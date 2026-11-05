import { SessionContext } from "@opencode/core/session/context"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { OpportunisticCompactionID } from "../engine-runtime/request"
import { createHistoryCompaction, type HistoryCompaction } from "../compaction-history"
import { compactionObservation } from "../compaction-metrics"
import { ArenaRuntime } from "../runtime"
import { and, desc, eq } from "drizzle-orm"
import { AIError } from "@opencode/ai"
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Permission as CorePermission } from "@opencode/core/permission"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session as CoreSession } from "@opencode/core/session"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionMove } from "@opencode/core/session/move"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { StepFailedError } from "@opencode/core/session/error"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session as SessionSchema } from "@opencode/schema/session"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/schema/agent"
import { ID as WorkspaceID } from "@opencode/schema/workspace"
import { Money } from "@opencode/schema/money"
import { ID as FormID } from "@opencode/schema/form"
import { Permission as PermissionSchema } from "@opencode/schema/permission"
import * as Prompt from "@opencode/schema/prompt"
import * as PromptInput from "@opencode/schema/prompt-input"
import { SessionEvent } from "@opencode/schema/session-event"
import * as PermissionV1 from "@opencode/schema/v1/permission"
import * as SessionV1 from "@opencode/schema/v1/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { makeGlobalNode, tags } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { failedAnswer, pendingMessage, project, projectSession, partID } from "./projection"
import { CurrentDirectory } from "@/project/instance-context"
import { getArenaAutoAccept, idleRecovery, setArenaAutoAccept } from "@/arena/engine-runtime"
import { ArenaResponseRecovery } from "@/arena/response-recovery"
import { shellRestartInput } from "@/arena/shell-restart"
import { battleResumeInput } from "@/arena/resume-note"
import { cancelSessionShells } from "@/arena/engine-runtime/shell"
import { EXTERNAL_WRITE } from "@/arena/contestant"
import type {
  ArenaMessageInfo,
  ArenaModel,
  ArenaPart,
  ArenaPermissionReply,
  ArenaQuestionRequest,
  ArenaQuestion,
  ArenaPromptPart,
  ArenaPromptInput,
  ArenaStatus,
  ArenaTranscript,
  SessionCreateInput,
} from "./schema"

export * as SessionV1 from "@opencode/schema/v1/session"
export * as PermissionV1 from "@opencode/schema/v1/permission"
// Arena callers use the retained V1 wire IDs.  They carry the same `msg_` values as Core IDs;
// canonical methods cast at the storage boundary so the projection never becomes a second store.
export { MessageID } from "@opencode/schema/v1/session"
export { ID as SessionID } from "@opencode/schema/session"
export { partID }
export { abandonedAttempts, messagesToGraft } from "./projection"
export const PartID = {
  make: (messageID: SessionMessage.ID, index: number) => partID(messageID, index),
}
export * from "./schema"

export interface DirectoryInterface {
  readonly ref: () => Effect.Effect<Location.Ref>
  readonly provide: <A, E, R>(ref: Location.Ref, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
}

/** Host-owned location context. Arena worktrees provide this around each operation. */
export class Directory extends Context.Service<Directory, DirectoryInterface>()("@agent-duel/ArenaDirectory") {}

export { CurrentDirectory }

export interface SessionInterface {
  readonly compactions: HistoryCompaction
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionV1.SessionInfo, Error>
  readonly create: (input?: SessionCreateInput) => Effect.Effect<SessionV1.SessionInfo, Error>
  readonly children: (parentID: SessionSchema.ID) => Effect.Effect<SessionV1.SessionInfo[], Error>
  readonly messages: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<ArenaTranscript, Error>
  readonly canonicalMessages: (sessionID: SessionSchema.ID) => Effect.Effect<readonly SessionMessage.Info[], Error>
  /**
   * Input Core holds in the session inbox until the runner promotes it at a step boundary, such as
   * a steer sent while the contestant works, projected as the messages it becomes on delivery.
   * `messages` reads the transcript only, so a queued steer is visible only here.
   */
  readonly pending: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<ArenaTranscript, Error>
  /**
   * Withdraw pending inputs, all or none. Fails, and withdraws nothing, when the runner already
   * delivered any of them.
   */
  readonly cancelPending: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageIDs: readonly SessionV1.MessageID[]
  }) => Effect.Effect<void, Error>
  /**
   * Move pending messages into the transcript without a model request, the way a 1.x steer stayed
   * as an unanswered message when its run was cut off. Returns how many moved.
   */
  readonly deliverPending: (sessionID: SessionSchema.ID) => Effect.Effect<number, Error>
  readonly getPart: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionV1.MessageID
    readonly partID: string
  }) => Effect.Effect<ArenaPart | undefined, Error>
  readonly fork: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID?: SessionV1.MessageID
    readonly onMessageMapping?: (mapping: ReadonlyMap<string, SessionV1.MessageID>) => void
  }) => Effect.Effect<SessionV1.SessionInfo, Error>
  readonly updateMessage: (message: ArenaMessageInfo) => Effect.Effect<ArenaMessageInfo, Error>
  /** Update a canonical V2 row after a native path transform, retaining provider state and content. */
  readonly updateCanonicalMessage: (input: {
    readonly sessionID: SessionSchema.ID
    readonly message: SessionMessage.Info
  }) => Effect.Effect<SessionMessage.Info, Error>
  readonly updatePart: (part: ArenaPart) => Effect.Effect<ArenaPart, Error>
  readonly removeMessage: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionV1.MessageID
  }) => Effect.Effect<SessionV1.MessageID, Error>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, Error>
  readonly setAgentModel: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: string
    readonly model: ArenaModel
    readonly time?: number
  }) => Effect.Effect<void, Error>
  readonly setPermission: (input: {
    readonly sessionID: SessionSchema.ID
    readonly permission: PermissionV1.Ruleset
  }) => Effect.Effect<void, Error>
  readonly copyMessage: (input: {
    readonly sourceSessionID: SessionSchema.ID
    readonly sourceMessageID: SessionV1.MessageID
    readonly targetSessionID: SessionSchema.ID
    readonly targetMessageID: SessionV1.MessageID
    readonly transform?: (message: SessionMessage.Info) => Effect.Effect<SessionMessage.Info, Error>
  }) => Effect.Effect<SessionMessage.Info, Error>
}

