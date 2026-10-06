import { Side } from "./domain"
import {
  battleMetricsSchemaVersion,
  type BattleMetricsDocument,
  type BattleSideMetrics,
  type ChatDocument,
  type GenerationDocument,
  type ReviewEffort,
  type ReviewEventDocument,
  type ReviewTab,
  type RunDocument,
  type TurnDocument,
} from "./records"

/**
 * The derived fact table. Everything here is recomputed from the battle
 * documents, so a definition can change and history can be restated; nothing
 * in this module may read state that a battle does not durably keep.
 *
 * [Analytics](../../../../docs/analytics.md) owns why the table is separate.
 */

/**
 * A voter who opens the diff and goes to lunch did not study it for an hour.
 * An interval longer than this is dropped rather than truncated: unknown is a
 * more honest answer than a made-up ceiling.
 */
const IDLE_CUTOFF_MS = 120_000

type VendorAliases = {
  readonly slug: RegExp
  readonly aliases: readonly string[]
}

// Matched against the contestant's own output only. A voter who names a model
// in their prompt makes the reply echo it, which is not the contestant leaking.
const vendors: readonly VendorAliases[] = [
  { slug: /anthropic|claude/i, aliases: ["Claude", "Anthropic"] },
  { slug: /openai|gpt|codex|^o\d/i, aliases: ["GPT", "OpenAI", "ChatGPT", "Codex"] },
  { slug: /google|gemini/i, aliases: ["Gemini", "Google"] },
  { slug: /x-ai|grok/i, aliases: ["Grok", "xAI"] },
  { slug: /z-ai|glm|zhipu/i, aliases: ["GLM", "Zhipu", "Z.ai"] },
  { slug: /qwen|alibaba|tongyi/i, aliases: ["Qwen", "Alibaba", "Tongyi"] },
  { slug: /meta|llama/i, aliases: ["Llama", "Meta"] },
  { slug: /mistral/i, aliases: ["Mistral"] },
  { slug: /deepseek/i, aliases: ["DeepSeek"] },
  { slug: /moonshot|kimi/i, aliases: ["Kimi", "Moonshot"] },
  { slug: /minimax/i, aliases: ["MiniMax"] },
]

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Words the contestant behind `slug` would use for itself. */
export function aliasesFor(slug: string): readonly string[] {
  return vendors.find((vendor) => vendor.slug.test(slug))?.aliases ?? []
}

/** The first alias the text names, or undefined when it names none. */
export function mentionedAlias(text: string, slug: string): string | undefined {
  for (const alias of aliasesFor(slug)) {
    // Surrounded by anything that is not a word character, so "GPT-4" counts
    // and "encrypt" does not.
    if (new RegExp(`(^|[^\\w])${escape(alias)}($|[^\\w])`, "i").test(text)) return alias
  }
  return undefined
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length
}

function blurredSpans(events: readonly ReviewEventDocument[]) {
  const spans: Array<{ from: number; to: number }> = []
  let blurredAt: number | undefined
  for (const event of events) {
    if (event.type === "window.blur" && blurredAt === undefined) blurredAt = event.offsetMs
    if (event.type === "window.focus" && blurredAt !== undefined) {
      spans.push({ from: blurredAt, to: event.offsetMs })
      blurredAt = undefined
    }
  }
  // A review that ends blurred leaves the span open; the caller closes it at
  // the last event, which is the last moment anything is known about.
  const last = events.at(-1)
  if (blurredAt !== undefined && last) spans.push({ from: blurredAt, to: last.offsetMs })
  return spans
}

function blurredWithin(spans: ReadonlyArray<{ from: number; to: number }>, from: number, to: number) {
  return spans.reduce((total, span) => total + Math.max(0, Math.min(to, span.to) - Math.max(from, span.from)), 0)
}

/**
 * One timeline per mounting of the card, oldest first. `offsetMs` restarts at
 * zero every mount, so events from different mounts are never comparable and
 * must never be sorted together.
 */
