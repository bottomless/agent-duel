import { and, desc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Permission as CorePermission } from "@opencode/core/permission"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session as CoreSession } from "@opencode/core/session"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionMove } from "@opencode/core/session/move"
import { SessionMessageTable } from "@opencode/core/session/sql"
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
import { project, projectSession, partID } from "./projection"
import { CurrentDirectory } from "@/project/instance-context"
import { getArenaAutoAccept, setArenaAutoAccept } from "@/arena/engine-runtime"
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
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionV1.SessionInfo, Error>
  readonly create: (input?: SessionCreateInput) => Effect.Effect<SessionV1.SessionInfo, Error>
  readonly children: (parentID: SessionSchema.ID) => Effect.Effect<SessionV1.SessionInfo[], Error>
  readonly messages: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<ArenaTranscript, Error>
  readonly canonicalMessages: (sessionID: SessionSchema.ID) => Effect.Effect<readonly SessionMessage.Info[], Error>
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

export interface PromptInterface {
  readonly prompt: (input: ArenaPromptInput) => Effect.Effect<import("./schema").WithParts | undefined, Error>
  readonly loop: (input: {
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<import("./schema").WithParts | undefined, Error>
  readonly cancel: (sessionID: SessionSchema.ID) => Effect.Effect<void, Error>
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

      const messages = Effect.fn("ArenaSession.messages")(function* (input: { readonly sessionID: SessionSchema.ID }) {
        const canonical = yield* sessions.messages({ ...input, order: "asc" })
        const info = yield* sessions.get(input.sessionID)
        return project(canonical, input.sessionID, info.model, info.agent)
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
        remove: (sessionID) => normalizeError(sessions.remove(sessionID)),
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

const promptLayer: Layer.Layer<SessionPrompt, never, CoreSession.Service | Session | Directory> = Layer.effect(
  SessionPrompt,
  Effect.gen(function* () {
    const sessions = yield* CoreSession.Service
    const arena = yield* Session
    const directory = yield* Directory
    const loop = Effect.fn("ArenaSessionPrompt.loop")(function* (input: { readonly sessionID: SessionSchema.ID }) {
      yield* sessions.resume(input.sessionID)
      yield* sessions.wait(input.sessionID)
      const transcript = yield* arena.messages({ sessionID: input.sessionID })
      return transcript.findLast((entry) => entry.info.role === "assistant")
    })
    return SessionPrompt.of({
      prompt: (input) =>
        normalizeError(
          Effect.gen(function* () {
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
            if (input.agent)
              yield* sessions.switchAgent({ sessionID: input.sessionID, agent: Agent.ID.make(input.agent) })
            if (input.model) {
              yield* sessions.switchModel({
                sessionID: input.sessionID,
                model: modelRef({
                  ...input.model,
                  ...(input.variant ? { variant: Model.VariantID.make(input.variant) } : {}),
                }),
              })
            }
            const admitted = yield* sessions.prompt({
              sessionID: input.sessionID,
              id: input.messageID ? currentMessageID(input.messageID) : undefined,
              text: promptText(input),
              files: [...(promptFiles(input.files) ?? []), ...(partFiles(input.parts) ?? [])],
              agents: input.agents,
              skills: input.skills,
              metadata,
              delivery: input.delivery,
              resume: input.noReply === true ? false : true,
            })
            if (input.noReply === true) return undefined
            // Core prompt admission is durable; waiting here ensures callers receive the terminal
            // assistant projection rather than a cached or fabricated transcript.
            void admitted
            return yield* loop({ sessionID: input.sessionID })
          }),
        ),
      loop: (input) => normalizeError(loop(input)),
      cancel: (sessionID) => normalizeError(sessions.interrupt(sessionID, { resume: false })),
      prepare: () => Effect.void,
    })
  }),
)

export const promptNode = makeGlobalNode({
  service: SessionPrompt,
  layer: promptLayer,
  deps: [CoreSession.node, sessionNode, directoryNode],
})

const statusLayer: Layer.Layer<SessionStatus, never, CoreSession.Service> = Layer.effect(
  SessionStatus,
  Effect.gen(function* () {
    const sessions = yield* CoreSession.Service
    return SessionStatus.of({
      get: (sessionID) =>
        normalizeError(
          Effect.gen(function* () {
            return { type: (yield* sessions.active).has(sessionID) ? "busy" : "idle" }
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