export class Session extends Context.Service<Session, SessionInterface>()("@agent-duel/ArenaSession") {}

export interface CancelOptions {
  readonly shells: boolean
}

export interface PromptInterface {
  readonly prompt: (input: ArenaPromptInput) => Effect.Effect<import("./schema").WithParts | undefined, Error>
  readonly loop: (input: {
    readonly interruptedBattleID?: string
    readonly stoppedShellIDs?: readonly string[]
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<import("./schema").WithParts | undefined, Error>
  /**
   * The session's latest answer, after the run it has now ends. Unlike `loop` it never starts a
   * run: Core answers the last message again when `resume` finds the session idle.
   */
  readonly join: (input: {
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<import("./schema").WithParts | undefined, Error>
  /**
   * Admit input into a session that may be working and wake its runner, without waiting for the
   * answer. The runner that owns the turn delivers it at its next step boundary.
   */
  readonly steer: (input: ArenaPromptInput) => Effect.Effect<void, Error>
  /** Interrupts the session and its child job. Stop also ends shells; steering keeps Preview alive. */
  readonly cancel: (sessionID: SessionSchema.ID, options?: CancelOptions) => Effect.Effect<void, Error>
  /** Child results stop starting runs of these sessions until the next `prompt` or `loop` of each. */
  readonly holdChildResults: (sessionIDs: readonly SessionSchema.ID[]) => Effect.Effect<void, Error>
  /** Whether the session has a run, a running job, or a job result that has not reached its parent. */
  readonly working: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, Error>
  readonly prepare: () => Effect.Effect<void, Error>
}

export class SessionPrompt extends Context.Service<SessionPrompt, PromptInterface>()(
  "@agent-duel/ArenaSessionPrompt",
) {}

export interface StatusInterface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ArenaStatus, Error>
}

export class SessionStatus extends Context.Service<SessionStatus, StatusInterface>()(
  "@agent-duel/ArenaSessionStatus",
) {}

export interface PermissionInterface {
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>, Error>
  readonly reply: (input: ArenaPermissionReply) => Effect.Effect<void, Error>
  readonly setAutoAccept: (sessionID: string, enabled: boolean) => Effect.Effect<void, Error>
}

export class Permission extends Context.Service<Permission, PermissionInterface>()("@agent-duel/ArenaPermission") {}

export interface QuestionInterface {
  readonly list: () => Effect.Effect<ReadonlyArray<ArenaQuestionRequest>, Error>
  readonly reply: (input: {
    readonly requestID: string
    readonly answers: ReadonlyArray<ReadonlyArray<string>>
  }) => Effect.Effect<void, Error>
  readonly reject: (requestID: string) => Effect.Effect<void, Error>
}

export class Question extends Context.Service<Question, QuestionInterface>()("@agent-duel/ArenaQuestion") {}

/** Host-provided move operation used when a localized session changes worktree. */
export interface MoveSessionInterface {
  readonly moveSession: (input: {
    readonly sessionID: SessionSchema.ID
    readonly directory: string
    readonly workspaceID?: string
    readonly moveChanges?: boolean
  }) => Effect.Effect<void, Error>
}

export class MoveSessionService extends Context.Service<MoveSessionService, MoveSessionInterface>()(
  "@agent-duel/MoveSession",
) {}

const encodeCanonical = Schema.encodeSync(SessionMessage.Info)

const modelRef = (value: ArenaModel): Model.Ref => ({
  id: value.modelID,
  providerID: value.providerID,
  ...(value.variant ? { variant: Model.VariantID.make(value.variant) } : {}),
})

const epoch = (value: number) => DateTime.makeUnsafe(value)

const currentSessionID = (value: string) => SessionSchema.ID.make(String(value))
const currentMessageID = (value: string) => SessionMessage.ID.make(String(value))
const wireMessageID = (value: string) => SessionV1.MessageID.make(String(value))

const currentError = (value: NonNullable<SessionV1.Assistant["error"]>): SessionMessage.Assistant["error"] => {
  const data = value.data
  return {
    type: value.name,
    message: "message" in data ? data.message : value.name,
    ...("statusCode" in data && data.statusCode !== undefined ? { status: data.statusCode } : {}),
    ...("responseBody" in data && data.responseBody !== undefined ? { response: { body: data.responseBody } } : {}),
  }
}

const arenaError = (error: string) => ({ type: "arena", message: error })
const CLEARED = "[Old tool result content cleared]"

/**
 * A stream that ended before the provider finished it, which the engine retries on its own and which
 * Arena offers Retry for. Core stores it as `provider.invalid-output` like malformed output, which is
 * not retried, so tell the two apart from the failure itself. A malformed-output AIError fails the
 * drain as that AIError. A `StepFailedError` of that type comes from a stream that succeeded without
 * a finish (`runner/step.ts`, unknown finish reason, `incomplete-stream`) or from a compaction.
 */
const incompleteStream = (failure: unknown) =>
  failure instanceof AIError
    ? failure.reason._tag === "InvalidProviderOutput" && failure.reason.classification === "incomplete-stream"
    : failure instanceof StepFailedError && failure.error.type === "provider.invalid-output"

const normalizeError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Error, R> =>
  effect.pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

const preserveToolContent = (current: readonly import("@opencode/schema/tool").Tool.Content[], output: string) => {
  if (output.length === 0) return current
  const index = current.findIndex((item) => item.type === "text")
  if (index === -1) return [...current, { type: "text" as const, text: output }]
  return current.map((item, itemIndex) =>
    itemIndex === index && item.type === "text" ? { ...item, text: output } : item,
  )
}

const locationRef = (input: { readonly directory: string; readonly workspaceID?: string }): Location.Ref =>
  Location.Ref.make({
    directory: AbsolutePath.make(input.directory),
    ...(input.workspaceID ? { workspaceID: WorkspaceID.make(input.workspaceID) } : {}),
  })

const promptFiles = (files: ArenaPromptInput["files"]): PromptInput.Prompt["files"] =>
  files?.map((file) =>
    "uri" in file
      ? file
      : {
          uri: `data:${file.mime};base64,${file.data}`,
          ...(file.name ? { name: file.name } : {}),
        },
  )

const partFiles = (parts: readonly ArenaPromptPart[] | undefined): PromptInput.Prompt["files"] =>
  parts?.flatMap((part) =>
    part.type === "file"
      ? [
          {
            uri: part.url,
            ...(part.filename ? { name: part.filename } : {}),
          },
        ]
      : [],
  )

const partText = (parts: readonly ArenaPromptPart[] | undefined) =>
  parts
    ?.flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "subtask") return [`${part.description}\n${part.prompt}`]
      if (part.type === "agent") return [`Continue with the ${part.name} agent.`]
      return []
    })
    .join("\n\n")