function mounts(events: readonly ReviewEventDocument[]) {
  const groups = new Map<string, ReviewEventDocument[]>()
  for (const event of events) {
    const key = event.mountId ?? ""
    const group = groups.get(key)
    if (group) group.push(event)
    else groups.set(key, [event])
  }
  return [...groups.values()]
    .map((group) => [...group].sort((left, right) => left.offsetMs - right.offsetMs))
    .sort((left, right) => arrival(left) - arrival(right))
}

function arrival(group: readonly ReviewEventDocument[]) {
  return Math.min(...group.map((event) => event.receivedAt.getTime()))
}

/**
 * Events that mean the voter did something, as opposed to the card or the window
 * reporting on itself. `verdict.folded` says a fold was offered, which the card
 * decides from the report's length; `verdict.expanded` is the one the voter clicks.
 */
function isInteraction(event: ReviewEventDocument) {
  return (
    event.type !== "battle.opened" &&
    event.type !== "window.focus" &&
    event.type !== "window.blur" &&
    event.type !== "verdict.folded" &&
    // Voter-caused, but pointer rather than click, and `diff.scrolled` repeats as
    // the reader descends. They are counted on their own fields instead of
    // swamping a count that means "things the voter chose to open".
    event.type !== "vote.hovered" &&
    event.type !== "diff.scrolled"
  )
}

/**
 * Reduce one turn's review into the effort fields. Dwell comes from the gaps
 * between consecutive events with blurred time removed, never from a duration
 * the client computed.
 */
export function reviewEffort(events: readonly ReviewEventDocument[]): ReviewEffort | undefined {
  if (events.length === 0) return undefined
  const dwellMsByPane: Record<string, number> = {}
  const panesOpened: ReviewTab[] = []
  const files = new Set<string>()
  const previews = new Set<Side>()
  const hoveredVotes = new Set<Side>()
  let deepestDiffDepth: number | undefined
  let expanded = false
  let foldOffered = false
  let activeMs = 0
  let interactionCount = 0
  let msToFirstInteraction: number | undefined

  for (const ordered of mounts(events)) {
    const spans = blurredSpans(ordered)
    // The pane does not carry across a remount: the card opens on its default
    // again and says so.
    let pane: ReviewTab | undefined

    for (const [index, event] of ordered.entries()) {
      if (isInteraction(event)) {
        interactionCount += 1
        // Taken from the first mount that recorded one, which is the first time
        // the voter acted after the card first opened.
        if (msToFirstInteraction === undefined) msToFirstInteraction = event.offsetMs
      }
      if (event.type === "file.selected") files.add(event.file)
      if (event.type === "preview.opened") previews.add(event.side)
      if (event.type === "vote.hovered") hoveredVotes.add(event.side)
      if (event.type === "diff.scrolled") {
        deepestDiffDepth = Math.max(deepestDiffDepth ?? 0, event.depth)
      }
      if (event.type === "verdict.expanded") expanded = true
      if (event.type === "verdict.folded") foldOffered = true
      if (event.type === "tab.viewed" && !panesOpened.includes(event.tab)) panesOpened.push(event.tab)
      // The pane opens before the time that follows it is spent in it. Attributing
      // the gap first would credit every tab's reading time to the tab before it.
      if (event.type === "tab.viewed") pane = event.tab

      const next = ordered[index + 1]
      if (!next) continue
      const focused = Math.max(0, next.offsetMs - event.offsetMs - blurredWithin(spans, event.offsetMs, next.offsetMs))
      // A gap this long is someone who left, not someone reading.
      if (focused > IDLE_CUTOFF_MS) continue
      // Only time with a pane on screen is time spent reading. The gap before the
      // card has shown anything is the battle running, not the voter working, and
      // counting it made a vote cast without a glance score higher than a studied one.
      if (!pane) continue
      activeMs += focused
      dwellMsByPane[pane] = (dwellMsByPane[pane] ?? 0) + focused
    }
  }

  return {
    ...(msToFirstInteraction === undefined ? {} : { msToFirstInteraction }),
    panesOpened,
    dwellMsByPane,
    filesViewed: files.size,
    previewsOpened: previews.size,
    // Absent when nothing was ever foldable, so `false` reads as "left it
    // folded" rather than "there was nothing to open".
    ...(expanded ? { verdictExpanded: true } : foldOffered ? { verdictExpanded: false } : {}),
    activeMs,
    eventCount: events.length,
    interactionCount,
    votesHovered: hoveredVotes.size,
    ...(deepestDiffDepth === undefined ? {} : { deepestDiffDepth }),
  }
}

