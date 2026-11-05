import { createHash } from "crypto"
import { resolvedBattleSet } from "./assignments"
import { isDuplicateKeyError, type ArenaCollection, type ArenaDb } from "./collection"
import { authorize, type ArenaContext } from "./context"
import { loadGenerationCapture } from "./generation-capture"
import type { ModelPool, ModelProfile } from "./pool"

// After a battle is decided, the winner's model writes a short handoff summary for the models of the
// next battle. Its last contestant call is rebuilt from the capture, byte for byte, so the request
// prefix is the one the provider already cached and the model's own earlier work is in context the
// way the provider keeps it. The summary is plain text, the one channel every family reads; the
// engine delivers it to both sides of the next battle as the same hidden note. Nothing here runs
// before the vote, and a replay that cannot run leaves the next battle without a note on both
// sides: there is no second producer.

export const CARRY_VERSION = 1
/** About 1.2K tokens: what the next battle's two sides read, once each, at a cold boundary. */
export const MAX_NOTE_CHARS = 4_800
const REPLAY_TIMEOUT_MS = 180_000
/** A carry still `started` after this long belongs to a function that died; the next request retries. */
const STARTED_STALE_MS = 10 * 60_000
const UPSTREAM = "https://openrouter.ai/api/v1/chat/completions"
const CARRIES = "arenaCarries"

// The transcript keeps what the winner said and did; what it worked out on the way is what the next
// battle loses. So the request asks only for that: the grounds behind choices, what was weighed and
// set aside, what was assumed, noticed or doubted, and the plan beyond what got done. Sections and
// rules follow Core's compaction template (`core/src/session/compaction.ts`), minus everything a
// transcript already shows.
export const HANDOFF_HEADINGS = ["## Why", "## Set aside", "## Assumed", "## Accepted", "## Unsure"] as const

/**
 * The one message appended after the winner's final reply. The model lists candidates in a scratch
 * part, quoting the message that already shows each one or marking it `nowhere`, then writes the
 * handoff from the `nowhere` lines only; the validator drops the scratch part. Measured on ten
 * DeepSeek battles against the transcript and the trace: 54% of bullets carried reasoning the chat
 * never shows, 30% restated it, 16% had no support in the trace (19 / 58 / 23 before). A second
 * deletion pass and a "reasons only" rule both lowered restating but raised the unsupported share,
 * so neither ships.
 */
export const HANDOFF_REQUEST = [
  "The turn above is complete. The agent that continues this work will read everything above: the request, your messages including your final one, every tool call with its input, and every tool result. It will not have what you worked out on the way. Record only that.",
  "",
  "Work in two parts.",
  "",
  "Part 1, under the heading `## Scratch`, is scratch work nobody will read. Go through your turn step by step and list every candidate, one line each: each choice together with its reason, each alternative you weighed even briefly, each assumption, each edge case or side effect you noticed and tolerated, each doubt, each check you planned and skipped. End each line with ` — shown above: ` followed by either a short quote of the message passage that already states it (your final message, a tool call input, a tool result, an earlier note) or the word `nowhere`. Quote, do not judge: if a passage states it in any wording, quote it. Do not reconstruct reasons after the fact and do not list alternatives you never weighed.",
  "",
  "Part 2 is the handoff. It contains exactly the candidates marked `nowhere`, rewritten as terse bullets in this format (omit any section that has nothing). If no candidate is marked `nowhere`, the handoff is the single line `(nothing beyond the messages above)`. Do not include the <template> tags in your response.",
  "<template>",
  "## Why",
  "- [a choice you made and the reason behind it, when no message states the reason]",
  "",
  "## Set aside",
  "- [an approach you weighed and dropped, and what ruled it out]",
  "",
  "## Assumed",
  "- [something you inferred or took as given rather than verified]",
  "",
  "## Accepted",
  "- [an edge case, side effect or inaccuracy you noticed and decided to tolerate]",
  "",
  "## Unsure",
  "- [a doubt about the result, or a check you planned but did not do]",
  "</template>",
  "",
  "Rules:",
  "- Terse single-line bullets, no prose paragraphs, no nested lists. No limit on the number of bullets, but each must come from a `nowhere` line.",
  "- Preserve exact file paths, symbols, commands, error strings and identifiers. Repository-relative paths only; no port numbers, hosts or URLs.",
  '- Write in the third person about "the previous agent"; never name the model or vendor behind it.',
  "- Do not address the user, do not call tools, and do not mention this request.",
  "- After the scratch part, return only the handoff sections, with no preamble or commentary.",
].join("\n")

