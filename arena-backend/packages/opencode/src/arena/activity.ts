import { Schema } from "effect"
import type { ChatDocument, RunDocument, TurnDocument } from "./records"
import { BattleState } from "./domain"

export const Run = Schema.Struct({
  id: Schema.String,
  side: Schema.Literals(["a", "b"]),
  runState: Schema.Literals(["pending", "complete", "stopped", "error", "interrupted"]),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  needsInput: Schema.Boolean,
  diff: Schema.optional(Schema.Struct({ files: Schema.Int, additions: Schema.Int, deletions: Schema.Int })),
})
export const Session = Schema.Struct({
  sessionID: Schema.String,
  chatID: Schema.String,
  turnID: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(BattleState)),
  resolved: Schema.Boolean,
  requiresDecision: Schema.Boolean,
  runs: Schema.Array(Run),
  comparisonState: Schema.optional(Schema.Literals(["pending", "running", "complete", "skipped", "failed"])),
  summary: Schema.optional(Schema.String),
  /**
   * What this chat changed on its own, across applied battles and later normal turns.
   *
   * A workspace's diff stat is its whole checkout's, and chats that run without a worktree share
   * one checkout, so the same number reaches every one of them. This is the chat's alone. Absent
   * until a turn has been applied, and absent when the diff could not be read.
   */
  chatDiff: Schema.optional(Schema.Struct({ files: Schema.Int, additions: Schema.Int, deletions: Schema.Int })),
})
export type ChatRecord = Pick<ChatDocument, "_id" | "canonicalSessionID" | "activeTurnID" | "status" | "repository">
export type TurnRecord = Pick<TurnDocument, "_id" | "chatID" | "sourceCanonicalSessionID" | "state" | "resolution" | "selectableSides" | "turnIndex" | "comparisonID" | "comparisonState">
export type RunRecord = Pick<RunDocument, "_id" | "turnID" | "side" | "rootSessionID" | "descendantSessionIDs" | "worktree" | "runState" | "startedAt" | "completedAt" | "diff">
export interface Record {
  sessionID: string
  chat: ChatRecord
  turn: TurnRecord | null
  summary?: string
  /** The tree the chat's first battle froze, and its latest applied battle or normal turn result. */
  contribution?: { base: string; result: string }
  runs: RunRecord[]
}

export function project(
  record: Record,
  inputRunIDs: ReadonlySet<string>,
  chatDiff?: { files: number; additions: number; deletions: number },
): typeof Session.Type {
  const turn = record.turn
  const resolved = turn?.resolution !== undefined
  // Omit missing fields: the HTTP JSON codec encodes explicit undefined as null.
  return {
    sessionID: record.sessionID,
    chatID: record.chat._id,
    turnID: turn?._id,
    state: turn?.state,
    resolved,
    ...(turn?.comparisonState ? { comparisonState: turn.comparisonState } : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(chatDiff ? { chatDiff } : {}),
    requiresDecision: !resolved && turn?.state === "awaiting_vote" && record.runs.length === 2 && record.runs.every((run) => run.runState !== "pending"),
    runs: record.runs.map((run) => ({
      id: run._id,
      side: run.side,
      runState: run.runState,
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      needsInput: inputRunIDs.has(run._id),
      ...(run.diff ? { diff: run.diff } : {}),
    })),
  }
}
export * as ArenaActivity from "./activity"