const formQuestion = (field: Form.Field): ArenaQuestion => {
  const header = field.title ?? field.key
  const question = field.description ? `${header}: ${field.description}` : header
  const options =
    "options" in field && field.options
      ? field.options.map((option) => ({
          label: option.label,
          description: option.description ?? "",
        }))
      : field.type === "boolean"
        ? [
            { label: "true", description: "Yes" },
            { label: "false", description: "No" },
          ]
        : []
  return {
    question,
    header,
    options,
    ...(field.type === "multiselect" ? { multiple: true } : {}),
    ...(field.type === "string" ? { custom: field.custom ?? true } : {}),
  }
}

const formRequest = (form: Form.Info): ArenaQuestionRequest => ({
  id: String(form.id),
  sessionID: String(form.sessionID),
  questions: form.fields.map(formQuestion),
})

const promptText = (input: ArenaPromptInput) =>
  [input.text, partText(input.parts)]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n\n")

function replaceCanonicalPart(
  current: SessionMessage.AssistantContent,
  part: ArenaPart,
): SessionMessage.AssistantContent {
  if (part.type === "text") return { ...current, type: "text", text: part.text, state: part.metadata }
  if (part.type === "reasoning") {
    if (current.type !== "reasoning") return { type: "reasoning", text: part.text, state: part.metadata }
    return { ...current, text: part.text, state: part.metadata }
  }
  if (part.type !== "tool") return current
  if (current.type !== "tool")
    return {
      type: "tool",
      id: part.callID,
      name: part.tool,
      time: { created: epoch(Date.now()) },
      state: { status: "streaming", input: "" },
    }
  const value = part.state
  if (value.status === "pending")
    return { ...current, id: part.callID, name: part.tool, state: { status: "streaming", input: value.raw } }
  if (value.status === "running")
    return {
      ...current,
      id: part.callID,
      name: part.tool,
      state: { status: "running", input: value.input, metadata: value.metadata ?? {} },
    } as SessionMessage.AssistantContent
  if (value.status === "completed")
    return {
      ...current,
      id: part.callID,
      name: part.tool,
      state: {
        status: "completed",
        input: value.input,
        content:
          value.time.compacted !== undefined
            ? [{ type: "text", text: CLEARED }]
            : preserveToolContent(current.state.status === "completed" ? current.state.content : [], value.output),
        metadata: value.metadata,
      },
    } as SessionMessage.AssistantContent
  return {
    ...current,
    id: part.callID,
    name: part.tool,
    state: { status: "error", input: value.input, error: arenaError(value.error), metadata: value.metadata },
  } as SessionMessage.AssistantContent
}

const updateRow = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  message: SessionMessage.Info,
) {
  const encoded = encodeCanonical(message)
  const { id, type, ...data } = encoded
  yield* database.db
    .update(SessionMessageTable)
    .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
    .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, sessionID)))
    .run()
    .pipe(Effect.orDie)
})

const directoryLayer: Layer.Layer<Directory, never, LocationServiceMap.Service> = Layer.effect(
  Directory,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const ref = () =>
      Effect.gen(function* () {
        return yield* CurrentDirectory
      })
    const provide = <A, E, R>(target: Location.Ref, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(locations.get(target)),
        Effect.provideService(CurrentDirectory, target),
      ) as Effect.Effect<A, E>
    return Directory.of({ ref, provide })
  }),
)