export type CarrySource = "replay" | "none"

export type CarryAnswer = {
  readonly version: typeof CARRY_VERSION
  readonly source: CarrySource
  readonly note?: string
  /** Why there is no note; a short fixed token, never upstream text. */
  readonly reason?: string
}

type CarryDocument = {
  readonly _id: string
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly generationID: string
  readonly model: string
  state: "started" | "complete"
  source?: CarrySource
  reason?: string
  note?: string
  noteChars?: number
  provider?: string
  usage?: Record<string, unknown>
  finishReason?: string
  latencyMs?: number
  readonly createdAt: Date
  completedAt?: Date
}

function carries(db: ArenaDb): ArenaCollection<CarryDocument> {
  return db.collection<CarryDocument>(CARRIES)
}

function carryID(userId: string, scopeID: string) {
  return createHash("sha256").update(`${userId.length}:${userId}|carry|${scopeID}`).digest("hex")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// How long a provider keeps the winner's prefix warm, from the request's start. A cold replay reads
// the whole prompt at full price, so outside the window there is no note. DeepSeek and MiMo are
// cheap enough cold to always run; Claude's cache lasts five minutes and nothing pings a finished side.
const WARM_WINDOW_MS: Readonly<Record<string, number>> = {
  anthropic: 270_000,
  moonshotai: 300_000,
  google: 480_000,
  "x-ai": 600_000,
  meta: 600_000,
  openai: 1_800_000,
  qwen: 1_800_000,
  deepseek: Infinity,
  xiaomi: Infinity,
}
const DEFAULT_WARM_WINDOW_MS = 600_000

export function warmWindowMs(slug: string) {
  const vendor = slug.split("/")[0] ?? ""
  return WARM_WINDOW_MS[vendor] ?? DEFAULT_WARM_WINDOW_MS
}

export type AssembledReply = {
  content: string
  reasoning: string
  readonly reasoningDetails: Record<string, unknown>[]
  toolCalls: boolean
  finishReason?: string
  provider?: string
  usage?: Record<string, unknown>
  error?: string
}

// The OpenRouter SDK's streaming accumulator: consecutive text fragments share one detail, whose
// signature and format come from the first fragment that carries them. The service's restore
// merges envelopes the same way, so a replayed message matches what a contestant call would send.
function mergeDetails(target: Record<string, unknown>[], incoming: unknown[], stream: boolean) {
  for (const detail of incoming) {
    if (!record(detail)) continue
    const previous = target.at(-1)
    if (stream && detail.type === "reasoning.text" && previous && previous.type === "reasoning.text") {
      previous.text = String(previous.text ?? "") + String(detail.text ?? "")
      if (!previous.signature && detail.signature !== undefined) previous.signature = detail.signature
      if (!previous.format && detail.format !== undefined) previous.format = detail.format
    } else target.push(structuredClone(detail))
  }
}

/** Rebuilds one chat completion from its raw upstream body: an SSE stream, or one JSON object. */
export function assembleChatCompletion(body: string): AssembledReply {
  const reply: AssembledReply = { content: "", reasoning: "", reasoningDetails: [], toolCalls: false }
  const payloads: unknown[] = []
  const trimmed = body.trim()
  let stream = true
  if (trimmed.startsWith("{")) {
    stream = false
    try {
      payloads.push(JSON.parse(trimmed))
    } catch {
      reply.error = "unreadable"
      return reply
    }
  } else {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      try {
        payloads.push(JSON.parse(data))
      } catch {
        // A cut line at the end of a recorded stream; the finish reason tells whether it mattered.
      }
    }
  }
  for (const payload of payloads) {
    if (!record(payload)) continue
    if (record(payload.error)) reply.error = String(payload.error.message ?? payload.error.code ?? "upstream")
    if (typeof payload.provider === "string") reply.provider = payload.provider
    if (record(payload.usage)) reply.usage = payload.usage
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
    if (!record(choice)) continue
    const part = record(choice.delta) ? choice.delta : record(choice.message) ? choice.message : undefined
    if (part) {
      if (typeof part.content === "string") reply.content += part.content
      if (typeof part.reasoning === "string") reply.reasoning += part.reasoning
      else if (typeof part.reasoning_content === "string") reply.reasoning += part.reasoning_content
      if (Array.isArray(part.reasoning_details)) mergeDetails(reply.reasoningDetails, part.reasoning_details, stream)
      if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) reply.toolCalls = true
    }
    if (typeof choice.finish_reason === "string") reply.finishReason = choice.finish_reason
  }
  return reply
}

