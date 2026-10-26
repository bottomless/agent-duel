import type { Model } from "@opencode/schema/model"
import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import * as Prompt from "@opencode/schema/prompt"
import * as PromptInput from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type * as SessionV1 from "@opencode/schema/v1/session"

/**
 * Arena's transcript is deliberately smaller than the OpenCode message schema.  It is a
 * transport projection, not a second store: the runtime always reads and writes the canonical
 * SessionMessage rows and derives these values at the boundary.
 */
export type ArenaModel = {
  readonly providerID: Model.Ref["providerID"]
  readonly modelID: Model.ID
  readonly variant?: string
}

export type ArenaTokens = {
  readonly total?: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type ArenaToolState = SessionV1.ToolState
export type ArenaPart = SessionV1.Part
export type ArenaMessageInfo = SessionV1.Info

export type ArenaTranscriptEntry = {
  readonly info: ArenaMessageInfo
  readonly parts: readonly ArenaPart[]
}

export type ArenaTranscript = readonly ArenaTranscriptEntry[]
export type ArenaSessionInfo = SessionV1.SessionInfo
export type ArenaPromptPart =
  | SessionV1.TextPartInput
  | SessionV1.FilePartInput
  | SessionV1.AgentPartInput
  | SessionV1.SubtaskPartInput

// Names retained at the Arena boundary so callers can migrate independently of Core's current
// message names.  They are aliases to the projection above, never a persistence model.
export type Info = ArenaMessageInfo
export type Part = ArenaPart
export type WithParts = ArenaTranscriptEntry
export type MessageID = SessionV1.MessageID
export type PartID = SessionV1.PartID
export type SessionID = SessionV1.SessionInfo["id"]

export type SessionCreateInput = {
  readonly id?: Session.ID
  readonly parentID?: Session.ID
  readonly title?: string
  readonly agent?: string
  readonly model?: ArenaModel
  readonly metadata?: Session.Metadata
  readonly permissions?: PermissionSchema.Ruleset
  readonly location?: { readonly directory: string; readonly workspaceID?: string }
}

export type ArenaPromptInput = {
  readonly sessionID: Session.ID
  readonly text?: string
  readonly model?: ArenaModel
  readonly agent?: string
  readonly variant?: string
  readonly system?: string
  readonly parts?: readonly ArenaPromptPart[]
  readonly files?: readonly (Prompt.FileAttachment | PromptInput.FileAttachment)[]
  readonly agents?: PromptInput.Prompt["agents"]
  readonly skills?: PromptInput.Prompt["skills"]
  readonly metadata?: Record<string, unknown>
  readonly delivery?: "steer" | "queue"
  readonly messageID?: SessionV1.MessageID
  readonly noReply?: boolean
}

export type ArenaStatus = { readonly type: "idle" | "busy" }

export type ArenaPermissionReply = {
  readonly requestID: string
  readonly reply: "once" | "always" | "reject"
  readonly message?: string
}

/**
 * Stable Arena question wire shape. OpenCode 2's native Form.Info is keyed by
 * field names and answer values; Arena clients still consume the V1 question
 * request made of prompts and labelled options. The runtime converts between
 * these representations at the service boundary.
 */
export type ArenaQuestionOption = {
  readonly label: string
  readonly description: string
}

export type ArenaQuestion = {
  readonly question: string
  readonly header: string
  readonly options: readonly ArenaQuestionOption[]
  readonly multiple?: boolean
  readonly custom?: boolean
}

export type ArenaQuestionRequest = {
  readonly id: string
  readonly sessionID: string
  readonly questions: readonly ArenaQuestion[]
  readonly tool?: {
    readonly messageID: string
    readonly callID: string
  }
}