const layer: Layer.Layer<Session, never, CoreSession.Service | Database.Service | Bus.Service | Directory> =
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const directory = yield* Directory
      const observations = new Map<string, Promise<void>>()
      const compactions = createHistoryCompaction({
        sessions,
        database,
        generate: ({ sessionID, id }) =>
          normalizeError(
            Effect.gen(function* () {
              const session = yield* sessions.get(sessionID)
              return yield* directory.provide(
                session.location,
                Effect.gen(function* () {
                  const contexts = yield* SessionContext.Service
                  const compaction = yield* SessionCompaction.Service
                  const context = yield* contexts.load(yield* contexts.select(sessionID))
                  return yield* compaction.candidate(context)
                }).pipe(Effect.provideService(OpportunisticCompactionID, id)),
              )
            }),
          ),
        observe: (id, snapshot) => {
          const observation = compactionObservation(id, snapshot)
          const previous = observations.get(id) ?? Promise.resolve()
          const pending = previous
            .then(async () => {
              const store = await ArenaRuntime.store()
              await store.recordCompaction(observation)
            })
            .catch((cause) => {
              console.warn("[arena-compaction] Could not record outcome", cause)
            })
          observations.set(id, pending)
          void pending.finally(() => {
            if (observations.get(id) === pending) observations.delete(id)
          })
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => compactions.dispose()))

      const messages = Effect.fn("ArenaSession.messages")(function* (input: { readonly sessionID: SessionSchema.ID }) {
        const canonical = yield* sessions.messages({ ...input, order: "asc" })
        const info = yield* sessions.get(input.sessionID)
        return project(canonical, input.sessionID, info.model, info.agent)
      })

      const pending = Effect.fn("ArenaSession.pending")(function* (input: { readonly sessionID: SessionSchema.ID }) {
        const items = yield* sessions.inbox(input.sessionID)
        const queued = items.flatMap((item) => {
          const message = pendingMessage(item)
          return message ? [message] : []
        })
        if (queued.length === 0) return []
        const info = yield* sessions.get(input.sessionID)
        return project(queued, input.sessionID, info.model, info.agent)
      })

      // Core's cancel takes one item and its own lock, so several in a row could stop halfway once the
      // runner delivers one. Check and cancel them all under the lock promotion takes instead.
      const cancelPending = Effect.fn("ArenaSession.cancelPending")(function* (input: {
        readonly sessionID: SessionSchema.ID
        readonly messageIDs: readonly SessionV1.MessageID[]
      }) {
        const ids = input.messageIDs.map(currentMessageID)
        yield* SessionInbox.serialized(
          input.sessionID,
          Effect.gen(function* () {
            const pending = new Set(
              (yield* sessions.inbox(input.sessionID))
                .filter((item) => pendingMessage(item) !== undefined)
                .map((item) => item.id),
            )
            if (ids.some((id) => !pending.has(id)))
              return yield* Effect.fail(new Error("Arena pending steer was already consumed"))
            yield* Effect.forEach(
              ids,
              (inboxID) => bus.publish(SessionEvent.InboxCancelled, { sessionID: input.sessionID, inboxID }),
              { discard: true },
            )
          }),
        )
      })

      // Core's own promotion step, without the model request that follows it: the delivered event
      // writes the message under the inbox ID. Serialized with the runner's promotion, so an item
      // it delivered first is skipped rather than written twice.
      const deliverPending = Effect.fn("ArenaSession.deliverPending")(function* (sessionID: SessionSchema.ID) {
        return yield* SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            const items = (yield* sessions.inbox(sessionID)).filter((item) => pendingMessage(item) !== undefined)
            yield* Effect.forEach(
              items,
              (item) =>
                bus
                  .publish(SessionEvent.InboxDelivered, { sessionID, inboxID: item.id })
                  .pipe(
                    Effect.catchDefect((defect) =>
                      defect instanceof SessionInbox.LifecycleConflict ? Effect.void : Effect.die(defect),
                    ),
                  ),
              { discard: true },
            )
            return items.length
          }),
        )
      })

      const getCanonical = (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) =>
        sessions
          .message({ sessionID, messageID })
          .pipe(
            Effect.flatMap((value) =>
              value ? Effect.succeed(value) : Effect.fail(new Error(`Message not found: ${messageID}`)),
            ),
          )

      const updateMessage = Effect.fn("ArenaSession.updateMessage")(function* (message: ArenaMessageInfo) {
        const current = yield* getCanonical(currentSessionID(message.sessionID), currentMessageID(message.id))
        if (message.role === "assistant" && current.type === "assistant") {
          const updated: SessionMessage.Assistant = {
            ...current,
            agent: Agent.ID.make(message.agent),
            model: {
              id: message.modelID,
              providerID: message.providerID,
              ...(message.variant ? { variant: Model.VariantID.make(message.variant) } : {}),
            },
            time: {
              ...current.time,
              created: epoch(message.time.created),
              ...(message.time.completed === undefined ? {} : { completed: epoch(message.time.completed) }),
            },
            ...(message.error === undefined ? {} : { error: currentError(message.error) }),
            cost: Money.USD.make(message.cost),
            tokens: {
              ...current.tokens,
              input: message.tokens.input,
              output: message.tokens.output,
              reasoning: message.tokens.reasoning,
              cache: message.tokens.cache,
            },
            finish: message.finish as SessionMessage.Assistant["finish"],
          }
          yield* updateRow(database, currentSessionID(message.sessionID), updated)
        }
        return message
      })

      const updateCanonicalMessage = Effect.fn("ArenaSession.updateCanonicalMessage")(function* (input: {
        readonly sessionID: SessionSchema.ID
        readonly message: SessionMessage.Info
      }) {
        yield* updateRow(database, input.sessionID, input.message)
        return input.message
      })

      const updatePart = Effect.fn("ArenaSession.updatePart")(function* (part: ArenaPart) {
        const current = yield* getCanonical(currentSessionID(part.sessionID), currentMessageID(part.messageID))
        if (current.type === "assistant") {
          const index = Number(part.id.slice(part.id.lastIndexOf("_") + 1))
          const content = current.content.map((item, itemIndex) =>
            itemIndex === index ? replaceCanonicalPart(item, part) : item,
          )
          yield* bus.publish(SessionEvent.MessageContentUpdated, {
            sessionID: part.sessionID,
            messageID: currentMessageID(part.messageID),
            content: content.map((item) => Schema.encodeSync(SessionMessage.AssistantContent)(item)),
          })
        } else if (current.type === "user") {
          const index = Number(part.id.slice(part.id.lastIndexOf("_") + 1))
          if (part.type === "text" && index === 0) {
            yield* updateRow(database, part.sessionID as SessionSchema.ID, { ...current, text: part.text })
          } else if (part.type === "file" && index > 0) {
            const files = [...(current.files ?? [])]
            const comma = part.url.indexOf(",")
            const data = comma === -1 ? "" : part.url.slice(comma + 1)
            files[index - 1] = Prompt.FileAttachment.make({
              data,
              mime: part.mime,
              source: { type: "inline" },
              name: part.filename,
            })
            yield* updateRow(database, part.sessionID as SessionSchema.ID, { ...current, files })
          }
        }
        return part
      })

      const copyMessage = Effect.fn("ArenaSession.copyMessage")(function* (input: {
        readonly sourceSessionID: SessionSchema.ID
        readonly sourceMessageID: SessionV1.MessageID
        readonly targetSessionID: SessionSchema.ID
        readonly targetMessageID: SessionV1.MessageID
        readonly transform?: (message: SessionMessage.Info) => Effect.Effect<SessionMessage.Info, Error>
      }) {
        const source = yield* getCanonical(input.sourceSessionID, currentMessageID(input.sourceMessageID))
        const transformed = input.transform ? yield* input.transform(source) : source
        const message = { ...transformed, id: currentMessageID(input.targetMessageID) }
        const encoded = encodeCanonical(message)
        const { type, ...data } = encoded
        const latest = yield* database.db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, input.targetSessionID))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const seq = (latest?.seq ?? -1) + 1
        yield* database.db
          .insert(SessionMessageTable)
          .values({
            id: currentMessageID(input.targetMessageID),
            session_id: input.targetSessionID,
            type,
            seq,
            time_created: DateTime.toEpochMillis(message.time.created),
            time_updated: Date.now(),
            data,
          })
          .run()
          .pipe(Effect.orDie)
        yield* Bus.reserveSequence(database.db, input.targetSessionID, seq)
        return message
      })

      const fork = Effect.fn("ArenaSession.fork")(function* (input: {
        readonly sessionID: SessionSchema.ID
        readonly messageID?: SessionV1.MessageID
        readonly onMessageMapping?: (mapping: ReadonlyMap<string, SessionV1.MessageID>) => void
      }) {
        const source = yield* sessions.messages({ sessionID: input.sessionID, order: "asc" })
        const before = input.messageID ? currentMessageID(input.messageID) : undefined
        const forked = yield* sessions.fork({ sessionID: input.sessionID, before })
        const copied = yield* sessions.messages({ sessionID: forked.id, order: "asc" })
        const mapping = new Map<string, SessionV1.MessageID>()
        source
          .slice(0, before ? source.findIndex((message) => message.id === before) : source.length)
          .forEach((message, index) => {
            const replacement = copied[index]
            if (replacement) mapping.set(message.id, wireMessageID(replacement.id))
          })
        input.onMessageMapping?.(mapping)
        return projectSession(forked)
      })

      return Session.of({
        compactions,
        get: (sessionID) => normalizeError(sessions.get(sessionID).pipe(Effect.map(projectSession))),
        create: (input = {}) =>
          normalizeError(
            Effect.gen(function* () {
              const common = {
                id: input.id,
                title: input.title,
                agent: input.agent ? Agent.ID.make(input.agent) : undefined,
                model: input.model ? modelRef(input.model) : undefined,
                metadata: input.metadata,
                permissions: input.permissions,
              }
              if (input.parentID)
                return yield* sessions.create({ ...common, parentID: input.parentID }).pipe(Effect.map(projectSession))
              const location = input.location
                ? {
                    directory: AbsolutePath.make(input.location.directory),
                    ...(input.location.workspaceID
                      ? { workspaceID: WorkspaceID.make(input.location.workspaceID) }
                      : {}),
                  }
                : yield* directory.ref()
              return yield* sessions.create({ ...common, location }).pipe(Effect.map(projectSession))
            }),
          ),
        children: (parentID) =>
          normalizeError(sessions.list({ parentID }).pipe(Effect.map((result) => result.data.map(projectSession)))),
        messages: (input) => normalizeError(messages(input)),
        canonicalMessages: (sessionID) => normalizeError(sessions.messages({ sessionID, order: "asc" })),
        pending: (input) => normalizeError(pending(input)),
        cancelPending: (input) => normalizeError(cancelPending(input)),
        deliverPending: (sessionID) => normalizeError(deliverPending(sessionID)),
        getPart: (input) =>
          normalizeError(
            Effect.gen(function* () {
              const transcript = yield* messages({ sessionID: input.sessionID })
              return transcript
                .find((entry) => entry.info.id === input.messageID)
                ?.parts.find((part) => part.id === input.partID)
            }),
          ),
        fork: (input) => normalizeError(fork(input)),
        updateMessage: (message) => normalizeError(updateMessage(message)),
        updateCanonicalMessage: (input) => normalizeError(updateCanonicalMessage(input)),
        updatePart: (part) => normalizeError(updatePart(part)),
        removeMessage: (input) =>
          normalizeError(
            Effect.gen(function* () {
              const messageID = currentMessageID(input.messageID)
              // A noReply prompt is durable in Core's inbox until the runner promotes it.  Arena
              // discard/interrupt paths address it by message ID, so cancel the admission before
              // touching canonical rows; deleting SQL alone would leave the prompt executable.
              const pending = yield* sessions.inbox(input.sessionID)
              if (pending.some((item) => item.id === messageID)) {
                yield* sessions.cancelInbox({ sessionID: input.sessionID, inboxID: messageID })
                return input.messageID
              }
              yield* database.db
                .delete(SessionMessageTable)
                .where(and(eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.session_id, input.sessionID)))
                .run()
                .pipe(Effect.orDie)
              return input.messageID
            }),
          ),
        remove: (sessionID) =>
          normalizeError(
            Effect.sync(() => compactions.invalidate(sessionID)).pipe(Effect.andThen(sessions.remove(sessionID))),
          ),
        setAgentModel: (input) =>
          normalizeError(
            Effect.gen(function* () {
              yield* sessions.switchAgent({ sessionID: input.sessionID, agent: Agent.ID.make(input.agent) })
              yield* sessions.switchModel({ sessionID: input.sessionID, model: modelRef(input.model) })
            }),
          ),
        setPermission: (input) =>
          normalizeError(
            sessions.setPermissions({
              sessionID: input.sessionID,
              permissions: input.permission.map((rule) => ({
                // Core asks for external-directory approval first, then applies
                // edit rules to the concrete file resource.
                action: rule.permission === EXTERNAL_WRITE ? "edit" : rule.permission,
                resource: rule.pattern,
                effect: rule.action,
              })),
            }),
          ),
        copyMessage: (input) => normalizeError(copyMessage(input)),
      })
    }),
  )

