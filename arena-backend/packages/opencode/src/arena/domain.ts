/**
 * The Arena orchestration state machine is deliberately independent of Mongo,
 * Git, and OpenCode. Adapters persist these values and use this module to make
 * their compare-and-set transitions deterministic.
 */
import { createHash } from "crypto"

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

/** Why the voter discarded a battle, when they said. The discard's confirmation offers these. */
export const DiscardReason = ["both_wrong", "changed_mind", "other"] as const
export type DiscardReason = (typeof DiscardReason)[number]

/**
 * Where a battle was when it was discarded: at the vote, after Stop, after the engine lost it, or
 * because its workspace was archived. The last two are not the voter's verdict on the results.
 */
export const DiscardStage = ["vote", "stop", "recovery", "archive"] as const
export type DiscardStage = (typeof DiscardStage)[number]

/** What `error` on a run starts with when its result could not be saved. */
export const RESULT_NOT_SAVED_MESSAGE = "Arena result finalization failed"

export type VoteResolution = {
  readonly kind: "vote"
  readonly vote: Vote
  readonly appliedSide: Side
}

export type StoppedResolution = {
  readonly kind: "stopped"
  readonly resolution: StopResolution
  readonly appliedSide?: Side
  /** False for a discard of a battle neither side showed anything in; see `identitiesRevealed`. */
  readonly revealed?: false
}

export type EarlyResolution = {
  readonly kind: "early"
  readonly vote: Side
  readonly appliedSide: Side
}