/** The winner's final reply as the next request carries it: text plus its reasoning, as returned. */
export function assistantMessage(reply: AssembledReply): Record<string, unknown> {
  return {
    role: "assistant",
    content: reply.content,
    ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
    ...(reply.reasoningDetails.length > 0 ? { reasoning_details: reply.reasoningDetails } : {}),
  }
}

// Names the next contestants must not read: a note that says which model wrote it lets a side pose
// as the previous winner. The pool's display names cover the hosted set; the rest are families.
const FAMILY_NAMES = [
  "Anthropic",
  "Claude",
  "OpenAI",
  "GPT",
  "ChatGPT",
  "Codex",
  "Google",
  "Gemini",
  "xAI",
  "Grok",
  "Llama",
  "Muse",
  "Alibaba",
  "Qwen",
  "DeepSeek",
  "Moonshot",
  "Kimi",
  "Xiaomi",
  "MiMo",
  "Zhipu",
  "GLM",
  "Mistral",
]
// A self-description, not any mention: "a library developed by Google" is fine to carry.
const VENDOR_CLAIM =
  /\b(?:I am|I'm|this (?:assistant|model|agent)|the (?:previous )?agent (?:is|was))\b[^\n]{0,40}?\b(?:developed|trained|made|built|created)\s+by\s+(?:anthropic|openai|google|xai|x\.ai|meta|alibaba|deepseek|moonshot|xiaomi|zhipu|mistral)\b/i
const SLOT_PATH = /(?:[A-Za-z]:)?[^\s"'`()<>]*\.agent-duel[\\/]worktrees[\\/][^\\/\s]+[\\/]generation-\d+-[ab][\\/]?/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s)\]'"`]*/g
const LOCAL_PORT = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/g
const PREVIEW_HOST = /\bturn\d+-[ab](?:--[\w.-]+)?\.[\w.-]+/g

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The pool's own names in every spelling a model uses for itself: display name, slug, canonical
 * slug and the slug's last segment (`claude-opus-5.5`, `kimi-k3.1-pro`). Hyphens and slashes count
 * as boundaries here, as the engine's own identity check treats them.
 */
function poolScrubber(pool: ModelPool) {
  const literals = new Set<string>()
  for (const profile of pool) {
    for (const value of [profile.displayName, profile.slug, profile.canonicalSlug]) {
      literals.add(value)
      const last = value.split("/").at(-1)
      if (last) literals.add(last)
    }
  }
  const alternatives = [...literals]
    .filter((name) => name.trim().length > 2)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  return new RegExp(`(?<!\\w)(?:${alternatives.join("|")})(?!\\w)`, "gi")
}

function nameScrubber() {
  const alternatives = [...FAMILY_NAMES]
    .filter((name) => name.trim().length > 1)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  // Not inside a path or identifier: `openai.ts` and `deepseek-client` keep their bytes.
  return new RegExp(`(?<![\\w./-])(?:${alternatives.join("|")})(?![\\w./-])`, "gi")
}

function scrub(text: string, pool: ModelPool) {
  return text
    .replace(SLOT_PATH, "")
    .replace(LOCAL_URL, "<local url>")
    .replace(LOCAL_PORT, "$1")
    .replace(PREVIEW_HOST, "<preview host>")
    .replace(poolScrubber(pool), "[model]")
    .replace(nameScrubber(), "[model]")
}

/** Keeps whole sections, in order, while they fit; a first section too long on its own is cut at a line. */
function truncateAtSections(text: string, max: number) {
  if (text.length <= max) return text
  const sections: string[] = []
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line) || sections.length === 0) sections.push(line)
    else sections[sections.length - 1] += `\n${line}`
  }
  let kept = ""
  for (const section of sections) {
    const candidate = kept ? `${kept}\n${section}` : section
    if (candidate.length > max) break
    kept = candidate
  }
  if (kept) return kept
  const head = text.slice(0, max)
  const cut = head.lastIndexOf("\n")
  return cut > 0 ? head.slice(0, cut) : head
}

export type HandoffValidation = { readonly note: string } | { readonly reason: string }

/** The summary the next battle may read, or why this reply is not one. */
/** What a model answers when its check leaves nothing to carry; a valid outcome, not a failure. */
export const NOTHING_TO_CARRY = "(nothing beyond the messages above)"

export function validateHandoff(text: string, pool: ModelPool): HandoffValidation {
  const lines = text.trim().split("\n")
  // The model's scratch work precedes the first handoff heading and is never delivered.
  const first = lines.findIndex((line) =>
    HANDOFF_HEADINGS.some((heading) => line.trim().toLowerCase() === heading.toLowerCase()),
  )
  const body = first >= 0 ? lines.slice(first).join("\n").trim() : ""
  const bullets = body.split("\n").filter((line) => line.trim().startsWith("- ")).length
  if (!body || bullets === 0) {
    if (lines.some((line) => line.trim().toLowerCase() === NOTHING_TO_CARRY)) return { reason: "nothing-to-carry" }
    if (body) return { reason: "nothing-to-carry" }
    return { reason: text.trim() ? "format" : "empty-reply" }
  }
  if (VENDOR_CLAIM.test(body)) return { reason: "identity" }
  const note = scrub(truncateAtSections(body, MAX_NOTE_CHARS), pool).trim()
  if (!note) return { reason: "empty-reply" }
  return { note }
}

function withTimeout(signal: AbortSignal, ms: number) {
  const timeout = AbortSignal.timeout(ms)
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout
}

type Outcome = {
  readonly answer: CarryAnswer
  readonly stored: Partial<CarryDocument>
}

function none(reason: string): Outcome {
  return { answer: { version: CARRY_VERSION, source: "none", reason }, stored: { source: "none", reason } }
}

async function replay(
  context: ArenaContext,
  db: ArenaDb,
  apiKey: string,
  userId: string,
  scopeID: string,
  winner: { readonly assignmentID: string; readonly model: ModelProfile },
  generationID: string,
  signal: AbortSignal,
): Promise<Outcome> {
  const loaded = await loadGenerationCapture(db, userId, generationID)
  if (!loaded) return none("no-capture")
  const { capture, body, verified } = loaded
  if (capture.scopeID !== scopeID || capture.assignmentID !== winner.assignmentID) return none("capture-mismatch")
  if (capture.endpoint !== "chat") return none("unsupported-endpoint")
  if (!verified) return none("unverified-rebuild")
  const response = capture.response
  if (!response || response.state !== "complete" || response.status !== 200 || typeof response.body !== "string") {
    return none("no-response")
  }
  const final = assembleChatCompletion(response.body)
  if (final.error || final.finishReason !== "stop" || final.toolCalls || !final.content.trim()) {
    return none("not-final-reply")
  }
  const age = context.now().getTime() - new Date(capture.createdAt).getTime()
  if (age > warmWindowMs(winner.model.slug)) return none("cold")
  if (!Array.isArray(body.messages)) return none("invalid-body")

  // Everything else stays as the contestant call sent it, which is also what a compaction call gets
  // through the proxy: no sampling fields, the same reasoning effort, routing, cache key and output cap.
  const replayBody = {
    ...body,
    messages: [...body.messages, assistantMessage(final), { role: "user", content: HANDOFF_REQUEST }],
    stream: true,
    stream_options: { include_usage: true },
  }
  const startedAt = Date.now()
  let upstream: Response
  let text: string
  try {
    upstream = await context.fetch(UPSTREAM, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(replayBody),
      signal: withTimeout(signal, REPLAY_TIMEOUT_MS),
    })
    text = await upstream.text()
  } catch (error) {
    return none(
      signal.aborted
        ? "cancelled"
        : error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "fetch-failed",
    )
  }
  const latencyMs = Date.now() - startedAt
  if (!upstream.ok)
    return {
      ...none(`upstream-${upstream.status}`),
      stored: { source: "none", reason: `upstream-${upstream.status}`, latencyMs },
    }
  const reply = assembleChatCompletion(text)
  const measured = {
    ...(reply.provider ? { provider: reply.provider } : {}),
    ...(reply.usage ? { usage: reply.usage } : {}),
    ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
    latencyMs,
  }
  const failed = (reason: string): Outcome => ({ ...none(reason), stored: { source: "none", reason, ...measured } })
  if (reply.error) return failed("upstream-error")
  if (reply.toolCalls) return failed("tool-call")
  if (reply.finishReason && reply.finishReason !== "stop") return failed(`finish-${reply.finishReason}`)
  const validated = validateHandoff(reply.content, context.pool)
  if ("reason" in validated) return failed(validated.reason)
  return {
    answer: { version: CARRY_VERSION, source: "replay", note: validated.note },
    stored: { source: "replay", note: validated.note, noteChars: validated.note.length, ...measured },
  }
}

function answerOf(document: CarryDocument): CarryAnswer {
  if (document.source === "replay" && document.note) {
    return { version: CARRY_VERSION, source: "replay", note: document.note }
  }
  return { version: CARRY_VERSION, source: "none", reason: document.reason ?? "unknown" }
}

const GENERATION_ID = /^gen_[0-9a-f]{32}$/i

export async function handleCarryRequest(request: Request, context: ArenaContext) {
  if (!context.carry) return Response.json({ error: "Not found" }, { status: 404 })
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
  const caller = await authorize(request, context, (message, status) => Response.json({ error: message }, { status }))
  if (caller instanceof Response) return caller
  const apiKey = context.openRouterApiKey
  if (!apiKey) return Response.json({ error: "Arena carry is unavailable" }, { status: 503 })

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return Response.json({ error: "Arena carry request is invalid" }, { status: 400 })
  }
  if (
    !record(parsed) ||
    parsed.action !== "carry" ||
    parsed.kind !== "battle" ||
    typeof parsed.scopeID !== "string" ||
    !parsed.scopeID.trim() ||
    typeof parsed.generationID !== "string" ||
    !GENERATION_ID.test(parsed.generationID) ||
    (parsed.decision !== "select:a" && parsed.decision !== "select:b" && parsed.decision !== "tie") ||
    Object.keys(parsed).some((key) => !["action", "kind", "scopeID", "decision", "generationID"].includes(key))
  ) {
    return Response.json({ error: "Arena carry request is invalid" }, { status: 400 })
  }
  const scopeID = parsed.scopeID.trim()
  const decision = parsed.decision
  const generationID = parsed.generationID

  let db: ArenaDb
  let resolved: Awaited<ReturnType<typeof resolvedBattleSet>>
  try {
    db = await context.db()
    resolved = await resolvedBattleSet(db, caller.id, scopeID)
  } catch (error) {
    console.error("[arena-service] Arena carry scope could not be read", error)
    return Response.json({ error: "Arena carry is unavailable" }, { status: 503 })
  }
  // Only a decided battle carries, and only the side the engine applied: a tie applies side A.
  if (!resolved || resolved.decision !== decision) {
    return Response.json({ error: "Arena carry scope is not resolved" }, { status: 403 })
  }
  const winner = resolved.assignments[decision === "select:b" ? 1 : 0]
  if (!winner) return Response.json({ error: "Arena carry scope is not resolved" }, { status: 403 })

  // One paid call per battle: the row exists before the upstream request, and a second request for
  // the same scope reads the first one's outcome instead of paying again.
  const _id = carryID(caller.id, scopeID)
  const now = context.now()
  const started: CarryDocument = {
    _id,
    userId: caller.id,
    scopeID,
    assignmentID: winner.assignmentID,
    generationID,
    model: winner.model.slug,
    state: "started",
    createdAt: now,
  }
  try {
    await carries(db).insertOne(started)
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      console.error("[arena-service] Arena carry could not be recorded", error)
      return Response.json({ error: "Arena carry is unavailable" }, { status: 503 })
    }
    const existing = await carries(db).findOne({ _id, userId: caller.id })
    if (existing?.state === "complete") return Response.json(answerOf(existing))
    if (existing && now.getTime() - new Date(existing.createdAt).getTime() < STARTED_STALE_MS) {
      return Response.json({ error: "Arena carry is in progress" }, { status: 409 })
    }
    await carries(db).replaceOne({ _id, userId: caller.id }, started)
  }

  let outcome: Outcome
  try {
    outcome = await replay(context, db, apiKey, caller.id, scopeID, winner, generationID, request.signal)
  } catch (error) {
    console.error("[arena-service] Arena carry replay failed", error)
    outcome = none("failed")
  }
  try {
    await carries(db).updateOne(
      { _id, userId: caller.id },
      { $set: { ...outcome.stored, state: "complete", completedAt: context.now() } },
    )
  } catch (error) {
    console.error("[arena-service] Arena carry outcome could not be recorded", error)
  }
  return Response.json(outcome.answer)
}