export const locationServiceMapNode = LayerNode.unbound(LocationServiceMap.Service, tags.values.global)
export const directoryNode = makeGlobalNode({
  service: Directory,
  layer: directoryLayer,
  deps: [locationServiceMapNode],
})
export const sessionNode = makeGlobalNode({
  service: Session,
  layer,
  deps: [CoreSession.node, Database.node, Bus.node, directoryNode],
})
export const node = sessionNode

const promptLayer: Layer.Layer<
  SessionPrompt,
  never,
  CoreSession.Service | Session | Directory | Job.Service | SubagentJob.Service
> = Layer.effect(
  SessionPrompt,
  Effect.gen(function* () {
    const sessions = yield* CoreSession.Service
    const arena = yield* Session
    const directory = yield* Directory
    const jobs = yield* Job.Service
    const subagents = yield* SubagentJob.Service
    // A failed drain comes back as an error, not as the errored assistant that 1.x returned.
    // Settle on that assistant instead, so the run fails the way Arena classifies (and offers
    // Retry for). Interruption is not an error here and still ends the loop.
    const answer = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      started: number,
      failure?: Parameters<typeof toSessionError>[0],
    ) {
      yield* sessions.wait(sessionID)
      const transcript = yield* arena.messages({ sessionID })
      if (failure === undefined) return transcript.findLast((entry) => entry.info.role === "assistant")
      const failed = failedAnswer(
        transcript,
        toSessionError(failure),
        { started, now: yield* Clock.currentTimeMillis },
        incompleteStream(failure),
      )
      if (!failed) return yield* Effect.fail(failure)
      return failed
    })
    const settle = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, started: number) {
      const failure = yield* sessions.resume(sessionID).pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      )
      return yield* answer(sessionID, started, failure)
    })
    const loop = Effect.fn("ArenaSessionPrompt.loop")(function* (
      input: Parameters<PromptInterface["loop"]>[0],
      /** When this run's work was admitted; a prompt admits it before the loop joins. */
      admittedAt?: number,
    ) {
      const notes = [
        ...(input.interruptedBattleID ? [battleResumeInput(input.sessionID, input.interruptedBattleID)] : []),
        shellRestartInput(input.sessionID, input.stoppedShellIDs),
      ]
      for (const note of notes) {
        if (!note) continue
        const messages = yield* sessions.messages({ sessionID: input.sessionID })
        const inbox = yield* sessions.inbox(input.sessionID)
        const exists = [...messages, ...inbox].some((message) => message.id === note.id)
        if (!exists)
          yield* sessions.synthetic({
            sessionID: input.sessionID,
            id: SessionMessage.ID.make(note.id),
            text: note.text,
            resume: false,
          })
      }
      yield* subagents.release(input.sessionID)
      return yield* settle(input.sessionID, admittedAt ?? (yield* Clock.currentTimeMillis))
    })
    const join = Effect.fn("ArenaSessionPrompt.join")(function* (input: { readonly sessionID: SessionSchema.ID }) {
      const started = yield* Clock.currentTimeMillis
      if ((yield* sessions.active).has(input.sessionID)) return yield* settle(input.sessionID, started)
      return yield* answer(input.sessionID, started)
    })
    // Admission is durable once it returns. `wake` starts the runner, or rings the doorbell of the
    // one already running so it drains again before it goes idle.
    const admit = Effect.fn("ArenaSessionPrompt.admit")(function* (input: ArenaPromptInput, wake: boolean) {
      yield* arena.compactions.accept(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed(false)))
      const metadata = {
        ...(input.metadata ?? {}),
        ...(input.system !== undefined ? { arenaSystem: input.system } : {}),
      }
      const location = yield* directory.ref()
      yield* directory.provide(
        location,
        Effect.gen(function* () {
          const entries = yield* InstructionEntry.Service
          if (input.system === undefined) {
            yield* entries.remove({ sessionID: input.sessionID, key: InstructionEntry.Key.make("arena") })
          } else {
            yield* entries.put({
              sessionID: input.sessionID,
              key: InstructionEntry.Key.make("arena"),
              value: input.system,
            })
          }
        }),
      )
      if (input.agent) yield* sessions.switchAgent({ sessionID: input.sessionID, agent: Agent.ID.make(input.agent) })
      if (input.model) {
        yield* sessions.switchModel({
          sessionID: input.sessionID,
          model: modelRef({
            ...input.model,
            ...(input.variant ? { variant: Model.VariantID.make(input.variant) } : {}),
          }),
        })
      }
      const admittedAt = yield* Clock.currentTimeMillis
      yield* sessions.prompt({
        sessionID: input.sessionID,
        id: input.messageID ? currentMessageID(input.messageID) : undefined,
        text: promptText(input),
        files: [...(promptFiles(input.files) ?? []), ...(partFiles(input.parts) ?? [])],
        agents: input.agents,
        skills: input.skills,
        metadata,
        delivery: input.delivery,
        resume: wake,
      })
      return admittedAt
    })
    return SessionPrompt.of({
      prompt: (input) =>
        normalizeError(
          Effect.gen(function* () {
            const admittedAt = yield* admit(input, input.noReply !== true)
            if (input.noReply === true) return undefined
            // Core prompt admission is durable; waiting here ensures callers receive the terminal
            // assistant projection rather than a cached or fabricated transcript.
            return yield* loop({ sessionID: input.sessionID }, admittedAt)
          }),
        ),
      steer: (input) => normalizeError(admit(input, true).pipe(Effect.asVoid)),
      loop: (input) => normalizeError(loop(input)),
      join: (input) => normalizeError(join(input)),
      cancel: (sessionID, options) =>
        normalizeError(
          Effect.gen(function* () {
            yield* sessions.interrupt(sessionID, { resume: false })
            yield* jobs.cancel(sessionID)
            if (options?.shells) {
              const ref = yield* directory.ref()
              yield* directory.provide(ref, cancelSessionShells(sessionID))
            }
          }),
        ),
      holdChildResults: (sessionIDs) =>
        Effect.forEach(sessionIDs, (sessionID) => subagents.hold(sessionID), { discard: true }),
      working: (sessionID) =>
        Effect.gen(function* () {
          if ((yield* sessions.active).has(sessionID)) return true
          const job = yield* jobs.get(sessionID)
          // Delivery removes a job that has a notification, so a finished one still has a result to
          // deliver. Foreground jobs have none, and their results are already in the tool call.
          return job !== undefined && (job.status === "running" || job.notificationID !== undefined)
        }),
      prepare: () => Effect.void,
    })
  }),
)

