import * as Prompt from "@opencode/schema/prompt"
import { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Tool } from "@opencode/schema/tool"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/schema/agent"
import { Provider } from "@opencode/schema/provider"
import { SessionID as WireSessionID } from "@opencode/schema/session-id"
import * as SessionV1 from "@opencode/schema/v1/session"
import { DateTime } from "effect"
import type { ArenaPart, ArenaToolState, ArenaTranscriptEntry, ArenaTranscript } from "./schema"

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

const projectError = (value: SessionMessage.Assistant["error"]): NonNullable<SessionV1.Assistant["error"]> => {
  if (!value) return { name: "UnknownError", data: { message: "Unknown assistant error" } }
  if (value.type === "aborted") return { name: "MessageAbortedError", data: { message: value.message } }
  if (value.status !== undefined || value.response !== undefined)
    return {
      name: "APIError",
      data: {
        message: value.message,
        isRetryable: false,
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
    time: { created: DateTime.toEpochMillis(message.time.created) },
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
