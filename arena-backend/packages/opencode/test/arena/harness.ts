// Shared harness for the Arena service integration tests. Moved out of
// `service.integration.test.ts` unchanged so a second test file can use it.
// This module registers no test hooks: keep every test and describe call out of it.
import { Store } from "@/arena/mongo"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import type {
  ArenaEventDocument,
  ArtifactDocument,
  BattleMetricsDocument,
  ChatDocument,
  ReviewEventDocument,
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

type Document = { readonly _id: string }
export type Mutable = Record<string, unknown>
type Update = Record<string, Record<string, unknown>>

export const arenaControlToken = "test-control-token"

export function arenaRequest(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-paseo-control-token", arenaControlToken)
  return import("@/server/server").then(({ Server }) => Server.Default().app.request(path, { ...init, headers }))
}

export const TOOL_OUTPUT_BODY = "arena-tool-output-".repeat(40)

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

export function memoryStore() {
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
  // The review rollup reads these on every admitted turn, so a store without them fails the
  // request rather than the metric.
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

export function chunks(lines: ReadonlyArray<unknown>) {
  return new Response(
    `${lines.map((line) => `data: ${typeof line === "string" ? line : JSON.stringify(line)}`).join("\n\n")}\n\n`,
    { headers: { "content-type": "text/event-stream", "x-openrouter-provider": "test-provider" } },
  )
}

export function contestantResponse(
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

export function installOpenRouterStub(options?: {
  readonly delayedOrdinal?: number
  readonly delayMs?: number
  readonly assignmentError?: string
  readonly questionOrdinals?: ReadonlyArray<number>
  readonly emptyOrdinals?: ReadonlyArray<number>
  readonly contestantCommands?: Readonly<Partial<Record<number, string>>>
  /**
   * A command keyed by the latest user message instead of the model's first request. Each model
   * runs it once per distinct prompt, so a multi-turn test can script every turn; a prompt the
   * function returns nothing for falls back to the per-model rules above.
   */
  readonly promptCommands?: (requestText: string) => string | undefined
}) {
  const original = globalThis.fetch
  const completedPromptCommands = new Set<string>()
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
  const testProfiles = [
    { slug: "test/model-a", displayName: "Test Model A" },
    { slug: "test/model-b", displayName: "Test Model B" },
    { slug: "test/model-c", displayName: "Test Model C" },
  ] as const
  type TestAssignment = {
    readonly scopeID: string
    readonly assignmentID: string
    readonly model: (typeof testProfiles)[number]
  }
  const assignmentSets = new Map<string, { readonly decision?: string; readonly assignments: TestAssignment[] }>()
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
    if (url.pathname !== "/api/openrouter/api/v1/chat/completions") {
      throw new Error(`Unexpected external request: ${url}`)
    }
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
    if (options?.delayedOrdinal === number) await Bun.sleep(options.delayMs ?? 0)
    const latestUserMessage = body.messages?.findLast((message) => message.role === "user")
    const requestText = JSON.stringify(latestUserMessage?.content ?? "")
    const normalFixture = requestText.includes("canonical normal turn") || requestText.includes("without a battle")
    const transcriptOnlyFixture = requestText.includes("transcript-only normal turn")
    const normalCommandKey = `${body.model}\n${requestText}`
    const runNormalCommand = (normalFixture || transcriptOnlyFixture) && !completedNormalCommands.has(normalCommandKey)
    if (runNormalCommand) completedNormalCommands.add(normalCommandKey)
    const promptCommand = runNormalCommand ? undefined : options?.promptCommands?.(requestText)
    const runPromptCommand = promptCommand !== undefined && !completedPromptCommands.has(normalCommandKey)
    if (runPromptCommand) completedPromptCommands.add(normalCommandKey)
    const tool =
      runNormalCommand || runPromptCommand
        ? "bash"
        : promptCommand !== undefined || count !== 1 || options?.emptyOrdinals?.includes(number)
          ? undefined
          : options?.questionOrdinals?.includes(number)
            ? "question"
            : "bash"
    return contestantResponse(
      body.model,
      number,
      tool,
      runNormalCommand ? (transcriptOnlyFixture ? "transcript" : "file") : false,
      runPromptCommand ? promptCommand : options?.contestantCommands?.[number],
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

/**
 * `until` is for the states a turn can re-enter. A promotion parks in `application_failed` as
 * `review`, and the answer to that lands it back in `application_failed` as `conflicted`, so the
 * state alone cannot tell the second arrival from the first.
 */
export async function waitForTurn(
  store: Store,
  turnID: string,
  state: TurnDocument["state"],
  until?: (turn: TurnDocument) => boolean,
) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const turn = await store.turn(turnID)
    if (turn?.state === state && (!until || until(turn))) return turn
    if (
      turn &&
      turn.state !== state &&
      ["discarded", "application_failed", "canonicalization_failed"].includes(turn.state)
    ) {
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

export type PublicSnapshot = {
  readonly chat: {
    readonly id: string
    readonly status: string
    readonly canonicalSessionID: string
    readonly canonicalSHA: string
    readonly blockedReason?: string
    readonly trunkConflicts?: ReadonlyArray<string>
  }
  readonly singleAgent?: {
    readonly id: string
    readonly revealed: boolean
    readonly vote?: "up" | "down"
    readonly identity?: { readonly name: string }
  }
  readonly turn?: {
    readonly id: string
    readonly state: string
    readonly vote?: string
    readonly appliedSide?: string
    readonly canVote: boolean
    readonly revealed: boolean
    readonly identities?: {
      readonly a: { readonly name: string }
      readonly b: { readonly name: string }
    }
  }
  readonly runs: ReadonlyArray<{
    readonly id: string
    readonly side: "a" | "b"
    readonly selectable: boolean
    readonly diff?: { readonly files: number; readonly additions: number; readonly deletions: number }
    readonly identity?: { readonly name: string }
    readonly messages?: ReadonlyArray<Readonly<Record<string, unknown>>>
    readonly parts?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>
    readonly permissions?: ReadonlyArray<Readonly<Record<string, unknown>>>
    readonly questions?: ReadonlyArray<Readonly<Record<string, unknown>>>
  }>
  readonly comparison?: { readonly state: string }
}

export async function json<T>(response: Response) {
  const text = await response.text()
  if (!response.ok) throw new Error(`Arena request failed with ${response.status}: ${text}`)
  return JSON.parse(text) as T
}