export const promptNode = makeGlobalNode({
  service: SessionPrompt,
  layer: promptLayer,
  deps: [CoreSession.node, sessionNode, directoryNode, Job.node, SubagentJob.node],
})

const statusLayer: Layer.Layer<SessionStatus, never, CoreSession.Service> = Layer.effect(
  SessionStatus,
  Effect.gen(function* () {
    const sessions = yield* CoreSession.Service
    return SessionStatus.of({
      get: (sessionID) =>
        normalizeError(
          Effect.gen(function* () {
            if (!(yield* sessions.active).has(sessionID)) return { type: "idle" } as const
            // Core keeps a scheduled retry on the open assistant until the next attempt starts. The
            // pane shows it as "Waiting for network", "Waiting for sign-in" or "Continuing after
            // model timeout".
            const [latest] = yield* sessions
              .messages({ sessionID, type: "assistant", order: "desc", limit: 1 })
              .pipe(Effect.orElseSucceed(() => []))
            const retry = latest?.type === "assistant" && !latest.time.completed ? latest.retry : undefined
            if (!retry) {
              // As in 1.x, the recovery attempt after a model timeout keeps its label until it ends.
              const recovery = idleRecovery(sessionID)
              if (recovery === undefined) return { type: "busy" } as const
              return {
                type: "retry",
                attempt: recovery,
                message: ArenaResponseRecovery.IDLE_RECOVERING,
                next: Date.now(),
              } as const
            }
            return {
              type: "retry",
              attempt: retry.attempt,
              message: retry.error.message,
              next: DateTime.toEpochMillis(retry.at),
            } as const
          }),
        ),
    })
  }),
)