type ArchivedPart = { readonly type?: unknown; readonly text?: unknown }
type ArchivedMessage = { readonly info?: { readonly id?: unknown; readonly role?: unknown }; readonly parts?: unknown }
type ArchivedSession = { readonly messages?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function archivedMessages(transcript: unknown): readonly ArchivedMessage[] {
  if (!Array.isArray(transcript)) return []
  const messages: ArchivedMessage[] = []
  for (const session of transcript as ArchivedSession[]) {
    if (isRecord(session) && Array.isArray(session.messages)) messages.push(...(session.messages as ArchivedMessage[]))
  }
  return messages
}

/** The prose of one message, in the order the card renders it. */
function textParts(message: ArchivedMessage | undefined): readonly string[] {
  if (!message || !Array.isArray(message.parts)) return []
  return (message.parts as ArchivedPart[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
}

/**
 * The contestant's closing reply — what the voter actually reads — pulled from
 * an archived transcript. Falls back to the last assistant message when the
 * recorded terminal id is missing, and gives up rather than guessing when the
 * archive has no assistant text at all.
 */
export function finalAssistantText(transcript: unknown, messageID?: string): string | undefined {
  const messages = archivedMessages(transcript)
  const assistants = messages.filter((message) => message.info?.role === "assistant")
  const target = messages.find((message) => message.info?.id === messageID) ?? assistants.at(-1)
  const text = textParts(target).join("\n\n").trim()
  return text.length > 0 ? text : undefined
}

/**
 * How many times the contestant stopped to say something to the voter. Counted
 * in text parts rather than messages, because that is what the battle card
 * draws: one assistant message that narrates, calls a tool, then narrates again
 * shows as two blocks of prose, and the voter reads two.
 *
 * Reasoning is not included — the voter is never shown it — and empty parts are
 * skipped, since a streamed part can settle with nothing in it.
 */
export function textMessageCount(transcript: unknown): number {
  return archivedMessages(transcript)
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => textParts(message))
    .filter((text) => text.trim().length > 0).length
}

function offsetFrom(base: Date, at: Date | undefined) {
  return at ? at.getTime() - base.getTime() : undefined
}

function winner(turn: TurnDocument, side: Side) {
  if (turn.resolution?.kind === "aborted") return false
  // A tie applies A to git (`domain.ts`, `voteResolution`) but nobody won it.
  // Reading `appliedSide` alone would file every tie as an A win and inflate
  // the left-column bias this table exists to measure.
  if (turn.vote === "tie") return false
  return turn.appliedSide === side
}

export type BattleMetricsInput = {
  readonly chat: ChatDocument
  readonly turn: TurnDocument
  readonly runs: readonly RunDocument[]
  readonly generations: readonly GenerationDocument[]
  readonly reviewEvents: readonly ReviewEventDocument[]
  /** The archived transcript, by side, when it could be read. */
  readonly transcripts: Partial<Record<Side, unknown>>
  readonly computedAt: Date
}

/** One document per battle, each contestant nested under `sides`. */
export function computeBattleMetrics(input: BattleMetricsInput): BattleMetricsDocument {
  const { chat, turn, runs, generations, reviewEvents, transcripts, computedAt } = input
  const base = turn.createdAt
  const bySide = new Map(runs.map((run) => [run.side, run]))
  const completions: Partial<Record<Side, number>> = {}
  for (const side of Side) {
    const at = offsetFrom(base, bySide.get(side)?.completedAt)
    if (at !== undefined) completions[side] = at
  }
  // A stopped run still carries a `completedAt`, so two timestamps are not proof of
  // a race: an early vote kills the loser mid-flight. Both sides have to have run
  // to the end for finishing first to mean anything.
  const raced =
    completions.a !== undefined &&
    completions.b !== undefined &&
    Side.every((side) => bySide.get(side)?.runState === "complete")
  const modelPair = Side.map((side) => turn.placement[side]?.model)
    .filter((model): model is string => Boolean(model))
    .sort()

  const sides: Partial<Record<Side, BattleSideMetrics>> = {}
  for (const side of Side) {
    const run = bySide.get(side)
    if (!run) continue
    const assignment = turn.placement[side]
    const runGenerations = generations.filter((generation) => generation.runID === run._id)
    const usage = run.usage
    const latencyMs = runGenerations.reduce((total, generation) => total + (generation.usage?.latencyMs ?? 0), 0)
    const first = runGenerations.find((generation) => generation.firstTokenAt && generation.startedAt)
    const completionTokens = usage?.completionTokens ?? 0
    const transcript = transcripts[side]
    const read = transcript !== undefined
    const summary = read ? finalAssistantText(transcript, run.terminalAssistantMessageID) : undefined
    const matchedAlias =
      summary === undefined || assignment.model === undefined
        ? undefined
        : mentionedAlias(summary, assignment.model)
    const other = side === "a" ? "b" : "a"

    sides[side] = {
      model: assignment.model ?? assignment.assignmentID,
      providers: run.resolvedProviders ?? [],
      llmCalls: runGenerations.length,
      latencyMs,
      ...(first?.firstTokenAt && first.startedAt
        ? { ttftMs: first.firstTokenAt.getTime() - first.startedAt.getTime() }
        : {}),
      ...(latencyMs > 0 && completionTokens > 0 ? { tokensPerSec: completionTokens / (latencyMs / 1000) } : {}),
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      cost: usage?.cost ?? 0,
      providerErrors: runGenerations.filter((generation) => generation.error !== undefined).length,
      retries: run.retries.length,
      ...(runGenerations.at(-1)?.finishReason ? { finishReason: runGenerations.at(-1)?.finishReason } : {}),
      runState: run.runState,
      runErrored: run.error !== undefined,
      ...(run.durationMs === null || run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      ...(completions[side] === undefined ? {} : { completedAtMs: completions[side] }),
      // Only meaningful when both sides ran to the end; a side that was stopped
      // did not lose a race it was not in.
      ...(raced ? { finishedFirst: (completions[side] ?? 0) <= (completions[other] ?? 0) } : {}),
      toolCount: run.toolCount,
      serviceCount: (run.services ?? []).filter((service) => service.kind === "owned_process").length,
      diffFiles: run.diff?.files ?? 0,
      diffAdditions: run.diff?.additions ?? 0,
      diffDeletions: run.diff?.deletions ?? 0,
      ...(summary === undefined ? {} : { summaryWordCount: wordCount(summary) }),
      ...(summary === undefined ? {} : { mentionsOwnName: matchedAlias !== undefined }),
      ...(matchedAlias ? { matchedAlias } : {}),
      // Absent when the transcript could not be read, so 0 reads as "said
      // nothing" rather than "nothing is known".
      ...(read ? { textMessageCount: textMessageCount(transcript) } : {}),
      won: winner(turn, side),
    }
  }

  const review = reviewEffort(reviewEvents)
  // The address the review came from, taken from the last event that carried
  // one: the daemon stamps it per flush, and a reconnect can change it.
  const ipAddress = [...reviewEvents].reverse().find((event) => event.ipAddress)?.ipAddress
  const voteAtMs = offsetFrom(base, turn.voteAt)

  return {
    _id: turn._id,
    schemaVersion: battleMetricsSchemaVersion,
    computedAt,
    turnID: turn._id,
    chatID: turn.chatID,
    turnIndex: turn.turnIndex,
    ...(chat.userId ? { userId: chat.userId } : {}),
    ...(turn.participantID ? { participantID: turn.participantID } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    modelPair,
    ...(turn.vote ? { vote: turn.vote } : {}),
    ...(turn.resolution?.kind ? { resolutionKind: turn.resolution.kind } : {}),
    selectedEarly: turn.selectedEarly === true,
    steerCount: turn.steerCount ?? 0,
    ...(voteAtMs === undefined ? {} : { voteAtMs }),
    ...(turn.timeToVoteMs === undefined ? {} : { timeToVoteMs: turn.timeToVoteMs }),
    ...(review ? { review } : {}),
    sides,
  }
}

export * as ArenaMetrics from "./metrics"