export type AbortedResolution = {
  readonly kind: "aborted"
  readonly reason: string
  /** False when the battle ended before either side could show anything; see `identitiesRevealed`. */
  readonly revealed?: false
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
  // `awaiting_vote` only reopens a battle an earlier engine parked here after a restart.
  awaiting_stop_resolution: ["discarding", "applying", "awaiting_vote"],
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

export function stoppedResolution(
  resolution: StopResolution,
  options?: { readonly revealed: false },
): StoppedResolution {
  return {
    kind: "stopped",
    resolution,
    ...(resolution === "apply_a" ? { appliedSide: "a" as const } : {}),
    ...(resolution === "apply_b" ? { appliedSide: "b" as const } : {}),
    ...(options ? { revealed: false as const } : {}),
  }
}

export function earlyResolution(side: Side): EarlyResolution {
  return { kind: "early", vote: side, appliedSide: side }
}

export function abortedResolution(reason: string, options?: { readonly revealed: false }): AbortedResolution {
  return { kind: "aborted", reason, ...(options ? { revealed: false as const } : {}) }
}

/**
 * Whether a resolved turn shows who the contestants were.
 *
 * A decision reveals once the voter has seen the sides' work. A battle that failed while it was
 * being created, or was discarded before either side showed anything, ends as blind as it began.
 */
export function identitiesRevealed(resolution: Resolution | undefined): boolean {
  if (resolution === undefined) return false
  return !((resolution.kind === "aborted" || resolution.kind === "stopped") && resolution.revealed === false)
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

/** The directory every slot of a chat's worktree pool sits in, under `.agent-duel/worktrees`. */
export function chatSlug(chatID: string): string {
  return createHash("sha256").update(chatID).digest("hex").slice(0, 16)
}

/**
 * The worktree directory of a spare slot, which a later turn renames to a generation's. `suffix` is
 * 8 random hex characters.
 */
export function spareName(suffix: string): string {
  return `spare-${suffix}`
}

/**
 * Every slot path under `.agent-duel/worktrees`, `<chatSlug>/<generationName or spareName>`, as a
 * regular expression source. The transcript rewrite matches slot names by it, so a slot path ends
 * where the name does and the `.` or `\n` written right after it survives.
 */
export const SLOT_PATH_PATTERN = String.raw`[0-9a-f]{16}/(?:generation-[1-9][0-9]*-[ab]|spare-[0-9a-f]{8})`

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
  return (
    application === "conflicted" || application === "review" || application === "manual" || application === "blocked"
  )
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

/**
 * Did a side's prompt fail on its own before a stop (or an early pick) took effect? Its side then
 * shows that failure, not "Stopped". A stream that dies while the stop tears it down ends after the
 * stop, and that side is stopped.
 */
export function failedBeforeHalt(input: {
  readonly failed: boolean
  readonly haltedAt?: Date
  readonly endedAt?: Date
}): boolean {
  return (
    input.failed &&
    input.haltedAt !== undefined &&
    input.endedAt !== undefined &&
    input.endedAt.getTime() < input.haltedAt.getTime()
  )
}

/**
 * How many times the voter may retry one failed contestant run. Each retry spends on the model
 * again, and a failure that keeps repeating is better answered by picking the other side or
 * sending the prompt again.
 */
export const MAX_MANUAL_RUN_RETRIES = 2

/** What the pane says under a contestant the engine's restart cut off. */
export const INTERRUPTED_RUN_MESSAGE = "Interrupted when Agent Duel closed"

/**
 * May the voter retry this failed run?
 *
 * Only while the battle is undecided, only for a retryable model failure or an empty compaction
 * summary (`errorRetryable`), and only once the failure is committed and the run still
 * has its worktree. The service refuses what this refuses, and the app shows Retry from it. A run
 * the engine's restart cut off is not retried on its own; the battle resumes (`canResumeBattle`).
 */
export function canRetryRun(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  run: {
    readonly runState: string
    readonly errorRetryable?: boolean
    readonly manualRetries?: number
    readonly finalizedAt?: Date
    readonly worktreeRemovedAt?: Date
  },
): boolean {
  return (
    (turn.state === "running" || turn.state === "awaiting_vote") &&
    turn.resolution === undefined &&
    run.runState === "error" &&
    run.errorRetryable === true &&
    (run.manualRetries ?? 0) < MAX_MANUAL_RUN_RETRIES &&
    run.finalizedAt !== undefined &&
    run.worktreeRemovedAt === undefined
  )
}

type ResumableRun = {
  readonly runState?: string
  readonly finalizedAt?: Date
  readonly worktreeRemovedAt?: Date
}

/**
 * May the voter resume a battle the engine's restart cut off?
 *
 * Every interrupted side resumes at once, under one claim, so neither gets a head start and the
 * voter cannot continue one side alone. It costs no retry: the models did nothing wrong. Until it
 * resumes, the battle can only be discarded: no vote, not even for a side that had finished, since
 * the voter never saw the other side finish. The service refuses what this refuses, and the app
 * shows Resume and Discard alone from it.
 */
export function canResumeBattle(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  runs: ReadonlyArray<ResumableRun>,
): boolean {
  const interrupted = runs.filter((run) => run.runState === "interrupted")
  return (
    turn.state === "awaiting_vote" &&
    turn.resolution === undefined &&
    interrupted.length > 0 &&
    interrupted.every((run) => run.finalizedAt !== undefined && run.worktreeRemovedAt === undefined)
  )
}

/**
 * Can a battle the engine's restart cut off go on where it stopped?
 *
 * The voter had not stopped it, and every side either settled before the restart or had its
 * environment ready, so a resumed contestant works in the same files it left. A battle that fails
 * this is recovered as a stopped one.
 */
export function canReopenInterruptedBattle(
  turn: { readonly state: BattleState; readonly transitionTimestamps?: Partial<Record<BattleState, Date>> },
  runs: ReadonlyArray<{
    readonly finalizedAt?: Date
    readonly environmentReadyAt?: Date
    readonly worktreeRemovedAt?: Date
  }>,
): boolean {
  return (
    (turn.state === "running" || turn.state === "finalizing" || turn.state === "interrupted_recovery") &&
    turn.transitionTimestamps?.stopping === undefined &&
    runs.length === 2 &&
    runs.every(
      (run) => run.finalizedAt !== undefined || (run.environmentReadyAt !== undefined && !run.worktreeRemovedAt),
    )
  )
}

type DecidedRun = { readonly side: Side; readonly selectable?: boolean } & ResumableRun

/**
 * May the voter call this battle a tie?
 *
 * A tie says the two results are as good as each other, so both have to be results the voter could
 * choose. It applies A whatever A is (`voteResolution`): over a failed run it would record a vote for
 * a failure and put that run's unfinished work in the checkout. The service refuses what this
 * refuses, and the app shows Tie from it.
 */
export function canTie(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  runs: ReadonlyArray<DecidedRun>,
): boolean {
  return (
    (turn.state === "awaiting_vote" || turn.state === "awaiting_stop_resolution") &&
    turn.resolution === undefined &&
    Side.every((side) => runs.some((run) => run.side === side && run.selectable === true))
  )
}

/**
 * May the voter discard this battle instead of applying either result?
 *
 * After a stop and at every vote, whatever the two results are, and when the engine's restart cut
 * the battle off (`canResumeBattle`). The service refuses what this refuses, and the app shows
 * Discard from it.
 */
export function canDiscardBattle(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  runs: ReadonlyArray<DecidedRun>,
): boolean {
  if (turn.resolution !== undefined) return false
  // `awaiting_vote` includes a battle `canResumeBattle` reopened.
  return turn.state === "awaiting_stop_resolution" || turn.state === "awaiting_vote"
}

/**
 * May the voter choose this side of a finished battle?
 *
 * Only a result that can be chosen, so a battle whose runs both failed is never voted on: Discard
 * and Retry are its only choices. A tie follows `canTie`, and a battle the engine's restart cut
 * off resumes before anything is chosen. The service refuses what this refuses, and the app shows
 * Choose from it.
 */
export function canVote(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  runs: ReadonlyArray<DecidedRun>,
  vote: Vote,
): boolean {
  if (vote === "tie") return canTie(turn, runs)
  return (
    turn.state === "awaiting_vote" &&
    turn.resolution === undefined &&
    !canResumeBattle(turn, runs) &&
    runs.some((run) => run.side === vote && run.selectable === true)
  )
}

type AcceptableRun = DecidedRun & {
  readonly error?: string
  readonly applicability?: string
  readonly finalCommit?: string
  readonly finalIndexTree?: string
}

/**
 * May the voter accept this failed side's work anyway?
 *
 * Only a side that ended in error with its result saved. A side whose setup failed can hold edits no
 * contestant made, and a side whose result could not be saved has at most an earlier attempt's
 * result, which would quietly lose the later work. A side still running comes back here through
 * Stop and Keep, and a side the engine's restart cut off resumes first. The service refuses what this
 * refuses, and the app shows Accept from it. The vote does not count (`voteDiscardedReason`).
 */
export function canAcceptFailed(
  turn: { readonly state: BattleState; readonly resolution?: unknown },
  runs: ReadonlyArray<AcceptableRun>,
  side: Side,
): boolean {
  if (turn.state !== "awaiting_vote" || turn.resolution !== undefined || canResumeBattle(turn, runs)) return false
  const run = runs.find((candidate) => candidate.side === side)
  return (
    run !== undefined &&
    run.runState === "error" &&
    run.finalizedAt !== undefined &&
    run.selectable !== true &&
    run.applicability === "applicable" &&
    !run.error?.startsWith(RESULT_NOT_SAVED_MESSAGE) &&
    Boolean(run.finalCommit && run.finalIndexTree)
  )
}

/**
 * The side this resolution applied, if that side had failed. Analysis needs it apart from
 * `voteDiscardedReason`, which also marks a vote for the finished side against a failed one. A side
 * kept after Stop that had already failed counts too.
 */
export function acceptedFailedSide(
  resolution: Resolution | undefined,
  runs: ReadonlyArray<{ readonly side: Side; readonly runState?: string }>,
): Side | undefined {
  if (resolution?.kind !== "vote" && resolution?.kind !== "stopped") return undefined
  const side = resolution.appliedSide
  return side && runs.some((run) => run.side === side && run.runState === "error") ? side : undefined
}

export const VoteDiscardedReason = ["contestant_failed"] as const
export type VoteDiscardedReason = (typeof VoteDiscardedReason)[number]

/**
 * Why this resolution's vote does not count, if it does not.
 *
 * A vote between a result and a failure says nothing about which model is better, so it still
 * applies the chosen side but is recorded as discarded. Analysis and the leaderboard drop it, and
 * the voter is told before choosing. A failed side is one that settled without a result that can
 * be chosen. An early pick needs the other side still working, so it never meets a failure.
 *
 * A side kept after Stop is marked the same way when the other side had already failed: metrics
 * would otherwise file it as a win. A run the stop cut off ends as stopped, so a failure there is
 * a run that ended in error before the stop.
 */
export function voteDiscardedReason(
  resolution: Resolution | undefined,
  runs: ReadonlyArray<DecidedRun>,
): VoteDiscardedReason | undefined {
  if (resolution?.kind === "stopped" && resolution.appliedSide) {
    const failed = runs.some((run) => run.finalizedAt !== undefined && run.runState === "error")
    return failed ? "contestant_failed" : undefined
  }
  if (resolution?.kind !== "vote") return undefined
  const failed = runs.some((run) => run.finalizedAt !== undefined && run.selectable !== true)
  return failed ? "contestant_failed" : undefined
}