export const statusNode = makeGlobalNode({ service: SessionStatus, layer: statusLayer, deps: [CoreSession.node] })

const permissionLayer: Layer.Layer<Permission, never, Directory> = Layer.effect(
  Permission,
  Effect.gen(function* () {
    const directory = yield* Directory
    const inLocation = <A, E>(effect: Effect.Effect<A, E, CorePermission.Service>) =>
      Effect.gen(function* () {
        const ref = yield* directory.ref()
        return yield* directory.provide(ref, effect)
      }) as Effect.Effect<A, E>
    return Permission.of({
      list: () =>
        normalizeError(
          inLocation(
            Effect.gen(function* () {
              const permissions = yield* CorePermission.Service
              const pending = yield* permissions.list()
              const wire = (request: CorePermission.Request): PermissionV1.Request => ({
                id: PermissionV1.ID.make(request.id),
                sessionID: request.sessionID as PermissionV1.Request["sessionID"],
                permission: request.action,
                patterns: [...request.resources],
                metadata: request.metadata ?? {},
                always: [...(request.save ?? [])],
                ...(request.source?.type === "tool"
                  ? { tool: { messageID: request.source.messageID, callID: request.source.id } }
                  : {}),
              })
              if (!pending.length || !pending.some((request) => getArenaAutoAccept(String(request.sessionID))))
                return pending.map(wire)
              const accepted = pending.filter(
                (request) => getArenaAutoAccept(String(request.sessionID)) && request.action !== "external_directory",
              )
              yield* Effect.forEach(
                accepted,
                (request) => permissions.reply({ requestID: request.id, reply: "once" }).pipe(Effect.ignore),
                { discard: true },
              )
              return (yield* permissions.list()).map(wire)
            }),
          ),
        ),
      reply: (input) =>
        normalizeError(
          inLocation(
            Effect.gen(function* () {
              const permissions = yield* CorePermission.Service
              yield* permissions.reply({
                requestID: PermissionSchema.ID.make(input.requestID),
                reply: input.reply,
                message: input.message,
              })
            }),
          ),
        ),
      setAutoAccept: (sessionID, enabled) =>
        normalizeError(
          Effect.gen(function* () {
            setArenaAutoAccept(sessionID, enabled)
          }),
        ),
    })
  }),
)

