import * as Prompt from "@opencode/schema/prompt"
import { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { Tool } from "@opencode/schema/tool"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/schema/agent"
import { Provider } from "@opencode/schema/provider"
import { SessionID as WireSessionID } from "@opencode/schema/session-id"
import * as SessionV1 from "@opencode/schema/v1/session"
import { DateTime } from "effect"
import { BATTLE_RESUME_MESSAGE_PREFIX } from "../resume-note"
import type { ArenaPart, ArenaToolState, ArenaTranscriptEntry, ArenaTranscript } from "./schema"
import { ArenaResponseRecovery } from "../response-recovery"

type CanonicalMessage = SessionMessage.Info

export type CanonicalEntry = {
  readonly info: CanonicalMessage
}

const partID = (messageID: SessionMessage.ID, index: number) =>
  SessionV1.PartID.ascending(`prt_${messageID.slice(4)}_${index}`)

const attachmentPartID = (messageID: SessionMessage.ID, parentIndex: number, index: number) =>
  SessionV1.PartID.ascending(`prt_${messageID.slice(4)}_${parentIndex}_file_${index}`)

const wireSessionID = (value: Session.ID): SessionV1.SessionInfo["id"] => WireSessionID.make(String(value))
const wireMessageID = (value: SessionMessage.ID): SessionV1.MessageID => SessionV1.MessageID.make(String(value))

const textFromContent = (content: readonly Tool.Content[] | undefined) =>
  content
    ?.filter((item): item is Extract<Tool.Content, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("") ?? ""

/**
 * Core error classes for a request that may succeed when sent again. 1.x marked the same failures
 * retryable: 429, 408/409/5xx and the proxy's `server_error` stream marker (`provider.internal`),
 * dropped connections (`provider.transport`) and timeouts. Arena offers the voter Retry from this.
 */
const RETRYABLE_ERRORS = new Set(["provider.rate-limit", "provider.internal", "provider.transport", "provider.timeout"])

const retryableError = (value: NonNullable<SessionMessage.Assistant["error"]>) =>
  RETRYABLE_ERRORS.has(value.type) ||
  (value.status !== undefined &&
    (value.status === 408 || value.status === 409 || value.status === 429 || value.status >= 500))

/**
 * `retryable` adds what the stored error cannot say: Core keeps an incomplete stream as
 * `provider.invalid-output` without its classification, while malformed output shares that type.
 */
const projectError = (
  value: SessionMessage.Assistant["error"],
  retryable = false,
): NonNullable<SessionV1.Assistant["error"]> => {
  if (!value) return { name: "UnknownError", data: { message: "Unknown assistant error" } }
  if (value.type === "aborted") return { name: "MessageAbortedError", data: { message: value.message } }
  // This is a manual side retry, not an automatic retry of the failed summary request.
  if (value.type === "compaction.empty-summary")
    return { name: "APIError", data: { message: ArenaResponseRecovery.COMPACTION_EMPTY, isRetryable: true } }
  const isRetryable = retryable || retryableError(value)
  if (isRetryable || value.status !== undefined || value.response !== undefined)
    return {
      name: "APIError",
      data: {
        message: value.message,
        isRetryable,
        ...(value.status === undefined ? {} : { statusCode: value.status }),
        ...(value.response === undefined ? {} : { responseBody: value.response.body }),
      },
    }
  return { name: "UnknownError", data: { message: value.message } }
}

const state = (
  value: SessionMessage.AssistantTool["state"],
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  parentIndex: number,
  created: number,
  ran: number | undefined,
  completed: number | undefined,
): ArenaToolState => {
  if (value.status === "streaming") return { status: "pending", input: {}, raw: value.input }
  if (value.status === "running") {
    return {
      status: "running",
      input: value.input,
      ...(value.metadata ? { metadata: value.metadata } : {}),
      time: { start: ran ?? created },
    }
  }
  if (value.status === "completed") {
    const attachments = value.content
      .filter((item): item is Extract<Tool.Content, { type: "file" }> => item.type === "file")
      .map((item, index) => ({
        id: attachmentPartID(messageID, parentIndex, index),
        sessionID: wireSessionID(sessionID),
        messageID: wireMessageID(messageID),
        type: "file" as const,
        mime: item.mime,
        filename: item.name,
        url: item.uri,
      }))
    return {
      status: "completed",
      input: value.input,
      output: textFromContent(value.content),
      title: String(value.metadata?.title ?? ""),
      metadata: value.metadata ?? {},
      time: {
        start: ran ?? created,
        end: completed ?? ran ?? created,
      },
      ...(attachments.length ? { attachments } : {}),
    }
  }
  return {
    status: "error",
    input: value.input,
    error: value.error.message,
    ...(value.metadata ? { metadata: value.metadata } : {}),
    time: {
      start: ran ?? created,
      end: completed ?? ran ?? created,
    },
  }
}

const canonicalFile = (
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  file: Prompt.FileAttachment,
  index: number,
): SessionV1.FilePart => ({
  id: partID(messageID, index),
  sessionID: wireSessionID(sessionID),
  messageID: wireMessageID(messageID),
  type: "file",
  mime: file.mime,
  filename: file.name,
  url: `data:${file.mime};base64,${file.data}`,
})

const canonicalPart = (
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  value: SessionMessage.AssistantContent,
  index: number,
  created: number,
): ArenaPart => {
  const id = partID(messageID, index)
  if (value.type === "text") {
    const result: SessionV1.TextPart = {
      id,
      sessionID: wireSessionID(sessionID),
      messageID: wireMessageID(messageID),
      type: "text",
      text: value.text,
      ...(value.state ? { metadata: value.state } : {}),
    }
    return result
  }
  if (value.type === "reasoning") {
    const result: SessionV1.ReasoningPart = {
      id,
      sessionID: wireSessionID(sessionID),
      messageID: wireMessageID(messageID),
      type: "reasoning",
      text: value.text,
      ...(value.state ? { metadata: value.state } : {}),
      time: {
        start: value.time ? DateTime.toEpochMillis(value.time.created) : created,
        ...(value.time?.completed ? { end: DateTime.toEpochMillis(value.time.completed) } : {}),
      },
    }
    return result
  }
  const result: SessionV1.ToolPart = {
    id,
    sessionID: wireSessionID(sessionID),
    messageID: wireMessageID(messageID),
    type: "tool",
    callID: value.id,
    tool: value.name,
    state: state(
      value.state,
      sessionID,
      messageID,
      index,
      DateTime.toEpochMillis(value.time.created),
      value.time.ran ? DateTime.toEpochMillis(value.time.ran) : undefined,
      value.time.completed ? DateTime.toEpochMillis(value.time.completed) : undefined,
    ),
  }
  return result
}

/**
 * Metadata key for when the user sent a steer. Core stamps a delivered message with the delivery
 * time, which lags the send by up to a tool call and differs per side; Arena shows the send time,
 * as 1.x did, and `lastTurnStart` reads it to tell a steer from a new prompt.
 */
export const ARENA_SENT_AT = "arenaSentAt"

const sentAt = (message: SessionMessage.User | SessionMessage.Synthetic) => {
  const value = message.metadata?.[ARENA_SENT_AT]
  return typeof value === "number" && Number.isFinite(value) ? value : DateTime.toEpochMillis(message.time.created)
}

const userEntry = (
  sessionID: Session.ID,
  message: SessionMessage.User | SessionMessage.Synthetic,
  model: Model.Ref | undefined,
  agent: Agent.ID | undefined,
): ArenaTranscriptEntry => {
  const text = message.text
  const wireModel = model
    ? {
        providerID: model.providerID,
        modelID: model.id,
        ...(model.variant ? { variant: model.variant } : {}),
      }
    : { providerID: Provider.ID.make("arena"), modelID: Model.ID.make("unknown") }
  const info: SessionV1.User = {
    id: wireMessageID(message.id),
    sessionID: wireSessionID(sessionID),
    role: "user",
    time: { created: sentAt(message) },
    agent: agent ?? Agent.ID.make("build"),
    model: wireModel,
    ...(message.type === "user" &&
    message.metadata &&
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    "arenaSystem" in message.metadata &&
    typeof message.metadata.arenaSystem === "string"
      ? { system: message.metadata.arenaSystem }
      : {}),
  }
  const parts: ArenaPart[] = [
    {
      id: partID(message.id, 0),
      sessionID: wireSessionID(sessionID),
      messageID: wireMessageID(message.id),
      type: "text",
      text,
      ...(message.type === "synthetic" ? { synthetic: true } : {}),
    },
  ]
  if (message.type === "user" && message.files)
    parts.push(...message.files.map((file, index) => canonicalFile(info.sessionID, message.id, file, index + 1)))
  return { info, parts }
}

const assistantEntry = (
  message: SessionMessage.Assistant,
  sessionID: Session.ID,
  parentID: SessionMessage.ID | undefined,
): ArenaTranscriptEntry => ({
  info: {
    id: wireMessageID(message.id),
    sessionID: wireSessionID(sessionID),
    role: "assistant",
    parentID: wireMessageID(parentID ?? message.id),
    time: {
      created: DateTime.toEpochMillis(message.time.created),
      ...(message.time.completed ? { completed: DateTime.toEpochMillis(message.time.completed) } : {}),
    },
    ...(message.error ? { error: projectError(message.error) } : {}),
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: "build",
    agent: message.agent,
    path: { cwd: sessionID, root: sessionID },
    cost: message.cost ?? 0,
    tokens: {
      input: message.tokens?.input ?? 0,
      output: message.tokens?.output ?? 0,
      reasoning: message.tokens?.reasoning ?? 0,
      cache: {
        read: message.tokens?.cache.read ?? 0,
        write: message.tokens?.cache.write ?? 0,
      },
    },
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.model.variant ? { variant: message.model.variant } : {}),
  } satisfies SessionV1.Assistant,
  parts: message.content.map((item, index) =>
    canonicalPart(sessionID, message.id, item, index, DateTime.toEpochMillis(message.time.created)),
  ),
})

/**
 * The message an inbox item becomes once Core delivers it: same ID and content, so a queued steer
 * keeps its identity when it moves from the inbox into the transcript. Controls are not messages.
 */
export function pendingMessage(item: SessionInbox.Info): SessionMessage.User | SessionMessage.Synthetic | undefined {
  if (item.type === "user")
    return {
      id: item.id,
      type: "user",
      metadata: item.payload.metadata,
      text: item.payload.text,
      files: item.payload.files,
      agents: item.payload.agents,
      skills: item.payload.skills,
      time: item.time,
    }
  if (item.type === "synthetic")
    return {
      id: item.id,
      type: "synthetic",
      text: item.payload.text,
      description: item.payload.description,
      metadata: item.payload.metadata,
      time: item.time,
    }
  return undefined
}

/**
 * The answer a contestant run that failed settles with. Core 2.0 reports a failed drain as an error
 * from `resume`, and records that error on the step's assistant when the step got that far. 1.x
 * returned that assistant, and Arena decides from its error whether the voter may retry the run.
 * When no step recorded the failure, build an unsaved assistant from it: its ID matches no stored
 * row, so a retry that removes the failed answer removes nothing that holds work. `retryable`
 * carries a retry class that the failure itself knew and the stored error lost (an incomplete stream).
 */
export function failedAnswer(
  transcript: ArenaTranscript,
  error: SessionMessage.Assistant["error"],
  time: { readonly started: number; readonly now: number },
  retryable = false,
): ArenaTranscriptEntry | undefined {
  const now = time.now
  const failure = projectError(error, retryable)
  const last = transcript.at(-1)
  // Only the step that failed the run counts: an earlier answer that was stopped, or a step that
  // failed and was continued, also carries an error.
  if (
    last?.info.role === "assistant" &&
    last.info.error !== undefined &&
    JSON.stringify(last.info.error) === JSON.stringify(projectError(error)) &&
    (last.info.time.completed ?? 0) >= time.started
  )
    return { ...last, info: { ...last.info, error: failure } }
  const user = transcript.findLast(
    (entry): entry is ArenaTranscriptEntry & { readonly info: SessionV1.User } => entry.info.role === "user",
  )
  if (!user) return undefined
  const info: SessionV1.Assistant = {
    id: SessionV1.MessageID.ascending(),
    sessionID: user.info.sessionID,
    role: "assistant",
    parentID: user.info.id,
    time: { created: now, completed: now },
    error: failure,
    modelID: user.info.model.modelID,
    providerID: user.info.model.providerID,
    mode: "build",
    agent: user.info.agent,
    path: { cwd: user.info.sessionID, root: user.info.sessionID },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "error",
    ...(user.info.model.variant ? { variant: user.info.model.variant } : {}),
  }
  return { info, parts: [] }
}

/**
 * The note Core adds after a cut answer so the next step continues it
 * (`CONTINUE_AFTER_INCOMPLETE_STREAM` in `core/src/session/runner/llm.ts`, not exported there).
 */
export const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const continuationNote = (message: CanonicalMessage) =>
  message.type === "synthetic" &&
  [CONTINUE_AFTER_INCOMPLETE_STREAM, ArenaResponseRecovery.IDLE_RESTART, ArenaResponseRecovery.IDLE_CONTINUE].includes(
    message.text,
  )

/**
 * A half answer: an assistant whose model request failed (not a stop or steer) before any tool ran.
 * An assistant that ran a tool is not one, because the tool's work is in the worktree.
 */
const halfAnswer = (message: CanonicalMessage) =>
  message.type === "assistant" &&
  message.error !== undefined &&
  message.error.type !== "aborted" &&
  !message.content.some((item) => item.type === "tool" && item.time.ran !== undefined)

/**
 * What Retry removes from a failed run after `boundary` (the run's prompt message): each half answer
 * and the continuation note right after it. 2.0 continues a cut step, so a failed run holds one such
 * pair per attempt. Retry answers the prompt again, so none of them is part of the new answer.
 */
export function abandonedAttempts(messages: readonly CanonicalMessage[], boundary: string): ReadonlySet<string> {
  const dropped = new Set<string>()
  let afterHalf = false
  for (const message of messages) {
    if (String(message.id) <= boundary) continue
    if (halfAnswer(message)) {
      dropped.add(String(message.id))
      afterHalf = true
      continue
    }
    if (afterHalf && continuationNote(message)) dropped.add(String(message.id))
    if (message.type === "assistant" || message.type === "user" || message.type === "synthetic") afterHalf = false
  }
  return dropped
}

/**
 * The rows of a winner's session that the vote copies into the chat, from `boundary` (its prompt) on,
 * unchanged and in order. Half answers and Core's continuation notes stay, because they are what the
 * winner's model read. These rows stay out:
 * - The battle Resume reminder, identified by its reserved message ID prefix. It applies only to
 *   recovering the interrupted contestant, not to later chat turns. Other synthetic rows stay.
 * - `system` rows, which describe the temporary worktree and must never become chat policy. The
 *   canonical runner reads its own instructions after the graft.
 * - `idle` rows with an error, which record a failure from before a Retry. Core does not send `idle`
 *   rows to a model, and the run went on after this one.
 */
export function messagesToGraft(messages: readonly CanonicalMessage[], boundary: string): readonly CanonicalMessage[] {
  return messages.filter((message) => {
    if (message.type === "system") return false
    if (message.type === "synthetic" && message.id.startsWith(BATTLE_RESUME_MESSAGE_PREFIX)) return false
    if (message.type === "idle" && message.error !== undefined) return false
    return String(message.id) >= boundary
  })
}

/** Convert canonical V2 rows into the stable Arena `info + parts` transcript. */
export function project(
  messages: readonly CanonicalMessage[],
  sessionID?: Session.ID,
  defaultModel?: Model.Ref,
  defaultAgent?: Agent.ID,
): ArenaTranscript {
  const projected: ArenaTranscriptEntry[] = []
  let lastUser: SessionMessage.ID | undefined
  let model = defaultModel
  let agent = defaultAgent
  for (const message of messages) {
    if (message.type === "model-switched") {
      model = message.model
      continue
    }
    if (message.type === "agent-switched") {
      agent = message.agent
      continue
    }
    if (message.type === "user" || message.type === "synthetic") {
      const owner = sessionID ?? Session.ID.make(String(message.id))
      const entry = userEntry(owner, message, model, agent)
      const info = entry.info
      const parts = entry.parts
      projected.push({ info, parts })
      lastUser = message.id
      continue
    }
    if (message.type === "assistant") {
      projected.push(assistantEntry(message, sessionID ?? Session.ID.make(String(message.id)), lastUser))
    }
  }
  return projected
}

/** Convert the canonical V2 session record to the stable Arena V1 session shape. */
export function projectSession(info: import("@opencode/schema/session").Session.Info): SessionV1.SessionInfo {
  return {
    id: wireSessionID(info.id),
    slug: String(info.id),
    projectID: info.projectID,
    ...(info.parentID ? { parentID: wireSessionID(info.parentID) } : {}),
    directory: info.location.directory,
    ...(info.location.workspaceID ? { workspaceID: info.location.workspaceID } : {}),
    ...(info.subpath ? { path: info.subpath } : {}),
    ...(info.title ? { title: info.title } : {}),
    ...(info.agent ? { agent: info.agent } : {}),
    ...(info.model
      ? {
          model: {
            id: info.model.id,
            providerID: info.model.providerID,
            ...(info.model.variant ? { variant: info.model.variant } : {}),
          },
        }
      : {}),
    version: "2.0.32",
    ...(info.metadata ? { metadata: info.metadata } : {}),
    ...(info.permissions
      ? {
          permission: info.permissions.map((rule) => ({
            permission: rule.action,
            pattern: rule.resource,
            action: rule.effect,
          })),
        }
      : {}),
    cost: info.cost,
    tokens: info.tokens,
    time: {
      created: DateTime.toEpochMillis(info.time.created),
      updated: DateTime.toEpochMillis(info.time.updated),
      ...(info.time.archived ? { archived: DateTime.toEpochMillis(info.time.archived) } : {}),
    },
  } satisfies SessionV1.SessionInfo
}

export function projectPart(entry: ArenaTranscriptEntry, index: number) {
  return entry.parts[index]
}

export { partID }
