import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "crypto"
import { createServer } from "net"
import { Global } from "@opencode-ai/core/global"
import { rename, rm, stat, writeFile } from "fs/promises"
import fs from "fs/promises"
import * as CopySnapshot from "@/arena/copy-snapshot"
import * as ArenaGit from "@/arena/git"
import { Store } from "@/arena/mongo"
import { connectLocalStore } from "@/arena/local-store"
import type { Frame } from "@/arena/stream"
import type {
  ArenaEventDocument,
  ArtifactDocument,
  BattleMetricsDocument,
  ChatDocument,
  CheckoutEvictionDocument,
  ComparisonDocument,
  CheckoutEvictionDocument,
  GenerationDocument,
  RawEventDocument,
  ReviewEventDocument,
  RunDocument,
  SessionArchiveDocument,
  SingleAgentRatingDocument,
  TurnDocument,
} from "@/arena/records"
import { registry, setStoreForTest } from "@/arena/runtime"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { MessageID } from "@/session/schema"
import { Server } from "@/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import {
  json,
  type PublicSnapshot,
  TOOL_OUTPUT_BODY,
} from "./harness"

const arenaControlToken = "test-control-token"

function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-paseo-control-token", arenaControlToken)
  return Server.Default().app.request(path, { ...init, headers })
}

type Document = { readonly _id: string }
type Mutable = Record<string, unknown>
type Update = Record<string, Record<string, unknown>>
const TOOL_OUTPUT_DISPLAY_CAP = 128
const CONTESTANT_WORKTREE_INSTRUCTION =
  "Git is prepared at the frozen base in an isolated worktree on $PASEO_CURRENT_BRANCH. Work in $(pwd). Branch changes in this worktree are part of your result. Do not modify $PASEO_TRUNK_DIR. Use $PASEO_TRUNK_BRANCH only to identify the canonical branch. Port aliases belong only to this contestant environment. Literal ports, preview URLs, log paths, and process IDs in earlier messages or tool output are historical; do not reuse them, connect to them, or stop anything using them. Read the current port aliases and preview URLs from the environment. Run the project the way its developers run it, so the whole project works from the preview URL. For browser-facing services, bind to HOST=127.0.0.1 and use PORT/PASEO_PORT for the primary listener or PASEO_PORT2/PASEO_PORT3 for additional listeners. Start long-running services so they remain alive after the shell tool returns, then verify the assigned port is listening before reporting the matching public URL: ARENA_PREVIEW_URL for PASEO_PORT, ARENA_PREVIEW_URL2 for PASEO_PORT2, or ARENA_PREVIEW_URL3 for PASEO_PORT3."

function record(value: unknown): value is Mutable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (record(current) ? current[key] : undefined), value)
}

function equal(actual: unknown, expected: unknown) {
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.includes(expected)
  return actual === expected
}

function matches(value: unknown, filter: unknown): boolean {
  if (!record(filter)) return equal(value, filter)
  if (!record(value)) return false
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return Array.isArray(expected) && expected.some((item) => matches(value, item))
    const actual = valueAt(value, key)
    if (!record(expected) || !Object.keys(expected).some((item) => item.startsWith("$"))) {
      return equal(actual, expected)
    }
    return Object.entries(expected).every(([operator, operand]) => {
      if (operator === "$exists") return (actual !== undefined) === operand
      if (operator === "$ne") return !equal(actual, operand)
      if (operator === "$gt") return typeof actual === "number" && typeof operand === "number" && actual > operand
      if (operator === "$type") return typeof actual === operand
      if (operator === "$in") return Array.isArray(operand) && operand.includes(actual)
      if (operator === "$all")
        return Array.isArray(actual) && Array.isArray(operand) && operand.every((item) => actual.includes(item))
      if (operator === "$nin")
        return !Array.isArray(actual) || !Array.isArray(operand) || operand.every((item) => !actual.includes(item))
      return false
    })
  })
}

function setAt(value: Mutable, path: string, next: unknown) {
  const keys = path.split(".")
  const leaf = keys.pop()
  if (!leaf) return
  const target = keys.reduce<Mutable>((current, key) => {
    const nested = record(current[key]) ? current[key] : {}
    current[key] = nested
    return nested
  }, value)
  target[leaf] = next
}

function unsetAt(value: Mutable, path: string) {
  const keys = path.split(".")
  const leaf = keys.pop()
  const target = keys.reduce<unknown>((current, key) => (record(current) ? current[key] : undefined), value)
  if (leaf && record(target)) delete target[leaf]
}

function applyUpdate(value: unknown, update: Update) {
  if (!record(value)) return
  Object.entries(update.$set ?? {}).forEach(([path, next]) => setAt(value, path, next))
  Object.keys(update.$unset ?? {}).forEach((path) => unsetAt(value, path))
  Object.entries(update.$inc ?? {}).forEach(([path, amount]) => {
    setAt(
      value,
      path,
      (typeof valueAt(value, path) === "number" ? (valueAt(value, path) as number) : 0) + Number(amount),
    )
  })
  Object.entries(update.$push ?? {}).forEach(([path, item]) => {
    const values = valueAt(value, path)
    if (Array.isArray(values)) values.push(item)
    else setAt(value, path, [item])
  })
  Object.entries(update.$addToSet ?? {}).forEach(([path, item]) => {
    const values = valueAt(value, path)
    if (Array.isArray(values) && !values.includes(item)) values.push(item)
    else if (!Array.isArray(values)) setAt(value, path, [item])
  })
  Object.entries(update.$pullAll ?? {}).forEach(([path, removed]) => {
    const values = valueAt(value, path)
    if (!Array.isArray(values) || !Array.isArray(removed)) return
    setAt(
      value,
      path,
      values.filter((item) => !removed.includes(item)),
    )
  })
  Object.entries(update.$min ?? {}).forEach(([path, item]) => {
    const current = valueAt(value, path)
    if (current === undefined || (current instanceof Date && item instanceof Date && item < current))
      setAt(value, path, item)
  })
}

function collection<T extends Document>() {
  const values: T[] = []
  const find = (filter: unknown = {}) => {
    let selected = values.filter((item) => matches(item, filter))
    return {
      sort(specification: Record<string, number>) {
        selected = selected.toSorted((a, b) => {
          for (const [field, direction] of Object.entries(specification)) {
            const left = valueAt(a, field)
            const right = valueAt(b, field)
            const comparison = (left ?? "") < (right ?? "") ? -1 : (left ?? "") > (right ?? "") ? 1 : 0
            if (comparison !== 0) return comparison * direction
          }
          return 0
        })
        return this
      },
      limit(size: number) {
        selected = selected.slice(0, size)
        return this
      },
      async toArray() {
        return selected
      },
      async next() {
        return selected[0] ?? null
      },
    }
  }
  return {
    values,
    async insertOne(value: T) {
      values.push(value)
      return { acknowledged: true, insertedId: value._id }
    },
    async replaceOne(filter: unknown, replacement: T, options?: { upsert?: boolean }) {
      const index = values.findIndex((item) => matches(item, filter))
      if (index < 0) {
        if (!options?.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
        values.push(replacement)
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, insertedId: replacement._id }
      }
      values[index] = replacement
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
    },
    async findOne(filter: unknown) {
      return values.find((item) => matches(item, filter)) ?? null
    },
    find,
    async findOneAndUpdate(filter: unknown, update: Update) {
      const value = values.find((item) => matches(item, filter))
      if (!value) return null
      applyUpdate(value, update)
      return value
    },
    async updateOne(filter: unknown, update: Update) {
      const value = values.find((item) => matches(item, filter))
      if (!value) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
      applyUpdate(value, update)
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
    },
    async updateMany(filter: unknown, update: Update) {
      const selected = values.filter((item) => matches(item, filter))
      selected.forEach((value) => applyUpdate(value, update))
      return { acknowledged: true, matchedCount: selected.length, modifiedCount: selected.length }
    },
    async deleteOne(filter: unknown) {
      const index = values.findIndex((item) => matches(item, filter))
      if (index >= 0) values.splice(index, 1)
      return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 }
    },
    async deleteMany(filter: unknown) {
      const retained = values.filter((item) => !matches(item, filter))
      const deletedCount = values.length - retained.length
      values.splice(0, values.length, ...retained)
      return { acknowledged: true, deletedCount }
    },
    async bulkWrite(operations: ReadonlyArray<{ updateOne: { filter: unknown; update: Update } }>) {
      let modifiedCount = 0
      for (const operation of operations) {
        const value = values.find((item) => matches(item, operation.updateOne.filter))
        if (!value) continue
        applyUpdate(value, operation.updateOne.update)
        modifiedCount++
      }
      return { modifiedCount }
    },
    aggregate(pipeline: ReadonlyArray<{ $match?: unknown }>) {
      const selected = values.filter((item) => matches(item, pipeline[0]?.$match ?? {}))
      return {
        async next() {
          return selected.length
            ? {
                storedSize: selected.reduce((sum, item) => sum + Number(valueAt(item, "storedSize") ?? 0), 0),
              }
            : null
        },
      }
    },
  }
}

function memoryStore() {
  const chats = collection<ChatDocument>()
  const turns = collection<TurnDocument>()
  const runs = collection<RunDocument>()
  const generations = collection<GenerationDocument>()
  const events = collection<ArenaEventDocument>()
  const rawEvents = collection<RawEventDocument>()
  const sessionArchives = collection<SessionArchiveDocument>()
  const singleAgentRatings = collection<SingleAgentRatingDocument>()
  const artifacts = collection<ArtifactDocument>()
  const comparisons = collection<ComparisonDocument>()
  const checkoutEvictions = collection<CheckoutEvictionDocument>()
  const reviewEvents = collection<ReviewEventDocument>()
  const battleMetrics = collection<BattleMetricsDocument>()
  const restart = () =>
    Object.assign(Object.create(Store.prototype), {
      chats,
      turns,
      runs,
      generations,
      events,
      rawEvents,
      sessionArchives,
      singleAgentRatings,
      artifacts,
      comparisons,
      checkoutEvictions,
      reviewEvents,
      battleMetrics,
      artifactQueues: new Map<string, Promise<void>>(),
    }) as Store
  return {
    store: restart(),
    restart,
    chats,
    turns,
    runs,
    generations,
    events,
    rawEvents,
    sessionArchives,
    singleAgentRatings,
    artifacts,
    comparisons,
    checkoutEvictions,
    reviewEvents,
    battleMetrics,
  }
}

const testProfiles = [
  { slug: "test/model-a", displayName: "Test Model A" },
  { slug: "test/model-b", displayName: "Test Model B" },
  { slug: "test/model-c", displayName: "Test Model C" },
] as const