export const permissionNode = makeGlobalNode({ service: Permission, layer: permissionLayer, deps: [directoryNode] })

const questionLayer: Layer.Layer<Question, never, Directory> = Layer.effect(
  Question,
  Effect.gen(function* () {
    const directory = yield* Directory
    const inLocation = <A, E>(effect: Effect.Effect<A, E, Form.Service>) =>
      Effect.gen(function* () {
        const ref = yield* directory.ref()
        return yield* directory.provide(ref, effect)
      }) as Effect.Effect<A, E>
    return Question.of({
      list: () =>
        normalizeError(
          inLocation(
            Effect.gen(function* () {
              const forms = yield* Form.Service
              return (yield* forms.list()).map(formRequest)
            }),
          ),
        ),
      reply: (input) =>
        normalizeError(
          inLocation(
            Effect.gen(function* () {
              const forms = yield* Form.Service
              const form = yield* forms.get(FormID.make(input.requestID))
              const answer = Object.fromEntries(
                form.fields.map((field, index) => {
                  const values = input.answers[index] ?? []
                  const first = values[0] ?? ""
                  if (field.type === "number" || field.type === "integer") return [field.key, Number(first)]
                  if (field.type === "boolean") return [field.key, first === "true"]
                  if (field.type === "multiselect") return [field.key, [...values]]
                  return [field.key, first]
                }),
              )
              yield* forms.reply({ id: form.id, answer })
            }),
          ),
        ),
      reject: (requestID) =>
        normalizeError(
          inLocation(
            Effect.gen(function* () {
              const forms = yield* Form.Service
              yield* forms.cancel(FormID.make(requestID))
            }),
          ),
        ),
    })
  }),
)

export const questionNode = makeGlobalNode({ service: Question, layer: questionLayer, deps: [directoryNode] })

const moveLayer: Layer.Layer<MoveSessionService, never, CoreSession.Service> = Layer.effect(
  MoveSessionService,
  Effect.gen(function* () {
    const sessions = yield* CoreSession.Service
    return MoveSessionService.of({
      moveSession: (input) =>
        normalizeError(
          sessions.move({
            sessionID: input.sessionID,
            directory: AbsolutePath.make(input.directory),
            ...(input.workspaceID ? { workspaceID: WorkspaceID.make(input.workspaceID) } : {}),
          }),
        ),
    })
  }),
)

export const MoveSession = {
  Service: MoveSessionService,
  layer: moveLayer,
} as const

/**
 * The complete Arena session facade.  Hosts provide the current Core globals once and install
 * this layer alongside their routes; Directory then resolves the request's LocationServiceMap
 * through CurrentDirectory for permission and question operations.
 */
const sessionPromptLayer = Layer.provideMerge(promptLayer, layer)

export const runtimeLayer = Layer.mergeAll(
  sessionPromptLayer,
  statusLayer,
  permissionLayer,
  questionLayer,
  moveLayer,
).pipe(Layer.provide(directoryLayer))

export const arenaSessionRuntimeLayer = runtimeLayer

export const moveNode = makeGlobalNode({ service: MoveSessionService, layer: moveLayer, deps: [CoreSession.node] })

export { project }
export * as SessionRuntime from "./index"
