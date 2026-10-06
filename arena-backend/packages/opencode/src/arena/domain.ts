/**
 * The Arena orchestration state machine is deliberately independent of Mongo,
 * Git, and OpenCode. Adapters persist these values and use this module to make
 * their compare-and-set transitions deterministic.
 */
export const Side = ["a", "b"] as const
export type Side = (typeof Side)[number]

export const BattleState = [
  "creating",
  "worktrees_ready",
  "running",
  "early_selected",
  "finalizing",
  "awaiting_vote",
  "applying",
  "canonicalizing",
  "cleanup_pending",
  "complete",
  "stopping",
  "awaiting_stop_resolution",
  "discarding",
  "discarded",
  "creation_failed",
  "finalization_failed",
  "application_failed",
  "canonicalization_failed",
  "interrupted_recovery",
] as const
export type BattleState = (typeof BattleState)[number]

export const Vote = ["a", "b", "tie"] as const
export type Vote = (typeof Vote)[number]

export const StopResolution = ["discard", "apply_a", "apply_b"] as const
export type StopResolution = (typeof StopResolution)[number]

export type VoteResolution = {
  readonly kind: "vote"
  readonly vote: Vote
  readonly appliedSide: Side
}

export type StoppedResolution = {
  readonly kind: "stopped"
  readonly resolution: StopResolution
  readonly appliedSide?: Side
}

export type EarlyResolution = {
  readonly kind: "early"
  readonly vote: Side
  readonly appliedSide: Side
}

export type AbortedResolution = {
  readonly kind: "aborted"
  readonly reason: string
}

export type Resolution = VoteResolution | StoppedResolution | EarlyResolution | AbortedResolution

const transitions: Readonly<Record<BattleState, ReadonlyArray<BattleState>>> = {
  creating: ["worktrees_ready", "creation_failed", "interrupted_recovery"],
  worktrees_ready: ["running", "creation_failed", "stopping", "interrupted_recovery"],
  running: ["early_selected", "finalizing", "stopping", "interrupted_recovery"],
  early_selected: ["applying", "application_failed", "finalization_failed", "interrupted_recovery"],
  finalizing: ["awaiting_vote", "finalization_failed", "interrupted_recovery"],
  awaiting_vote: ["running", "applying", "discarding"],
  applying: ["canonicalizing", "application_failed", "discarding"],
  canonicalizing: ["cleanup_pending", "complete", "canonicalization_failed"],
  cleanup_pending: ["complete"],
  complete: [],
  stopping: ["awaiting_stop_resolution", "finalization_failed", "interrupted_recovery"],
  awaiting_stop_resolution: ["discarding", "applying"],
  discarding: ["discarded"],
  discarded: [],
  creation_failed: ["creating", "discarding", "interrupted_recovery"],
  finalization_failed: ["finalizing", "stopping", "awaiting_stop_resolution", "discarding", "interrupted_recovery"],
  application_failed: ["applying"],
  canonicalization_failed: ["canonicalizing"],
  interrupted_recovery: ["awaiting_stop_resolution", "finalizing", "discarding"],
}

export function canTransition(from: BattleState, to: BattleState): boolean {
  return from === to || transitions[from].includes(to)
}

export function requireTransition(from: BattleState, to: BattleState): void {
  if (canTransition(from, to)) return
  throw new Error(`Arena battle cannot transition from ${from} to ${to}`)
}

export function voteResolution(vote: Vote): VoteResolution {
  return {
    kind: "vote",
    vote,
    // A tie deterministically applies A to Git/session state.
    appliedSide: vote === "tie" ? "a" : vote,
  }
}

export function stoppedResolution(resolution: StopResolution): StoppedResolution {
  return {
    kind: "stopped",
    resolution,
    ...(resolution === "apply_a" ? { appliedSide: "a" as const } : {}),
    ...(resolution === "apply_b" ? { appliedSide: "b" as const } : {}),
  }
}

export function earlyResolution(side: Side): EarlyResolution {
  return { kind: "early", vote: side, appliedSide: side }
}

export function abortedResolution(reason: string): AbortedResolution {
  return { kind: "aborted", reason }
}

export function isVoteReady(state: BattleState): boolean {
  return state === "awaiting_vote"
}

export function isFinalState(state: BattleState): boolean {
  return state === "complete" || state === "discarded"
}

/** Stable, delimiter-safe identifiers for unique turn and operation records. */
export function turnID(chatID: string, turnIndex: number): string {
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) {
    throw new Error("Arena turn index must be a non-negative safe integer")
  }
  return identifier("turn", chatID, String(turnIndex))
}

export function operationID(input: {
  readonly turnID: string
  readonly operation: string
  readonly side?: Side
  readonly attempt?: number
}): string {
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 0)) {
    throw new Error("Arena operation attempt must be a non-negative safe integer")
  }
  return identifier("operation", input.turnID, input.operation, input.side ?? "both", String(input.attempt ?? 0))
}

/**
 * The worktree directory and branch segment for one side of a generation.
 *
 * Generations are 0-based in the documents and on the wire, and the turn number a reader sees
 * counts from 1. The name follows the reader: `generation-1-a` belongs to the first battle.
 */
export function generationName(generation: number, side: Side): string {
  return `generation-${generation + 1}-${side}`
}

function identifier(kind: string, ...parts: ReadonlyArray<string>): string {
  return [kind, ...parts.map((part) => `${part.length}:${part}`)].join("|")
}

export * as ArenaDomain from "./domain"

/**
 * Is this turn a promotion parked on the user?
 *
 * These states qualify and they are parked for the same reason: `conflicted` left markers in the
 * checkout waiting to be resolved; `review` has not touched the checkout while it waits for
 * answers; `manual` and `blocked` stopped before writing and wait for a retry or a discard. Arena is writing in neither, which is what makes them the only battle states that
 * still accept an ordinary prompt on the canonical session — the prompt is how the user gets help
 * with the very thing Arena is parked on.
 *
 * Lives here because two guards need it and they sit in different layers: the HTTP mutation guard
 * reached through `runtime.ts`, and `beginNormalTurn` inside the service. They must agree, or one
 * refuses what the other allows and the refusal arrives as a bare `BadRequest`.
 */
export function isParkedPromotion(turn: {
  readonly state: BattleState
  readonly gitApplication?: { readonly state?: string }
}): boolean {
  if (turn.state !== "application_failed") return false
  const application = turn.gitApplication?.state
  return application === "conflicted" || application === "review" || application === "manual" || application === "blocked"
}

/**
 * Is a settled contestant's assistant error just the stop arriving?
 *
 * A stopped run ends mid-message and the provider reports that as `MessageAbortedError`. An early
 * pick cancels the loser and `Stop battle` cancels both, so on a stopped run that abort is the
 * thing the user asked for — recording it would put a raw provider error in front of someone who
 * just chose a winner. Any other error on a stopped run, and every error on a run that was not
 * stopped, is still worth reporting.
 */
export function isStopAbort(input: {
  readonly stopped: boolean
  readonly error?: { readonly name?: string }
}): boolean {
  return input.stopped && input.error?.name === "MessageAbortedError"
}