function chunks(lines: ReadonlyArray<unknown>) {
  return new Response(
    `${lines.map((line) => `data: ${typeof line === "string" ? line : JSON.stringify(line)}`).join("\n\n")}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function contestantResponse(
  model: string,
  ordinal: number,
  tool?: "bash" | "question",
  normalFixture: false | "file" | "transcript" = false,
  commandOverride?: string,
  generationKey: string = String(ordinal),
) {
  const base = { id: `chatcmpl-${generationKey}`, object: "chat.completion.chunk", model }
  if (!tool) {
    return chunks([
      { ...base, choices: [{ index: 0, delta: { role: "assistant" } }] },
      {
        ...base,
        choices: [{ index: 0, delta: { content: `Completed contestant result ${ordinal}.` } }],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
      "[DONE]",
    ])
  }
  const call = `call-${generationKey}`
  const name = tool
  const command =
    commandOverride ??
    (normalFixture === "transcript"
      ? ":"
      : normalFixture === "file"
        ? "printf 'normal contestant result\\n' > normal-result.txt; git add normal-result.txt; git commit -m 'test: record normal turn'"
        : ordinal === 1
          ? `printf 'result 1\\n' > arena-result.txt; printf '%s\\n' '${TOOL_OUTPUT_BODY}'`
          : `printf 'result ${ordinal}\\n' > arena-result.txt`)
  const argumentsValue =
    tool === "question"
      ? {
          questions: [
            {
              question: "Continue this contestant run?",
              header: "Continue",
              options: [{ label: "Proceed", description: "Continue the isolated run." }],
            },
          ],
        }
      : { command }
  return chunks([
    { ...base, choices: [{ index: 0, delta: { role: "assistant" } }] },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: call, type: "function", function: { name, arguments: "" } }],
          },
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify(argumentsValue),
                },
              },
            ],
          },
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
    "[DONE]",
  ])
}

function installOpenRouterStub(options?: {
  readonly delayedOrdinal?: number
  readonly delayMs?: number
  readonly delayAllMs?: number
  readonly assignmentError?: string
  readonly questionOrdinals?: ReadonlyArray<number>
  readonly emptyOrdinals?: ReadonlyArray<number>
  readonly contestantCommands?: Readonly<Partial<Record<number, string>>>
}) {
  const original = globalThis.fetch
  const calls = new Map<string, number>()
  const ordinal = new Map<string, number>()
  const completedNormalCommands = new Set<string>()
  const contestantRequests: Array<{
    readonly model: string
    readonly messages?: Array<{ readonly content?: Array<{ readonly text?: string }> }>
    readonly provider?: {
      readonly sort?: string
      readonly require_parameters?: boolean
      readonly max_price?: { readonly prompt?: number; readonly completion?: number }
    }
  }> = []
  let utilityCalls = 0
  type TestAssignment = {
    readonly scopeID: string
    readonly assignmentID: string
    readonly model: (typeof testProfiles)[number]
  }
  const assignmentSets = new Map<string, { readonly decision?: string; readonly assignments: Array<TestAssignment> }>()
  const assignmentsByScope = new Map<string, TestAssignment>()
  const assignmentsByID = new Map<string, TestAssignment>()
  let assignmentSequence = 0
  const execute = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const authorization = new Headers(init?.headers).get("Authorization")
    if (url.origin !== "https://control.test" || authorization !== "Bearer test-session") {
      throw new Error("Arena request did not use the authenticated control-plane route")
    }
    if (url.pathname === "/api/arena/assignments") {
      const body = JSON.parse(String(init?.body)) as {
        action: "create" | "resolve"
        kind: "battle" | "single"
        scopeID: string
        decision?: string
      }
      const key = `${body.kind}:${body.scopeID}`
      let set = assignmentSets.get(key)
      if (body.action === "create") {
        if (options?.assignmentError) return Response.json({ error: options.assignmentError }, { status: 503 })
        if (!set) {
          const count = body.kind === "battle" ? 2 : 1
          const created = Array.from({ length: count }, (_, offset) => {
            const model = testProfiles[(assignmentSequence + offset) % testProfiles.length]!
            const assignment = {
              scopeID: body.scopeID,
              assignmentID: `assignment-${assignmentSequence}-${offset}`,
              model,
            }
            assignmentsByScope.set(`${assignment.scopeID}:${assignment.assignmentID}`, assignment)
            assignmentsByID.set(assignment.assignmentID, assignment)
            return assignment
          })
          assignmentSequence++
          set = { assignments: created }
          assignmentSets.set(key, set)
        }
        return Response.json({
          assignments: set.assignments.map(({ assignmentID }) => ({ assignmentID })),
        })
      }
      if (!set) return Response.json({ error: "not found" }, { status: 404 })
      if (set.decision && set.decision !== body.decision) {
        return Response.json({
          decision: set.decision,
          assignments: set.assignments.map(({ assignmentID, model }) => ({
            assignmentID,
            model: model.displayName,
          })),
        })
      }
      assignmentSets.set(key, { ...set, decision: body.decision })
      return Response.json({
        decision: body.decision,
        assignments: set.assignments.map(({ assignmentID, model }) => ({ assignmentID, model: model.displayName })),
      })
    }
    if (url.pathname !== "/api/openrouter/api/v1/chat/completions")
      throw new Error(`Unexpected external request: ${url}`)
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages?: Array<{
        readonly role?: string
        readonly content?: string | Array<{ readonly text?: string }>
      }>
    }
    if (body.model === "minimax/minimax-m2.7") {
      utilityCalls++
      return Response.json({
        provider: "groq",
        choices: [{ message: { content: "The two retained Git results and transcripts were compared." } }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      })
    }
    const headers = new Headers(init?.headers)
    if (headers.has("x-arena-assignment")) throw new Error("Contestant request carried a legacy routing token")
    const assignmentID = headers.get("x-arena-assignment-id")
    const scopeID = headers.get("x-arena-scope-id")
    const assigned = assignmentID && scopeID ? assignmentsByScope.get(`${scopeID}:${assignmentID}`) : undefined
    if (!assigned) throw new Error("Contestant request did not carry a valid opaque assignment")
    body.model = assigned.model.slug
    contestantRequests.push(body)
    const count = (calls.get(body.model) ?? 0) + 1
    calls.set(body.model, count)
    const number = ordinal.get(body.model) ?? ordinal.size + 1
    ordinal.set(body.model, number)
    if (options?.delayAllMs !== undefined) await Bun.sleep(options.delayAllMs)
    else if (options?.delayedOrdinal === number) await Bun.sleep(options.delayMs ?? 0)
    const latestUserMessage = body.messages?.findLast((message) => message.role === "user")
    const requestText = JSON.stringify(latestUserMessage?.content ?? "")
    const normalFixture = requestText.includes("canonical normal turn") || requestText.includes("without a battle")
    const transcriptOnlyFixture = requestText.includes("transcript-only normal turn")
    const normalCommandKey = `${body.model}\n${requestText}`
    const runNormalCommand = (normalFixture || transcriptOnlyFixture) && !completedNormalCommands.has(normalCommandKey)
    if (runNormalCommand) completedNormalCommands.add(normalCommandKey)
    const tool = runNormalCommand
      ? "bash"
      : count !== 1 || options?.emptyOrdinals?.includes(number)
        ? undefined
        : options?.questionOrdinals?.includes(number)
          ? "question"
          : "bash"
    return contestantResponse(
      "contestant",
      number,
      tool,
      runNormalCommand ? (transcriptOnlyFixture ? "transcript" : "file") : false,
      options?.contestantCommands?.[number],
      // OpenRouter generates one opaque ID per request even when a tool loop
      // sends multiple requests to the same model.
      `${number}-${count}`,
    )
  }
  setArenaCredentials({
    mode: "hosted",
    token: "test-session",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken(arenaControlToken),
  })
  globalThis.fetch = Object.assign(execute, { preconnect: original.preconnect.bind(original) })
  return {
    calls,
    contestantRequests,
    modelForAssignment: (assignmentID: string) => assignmentsByID.get(assignmentID)?.model.slug,
    utilityCalls: () => utilityCalls,
    restore: () => {
      setArenaCredentials(undefined)
      globalThis.fetch = original
    },
  }
}
async function exists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

async function waitForRemoved(path: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await exists(path))) return
    await Bun.sleep(10)
  }
  throw new Error(`Arena worktree was not removed: ${path}`)
}

async function waitForReadyChat(store: Store, chatID: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const chat = await store.chat(chatID)
    if (chat?.status === "ready") return chat
    await Bun.sleep(10)
  }
  throw new Error(`Arena chat did not return to ready: ${chatID}`)
}

async function waitForTurn(
  store: Store,
  turnID: string,
  state: TurnDocument["state"],
  timeoutOrUntil: number | ((turn: TurnDocument) => boolean) = 20_000,
) {
  // `until` is for a state the turn can re-enter: a review parks in `application_failed`, and its
  // answer can land the turn there again as `conflicted`.
  const until = typeof timeoutOrUntil === "function" ? timeoutOrUntil : undefined
  const deadline = Date.now() + (typeof timeoutOrUntil === "number" ? timeoutOrUntil : 20_000)
  while (Date.now() < deadline) {
    const turn = await store.turn(turnID)
    if (turn?.state === state && (!until || until(turn))) return turn
    if (turn && turn.state !== state && ["discarded", "application_failed", "canonicalization_failed"].includes(turn.state)) {
      const runs = await store.runsForTurn(turnID)
      throw new Error(
        `Arena turn reached ${turn.state} while waiting for ${state}: ${turn.failureReason ?? "no failure recorded"}; git=${JSON.stringify(turn.gitApplication)}; ${JSON.stringify(
          runs.map((run) => ({ side: run.side, runState: run.runState, error: run.error })),
        )}`,
      )
    }
    await Bun.sleep(10)
  }
  throw new Error(`Arena turn did not reach ${state}`)
}
/**
 * The warm pair is prepared after the turn completes, so that the chat reaches `ready` — and
 * the user's next prompt can start a turn — without waiting on the project's setup command.
 * `complete` therefore no longer implies a prepared pair; this is what does.
 */
async function waitForWarmPair(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const turn = await store.turn(turnID)
    const warm = turn?.warmPreparation
    if (warm?.state === "ready") return turn
    if (warm?.state === "failed") throw new Error(`Arena warm preparation failed: ${warm.error ?? "no error recorded"}`)
    await Bun.sleep(10)
  }
  throw new Error("Arena did not prepare a warm pair")
}

async function waitForCanonicalTranscriptChange(store: Store, chatID: string, previousHash: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const chat = await store.chat(chatID)
    if (chat && chat.canonicalTranscriptHash !== previousHash) return chat
    await Bun.sleep(10)
  }
  throw new Error("Arena did not reconcile the single-agent transcript")
}

async function waitForTrunkConflicts(store: Store, chatID: string, expected: ReadonlyArray<string>) {
  const deadline = Date.now() + 20_000
  let observed: ReadonlyArray<string> | undefined
  while (Date.now() < deadline) {
    const chat = await store.chat(chatID)
    observed = chat?.trunkConflicts
    if (chat && (observed ?? []).join("\n") === expected.join("\n")) return chat
    await Bun.sleep(10)
  }
  throw new Error(`Arena trunk conflicts stayed ${JSON.stringify(observed)} instead of ${JSON.stringify(expected)}`)
}

async function waitForOneCompletedRun(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  let observed: Awaited<ReturnType<Store["runsForTurn"]>> = []
  while (Date.now() < deadline) {
    observed = await store.runsForTurn(turnID)
    if (observed.filter((run) => run.completedAt).length === 1) return observed
    await Bun.sleep(10)
  }
  const turn = await store.turn(turnID)
  throw new Error(
    `Arena runs did not expose independent completion times: ${JSON.stringify({
      turn: turn && { state: turn.state, failureReason: turn.failureReason },
      runs: observed.map((run) => ({
        side: run.side,
        runState: run.runState,
        error: run.error,
        completedAt: run.completedAt,
      })),
    })}`,
  )
}

async function waitForMixedRunTerminals(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const runs = await store.runsForTurn(turnID)
    if (
      runs.filter((run) => run.runState === "complete" && run.selectable).length === 1 &&
      runs.filter((run) => run.runState === "pending").length === 1
    ) {
      return runs
    }
    await Bun.sleep(10)
  }
  throw new Error("Arena runs did not reach mixed complete and pending terminals")
}

async function waitForQuestions(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  headers: Record<string, string>,
  turnID: string,
  count: number,
) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const snapshot = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
    if (snapshot.runs.reduce((total, run) => total + (run.questions?.length ?? 0), 0) === count) return snapshot
    await Bun.sleep(10)
  }
  throw new Error(`Arena runs did not expose ${count} pending questions`)
}

async function waitForSelectableRun(store: Store, turnID: string, side: "a" | "b") {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const run = (await store.runsForTurn(turnID)).find((item) => item.side === side)
    if (run?.selectable) return run
    await Bun.sleep(10)
  }
  throw new Error(`Arena ${side.toUpperCase()} run did not become selectable`)
}

async function waitForComparison(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const comparison = await store.comparisons.findOne({ turnID })
    if (comparison?.state === "complete") return comparison
    if (comparison?.state === "failed") throw new Error(`Arena comparison failed: ${comparison.error}`)
    await Bun.sleep(10)
  }
  throw new Error("Arena comparison did not complete")
}

async function observeArenaStream(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  const frames: Frame[] = []
  let failure: unknown
  const reading = (async () => {
    const decoder = new TextDecoder()
    let pending = ""
    for (;;) {
      const value = await reader.read()
      if (value.done) return
      pending += decoder.decode(value.value, { stream: true }).replace(/\r\n/g, "\n")
      let boundary: number
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) frames.push(JSON.parse(data) as Frame)
      }
    }
  })().catch((error: unknown) => {
    failure = error
  })
  return {
    frames,
    async until(predicate: (frame: Frame) => boolean) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (failure) throw failure
        const found = frames.find(predicate)
        if (found) return found
        await Bun.sleep(20)
      }
      throw new Error("Arena SSE did not deliver the expected state")
    },
    async [Symbol.asyncDispose]() {
      await reader.cancel()
      await reading
      reader.releaseLock()
    },
  }
}

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setArenaCredentials(undefined)
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("Arena service vertical slice", () => {

  for (const action of ["send", "archive"] as const) {
    test(`keeps warm ownership local while another chat starts (${action})`, async () => {
      await using directory = await tmpdir({
        git: true,
        config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
      })
      await using data = await tmpdir()
      await writeFile(`${directory.path}/source.txt`, "base\n")
      await $`git add opencode.json source.txt`.cwd(directory.path).quiet()
      await $`git commit -m "test: cross-chat warm ownership"`.cwd(directory.path).quiet()
      await writeFile(`${directory.path}/source.txt`, "staged\n")
      await $`git add source.txt`.cwd(directory.path).quiet()
      await writeFile(`${directory.path}/source.txt`, "working\n")
      const store = await connectLocalStore({ directory: data.path })
      const command = "cat source.txt; printf 'LOCK_TOOL_OK\\n'"
      const router = installOpenRouterStub({ contestantCommands: { 1: command, 2: command, 3: command } })
      process.env.OPENCODE_ARENA = "1"
      setStoreForTest(store)
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const until = async (label: string, check: () => Promise<boolean>) => {
        const deadline = Date.now() + 60_000
        while (!(await check())) {
          if (Date.now() > deadline) throw new Error(`Warm ownership test did not make progress: ${label}`)
          await Bun.sleep(10)
        }
      }
      // Holds the background chat's next pair in its ignored-content sync, the part of warm
      // preparation that runs outside the repository lock. The foreground chat's first battle is
      // generation 1, so only the pair for the background chat's second turn waits here.
      let warmEntered = false
      let releaseWarm!: () => void
      const warmReleased = new Promise<void>((resolve) => {
        releaseWarm = resolve
      })
      const apply = CopySnapshot.applyIgnoredResync
      let held: ReturnType<typeof spyOn> | undefined
      try {
        const create = async (title: string) => {
          const session = await json<{ id: string }>(
            await request("/session", { method: "POST", headers, body: JSON.stringify({ title }) }),
          )
          const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${session.id}`, { headers }))
          return { sessionID: session.id, chatID: attached.chat.id }
        }
        const background = await create("Warm owner")
        const foreground = await create("Independent foreground")
        const send = (chatID: string) =>
          request(`/arena/chats/${chatID}/turns`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Read source.txt with a tool." }),
          })
        const first = await json<PublicSnapshot>(await send(background.chatID))
        await until("initial battle", async () => (await store.turn(first.turn!.id))?.state === "awaiting_vote")
        held = spyOn(CopySnapshot, "applyIgnoredResync").mockImplementation(async (input) => {
          if (input.targetRoot.includes("/generation-2-")) {
            warmEntered = true
            await warmReleased
          }
          return apply(input)
        })
        expect(
          (
            await request(`/arena/turns/${first.turn!.id}/vote`, {
              method: "POST",
              headers,
              body: JSON.stringify({ vote: "a" }),
            })
          ).status,
        ).toBe(200)
        await until("warm setup gate", async () => warmEntered)
        const pending =
          action === "send"
            ? send(background.chatID)
            : request(`/arena/sessions/${background.sessionID}/archive`, { method: "POST", headers })
        let foregroundResponse: Response | undefined
        void send(foreground.chatID)
          .then((response) => {
            foregroundResponse = response
          })
          .catch(() => undefined)
        void pending.catch(() => undefined)
        await until("foreground admission", async () => foregroundResponse !== undefined)
        const next = await json<PublicSnapshot>(foregroundResponse!)
        await until("foreground battle", async () => (await store.turn(next.turn!.id))?.state === "awaiting_vote")
        expect((await store.turn(first.turn!.id))?.warmPreparation?.state).toBe("pending")
        expect((await store.chat(background.chatID))?.activeTurnID).toBeUndefined()
        const runs = await store.runsForTurn(next.turn!.id)
        const parts = await Promise.all(
          runs.map(async (run) => {
            const messages = await json<
              Array<{ parts: Array<{ type: string; state?: { status: string; output?: string } }> }>
            >(await request(`/session/${run.rootSessionID}/message`, { headers }))
            expect(await Bun.file(`${run.worktree}/source.txt`).text()).toBe("working\n")
            expect(await $`git show :source.txt`.cwd(run.worktree).quiet().text()).toBe("staged\n")
            return messages.flatMap((message) => message.parts)
          }),
        )
        expect(
          parts
            .flat()
            .some(
              (part) =>
                part.type === "tool" &&
                part.state?.status === "completed" &&
                part.state.output?.includes("LOCK_TOOL_OK"),
            ),
        ).toBe(true)
        releaseWarm()
        const completed = await pending
        expect(completed.status).toBe(200)
        if (action === "send") {
          const resumed = await json<PublicSnapshot>(completed)
          await until(
            "same-chat continuation",
            async () => (await store.turn(resumed.turn!.id))?.state === "awaiting_vote",
          )
          const resumedRuns = await store.runsForTurn(resumed.turn!.id)
          expect(resumedRuns.every((run) => run.worktree.includes("generation-2-"))).toBe(true)
        } else {
          const archived = await json<PublicSnapshot>(completed)
          expect(archived.chat.status).toBe("archived")
          const warm = (await store.turn(first.turn!.id))?.warmPreparation
          expect(warm?.state).toBe("failed")
          const slots = Object.values(warm!.worktrees)
          expect(slots).toHaveLength(2)
          for (const slot of slots) {
            expect(await exists(slot!.directory)).toBe(false)
            if (slot!.forkedSessionID)
              expect((await request(`/session/${slot!.forkedSessionID}`, { headers })).status).toBe(404)
          }
        }
      } finally {
        releaseWarm()
        held?.mockRestore()
        router.restore()
        setStoreForTest(undefined)
        await disposeAllInstances()
        await store.close()
      }
    }, 180_000)
  }

  test("keeps assignment identities outside desktop records until the vote", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure opaque assignment fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Opaque Arena assignments" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Produce two blinded results." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not admit the opaque assignment battle")
      const unresolved = await waitForTurn(memory.store, turnID, "awaiting_vote")
      const privateBeforeVote = JSON.stringify({ turn: unresolved, runs: await memory.store.runsForTurn(turnID) })
      for (const profile of testProfiles) {
        expect(privateBeforeVote).not.toContain(profile.slug)
        expect(privateBeforeVote).not.toContain(profile.displayName)
      }
      expect(unresolved.placement.a.model).toBeUndefined()
      expect(unresolved.placement.b.model).toBeUndefined()

      const publicBeforeVote = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
      expect(publicBeforeVote.turn?.revealed).toBe(false)
      expect(publicBeforeVote.turn?.identities).toBeUndefined()

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
      const publicAfterVote = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
      expect(publicAfterVote.turn?.revealed).toBe(true)
      expect(testProfiles.map((profile) => profile.displayName)).toContain(publicAfterVote.turn?.identities?.a.name)
      expect(testProfiles.map((profile) => profile.displayName)).toContain(publicAfterVote.turn?.identities?.b.name)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("honors an already committed valid decision instead of applying a later choice", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure authoritative vote fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Authoritative Arena vote" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Produce two results for an authoritative vote." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not admit the authoritative vote battle")
      await waitForTurn(memory.store, turnID, "awaiting_vote")

      const committed = await fetch("https://control.test/api/arena/assignments", {
        method: "POST",
        headers: { Authorization: "Bearer test-session", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", kind: "battle", scopeID: turnID, decision: "select:a" }),
      })
      expect(committed.status).toBe(200)

      const acknowledged = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "b" }),
        }),
      )
      expect(acknowledged.turn?.vote).toBe("a")
      expect(acknowledged.turn?.appliedSide).toBe("a")
      await waitForTurn(memory.store, turnID, "complete")
      expect((await memory.store.turn(turnID))?.resolution).toMatchObject({
        kind: "vote",
        vote: "a",
        appliedSide: "a",
      })
    } finally {
      router.restore()
    }
  }, 30_000)

  test.each(["snapshot", "stream"])("blocks and restores a canonical checkout through %s", async (transport) => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure canonical recovery fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const gitDirectory = `${directory.path}/.git`
    const hiddenGitDirectory = `${directory.path}/.git.arena-unavailable`
    let checkoutHidden = false

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Canonical recovery",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(attached.chat.status).toBe("ready")

      const read = async () => {
        if (transport === "snapshot")
          return json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
        await using observed = await observeArenaStream(
          await request(`/arena/sessions/${source.id}/stream`, { headers }),
        )
        const frame = await observed.until((frame) => frame.kind === "snapshot")
        if (frame.kind !== "snapshot") throw new Error("Expected initial snapshot")
        return frame.snapshot
      }

      await rename(gitDirectory, hiddenGitDirectory)
      checkoutHidden = true
      const blocked = await read()
      expect(blocked.chat.status).toBe("blocked")
      expect(blocked.chat.blockedReason).toContain("trunk worktree is unavailable")
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("blocked")

      await $`git init -q`.cwd(directory.path)
      await $`git config user.email replacement@example.test`.cwd(directory.path).quiet()
      await $`git config user.name Replacement`.cwd(directory.path).quiet()
      await writeFile(`${directory.path}/replacement-repository.txt`, "replacement\n")
      await $`git add replacement-repository.txt`.cwd(directory.path).quiet()
      await $`git commit -m "test: unrelated replacement repository"`.cwd(directory.path).quiet()
      const replacement = await read()
      expect(replacement.chat.status).toBe("blocked")
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("blocked")

      await rm(gitDirectory, { recursive: true, force: true })
      await rename(hiddenGitDirectory, gitDirectory)
      checkoutHidden = false
      const restored = await read()
      expect(restored.chat.status).toBe("ready")
      expect(restored.chat.blockedReason).toBeUndefined()
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
    } finally {
      if (checkoutHidden) {
        await rm(gitDirectory, { recursive: true, force: true })
        await rename(hiddenGitDirectory, gitDirectory)
      }
    }
  })

  test("follows the trunk branch when the developer cuts one between turns", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure trunk rename fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    setArenaCredentials({
      mode: "hosted",
      token: "test-session",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: hashArenaControlToken(arenaControlToken),
    })

    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Trunk rename",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      }),
    )
    const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    expect(attached.chat.status).toBe("ready")
    expect(attached.chat.trunk.branch).toBeTruthy()

    // Cut at HEAD and checked out, which is what the workspace's Create branch action runs. The
    // commit does not move, so only the name the next turn would host contestants on changes.
    await $`git switch -c feature/cut-between-turns`.cwd(directory.path).quiet()

    const after = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    expect(after.chat.status).toBe("ready")
    expect(after.chat.trunk.branch).toBe("feature/cut-between-turns")
    const stored = await memory.store.chat(attached.chat.id)
    expect(stored?.arenaBranch).toBe("feature/cut-between-turns")
    expect(stored?.canonicalCheckout?.branch).toBe("feature/cut-between-turns")
    expect(stored?.repository.branch).toBe("feature/cut-between-turns")
  })

  test("tells a subscribed chat about a branch cut while it listens", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure subscribed trunk fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    setArenaCredentials({
      mode: "hosted",
      token: "test-session",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: hashArenaControlToken(arenaControlToken),
    })

    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Subscribed trunk",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      }),
    )

    // The app subscribes once and then listens, which is the case a re-attach would hide.
    await using observed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
    await observed.until((frame) => frame.kind === "snapshot")

    await $`git switch -c feature/cut-while-listening`.cwd(directory.path).quiet()

    // The chat's own state reaches a subscriber as a control change, not a second bootstrap.
    const carried = await observed.until(
      (frame) =>
        frame.kind === "changes" &&
        frame.changes.some(
          (change) => change.kind === "state" && change.snapshot.chat.trunk.branch === "feature/cut-while-listening",
        ),
    )
    expect(carried.kind).toBe("changes")
  })

  test("inspects a checkout another chat moved once, not on every poll", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure moved checkout fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    setArenaCredentials({
      mode: "hosted",
      token: "test-session",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: hashArenaControlToken(arenaControlToken),
    })

    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Moved checkout",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      }),
    )
    const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    const trunk = attached.chat.trunk.branch
    await using observed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
    await observed.until((frame) => frame.kind === "snapshot")
    const inspections = spyOn(ArenaGit, "inspectCanonical")
    try {
      // What another chat's vote on an existing branch leaves behind: a new branch name and a new
      // head. This chat records neither until its own next turn, so the branch answer keeps
      // disagreeing with the record. A full inspection writes the index tree, and the inspection
      // used to run on every tick and take index.lock under that other chat's next vote.
      await $`git switch -c feature/moved-by-another-chat`.cwd(directory.path).quiet()
      await $`git commit --allow-empty -m "test: another chat's winner"`.cwd(directory.path).quiet()
      const deadline = Date.now() + 10_000
      while (inspections.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(50)
      expect(inspections.mock.calls.length).toBe(1)
      await Bun.sleep(3_500)
      expect(inspections.mock.calls.length).toBe(1)

      const stored = await memory.store.chat(attached.chat.id)
      expect(stored?.status).toBe("ready")
      expect(stored?.canonicalCheckout?.branch).toBe(trunk)
    } finally {
      inspections.mockRestore()
    }
  })

  test("keeps a chat usable on a conflicted trunk and refuses only the battle", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure conflicted trunk fixture"`.cwd(directory.path).quiet()
    const trunkBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    await writeFile(`${directory.path}/f`, "base\n")
    await $`git add f`.cwd(directory.path).quiet()
    await $`git commit -m base`.cwd(directory.path).quiet()
    await $`git checkout -b side`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/f`, "side\n")
    await $`git commit -am side`.cwd(directory.path).quiet()
    await $`git checkout ${trunkBranch}`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/f`, "trunk\n")
    await $`git commit -am trunk`.cwd(directory.path).quiet()
    const merged = await $`git merge side`.cwd(directory.path).quiet().nothrow()
    expect(merged.exitCode).not.toBe(0)
    expect((await $`git ls-files -u`.cwd(directory.path).quiet().text()).trim().split("\n")).toHaveLength(3)

    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Conflicted trunk",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(attached.chat.status).toBe("ready")
      expect(attached.chat.trunkConflicts).toEqual(["f"])
      expect(attached.chat.blockedReason).toBeUndefined()

      const refused = await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "This battle must wait for a clean trunk." }),
      })
      const body = (await refused.json()) as { readonly data?: { readonly message?: string } }
      expect(refused.status).toBe(400)
      expect(body.data?.message).toContain("Unresolved merge conflicts: f")
      // Only startTurnUnlocked's guard names the single-agent escape. snapshotBase's
      // OperationError stops at the file list, so this pins which check refused the battle.
      expect(body.data?.message).toContain("turn Battle off")
      const held = await memory.store.chat(attached.chat.id)
      expect(held?.status).toBe("ready")
      expect(held?.activeTurnID).toBeUndefined()
      expect(memory.turns.values).toHaveLength(0)

      const previousHash = held?.canonicalTranscriptHash ?? ""
      const singlePass = await request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          parts: [{ type: "text", text: "Resolve the merge conflict in the trunk." }],
        }),
      })
      expect(singlePass.status).toBe(200)
      expect(await memory.store.latestSingleAgentRating(source.id)).toBeTruthy()
      const afterFirstPass = await waitForCanonicalTranscriptChange(memory.store, attached.chat.id, previousHash)
      // The normal-turn path writes the list too, so a single-agent turn on a conflicted trunk
      // must not erase it.
      expect(afterFirstPass.status).toBe("ready")
      expect(afterFirstPass.trunkConflicts).toEqual(["f"])

      await writeFile(`${directory.path}/f`, "resolved\n")
      await $`git add f`.cwd(directory.path).quiet()
      await $`git commit -m merged`.cwd(directory.path).quiet()

      // A second single-agent turn clears the list through beginNormalTurn and
      // reconcileNormalTurn, before any session GET can clear it through reconciliation.
      const secondPass = await request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          parts: [{ type: "text", text: "Confirm the trunk is clean now." }],
        }),
      })
      expect(secondPass.status).toBe(200)
      const afterSecondPass = await waitForTrunkConflicts(memory.store, attached.chat.id, [])
      expect(afterSecondPass.trunkConflicts).toBeUndefined()
      expect(afterSecondPass.status).toBe("ready")

      const cleared = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(cleared.chat.status).toBe("ready")
      expect(cleared.chat.trunkConflicts).toBeUndefined()
      expect((await memory.store.chat(attached.chat.id))?.trunkConflicts).toBeUndefined()
    } finally {
      router.restore()
    }
  }, 45_000)

  test("restores a blocked checkout while its stream stays connected", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
    const source = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Live canonical repair" }),
      }),
    )
    await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    const gitDirectory = `${directory.path}/.git`
    const hiddenGitDirectory = `${directory.path}/.git.arena-unavailable`
    await rename(gitDirectory, hiddenGitDirectory)
    let hidden = true
    try {
      await using observed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
      const initial = await observed.until((frame) => frame.kind === "snapshot")
      if (initial.kind !== "snapshot") throw new Error("Expected initial snapshot")
      expect(initial.snapshot.chat.status).toBe("blocked")
      await rename(hiddenGitDirectory, gitDirectory)
      hidden = false
      const restored = await observed.until(
        (frame) =>
          frame.kind === "changes" &&
          frame.changes.some((change) => change.kind === "state" && change.snapshot.chat.status === "ready"),
      )
      expect(restored.kind).toBe("changes")
      expect(observed.frames.filter((frame) => frame.kind === "snapshot")).toHaveLength(1)
      expect((await memory.store.chat(initial.snapshot.chat.id))?.status).toBe("ready")
    } finally {
      if (hidden) await rename(hiddenGitDirectory, gitDirectory)
    }
  })

  test("serializes concurrent turn starts for one chat", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure concurrent start fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Concurrent Arena start" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const responses = await Promise.all(
        ["First request", "Second request"].map((prompt) =>
          request(`/arena/chats/${attached.chat.id}/turns`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt }),
          }),
        ),
      )
      expect(responses.filter((response) => response.ok)).toHaveLength(1)
      expect(responses.filter((response) => !response.ok)).toHaveLength(1)
      const admittedResponse = responses.find((response) => response.ok)
      if (!admittedResponse) throw new Error("Arena did not admit either concurrent start")
      const admitted = await json<PublicSnapshot>(admittedResponse)
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return the admitted concurrent turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      expect(memory.turns.values).toHaveLength(1)
      expect(await memory.store.runsForTurn(turnID)).toHaveLength(2)
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
    } finally {
      router.restore()
    }
  }, 30_000)

  // Startup recovery runs again in this process, so the service's own records of the pair (its
  // watches and synced state) survive; a real restart loses them and re-clones every root.
  test("keeps a warm pair distrusted through startup recovery and refreshes it at the next send", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure warm recovery fixture"`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/.git/info/exclude`, "\n.arena-warm-cache\n", { flag: "a" })
    await writeFile(`${directory.path}/.arena-warm-cache`, "warm seed\n")
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Warm recovery" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Prepare a warm pair after this result." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return the warm recovery turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
      const completed = await waitForWarmPair(memory.store, turnID)
      const warmA = completed?.warmPreparation?.worktrees.a
      const warmB = completed?.warmPreparation?.worktrees.b
      if (!warmA || !warmB) throw new Error("Arena did not prepare both warm recovery worktrees")
      expect(completed?.warmPreparation?.state).toBe("ready")
      expect(await Bun.file(`${warmA.directory}/.arena-warm-cache`).text()).toBe("warm seed\n")
      expect(await Bun.file(`${warmB.directory}/.arena-warm-cache`).text()).toBe("warm seed\n")
      await writeFile(`${warmA.directory}/.arena-warm-cache`, "corrupted after preparation\n")
      await writeFile(`${warmB.directory}/opencode.json`, "{}\n")
      setStoreForTest(memory.store)
      await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))

      // Nothing watched the pair while the daemon was down, so recovery keeps it without trusting
      // it, and the next send brings it back to its base where it stands.
      expect((await memory.store.turn(turnID))?.warmPreparation?.state).toBe("ready")
      expect(await Promise.all([exists(warmA.directory), exists(warmB.directory)])).toEqual([true, true])
      const next = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Start from the refreshed pair." }),
        }),
      )
      const nextTurnID = next.turn?.id
      if (!nextTurnID) throw new Error("Arena did not return the turn after recovery")
      await waitForTurn(memory.store, nextTurnID, "awaiting_vote")
      expect((await memory.store.turn(nextTurnID))?.setupTimings?.warmPath).toBe("refreshed")
      const runs = await memory.store.runsForTurn(nextTurnID)
      expect(runs.map((run) => run.worktree).toSorted()).toEqual([warmA.directory, warmB.directory].toSorted())
      for (const run of runs) {
        expect(await Bun.file(`${run.worktree}/.arena-warm-cache`).text()).toBe("warm seed\n")
        expect(await Bun.file(`${run.worktree}/opencode.json`).text()).toBe(
          await Bun.file(`${directory.path}/opencode.json`).text(),
        )
      }
    } finally {
      router.restore()
    }
  }, 30_000)

  /**
   * A chat left as a battle leaves it: one vote applied, the retained winner and the next turn's warm
   * pair in place. Records which directories' instances the engine disposes from here on.
   */
  async function votedChatWithWarmPair(directory: string, memory: ReturnType<typeof memoryStore>) {
    const headers = { "content-type": "application/json", "x-opencode-directory": directory }
    const source = await json<{ id: string }>(
      await request("/session", { method: "POST", headers, body: JSON.stringify({ title: "Idle unload" }) }),
    )
    const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
    const disposed = new Set<string>()
    const onEvent = (event: GlobalEvent) => {
      if (event.payload.type === "server.instance.disposed" && event.directory) disposed.add(event.directory)
    }
    GlobalBus.on("event", onEvent)
    const observe = () => request(`/arena/sessions/${source.id}/stream`, { headers }).then(observeArenaStream)
    const send = async (prompt: string) => {
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt }),
        }),
      )
      if (!admitted.turn?.id) throw new Error("Arena did not return the turn")
      return admitted.turn.id
    }
    return {
      disposed,
      observe,
      send,
      stopObserving: () => GlobalBus.off("event", onEvent),
      async voteAndWarm(turnID: string) {
        await waitForTurn(memory.store, turnID, "awaiting_vote")
        await json<PublicSnapshot>(
          await request(`/arena/turns/${turnID}/vote`, {
            method: "POST",
            headers,
            body: JSON.stringify({ vote: "a" }),
          }),
        )
        await waitForTurn(memory.store, turnID, "complete")
        const completed = await waitForWarmPair(memory.store, turnID)
        const warm = [
          completed?.warmPreparation?.worktrees.a?.directory,
          completed?.warmPreparation?.worktrees.b?.directory,
        ]
        const winner = (await memory.store.chat(attached.chat.id))?.retainedWinner?.worktree
        if (!warm[0] || !warm[1] || !winner) throw new Error("Arena did not keep a winner and a warm pair")
        return { warm: [warm[0], warm[1]], winner }
      },
    }
  }

  async function disposedWithin(disposed: ReadonlySet<string>, directories: readonly string[], milliseconds: number) {
    const deadline = Date.now() + milliseconds
    while (directories.some((path) => !disposed.has(path)) && Date.now() < deadline) await Bun.sleep(50)
    return directories.map((path) => disposed.has(path))
  }

  test("unloads an idle chat's contestant worktrees and still sends from its warm pair", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure idle unload fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_IDLE_UNLOAD_MS = "200"
    setStoreForTest(memory.store)
    const chat = await votedChatWithWarmPair(directory.path, memory)

    try {
      const { warm, winner } = await chat.voteAndWarm(await chat.send("Leave a winner and a warm pair behind."))

      // Nobody watches the chat, so once it has been idle for the threshold its worktrees unload.
      expect(await disposedWithin(chat.disposed, [...warm, winner], 10_000)).toEqual([true, true, true])

      const nextTurnID = await chat.send("Start from the unloaded pair.")
      await waitForTurn(memory.store, nextTurnID, "awaiting_vote")
      // Unloading drops only the instances, so the pair is still trusted and reused as it stands.
      expect((await memory.store.turn(nextTurnID))?.setupTimings?.warmPath).toBe("reused")
      const runs = await memory.store.runsForTurn(nextTurnID)
      const byPath = (left: string, right: string) => left.localeCompare(right)
      expect(runs.map((run) => run.worktree).toSorted(byPath)).toEqual(warm.toSorted(byPath))
    } finally {
      chat.stopObserving()
      delete process.env.OPENCODE_ARENA_IDLE_UNLOAD_MS
      router.restore()
    }
  }, 60_000)

  test("keeps the chat the app streams loaded and unloads it once the stream closes", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure watched unload fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_IDLE_UNLOAD_MS = "200"
    setStoreForTest(memory.store)
    const chat = await votedChatWithWarmPair(directory.path, memory)

    try {
      const observed = await chat.observe()
      await observed.until((frame) => frame.kind === "snapshot")
      const { warm } = await chat.voteAndWarm(await chat.send("Leave a warm pair behind while watched."))

      expect(await disposedWithin(chat.disposed, warm, 1_500)).toEqual([false, false])

      await observed[Symbol.asyncDispose]()

      expect(await disposedWithin(chat.disposed, warm, 10_000)).toEqual([true, true])
    } finally {
      chat.stopObserving()
      delete process.env.OPENCODE_ARENA_IDLE_UNLOAD_MS
      router.restore()
    }
  }, 60_000)

  test("reuses warm environments unchanged after a transcript-only single-agent turn", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure warm reuse fixture"`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/.git/info/exclude`, "\n.arena-warm-cache\n", { flag: "a" })
    await writeFile(`${directory.path}/.arena-warm-cache`, "warm seed\n")
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Warm reuse" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const first = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Prepare environments for an unchanged continuation." }),
        }),
      )
      const firstTurnID = first.turn?.id
      if (!firstTurnID) throw new Error("Arena did not return the first warm reuse turn")
      await waitForTurn(memory.store, firstTurnID, "awaiting_vote")
      const acknowledged = await json<PublicSnapshot>(
        await request(`/arena/turns/${firstTurnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      expect(acknowledged.turn?.state).toBe("applying")
      await waitForTurn(memory.store, firstTurnID, "complete")
      const completed = await waitForWarmPair(memory.store, firstTurnID)
      const warmA = completed?.warmPreparation?.worktrees.a
      const warmB = completed?.warmPreparation?.worktrees.b
      if (!warmA || !warmB) throw new Error("Arena did not prepare the warm reuse pair")

      const beforeNormal = await memory.store.chat(attached.chat.id)
      if (!beforeNormal) throw new Error("Arena did not retain the warm reuse chat")
      const beforeNormalHash = beforeNormal.canonicalTranscriptHash
      const normal = await request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "Handle this transcript-only normal turn without changing files." }],
        }),
      })
      expect(normal.status).toBe(200)
      await waitForCanonicalTranscriptChange(memory.store, attached.chat.id, beforeNormalHash)

      const second = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Reuse the prepared environments exactly." }),
        }),
      )
      const secondTurnID = second.turn?.id
      if (!secondTurnID) throw new Error("Arena did not return the second warm reuse turn")
      await waitForTurn(memory.store, secondTurnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(secondTurnID)
      expect(runs.map((run) => run.worktree).toSorted()).toEqual([warmA.directory, warmB.directory].toSorted())
      // Reused as prepared: neither side was synced again at the send.
      const secondTimings = (await memory.store.turn(secondTurnID))?.setupTimings
      expect(secondTimings?.warmPath).toBe("reused")
      expect([secondTimings?.sides?.a?.syncPath, secondTimings?.sides?.b?.syncPath]).toEqual(["reused", "reused"])

      await json<PublicSnapshot>(
        await request(`/arena/turns/${secondTurnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, secondTurnID, "complete")
    } finally {
      router.restore()
    }
  }, 45_000)

  test("waits for the retained winner only while it still serves a port", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure retained release fixture"`.cwd(directory.path).quiet()
    await using arenaDirectory = await tmpdir()
    const store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const battle = async (chatID: string, prompt: string) => {
      const started = await json<PublicSnapshot>(
        await request(`/arena/chats/${chatID}/turns`, { method: "POST", headers, body: JSON.stringify({ prompt }) }),
      )
      const turnID = started.turn?.id
      if (!turnID) throw new Error(`Arena did not start: ${prompt}`)
      await waitForTurn(store, turnID, "awaiting_vote")
      return turnID
    }
    const win = async (turnID: string) => {
      await request(`/arena/turns/${turnID}/vote`, { method: "POST", headers, body: JSON.stringify({ vote: "a" }) })
      await waitForTurn(store, turnID, "complete")
      const retained = (await store.chat((await store.turn(turnID))!.chatID))?.retainedWinner
      if (!retained) throw new Error("Arena did not retain the winner")
      const run = await store.run(retained.runID)
      if (!run?.portAliases) throw new Error("Retained winner has no port bank")
      return run
    }

    try {
      const source = await json<{ id: string }>(
        await request("/session", { method: "POST", headers, body: JSON.stringify({ title: "Retained release" }) }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const chatID = attached.chat.id

      // A preview the winner left listening is gone before either contestant is prompted.
      const serving = await win(await battle(chatID, "Leave a preview behind."))
      const listener = createServer()
      await new Promise<void>((resolve) => listener.listen(serving.portAliases!.PASEO_PORT, "127.0.0.1", resolve))
      let waitedTurnID: string
      try {
        waitedTurnID = await battle(chatID, "Continue while the preview listens.")
      } finally {
        await new Promise((resolve) => listener.close(resolve))
      }
      const waited = await store.turn(waitedTurnID)
      const removedWhileServing = (await store.run(serving._id))?.worktreeRemovedAt
      if (!removedWhileServing || !waited?.transitionTimestamps.worktrees_ready) {
        throw new Error("The serving winner was not released during the send")
      }
      expect(removedWhileServing.getTime()).toBeLessThanOrEqual(waited.transitionTimestamps.worktrees_ready.getTime())

      // With nothing listening, the release still completes and still records the transition.
      const idle = await win(waitedTurnID)
      const releasedTurnID = await battle(chatID, "Continue with no preview left.")
      const deadline = Date.now() + 15_000
      while (!(await store.run(idle._id))?.worktreeRemovedAt) {
        if (Date.now() > deadline) throw new Error("The idle winner was never released")
        await Bun.sleep(50)
      }
      expect((await store.chat(chatID))?.retainedWinner?.runID).not.toBe(idle._id)
      expect((await store.turn(releasedTurnID))?.transitionEvent?.previousWinningRunID).toBe(idle._id)
    } finally {
      router.restore()
      await store.close()
    }
  }, 90_000)

  test.each(["manifest", "ready"] as const)(
    "reuses a warm pair when submission overlaps %s publication",
    async (gate) => {
      await using directory = await tmpdir({
        git: true,
        config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
      })
      await $`git add opencode.json`.cwd(directory.path).quiet()
      await $`git commit -m "test: configure warm handoff race fixture"`.cwd(directory.path).quiet()
      await writeFile(`${directory.path}/.git/info/exclude`, "\n.arena-warm-cache\n", { flag: "a" })
      await writeFile(`${directory.path}/.arena-warm-cache`, "warm seed\n")
      const memory = memoryStore()
      const router = installOpenRouterStub()
      process.env.OPENCODE_ARENA = "1"
      process.env.OPENROUTER_API_KEY = "test-openrouter-key"
      setStoreForTest(memory.store)
      setArenaCredentials({
        mode: "hosted",
        token: "test-session",
        controlPlaneUrl: "https://control.test",
        controlTokenHash: hashArenaControlToken(arenaControlToken),
      })
      let observingAdmission = true
      const waitForAdmissionQueue = async (chatID: string) => {
        const deadline = Date.now() + 15_000
        while (observingAdmission && Date.now() < deadline) {
          const log = await fs.readFile(`${Global.Path.log}/opencode.log`, "utf8").catch(() => "")
          if (
            log.split("\n").some((line) => line.includes("Arena turn waiting for preparation") && line.includes(chatID))
          )
            return
          await Bun.sleep(10)
        }
        if (observingAdmission) throw new Error("Admission neither queued nor passed its warm-reuse decision")
      }
      let foregroundManifestObserved!: () => void
      const foregroundManifest = new Promise<void>((resolve) => {
        foregroundManifestObserved = resolve
      })
      let releaseWarmReady!: () => void
      const warmReadyRelease = new Promise<void>((resolve) => {
        releaseWarmReady = resolve
      })

      try {
        const headers = {
          "content-type": "application/json",
          "x-opencode-directory": directory.path,
        }
        const source = await json<{ id: string }>(
          await request("/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "Warm handoff race" }),
          }),
        )
        const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))

        // The memory harness stores live document objects. Clone every chat read so the test has
        // database snapshot semantics instead of observing later in-place mutations.
        const originalUpdateTurn = memory.store.updateTurn.bind(memory.store)
        const originalChat = memory.store.chat.bind(memory.store)
        memory.store.chat = async (chatID) => {
          const current = await originalChat(chatID)
          return current ? structuredClone(current) : current
        }
        let secondRequestStarted = false
        const originalStoreArtifact = memory.store.storeArtifact.bind(memory.store)
        let manifestObserved!: () => void
        const manifestReady = new Promise<void>((resolve) => {
          manifestObserved = resolve
        })
        memory.store.storeArtifact = async (input) => {
          if (gate === "manifest" && input._id.includes("|warm-")) {
            manifestObserved()
            await warmReadyRelease
          }
          if (
            gate === "manifest" &&
            secondRequestStarted &&
            input._id.endsWith("|copy-manifest") &&
            !input._id.includes("|warm-")
          ) {
            // The previous implementation can pass its warm-reuse decision before
            // warming owns the repository lock. Hold it here until the pair is ready.
            foregroundManifestObserved()
            await warmReadyObservedPromise
          }
          return originalStoreArtifact(input)
        }
        memory.store.updateTurn = async (turnID, patch) => {
          if (patch.warmPreparation?.state === "ready" && !warmReadyPatch) {
            warmReadyPatch = structuredClone(patch.warmPreparation)
            const a = warmReadyPatch.worktrees.a
            const b = warmReadyPatch.worktrees.b
            if (!a || !b) throw new Error("Warm pair is incomplete")
            warmReadyObserved()
            if (gate === "ready") await warmReadyRelease
          }
          return originalUpdateTurn(turnID, patch)
        }

        let warmReadyPatch: NonNullable<Parameters<Store["updateTurn"]>[1]["warmPreparation"]> | undefined
        let warmReadyObserved!: () => void
        const warmReadyObservedPromise = new Promise<void>((resolve) => {
          warmReadyObserved = resolve
        })

        const first = await json<PublicSnapshot>(
          await request(`/arena/chats/${attached.chat.id}/turns`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Prepare a pair for the handoff race." }),
          }),
        )
        const firstTurnID = first.turn?.id
        if (!firstTurnID) throw new Error("Arena did not return the first warm handoff turn")
        await waitForTurn(memory.store, firstTurnID, "awaiting_vote", 45_000)
        await json<PublicSnapshot>(
          await request(`/arena/turns/${firstTurnID}/vote`, {
            method: "POST",
            headers,
            body: JSON.stringify({ vote: "a" }),
          }),
        )
        await waitForTurn(memory.store, firstTurnID, "complete")
        await (gate === "manifest" ? manifestReady : warmReadyObservedPromise)
        // Begin the next request while warming is held at this published boundary.
        // Admission must claim the pair after the warmer releases the gate.
        secondRequestStarted = true
        const secondResponse = request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Continue while the warm pair finishes." }),
        })
        if (gate === "manifest") await Promise.race([waitForAdmissionQueue(attached.chat.id), foregroundManifest])
        releaseWarmReady()
        await Promise.race([warmReadyObservedPromise, secondResponse])
        if (!warmReadyPatch) throw new Error("Arena did not expose the warm handoff publication")
        const warm = warmReadyPatch
        const warmA = warm.worktrees.a
        const warmB = warm.worktrees.b
        if (!warmA || !warmB) throw new Error("Arena did not prepare the warm handoff pair")
        const warmManifest = await memory.artifacts.findOne({ _id: warmA.copyManifestID })
        if (!warmManifest) throw new Error("Arena did not persist the warm copy manifest")

        const second = await json<PublicSnapshot>(await secondResponse)
        const secondTurnID = second.turn?.id
        if (!secondTurnID) throw new Error("Arena did not return the raced warm handoff turn")
        await waitForTurn(memory.store, secondTurnID, "awaiting_vote", 45_000)
        const runs = await memory.store.runsForTurn(secondTurnID)
        expect(runs.map((run) => run.worktree).toSorted()).toEqual([warmA.directory, warmB.directory].toSorted())
        // Claimed as published, not synced again at the send.
        expect((await memory.store.turn(secondTurnID))?.setupTimings?.warmPath).toBe("reused")

        const admitted = await memory.store.turn(secondTurnID)
        expect(admitted?.warmPreparation?.generation).toBe(warm.generation)
        const admittedManifest = admitted?.copySnapshot?.manifestID
          ? await memory.artifacts.findOne({ _id: admitted.copySnapshot.manifestID })
          : undefined
        expect(admittedManifest?.createdAt).toEqual(warmManifest.createdAt)
      } finally {
        observingAdmission = false
        releaseWarmReady()
        router.restore()
      }
    },
    90_000,
  )

  test("refreshes warm environments after a file changes deep inside an ignored tree", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure deep ignored edit fixture"`.cwd(directory.path).quiet()
    // An ignored directory, so the manifest records one root whose own inode, size and
    // mtime say nothing about the file nested inside it.
    await writeFile(`${directory.path}/.git/info/exclude`, "\ndeps\n", { flag: "a" })
    await $`mkdir -p ${directory.path}/deps/pkg`.quiet()
    await writeFile(`${directory.path}/deps/pkg/index.js`, "before\n")
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Deep ignored edit" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const first = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Prepare environments to be invalidated." }),
        }),
      )
      const firstTurnID = first.turn?.id
      if (!firstTurnID) throw new Error("Arena did not return the first turn")
      await waitForTurn(memory.store, firstTurnID, "awaiting_vote")
      await request(`/arena/turns/${firstTurnID}/vote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ vote: "a" }),
      })
      await waitForTurn(memory.store, firstTurnID, "complete")
      const completed = await waitForWarmPair(memory.store, firstTurnID)
      const warmA = completed?.warmPreparation?.worktrees.a
      if (!warmA) throw new Error("Arena did not prepare the warm pair")
      expect(await Bun.file(`${warmA.directory}/deps/pkg/index.js`).text()).toBe("before\n")

      await writeFile(`${directory.path}/deps/pkg/index.js`, "after\n")
      // The filesystem reports asynchronously, and the assertion below is about what the
      // send sees, which is only meaningful once the report has landed.
      await Bun.sleep(1_500)

      const second = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Both contestants must see the edited dependency." }),
        }),
      )
      const secondTurnID = second.turn?.id
      if (!secondTurnID) throw new Error("Arena did not return the second turn")
      await waitForTurn(memory.store, secondTurnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(secondTurnID)
      expect(runs).toHaveLength(2)
      for (const run of runs) {
        expect(await Bun.file(`${run.worktree}/deps/pkg/index.js`).text()).toBe("after\n")
      }
    } finally {
      router.restore()
    }
  }, 60_000)

  test("rejects a battle before mutation when the control plane cannot assign contestants", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena preflight fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({
      assignmentError: "Arena contestant pool is unavailable",
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena access preflight" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const worktreesBefore = await $`git worktree list --porcelain`.cwd(directory.path).quiet().text()

      const response = await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "This battle must not be admitted." }),
      })
      const body = (await response.json()) as { readonly data?: { readonly message?: string } }

      expect(response.status).toBe(400)
      expect(body.data?.message).toContain("contestant pool is unavailable")
      expect(router.contestantRequests).toHaveLength(0)
      expect(memory.turns.values).toHaveLength(0)
      expect(memory.runs.values).toHaveLength(0)
      expect(memory.chats.values[0]).toMatchObject({ status: "ready", turnCount: 0 })
      expect(memory.chats.values[0]).not.toHaveProperty("activeTurnID")
      expect(await $`git worktree list --porcelain`.cwd(directory.path).quiet().text()).toBe(worktreesBefore)
      expect(await $`git for-each-ref refs/battles`.cwd(directory.path).quiet().text()).toBe("")
    } finally {
      router.restore()
    }
  })

  test("rotates single-agent contestants per completed pass and records votes separately", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure single-agent rating fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 500 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    try {
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Arena single-agent rating",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const beforePass = await json<PublicSnapshot>(
        await request(`/arena/sessions/${source.id}?userID=user-1`, { headers }),
      )
      expect(beforePass.singleAgent).toBeUndefined()

      const firstMessageID = MessageID.ascending()
      const firstPass = await request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: firstMessageID,
          parts: [{ type: "text", text: "Handle this first pass without a battle." }],
        }),
      })
      expect(firstPass.status).toBe(200)

      const hidden = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(hidden.singleAgent).toMatchObject({ revealed: false })
      expect(hidden.singleAgent?.identity).toBeUndefined()
      const firstRating = await memory.store.latestSingleAgentRating(source.id)
      if (!firstRating) throw new Error("Arena did not persist the first single-agent pass")
      expect(firstRating).toMatchObject({ messageID: firstMessageID, precedingTurnCount: 0 })
      expect(firstRating.completedAt).toBeInstanceOf(Date)
      expect(firstRating.resultTree).toBe(
        (await $`git rev-parse HEAD^{tree}`.cwd(directory.path).quiet().text()).trim(),
      )
      // A rating is keyed by session, so it takes its owner from the chat.
      expect(firstRating.userId).toBe("user-1")

      const revealed = await json<PublicSnapshot>(
        await request(`/arena/sessions/${source.id}/single-agent-vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ratingID: firstRating._id,
            vote: "up",
            participantID: "cid_single-agent-voter",
          }),
        }),
      )
      expect(revealed.singleAgent).toMatchObject({ id: firstRating._id, revealed: true, vote: "up" })
      expect(testProfiles.map((profile) => profile.displayName)).toContain(revealed.singleAgent?.identity?.name)

      const secondRequestBoundary = router.contestantRequests.length
      const secondMessageID = MessageID.ascending()
      const secondPass = request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: secondMessageID,
          parts: [{ type: "text", text: "Handle this second pass without a battle." }],
        }),
      })
      while (router.contestantRequests.length === secondRequestBoundary) await Bun.sleep(5)

      const running = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(running.singleAgent).toBeUndefined()
      const secondRating = await memory.store.latestSingleAgentRating(source.id)
      if (!secondRating) throw new Error("Arena did not persist the second single-agent pass")
      expect(secondRating.messageID).toBe(secondMessageID)
      expect(secondRating.assignment.assignmentID).not.toBe(firstRating.assignment.assignmentID)
      expect(secondRating.completedAt).toBeUndefined()

      expect((await secondPass).status).toBe(200)
      const secondHidden = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(secondHidden.singleAgent).toEqual({ id: secondRating._id, revealed: false })
      expect(secondHidden.singleAgent?.id).not.toBe(firstRating._id)
      expect(memory.singleAgentRatings.values).toHaveLength(2)
      expect(memory.singleAgentRatings.values[0]).toMatchObject({
        vote: "up",
        voteParticipantID: "cid_single-agent-voter",
      })
      expect(memory.singleAgentRatings.values[1]?.vote).toBeUndefined()
      expect(memory.turns.values).toHaveLength(0)

      const staleVote = await request(`/arena/sessions/${source.id}/single-agent-vote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ratingID: firstRating._id, vote: "up" }),
      })
      expect(staleVote.status).toBe(400)
    } finally {
      router.restore()
    }
  })

  test("keeps interaction responses hydrated while contestant questions settle", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena question fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ questionOrdinals: [1, 2] })
    const previousBuildSHA = process.env.OPENCODE_ARENA_BUILD_SHA
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Arena question response hydration",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Ask before continuing." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted question turn")
      const pending = await waitForQuestions(request, headers, turnID, 2)
      await using streamed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
      const initial = await streamed.until((frame) => frame.kind === "snapshot")
      if (initial.kind !== "snapshot") throw new Error("Missing interaction snapshot")
      expect(initial.snapshot.runs.flatMap((run) => run.questions ?? [])).toHaveLength(2)
      const [first, second] = pending.runs.toSorted((left, right) => left.side.localeCompare(right.side))
      const firstRequestID = first?.questions?.[0]?.id
      const secondRequestID = second?.questions?.[0]?.id
      if (!first || !second || typeof firstRequestID !== "string" || typeof secondRequestID !== "string") {
        throw new Error("Arena did not expose both pending question request IDs")
      }

      const replied = await json<PublicSnapshot>(
        await request(
          `/arena/runs/${encodeURIComponent(first.id)}/questions/${encodeURIComponent(firstRequestID)}/reply`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ answers: [["Proceed"]] }),
          },
        ),
      )
      const repliedFirst = replied.runs.find((run) => run.id === first.id)
      const stillPending = replied.runs.find((run) => run.id === second.id)
      expect(repliedFirst?.questions).toEqual([])
      expect(repliedFirst?.messages?.length).toBeGreaterThan(0)
      expect(Object.values(repliedFirst?.parts ?? {}).flat().length).toBeGreaterThan(0)
      expect(stillPending?.questions?.map((question) => question.id)).toEqual([secondRequestID])

      const rejected = await json<PublicSnapshot>(
        await request(
          `/arena/runs/${encodeURIComponent(second.id)}/questions/${encodeURIComponent(secondRequestID)}/reject`,
          { method: "POST", headers },
        ),
      )
      const rejectedSecond = rejected.runs.find((run) => run.id === second.id)
      expect(rejectedSecond?.questions).toEqual([])
      expect(rejectedSecond?.messages?.length).toBeGreaterThan(0)
      expect(Object.values(rejectedSecond?.parts ?? {}).flat().length).toBeGreaterThan(0)
      await streamed.until(
        (frame) =>
          frame.kind === "changes" &&
          frame.changes.some(
            (change) => change.kind === "state" && change.snapshot.runs.every((run) => !run.questions?.length),
          ),
      )
      expect(streamed.frames.filter((frame) => frame.kind === "snapshot")).toHaveLength(1)
    } finally {
      if (previousBuildSHA) process.env.OPENCODE_ARENA_BUILD_SHA = previousBuildSHA
      else delete process.env.OPENCODE_ARENA_BUILD_SHA
      router.restore()
    }
  }, 30_000)

  test("resumes both contestants after completed results and returns to voting", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure completed reply fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Completed Arena replies",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await (async () => {
        await using initial = await observeArenaStream(
          await request(`/arena/sessions/${source.id}/stream`, { headers }),
        )
        const frame = await initial.until((frame) => frame.kind === "snapshot")
        if (frame.kind !== "snapshot") throw new Error("Missing new chat snapshot")
        expect(frame.snapshot.chat.status).toBe("ready")
        expect(frame.snapshot.runs).toEqual([])
        return frame.snapshot
      })()
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create two results, then wait for feedback." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted reply turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      await waitForComparison(memory.store, turnID)
      await using streamed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
      const firstFrame = await streamed.until((frame) => frame.kind === "snapshot")
      expect(firstFrame.kind).toBe("snapshot")
      if (firstFrame.kind !== "snapshot") throw new Error("Missing initial snapshot")
      expect(firstFrame.snapshot.turn?.state).toBe("awaiting_vote")
      expect(firstFrame.snapshot.runs.every((run) => run.messages?.length)).toBe(true)
      expect(firstFrame.snapshot.events).toEqual([])
      const initialRequestCount = router.contestantRequests.length
      const initialRuns = await memory.store.runsForTurn(turnID)
      const promptBoundaries = new Map(initialRuns.map((run) => [run.side, run.promptMessageID]))
      const initialResults = new Map(
        initialRuns.map((run) => [run.side, { finalCommit: run.finalCommit, permanentRef: run.permanentRef }]),
      )
      const archiveHashes = new Map(
        await Promise.all(
          initialRuns.map(
            async (run) =>
              [
                run.side,
                (await memory.sessionArchives.findOne({ _id: run.transcriptArchiveID }))?.contentHash,
              ] as const,
          ),
        ),
      )
      await Promise.all(
        initialRuns.map((run) => writeFile(`${run.worktree}/continued-result.txt`, `continued ${run.side}\n`, "utf8")),
      )

      const resumed = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Apply this follow-up to both completed results.", target: "both" }),
        }),
      )
      expect(resumed.turn?.state).toBe("running")
      expect((await memory.store.runsForTurn(turnID)).map((run) => run.runState)).toEqual(["pending", "pending"])

      const continuedTurn = await waitForTurn(memory.store, turnID, "awaiting_vote")
      expect(continuedTurn.finalizedSides?.toSorted()).toEqual(["a", "b"])
      await waitForComparison(memory.store, turnID)
      const continuedRuns = await memory.store.runsForTurn(turnID)
      expect(router.contestantRequests).toHaveLength(initialRequestCount + 2)
      expect(continuedRuns.every((run) => run.runState === "complete" && run.selectable)).toBe(true)
      expect(continuedRuns.every((run) => run.promptMessageID === promptBoundaries.get(run.side))).toBe(true)
      for (const run of continuedRuns) {
        const initial = initialResults.get(run.side)
        expect(run.permanentRef).toBe(initial?.permanentRef)
        expect(run.finalCommit).not.toBe(initial?.finalCommit)
        if (!run.permanentRef || !run.finalCommit) throw new Error("Continued run did not retain a final ref")
        expect((await $`git rev-parse ${run.permanentRef}`.cwd(directory.path).quiet().text()).trim()).toBe(
          run.finalCommit,
        )
        const archive = await memory.sessionArchives.findOne({ _id: run.transcriptArchiveID })
        expect(archive?.contentHash).not.toBe(archiveHashes.get(run.side))
      }
      await streamed.until(
        (frame) =>
          frame.kind === "changes" &&
          frame.changes.some((change) => change.kind === "state" && change.snapshot.turn?.state === "awaiting_vote"),
      )
      expect(streamed.frames.filter((frame) => frame.kind === "snapshot")).toHaveLength(1)
      expect(
        streamed.frames.some(
          (frame) =>
            frame.kind === "changes" &&
            frame.changes.some((change) => change.kind === "text" || change.kind === "part"),
        ),
      ).toBe(true)
      expect(memory.comparisons.values).toHaveLength(1)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("archives an unresolved chat and removes both contestant worktrees", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena archive fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Archived Arena chat",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create results that will be discarded by workspace archive." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted archive turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const before = await memory.store.runsForTurn(turnID)
      expect(await Promise.all(before.map((run) => exists(run.worktree)))).toEqual([true, true])

      const archived = await json<PublicSnapshot | null>(
        await request(`/arena/sessions/${source.id}/archive`, { method: "POST", headers }),
      )
      expect(archived?.chat.status).toBe("archived")
      expect(archived?.turn?.state).toBe("discarded")
      expect(archived?.turn?.resolution).toEqual({ kind: "stopped", resolution: "discard" })
      const after = await memory.store.runsForTurn(turnID)
      expect(after.every((run) => !!run.worktreeRemovedAt && run.retention === "none")).toBe(true)
      expect(await Promise.all(before.map((run) => exists(run.worktree)))).toEqual([false, false])
    } finally {
      router.restore()
    }
  }, 30_000)

  test("resumes a finished contestant while the other contestant is still working", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure mixed reply fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 1_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Mixed Arena reply",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Finish one result before the other." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted mixed reply turn")

      const mixedRuns = await waitForMixedRunTerminals(memory.store, turnID)
      const finished = mixedRuns.find((run) => run.runState === "complete")
      if (!finished?.transcriptArchiveID) throw new Error("Finished run did not retain its transcript archive")
      const firstArchive = await memory.sessionArchives.findOne({ _id: finished.transcriptArchiveID })
      const finishedModel = router.modelForAssignment(finished.assignment.assignmentID)
      if (!finishedModel) throw new Error("Finished run did not retain an opaque assignment")
      const finishedRequestBoundary = router.calls.get(finishedModel) ?? 0

      const resumed = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: "Revise your finished result while the other side works.",
            target: finished.side,
          }),
        }),
      )
      expect(resumed.turn?.state).toBe("running")
      expect(resumed.runs.find((run) => run.side === finished.side)?.runState).toBe("pending")

      await waitForTurn(memory.store, turnID, "awaiting_vote")
      await waitForComparison(memory.store, turnID)
      const finalRuns = await memory.store.runsForTurn(turnID)
      const resumedRun = finalRuns.find((run) => run.side === finished.side)
      expect(finalRuns.every((run) => run.runState === "complete" && run.selectable)).toBe(true)
      expect(router.calls.get(finishedModel)).toBe(finishedRequestBoundary + 1)
      expect(resumedRun?.transcriptArchiveID).toBeTruthy()
      const resumedArchive = resumedRun?.transcriptArchiveID
        ? await memory.sessionArchives.findOne({ _id: resumedRun.transcriptArchiveID })
        : null
      expect(resumedArchive?.contentHash).not.toBe(firstArchive?.contentHash)
      expect(router.utilityCalls()).toBe(1)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("interrupts a queued steer and resumes the same contestant session", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure interrupt steer fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayAllMs: 5_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Interrupt queued steer",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Run a tool before answering." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted interrupt turn")

      const deadline = Date.now() + 60_000
      let target: RunDocument | undefined
      while (Date.now() < deadline) {
        const turn = await memory.store.turn(turnID)
        const runs = await memory.store.runsForTurn(turnID)
        target = turn?.state === "running" ? runs.find((run) => run.runState === "pending") : undefined
        if (target && router.contestantRequests.length >= 2) break
        await Bun.sleep(10)
      }
      if (!target) throw new Error("Arena did not keep a contestant running for interruption")

      expect(
        (
          await request(`/arena/turns/${turnID}/reply`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Use the queued steer.", target: target.side }),
          })
        ).status,
      ).toBe(200)

      let pendingMessageID: string | undefined
      while (Date.now() < deadline) {
        const messages = await json<Array<{ info: { id: string; role: string }; parts: readonly unknown[] }>>(
          await request(`/session/${target.rootSessionID}/message`, { headers }),
        )
        pendingMessageID = messages.findLast(
          (message) => message.info.role === "user" && message.info.id !== target!.promptMessageID,
        )?.info.id
        if (pendingMessageID) break
        await Bun.sleep(10)
      }
      if (!pendingMessageID) throw new Error("Arena did not persist the queued steer")

      const requestBoundary = router.contestantRequests.length
      const interrupted = await request(
        `/arena/runs/${target._id}/steer/${encodeURIComponent(pendingMessageID)}/interrupt`,
        { method: "POST", headers },
      )
      expect(interrupted.status).toBe(200)

      while (Date.now() < deadline) {
        const turn = await memory.store.turn(turnID)
        const runs = await memory.store.runsForTurn(turnID)
        if (
          turn?.state === "running" &&
          runs.some((run) => run._id === target!._id && run.runState === "pending") &&
          router.contestantRequests.length > requestBoundary
        )
          break
        await Bun.sleep(10)
      }
      const resumedTurn = await memory.store.turn(turnID)
      const resumedRun = (await memory.store.runsForTurn(turnID)).find((run) => run._id === target!._id)
      if (resumedTurn?.state !== "running" || resumedRun?.runState !== "pending") {
        throw new Error("Arena did not keep the resumed contestant running for a second interruption")
      }
      expect(
        (
          await request(`/arena/turns/${turnID}/reply`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Use the second queued steer.", target: target.side }),
          })
        ).status,
      ).toBe(200)
      let secondPendingMessageID: string | undefined
      while (Date.now() < deadline) {
        const messages = await json<Array<{ info: { id: string; role: string } }>>(
          await request(`/session/${target.rootSessionID}/message`, { headers }),
        )
        secondPendingMessageID = messages.findLast(
          (message) => message.info.role === "user" && message.info.id !== target!.promptMessageID,
        )?.info.id
        if (secondPendingMessageID && secondPendingMessageID !== pendingMessageID) break
        await Bun.sleep(10)
      }
      if (!secondPendingMessageID || secondPendingMessageID === pendingMessageID) {
        throw new Error("Arena did not persist the second queued steer")
      }
      const interruptedAgain = await request(
        `/arena/runs/${target._id}/steer/${encodeURIComponent(secondPendingMessageID)}/interrupt`,
        { method: "POST", headers },
      )
      expect(interruptedAgain.status).toBe(200)

      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const finalRun = (await memory.store.runsForTurn(turnID)).find((run) => run._id === target!._id)
      expect(finalRun?.runState).toBe("complete")
      const messages = await json<Array<{ info: { id: string; role: string; parentID?: string } }>>(
        await request(`/session/${target.rootSessionID}/message`, { headers }),
      )
      expect(messages.filter((message) => message.info.id === pendingMessageID)).toHaveLength(1)
      expect(
        messages.filter((message) => message.info.role === "assistant" && message.info.parentID === pendingMessageID),
      ).toHaveLength(1)
      expect(messages.filter((message) => message.info.id === secondPendingMessageID)).toHaveLength(1)
      expect(
        messages.filter(
          (message) => message.info.role === "assistant" && message.info.parentID === secondPendingMessageID,
        ),
      ).toHaveLength(1)
      expect(router.contestantRequests.length).toBeGreaterThanOrEqual(4)
      const stale = await request(
        `/arena/runs/${target._id}/steer/${encodeURIComponent(pendingMessageID)}/interrupt`,
        { method: "POST", headers },
      )
      expect(stale.status).toBe(400)
    } finally {
      router.restore()
    }
  }, 90_000)

  test("discards multiple queued steers without interrupting active work", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure discard steer fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayAllMs: 5_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Discard queued steers",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Run a long command before answering." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted discard turn")

      const deadline = Date.now() + 60_000
      let target: RunDocument | undefined
      while (Date.now() < deadline) {
        const turn = await memory.store.turn(turnID)
        const runs = await memory.store.runsForTurn(turnID)
        target = turn?.state === "running" ? runs.find((run) => run.runState === "pending") : undefined
        if (target && router.contestantRequests.length >= 2) break
        await Bun.sleep(10)
      }
      if (!target) throw new Error("Arena did not keep a contestant running for discard")
      const activeRequestBoundary = router.contestantRequests.length

      for (const prompt of ["Discard this first queued steer.", "Discard this second queued steer."]) {
        expect(
          (
            await request(`/arena/turns/${turnID}/reply`, {
              method: "POST",
              headers,
              body: JSON.stringify({ prompt, target: target.side }),
            })
          ).status,
        ).toBe(200)
      }

      type Message = { info: { id: string; role: string; parentID?: string }; parts: Array<{ text?: string }> }
      const readMessages = async () =>
        json<Message[]>(await request(`/session/${target!.rootSessionID}/message`, { headers }))
      let queuedIDs: string[] = []
      while (Date.now() < deadline) {
        const messages = await readMessages()
        queuedIDs = messages
          .filter((message) => message.info.role === "user" && message.info.id !== target!.promptMessageID)
          .map((message) => message.info.id)
        if (queuedIDs.length >= 2) break
        await Bun.sleep(10)
      }
      if (queuedIDs.length < 2) throw new Error("Arena did not persist both queued steers")

      const discarded = await request(`/arena/runs/${target._id}/steer/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageIDs: queuedIDs }),
      })
      expect(discarded.status).toBe(200)
      expect(router.contestantRequests.length).toBe(activeRequestBoundary)
      expect((await readMessages()).some((message) => queuedIDs.includes(message.info.id))).toBe(false)

      const original = await request(`/arena/runs/${target._id}/steer/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageIDs: [target.promptMessageID] }),
      })
      expect(original.status).toBe(400)
      const invalid = await request(`/arena/runs/${target._id}/steer/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageIDs: ["missing-steer-message"] }),
      })
      expect(invalid.status).toBe(400)
      const duplicate = await request(`/arena/runs/${target._id}/steer/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageIDs: [queuedIDs[0], queuedIDs[0]] }),
      })
      expect(duplicate.status).toBe(400)

      expect(
        (
          await request(`/arena/turns/${turnID}/reply`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Keep this consumed steer.", target: target.side }),
          })
        ).status,
      ).toBe(200)
      let consumedID: string | undefined
      while (Date.now() < deadline) {
        const messages = await readMessages()
        const consumed = messages.find(
          (message) => message.info.role === "user" && message.info.id !== target!.promptMessageID,
        )
        consumedID = consumed?.info.id
        if (consumedID && messages.some((message) => message.info.parentID === consumedID)) break
        await Bun.sleep(10)
      }
      if (!consumedID) throw new Error("Arena did not persist the consumed steer")
      const consumed = await request(`/arena/runs/${target._id}/steer/discard`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageIDs: [consumedID] }),
      })
      expect(consumed.status).toBe(400)
      expect((await readMessages()).some((message) => message.info.id === consumedID)).toBe(true)

      await waitForTurn(memory.store, turnID, "awaiting_vote")
      expect(router.contestantRequests.length).toBeGreaterThan(activeRequestBoundary)
      expect(router.contestantRequests.some((request) => JSON.stringify(request).includes("Discard this first"))).toBe(
        false,
      )
      expect(
        router.contestantRequests.some((request) => JSON.stringify(request).includes("Discard this second")),
      ).toBe(false)
    } finally {
      router.restore()
    }
  }, 90_000)

  test("a reply to both resumes the finished contestant and steers the one still working", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure mixed both reply fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    // The second contestant is held long enough for the first one's result to be committed, which
    // takes a second or more, so the test sees one finalized side while the other still works.
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 8_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Mixed Arena reply to both",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Finish one result before the other." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted mixed reply turn")

      // One side finished, with its result finalized, and the other still working.
      const deadline = Date.now() + 45_000
      const mixed = async () => {
        const runs = await memory.store.runsForTurn(turnID)
        const finalized = (await memory.store.turn(turnID))?.finalizedSides ?? []
        const finished = runs.find((run) => run.runState === "complete")
        const working = runs.find((run) => run.runState === "pending")
        return finished && working && finalized.includes(finished.side) ? runs : undefined
      }
      let mixedRuns = await mixed()
      while (!mixedRuns && Date.now() < deadline) {
        await Bun.sleep(10)
        mixedRuns = await mixed()
      }
      if (!mixedRuns) throw new Error("Arena runs did not reach one finalized and one working side")
      const models = mixedRuns.map((run) => router.modelForAssignment(run.assignment.assignmentID))
      if (models.some((model) => !model)) throw new Error("A run did not retain an opaque assignment")

      const replied = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Both sides: keep the change minimal.", target: "both" }),
        }),
      )
      expect(replied.turn?.state).toBe("running")
      expect(replied.runs.map((run) => `${run.side}:${run.runState}`)).toEqual(["a:pending", "b:pending"])

      await waitForTurn(memory.store, turnID, "awaiting_vote", 45_000)
      const finalRuns = await memory.store.runsForTurn(turnID)
      expect(finalRuns.every((run) => run.runState === "complete" && run.selectable)).toBe(true)
      for (const model of models) {
        expect(
          router.contestantRequests.some(
            (body) => body.model === model && JSON.stringify(body.messages).includes("Both sides: keep the change minimal."),
          ),
        ).toBe(true)
      }
    } finally {
      router.restore()
    }
  }, 90_000)

  test("a reply to both sent before the finished contestant's result is committed waits and reaches both", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure unsettled both reply fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 8_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    // Hold the first side's finalization open, so its run reads complete while its side is not yet
    // in `finalizedSides`: the window a reply used to be dropped in.
    let releaseFinalization = () => {}
    const finalizationHeld = new Promise<void>((resolve) => {
      releaseFinalization = resolve
    })
    let held = false
    const markRunFinalized = memory.store.markRunFinalized.bind(memory.store)
    memory.store.markRunFinalized = async (input) => {
      if (!held) {
        held = true
        await finalizationHeld
      }
      return markRunFinalized(input)
    }

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Unsettled Arena reply to both",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Finish one result before the other." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted unsettled reply turn")

      const deadline = Date.now() + 45_000
      const unsettled = async () => {
        const runs = await memory.store.runsForTurn(turnID)
        const finalized = (await memory.store.turn(turnID))?.finalizedSides ?? []
        const finished = runs.find((run) => run.runState === "complete")
        const working = runs.find((run) => run.runState === "pending")
        return held && finished && working && !finalized.includes(finished.side) ? runs : undefined
      }
      let unsettledRuns = await unsettled()
      while (!unsettledRuns && Date.now() < deadline) {
        await Bun.sleep(10)
        unsettledRuns = await unsettled()
      }
      if (!unsettledRuns) throw new Error("Arena runs did not reach one unfinalized finished side")
      const models = unsettledRuns.map((run) => router.modelForAssignment(run.assignment.assignmentID))

      const reply = request(`/arena/turns/${turnID}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Both sides: settle first, then reply.", target: "both" }),
      })
      setTimeout(releaseFinalization, 300)
      const replied = await json<PublicSnapshot>(await reply)
      expect(replied.turn?.state).toBe("running")
      expect(replied.runs.map((run) => `${run.side}:${run.runState}`)).toEqual(["a:pending", "b:pending"])
      expect((await memory.store.turn(turnID))?.steerCount).toBe(1)

      await waitForTurn(memory.store, turnID, "awaiting_vote", 45_000)
      for (const model of models) {
        expect(
          router.contestantRequests.some(
            (body) =>
              body.model === model && JSON.stringify(body.messages).includes("Both sides: settle first, then reply."),
          ),
        ).toBe(true)
      }
    } finally {
      releaseFinalization()
      router.restore()
    }
  }, 90_000)

  test("a reply that cannot resume the finished contestant fails, reaches neither side, and is not counted", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure unclaimed both reply fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 8_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    // Another writer took the turn between the reply's read and its claim.
    memory.store.claimRunningReplyContinuation = async (turnID) => {
      const turn = await memory.store.turn(turnID)
      if (!turn) throw new Error(`Arena turn not found: ${turnID}`)
      return { turn, claimed: false as const, comparisonID: undefined }
    }

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Unclaimed Arena reply to both",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Finish one result before the other." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted unclaimed reply turn")

      const deadline = Date.now() + 45_000
      const mixed = async () => {
        const runs = await memory.store.runsForTurn(turnID)
        const finalized = (await memory.store.turn(turnID))?.finalizedSides ?? []
        const finished = runs.find((run) => run.runState === "complete")
        const working = runs.find((run) => run.runState === "pending")
        return finished && working && finalized.includes(finished.side) ? runs : undefined
      }
      while (!(await mixed()) && Date.now() < deadline) await Bun.sleep(10)
      if (!(await mixed())) throw new Error("Arena runs did not reach one finalized and one working side")

      const refused = await request(`/arena/turns/${turnID}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Both sides: this one is refused.", target: "both" }),
      })
      expect(refused.status).toBe(400)
      expect(await refused.text()).toContain("Send it again")
      expect((await memory.store.turn(turnID))?.steerCount ?? 0).toBe(0)

      await waitForTurn(memory.store, turnID, "awaiting_vote", 45_000)
      expect(
        router.contestantRequests.some((body) => JSON.stringify(body.messages).includes("this one is refused")),
      ).toBe(false)
    } finally {
      router.restore()
    }
  }, 90_000)

  test("runs and continues battles from a dirty canonical checkout without moving HEAD or the index", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure dirty arena fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 750 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Dirty Arena canonical session",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const head = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
      await Bun.write(`${directory.path}/user-draft.txt`, "uncommitted user work\n")
      await $`git add user-draft.txt`.cwd(directory.path).quiet()
      const index = (await $`git write-tree`.cwd(directory.path).quiet().text()).trim()
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const chat = await memory.store.chat(attached.chat.id)
      if (!chat) throw new Error("Arena did not persist the isolated chat")
      const canonical = chat.repository.root

      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create a result without losing my current work." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted dirty turn")
      const partiallyCompleted = await waitForOneCompletedRun(memory.store, turnID)
      expect(partiallyCompleted.filter((run) => run.completedAt)).toHaveLength(1)
      expect(partiallyCompleted.filter((run) => !run.completedAt)).toHaveLength(1)
      const activeSession = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(activeSession.chat.status).toBe("battle_active")
      expect(activeSession.runs.every((run) => (run.messages?.length ?? 0) > 0)).toBe(true)
      expect(activeSession.runs.every((run) => Object.values(run.parts ?? {}).flat().length > 0)).toBe(true)
      const turn = await waitForTurn(memory.store, turnID, "awaiting_vote")
      expect(turn.baseSnapshot).toMatchObject({ canonicalHead: head, indexTree: index })
      expect(turn.baseSnapshot?.permanentRef).toBeTruthy()
      expect(turn.frozenBaseSHA).not.toBe(head)
      expect(turn.frozenBaseSHA).not.toBe(chat.currentCanonicalSHA)
      const finishedRuns = await memory.store.runsForTurn(turnID)
      const durations = finishedRuns.map((run) => run.completedAt!.getTime() - run.startedAt!.getTime())
      expect(Math.abs(durations[0]! - durations[1]!)).toBeGreaterThanOrEqual(500)

      const acknowledged = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      expect(acknowledged.turn?.state).toBe("applying")
      await waitForTurn(memory.store, turnID, "complete")
      const completed = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
      expect(completed.turn?.state).toBe("complete")
      expect(completed.chat.canonicalSHA).toBe(head)
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(head)
      expect((await $`git write-tree`.cwd(directory.path).quiet().text()).trim()).toBe(index)
      expect(await Bun.file(`${directory.path}/user-draft.txt`).text()).toBe("uncommitted user work\n")
      expect(await Bun.file(`${directory.path}/arena-result.txt`).exists()).toBe(true)

      const continued = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Continue from the selected dirty-checkout result." }),
        }),
      )
      const continuedTurnID = continued.turn?.id
      if (!continuedTurnID) throw new Error("Arena did not return a continuation turn")
      await waitForTurn(memory.store, continuedTurnID, "awaiting_vote")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${continuedTurnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, continuedTurnID, "complete")
      const continuedResult = await json<PublicSnapshot>(await request(`/arena/turns/${continuedTurnID}`, { headers }))
      expect(continuedResult.turn?.state).toBe("complete")
      expect(continuedResult.chat.canonicalSHA).toBe(head)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("completes with visible conflict markers and admits the next battle", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure conflict fixture"`.cwd(directory.path).quiet()
    await writeFile(`${directory.path}/.git/info/exclude`, "\n.arena-warm-cache\n", { flag: "a" })
    await writeFile(`${directory.path}/.arena-warm-cache`, "canonical cache\n")
    const initialHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = "printf 'contestant result\\n' > arena-result.txt; git update-ref refs/heads/conflict-carry-over HEAD"
    const router = installOpenRouterStub({ contestantCommands: { 1: command, 2: command } })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena conflict session" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create the contested result file." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted conflict turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")

      await Bun.write(`${directory.path}/arena-result.txt`, "developer version\n")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )

      // The developer's own edit to the contested file collides with the winner's, so the vote
      // stops before writing anything and asks. This is the flow the callout drives: answer
      // "Let an agent resolve", get the markers, clear them.
      const reviewed = await waitForTurn(
        memory.store,
        turnID,
        "application_failed",
        (turn) => turn.gitApplication?.state === "review",
      )
      const edits = reviewed.gitApplication?.review?.items.find((item) => item.kind === "edits")
      expect(edits).toMatchObject({ key: "@edits", paths: ["arena-result.txt"], unmergeable: [] })
      expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toBe("developer version\n")
      expect(
        (await $`git rev-parse --verify --quiet conflict-carry-over`.cwd(directory.path).quiet().nothrow()).exitCode,
      ).not.toBe(0)
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/retry-resolution`, {
          method: "POST",
          headers,
          body: JSON.stringify({ answers: [{ key: "@edits", fingerprint: edits!.fingerprint, choice: "combine" }] }),
        }),
      )
      const conflicted = await waitForTurn(
        memory.store,
        turnID,
        "application_failed",
        (turn) => turn.gitApplication?.state === "conflicted",
      )
      expect(conflicted.gitApplication?.state).toBe("conflicted")
      expect(conflicted.gitApplication?.conflicts).toContain("arena-result.txt")
      // The whole result lands at once: the markers in the checkout and the branch the winner made.
      expect(conflicted.gitApplication?.refs).toEqual([{ ref: "refs/heads/conflict-carry-over", action: "created" }])
      expect((await $`git rev-parse conflict-carry-over`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)
      expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toContain("<<<<<<<")
      // The promotion writes its whole result in one step, so a conflicted path is an ordinary
      // dirty file. Nothing is unmerged and no sequencer is open -- which is why the parked turn
      // waits on the markers rather than on `git diff --diff-filter=U`.
      const parkedStatus = (await $`git status --short`.cwd(directory.path).quiet().text()).trim()
      expect(parkedStatus).toContain("arena-result.txt")
      expect(parkedStatus.startsWith("U") || parkedStatus.at(1) === "U").toBe(false)
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)

      // A parked promotion takes prompts, and this is the one the callout sends. It lands on the
      // canonical session after the winner's grafted transcript, which is what used to doom it: the
      // retry's graft cleared every message at or after its anchor before re-copying, so the
      // conversation that resolved the conflict disappeared the moment it succeeded.
      const canonicalSessionID = attached.chat.canonicalSessionID
      const resolvePrompt = await request(`/session/${canonicalSessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          noReply: true,
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "help me resolve conflicts" }],
        }),
      })
      expect(resolvePrompt.status).toBe(200)
      // The graft is forked alongside the apply, so a park that returned without waiting on it
      // would leave a half-copied transcript under the prompt above.
      const graftedBefore = (await memory.store.turn(turnID))?.canonicalGraftedAt
      expect(graftedBefore).toBeTruthy()

      // Editing the markers out is the whole of the work. Nothing is staged here on purpose: a
      // trunk merge ends in the user's own commit, and the retry has no unmerged index to read.
      await Bun.write(`${directory.path}/arena-result.txt`, "resolved version\n")

      // And nobody presses anything. Resolving a file writes nothing the daemon can hear, so the
      // app asks again on a timer by re-subscribing, and that subscribe has to re-read the
      // checkout -- otherwise the callout stands over a resolved workspace until the session is
      // attached again. The loop is the timer: an early subscribe can land while the agent's own
      // turn is still settling, which the resume deliberately waits out.
      const resumeDeadline = Date.now() + 20_000
      while (Date.now() < resumeDeadline) {
        if ((await memory.store.turn(turnID))?.state === "complete") break
        await using observed = await observeArenaStream(
          await request(`/arena/sessions/${source.id}/stream`, { headers }),
        )
        await observed.until((frame) => frame.kind === "snapshot")
        await Bun.sleep(250)
      }
      await waitForTurn(memory.store, turnID, "complete")
      expect((await memory.store.turn(turnID))?.gitApplication?.state).toBe("applied")
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)
      expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toBe("resolved version\n")
      // The finished promotion still reports the branch it created with the markers.
      expect((await memory.store.turn(turnID))?.gitApplication?.refs).toEqual([
        { ref: "refs/heads/conflict-carry-over", action: "created" },
      ])
      expect((await $`git rev-parse conflict-carry-over`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)

      const canonicalHistory = await (await request(`/session/${canonicalSessionID}/message`, { headers })).text()
      expect(canonicalHistory).toContain("help me resolve conflicts")
      // Skipped rather than re-run, which is the only way the prompt above could survive it.
      expect((await memory.store.turn(turnID))?.canonicalGraftedAt).toEqual(graftedBefore!)
    } finally {
      router.restore()
    }
  }, 90_000)

  test("can discard the winning result from a review without changing the checkout", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure discard-winner fixture"`.cwd(directory.path).quiet()
    await Bun.write(`${directory.path}/developer-state.txt`, "base\n")
    await $`git add developer-state.txt`.cwd(directory.path).quiet()
    await $`git commit -m "test: add developer state fixture"`.cwd(directory.path).quiet()
    const initialHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    await Bun.write(`${directory.path}/developer-state.txt`, "base\nstaged\n")
    await $`git add developer-state.txt`.cwd(directory.path).quiet()
    await Bun.write(`${directory.path}/developer-state.txt`, "base\nstaged\nunstaged\n")
    const initialIndex = (await $`git write-tree`.cwd(directory.path).quiet().text()).trim()
    const initialStatus = (await $`git status --short`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena discard winner session" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create the discarded result file." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted discard-winner turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")

      await Bun.write(`${directory.path}/arena-result.txt`, "developer version\n")
      // A revert in progress is something Arena will not write over, so the vote parks on a review.
      await Bun.write(`${directory.path}/.git/REVERT_HEAD`, `${initialHead}\n`)
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      const reviewed = await waitForTurn(memory.store, turnID, "application_failed")
      expect(reviewed.gitApplication?.state).toBe("review")
      expect(reviewed.gitApplication?.review?.items).toEqual([
        { kind: "busy", key: "@busy", fingerprint: "revert", operation: "revert" },
      ])

      const pausedMessage = await request(`/session/${attached.chat.canonicalSessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          noReply: true,
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "keep this message while deciding" }],
        }),
      })
      expect(pausedMessage.status).toBe(200)

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/retry-resolution`, {
          method: "POST",
          headers,
          body: JSON.stringify({ mode: "discard_winner" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "discarded")
      await $`rm -f .git/REVERT_HEAD`.cwd(directory.path).quiet()

      const completed = await memory.store.turn(turnID)
      expect(completed?.gitApplication?.state).toBe("discarded")
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)
      expect((await $`git write-tree`.cwd(directory.path).quiet().text()).trim()).toBe(initialIndex)
      expect((await $`git status --short`.cwd(directory.path).quiet().text()).trim().split(/\r?\n/).toSorted()).toEqual(
        [initialStatus, "?? arena-result.txt"].filter(Boolean).toSorted(),
      )
      expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toBe("developer version\n")
      expect((await memory.store.runsForTurn(turnID)).every((run) => run.worktreeRemovedAt)).toBe(true)
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
      expect((await memory.store.chat(attached.chat.id))?.retainedWinner).toBeUndefined()
      const history = await (await request(`/session/${attached.chat.canonicalSessionID}/message`, { headers })).text()
      expect(history).toContain("keep this message while deciding")

      const storedChat = await memory.store.chat(attached.chat.id)
      const selectedRun = await memory.store.run(reviewed.runIDs.a)
      if (!completed || !storedChat || !selectedRun) throw new Error("Missing discard recovery fixture")
      for (const crashState of ["applying", "discarding"] as const) {
        completed.state = crashState
        completed.gitApplication = { state: crashState === "applying" ? "failed" : "discarded" }
        storedChat.status = "battle_active"
        storedChat.activeTurnID = turnID
        storedChat.retainedWinner = {
          runID: selectedRun._id,
          worktree: selectedRun.worktree,
          resultRef: "refs/arena/test-discard-recovery",
          state: "live",
        }
        setStoreForTest(memory.store)
        const recovered = await json<PublicSnapshot>(await request(`/arena/chats/${storedChat._id}`, { headers }))
        expect(recovered.chat.status).toBe("ready")
        expect(recovered.turn?.state).toBe("discarded")
        expect(storedChat.retainedWinner).toBeUndefined()
        expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(initialHead)
        expect((await $`git write-tree`.cwd(directory.path).quiet().text()).trim()).toBe(initialIndex)
        expect(await Bun.file(`${directory.path}/developer-state.txt`).text()).toBe("base\nstaged\nunstaged\n")
        expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toBe("developer version\n")
      }

      // The transcript digest updated during discard must admit the next battle, while the
      // staged and unstaged developer edits remain the checkout's starting state.
      const next = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Verify the preserved workspace state." }),
        }),
      )
      const nextTurnID = next.turn?.id
      if (!nextTurnID) throw new Error("Arena did not admit a turn after discarding the winner")
      await waitForTurn(memory.store, nextTurnID, "running")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${nextTurnID}/stop`, { method: "POST", headers }),
      )
      await waitForTurn(memory.store, nextTurnID, "awaiting_stop_resolution")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${nextTurnID}/stop-resolution`, {
          method: "POST",
          headers,
          body: JSON.stringify({ resolution: "discard" }),
        }),
      )
      await waitForTurn(memory.store, nextTurnID, "discarded")
    } finally {
      router.restore()
    }
  }, 90_000)

  test("recovers a conflict persisted by an older daemon without blocking the chat", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure legacy conflict fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Legacy Arena conflict session" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create the contested result file." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return a legacy conflict turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const winner = (await memory.store.runsForTurn(turnID)).find((run) => run.side === "a")
      const turn = memory.turns.values.find((item) => item._id === turnID)
      if (!winner?.finalCommit || !turn) throw new Error("Arena did not retain the winner")

      await Bun.write(`${directory.path}/arena-result.txt`, "developer version\n")
      await $`git add arena-result.txt`.cwd(directory.path).quiet()
      const developerTree = (await $`git write-tree`.cwd(directory.path).quiet().text()).trim()
      await $`git reset --mixed HEAD`.cwd(directory.path).quiet()
      const baseTree = (await $`git rev-parse HEAD^{tree}`.cwd(directory.path).quiet().text()).trim()
      const winnerTree = (
        await $`git rev-parse ${winner.finalCommit}^{tree}`.cwd(directory.path).quiet().text()
      ).trim()
      await $`git read-tree -m ${baseTree} ${developerTree} ${winnerTree}`.cwd(directory.path).quiet()
      await $`git checkout --conflict=merge -- arena-result.txt`.cwd(directory.path).quiet()

      turn.state = "application_failed"
      turn.resolution = { kind: "vote", vote: "a", appliedSide: "a" }
      turn.vote = "a"
      turn.appliedSide = "a"
      turn.resultingCanonicalSHA = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
      turn.gitApplication = {
        state: "conflicted",
        reason: "Resolve the checkout's Git conflicts, then retry the Arena resolution.",
        resultCommit: winner.finalCommit,
        conflicts: ["arena-result.txt"],
        baseCommit: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
      }
      setStoreForTest(memory.restart())

      const recovered = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}`, { headers }),
      )
      // "Not blocked" is the claim, not "idle". A parked promotion holds the chat on its own turn
      // and stays there; what changed is that the gates let it take prompts while it waits.
      expect(recovered.chat.status).not.toBe("blocked")
      // The turn stays parked on its markers, like one this daemon parked itself.
      expect(recovered.turn?.state).toBe("application_failed")
      expect(recovered.turn?.gitApplication?.state).toBe("conflicted")
      expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toContain("<<<<<<<")
      // The unmerged index the older daemon left is settled on sight. Nothing downstream expects
      // one, and the markers it materializes are the same markers that were already there.
      const status = (await $`git status --short`.cwd(directory.path).quiet().text()).trim()
      expect(status).toContain("arena-result.txt")
      expect(status.startsWith("U") || status.at(1) === "U").toBe(false)

      // And it finishes the ordinary way: edit the markers out, retry, done.
      await Bun.write(`${directory.path}/arena-result.txt`, "resolved version\n")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/retry-resolution`, { method: "POST", headers, body: "{}" }),
      )
      await waitForTurn(memory.store, turnID, "complete")
      expect((await memory.store.turn(turnID))?.gitApplication?.state).toBe("applied")
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
    } finally {
      router.restore()
    }
  }, 30_000)

  test("installs the winning contestant's real commit chain and residual Git state", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure commit promotion fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const command = (ordinal: number) =>
      `printf 'committed ${ordinal}\\n' > committed.txt; git add committed.txt; git commit -m 'contestant ${ordinal}'; git commit --allow-empty -m 'contestant empty ${ordinal}'; printf 'unstaged ${ordinal}\\n' >> committed.txt; printf 'staged ${ordinal}\\n' > residual-staged.txt; git add residual-staged.txt; printf 'untracked ${ordinal}\\n' > residual-untracked.txt`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(1), 2: command(2) },
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena commit promotion" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Commit the result and leave the remaining state intact." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted commit turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(turnID)
      const winner = runs.find((run) => run.side === "a")
      if (!winner?.agentCommit || !winner.finalCommit) throw new Error("Arena did not capture the commit chain")
      expect(winner.agentCommits).toHaveLength(2)
      expect(winner.fullyCommitted).toBe(false)

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")

      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(winner.agentCommit)
      expect((await memory.store.turn(turnID))?.resultingCanonicalSHA).toBe(winner.agentCommit)
      expect(
        (await $`git rev-list --reverse ${winner.agentCommits![0]}^..HEAD`.cwd(directory.path).quiet().text())
          .trim()
          .split("\n"),
      ).toEqual(winner.agentCommits)
      const status = await $`git status --short`.cwd(directory.path).quiet().text()
      expect(status).toContain(" M committed.txt")
      expect(status).toContain("A  residual-staged.txt")
      expect(status).toContain("?? residual-untracked.txt")
      expect(await $`git log -2 --format=%s`.cwd(directory.path).quiet().text()).not.toContain("Arena")
      expect(
        (
          await $`git rev-parse ${winner.permanentRef!.replace(/\/a$/, "/selected")}`.cwd(directory.path).quiet().text()
        ).trim(),
      ).toBe(winner.finalCommit)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("applies a winner to the current descendant branch and keeps the chat ready", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure changed branch fixture"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = (ordinal: number) =>
      `printf 'winner ${ordinal}\\n' > winner.txt; git add winner.txt; git commit -m 'winner ${ordinal}'`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(1), 2: command(2) },
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena changed public branch" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Commit a winner before the public branch changes." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return a changed branch turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")

      const currentBranch = "fix/other-session"
      await $`git switch -c ${currentBranch}`.cwd(directory.path).quiet()
      await writeFile(`${directory.path}/other-session.txt`, "other session\n")
      await $`git add other-session.txt && git commit -m "other session"`.cwd(directory.path).quiet()
      const currentHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")

      expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(currentBranch)
      expect((await $`git merge-base --is-ancestor ${currentHead} HEAD`.cwd(directory.path).quiet().nothrow()).exitCode).toBe(0)
      expect(await Bun.file(`${directory.path}/winner.txt`).text()).toMatch(/^winner [12]\n$/)
      expect(await memory.store.chat(attached.chat.id)).toMatchObject({
        status: "ready",
        arenaBranch: currentBranch,
        canonicalCheckout: { branch: currentBranch, detached: false },
      })
      expect(sourceBranch).not.toBe(currentBranch)

      const continued = await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Continue on the current branch." }),
      })
      expect(continued.status).toBe(200)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("adopts a winning contestant's newly created branch", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure branch promotion fixture"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = (ordinal: number) =>
      `git switch -c arena-winner-${ordinal}; printf 'committed ${ordinal}\\n' > branch-result.txt; git add branch-result.txt; git commit -m 'branch winner ${ordinal}'; printf 'unstaged ${ordinal}\\n' >> branch-result.txt; printf 'staged ${ordinal}\\n' > branch-staged.txt; git add branch-staged.txt; printf 'untracked ${ordinal}\\n' > branch-untracked.txt`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(1), 2: command(2) },
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena branch promotion" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create and switch to a new branch for the result." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted branch turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(turnID)
      const winner = runs.find((run) => run.side === "a")
      if (!winner?.agentCommit || !winner.finalBranch) {
        throw new Error("Arena did not capture the branch winner commit")
      }
      const winningBranch = winner.finalBranch
      expect(winner).toMatchObject({
        branchAtRun: sourceBranch,
        branchChanged: true,
        applicability: "applicable",
      })
      expect(winningBranch).toMatch(/^arena-winner-[12]$/)

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")

      expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(winningBranch)
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(winner.agentCommit)
      expect((await $`git rev-parse ${sourceBranch}`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
      const status = await $`git status --short`.cwd(directory.path).quiet().text()
      expect(status).toContain(" M branch-result.txt")
      expect(status).toContain("A  branch-staged.txt")
      expect(status).toContain("?? branch-untracked.txt")
      expect(await memory.store.chat(attached.chat.id)).toMatchObject({
        arenaBranch: winningBranch,
        canonicalCheckout: { branch: winningBranch, detached: false },
      })
    } finally {
      router.restore()
    }
  }, 30_000)

  test("mirrors canonical branches and origin into each contestant", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure mirror fixture"`.cwd(directory.path).quiet()
    await $`git branch arena-main HEAD`.cwd(directory.path).quiet()
    await $`git remote add origin https://example.invalid/mirror.git`.cwd(directory.path).quiet()
    const mainTip = (await $`git rev-parse arena-main`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = () => `git rev-parse arena-main > mirrored.txt; git config --get remote.origin.url > origin.txt`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(), 2: command() },
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena mirror" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Record the mirrored branch and origin." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted mirror turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
      expect((await fs.readFile(`${directory.path}/mirrored.txt`, "utf8")).trim()).toBe(mainTip)
      expect((await fs.readFile(`${directory.path}/origin.txt`, "utf8")).trim()).toBe(
        "https://example.invalid/mirror.git",
      )
    } finally {
      router.restore()
    }
  }, 30_000)

  test("promotes a winner that merged into an existing branch and switches the chat to it", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure existing branch fixture"`.cwd(directory.path).quiet()
    await $`git branch arena-main HEAD`.cwd(directory.path).quiet()
    const mainTip = (await $`git rev-parse arena-main`.cwd(directory.path).quiet().text()).trim()
    await fs.writeFile(`${directory.path}/feature.txt`, "feature\n", "utf8")
    await $`git add feature.txt`.cwd(directory.path).quiet()
    await $`git commit -m "feature work"`.cwd(directory.path).quiet()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = () => `git checkout arena-main && git merge --no-ff --no-edit ${sourceBranch}`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(), 2: command() },
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena merge into main" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Merge this into main." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted merge turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(turnID)
      const winner = runs.find((run) => run.side === "a")
      if (!winner?.rawHead) throw new Error("Arena did not capture the merge winner")
      expect(winner).toMatchObject({
        branchAtRun: sourceBranch,
        finalBranch: "arena-main",
        branchChanged: true,
        applicability: "applicable",
      })

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")

      expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe("arena-main")
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(winner.rawHead)
      expect((await $`git rev-parse HEAD^`.cwd(directory.path).quiet().text()).trim()).toBe(mainTip)
      expect((await $`git rev-parse HEAD^2`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
      expect((await $`git rev-parse ${sourceBranch}`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
      // The promotion leaves only the permanent battle refs behind; every transient ref is gone.
      const battleRefs = (await $`git for-each-ref --format="%(refname)" refs/battles/`.cwd(directory.path).quiet().text())
        .trim()
        .split("\n")
        .filter(Boolean)
      expect(battleRefs.length).toBeGreaterThan(0)
      expect(battleRefs.filter((ref) => /-safety|-target-tip|-target-existing/.test(ref))).toEqual([])
      const chat = await memory.store.chat(attached.chat.id)
      expect(chat).toMatchObject({
        arenaBranch: "arena-main",
        canonicalCheckout: { branch: "arena-main", detached: false },
      })
      expect(chat?.currentCanonicalSHA).toBe(winner.rawHead)
      // The next turn freezes from the target branch, not the branch the chat started on.
      const completed = await memory.store.turn(turnID)
      if (completed?.warmPreparation?.state === "ready") {
        expect(completed.warmPreparation.worktrees.a?.branch).toBe("arena-main")
      }
    } finally {
      router.restore()
    }
  }, 30_000)

  test("carries a branch and a tag the winner moved and left into the checkout", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure carry-over fixture"`.cwd(directory.path).quiet()
    await $`git branch arena-main HEAD`.cwd(directory.path).quiet()
    const mainTip = (await $`git rev-parse arena-main`.cwd(directory.path).quiet().text()).trim()
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const memory = memoryStore()
    const command = () =>
      `git checkout -q arena-main && printf 'main\\n' > on-main.txt && git add on-main.txt && git commit -q -m "on main" && git tag -a v9 -m v9 && git checkout -q ${sourceBranch}`
    const router = installOpenRouterStub({
      contestantCommands: { 1: command(), 2: command() },
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena carry over" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Commit and tag on main, then come back." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted carry-over turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(turnID)
      const winner = runs.find((run) => run.side === "a")
      if (!winner?.refChanges) throw new Error("Arena did not record the winner's ref changes")
      expect(winner).toMatchObject({
        branchAtRun: sourceBranch,
        finalBranch: sourceBranch,
        branchChanged: false,
        applicability: "applicable",
      })
      const byRef = new Map(winner.refChanges.map((change) => [change.ref, change]))
      const main = byRef.get("refs/heads/arena-main")
      const tag = byRef.get("refs/tags/v9")
      if (!main?.after || !tag?.after) throw new Error("Arena did not record the moved branch and tag")
      expect(main.before).toBe(mainTip)
      expect(tag.before).toBeUndefined()
      expect(winner.refChanges).toHaveLength(2)

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")

      // The chat stays on its branch; the branch and tag the winner moved and left came along.
      expect((await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()).toBe(sourceBranch)
      expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(sourceHead)
      expect((await $`git rev-parse arena-main`.cwd(directory.path).quiet().text()).trim()).toBe(main.after)
      expect((await $`git rev-parse arena-main^`.cwd(directory.path).quiet().text()).trim()).toBe(mainTip)
      expect((await $`git rev-parse refs/tags/v9`.cwd(directory.path).quiet().text()).trim()).toBe(tag.after)
      expect((await $`git cat-file -t refs/tags/v9`.cwd(directory.path).quiet().text()).trim()).toBe("tag")
      const completed = await memory.store.turn(turnID)
      expect(completed?.gitApplication).toMatchObject({
        state: "applied",
        refs: [
          { ref: "refs/heads/arena-main", action: "updated" },
          { ref: "refs/tags/v9", action: "created" },
        ],
      })
      // The imported objects stay with the turn's permanent refs. The chat segment of the ref
      // is a hash of the chat id (`refRoot` in service.ts), so match on the tail. Turn indexes
      // start at 0, so the first turn of the chat is `turn-0`.
      const importedRefs = (
        await $`git for-each-ref --format="%(refname) %(objectname)" refs/battles/`.cwd(directory.path).quiet().text()
      )
        .trim()
        .split("\n")
        .filter((line) => line.includes("/a-refs/"))
        .sort()
      expect(importedRefs).toEqual([
        expect.stringMatching(new RegExp(`/turn-0/a-refs/heads/arena-main ${main.after}$`)),
        expect.stringMatching(new RegExp(`/turn-0/a-refs/tags/v9 ${tag.after}$`)),
      ])
    } finally {
      router.restore()
    }
  }, 30_000)

  test("binds concurrent chat resolution to each session's existing checkout", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure branch adoption fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory.path,
    }
    const sourceBranch = (await $`git branch --show-current`.cwd(directory.path).quiet().text()).trim()
    const sourceHead = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const sourceA = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Arena canonical session A" }),
      }),
    )
    const sourceB = await json<{ id: string }>(
      await request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Arena canonical session B" }),
      }),
    )
    const [attachedA, repeatedA, attachedB] = await Promise.all([
      json<PublicSnapshot>(await request(`/arena/sessions/${sourceA.id}`, { headers })),
      json<PublicSnapshot>(await request(`/arena/sessions/${sourceA.id}`, { headers })),
      json<PublicSnapshot>(await request(`/arena/sessions/${sourceB.id}`, { headers })),
    ])
    const [chatA, chatB] = await Promise.all([
      memory.store.chat(attachedA.chat.id),
      memory.store.chat(attachedB.chat.id),
    ])
    if (!chatA || !chatB) throw new Error("Arena did not persist both canonical chats")

    expect(repeatedA.chat.id).toBe(attachedA.chat.id)
    expect(chatA.source).toEqual({ root: directory.path, branch: sourceBranch })
    expect(chatB.source).toEqual({ root: directory.path, branch: sourceBranch })
    expect(chatA.repository.root).toBe(directory.path)
    expect(chatB.repository.root).toBe(directory.path)
    expect(chatA.repository.branch).toBe(sourceBranch)
    expect(chatB.repository.branch).toBe(sourceBranch)
    expect(chatA.currentCanonicalSHA).toBe(sourceHead)
    expect(chatB.currentCanonicalSHA).toBe(sourceHead)
  }, 30_000)

  test.each(["snapshot", "stream"])(
    "records the %s account as the chat's owner and never transfers it",
    async (transport) => {
      await using directory = await tmpdir({
        git: true,
        config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
      })
      await $`git add opencode.json`.cwd(directory.path).quiet()
      await $`git commit -m "test: configure ownership fixture"`.cwd(directory.path).quiet()
      const memory = memoryStore()
      process.env.OPENCODE_ARENA = "1"
      setStoreForTest(memory.store)

      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const attach = async (sessionID: string, userID?: string) => {
        const query = userID ? `?userID=${encodeURIComponent(userID)}` : ""
        const path = `/arena/sessions/${sessionID}${transport === "stream" ? "/stream" : ""}${query}`
        if (transport === "snapshot") return json<PublicSnapshot>(await request(path, { headers }))
        await using watched = await observeArenaStream(await request(path, { headers }))
        const frame = await watched.until((value) => value.kind === "snapshot")
        if (frame.kind !== "snapshot") throw new Error("Missing ownership snapshot")
        return frame.snapshot
      }
      const unowned = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena unowned session" }),
        }),
      )
      const owned = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena owned session" }),
        }),
      )

      const attached = await attach(owned.id, "user-1")
      await attach(owned.id, "user-2")
      const anonymous = await attach(unowned.id)

      const [ownedChat, unownedChat] = await Promise.all([
        memory.store.chat(attached.chat.id),
        memory.store.chat(anonymous.chat.id),
      ])
      expect(ownedChat?.userId).toBe("user-1")
      expect(unownedChat?.userId).toBeUndefined()

      // A chat written before accounts existed takes the next resolver's account.
      const claimed = await attach(unowned.id, "user-3")
      expect((await memory.store.chat(claimed.chat.id))?.userId).toBe("user-3")
    },
    30_000,
  )

  test("rejects Battle when a canonical normal prompt was admitted first", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure normal admission fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 1, delayMs: 500 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Arena normal admission session",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const normal = request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "Reserve this canonical normal turn." }],
        }),
      })
      let earlyNormalResponse: Response | undefined
      void normal.then((response) => {
        earlyNormalResponse = response
      })
      while (router.contestantRequests.length === 0 && !earlyNormalResponse) await Bun.sleep(5)
      if (earlyNormalResponse) {
        throw new Error(
          `Normal prompt settled before reaching OpenRouter: ${earlyNormalResponse.status} ${await earlyNormalResponse.text()}`,
        )
      }
      const rating = await memory.store.latestSingleAgentRating(source.id)
      if (!rating) throw new Error("Arena did not assign a single-agent contestant")
      expect(router.contestantRequests[0]?.model).toBe(router.modelForAssignment(rating.assignment.assignmentID))

      const battle = await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "This battle must wait for normal execution." }),
      })
      expect(battle.status).toBeGreaterThanOrEqual(400)
      expect((await normal).status).toBe(200)
      expect((await memory.store.chat(attached.chat.id))?.status).toBe("ready")
    } finally {
      router.restore()
    }
  }, 30_000)

  for (const selectedSide of ["a", "b"] as const) {
    test(`keeps canceling an early ${selectedSide === "a" ? "B" : "A"} loser that has not registered its prompt yet`, async () => {
      await using directory = await tmpdir({
        git: true,
        config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
      })
      await $`git add opencode.json`.cwd(directory.path).quiet()
      await $`git commit -m "test: configure early selection fixture"`.cwd(directory.path).quiet()
      const memory = memoryStore()
      const router = installOpenRouterStub()
      const loserSide = selectedSide === "a" ? "b" : "a"
      const enteredLoser = Promise.withResolvers<void>()
      const releaseLoser = Promise.withResolvers<void>()
      const updateRun = memory.store.updateRun.bind(memory.store)
      let blocked = false
      memory.store.updateRun = async (runID, patch) => {
        const run = await memory.store.run(runID)
        if (!blocked && run?.side === loserSide && patch.startedAt) {
          blocked = true
          enteredLoser.resolve()
          await releaseLoser.promise
        }
        return updateRun(runID, patch)
      }
      process.env.OPENCODE_ARENA = "1"
      setStoreForTest(memory.store)

      try {
        const headers = {
          "content-type": "application/json",
          "x-opencode-directory": directory.path,
        }
        const source = await json<{ id: string }>(
          await request("/session", {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "Early selection canonical session",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          }),
        )
        const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
        const admitted = await json<PublicSnapshot>(
          await request(`/arena/chats/${attached.chat.id}/turns`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt: "Create an early selected result." }),
          }),
        )
        const turnID = admitted.turn?.id
        if (!turnID) throw new Error("Arena did not return an admitted early-selection turn")
        await enteredLoser.promise
        const winner = await waitForSelectableRun(memory.store, turnID, selectedSide)

        const early = await json<PublicSnapshot>(
          await request(`/arena/turns/${turnID}/vote`, {
            method: "POST",
            headers,
            body: JSON.stringify({ vote: selectedSide }),
          }),
        )
        expect(early.turn?.state).toBe("early_selected")
        releaseLoser.resolve()

        const complete = await waitForTurn(memory.store, turnID, "complete")
        const runs = await memory.store.runsForTurn(turnID)
        const loser = runs.find((run) => run.side === loserSide)
        expect(complete.selectedEarly).toBe(true)
        expect(winner.durationMs).toBeTypeOf("number")
        expect(loser?.runState).toBe("stopped")
        expect(loser?.durationMs).toBeNull()
        expect(new Set(router.contestantRequests.map((item) => item.model))).toEqual(
          new Set([router.modelForAssignment(winner.assignment.assignmentID)]),
        )
      } finally {
        releaseLoser.resolve()
        router.restore()
      }
    }, 30_000)
  }

  test("serves a stopped-battle diff when contestants lack finalized results", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure stopped battle fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ delayedOrdinal: 2, delayMs: 750 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Stopped Arena diff",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create results that will be stopped." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted stopped turn")
      await waitForTurn(memory.store, turnID, "running")

      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/stop`, {
          method: "POST",
          headers,
        }),
      )
      const stopped = await waitForTurn(memory.store, turnID, "awaiting_stop_resolution")
      const runs = memory.runs.values.filter((item) => item.turnID === turnID)
      const a = runs.find((run) => run.side === "a")
      const b = runs.find((run) => run.side === "b")
      if (!a?.finalCommit || !a.permanentRef || !b?.finalCommit) {
        throw new Error("Arena did not finalize both stopped results before the diff fixture mutation")
      }
      const aCommit = a.finalCommit
      const aRef = a.permanentRef
      delete (b as Mutable).finalCommit
      delete (b as Mutable).finalTree
      delete (b as Mutable).permanentRef

      type Diff = {
        baseCommit: string
        a: { commit: string; ref?: string }
        b: { commit: string; ref?: string }
        treesEqual: boolean
        patch: string
        divergence?: { conflicted: boolean; files: { file: string; status: string }[] }
      }
      const partial = await json<Diff>(await request(`/arena/turns/${turnID}/diff`, { headers }))
      expect(partial).toMatchObject({
        baseCommit: stopped.frozenBaseSHA,
        a: { commit: aCommit, ref: aRef },
        b: { commit: stopped.frozenBaseSHA },
      })
      expect(partial.b.ref).toBeUndefined()
      // The missing side is the base itself, so every file is A's alone and nothing conflicts.
      expect(partial.divergence?.conflicted).toBe(false)
      expect(partial.divergence?.files.length).toBeGreaterThan(0)
      expect(partial.divergence?.files.every((file) => file.status === "only_a")).toBe(true)

      delete (a as Mutable).finalCommit
      delete (a as Mutable).finalTree
      delete (a as Mutable).permanentRef
      const diff = await json<Diff>(await request(`/arena/turns/${turnID}/diff`, { headers }))
      expect(diff).toMatchObject({
        baseCommit: stopped.frozenBaseSHA,
        a: { commit: stopped.frozenBaseSHA },
        b: { commit: stopped.frozenBaseSHA },
        treesEqual: true,
        patch: "",
      })
      expect(diff.a.ref).toBeUndefined()
      expect(diff.b.ref).toBeUndefined()

      const discarded = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/stop-resolution`, {
          method: "POST",
          headers,
          body: JSON.stringify({ resolution: "discard" }),
        }),
      )
      expect(discarded.turn?.state).toBe("discarded")
      expect(discarded.turn?.resolution).toEqual({ kind: "stopped", resolution: "discard" })
      expect(discarded.turn?.comparisonState).toBe("skipped")
    } finally {
      router.restore()
    }
  }, 30_000)

  test("makes a finalized empty contestant result selectable", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure empty arena result fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub({ emptyOrdinals: [1] })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Empty Arena result",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "A service-only result should still be selectable." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted empty-result turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const result = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
      const empty = result.runs.find((run) => run.diff?.files === 0)
      const changed = result.runs.find((run) => (run.diff?.files ?? 0) > 0)

      expect(empty?.selectable).toBe(true)
      expect(changed?.selectable).toBe(true)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("runs battles, accepts a randomized normal contestant turn, and continues battling", async () => {
    await using directory = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        tool_output: { max_bytes: TOOL_OUTPUT_DISPLAY_CAP, max_lines: 1_000 },
        watcher: { ignore: [".git"] },
      },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena fixture"`.cwd(directory.path).quiet()
    await using arenaDirectory = await tmpdir()
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Arena canonical session",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(attached.chat.status).toBe("ready")
      expect(attached.chat.canonicalSessionID).toBe(source.id)
      const chat = await store.chat(attached.chat.id)
      if (!chat) throw new Error("Arena did not persist the isolated chat")
      const canonical = chat.repository.root

      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: "Create a distinct result file.",
            participantID: "cid_test-participant",
          }),
        }),
      )
      const firstTurnID = admitted.turn?.id
      if (!firstTurnID) throw new Error("Arena did not return an admitted turn")
      const first = await waitForTurn(store, firstTurnID, "awaiting_vote")
      const firstRuns = await store.runsForTurn(firstTurnID)
      expect(new Set(router.contestantRequests.map((request) => request.model)).size).toBe(2)
      expect(
        router.contestantRequests.every((request) =>
          request.messages?.some((message) =>
            typeof message.content === "string"
              ? message.content.includes(CONTESTANT_WORKTREE_INSTRUCTION)
              : message.content?.some((part) => part.text?.includes(CONTESTANT_WORKTREE_INSTRUCTION)),
          ),
        ),
      ).toBe(true)
      const beforeVote = await json<PublicSnapshot>(await request(`/arena/turns/${firstTurnID}`, { headers }))
      expect(beforeVote.turn?.canVote).toBe(true)
      expect(beforeVote.turn?.revealed).toBe(false)
      expect(beforeVote.turn?.identities).toBeUndefined()
      expect(beforeVote.runs.every((run) => run.identity === undefined)).toBe(true)
      expect(beforeVote.runs.every((run) => (run.messages?.length ?? 0) > 0)).toBe(true)
      const hydrated = JSON.stringify(beforeVote.runs)
      for (const placement of Object.values(first.placement)) {
        expect(hydrated).not.toContain(placement.assignmentID)
      }
      expect(JSON.stringify(first)).not.toContain("routingToken")
      expect(first.placement.a.assignmentID).not.toBe(first.placement.b.assignmentID)

      expect(firstRuns).toHaveLength(2)
      const malformed = firstRuns[0]!
      const originalSessionID = malformed.rootSessionID
      let degraded: PublicSnapshot
      try {
        await store.runs.updateOne({ _id: malformed._id }, { $set: { rootSessionID: "malformed-session-id" } })
        degraded = await json<PublicSnapshot>(await request(`/arena/turns/${firstTurnID}`, { headers }))
      } finally {
        await store.runs.updateOne({ _id: malformed._id }, { $set: { rootSessionID: originalSessionID } })
      }
      const malformedIndex = degraded.runs.findIndex((run) => run.id === malformed._id)
      expect(malformedIndex).toBeGreaterThanOrEqual(0)
      expect(degraded.runs[malformedIndex]?.messages).toBeUndefined()
      expect(
        degraded.runs.filter((_, index) => index !== malformedIndex).every((run) => (run.messages?.length ?? 0) > 0),
      ).toBe(true)
      const degradedJSON = JSON.stringify(degraded.runs)
      for (const placement of Object.values(first.placement)) {
        expect(degradedJSON).not.toContain(placement.assignmentID)
      }
      expect(firstRuns.map((run) => run.runState)).toEqual(["complete", "complete"])
      expect(firstRuns.every((run) => typeof run.durationMs === "number" && run.durationMs >= 0)).toBe(true)
      expect(firstRuns.every((run) => run.applicability === "applicable")).toBe(true)
      expect(firstRuns.every((run) => run.finalCommit && run.permanentRef && run.archiveComplete)).toBe(true)
      expect(firstRuns[0]?.finalTree).not.toBe(firstRuns[1]?.finalTree)
      expect(await Promise.all(firstRuns.map((run) => exists(run.worktree)))).toEqual([true, true])

      const winner = firstRuns.find((run) => run.side === "a")!
      const loser = firstRuns.find((run) => run.side === "b")!
      const acknowledged = await json<PublicSnapshot>(
        await request(`/arena/turns/${firstTurnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "tie", participantID: "cid_test-participant" }),
        }),
      )
      expect(acknowledged.turn?.state).toBe("applying")
      expect(acknowledged.turn?.revealed).toBe(true)
      await waitForTurn(store, firstTurnID, "complete")
      const voted = await json<PublicSnapshot>(await request(`/arena/turns/${firstTurnID}`, { headers }))
      expect(voted.turn?.state).toBe("complete")
      expect(voted.turn?.vote).toBe("tie")
      expect(voted.turn?.appliedSide).toBe("a")
      expect((await store.turn(firstTurnID))?.selectedEarly).toBe(false)
      expect((await store.turn(firstTurnID))?.participantID).toBe("cid_test-participant")
      expect((await store.turn(firstTurnID))?.voteParticipantID).toBe("cid_test-participant")
      expect(voted.turn?.revealed).toBe(true)
      expect(voted.turn?.identities?.a.name).not.toBe(voted.turn?.identities?.b.name)
      expect(voted.runs.every((run) => run.identity !== undefined)).toBe(true)
      const persistedVoted = await store.turn(firstTurnID)
      expect(persistedVoted?.placement.a.model).toBe(voted.turn?.identities?.a.name)
      expect(persistedVoted?.placement.b.model).toBe(voted.turn?.identities?.b.name)
      const retained = await json<PublicSnapshot>(await request(`/arena/turns/${firstTurnID}`, { headers }))
      expect(retained.runs.every((run) => (run.messages?.length ?? 0) > 0)).toBe(true)
      // The canonical session is established once and never swapped for the winner's: the winner's
      // messages are grafted onto it instead, so it outlives every contestant worktree.
      expect(voted.chat.canonicalSessionID).toBe(source.id)
      expect((await store.turn(firstTurnID))?.canonicalUserMessageID).toBeTruthy()
      // The winner stays live through the next-send boundary. The loser lets go of its worktree at
      // once, and the next pair's warm-up adopts it: it leaves its generation's path for the next.
      await waitForRemoved(firstRuns.find((run) => run.side !== "a")!.worktree)
      expect(await Promise.all(firstRuns.map((run) => exists(run.worktree)))).toEqual([true, false])
      expect((await store.run(loser._id))?.worktreeRemovedAt).toBeTruthy()
      expect((await store.run(winner._id))?.worktreeRemovedAt).toBeUndefined()

      const resolved = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      expect(resolved.chat.id).toBe(attached.chat.id)
      expect(resolved.runs.every((run) => (run.messages?.length ?? 0) > 0)).toBe(true)
      expect(resolved.runs.every((run) => Object.values(run.parts ?? {}).flat().length > 0)).toBe(true)
      const normalRequestBoundary = router.contestantRequests.length
      const normal = await request(`/session/${source.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [
            {
              type: "text",
              text: `Handle this turn without a battle in ${canonical}/normal-result.txt.`,
            },
          ],
        }),
      })
      expect(normal.status).toBe(200)
      const rating = await store.latestSingleAgentRating(source.id)
      if (!rating) throw new Error("Arena did not assign a single-agent contestant")
      expect(router.contestantRequests.slice(normalRequestBoundary).map((request) => request.model)).toContain(
        router.modelForAssignment(rating.assignment.assignmentID),
      )
      const normalHead = (await $`git rev-parse HEAD`.cwd(canonical).quiet().text()).trim()
      expect(await Bun.file(`${canonical}/normal-result.txt`).text()).toBe("normal contestant result\n")
      const requestBoundary = router.contestantRequests.length
      await store.close()
      store = await connectLocalStore({ directory: arenaDirectory.path })
      setStoreForTest(store)
      const continued = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: `Continue from the selected result at ${canonical}/normal-result.txt.`,
          }),
        }),
      )
      const secondTurnID = continued.turn?.id
      if (!secondTurnID) throw new Error("Arena did not return a continuation turn")
      const second = await waitForTurn(store, secondTurnID, "awaiting_vote")
      expect(second.turnIndex).toBe(1)
      expect(second.sourceCanonicalSessionID).toBe(source.id)
      expect(second.baseSnapshot?.canonicalHead).toBe(normalHead)
      expect(second.frozenBaseSHA).not.toBe(normalHead)
      const secondRuns = await store.runsForTurn(secondTurnID)
      const continuationRequests = router.contestantRequests.slice(requestBoundary)
      expect(continuationRequests.length).toBeGreaterThanOrEqual(2)
      expect(
        continuationRequests.every((request) => !JSON.stringify(request).includes(`${canonical}/normal-result.txt`)),
      ).toBe(true)
      expect(
        continuationRequests.every((request) =>
          secondRuns.some((run) => JSON.stringify(request).includes(`${run.worktree}/normal-result.txt`)),
        ),
      ).toBe(true)
      await json<PublicSnapshot>(
        await request(`/arena/turns/${secondTurnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "tie" }),
        }),
      )
      await waitForTurn(store, secondTurnID, "complete")
      await waitForReadyChat(store, attached.chat.id)
      const completed = await json<PublicSnapshot>(await request(`/arena/turns/${secondTurnID}`, { headers }))
      expect(completed.turn?.state).toBe("complete")

      expect(await $`git rev-parse HEAD`.cwd(canonical).text()).toContain(completed.chat.canonicalSHA)
      expect(await $`git rev-parse ${winner.permanentRef!}`.cwd(directory.path).text()).toContain(winner.finalCommit!)
      expect(await $`git rev-parse ${loser.permanentRef!}`.cwd(directory.path).text()).toContain(loser.finalCommit!)

      const admittedOnly = await request(`/session/${completed.chat.canonicalSessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          messageID: MessageID.ascending(),
          noReply: true,
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "Admit this normal turn without running it." }],
        }),
      })
      expect(admittedOnly.status).toBe(200)
      // The test server exposes the response as a stream. Consume it before
      // mutating the same repository outside the request lifecycle.
      await admittedOnly.text()
      await Bun.write(`${canonical}/external-change.txt`, "external change\n")
      await $`git add external-change.txt`.cwd(canonical).quiet()
      await $`git commit -m "test: external change"`.cwd(canonical).quiet()
      const rejected = await request(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Do not accept an unrelated commit as a normal turn." }),
      })
      expect(rejected.status).toBeGreaterThanOrEqual(400)

      const turns = await store.turns.find().toArray()
      const runs = await store.runs.find().toArray()
      const generations = await store.generations.find().toArray()
      const events = await store.events.find().toArray()
      const rawEvents = await store.rawEvents.find().toArray()
      const sessionArchives = await store.sessionArchives.find().toArray()
      const artifacts = await store.artifacts.find().toArray()
      const comparisons = await store.comparisons.find().toArray()
      expect(turns).toHaveLength(2)
      expect(runs).toHaveLength(4)
      expect(generations.length).toBeGreaterThanOrEqual(6)
      expect(events.length).toBeGreaterThan(0)
      expect(rawEvents.length).toBeGreaterThanOrEqual(events.length)
      expect(events.some((event) => event.coalesced)).toBe(true)
      expect(sessionArchives).toHaveLength(4)
      expect(artifacts.some((artifact) => artifact.kind === "transcript")).toBe(true)
      expect(artifacts.some((artifact) => artifact.kind === "generation_request")).toBe(true)
      const toolOutputs = artifacts.filter((artifact) => artifact.kind === "tool_output")
      expect(toolOutputs).toHaveLength(1)
      const toolOutput = toolOutputs[0]!
      const fullOutput = `${TOOL_OUTPUT_BODY}\n`
      expect(toolOutput.originalSize).toBe(Buffer.byteLength(fullOutput))
      expect(toolOutput.originalSize).toBeGreaterThan(TOOL_OUTPUT_DISPLAY_CAP)
      expect(toolOutput.storedSize).toBe(toolOutput.originalSize)
      expect(toolOutput.data.toString()).toBe(fullOutput)
      expect(toolOutput.contentHash).toBe(createHash("sha256").update(fullOutput).digest("hex"))
      expect(toolOutput.truncated).toBe(false)
      expect(toolOutput.truncationReason).toBeUndefined()
      expect(comparisons.length).toBeGreaterThanOrEqual(1)
      expect(router.calls.size).toBeGreaterThanOrEqual(2)
    } finally {
      router.restore()
      await store.close()
    }
  }, 30_000)

  test("observes a replaced test Store without leaking the previous Arena state", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
    process.env.OPENCODE_ARENA = "1"
    const first = memoryStore()
    setStoreForTest(first.store)

    const sourceA = await json<{ id: string }>(
      await Server.Default().app.request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "First Store" }),
      }),
    )
    const attachedA = await json<PublicSnapshot>(
      await Server.Default().app.request(`/arena/sessions/${sourceA.id}`, { headers }),
    )

    const second = memoryStore()
    setStoreForTest(second.store)
    const sourceB = await json<{ id: string }>(
      await Server.Default().app.request("/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Second Store" }),
      }),
    )
    const attachedB = await json<PublicSnapshot>(
      await Server.Default().app.request(`/arena/sessions/${sourceB.id}`, { headers }),
    )

    expect(first.chats.values.map((chat) => chat._id)).toEqual([attachedA.chat.id])
    expect(second.chats.values.map((chat) => chat._id)).toEqual([attachedB.chat.id])
    expect(attachedB.chat.id).not.toBe(attachedA.chat.id)
  })

  test("keeps both outcomes intact until a missing transcript archive can be retained", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena archive invariant" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const chat = await memory.store.chat(attached.chat.id)
      if (!chat) throw new Error("Arena did not persist the isolated chat")
      const canonical = chat.repository.root
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create a retained result." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const runs = await memory.store.runsForTurn(turnID)
      const missing = runs[0]
      if (!missing?.transcriptArchiveID) throw new Error("Arena did not archive the first result")
      await memory.sessionArchives.deleteOne({ _id: missing.transcriptArchiveID })
      missing.archiveComplete = undefined
      missing.transcriptArchiveID = undefined
      const saveSessionArchive = memory.store.saveSessionArchive.bind(memory.store)
      let failArchives = true
      memory.store.saveSessionArchive = (archive) =>
        failArchives && archive.runID === missing._id
          ? Promise.reject(new Error("injected transcript archive failure"))
          : saveSessionArchive(archive)

      const head = (await $`git rev-parse HEAD`.cwd(canonical).quiet().text()).trim()
      const acknowledged = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      expect(acknowledged.turn?.state).toBe("applying")
      await waitForTurn(memory.store, turnID, "application_failed")
      const unchanged = await memory.store.turn(turnID)
      expect(unchanged?.resolution).toEqual({ kind: "vote", vote: "a", appliedSide: "a" })
      expect((await $`git rev-parse HEAD`.cwd(canonical).quiet().text()).trim()).toBe(head)
      expect(await Promise.all(runs.map((run) => exists(run.worktree)))).toEqual([true, true])
      expect(
        await Promise.all(runs.map((run) => $`git rev-parse ${run.permanentRef!}`.cwd(directory.path).quiet().text())),
      ).toEqual(runs.map((run) => `${run.finalCommit}\n`))
      expect(
        await Promise.all(runs.map(async (run) => (await request(`/session/${run.rootSessionID}`, { headers })).ok)),
      ).toEqual([true, true])

      await using streamed = await observeArenaStream(await request(`/arena/sessions/${source.id}/stream`, { headers }))
      await streamed.until((frame) => frame.kind === "snapshot")
      failArchives = false
      const retried = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/retry-resolution`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        }),
      )
      expect(["applying", "canonicalizing", "cleanup_pending", "complete"]).toContain(retried.turn?.state)
      await waitForTurn(memory.store, turnID, "complete")
      expect((await memory.store.run(missing._id))?.archiveComplete).toBe(true)
      await streamed.until(
        (frame) =>
          frame.kind === "changes" &&
          frame.changes.some((change) => change.kind === "state" && change.snapshot.turn?.state === "complete"),
      )
      expect(streamed.frames.filter((frame) => frame.kind === "snapshot")).toHaveLength(1)
    } finally {
      router.restore()
    }
  }, 30_000)

  test("retries failed startup recovery and repairs both application completion crash points", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena recovery invariant" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create a recoverable result." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted turn")
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
      const chat = memory.chats.values.find((item) => item._id === attached.chat.id)
      const turn = memory.turns.values.find((item) => item._id === turnID)
      if (!chat || !turn) throw new Error("Arena did not retain the completed battle")

      chat.status = "battle_active"
      chat.activeTurnID = turnID
      const loadTurn = memory.store.turn.bind(memory.store)
      let failRecovery = true
      memory.store.turn = (id) => {
        if (!failRecovery) return loadTurn(id)
        failRecovery = false
        return Promise.reject(new Error("injected startup recovery failure"))
      }
      setStoreForTest(memory.store)
      expect((await request(`/arena/chats/${chat._id}`, { headers })).status).toBe(400)
      expect(chat.status).toBe("battle_active")
      const recovered = await json<PublicSnapshot>(await request(`/arena/chats/${chat._id}`, { headers }))
      expect(recovered.chat.status).toBe("ready")
      expect(recovered.turn?.state).toBe("complete")

      turn.state = "cleanup_pending"
      turn.cleanup = { state: "complete" }
      chat.status = "ready"
      chat.activeTurnID = undefined
      setStoreForTest(memory.store)
      const repaired = await json<PublicSnapshot>(await request(`/arena/chats/${chat._id}`, { headers }))
      expect(repaired.chat.status).toBe("ready")
      expect(repaired.turn?.state).toBe("complete")
      expect((await memory.store.turn(turnID))?.state).toBe("complete")
    } finally {
      router.restore()
    }
  }, 30_000)

  test("marks interrupted utility comparisons failed without rerunning models or deleting raw artifacts", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure arena fixture"`.cwd(directory.path).quiet()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)

    try {
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory.path,
      }
      const source = await json<{ id: string }>(
        await request("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Arena comparison recovery" }),
        }),
      )
      const attached = await json<PublicSnapshot>(await request(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await request(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create evidence for a restart comparison." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return an admitted turn")
      const turn = await waitForTurn(memory.store, turnID, "awaiting_vote")
      const comparison = await waitForComparison(memory.store, turnID)
      const artifactIDs = [...comparison.artifactIDs]
      const contestantCalls = Array.from(router.calls.entries())
      const utilityCalls = router.utilityCalls()

      comparison.state = "running"
      comparison.output = undefined
      comparison.error = undefined
      turn.comparisonState = "running"
      setStoreForTest(memory.restart())
      const recovered = await json<PublicSnapshot>(await request(`/arena/turns/${turnID}`, { headers }))
      expect(recovered.turn?.state).toBe("awaiting_vote")
      expect(recovered.turn?.canVote).toBe(true)
      expect(recovered.comparison?.state).toBe("failed")
      expect((await memory.comparisons.findOne({ _id: comparison._id }))?.error).toBe(
        "Arena utility comparison was interrupted by a process restart",
      )
      expect(comparison.artifactIDs).toEqual(artifactIDs)
      expect(
        await Promise.all(
          artifactIDs.map((id) => memory.artifacts.findOne({ _id: id }).then((artifact) => !!artifact)),
        ),
      ).toEqual(artifactIDs.map(() => true))
      expect(Array.from(router.calls.entries())).toEqual(contestantCalls)
      expect(router.utilityCalls()).toBe(utilityCalls)

      const voted = await json<PublicSnapshot>(
        await request(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      expect(voted.turn?.state).toBe("applying")
      await waitForTurn(memory.store, turnID, "complete")

      comparison.state = "running"
      comparison.error = undefined
      turn.comparisonState = "running"
      setStoreForTest(memory.restart())
      const completed = await json<PublicSnapshot>(await request(`/arena/chats/${attached.chat.id}`, { headers }))
      expect(completed.chat.status).toBe("ready")
      expect(completed.turn?.state).toBe("complete")
      expect(completed.comparison?.state).toBe("failed")
      expect(Array.from(router.calls.entries())).toEqual(contestantCalls)
      expect(router.utilityCalls()).toBe(utilityCalls)
      expect(comparison.artifactIDs).toEqual(artifactIDs)

      comparison.state = "complete"
      comparison.output = "Recovered completed comparison"
      comparison.error = undefined
      turn.comparisonState = "running"
      setStoreForTest(memory.restart())
      const reconciled = await json<PublicSnapshot>(await request(`/arena/chats/${attached.chat.id}`, { headers }))
      expect(reconciled.comparison?.state).toBe("complete")
      expect((await memory.store.turn(turnID))?.comparisonState).toBe("complete")
      expect(Array.from(router.calls.entries())).toEqual(contestantCalls)
      expect(router.utilityCalls()).toBe(utilityCalls)

      comparison.state = "failed"
      comparison.error = "injected historical summary failure"
      turn.comparisonState = "failed"
      await using historical = await observeArenaStream(
        await request(`/arena/sessions/${source.id}/stream?turnID=${turnID}`, { headers }),
      )
      const initial = await historical.until((frame) => frame.kind === "snapshot")
      if (initial.kind !== "snapshot") throw new Error("Missing historical snapshot")
      expect(initial.snapshot.turn?.state).toBe("complete")
      expect(initial.snapshot.comparison?.state).toBe("failed")
      await json<PublicSnapshot>(await request(`/arena/turns/${turnID}/retry-comparison`, { method: "POST", headers }))
      const completedRetry = await historical.until(
        (frame) =>
          frame.kind === "changes" &&
          frame.changes.some((change) => change.kind === "state" && change.snapshot.comparison?.state === "complete"),
      )
      if (completedRetry.kind !== "changes") throw new Error("Missing summary update")
      const state = completedRetry.changes.find((change) => change.kind === "state")
      expect(state?.snapshot.turn?.state).toBe("complete")
      expect(state?.snapshot.runs.every((run) => run.messages === undefined && run.parts === undefined)).toBe(true)
      expect(historical.frames.filter((frame) => frame.kind === "snapshot")).toHaveLength(1)
      expect(Array.from(router.calls.entries())).toEqual(contestantCalls)
      expect(router.utilityCalls()).toBe(utilityCalls + 1)
    } finally {
      router.restore()
    }
  }, 30_000)
})
