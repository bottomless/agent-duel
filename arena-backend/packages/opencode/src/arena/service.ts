import { ArenaActivity } from "./activity"
import { Stream } from "effect"
import { createArenaStream, type Frame as ArenaStreamFrame } from "./stream"
import { execFile as nodeExecFile } from "child_process"
import { createHash, randomBytes } from "crypto"
import { realpathSync, type BigIntStats } from "fs"
import { lstat, mkdir, readdir, readFile, readlink, realpath } from "fs/promises"
import { basename, dirname, join, relative as relativePath, resolve as resolvePath } from "path"
import { promisify } from "util"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { clearToolExecutionEnvironment, gateToolExecution, isToolExecutionGated } from "@/session/tool-execution-gate"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { hostRepoPath, isolatedRoot, Worktree } from "@/worktree"
import { TRASH_DIRNAME } from "@/util/discard-tree"
import { LOCAL_STATE_DIRNAME, PRIVATE_REF_PREFIXES } from "@/worktree/layout"
import { generate as generateComparison } from "./comparison"
import {
  canonicalizeArenaEnvironment,
  canonicalizeTranscriptPaths,
  localizeArenaEnvironment,
} from "./canonical-path"
import { comparisonTimeline } from "./comparison-timeline"
import { contestantPermissions } from "./contestant"
import { createBattleAssignments, createSingleAssignment, resolveAssignments } from "./assignment-client"
import type { BattleAssignmentDecision } from "@agent-duel/arena-service/assignment-decision"
import { ArenaAttachments } from "./attachments"
import { forkSessionInto, type ArenaFork } from "./fork"
import {
  earlyResolution,
  generationName,
  isFinalState,
  isParkedPromotion,
  isStopAbort,
  operationID,
  stoppedResolution,
  turnID as makeTurnID,
  voteResolution,
  type Resolution,
  type Side,
  type StopResolution,
  type Vote,
} from "./domain"
import {
  acceptWinnerConflicts,
  battleRefs,
  compare,
  containsCommit,
  diffHostRefs,
  finalize,
  finishWinnerPromotion,
  importResultRef,
  importWinnerRef,
  inspectCanonical,
  readCanonicalBranch,
  mirrorCanonicalRefs,
  OperationError,
  inspectBranchTarget,
  observeWinnerRefs,
  refLabel,
  reportCheckoutMove,
  type CheckoutMove,
  type ObservedRef,
  type PublicChoice,
  promoteWinnerState,
  refBackupName,
  repositoryOperation,
  holdWinnerRefs,
  editsFingerprint,
  type RefWrite,
  PublicEditsAtRiskError,
  recoverFailedPromotion,
  removeRef,
  repositoryKey,
  selectResult,
  snapshotBase,
  snapshotHostRefs,
  syncContestantState,
  TRUNK_CONFLICT_OPERATION,
  unresolvedConflictPaths,
  verifyContestantState,
  type FinalizedResult,
  type RefChange,
  type SnapshotBase,
  STAT_TRACKED,
} from "./git"
import { finalizedFile, finalizedTree, liveFile, liveTree } from "./inspection"
import type { RefOutcome } from "./ref-types"
import {
  answerFor,
  decideRef,
  mergeAnswers,
  resolveRef,
  type BranchAction,
  type PlannedRef,
  type ReviewAnswer,
  type ReviewItem,
} from "./branch-review"
import { contestant, highReasoning } from "./model-profile"
import { ArenaMetrics } from "./metrics"
import { jsonValue, parseSnapshot, project } from "./public"
import { ArenaSchema } from "./schema"
import { ArenaPrivacy } from "./privacy"
import { resolveBuildCommit } from "./provenance"
import { ArenaTranscriptArtifact } from "./transcript-artifact"
import type {
  ApplyBaseChoice,
  ChatDocument,
  CapturedService,
  CopyOmission,
  HiddenAssignment,
  ReviewEventDocument,
  ReviewEventInput,
  ReviewIngestResult,
  RunDocument,
  PartialApply,
  SessionArchiveDocument,
  SingleAgentVote,
  TurnDocument,
  SlotSyncTimings,
  TurnSetupTimings,
  WarmPreparation,
  WarmWorktreeRecord,
} from "./records"
import { battleMetricsSchemaVersion, reviewFlushLimit } from "./records"
import { enabled, recoverOnce, registry, setTelemetry, store as runtimeStore } from "./runtime"
import { waitForInitialDispatch } from "./dispatch"
import { create as createTelemetry } from "./telemetry"
import { Recorder } from "./events"
import {
  createArenaOperationTracker,
  mergeOperationProgress,
  type ArenaActiveOperation,
  type ArenaOperationProgress,
} from "./operation-tracker"
import {
  allocatePreview,
  endOwnership,
  environment as previewEnvironment,
  hostnameForAlias as previewHostnameForAlias,
  observe as observePreview,
  PORT_ALIASES,
  anyListening,
  releaseTakenBank,
  route as previewRoute,
  url as previewUrl,
  type PreviewRoute,
} from "./preview"
import {
  applyIgnoredResync,
  createIgnoredContentSnapshot,
  fingerprintCopiedContent,
  listIgnoredRoots,
  matchesIgnoredContentSnapshot,
  planIgnoredResync,
  type CopyManifest,
  type CopyManifestEntry,
  type RootObservation,
  type SlotRootRecord,
} from "./copy-snapshot"
import { assignProxyRoutes, captureOwnedServices, persistedProxyRoutes, stopOwnedServices } from "./services"
import { buildEnvironmentTransition } from "./transition"
import { createIgnoredJournal, createSlotWatch, watcherBackendUnavailable, type JournalMark } from "./environment-watch"
import type { Store } from "./mongo"

const encoder = new TextEncoder()
const contestantWorktreeInstruction =
  "Git is prepared at the frozen base in an isolated worktree on $PASEO_CURRENT_BRANCH. Work in $(pwd). Branch changes in this worktree are part of your result. Do not modify $PASEO_TRUNK_DIR. Use $PASEO_TRUNK_BRANCH only to identify the canonical branch. Port aliases belong only to this contestant environment. Literal ports, preview URLs, log paths, and process IDs in earlier messages or tool output are historical; do not reuse them, connect to them, or stop anything using them. Read the current port aliases and preview URLs from the environment. Run the project the way its developers run it, so the whole project works from the preview URL. For browser-facing services, bind to HOST=127.0.0.1 and use PORT/PASEO_PORT for the primary listener or PASEO_PORT2/PASEO_PORT3 for additional listeners. Start long-running services so they remain alive after the shell tool returns, then verify the assigned port is listening before reporting the matching public URL: ARENA_PREVIEW_URL for PASEO_PORT, ARENA_PREVIEW_URL2 for PASEO_PORT2, or ARENA_PREVIEW_URL3 for PASEO_PORT3."
const canonicalUnavailableReason = "The trunk worktree is unavailable. Restore it at its recorded location, then retry."

// The refusal reaches the user as a toast, so a merge that conflicted in hundreds of files must
// not produce a multi-kilobyte message. The chat's stored trunkConflicts list stays complete.
const MAX_LISTED_CONFLICTS = 5

export function trunkConflictList(files: readonly string[]) {
  if (files.length <= MAX_LISTED_CONFLICTS) return files.join(", ")
  return `${files.slice(0, MAX_LISTED_CONFLICTS).join(", ")}, and ${files.length - MAX_LISTED_CONFLICTS} more`
}

export function trunkConflictReason(files: readonly string[]) {
  return `Unresolved merge conflicts: ${trunkConflictList(files)}. Resolve them, or turn Battle off and ask one agent to resolve them.`
}

/**
 * Another git process holds `index.lock` — very often the agent Arena itself asked to resolve the
 * conflicts, part way through its `git add`. That is git present and busy, the opposite of the
 * "trunk worktree is unavailable" the checkout inspection would otherwise conclude, and blocking a
 * chat on it puts an alarm in front of the user for a lock that is gone milliseconds later.
 *
 * The block does clear itself on the next successful inspection, so this was never permanent — it
 * was a scary sentence arriving in the middle of work that had in fact succeeded.
 */
export function isGitLockContention(detail: string): boolean {
  return detail.includes("index.lock") || detail.includes("Another git process")
}

/**
 * Why a promotion stopped before touching the checkout. The UI writes its own copy from the
 * items; this is what a CLI reader, a log, and a stale client see.
 */
function reviewReason(items: readonly ReviewItem[]): string {
  const busy = items.find((item) => item.kind === "busy")
  if (busy) return `The workspace is part way through a ${busy.operation}. Finish or abort it, then check again.`
  const count = items.length
  return `The winning result needs ${count} decision${count === 1 ? "" : "s"} before Arena applies it.`
}

/**
 * The unmerged paths behind a snapshotBase refusal, or undefined for any other failure.
 * A conflicted trunk refuses one battle; everything else still blocks the chat.
 */
export function trunkConflictPaths(failure: unknown) {
  if (!(failure instanceof OperationError) || failure.operation !== TRUNK_CONFLICT_OPERATION) return undefined
  return failure.paths ?? []
}

function sameConflicts(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

/**
 * The previous winner's transition is recorded for the report in the UI and never reaches a
 * contestant: nothing about the environment is part of a prompt, and keeping it out is what lets
 * the send prompt without waiting for the release.
 */
function contestantSystemInstruction(worktree?: string, environmentPending = false) {
  const env = worktree ? previewEnvironment(worktree) : {}
  const previewUrls = PORT_ALIASES.flatMap((alias) => {
    const suffix = alias === "PASEO_PORT" ? "" : alias.slice("PASEO_PORT".length)
    const name = `ARENA_PREVIEW_URL${suffix}`
    return env[name] ? [`${name}=${env[name]}`] : []
  })
  const currentPreview = previewUrls.length
    ? `Current public preview URLs:\n${previewUrls.join("\n")}\nIn your final response, report the expanded http(s) URL, never the variable name.`
    : ""
  const pendingEnvironment =
    environmentPending && worktree
      ? `The initial model call is running while the environment is still being prepared at ${worktree}. This is your worktree path. You may reason immediately. Tools that do not need the filesystem can run before the base checkout is ready. Once it is ready, safe reads can run while ignored content finishes copying. A tool that could observe or change incomplete state will wait until its required setup phase completes.`
      : ""
  return [contestantWorktreeInstruction, pendingEnvironment, currentPreview].filter(Boolean).join("\n\n")
}
function error(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

/** An apply that wrote part of the winner into the checkout and could not take it back out. */
class PartialApplyError extends Error {
  readonly partial: PartialApply
  constructor(refused: unknown, undo: unknown, partial: PartialApply) {
    super(
      `Arena applied part of the winning changes, then could not write the other branches (${error(refused).message}) or undo the part already applied (${error(undo).message}).`,
    )
    this.partial = partial
  }
}

function promise<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: error })
}

function bestEffort<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.map((value) => ({ available: true as const, value })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({ available: false as const, value: undefined }),
    ),
  )
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function chatID(sessionID: string) {
  return `chat|${sessionID.length}:${sessionID}`
}

function participantID(value?: string) {
  if (value === undefined) return
  const normalized = value.trim()
  if (!normalized || Buffer.byteLength(normalized) > 256) {
    throw new Error("Arena participant ID must contain at most 256 bytes")
  }
  return normalized
}

function accountID(value?: string) {
  if (value === undefined) return
  const normalized = value.trim()
  if (!normalized) return
  if (Buffer.byteLength(normalized) > 256) throw new Error("Arena account ID must contain at most 256 bytes")
  return normalized
}

/** What a single-agent turn runs with: the Arena model, and a note about a winner not yet applied. */
export type NormalTurnStart = {
  readonly model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  /** Sent as a synthetic part of the user's message: the model reads it, the chat does not show it. */
  readonly note?: string
}

/**
 * The winner's transcript joins the chat at the vote, before its result reaches the checkout. While
 * the result waits -- on a review, or stopped -- an agent reading that transcript takes the
 * battle's changes as done and calls the real repository rewritten. This tells it otherwise.
 */
export function unappliedWinnerNote(turn: Pick<TurnDocument, "gitApplication">): string | undefined {
  const application = turn.gitApplication
  if (application?.state !== "review" && application?.state !== "manual" && application?.state !== "blocked") {
    return undefined
  }
  const waiting =
    application.state === "review"
      ? "It waits for the user to answer a question about it in the app."
      : "Arena could not apply it."
  return [
    `<arena-note>The winning agent's result from the last battle has not been applied to this workspace yet. ${waiting}`,
    "The earlier messages describe the winner's own copy of the repository. This workspace, its branches, and its files are still as the user had them, so do not treat a difference from those messages as something that went wrong.",
    "Check the real state with git before you act. The user decides in the app whether to apply it, so do not redo the winner's changes unless the user asks. Do not mention this note.</arena-note>",
  ].join(" ")
}

/** Why the card shows a ref the winner changed as kept. */
function keptReason(ref: ObservedRef, agentVersion: string): string {
  const label = refLabel(ref.ref)
  if (ref.agentMove === "deleted") return `${label} was kept, although the winning agent deleted it.`
  if (ref.rewound) {
    const where = ref.agentSubject ? ` to “${ref.agentSubject}”` : ""
    return `The winning agent moved ${label} back${where} and added nothing to it, so your ${label} was kept.`
  }
  return `Your ${label} was kept. The winning agent's version is at ${agentVersion}.`
}

function refRoot(turn: Pick<TurnDocument, "chatID" | "turnIndex">) {
  return battleRefs(chatSlug(turn.chatID), turn.turnIndex).base.replace(/\/base$/, "")
}

function singleAgentResultRef(chatID: string, ratingID: string) {
  return `refs/battles/${chatSlug(chatID)}/single-agent/${createHash("sha256").update(ratingID).digest("hex")}`
}

function chatSlug(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

function contestantWorktreeName(id: string, generation: number, side: Side) {
  return `${chatSlug(id)}/${generationName(generation, side)}`
}

function appliedConflicts(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || !("conflicts" in value)) return []
  const conflicts = value.conflicts
  if (!Array.isArray(conflicts)) return []
  return conflicts.filter((item): item is string => typeof item === "string")
}

const parkedConflictReason =
  "The winning changes were applied and some files carry merge conflicts. Resolve them, then retry to finish applying the winner."

function copyOmissions(entries: readonly CopyManifestEntry[]): CopyOmission[] {
  return entries.flatMap((entry) => {
    if (entry.state !== "omitted" || !entry.omissionReason) return []
    return [
      {
        relativePath: entry.relativePath,
        fileType: entry.type,
        logicalBytes: entry.logicalBytes,
        sourceIdentity: JSON.stringify(entry.sourceIdentity ?? {}),
        omissionReason: entry.omissionReason,
      },
    ]
  })
}

function previewRoutes(preview: PreviewRoute) {
  return PORT_ALIASES.map((alias) => {
    const port = preview.portAliases[alias]
    const hostname = previewHostnameForAlias(preview.hostname, alias)
    const url = previewUrl({ hostname, port, portAliases: preview.portAliases })
    return {
      hostname,
      port,
      alias,
      active: preview.state === "active" && preview.ownership === "owned",
      ...(url ? { url } : {}),
    }
  })
}

function previewEnvironmentService(preview: PreviewRoute, at: Date): CapturedService {
  return {
    kind: "environment",
    command: "Arena preview environment",
    args: [],
    env: Object.fromEntries(PORT_ALIASES.map((alias) => [alias, String(preview.portAliases[alias])])),
    relativeCwd: ".",
    listeners: PORT_ALIASES.map((alias) => ({
      port: preview.portAliases[alias],
      alias,
      verifiedAt: at,
    })),
    proxyRoutes: previewRoutes(preview),
    capturedAt: at,
    verifiedAt: at,
  }
}

async function arenaCopyConfiguration(root: string): Promise<unknown> {
  const file = Bun.file(join(root, "paseo.json"))
  if (!(await file.exists())) return undefined
  return await file.json()
}

function assignment(value: { readonly assignmentID: string }): HiddenAssignment {
  return {
    assignmentID: value.assignmentID,
    requestedReasoning: highReasoning.reasoning,
    enforcedReasoning: highReasoning.reasoning,
  }
}

function assignmentDecision(resolution: ReturnType<typeof voteResolution> | ReturnType<typeof stoppedResolution> | ReturnType<typeof earlyResolution>): BattleAssignmentDecision {
  if (resolution.kind === "vote") return resolution.vote === "tie" ? "tie" : `select:${resolution.vote}`
  if (resolution.kind === "early") return `select:${resolution.vote}`
  if (resolution.appliedSide) return `select:${resolution.appliedSide}`
  return "discard"
}

async function resolvedPlacement(turn: TurnDocument, decision: BattleAssignmentDecision) {
  const resolved = await resolveAssignments("battle", turn._id, decision)
  const models = new Map(resolved.assignments.map((value) => [value.assignmentID, value.model]))
  const a = models.get(turn.placement.a.assignmentID)
  const b = models.get(turn.placement.b.assignmentID)
  if (!a || !b) throw new Error("Arena reveal did not match the battle assignments")
  return {
    decision: resolved.decision,
    models: { a, b },
    metrics: resolved.assignments.flatMap((assignment) => assignment.metrics),
  }
}

async function modelsForDecision(turn: TurnDocument, decision: BattleAssignmentDecision) {
  const resolved = await resolvedPlacement(turn, decision)
  if (resolved.decision !== decision) {
    throw new Error(`Arena battle was already resolved as ${resolved.decision}`)
  }
  return resolved
}

function selectedSide(decision: BattleAssignmentDecision): Side | undefined {
  if (decision === "select:a") return "a"
  if (decision === "select:b") return "b"
  return undefined
}

function committedResolution(
  requested: Exclude<Resolution, { readonly kind: "aborted" }>,
  decision: BattleAssignmentDecision,
): Exclude<Resolution, { readonly kind: "aborted" }> {
  const side = selectedSide(decision)
  if (requested.kind === "vote") {
    if (side) return voteResolution(side)
    if (decision === "tie") return voteResolution("tie")
  }
  if (requested.kind === "early" && side) return earlyResolution(side)
  if (requested.kind === "stopped") {
    if (side) return stoppedResolution(side === "a" ? "apply_a" : "apply_b")
    if (decision === "discard") return stoppedResolution("discard")
  }
  throw new Error(`Arena battle was already resolved as ${decision}`)
}

/** The frozen starting point a contestant worktree is synced to. */
type ContestantBase = {
  readonly frozenHead: string
  readonly indexTree: string
  readonly workingTree: string
}

/** `wait` deletes a chat's trash before returning instead of in the background. */
type SlotTrashOptions = { readonly wait?: boolean }

/** A kept worktree's last sync, as this process saw it. */
type SlotState = {
  /** Its copied ignored roots as they stood right after their clone, for the next resync to keep. */
  readonly ignored: ReadonlyMap<string, SlotRootRecord>
  /** Per copied directory root, the journal position taken before that root was cloned. */
  readonly marks: ReadonlyMap<string, JournalMark>
  /** The base it was synced to and the checkout rules then, to tell when files must be rewritten. */
  readonly synced?: ContestantBase & { readonly rules: string }
  /** Each tracked file as that sync left it, from `trackedFiles`; what the next sync may leave alone. */
  readonly files?: ReadonlySet<bigint>
  /**
   * When the last process that could write into it was stopped. Absent while one may still be
   * running, as the instance a warm worktree's contestant was prepared with.
   */
  readonly stoppedAt?: number
  readonly syncedAt?: number
  /** The checkout's git metadata at the moment its host was copied. */
  readonly metadataFingerprint?: string
}

/**
 * Config that decides how a blob becomes bytes on disk. A kept index skips every file whose stat
 * data still matches, so a change here reaches a kept worktree only by rewriting every file.
 */
const CHECKOUT_CONFIG =
  "^(core\\.(autocrlf|eol|safecrlf|symlinks|filemode|ignorecase|precomposeunicode|checkroundtripencoding|attributesfile)|filter\\..*|working-tree-encoding)$"

/**
 * A watch reports a write 50-500 ms after it happens, so a worktree's watch is settled no sooner
 * than this after the last process that could write into it was stopped.
 */
const SLOT_WATCH_SETTLE_MS = 700

/** How long a process found in a chat's worktree directory gets to exit before the listing is taken again. */
const SLOT_PROCESS_RELIST_MS = 500

/** The next pair plus the retained winner, which keeps its worktree until the next send. */
const SLOT_POOL_TARGET = 3

/**
 * Where a generation's warm record is kept: on the turn before it, or, for generation 0, which
 * has no turn before it, on the chat.
 */
type WarmOwner =
  | { readonly kind: "turn"; readonly turn: TurnDocument }
  | { readonly kind: "chat"; readonly chatID: string }

/**
 * How long a chat stays open without a send before its first pair is prepared. The draft
 * composer opens a chat and starts its battle in the same breath; a warm-up that took the start
 * lock first would make that send wait for a whole pair instead of building its own.
 */
const INITIAL_WARM_DELAY_MS = 1_000

/**
 * After a chat's first pair fails, how long before opening the chat tries again, doubling with
 * each failure in a row up to the cap. A checkout that fails every time would otherwise be built
 * and torn down again each time its panel is shown.
 */
const INITIAL_WARM_RETRY_MS = 30_000
const INITIAL_WARM_RETRY_MAX_MS = 30 * 60_000

/**
 * How long after startup recovery the latest chat's pair is prepared again. The app reconnects
 * to a restarted engine by reading every chat it shows, and the build takes the checkout's
 * repository lock for its host copies and floods the disk with clones; those first reads should
 * not queue behind it.
 */
const RESTART_REWARM_DELAY_MS = 1_500

/**
 * How long a reply waits for a finished contestant's result to be committed before it gives up. The
 * commit takes a second or two; a reply still unclaimed after this fails rather than hanging.
 */
const REPLY_SETTLE_TIMEOUT_MS = 30_000

/**
 * Preparing a chat's first pair on open is opt-in (`OPENCODE_ARENA_INITIAL_WARM=1`). The engine
 * cannot tell a chat that will battle from one used with a single agent: the app subscribes to
 * every OpenCode chat, and the draft composer's first battle sends straight after resolving, so
 * it never waits long enough to use the pair. Turned on, every empty chat that is shown gets two
 * worktrees and two booted instances until it is archived, and its host copies take the
 * checkout's repository lock, which normal prompts and other chats' sends on that repository
 * also take.
 * It wants a signal from the app that a battle is being written before it is on by default.
 */
const initialWarmEnabled = () => process.env.OPENCODE_ARENA_INITIAL_WARM === "1"

/**
 * How long a chat goes unwatched before its contestant worktrees unload. The app streams only the
 * chat it shows, and every worktree a chat keeps (the retained winner and the warm pair) holds a
 * loaded OpenCode instance until that chat's next send. Tests shorten it.
 */
const idleUnloadMs = () => Number(process.env.OPENCODE_ARENA_IDLE_UNLOAD_MS) || 5 * 60_000

/** The worktree a host directory in a chat's worktree directory belongs to, by name. */
function hostedWorktree(name: string) {
  for (const suffix of [".git.partial", ".git"]) {
    if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length)
  }
  return undefined
}

/**
 * Whether a directory in a chat's worktree pool is one of Arena's worktrees: its `.git` link
 * names an entry in its own host beside it, and that entry names the directory back. Creating a
 * worktree and adopting one both leave exactly that. A contestant's `git worktree add ../x`
 * leaves a `.git` link too, but one into the contestant's own host, and it is litter.
 */
async function isPoolWorktree(directory: string) {
  const read = (file: string) =>
    readFile(file, "utf8").then(
      (text) => text.replace(/[\r\n]+$/, ""),
      () => "",
    )
  const real = (file: string) => realpath(file).catch(() => undefined)
  const link = await read(join(directory, ".git"))
  if (!link.startsWith("gitdir: ")) return false
  const [admin, entries, own] = await Promise.all([
    real(resolvePath(directory, link.slice("gitdir: ".length))),
    real(join(hostRepoPath(directory), "worktrees")),
    real(join(directory, ".git")),
  ])
  if (!admin || !entries || !own || dirname(admin) !== entries) return false
  const back = await read(join(admin, "gitdir"))
  return back !== "" && (await real(resolvePath(admin, back))) === own
}

/**
 * Which free worktree each side adopts. One already at a side's target path goes to that side:
 * given to the other side, it would be cleared out of the way of this side's adopt.
 */
function assignSlots(
  free: readonly string[],
  targets: Readonly<Record<Side, string>>,
  identity: (directory: string) => string,
): Record<Side, string | undefined> {
  const remaining = [...free]
  const take = (side: Side) => {
    const index = remaining.findIndex((directory) => identity(directory) === identity(targets[side]))
    return index >= 0 ? remaining.splice(index, 1)[0] : undefined
  }
  const exact = { a: take("a"), b: take("b") }
  return { a: exact.a ?? remaining.shift(), b: exact.b ?? remaining.shift() }
}

/** Files in a git directory a host copies once and nothing re-syncs; refs are the mirror's. */
const HOST_METADATA_FILES = [
  "config",
  "description",
  "shallow",
  "info/exclude",
  "info/attributes",
  "info/grafts",
  "info/sparse-checkout",
]

/**
 * The checkout's excludes without the line the worktree module adds for its own state. The first
 * worktree made in a checkout writes that line while its host is copied, after the pair's
 * fingerprint was taken, and every host has it whatever the checkout says; counted, it would make
 * a checkout's first pair read as stale at its first send.
 */
function withoutLocalStateExclude(data: Buffer) {
  const pattern = `/${LOCAL_STATE_DIRNAME}/`
  return data
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== pattern)
    .join("\n")
}

/**
 * Identify the git metadata a contestant host copies from the checkout and keeps: config,
 * hooks, info, the shallow list, and the refs the mirror does not sync. A warm host copied before any of it changed is stale, and
 * nothing short of a fresh copy updates it.
 */
async function hostMetadataFingerprint(commonGitDir: string) {
  const hash = createHash("sha256")
  const add = (name: string, data: Uint8Array | string | undefined) => {
    hash.update(name)
    hash.update("\0")
    hash.update(data ?? "\u0001missing")
    hash.update("\0")
  }
  for (const name of HOST_METADATA_FILES) {
    const data = await readFile(join(commonGitDir, name)).catch(() => undefined)
    add(name, name === "info/exclude" && data ? withoutLocalStateExclude(data) : data)
  }
  const hooks = await readdir(join(commonGitDir, "hooks")).catch(() => [] as string[])
  for (const name of hooks.toSorted()) {
    const file = join(commonGitDir, "hooks", name)
    const stats = await lstat(file).catch(() => undefined)
    add(`hooks/${name}:${stats?.mode ?? 0}`, stats?.isFile() ? await readFile(file).catch(() => undefined) : undefined)
  }
  // Refs the mirror leaves alone: the stash, whose older entries live only in its reflog, notes
  // and replacements. A reftable checkout keeps them in its tables, which this does not read.
  for (const name of ["refs/stash", "logs/refs/stash"]) add(name, await readFile(join(commonGitDir, name)).catch(() => undefined))
  for (const namespace of ["refs/notes", "refs/replace"]) {
    const names = await readdir(join(commonGitDir, namespace), { recursive: true }).catch(() => [] as string[])
    for (const name of names.toSorted()) {
      add(`${namespace}/${name}`, await readFile(join(commonGitDir, namespace, name)).catch(() => undefined))
    }
  }
  const packed = await readFile(join(commonGitDir, "packed-refs"), "utf8").catch(() => "")
  add(
    "packed-refs",
    packed
      .split("\n")
      .filter((line) => /^[0-9a-f]+ refs\/(stash$|notes\/|replace\/)/.test(line))
      .join("\n"),
  )
  return hash.digest("hex")
}

function copiedDirectoryRoots(manifest: CopyManifest) {
  return manifest.entries.flatMap((entry) =>
    entry.state === "copied" && entry.type === "directory" ? [entry.relativePath] : [],
  )
}

function copiedRoots(manifest: CopyManifest) {
  return manifest.entries.flatMap((entry) => (entry.state === "copied" ? [entry.relativePath] : []))
}

/**
 * A tracked file as it stands on disk, for `trackedFiles`: the entry that says which blob it
 * holds and its lstat. A file written, replaced, renamed or chmodded since cannot show the same
 * lstat again, because its ctime moves and no process can set a ctime back.
 */
function trackedFileKey(path: string, entry: string, stats: BigIntStats) {
  return BigInt(
    Bun.hash(
      `${path}\0${entry}\0${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
    ),
  )
}

/** `trackedFileKey` for each of `entries`, or undefined for a path that does not lstat. */
async function trackedFileKeys(
  directory: string,
  entries: readonly { readonly path: string; readonly entry: string }[],
) {
  const keys = Array.from<bigint | undefined>({ length: entries.length })
  let next = 0
  const worker = async () => {
    for (let index = next++; index < entries.length; index = next++) {
      const { path, entry } = entries[index]
      const stats = await lstat(join(directory, path), { bigint: true }).catch(() => undefined)
      keys[index] = stats ? trackedFileKey(path, entry, stats) : undefined
    }
  }
  await Promise.all(Array.from({ length: Math.min(64, entries.length) }, worker))
  return keys
}

const execFile = promisify(nodeExecFile)

type WorkingProcess = { readonly pid: number; readonly directory: string }

/**
 * The working directory of every process this user can see, as resolved paths, or undefined
 * when they could not be listed.
 */
async function processDirectories(): Promise<readonly WorkingProcess[] | undefined> {
  if (process.platform === "win32") return []
  if (process.platform === "linux") {
    const pids = await readdir("/proc").catch(() => undefined)
    if (!pids) return undefined
    const listed = await Promise.all(
      pids
        .filter((pid) => /^\d+$/.test(pid))
        .map(async (pid) => {
          const directory = await readlink(`/proc/${pid}/cwd`).catch(() => undefined)
          return directory === undefined ? [] : [{ pid: Number(pid), directory }]
        }),
    )
    return listed.flat()
  }
  // In the C locale lsof prints every non-ASCII path byte as `\xNN`, and no path would match.
  const listed = await execFile("lsof", ["-nP", "-a", "-d", "cwd", "-F", "pn"], {
    env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  }).catch((cause: { readonly code?: unknown; readonly stdout?: unknown }) =>
    // lsof exits 1 when a process vanished while it looked; what it printed still stands.
    cause.code === 1 && typeof cause.stdout === "string" && cause.stdout.length > 0
      ? { stdout: cause.stdout }
      : undefined,
  )
  if (!listed) return undefined
  let pid = 0
  return listed.stdout.split("\n").flatMap((line) => {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    return line.startsWith("n") ? [{ pid, directory: line.slice(1) }] : []
  })
}

/**
 * Every process's working directory, listed again after a moment when the first look finds one in
 * a worktree of the chat that is free to adopt. A released contestant's services and shells are
 * stopped at the vote, and one still exiting would otherwise have its worktree retired as
 * occupied. `owned` names the worktrees runs still hold, whose processes keep running.
 */
async function slotPoolProcesses(
  pool: string,
  owned: ReadonlySet<string>,
): Promise<readonly WorkingProcess[] | undefined> {
  const identities = Array.from(new Set([resolvePath(pool), await realpath(pool).catch(() => resolvePath(pool))]))
  const inFreeSlot = (directory: string) =>
    identities.some((id) => {
      if (!directory.startsWith(`${id}/`)) return false
      const name = directory.slice(id.length + 1).split("/")[0] ?? ""
      return name !== TRASH_DIRNAME && hostedWorktree(name) === undefined && !owned.has(name)
    })
  const inPool = (listed: readonly WorkingProcess[]) => listed.some((entry) => inFreeSlot(entry.directory))
  const first = await processDirectories()
  if (!first || !inPool(first)) return first
  await new Promise((resolve) => setTimeout(resolve, SLOT_PROCESS_RELIST_MS))
  return (await processDirectories()) ?? first
}

/** The command line of each process, for the log only. */
async function processCommands(pids: readonly number[]) {
  if (pids.length === 0 || process.platform === "win32") return ""
  const listed = await execFile("ps", ["-o", "pid=,command=", "-p", pids.join(",")], {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5_000,
  }).catch(() => undefined)
  return (
    listed?.stdout
      .split("\n")
      .map((line) => line.trim().slice(0, 200))
      .filter(Boolean)
      .join("; ") ?? ""
  )
}

/** The `-z` listing of `ls-tree` or `ls-files --stage`: its fields, and the path after the tab. */
function listedIndexEntries(listing: string) {
  return listing.split("\0").flatMap((line) => {
    const tab = line.indexOf("\t")
    if (tab < 0) return []
    return [{ fields: line.slice(0, tab).split(" "), path: line.slice(tab + 1) }]
  })
}

type SideRuntime = {
  readonly side: Side
  readonly turnID: string
  readonly runID: string
  readonly sessionID: SessionID
  readonly worktree: Worktree.Info
  readonly assignment: HiddenAssignment
}

type FinalizedSide = {
  readonly result: FinalizedResult
  readonly transcript: string
  readonly artifactID: string
}

type ReplyTarget = Side | "both"

export type ArenaCheckoutInspection = {
  readonly eligible: boolean
  readonly lastActivityAt: string | null
  readonly reason?: string
}

/** Turn activity used by checkout eviction; environment/setup timestamps are intentionally absent. */
export function latestArenaChatActivity(turns: readonly TurnDocument[], runs: readonly RunDocument[]) {
  const dates = turns.flatMap((turn) => [
    turn.createdAt,
    turn.voteAt,
    turn.applicationAt,
    turn.transitionTimestamps.complete,
    turn.transitionTimestamps.discarded,
  ])
  dates.push(...runs.flatMap((run) => [run.startedAt, run.completedAt]))
  const valid = dates.filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()))
  return valid.length > 0 ? new Date(Math.max(...valid.map((date) => date.getTime()))) : undefined
}

type ArchivedSessionPayload = {
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly runState: string
  readonly error?: string
  readonly permissionState: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly questionState: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly messageBoundary?: { readonly first: string; readonly last: string }
}

export interface Interface {
  readonly activity: (
    sessionIDs: readonly string[],
  ) => Effect.Effect<readonly (typeof ArenaActivity.Session.Type)[], Error>
  /**
   * Resolving a session creates its chat, so this is where a battle tree gets
   * its owner. `userID` is the signed-in account the daemon resolved; a backend
   * running without accounts passes nothing and the tree stays unowned.
   */
  readonly stream: (
    sessionID: string,
    turnID?: string,
    userID?: string,
  ) => Effect.Effect<Stream.Stream<ArenaStreamFrame, Error>, Error>
  readonly session: (sessionID: string, userID?: string) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly archiveSession: (sessionID: string) => Effect.Effect<ReturnType<typeof project> | null, Error>
  readonly inspectCheckout: (worktreeRoot: string) => Effect.Effect<ArenaCheckoutInspection, Error>
  readonly prepareCheckout: (worktreeRoot: string) => Effect.Effect<void, Error>
  readonly releaseCheckout: (worktreeRoot: string) => Effect.Effect<void, Error>
  readonly snapshot: (chatID: string, afterSequence?: number) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly turn: (turnID: string, afterSequence?: number) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly diff: (turnID: string) => Effect.Effect<ArenaSchema.ComparisonDiff, Error>
  readonly inspect: (chatID: string, turnID: string, side: Side) => Effect.Effect<ArenaSchema.Snapshot, Error>
  readonly inspectTree: (chatID: string, turnID: string, side: Side) => Effect.Effect<ArenaSchema.InspectTree, Error>
  readonly inspectFile: (
    chatID: string,
    turnID: string,
    side: Side,
    path: string,
  ) => Effect.Effect<ArenaSchema.InspectFile, Error>
  readonly replyPermission: (
    runID: string,
    requestID: string,
    response: PermissionV1.Reply,
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly replyQuestion: (
    runID: string,
    requestID: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly rejectQuestion: (runID: string, requestID: string) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly beginNormalTurn: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<NormalTurnStart | undefined, Error>
  readonly recordNormalTurn: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly singleAgentVote: (
    sessionID: string,
    ratingID: string,
    vote: SingleAgentVote,
    participantID?: string,
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly startTurn: (
    chatID: string,
    prompt: string,
    participantID?: string,
    autoAccept?: boolean,
    attachments?: readonly ArenaAttachments.Input[],
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly setAutoAccept: (sessionID: string, enabled: boolean) => Effect.Effect<void, Error>
  readonly reply: (
    turnID: string,
    prompt: string,
    target: ReplyTarget,
    attachments?: readonly ArenaAttachments.Input[],
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly vote: (
    turnID: string,
    vote: Vote,
    participantID?: string,
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly recordReview: (
    turnID: string,
    events: readonly ReviewEventInput[],
    participantID?: string,
    ipAddress?: string,
  ) => Effect.Effect<ReviewIngestResult, Error>
  readonly retryResolution: (
    turnID: string,
    /** `restore_workspace` puts back a checkout an apply left half written, and does nothing else. */
    mode?: ApplyBaseChoice | "restore_workspace",
    answers?: readonly ReviewAnswer[],
  ) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly retryComparison: (turnID: string) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly stop: (turnID: string) => Effect.Effect<ReturnType<typeof project>, Error>
  readonly resolveStop: (turnID: string, resolution: StopResolution) => Effect.Effect<ReturnType<typeof project>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Arena") {}

export function normalTurnReservations() {
  const counts = new Map<string, number>()
  return {
    reserve(sessionID: string) {
      counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1)
    },
    release(sessionID: string) {
      const count = counts.get(sessionID) ?? 0
      if (count <= 1) return counts.delete(sessionID)
      counts.set(sessionID, count - 1)
    },
    active(sessionID: string) {
      return (counts.get(sessionID) ?? 0) > 0
    },
  }
}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | InstanceStore.Service
  | Git.Service
  | Session.Service
  | SessionPrompt.Service
  | Image.Service
  | SessionStatus.Service
  | Permission.Service
  | Question.Service
  | Worktree.Service
  | MoveSession.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const image = yield* Image.Service
    const statuses = yield* SessionStatus.Service
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    const worktrees = yield* Worktree.Service
    const mover = yield* MoveSession.Service
    const scope = yield* Scope.Scope
    const operationTrackers = new WeakMap<Store, ReturnType<typeof createArenaOperationTracker>>()
    const operationTrackerFor = (store: Store) => {
      const existing = operationTrackers.get(store)
      if (existing) return existing
      const created = createArenaOperationTracker({
        publish: (turnID, activeOperations, progress) =>
          promise(async () => {
            const patch: {
              activeOperations: readonly ArenaActiveOperation[]
              operationProgress?: readonly ArenaOperationProgress[]
            } = { activeOperations: [...activeOperations] }
            if (progress) {
              const current = await store.turn(turnID)
              patch.operationProgress = mergeOperationProgress(current?.operationProgress ?? [], progress)
            }
            await store.updateTurn(turnID, patch)
          }).pipe(Effect.asVoid),
        log: ({ turnID, operation, durationMs }) =>
          Effect.logDebug("Arena transition operation completed", { turnID, operation, durationMs }),
      })
      operationTrackers.set(store, created)
      return created
    }
    const trackOperation = <A, E, R>(
      store: Store,
      turnID: string,
      operation: ArenaActiveOperation,
      effect: Effect.Effect<A, E, R>,
    ) => operationTrackerFor(store).track(turnID, operation, effect)
    let telemetryStore: Store | undefined
    let telemetry: ReturnType<typeof createTelemetry> | undefined
    let recorder: Recorder | undefined
    const activeNormalTurns = normalTurnReservations()
    const activatingBattles = new Set<string>()
    const chatCreationLocks = new Map<string, Semaphore.Semaphore>()
    const turnStartLocks = new Map<string, Semaphore.Semaphore>()
    const repositoryMutationLocks = new Map<string, Semaphore.Semaphore>()
    const checkoutCleanupLocks = new Map<string, Semaphore.Semaphore>()
    const turnCopyManifests = new Map<string, CopyManifest>()
    // Root sessions whose request another instance hosts: the canonical checkout's, while their
    // worktree is staged. Their runner is registered there, so cancels and steers go there too.
    const promptHosts = new Map<SessionID, string>()
    // Aborted by Stop, so a stopped battle resolves without waiting for the rest of its copy.
    const environmentCopyStops = new Map<string, AbortController>()
    const trustedWarmPairs = new WeakMap<Store, Set<string>>()
    // The checkout's ignored directory roots, one journal per chat for its whole life. A mark is
    // a moment in it, so "has this root been written since that clone" is one lookup.
    const journal = createIgnoredJournal()
    // Each kept worktree's copied roots, from the end of its sync to the start of its next one.
    const slotWatch = createSlotWatch()
    const watcherUnavailable = watcherBackendUnavailable()
    if (watcherUnavailable) {
      yield* Effect.logError("Arena filesystem watcher unavailable; every send re-syncs both sides", {
        reason: watcherUnavailable,
        platform: process.platform,
        arch: process.arch,
      })
    }
    // What this process knows about a kept worktree's ignored content, by resolved directory. A
    // worktree without an entry has unknown history, so its roots are cloned again, which is
    // always exact. Moved with the worktree when it is adopted into a new path.
    const slotStates = new Map<string, SlotState>()
    // The journal position taken before a warm pair's first clone, by `warmPairKey`.
    const warmMarks = new Map<string, JournalMark>()
    // Open streams per chat, and when each chat last stopped being watched. Process-local: a
    // restarted engine has loaded nothing.
    const watchedChats = new Map<string, number>()
    const unwatchedSince = new Map<string, number>()
    let idleUnloadStarted = false
    const reconciledComparisonStores = new WeakSet<Store>()
    let recoverInterrupted: (store: Store) => Effect.Effect<void, Error> = () => Effect.void

    const getStore = promise(() => runtimeStore()).pipe(
      Effect.tap((store) =>
        Effect.sync(() => {
          if (telemetryStore === store) return
          recorder?.close()
          telemetryStore = store
          telemetry = createTelemetry(store)
          setTelemetry(telemetry)
          recorder = new Recorder(store)
        }),
      ),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        recorder?.close()
        telemetry = undefined
        setTelemetry(undefined)
      }),
    )

    const available = Effect.fn("Arena.available")(function* () {
      if (!enabled()) return yield* Effect.fail(new Error("Arena mode is disabled"))
      const store = yield* getStore
      yield* promise(() => recoverOnce(() => Effect.runPromise(recoverInterrupted(store))))
      return store
    })

    const revealTelemetry = (turn: TurnDocument, metrics: Awaited<ReturnType<typeof resolvedPlacement>>["metrics"]) =>
      promise(() => telemetry?.reveal?.({ runIDs: Object.values(turn.runIDs), metrics }) ?? Promise.resolve())

    const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      instances.provide({ directory }, effect)
    const withGit = <A, E, R>(effect: Effect.Effect<A, E, R | Git.Service>) =>
      effect.pipe(Effect.provideService(Git.Service, git))
    const forkInto = (input: ArenaFork.Input) =>
      forkSessionInto(input).pipe(
        Effect.provideService(Session.Service, sessions),
        Effect.provideService(MoveSession.Service, mover),
        Effect.provideService(InstanceStore.Service, instances),
        Effect.provideService(Git.Service, git),
      )
    const repositoryMutationLock = (commonGitDir: string) => {
      const existing = repositoryMutationLocks.get(commonGitDir)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      repositoryMutationLocks.set(commonGitDir, created)
      return created
    }
    const withRepositoryMutation = <A, E, R>(commonGitDir: string, effect: Effect.Effect<A, E, R>) =>
      repositoryMutationLock(commonGitDir).withPermits(1)(effect)
    const checkoutCleanupLock = (root: string) => {
      const existing = checkoutCleanupLocks.get(root)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      checkoutCleanupLocks.set(root, created)
      return created
    }
    const preparationPhase =
      (phase: string, context: { chatID?: string; turnID?: string; side?: Side; directory?: string }) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const startedAt = new Date().toISOString()
          const started = performance.now()
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Effect.logInfo("Arena preparation phase", {
                ...context,
                phase,
                startedAt,
                durationMs: Math.round(performance.now() - started),
                outcome: Exit.isSuccess(exit) ? "success" : "failure",
              }),
            ),
          )
        })
    // Process-local, like what it records: a restarted engine prepares again.
    const preparedContestants = new Set<string>()
    // The preparation still running in a directory, so a worktree about to be synced, moved or
    // released can stop it first: it loads the directory's instance, which writes into it.
    const preparations = new Map<string, Fiber.Fiber<void>>()
    /**
     * Start what a contestant's first prompt would otherwise start once the battle is running:
     * its directory's location services and its snapshot baseline. Detached so no setup waits on
     * it; a prompt that arrives first joins the build already in flight.
     */
    const prepareContestant = (directory: string, context: { chatID?: string; turnID?: string; side?: Side }) =>
      Effect.gen(function* () {
        const key = resolvePath(directory)
        // The directory's instance writes into it from here until it is disposed.
        const slot = slotStates.get(key)
        if (slot?.stoppedAt !== undefined) {
          const { stoppedAt: _stoppedAt, ...running } = slot
          slotStates.set(key, running)
        }
        const fiber = yield* inDirectory(directory, prompts.prepare()).pipe(
          preparationPhase("prepare-contestant", { ...context, directory }),
          Effect.tap(() => Effect.sync(() => preparedContestants.add(directory))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Arena contestant preparation failed", { ...context, directory, cause }),
          ),
          Effect.forkIn(scope),
        )
        preparations.set(key, fiber)
        fiber.addObserver(() => {
          if (preparations.get(key) === fiber) preparations.delete(key)
        })
      })
    /** Stop the directory's preparation and forget that it ran; whatever runs there next prepares again. */
    const stopPreparation = Effect.fnUntraced(function* (directory: string) {
      const key = resolvePath(directory)
      const fiber = preparations.get(key)
      preparations.delete(key)
      preparedContestants.delete(directory)
      if (fiber) yield* Fiber.interrupt(fiber)
    })
    const warmPairKey = (chatID: string, generation: number) => `${chatID}:${generation}`
    const trustWarmPair = (store: Store, chatID: string, generation: number) => {
      const trusted = trustedWarmPairs.get(store) ?? new Set<string>()
      trusted.add(warmPairKey(chatID, generation))
      trustedWarmPairs.set(store, trusted)
    }
    const distrustWarmPair = (store: Store, chatID: string, generation: number) =>
      trustedWarmPairs.get(store)?.delete(warmPairKey(chatID, generation))
    const isWarmPairTrusted = (store: Store, chatID: string, generation: number) =>
      trustedWarmPairs.get(store)?.has(warmPairKey(chatID, generation)) === true

    /**
     * The warm record for the chat's next turn, in whatever state, and where it is kept. Every
     * reader of the next pair comes through here, so the first turn's, which the chat holds, is
     * found like any other. It is read from the store as a turn's is: the chat a caller holds can
     * predate the record.
     */
    const warmRecordFor = Effect.fnUntraced(function* (store: Store, chat: ChatDocument) {
      if (chat.turnCount === 0) {
        const latest = yield* promise(() => store.chat(chat._id))
        const preparation = latest?.turnCount === 0 ? latest.initialWarmPreparation : undefined
        if (preparation?.generation !== 0) return undefined
        const owner: WarmOwner = { kind: "chat", chatID: chat._id }
        return { owner, preparation }
      }
      const turn = yield* promise(() =>
        store.turns.findOne({ chatID: chat._id, "warmPreparation.generation": chat.turnCount }),
      )
      if (!turn?.warmPreparation) return undefined
      const owner: WarmOwner = { kind: "turn", turn }
      return { owner, preparation: turn.warmPreparation }
    })

    /** Record a warm pair's progress where `warmRecordFor` finds it; `undefined` removes the record. */
    const writeWarmRecord = (store: Store, owner: WarmOwner, preparation: WarmPreparation | undefined) =>
      promise(async () => {
        if (owner.kind === "turn") {
          if (preparation) await store.updateTurn(owner.turn._id, { warmPreparation: preparation })
          else await store.turns.updateOne({ _id: owner.turn._id }, { $unset: { warmPreparation: "" } })
          return
        }
        await store.updateChat(
          { _id: owner.chatID },
          preparation
            ? { $set: { initialWarmPreparation: preparation, updatedAt: new Date() } }
            : { $set: { updatedAt: new Date() }, $unset: { initialWarmPreparation: "" } },
        )
      })

    /** Every warm record a chat holds, its turns' and its own, for archive and eviction to clear. */
    const warmRecordsOf = (chat: ChatDocument, turns: readonly TurnDocument[]) =>
      [...turns.map((turn) => turn.warmPreparation), chat.initialWarmPreparation].filter(
        (preparation): preparation is WarmPreparation => preparation !== undefined,
      )

    /**
     * Trust is coverage, not a flag. A pair marked trusted in this process is only usable while
     * the watches can also account for every moment since it was synced: the checkout's journal
     * since the mark taken before the pair's first clone, and each worktree's own watch since its
     * sync ended. Any one of them failing sends the turn down the refresh path.
     */
    const warmPairIsUsable = (
      store: Store,
      chatID: string,
      generation: number,
      directories: readonly string[],
      roots: readonly string[],
    ) => {
      if (!isWarmPairTrusted(store, chatID, generation)) {
        return { usable: false as const, reason: "warm pair is not trusted in this process" }
      }
      const canonical = journal.changedSince(chatID, warmMarks.get(warmPairKey(chatID, generation)), roots)
      if (!canonical.complete) {
        return { usable: false as const, reason: canonical.reason ?? "the checkout's ignored content was not observed" }
      }
      if (canonical.changed.size > 0) {
        const changed = Array.from(canonical.changed).sort().join(", ")
        return { usable: false as const, reason: `ignored content changed in the checkout: ${changed}` }
      }
      for (const directory of directories) {
        const slot = slotWatch.settle(directory, roots)
        if (!slot.complete) {
          return {
            usable: false as const,
            reason: `${basename(directory)} was not watched: ${slot.reason ?? "unknown"}`,
          }
        }
        if (slot.changed.size > 0) {
          const changed = Array.from(slot.changed).sort().join(", ")
          return { usable: false as const, reason: `ignored content changed in ${basename(directory)}: ${changed}` }
        }
      }
      return { usable: true as const }
    }
    const discoverRunServices = Effect.fn("Arena.discoverRunServices")(function* (run: RunDocument) {
      const preview = previewRoute(run.worktree)
      const routes = preview ? previewRoutes(preview) : persistedProxyRoutes(run.services)
      const captured = yield* promise(() =>
        captureOwnedServices({
          worktree: run.worktree,
          portAliases: run.portAliases,
          proxyRoutes: routes,
        }),
      )
      const owned = assignProxyRoutes(captured, routes)
      observePreview(
        run.worktree,
        owned.flatMap((service) =>
          service.listeners.map((listener) => ({
            port: listener.port,
            ...(listener.alias ? { alias: listener.alias } : {}),
            command: service.command,
          })),
        ),
      )
      return [...(preview ? [previewEnvironmentService(preview, new Date())] : []), ...owned]
    })

    const projectSnapshot = Effect.fn("Arena.projectSnapshot")(function* (
      snapshot: Awaited<ReturnType<Store["snapshot"]>>,
      afterSequence: number,
      options: { controlsOnly?: boolean; discoverServices?: boolean } = {},
    ) {
      const controlsOnly = options.controlsOnly === true
      const store = yield* getStore
      if (options.discoverServices !== false && afterSequence < 0 && snapshot.chat.status === "battle_active") {
        yield* Effect.forEach(
          snapshot.runs.filter((run) => !run.worktreeRemovedAt),
          (run) =>
            discoverRunServices(run).pipe(
              Effect.tap((services) =>
                promise(() => store.updateRun(run._id, { services })).pipe(
                  Effect.tap(() => Effect.sync(() => (run.services = services))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Arena live service discovery failed", { runID: run._id, cause }),
              ),
            ),
          { concurrency: 2, discard: true },
        )
      }
      const projected = project(snapshot)
      if (afterSequence >= 0 && !controlsOnly) return projected
      return yield* hydrateRuns(projected, snapshot, controlsOnly)
    })

    /**
     * Fill each contestant's thread in, from its archive or from the live session.
     *
     * Split out of `projectSnapshot` because every mutation answers with a snapshot too, and
     * the client writes those straight over its cached snapshot. An unhydrated answer therefore
     * empties both contestant threads until the subscription resynchronizes — a visible blink now
     * that the panes stay up through a resolution instead of unmounting on the vote.
     *
     * Service discovery stays in `projectSnapshot`: a mutation should not wait for discovery, and
     * a mutation has no reason to probe services it is often about to stop.
     */
    const hydrateRuns = Effect.fn("Arena.hydrateRuns")(function* (
      projected: ReturnType<typeof project>,
      snapshot: Awaited<ReturnType<Store["snapshot"]>>,
      controlsOnly = false,
    ) {
      const store = yield* getStore
      const hydrated = yield* Effect.forEach(
        snapshot.runs,
        (run) =>
          Effect.gen(function* () {
            const sessionID = SessionID.make(run.rootSessionID)
            const sessionIDs = new Set([run.rootSessionID, ...run.descendantSessionIDs])
            const safeRequest = (type: string, request: unknown) => {
              const envelope = ArenaPrivacy.event({ type, properties: request }) as {
                readonly properties?: unknown
              }
              return envelope.properties ?? {}
            }
            if (run.archiveComplete && controlsOnly)
              return { key: run._id, value: { permissions: [], questions: [], status: { type: "idle" } } }
            if (run.archiveComplete) {
              const archived = yield* bestEffort(
                promise(async () => {
                  const manifest = run.transcriptArchiveID
                    ? await store.sessionArchives.findOne({
                        _id: run.transcriptArchiveID,
                        runID: run._id,
                      })
                    : undefined
                  const artifact = await store.artifacts.findOne({
                    _id: manifest?.artifactIDs[0] ?? `${run._id}|transcript`,
                  })
                  if (!artifact) throw new Error(`Arena transcript archive not found: ${run._id}`)
                  const payload = ArenaTranscriptArtifact.decode(artifact)
                  if (!Array.isArray(payload)) throw new Error(`Arena transcript archive is invalid: ${run._id}`)
                  const root = payload.find(
                    (item): item is Record<string, unknown> =>
                      typeof item === "object" &&
                      item !== null &&
                      !Array.isArray(item) &&
                      item.sessionID === run.rootSessionID,
                  )
                  if (!root || !Array.isArray(root.messages)) {
                    throw new Error(`Arena root transcript archive is missing: ${run._id}`)
                  }
                  const messages = root.messages.flatMap((message) => {
                    if (
                      typeof message !== "object" ||
                      message === null ||
                      Array.isArray(message) ||
                      typeof message.info !== "object" ||
                      message.info === null ||
                      Array.isArray(message.info) ||
                      typeof message.info.id !== "string" ||
                      !Array.isArray(message.parts)
                    )
                      return []
                    const infoEnvelope = ArenaPrivacy.event({
                      type: "message.updated",
                      properties: { info: message.info },
                    })
                    if (
                      typeof infoEnvelope !== "object" ||
                      infoEnvelope === null ||
                      !("properties" in infoEnvelope) ||
                      typeof infoEnvelope.properties !== "object" ||
                      infoEnvelope.properties === null ||
                      !("info" in infoEnvelope.properties)
                    )
                      return []
                    const parts = message.parts.flatMap((part: unknown) => {
                      const partEnvelope = ArenaPrivacy.event({
                        type: "message.part.updated",
                        properties: { part },
                      })
                      if (
                        typeof partEnvelope !== "object" ||
                        partEnvelope === null ||
                        !("properties" in partEnvelope) ||
                        typeof partEnvelope.properties !== "object" ||
                        partEnvelope.properties === null ||
                        !("part" in partEnvelope.properties)
                      )
                        return []
                      return [partEnvelope.properties.part]
                    })
                    return [{ info: infoEnvelope.properties.info, parts }]
                  })
                  const permissions = Array.isArray(root.permissionState)
                    ? root.permissionState.map((request) => safeRequest("permission.asked", request))
                    : []
                  const questions = Array.isArray(root.questionState)
                    ? root.questionState.map((request) => safeRequest("question.asked", request))
                    : []
                  return {
                    messages: messages.map((message) => message.info),
                    parts: Object.fromEntries(
                      messages.flatMap((message) =>
                        typeof message.info === "object" &&
                        message.info !== null &&
                        "id" in message.info &&
                        typeof message.info.id === "string"
                          ? [[message.info.id, message.parts] as const]
                          : [],
                      ),
                    ),
                    permissions,
                    questions,
                  }
                }),
              )
              return {
                key: run._id,
                value: archived.available ? archived.value : {},
              }
            }
            if (snapshot.chat.status !== "battle_active") return { key: run._id, value: {} }
            const live = yield* inDirectory(
              run.worktree,
              Effect.all({
                messages: controlsOnly
                  ? Effect.succeed({ available: false as const })
                  : bestEffort(
                      sessions.messages({ sessionID }).pipe(Effect.map(ArenaPrivacy.messages), Effect.mapError(error)),
                    ),
                status: bestEffort(statuses.get(sessionID).pipe(Effect.map(ArenaPrivacy.status))),
                permissions: bestEffort(
                  permissions
                    .list()
                    .pipe(
                      Effect.map((requests) =>
                        requests
                          .filter((request) => sessionIDs.has(request.sessionID))
                          .map((request) => safeRequest("permission.asked", request)),
                      ),
                    ),
                ),
                questions: bestEffort(
                  questions
                    .list()
                    .pipe(
                      Effect.map((requests) =>
                        requests
                          .filter((request) => sessionIDs.has(request.sessionID))
                          .map((request) => safeRequest("question.asked", request)),
                      ),
                    ),
                ),
              }),
            )
            return {
              key: run._id,
              value: {
                ...(live.messages.available
                  ? {
                      messages: live.messages.value.map((message) => message.info),
                      parts: Object.fromEntries(live.messages.value.map((message) => [message.info.id, message.parts])),
                    }
                  : {}),
                ...(live.status.available ? { status: live.status.value } : {}),
                ...(live.permissions.available ? { permissions: live.permissions.value } : {}),
                ...(live.questions.available ? { questions: live.questions.value } : {}),
              },
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined),
            ),
          ),
        { concurrency: 2 },
      )
      return parseSnapshot(
        jsonValue({
          ...projected,
          runs: projected.runs.map((run) => {
            const live = hydrated.find((item) => item?.key === run.id)
            return live ? { ...run, ...live.value } : run
          }),
        }),
      )
    })

    /** The snapshot a mutation answers with. Hydrated, because the client writes it over the poll. */
    const respond = Effect.fn("Arena.respond")(function* (store: Store, chatID: string) {
      const current = yield* promise(() => store.snapshot(chatID))
      return yield* hydrateRuns(project(current), current)
    })

    const configuration = Effect.fn("Arena.configuration")(function* () {
      const value = yield* config.get()
      const whole = digest(value)
      const part = (key: string) => digest((value as Record<string, unknown>)[key] ?? null)
      return {
        modelPool: digest(sampleProfiles()),
        agent: part("agent"),
        plugins: part("plugin"),
        mcp: part("mcp"),
        skills: part("skills"),
        tools: part("tools"),
        system: digest({ instructions: (value as Record<string, unknown>).instructions, whole }),
      }
    })

    /**
     * The diff between a chat's own two anchors, remembered until one of them moves.
     *
     * Activity is polled every second while a battle runs, and this is a real git call, so it is
     * kept per chat and recomputed only when a result anchor moves. A failed read is remembered too:
     * the sidebar falls back to the checkout's number, and retrying it every poll would not help.
     */
    const chatDiffs = new Map<
      string,
      { span: string; value: { files: number; additions: number; deletions: number } | undefined }
    >()

    const chatDiff = Effect.fn("Arena.chatDiff")(function* (record: ArenaActivity.Record) {
      const span = record.contribution
      if (!span) return undefined
      const key = `${span.base}..${span.result}`
      const remembered = chatDiffs.get(record.chat._id)
      if (remembered?.span === key) return remembered.value
      const output = yield* git
        .run(["diff", "--numstat", "--no-ext-diff", "--no-renames", span.base, span.result], {
          cwd: record.chat.repository.root,
          maxOutputBytes: 2 * 1024 * 1024,
        })
        .pipe(
          Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(null))),
        )
      const value = output
        ? parseNumstat(output.text()).reduce(
            (total, item) => ({
              files: total.files + 1,
              additions: total.additions + item.additions,
              deletions: total.deletions + item.deletions,
            }),
            { files: 0, additions: 0, deletions: 0 },
          )
        : undefined
      chatDiffs.set(record.chat._id, { span: key, value })
      return value
    })

    const activity = Effect.fn("Arena.activity")(function* (sessionIDs: readonly string[]) {
      // Observing must not initialize chats or run recovery/application mutations.
      if (!enabled()) return []
      const store = yield* getStore
      const records = yield* promise(() => store.activity(sessionIDs))
      return yield* Effect.forEach(
        records,
        (record) =>
          Effect.gen(function* () {
            const inputRunIDs = new Set<string>()
            if (record.chat.status === "battle_active" && !record.turn?.resolution) {
              for (const run of record.runs) {
                if (run.runState !== "pending") continue
                const sessionIDs = new Set([run.rootSessionID, ...run.descendantSessionIDs])
                const waiting = yield* inDirectory(
                  run.worktree,
                  Effect.all({
                    permissions: permissions.list(),
                    questions: questions.list(),
                  }),
                )
                const requests = [...waiting.permissions, ...waiting.questions]
                if (requests.some((request) => sessionIDs.has(request.sessionID))) inputRunIDs.add(run._id)
              }
            }
            return ArenaActivity.project(record, inputRunIDs, yield* chatDiff(record))
          }),
        { concurrency: 4 },
      )
    })

    const snapshot = Effect.fn("Arena.snapshot")(function* (id: string, afterSequence = -1) {
      const store = yield* available()
      const current = yield* promise(() => store.snapshot(id, afterSequence))
      return yield* projectSnapshot(current, afterSequence)
    })

    const turnSnapshot = Effect.fn("Arena.turnSnapshot")(function* (id: string, afterSequence = -1) {
      const store = yield* available()
      const current = yield* promise(() => store.snapshotTurn(id, afterSequence))
      return yield* projectSnapshot(current, afterSequence)
    })

    const comparisonDiff = Effect.fn("Arena.comparisonDiff")(function* (id: string) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const a = runs.find((run) => run.side === "a")
      const b = runs.find((run) => run.side === "b")
      const stopped =
        turn.state === "stopping" ||
        turn.state === "awaiting_stop_resolution" ||
        turn.state === "discarding" ||
        turn.state === "discarded" ||
        turn.resolution?.kind === "stopped"
      if ((!a?.finalCommit || !b?.finalCommit) && !stopped) {
        return yield* Effect.fail(new Error("Arena comparison is not finalized"))
      }
      // A stopped battle deliberately permits partial and failed contestants. Keep its
      // diff inspectable by representing a side without a finalized result as the
      // frozen base revision; the public run still reports that the side has no result.
      const aCommit = a?.finalCommit ?? turn.frozenBaseSHA
      const bCommit = b?.finalCommit ?? turn.frozenBaseSHA
      const evidence = yield* withGit(
        compare({
          canonical: chat.repository.root,
          baseCommit: turn.frozenBaseSHA,
          aCommit,
          bCommit,
          maxOutputBytes: 5 * 1024 * 1024,
        }),
      ).pipe(Effect.mapError(error))
      return Schema.decodeUnknownSync(ArenaSchema.ComparisonDiff)({
        turnID: turn._id,
        baseCommit: turn.frozenBaseSHA,
        a: {
          commit: aCommit,
          tree: evidence.aTree,
          ...(a?.finalCommit && a.permanentRef ? { ref: a.permanentRef } : {}),
        },
        b: {
          commit: bCommit,
          tree: evidence.bTree,
          ...(b?.finalCommit && b.permanentRef ? { ref: b.permanentRef } : {}),
        },
        treesEqual: evidence.aTree === evidence.bTree,
        files: evidence.files,
        filesTruncated: evidence.filesTruncated,
        patch: evidence.patch,
        truncated: evidence.truncated,
        stats: evidence.stats,
        divergence: evidence.divergence,
      })
    })

    const inspect = Effect.fn("Arena.inspect")(function* (requestedChatID: string, id: string, side: Side) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn || turn.chatID !== requestedChatID) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const run = runs.find((item) => item.side === side)
      if (!run) return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} is not ready`))

      let status = ""
      let patch = ""
      let patchTruncated = false
      const maxSummaryBytes = 2 * 1024 * 1024
      const maxSummaryEntries = 5_000
      const maxPatchBytes = 5 * 1024 * 1024
      let files: ReadonlyArray<{
        path: string
        status?: string
        additions?: number
        deletions?: number
        binary?: boolean
      }> = []
      if (run.finalCommit) {
        const [statusResult, patchResult, statsResult] = yield* Effect.all([
          git.run(["show", "--no-patch", "--format=%h %s", run.finalCommit], {
            cwd: chat.repository.root,
            maxOutputBytes: 64 * 1024,
          }),
          git.run(
            ["diff", "--patch", "--no-ext-diff", "--no-renames", turn.frozenBaseSHA, run.finalCommit, "--", "."],
            { cwd: chat.repository.root, maxOutputBytes: 5 * 1024 * 1024 },
          ),
          git.run(
            ["diff", "--numstat", "--no-ext-diff", "--no-renames", turn.frozenBaseSHA, run.finalCommit, "--", "."],
            { cwd: chat.repository.root, maxOutputBytes: maxSummaryBytes },
          ),
        ])
        status = statusResult.text().trim()
        patch = patchResult.text()
        const parsed = parseNumstat(statsResult.text())
        patchTruncated = patchResult.truncated || statsResult.truncated || parsed.length > maxSummaryEntries
        files = parsed.slice(0, maxSummaryEntries)
      } else {
        const [statusResult, statsResult, trackedPatch] = yield* Effect.all([
          git.run(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
            cwd: run.worktree,
            maxOutputBytes: maxSummaryBytes,
          }),
          git.run(["diff", "--numstat", "--no-ext-diff", "--no-renames", turn.frozenBaseSHA, "--", "."], {
            cwd: run.worktree,
            maxOutputBytes: maxSummaryBytes,
          }),
          git.patchAll(run.worktree, turn.frozenBaseSHA, { maxOutputBytes: 5 * 1024 * 1024 }),
        ])
        const parsedItems = parseStatus(statusResult.text())
        const items = parsedItems.slice(0, maxSummaryEntries)
        const trackedStats = parseNumstat(statsResult.text()).slice(0, maxSummaryEntries)
        status = items.map((item) => `${item.code} ${item.file}`).join("\n")
        const stats = new Map(trackedStats.map((item) => [item.path, item]))
        const chunks = [trackedPatch.text]
        let patchBytes = Buffer.byteLength(trackedPatch.text)
        patchTruncated =
          trackedPatch.truncated ||
          statusResult.truncated ||
          statsResult.truncated ||
          parsedItems.length > maxSummaryEntries
        const untrackedItems = items.filter((item) => item.code === "??")
        for (const [index, item] of untrackedItems.entries()) {
          const remaining = maxPatchBytes - patchBytes
          if (index >= 100 || remaining <= 0) {
            patchTruncated = true
            break
          }
          const [stat, untracked] = yield* Effect.all([
            git.statUntracked(run.worktree, item.file),
            git.patchUntracked(run.worktree, item.file, {
              maxOutputBytes: Math.min(256 * 1024, remaining),
            }),
          ])
          if (stat) {
            stats.set(item.file, {
              path: stat.file,
              additions: stat.additions,
              deletions: stat.deletions,
              binary: false,
            })
          }
          if (untracked.text) {
            chunks.push(untracked.text)
            patchBytes += Buffer.byteLength(untracked.text)
          }
          patchTruncated ||= untracked.truncated
        }
        patch = chunks.filter(Boolean).join("\n")
        files = items.map((item) => ({
          path: item.file,
          status: item.status,
          additions: stats.get(item.file)?.additions,
          deletions: stats.get(item.file)?.deletions,
        }))
      }
      const projected = project(yield* promise(() => store.snapshotTurn(turn._id)))
      return parseSnapshot(
        jsonValue({
          ...projected,
          runs: projected.runs.map((item) =>
            item.id === run._id
              ? {
                  ...item,
                  inspection: {
                    status,
                    patch,
                    patchTruncated,
                    finalRef: run.permanentRef,
                    finalCommit: run.finalCommit,
                    files,
                    commands: run.testCommands.slice(0, 500).map((command) => ({ command: command.slice(0, 4_096) })),
                    commandsTruncated:
                      run.testCommands.length > 500 || run.testCommands.some((command) => command.length > 4_096),
                  },
                }
              : item,
          ),
        }),
      )
    })

    const inspectionTarget = Effect.fn("Arena.inspectionTarget")(function* (
      requestedChatID: string,
      id: string,
      side: Side,
    ) {
      if (side !== "a" && side !== "b") return yield* Effect.fail(new Error("Arena side must be A or B"))
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn || turn.chatID !== requestedChatID) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      const chat = yield* promise(() => store.chat(requestedChatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${requestedChatID}`))
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const run = runs.find((item) => item.side === side)
      if (!run) return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} is not ready`))
      if (run.finalCommit && (!run.finalTree || !run.permanentRef)) {
        return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} has incomplete retained Git evidence`))
      }
      if (!run.finalCommit && run.worktreeRemovedAt) {
        return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} has no retained result`))
      }
      return {
        chat,
        run,
        finalized:
          run.finalCommit && run.finalTree && run.permanentRef
            ? { commit: run.finalCommit, tree: run.finalTree, ref: run.permanentRef }
            : undefined,
      }
    })

    const inspectTree = Effect.fn("Arena.inspectTree")(function* (chatID: string, turnID: string, side: Side) {
      const target = yield* inspectionTarget(chatID, turnID, side)
      const tree = target.finalized
        ? yield* withGit(
            finalizedTree({
              repository: target.chat.repository.root,
              ...target.finalized,
            }),
          ).pipe(Effect.mapError(error))
        : yield* promise(() => liveTree(target.run.worktree))
      return Schema.decodeUnknownSync(ArenaSchema.InspectTree)({ chatID, turnID, side, ...tree })
    })

    const inspectFile = Effect.fn("Arena.inspectFile")(function* (
      chatID: string,
      turnID: string,
      side: Side,
      path: string,
    ) {
      const target = yield* inspectionTarget(chatID, turnID, side)
      const file = target.finalized
        ? yield* withGit(
            finalizedFile({
              repository: target.chat.repository.root,
              ...target.finalized,
              path,
            }),
          ).pipe(Effect.mapError(error))
        : yield* promise(() => liveFile(target.run.worktree, path))
      return Schema.decodeUnknownSync(ArenaSchema.InspectFile)({ chatID, turnID, side, ...file })
    })

    const runForReply = Effect.fn("Arena.runForReply")(function* (store: Store, runID: string) {
      const run = yield* promise(() => store.run(runID))
      if (!run) return yield* Effect.fail(new Error(`Arena run not found: ${runID}`))
      return run
    })

    const replySnapshot = Effect.fn("Arena.replySnapshot")(function* (store: Store, turnID: string) {
      return yield* projectSnapshot(yield* promise(() => store.snapshotTurn(turnID)), -1)
    })

    const replyPermission = Effect.fn("Arena.replyPermission")(function* (
      runID: string,
      requestID: string,
      response: PermissionV1.Reply,
    ) {
      const store = yield* available()
      const run = yield* runForReply(store, runID)
      yield* inDirectory(
        run.worktree,
        permissions.reply({ requestID: PermissionV1.ID.make(requestID), reply: response }),
      ).pipe(Effect.mapError(error))
      yield* promise(() =>
        store.writeRun(
          { _id: runID },
          {
            $push: { permissionOutcomes: { requestID, response, at: new Date() } },
            $set: { updatedAt: new Date() },
          },
        ),
      )
      return yield* replySnapshot(store, run.turnID)
    })

    const setAutoAccept = Effect.fn("Arena.setAutoAccept")(function* (sessionID: string, enabled: boolean) {
      const store = yield* available()
      const chat = yield* promise(() => store.chat(chatID(sessionID)))
      const turnID = chat?.activeTurnID
      if (!turnID) return
      yield* promise(() => store.updateTurn(turnID, { autoAccept: enabled }))
      const runs = yield* promise(() => store.runsForTurn(turnID))
      yield* Effect.forEach(
        runs,
        (run) =>
          Effect.gen(function* () {
            yield* promise(() => store.updateRun(run._id, { autoAccept: enabled }))
            yield* inDirectory(run.worktree, permissions.setAutoAccept(enabled))
          }),
        { concurrency: 2, discard: true },
      )
    })

    const replyQuestion = Effect.fn("Arena.replyQuestion")(function* (
      runID: string,
      requestID: string,
      answers: ReadonlyArray<ReadonlyArray<string>>,
    ) {
      const store = yield* available()
      const run = yield* runForReply(store, runID)
      yield* inDirectory(run.worktree, questions.reply({ requestID: QuestionID.make(requestID), answers })).pipe(
        Effect.mapError(error),
      )
      yield* promise(() =>
        store.writeRun(
          { _id: runID },
          {
            $push: { questionOutcomes: { requestID, answers, at: new Date() } },
            $set: { updatedAt: new Date() },
          },
        ),
      )
      return yield* replySnapshot(store, run.turnID)
    })

    const rejectQuestion = Effect.fn("Arena.rejectQuestion")(function* (runID: string, requestID: string) {
      const store = yield* available()
      const run = yield* runForReply(store, runID)
      yield* inDirectory(run.worktree, questions.reject(QuestionID.make(requestID))).pipe(Effect.mapError(error))
      yield* promise(() =>
        store.writeRun(
          { _id: runID },
          {
            $push: { questionOutcomes: { requestID, rejected: true, at: new Date() } },
            $set: { updatedAt: new Date() },
          },
        ),
      )
      return yield* replySnapshot(store, run.turnID)
    })

    const chatCreationLock = (sessionID: string) => {
      const existing = chatCreationLocks.get(sessionID)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      chatCreationLocks.set(sessionID, created)
      return created
    }

    const ensureSingleAgentRating = Effect.fn("Arena.ensureSingleAgentRating")(function* (
      rawSessionID: string,
      messageID: MessageID,
    ) {
      const store = yield* available()
      const existing = yield* promise(() => store.singleAgentRating(rawSessionID, messageID))
      if (existing) {
        registry.replaceSingle(rawSessionID, {
          runID: existing._id,
          rootSessionID: rawSessionID,
          scopeID: existing._id,
          assignmentID: existing.assignment.assignmentID,
          telemetry: false,
        })
        return existing
      }
      const owner = yield* promise(() => store.chatForSession(rawSessionID))
      const now = new Date()
      const id = `single-agent|${rawSessionID.length}:${rawSessionID}|${messageID.length}:${messageID}`
      const selected = yield* promise(() => createSingleAssignment(id))
      const rating = (yield* promise(() =>
        store.claimSingleAgentRating({
          _id: id,
          ...(owner?.userId ? { userId: owner.userId } : {}),
          sessionID: rawSessionID,
          messageID,
          assignment: assignment(selected),
          createdAt: now,
          updatedAt: now,
        }),
      )).value
      registry.replaceSingle(rawSessionID, {
        runID: rating._id,
        rootSessionID: rawSessionID,
        scopeID: rating._id,
        assignmentID: rating.assignment.assignmentID,
        telemetry: false,
      })
      return rating
    })

    const turnStartLock = (chatID: string) => {
      const existing = turnStartLocks.get(chatID)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      turnStartLocks.set(chatID, created)
      return created
    }

    const blockCanonicalCheckout = Effect.fn("Arena.blockCanonicalCheckout")(function* (
      store: Store,
      chat: ChatDocument,
      detail: string,
    ) {
      if (chat.status === "blocked" && chat.blockedReason === canonicalUnavailableReason) return chat
      yield* Effect.logWarning("Arena trunk worktree is unavailable", {
        chatID: chat._id,
        detail,
      })
      const updated = yield* promise(() =>
        store.updateChatReturning(
          {
            _id: chat._id,
            status: { $in: ["ready", "blocked"] },
            activeTurnID: { $exists: false },
            checkoutEvicted: { $ne: true },
          },
          {
            $set: {
              status: "blocked",
              blockedReason: canonicalUnavailableReason,
              updatedAt: new Date(),
            },
          },
        ),
      )
      return updated ?? chat
    })

    // Records what the last inspection saw of the trunk on a chat that stays ready: its
    // unresolved merge conflicts, and the branch when `rename` says the developer renamed the
    // trunk or cut a new one at the same commit. Guarded like the other ready-chat updates so it
    // never fights an active turn.
    const recordTrunkState = Effect.fn("Arena.recordTrunkState")(function* (
      store: Store,
      chatID: string,
      trunk: {
        readonly conflicts: readonly string[]
        readonly rename?: { readonly branch?: string; readonly detached: boolean }
      },
    ) {
      const { conflicts, rename } = trunk
      const clearConflicts = conflicts.length === 0
      const clearBranch = rename !== undefined && rename.branch === undefined
      // Through the Store, not the collection: a raw write notifies no one, and a subscribed app
      // would keep rendering the branch and the conflicts the last frame carried.
      return yield* promise(() =>
        store.updateChatReturning(
          {
            _id: chatID,
            status: "ready",
            activeTurnID: { $exists: false },
          },
          {
            $set: {
              ...(conflicts.length > 0 ? { trunkConflicts: conflicts } : {}),
              ...(rename ? { "canonicalCheckout.detached": rename.detached } : {}),
              ...(rename?.branch
                ? {
                    arenaBranch: rename.branch,
                    "repository.branch": rename.branch,
                    "canonicalCheckout.branch": rename.branch,
                  }
                : {}),
              updatedAt: new Date(),
            },
            ...(clearConflicts || clearBranch
              ? {
                  $unset: {
                    ...(clearConflicts ? { trunkConflicts: "" } : {}),
                    ...(clearBranch
                      ? { arenaBranch: "", "repository.branch": "", "canonicalCheckout.branch": "" }
                      : {}),
                  },
                }
              : {}),
          },
        ),
      )
    })

    const reconcileCanonicalAvailability = Effect.fn("Arena.reconcileCanonicalAvailability")(function* (
      store: Store,
      chat: ChatDocument,
    ) {
      if (chat.checkoutEvicted || (chat.status !== "ready" && chat.status !== "blocked")) return chat
      if (yield* promise(() => store.checkoutEviction(chat.canonicalCheckout?.root ?? chat.repository.root)))
        return chat
      const inspection = yield* Effect.exit(
        Effect.gen(function* () {
          const state = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
          if (state.root !== chat.repository.root) {
            return yield* Effect.fail(new Error("Canonical checkout root changed outside Arena"))
          }
          const commonGitDir = yield* withGit(repositoryKey(state.root)).pipe(Effect.mapError(error))
          const recordedGitDir = chat.canonicalCheckout?.commonGitDir
          if (recordedGitDir && commonGitDir !== recordedGitDir) {
            return yield* Effect.fail(new Error("Canonical checkout repository identity changed outside Arena"))
          }
          const hasInitialCommit = yield* withGit(
            containsCommit({ repository: state.root, commit: chat.initialCanonicalSHA }),
          ).pipe(Effect.mapError(error))
          if (!hasInitialCommit) {
            return yield* Effect.fail(new Error("Canonical checkout no longer belongs to the recorded repository"))
          }
          return { state, commonGitDir }
        }),
      )
      if (Exit.isFailure(inspection)) {
        const detail = Cause.pretty(inspection.cause)
        // Git was busy, not missing. Skip this pass and let the next poll read it.
        if (isGitLockContention(detail)) {
          yield* Effect.logDebug("Arena skipped a canonical inspection while git was locked", {
            chatID: chat._id,
          })
          return chat
        }
        return yield* blockCanonicalCheckout(store, chat, detail)
      }
      const { state, commonGitDir } = inspection.value
      if (chat.status !== "blocked") {
        // A ready chat still records the trunk's unresolved merge conflicts so the battle guard
        // and the app read the same list the last inspection saw.
        //
        // It records the branch on the same pass. Between turns the developer can rename the
        // trunk or cut a new branch at the same commit, and the next turn hosts contestants on
        // whatever name git answers with — so a chat that kept the name it was attached with
        // would show one branch and battle on another. Only the name moves here: a head that
        // moved is a different checkout than the chat's history was built on, and completeTurn
        // and the blocked-restore path below own that transition.
        const renamed =
          state.head === chat.canonicalCheckout?.head && state.branch !== chat.canonicalCheckout.branch
        if (!renamed && sameConflicts(chat.trunkConflicts ?? [], state.conflicts)) return chat
        const refreshed = yield* recordTrunkState(store, chat._id, {
          conflicts: state.conflicts,
          ...(renamed ? { rename: { branch: state.branch, detached: state.detached } } : {}),
        })
        // The write is guarded, so a miss means the chat moved on. Report the inspected list
        // anyway: startTurnUnlocked reads it straight from here and must not see a stale one.
        return refreshed ?? { ...chat, trunkConflicts: state.conflicts }
      }

      const restored = yield* promise(() =>
        store.updateChatReturning(
          {
            _id: chat._id,
            status: "blocked",
            activeTurnID: { $exists: false },
          },
          {
            $set: {
              status: "ready",
              currentCanonicalSHA: state.head,
              "canonicalCheckout.root": state.root,
              "canonicalCheckout.commonGitDir": commonGitDir,
              "canonicalCheckout.head": state.head,
              ...(state.indexTree ? { "canonicalCheckout.indexTree": state.indexTree } : {}),
              "canonicalCheckout.detached": state.detached,
              ...(state.conflicts.length > 0 ? { trunkConflicts: state.conflicts } : {}),
              ...(state.branch
                ? {
                    arenaBranch: state.branch,
                    "repository.branch": state.branch,
                    "canonicalCheckout.branch": state.branch,
                  }
                : {}),
              updatedAt: new Date(),
            },
            $unset: {
              blockedReason: "",
              ...(state.conflicts.length > 0 ? {} : { trunkConflicts: "" }),
              ...(state.branch
                ? {}
                : {
                    arenaBranch: "",
                    "repository.branch": "",
                    "canonicalCheckout.branch": "",
                  }),
            },
          },
        ),
      )
      return restored ?? (yield* promise(() => store.chat(chat._id))) ?? chat
    })

    /**
     * Ownership is claimed once and never transferred: a chat written before
     * accounts existed takes the owner of whoever resolves it next, and after
     * that the field is immutable.
     */
    const claimOwnership = Effect.fn("Arena.claimOwnership")(function* (
      store: Store,
      chat: ChatDocument,
      sessionID: string,
      userId?: string,
    ) {
      if (!userId || chat.userId) return
      yield* promise(() =>
        store.chats.updateOne(
          { _id: chat._id, userId: { $exists: false } },
          { $set: { userId, updatedAt: new Date() } },
        ),
      )
      // Ratings are keyed by the session the caller named, which is not always
      // the chat's current canonical one after a battle promoted a winner.
      const sessions = new Set([sessionID, chat.canonicalSessionID])
      for (const session of sessions) yield* promise(() => store.adoptSessionRatings(session, userId))
    })

    /**
     * Finish a promotion the moment its conflicts are gone.
     *
     * The voter already chose this winner and asked for it to be applied; the conflict only
     * interrupted that. So there is no button to press afterwards — resolving the files *is* the
     * instruction, and staging them is the deliberate act that says "done". This is not the
     * "nothing drains on its own" rule in reverse: that rule stops Arena *starting* work nobody
     * asked for, and this finishes work already asked for.
     *
     * Runs on the snapshot read the app already polls at 750ms while a battle is active, because
     * a resolution in a terminal emits no event. Forked: a read must not wait on a promotion.
     * Concurrent polls are harmless -- `retryResolution` claims the state transition, so the
     * second caller finds it already claimed and does nothing.
     */
    const resumeResolvedPromotion = Effect.fn("Arena.resumeResolvedPromotion")(function* (
      store: Store,
      chat: ChatDocument,
    ) {
      const turn = yield* parkedPromotionTurn(store, chat)
      // A divergence parks on a question. Its checkout is clean by definition, so resuming on
      // "no unmerged paths" would apply the winner without the answer the callout is asking for.
      if (turn?.gitApplication?.state !== "conflicted") return
      // The agent asked to resolve is still working; a file part way through an edit is not an
      // answer, so the resume waits for the turn to end before reading the markers at all.
      if (activeNormalTurns.active(chat.canonicalSessionID)) return
      const unresolved = yield* withGit(
        unresolvedConflictPaths({
          canonical: chat.repository.root,
          paths: turn.gitApplication.conflicts ?? [],
        }),
      ).pipe(Effect.mapError(error))
      if (unresolved.length > 0) return
      yield* retryResolution(turn._id).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Arena could not resume a resolved promotion", { turnID: turn._id, cause }),
        ),
        Effect.forkIn(scope),
      )
    })

    const ensureChat = Effect.fn("Arena.ensureChat")((rawSessionID: string, rawUserID?: string) =>
      chatCreationLock(rawSessionID).withPermits(1)(
        Effect.gen(function* () {
          const store = yield* available()
          const userId = accountID(rawUserID)
          const existing = yield* promise(() => store.chatForSession(rawSessionID))
          if (existing) {
            yield* claimOwnership(store, existing, rawSessionID, userId)
            // An evicted checkout has no worktree to inspect or resume; restore brings it back.
            if (!existing.checkoutEvicted) {
              yield* reconcileCanonicalAvailability(store, existing)
              yield* resumeResolvedPromotion(store, existing)
            }
            const current = yield* promise(() => store.snapshot(existing._id))
            yield* warmInitialPair(store, current.chat)
            return yield* projectSnapshot(current, -1)
          }

          const sessionID = SessionID.make(rawSessionID)
          const info = yield* sessions.get(sessionID).pipe(Effect.mapError(error))
          const id = chatID(sessionID)
          const state = yield* withGit(inspectCanonical(info.directory)).pipe(Effect.mapError(error))
          const commonGitDir = yield* withGit(repositoryKey(state.root)).pipe(Effect.mapError(error))
          if (yield* promise(() => store.checkoutEviction(state.root))) {
            return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
          }
          const messages = yield* sessions.messages({ sessionID }).pipe(Effect.mapError(error))
          const now = new Date()
          const chatConfiguration = yield* configuration()
          const opencodeCommit = yield* promise(() => resolveBuildCommit())
          yield* withRepositoryMutation(
            commonGitDir,
            promise(() =>
              store.createChat({
                _id: id,
                ...(userId ? { userId } : {}),
                source: {
                  root: state.root,
                  ...(state.branch ? { branch: state.branch } : {}),
                },
                repository: {
                  projectID: info.projectID,
                  root: state.root,
                  ...(state.branch ? { branch: state.branch } : {}),
                },
                ...(state.branch ? { arenaBranch: state.branch } : {}),
                canonicalCheckout: {
                  root: state.root,
                  commonGitDir,
                  ...(state.branch ? { branch: state.branch } : {}),
                  detached: !state.branch,
                  head: state.head,
                  ...(state.indexTree ? { indexTree: state.indexTree } : {}),
                  transcriptHash: digest(messages),
                },
                initialCanonicalSHA: state.head,
                currentCanonicalSHA: state.head,
                canonicalSessionID: sessionID,
                canonicalTranscriptVersion: 1,
                canonicalTranscriptHash: digest(messages),
                turnCount: 0,
                status: "ready",
                ...(state.conflicts.length > 0 ? { trunkConflicts: state.conflicts } : {}),
                opencodeCommit,
                opencodeVersion: InstallationVersion,
                arenaVersion: "prototype-1",
                configuration: chatConfiguration,
                utilityPromptVersion: "arena-comparison-v1",
                createdAt: now,
                updatedAt: now,
              }),
            ),
          )
          if (userId) yield* promise(() => store.adoptSessionRatings(sessionID, userId))
          const current = yield* promise(() => store.snapshot(id))
          yield* warmInitialPair(store, current.chat)
          return yield* projectSnapshot(current, -1)
        }),
      ),
    )

    /** Where a chat keeps its contestant worktrees and their hosts: every generation's pair and the spare. */
    const slotPool = (chat: Pick<ChatDocument, "_id" | "repository">) =>
      join(isolatedRoot(chat.repository.root), chatSlug(chat._id))
    const slotKey = (directory: string) => resolvePath(directory)
    /** One answer for every spelling of a directory, so an owned worktree is never taken for a free one. */
    const directoryIdentity = (directory: string) => {
      try {
        return realpathSync.native(directory)
      } catch {
        return resolvePath(directory)
      }
    }
    const canonicalCommonDir = Effect.fnUntraced(function* (chat: ChatDocument) {
      if (chat.canonicalCheckout?.commonGitDir) return chat.canonicalCheckout.commonGitDir
      const located = yield* git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: chat.repository.root,
      })
      return located.exitCode === 0 ? located.text().trim() : join(chat.repository.root, ".git")
    })

    /**
     * The last process able to write into a worktree is gone; its watch can be settled from here.
     * An earlier stamp stands: whatever starts writing again (`prepareContestant`) clears it, so a
     * stamp still present means nothing has written since.
     */
    const markSlotStopped = (directory: string, at = Date.now()) => {
      const key = slotKey(directory)
      const state = slotStates.get(key)
      if (state?.stoppedAt !== undefined) return
      slotStates.set(key, { ...(state ?? { ignored: new Map(), marks: new Map() }), stoppedAt: at })
    }

    /** Stop following a worktree and forget what this process knew of it: it is leaving. */
    const forgetSlot = Effect.fnUntraced(function* (directory: string) {
      yield* stopPreparation(directory)
      yield* promise(() => slotWatch.stop(directory)).pipe(Effect.ignore)
      slotStates.delete(slotKey(directory))
    })

    /** Put a worktree nothing vouches for in the trash with its host, without asking git about either. */
    const retireSlot = Effect.fnUntraced(function* (chat: ChatDocument, directory: string) {
      yield* forgetSlot(directory)
      yield* inDirectory(chat.repository.root, worktrees.retire(directory)).pipe(Effect.mapError(error))
    })

    /**
     * Empty the trash a chat's worktrees, their hosts and discarded ignored roots are moved into.
     * Only after the adopts that could still be moving an index out of it, and only when it is a
     * directory of its own: from inside a contestant worktree it is `../.trash`, and a sweep
     * through a symlink left there would delete whatever the link points at.
     */
    const sweepSlotTrash = Effect.fnUntraced(function* (chat: ChatDocument, options?: SlotTrashOptions) {
      for (const root of [slotPool(chat), isolatedRoot(chat.repository.root)]) {
        const trash = yield* Effect.promise(() => lstat(join(root, TRASH_DIRNAME)).catch(() => undefined))
        if (trash?.isDirectory()) yield* options?.wait ? worktrees.drainTrash(root) : worktrees.sweepTrash(root)
      }
    })

    /**
     * Take everything out of a chat's worktree directory, for archive and eviction once their
     * own removals are done: free worktrees, the spare, anything left behind, and their hosts.
     * The chat's watches stop with it.
     */
    const retireSlotPool = Effect.fn("Arena.retireSlotPool")(function* (
      chat: ChatDocument,
      options?: SlotTrashOptions,
    ) {
      const pool = slotPool(chat)
      const entries = yield* Effect.promise(() => readdir(pool).catch(() => [] as string[]))
      const directories = new Set(
        entries.flatMap((name) => (name === TRASH_DIRNAME ? [] : [join(pool, hostedWorktree(name) ?? name)])),
      )
      yield* Effect.forEach(
        directories,
        (directory) =>
          retireSlot(chat, directory).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Arena could not retire a chat worktree", { chatID: chat._id, directory, cause }),
            ),
          ),
        { concurrency: 4, discard: true },
      )
      const prefix = `${slotKey(pool)}/`
      yield* Effect.forEach(
        Array.from(slotStates.keys()).filter((key) => key.startsWith(prefix)),
        (key) => forgetSlot(key),
        { discard: true },
      )
      for (const key of Array.from(warmMarks.keys())) {
        if (key.startsWith(`${chat._id}:`)) warmMarks.delete(key)
      }
      yield* promise(() => journal.stop(chat._id)).pipe(Effect.ignore)
      yield* sweepSlotTrash(chat, options)
    })

    /**
     * Sort a chat's worktree directory into the worktrees no run owns and litter. A worktree is
     * owned while a run that has not released it, or `reserved`, names it. A host whose worktree
     * is gone, and anything that is not one of Arena's worktrees (`isPoolWorktree`), is litter:
     * whatever a contestant left beside its worktree, such as `git worktree add ../x`, which
     * every later contestant would otherwise find there.
     */
    const sortSlotPool = Effect.fnUntraced(function* (store: Store, chat: ChatDocument, reserved: ReadonlySet<string>) {
      const pool = slotPool(chat)
      const entries = yield* Effect.promise(() => readdir(pool, { withFileTypes: true }).catch(() => []))
      const runs = yield* promise(() => store.runsForChat(chat._id))
      const owned = new Set(
        [...runs.flatMap((run) => (run.worktreeRemovedAt ? [] : [run.worktree])), ...reserved].map(directoryIdentity),
      )
      const names = new Set(entries.map((entry) => entry.name))
      const unowned: string[] = []
      const litter = new Set<string>()
      for (const entry of entries) {
        if (entry.name === TRASH_DIRNAME) continue
        const hosted = hostedWorktree(entry.name)
        if (hosted !== undefined) {
          const directory = join(pool, hosted)
          if (!names.has(hosted) && !owned.has(directoryIdentity(directory))) litter.add(directory)
          continue
        }
        const directory = join(pool, entry.name)
        if (owned.has(directoryIdentity(directory))) continue
        if (entry.isDirectory() && (yield* Effect.promise(() => isPoolWorktree(directory)))) unowned.push(directory)
        else litter.add(directory)
      }
      return { unowned, litter }
    })

    const retireLitter = (chat: ChatDocument, litter: Iterable<string>, message: string) =>
      Effect.forEach(
        litter,
        (directory) =>
          retireSlot(chat, directory).pipe(
            Effect.catchCause((cause) => Effect.logWarning(message, { chatID: chat._id, directory, cause })),
          ),
        { concurrency: 4, discard: true },
      )

    /**
     * Retire the litter in a chat's worktree directory before a turn's contestants start. The pool
     * is sorted when a pair is prepared after a vote, but a retained winner answering a follow-up,
     * or a terminal opened in a worktree, can leave something there after that. Taken under the
     * repository lock, so a spare being claimed is never caught half made.
     */
    const sweepSlotPool = Effect.fnUntraced(function* (
      store: Store,
      chat: ChatDocument,
      reserved: ReadonlySet<string>,
    ) {
      const { litter } = yield* withRepositoryMutation(
        chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
        sortSlotPool(store, chat, reserved),
      )
      if (litter.size === 0) return
      yield* Effect.logInfo("Arena retires litter from a chat's worktree directory", {
        chatID: chat._id,
        entries: Array.from(litter, (directory) => basename(directory)).join(", "),
      })
      yield* retireLitter(chat, litter, "Arena could not retire litter from a chat's worktree directory")
    })

    /**
     * Sort a chat's worktree directory (`sortSlotPool`) and retire the litter. An unowned worktree
     * is free unless one of the `working` directories is in it. Free worktrees this process has a
     * record of come first, since their ignored content can be kept, then the most recently used.
     */
    const scanSlotPool = Effect.fn("Arena.scanSlotPool")(function* (
      store: Store,
      chat: ChatDocument,
      reserved: ReadonlySet<string>,
      working: readonly WorkingProcess[] | undefined,
    ) {
      const { unowned, litter } = yield* sortSlotPool(store, chat, reserved)
      const free: { readonly directory: string; readonly known: boolean; readonly usedAt: number }[] = []
      const occupied: string[] = []
      const occupiers = new Map<number, string>()
      for (const directory of unowned) {
        // A process working in a free worktree, a terminal's shell the user left open above all,
        // would follow it into the next pair and write there. In the trash it writes into a tree
        // that is being deleted, as it did when released worktrees were removed.
        const identities = [resolvePath(directory), directoryIdentity(directory)]
        const inside = working?.filter((entry) =>
          identities.some((id) => entry.directory === id || entry.directory.startsWith(`${id}/`)),
        )
        if (!inside || inside.length > 0) {
          for (const entry of inside ?? []) occupiers.set(entry.pid, entry.directory)
          occupied.push(directory)
          litter.add(directory)
          continue
        }
        const stats = yield* Effect.promise(() => lstat(directory).catch(() => undefined))
        free.push({ directory, known: slotStates.has(slotKey(directory)), usedAt: stats?.mtimeMs ?? 0 })
      }
      if (occupied.length > 0) {
        const commands = yield* Effect.promise(() => processCommands(Array.from(occupiers.keys())))
        yield* Effect.logInfo("Arena retires worktrees a process may still work in", {
          chatID: chat._id,
          directories: occupied.join(", "),
          ...(commands ? { processes: commands } : {}),
          ...(working ? {} : { reason: "the processes' working directories could not be listed" }),
        })
      }
      yield* retireLitter(chat, litter, "Arena could not retire a stray worktree")
      return free
        .toSorted((left, right) => Number(right.known) - Number(left.known) || right.usedAt - left.usedAt)
        .map((slot) => slot.directory)
    })

    /**
     * What the checkout's journal saw of each copied directory root since the mark taken before
     * that root was last cloned into this worktree. A root without a mark counts as changed.
     */
    const observeCanonical = (
      chatID: string,
      marks: ReadonlyMap<string, JournalMark> | undefined,
      roots: readonly string[],
    ): RootObservation => {
      if (!journal.mark(chatID)) {
        return { complete: false, changed: new Set(roots), reason: "the checkout is not being watched" }
      }
      const changed = new Set<string>()
      const unwatched = new Map<string, string>()
      const paths = new Map<string, ReadonlySet<string>>()
      for (const root of roots) {
        const seen = journal.changedSince(chatID, marks?.get(root), [root])
        if (!seen.complete) {
          changed.add(root)
          unwatched.set(root, seen.reason ?? "not watched")
          continue
        }
        if (!seen.changed.has(root)) continue
        changed.add(root)
        const why = seen.unwatched?.get(root)
        if (why !== undefined) unwatched.set(root, why)
        const written = seen.paths?.get(root)
        if (written) paths.set(root, written)
      }
      return {
        complete: true,
        changed,
        ...(unwatched.size > 0 ? { unwatched } : {}),
        ...(paths.size > 0 ? { paths } : {}),
      }
    }

    /** The config and attributes that decide how blobs become files, as the worktree's host has them. */
    const checkoutRules = Effect.fnUntraced(function* (directory: string) {
      const [config, attributes] = yield* Effect.all(
        [
          git.run(["config", "--get-regexp", CHECKOUT_CONFIG], { cwd: directory }),
          Effect.promise(() => readFile(join(hostRepoPath(directory), "info", "attributes"), "utf8").catch(() => "")),
        ],
        { concurrency: 2 },
      )
      return digest([config.exitCode === 0 ? config.text() : "", attributes])
    })

    /**
     * Whether what turns blobs into files differs from the worktree's last sync: the attributes
     * files the base carries, or the config and attributes its host has. The files that sync left
     * untouched hold its conversion, and git skips them while their stat data matches, so such a
     * change reaches them only when all of them are written again. Nothing after the sync would
     * catch it: verification stages the tree through the same stat data.
     */
    const checkoutRulesChanged = Effect.fnUntraced(function* (
      directory: string,
      previous: SlotState["synced"],
      base: ContestantBase,
      rules: string,
    ) {
      if (!previous) return false
      if (previous.rules !== rules) return true
      const moved = (
        [
          [previous.frozenHead, base.frozenHead],
          [previous.indexTree, base.indexTree],
          [previous.workingTree, base.workingTree],
        ] as const
      ).filter(([from, to]) => from !== to)
      const diffs = yield* Effect.forEach(
        moved,
        ([from, to]) =>
          git.run(["diff", "--quiet", "--no-renames", from, to, "--", ":(glob,icase)**/.gitattributes"], {
            cwd: directory,
          }),
        { concurrency: "unbounded" },
      )
      return diffs.some((diff) => diff.exitCode !== 0)
    })

    /**
     * Every tracked file of `workingTree` as it stands in `directory`, keyed by `trackedFileKey`.
     * Taken once a sync has written and verified them, so a file whose key is unchanged at the
     * next sync still holds exactly what this one wrote.
     */
    const trackedFiles = Effect.fnUntraced(function* (directory: string, workingTree: string) {
      const listed = yield* git.run(["ls-tree", "-r", "-z", "--full-tree", workingTree], { cwd: directory })
      if (listed.exitCode !== 0) return undefined
      const entries = listedIndexEntries(listed.text()).flatMap(({ fields: [mode, type, oid], path }) =>
        type === "blob" && mode && oid ? [{ path, entry: `${mode} ${oid}` }] : [],
      )
      const keys = yield* Effect.promise(() => trackedFileKeys(directory, entries))
      return new Set(keys.filter((key): key is bigint => key !== undefined))
    })

    /**
     * Take back the stat data a kept index holds for every file not exactly as the last sync left
     * it, so the sync writes those files from their blobs instead of trusting them.
     *
     * The index came from the worktree's previous occupant, who could leave any stat data in it:
     * git records a file's stat against its blob under whatever config and attributes were in
     * force, and a contestant can write the index itself. An entry is trusted only when it names
     * the blob the last sync wrote to that path and the file's lstat is unchanged since. Every
     * other entry is written back with no stat data, which git reads as a changed file. Returns
     * `rewrite` when nothing can be trusted, since then rebuilding the index is cheaper.
     */
    const distrustChangedFiles = Effect.fnUntraced(function* (
      directory: string,
      files: ReadonlySet<bigint> | undefined,
    ) {
      const listed = yield* git.run(["ls-files", "--stage", "-z"], { cwd: directory })
      if (listed.exitCode !== 0) return { rewrite: true, distrusted: 0 }
      const entries = listedIndexEntries(listed.text()).flatMap(({ fields: [mode, oid, stage], path }) =>
        mode && oid && stage ? [{ path, mode, oid, stage }] : [],
      )
      if (entries.length === 0) return { rewrite: false, distrusted: 0 }
      if (!files || entries.some((entry) => entry.stage !== "0")) return { rewrite: true, distrusted: entries.length }
      // A gitlink's directory is not a file the checkout writes.
      const candidates = entries.filter((entry) => entry.mode !== "160000")
      const keys = yield* Effect.promise(() =>
        trackedFileKeys(
          directory,
          candidates.map((entry) => ({ path: entry.path, entry: `${entry.mode} ${entry.oid}` })),
        ),
      )
      const distrusted = candidates.filter((_, index) => {
        const key = keys[index]
        return key === undefined || !files.has(key)
      })
      if (distrusted.length === 0) return { rewrite: false, distrusted: 0 }
      // Under `core.ignoreStat` these entries would come back assume-unchanged, and the sync would
      // take the flags for a contestant's and rebuild the whole index.
      const written = yield* git.run(["update-index", "-z", "--index-info"], {
        cwd: directory,
        env: STAT_TRACKED,
        stdin: Stream.make(
          encoder.encode(distrusted.map((entry) => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join("")),
        ),
      })
      if (written.exitCode !== 0) return { rewrite: true, distrusted: entries.length }
      return { rewrite: false, distrusted: distrusted.length }
    })

    /**
     * Bring a contestant worktree whose git metadata is in place, adopted behind a fresh host or
     * just created, to exactly `base` plus the manifest's ignored content, then prove it. Every
     * path runs this one routine, so a worktree an earlier contestant used and one checked out a
     * moment ago are prepared, and checked, the same way.
     *
     * `observeSlot` reads what the worktree's own watch saw since its last sync. It runs after the
     * git sync, which writes nothing under an ignored root, so a refresh in place settles its watch
     * while git works.
     */
    const prepareSlotContent = Effect.fn("Arena.prepareSlotContent")(function* (input: {
      readonly chat: ChatDocument
      readonly directory: string
      readonly branch?: string
      readonly base: ContestantBase
      readonly manifest: CopyManifest
      readonly observeSlot: Effect.Effect<RootObservation>
      /** The index was rebuilt without stat data, so every file is written anyway. */
      readonly indexRebuilt?: boolean
      readonly signal?: AbortSignal
    }) {
      const key = slotKey(input.directory)
      const previous = slotStates.get(key)
      const expected = {
        worktree: input.directory,
        frozenHead: input.base.frozenHead,
        indexTree: input.base.indexTree,
        workingTree: input.base.workingTree,
        ...(input.branch ? { branch: input.branch } : {}),
      }

      const gitStarted = performance.now()
      const rules = yield* checkoutRules(input.directory)
      const rulesChanged =
        input.indexRebuilt === true ||
        (yield* checkoutRulesChanged(input.directory, previous?.synced, input.base, rules))
      const trust = rulesChanged
        ? { rewrite: true, distrusted: 0 }
        : yield* distrustChangedFiles(input.directory, previous?.files)
      const rewrite = rulesChanged || trust.rewrite
      yield* withGit(syncContestantState({ ...expected, forceCheckout: rewrite })).pipe(Effect.mapError(error))
      // A fresh host leaves Arena's private refs out by filtering loose and packed refs, which a
      // reftable host does not have: its copy carries every battle ref the checkout has, and
      // verification refuses them.
      const privateRefs = yield* git.run(["for-each-ref", "--format=%(refname)", ...PRIVATE_REF_PREFIXES], {
        cwd: input.directory,
      })
      const stale = privateRefs
        .text()
        .split("\n")
        .filter((ref) => ref.length > 0 && ref !== `refs/heads/${input.branch}`)
      if (stale.length > 0) {
        const deleted = yield* git.run(["update-ref", "--stdin"], {
          cwd: input.directory,
          stdin: Stream.make(encoder.encode(stale.map((ref) => `delete ${ref}\n`).join(""))),
        })
        if (deleted.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(
              `Could not remove Arena's refs from ${input.directory}: ${deleted.stderr.toString("utf8").trim()}`,
            ),
          )
        }
      }
      const gitMs = Math.round(performance.now() - gitStarted)

      const slot = yield* input.observeSlot
      const ignoredStarted = performance.now()
      const roots = copiedDirectoryRoots(input.manifest)
      // Covered before the mark below, so a write any clone could have missed lands after it.
      yield* promise(() => journal.begin(input.chat._id, input.chat.repository.root, roots))
      // Taken before the checkout is read for the plan, not before the apply: a patch brings over
      // only the paths the journal named by then, so a write the journal delivers between the
      // plan and the apply has to fall after the mark to be brought over at the next sync. A
      // clone after the mark only makes that next sync look at what it already copied.
      yield* promise(() => journal.renew(input.chat._id))
      const mark = journal.mark(input.chat._id)
      // Exact names: a trimmed listing would fold a contestant's `.env ` into the copied `.env`.
      const slotRoots = yield* promise(() => listIgnoredRoots(input.directory))
      const plan = yield* promise(() =>
        planIgnoredResync({
          targetRoot: input.directory,
          manifest: input.manifest,
          slotRoots,
          ...(previous ? { records: previous.ignored } : {}),
          canonical: observeCanonical(input.chat._id, previous?.marks, roots),
          slot,
        }),
      )
      const complete = Effect.gen(function* () {
        const applied = yield* promise(() =>
          applyIgnoredResync({ targetRoot: input.directory, manifest: input.manifest, plan, signal: input.signal }),
        ).pipe(
          // A stopped copy leaves some roots discarded and others half cloned. With no record, the
          // next sync of this worktree checks out and clones everything again.
          Effect.tapError(() => Effect.sync(() => input.signal?.aborted && slotStates.delete(key))),
        )
        // A kept root is still vouched for since its earlier clone; a patched or cloned one since this mark.
        const marks = new Map<string, JournalMark>()
        for (const root of roots) {
          const record = applied.records.get(root)
          const since = record !== undefined && record === plan.records.get(root) ? previous?.marks.get(root) : mark
          if (since) marks.set(root, since)
        }
        const ignoredMs = Math.round(performance.now() - ignoredStarted)

        const verifyStarted = performance.now()
        yield* withGit(verifyContestantState(expected)).pipe(Effect.mapError(error))
        const listed = new Set(yield* promise(() => listIgnoredRoots(input.directory)))
        const wanted = new Set(copiedRoots(input.manifest))
        const extra = [...listed].filter((root) => !wanted.has(root)).sort()
        const missing = [...wanted].filter((root) => !listed.has(root)).sort()
        if (extra.length > 0 || missing.length > 0) {
          return yield* Effect.fail(
            new Error(
              `Contestant worktree ${input.directory} does not hold the checkout's ignored content: extra ${extra.slice(0, 20).join(", ") || "none"}; missing ${missing.slice(0, 20).join(", ") || "none"}`,
            ),
          )
        }
        const files = yield* trackedFiles(input.directory, input.base.workingTree)
        const verifyMs = Math.round(performance.now() - verifyStarted)

        // From the end of this sync's own writes until the worktree's next sync.
        yield* promise(() => slotWatch.begin(input.directory, roots))
        const syncedAt = Date.now()
        slotStates.set(key, {
          ignored: applied.records,
          marks,
          synced: { ...input.base, rules },
          ...(files ? { files } : {}),
          syncedAt,
          // The sync was the last writer; whatever runs here next clears this until it is stopped.
          stoppedAt: syncedAt,
          ...(previous?.metadataFingerprint ? { metadataFingerprint: previous.metadataFingerprint } : {}),
        })
        return {
          timings: {
            gitMs,
            ignoredMs,
            verifyMs,
            recloned: applied.recloned,
            kept: applied.kept,
            patched: applied.patched,
            patchedPaths: applied.patchedPaths,
            discarded: applied.discarded,
            distrusted: trust.distrusted,
            rewroteAll: rewrite,
          },
          reasons: { ...plan.reasons, ...applied.unpatched },
        }
      })
      return { removedPaths: plan.discard, complete }
    })

    const syncSlotContent = Effect.fn("Arena.syncSlotContent")(function* (
      input: Parameters<typeof prepareSlotContent>[0],
    ) {
      const pending = yield* prepareSlotContent(input)
      return yield* pending.complete
    })

    /**
     * Whether an idle warm worktree still holds the ignored content its sync left: the same roots
     * git lists, and every file root the very file that was cloned. Directory roots are the slot
     * watch's to answer. A process that wrote into the idle worktree outside its copied roots, a
     * cache file say, shows up here as a root the checkout does not have.
     */
    const slotHoldsManifest = Effect.fnUntraced(function* (directory: string, manifest: CopyManifest) {
      const state = slotStates.get(slotKey(directory))
      if (!state) return `${basename(directory)} has no record of its ignored content in this process`
      const listed = yield* Effect.promise(() => listIgnoredRoots(directory).catch(() => undefined))
      const wanted = new Set(copiedRoots(manifest))
      if (!listed || listed.length !== wanted.size || listed.some((root) => !wanted.has(root))) {
        return `${basename(directory)} holds ignored content the checkout does not`
      }
      const files = manifest.entries.filter((entry) => entry.state === "copied" && entry.type !== "directory")
      const moved = yield* Effect.forEach(
        files,
        (entry) =>
          Effect.promise(() => lstat(join(directory, entry.relativePath)).catch(() => undefined)).pipe(
            Effect.map((stats) => {
              const record = state.ignored.get(entry.relativePath)?.targetIdentity
              return (
                !stats ||
                !record ||
                stats.ino !== record.inode ||
                stats.dev !== record.device ||
                stats.size !== record.size ||
                stats.mtimeMs !== record.mtimeMs ||
                stats.ctimeMs !== record.ctimeMs ||
                stats.mode !== record.mode
              )
            }),
          ),
        { concurrency: "unbounded" },
      )
      return moved.some(Boolean) ? `an ignored file in ${basename(directory)} changed since warm-up` : undefined
    })

    const logSlotSync = (
      context: { readonly chatID?: string; readonly turnID?: string; readonly side?: Side; readonly from?: string },
      directory: string,
      sync: SlotSyncTimings,
      reasons?: Readonly<Record<string, string>>,
    ) =>
      Effect.logInfo("Arena slot sync", {
        ...context,
        directory,
        ...sync,
        ...(reasons && Object.keys(reasons).length > 0 ? { reasons: JSON.stringify(reasons).slice(0, 2_000) } : {}),
      })

    /**
     * Register a new contestant worktree at `name` in a fresh host, at `head` and not yet checked
     * out. Whatever was at the path goes to the trash first, host included. The caller holds the
     * repository lock: the host is a copy of the checkout's git directory.
     */
    const claimSlot = Effect.fnUntraced(function* (input: {
      readonly chat: ChatDocument
      readonly name: string
      readonly branch?: string
      readonly head: string
      readonly metadataFingerprint: string
    }) {
      yield* forgetSlot(join(isolatedRoot(input.chat.repository.root), input.name))
      const info = yield* inDirectory(
        input.chat.repository.root,
        worktrees.reclaimWorktreeInfo({ name: input.name, branch: input.branch, isolated: true, freshHost: true }),
      ).pipe(Effect.mapError(error))
      yield* forgetSlot(info.directory)
      yield* inDirectory(input.chat.repository.root, worktrees.attachAt(info, input.head, { reset: true })).pipe(
        Effect.mapError(error),
      )
      slotStates.set(slotKey(info.directory), {
        ignored: new Map(),
        marks: new Map(),
        metadataFingerprint: input.metadataFingerprint,
      })
      return info
    })

    /**
     * Move a free worktree to `to` behind a fresh host, keeping its files and index so only what
     * changed since its last sync is written again. Its watch is read no sooner than
     * SLOT_WATCH_SETTLE_MS after the last process that could write into it stopped; a warm
     * worktree's instance is stopped here for that. A watch follows the path it was opened on, so
     * a worktree that moves is read before it does, and one refreshed where it stands keeps its
     * watch through the adopt and is read by `observeSlot`, while its git sync runs.
     */
    const adoptSlot = Effect.fnUntraced(function* (input: {
      readonly chat: ChatDocument
      readonly from: string
      readonly to: string
      readonly name: string
      readonly branch?: string
      readonly head: string
      readonly roots: readonly string[]
      readonly metadataFingerprint: string
    }) {
      const fromKey = slotKey(input.from)
      const inPlace = fromKey === slotKey(input.to)
      if (slotStates.has(fromKey) && slotStates.get(fromKey)?.stoppedAt === undefined) {
        yield* stopPreparation(input.from)
        yield* instances.disposeDirectory(input.from)
        markSlotStopped(input.from)
      }
      const state = slotStates.get(fromKey)
      const settle = Effect.gen(function* () {
        if (state?.stoppedAt !== undefined) {
          const wait = SLOT_WATCH_SETTLE_MS - (Date.now() - state.stoppedAt)
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
        }
        return slotWatch.settle(input.from, input.roots)
      })
      const observed = inPlace ? undefined : yield* settle
      yield* stopPreparation(input.from)
      if (!inPlace) yield* promise(() => slotWatch.stop(input.from)).pipe(Effect.ignore)
      slotStates.delete(fromKey)
      const adopted = yield* inDirectory(
        input.chat.repository.root,
        worktrees.adopt({
          from: input.from,
          to: input.to,
          name: input.name,
          ...(input.branch ? { branch: input.branch } : {}),
          head: input.head,
        }),
      ).pipe(Effect.mapError(error))
      if (!inPlace) yield* forgetSlot(adopted.directory)
      slotStates.set(slotKey(adopted.directory), {
        ignored: state?.ignored ?? new Map(),
        marks: state?.marks ?? new Map(),
        ...(state?.synced ? { synced: state.synced } : {}),
        ...(state?.files ? { files: state.files } : {}),
        metadataFingerprint: input.metadataFingerprint,
      })
      return { info: adopted, observeSlot: observed ? Effect.succeed(observed) : settle }
    })

    const copyManifestByID = Effect.fn("Arena.copyManifestByID")(function* (
      store: Store,
      manifestID: string,
      turnID?: string,
    ) {
      const artifact = yield* promise(() => store.artifacts.findOne({ _id: manifestID, ...(turnID ? { turnID } : {}) }))
      if (!artifact) return yield* Effect.fail(new Error(`Arena copy manifest is missing: ${manifestID}`))
      const manifest = yield* Effect.try({
        try: () => JSON.parse(artifact.data.toString("utf8")) as CopyManifest,
        catch: error,
      })
      if (manifest.manifestID !== manifestID || manifest.canonicalRoot.length === 0) {
        return yield* Effect.fail(new Error(`Arena copy manifest is invalid: ${manifestID}`))
      }
      return manifest
    })

    const copyManifestForTurn = Effect.fn("Arena.copyManifestForTurn")(function* (store: Store, turn: TurnDocument) {
      const cached = turnCopyManifests.get(turn._id)
      if (cached) return cached
      const manifestID = turn.copySnapshot?.manifestID
      if (!manifestID) return yield* Effect.fail(new Error(`Arena turn has no copy manifest: ${turn._id}`))
      const manifest = yield* copyManifestByID(store, manifestID, turn._id)
      turnCopyManifests.set(turn._id, manifest)
      return manifest
    })

    const descendants = Effect.fn("Arena.descendants")(function* (root: SessionID) {
      const result: SessionID[] = []
      const visit = (parent: SessionID): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const child of yield* sessions.children(parent)) {
            result.push(child.id)
            yield* visit(child.id)
          }
        })
      yield* visit(root)
      return result
    })

    const archive = Effect.fn("Arena.archive")(function* (
      store: Store,
      turn: TurnDocument,
      run: SideRuntime,
      runState: RunDocument["runState"],
      runError?: string,
    ) {
      const ids = [run.sessionID, ...(yield* descendants(run.sessionID))]
      const [pendingPermissions, pendingQuestions] = yield* inDirectory(
        run.worktree.directory,
        Effect.all([permissions.list(), questions.list()]),
      )
      const archived: ArchivedSessionPayload[] = []
      for (const id of ids) {
        const [info, messages] = yield* Effect.all([
          sessions.get(id).pipe(Effect.mapError(error)),
          sessions.messages({ sessionID: id }).pipe(Effect.mapError(error)),
        ])
        const blindedMessages = ArenaPrivacy.messages(messages)
        archived.push({
          sessionID: id,
          parentSessionID: info.parentID,
          metadata: JSON.parse(JSON.stringify(ArenaPrivacy.sessionInfo(info))) as Record<string, unknown>,
          messages: JSON.parse(JSON.stringify(blindedMessages)) as ReadonlyArray<Readonly<Record<string, unknown>>>,
          runState,
          ...(runError ? { error: runError } : {}),
          permissionState: pendingPermissions.filter((item) => item.sessionID === id),
          questionState: pendingQuestions.filter((item) => item.sessionID === id),
          ...(blindedMessages.length
            ? {
                messageBoundary: {
                  first: blindedMessages[0].info.id,
                  last: blindedMessages[blindedMessages.length - 1].info.id,
                },
              }
            : {}),
        })
      }
      const encoded = ArenaTranscriptArtifact.encode(archived)
      const artifactID = `${run.runID}|transcript`
      const artifact = yield* promise(() =>
        store.storeArtifact({
          _id: artifactID,
          runID: run.runID,
          turnID: turn._id,
          kind: "transcript",
          mimeType: "application/json",
          encoding: "json",
          compression: encoded.compression,
          data: encoded.data,
          createdAt: new Date(),
        }),
      )
      const document: SessionArchiveDocument = {
        _id: `${run.runID}|archive`,
        runID: run.runID,
        rootSessionID: run.sessionID,
        sessions: archived.map((item) => ({
          sessionID: item.sessionID,
          ...(item.parentSessionID ? { parentSessionID: item.parentSessionID } : {}),
          runState: item.runState,
          ...(item.error ? { error: item.error } : {}),
          messageCount: item.messages.length,
          ...(item.messageBoundary ? { messageBoundary: item.messageBoundary } : {}),
        })),
        artifactIDs: [artifactID],
        contentHash: digest(archived),
        serializationVersion: "v1",
        originalSize: encoded.originalSize,
        storedSize: artifact.storedSize,
        truncated: artifact.truncated,
        createdAt: new Date(),
      }
      yield* promise(() => store.saveSessionArchive(document))
      const root = archived.find((item) => item.sessionID === run.sessionID)
      const storedRun = yield* promise(() => store.run(run.runID))
      const hidden = new Set(
        Object.values(turn.placement).flatMap((assignment) => [
          assignment.assignmentID,
          ...(assignment.model ? [assignment.model] : []),
        ]),
      )
      const transcript = comparisonTimeline(root?.messages ?? [], storedRun?.promptMessageID, hidden)
      yield* promise(() =>
        store.updateRun(run.runID, {
          descendantSessionIDs: ids.slice(1),
          transcriptArchiveID: document._id,
          archiveComplete: true,
          archivedAt: new Date(),
        }),
      )
      return {
        artifactID,
        transcript,
      }
    })

    /**
     * Whether a run's transcript is durably archived. Existence only — so the artifacts are
     * counted rather than loaded. They hold the serialized transcript, up to
     * `MAX_ARTIFACT_BYTES` each, and this used to pull all of it out of Mongo to answer a
     * boolean, on the vote's critical path.
     */
    const archiveRetained = (store: Store, run: RunDocument) =>
      promise(async () => {
        if (!run.archiveComplete || !run.transcriptArchiveID) return false
        const manifest = await store.sessionArchives.findOne(
          { _id: run.transcriptArchiveID, runID: run._id },
          { projection: { artifactIDs: 1 } },
        )
        if (!manifest || manifest.artifactIDs.length === 0) return false
        const present = await Promise.all(
          manifest.artifactIDs.map((id) => store.artifacts.findOne({ _id: id }, { projection: { _id: 1 } })),
        )
        return present.every((artifact) => artifact !== null)
      })

    const ensureArchives = Effect.fn("Arena.ensureArchives")(function* (store: Store, turn: TurnDocument) {
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const retained = yield* Effect.forEach(runs, (run) => archiveRetained(store, run))
      const missing = runs.filter((_, index) => !retained[index])
      yield* Effect.forEach(
        missing,
        (run) =>
          archive(
            store,
            turn,
            {
              side: run.side,
              turnID: run.turnID,
              runID: run._id,
              sessionID: SessionID.make(run.rootSessionID),
              worktree: { name: `turn-${turn.turnIndex}-${run.side}`, directory: run.worktree },
              assignment: run.assignment,
            },
            run.runState,
            run.error,
          ),
        { concurrency: 2, discard: true },
      )
      // Nothing was missing, so the check above is the verification — re-running it would only
      // ask Mongo the same question twice on the way to a vote's result.
      if (missing.length === 0) return runs
      const refreshed = yield* promise(() => store.runsForTurn(turn._id))
      const verified = yield* Effect.forEach(refreshed, (run) => archiveRetained(store, run))
      const incomplete = refreshed.filter((_, index) => !verified[index])
      if (incomplete.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Arena transcript archives are incomplete for: ${incomplete.map((run) => run.side.toUpperCase()).join(", ")}`,
          ),
        )
      }
      return refreshed
    })

    const recordCanonicalTranscript = Effect.fn("Arena.recordCanonicalTranscript")(function* (
      store: Store,
      id: string,
      messages: SessionV1.WithParts[],
    ) {
      const hash = digest(messages)
      const chat = yield* promise(() => store.chat(id))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${id}`))
      if (chat.canonicalTranscriptHash === hash) return chat
      const updated = yield* promise(() =>
        store.updateChatReturning(
          { _id: id, canonicalTranscriptHash: chat.canonicalTranscriptHash },
          {
            $set: { canonicalTranscriptHash: hash, updatedAt: new Date() },
            $inc: { canonicalTranscriptVersion: 1 },
          },
        ),
      )
      if (updated) return updated
      const current = yield* promise(() => store.chat(id))
      if (current?.canonicalTranscriptHash === hash) return current
      return yield* Effect.fail(new Error(`Arena canonical transcript update lost a concurrent change: ${id}`))
    })

    const reconcileNormalTurn = Effect.fn("Arena.reconcileNormalTurn")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if (!enabled()) return
      const store = yield* getStore
      const rating = yield* promise(() => store.singleAgentRating(input.sessionID, input.messageID))
      if (!rating) return
      const transcript = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.mapError(error))
      const message = transcript.find((item) => item.info.id === input.messageID)
      if (
        message?.info.role !== "user" ||
        message.info.model.providerID !== ProviderV2.ID.make("arena") ||
        message.info.model.modelID !== ModelV2.ID.make(contestant.id)
      )
        return
      if (
        !transcript.some(
          (candidate) => candidate.info.role === "assistant" && candidate.info.parentID === message.info.id,
        )
      )
        return
      yield* promise(() => store.completeSingleAgentRating(input))
      const chat = yield* promise(() => store.chatForSession(input.sessionID))
      if (!chat || chat.status !== "ready" || chat.canonicalSessionID !== input.sessionID) return
      const state = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
      if (state.root !== chat.repository.root) return
      if (state.conflicts.length === 0) {
        const result = yield* withRepositoryMutation(
          chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
          withGit(
            snapshotBase({
              canonical: chat.repository.root,
              permanentRef: singleAgentResultRef(chat._id, rating._id),
            }),
          ),
        ).pipe(Effect.mapError(error))
        if (result.root !== chat.repository.root) return
        yield* promise(() =>
          store.recordSingleAgentResult({
            sessionID: input.sessionID,
            messageID: input.messageID,
            precedingTurnCount: chat.turnCount,
            resultTree: result.baseTree,
          }),
        )
      }
      yield* promise(() =>
        store.updateChatReturning(
          {
            _id: chat._id,
            status: "ready",
            currentCanonicalSHA: chat.currentCanonicalSHA,
            canonicalSessionID: input.sessionID,
            canonicalTranscriptHash: chat.canonicalTranscriptHash,
          },
          {
            $set: {
              currentCanonicalSHA: state.head,
              canonicalTranscriptHash: digest(transcript),
              "canonicalCheckout.head": state.head,
              ...(state.indexTree ? { "canonicalCheckout.indexTree": state.indexTree } : {}),
              "canonicalCheckout.detached": state.detached,
              ...(state.conflicts.length > 0 ? { trunkConflicts: state.conflicts } : {}),
              ...(state.branch
                ? {
                    arenaBranch: state.branch,
                    "repository.branch": state.branch,
                    "canonicalCheckout.branch": state.branch,
                  }
                : {}),
              updatedAt: new Date(),
            },
            ...(state.branch && state.conflicts.length > 0
              ? {}
              : {
                  $unset: {
                    ...(state.branch
                      ? {}
                      : {
                          arenaBranch: "",
                          "repository.branch": "",
                          "canonicalCheckout.branch": "",
                        }),
                    ...(state.conflicts.length > 0 ? {} : { trunkConflicts: "" }),
                  },
                }),
            $inc: { canonicalTranscriptVersion: 1 },
          },
        ),
      )
    })
    /**
     * A promotion parked on the user, and the only moment an ordinary turn may run inside an
     * unresolved battle. `isParkedPromotion` names the states: in each one Arena is not writing,
     * so an agent running there races nothing -- and the prompt is how the developer gets help
     * with the thing Arena is parked on. Every other unresolved turn still owns the checkout.
     */
    const parkedPromotionTurn = Effect.fn("Arena.parkedPromotionTurn")(function* (
      store: Store,
      chat: ChatDocument,
    ) {
      if (chat.status !== "battle_active" || !chat.activeTurnID) return undefined
      const turn = yield* promise(() => store.turn(chat.activeTurnID!))
      // `isParkedPromotion` is shared with the HTTP mutation guard, which runs first and would
      // otherwise refuse the prompt before this ever sees it.
      return turn && isParkedPromotion(turn) ? turn : undefined
    })

    const beginNormalTurn = Effect.fn("Arena.beginNormalTurn")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if (!enabled()) return undefined
      const store = yield* available()
      const assignModel = ensureSingleAgentRating(input.sessionID, input.messageID).pipe(
        Effect.map(
          (): NormalTurnStart => ({
            model: { providerID: ProviderV2.ID.make("arena"), modelID: ModelV2.ID.make(contestant.id) },
          }),
        ),
      )
      const chat = yield* promise(() => store.chatForSession(input.sessionID))
      if (!chat || chat.canonicalSessionID !== input.sessionID) return yield* assignModel
      const repairing = (yield* parkedPromotionTurn(store, chat)) !== undefined
      if (chat.status !== "ready" && !repairing) {
        return yield* Effect.fail(new Error("Arena chat already has an active battle"))
      }
      if (activatingBattles.has(input.sessionID))
        return yield* Effect.fail(new Error("Arena chat already has an active battle"))
      // Normal execution is process-local. Reserve before its final durable readiness check so a
      // Battle that races after this point observes the reservation; if Battle won before it,
      // the check below rejects the prompt and releases the reservation.
      activeNormalTurns.reserve(input.sessionID)
      if (activatingBattles.has(input.sessionID)) {
        activeNormalTurns.release(input.sessionID)
        return yield* Effect.fail(new Error("Arena chat already has an active battle"))
      }
      const current = yield* promise(() => store.chat(chat._id)).pipe(
        Effect.onError(() => Effect.sync(() => activeNormalTurns.release(input.sessionID))),
      )
      const parked = current ? yield* parkedPromotionTurn(store, current) : undefined
      const stillRepairing = parked !== undefined
      if (
        current?.canonicalSessionID !== input.sessionID ||
        current.checkoutEvicted ||
        (current.status !== "ready" && !stillRepairing)
      ) {
        activeNormalTurns.release(input.sessionID)
        return yield* Effect.fail(new Error("Arena chat already has an active battle"))
      }
      const checkoutRoot = current.canonicalCheckout?.root ?? current.repository.root
      if (yield* promise(() => store.checkoutEviction(checkoutRoot))) {
        activeNormalTurns.release(input.sessionID)
        return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
      }
      const canonical = yield* withGit(inspectCanonical(current.repository.root)).pipe(
        Effect.mapError(error),
        Effect.onError(() => Effect.sync(() => activeNormalTurns.release(input.sessionID))),
      )
      yield* withRepositoryMutation(
        current.canonicalCheckout?.commonGitDir ?? current.repository.root,
        Effect.gen(function* () {
          const latest = yield* promise(() => store.chat(current._id))
          if (
            !latest ||
            (latest.status !== "ready" && !stillRepairing) ||
            latest.checkoutEvicted ||
            (yield* promise(() => store.checkoutEviction(checkoutRoot)))
          ) {
            return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
          }
          yield* promise(() =>
            store.updateChat(
              { _id: current._id, status: "ready", canonicalSessionID: input.sessionID },
              {
                $set: {
                  currentCanonicalSHA: canonical.head,
                  "canonicalCheckout.head": canonical.head,
                  ...(canonical.indexTree ? { "canonicalCheckout.indexTree": canonical.indexTree } : {}),
                  "canonicalCheckout.detached": canonical.detached,
                  ...(canonical.conflicts.length > 0 ? { trunkConflicts: canonical.conflicts } : {}),
                  ...(canonical.branch
                    ? {
                        arenaBranch: canonical.branch,
                        "repository.branch": canonical.branch,
                        "canonicalCheckout.branch": canonical.branch,
                      }
                    : {}),
                  updatedAt: new Date(),
                },
                ...(canonical.branch && canonical.conflicts.length > 0
                  ? {}
                  : {
                      $unset: {
                        ...(canonical.branch
                          ? {}
                          : {
                              arenaBranch: "",
                              "repository.branch": "",
                              "canonicalCheckout.branch": "",
                            }),
                        ...(canonical.conflicts.length > 0 ? {} : { trunkConflicts: "" }),
                      },
                    }),
              },
            ),
          )
        }),
      ).pipe(Effect.onError(() => Effect.sync(() => activeNormalTurns.release(input.sessionID))))
      const note = parked ? unappliedWinnerNote(parked) : undefined
      return yield* assignModel.pipe(
        Effect.map((start): NormalTurnStart => (note ? { ...start, note } : start)),
        Effect.onError(() => Effect.sync(() => activeNormalTurns.release(input.sessionID))),
      )
    })
    /**
     * An agent asked for help during a review may have settled some of it -- combined two
     * branches, or committed what the review was asking about. Plan again once it ends: settled
     * refs leave the review, and a review with nothing left applies.
     */
    const replanReview = Effect.fn("Arena.replanReview")(function* (sessionID: SessionID) {
      if (!enabled()) return
      const store = yield* getStore
      const chat = yield* promise(() => store.chatForSession(sessionID))
      if (!chat) return
      const turn = yield* parkedPromotionTurn(store, chat)
      if (turn?.gitApplication?.state !== "review") return
      yield* retryResolution(turn._id)
    })
    const recordNormalTurn = (input: { sessionID: SessionID; messageID: MessageID }) =>
      reconcileNormalTurn(input).pipe(
        Effect.catchCause((cause) => Effect.logError("Arena normal-turn reconciliation failed", { cause })),
        Effect.ensuring(Effect.sync(() => activeNormalTurns.release(input.sessionID))),
        Effect.andThen(
          replanReview(input.sessionID).pipe(
            Effect.catchCause((cause) => Effect.logDebug("Arena could not plan a review again", { cause })),
            Effect.forkIn(scope),
          ),
        ),
      )

    const singleAgentVote = Effect.fn("Arena.singleAgentVote")(function* (
      rawSessionID: string,
      ratingID: string,
      vote: SingleAgentVote,
      rawParticipantID?: string,
    ) {
      const store = yield* available()
      const chat = yield* promise(() => store.chatForSession(rawSessionID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found for session: ${rawSessionID}`))
      if (chat.checkoutEvicted) return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
      const admittedParticipantID = yield* Effect.try({
        try: () => participantID(rawParticipantID),
        catch: error,
      })
      const resolved = yield* promise(() => resolveAssignments("single", ratingID, `rate:${vote}`))
      const committedVote = resolved.decision === "rate:up" ? "up" : "down"
      const model = resolved.assignments[0]?.model
      if (!model) return yield* Effect.fail(new Error("Arena single-agent reveal is invalid"))
      yield* promise(() =>
        store.recordSingleAgentVote({
          sessionID: rawSessionID,
          ratingID,
          vote: committedVote,
          model,
          ...(admittedParticipantID ? { participantID: admittedParticipantID } : {}),
        }),
      )
      return yield* projectSnapshot(yield* promise(() => store.snapshot(chat._id)), -1)
    })

    const finalizeSide = Effect.fn("Arena.finalizeSide")(function* (
      store: Store,
      turn: TurnDocument,
      run: SideRuntime,
      promptExit: Exit.Exit<SessionV1.WithParts | void, unknown>,
      stopped: boolean,
      runStateOverride?: RunDocument["runState"],
    ) {
      const stored = yield* promise(() => store.run(run.runID))
      const completedAt = stored?.completedAt ?? new Date()
      const assistant =
        Exit.isSuccess(promptExit) && promptExit.value?.info.role === "assistant" ? promptExit.value.info : undefined
      const ids = [run.sessionID, ...(yield* descendants(run.sessionID))]
      const [sessionStates, pendingPermissions, pendingQuestions] = yield* inDirectory(
        run.worktree.directory,
        Effect.all([Effect.forEach(ids, (sessionID) => statuses.get(sessionID)), permissions.list(), questions.list()]),
      )
      const unsettled: string[] = []
      if (!stopped && !assistant) unsettled.push("Contestant prompt did not return a terminal assistant message")
      if (!stopped && assistant && (!assistant.time.completed || (!assistant.finish && !assistant.error))) {
        unsettled.push("Contestant assistant message was not terminal")
      }
      if (!stopped && sessionStates.some((state) => state.type !== "idle")) {
        unsettled.push("A contestant session was still active after the prompt settled")
      }
      if (!stopped && pendingPermissions.some((item) => ids.includes(item.sessionID))) {
        unsettled.push("A contestant permission request remained unresolved")
      }
      if (!stopped && pendingQuestions.some((item) => ids.includes(item.sessionID))) {
        unsettled.push("A contestant question remained unresolved")
      }
      // The panes say why a stopped run stopped, so the abort that ends it is not reported here.
      if (assistant?.error && !isStopAbort({ stopped, error: assistant.error })) {
        unsettled.push(`Contestant assistant error: ${JSON.stringify(assistant.error)}`)
      }
      if (Exit.isFailure(promptExit)) unsettled.push(Cause.pretty(promptExit.cause))
      const runState: RunDocument["runState"] =
        runStateOverride ?? (stopped ? "stopped" : unsettled.length === 0 ? "complete" : "error")
      const runError = unsettled.length ? unsettled.join("\n") : undefined
      const durationMs =
        runState === "complete" && stored?.startedAt
          ? Math.max(0, completedAt.getTime() - stored.startedAt.getTime())
          : null
      yield* promise(() =>
        store.updateRun(run.runID, {
          runState,
          durationMs,
          ...(assistant ? { terminalAssistantMessageID: assistant.id } : {}),
          ...(runError ? { error: runError } : {}),
          completedAt,
        }),
      )
      const permanentRef = `${refRoot(turn)}/${run.side}`
      const result = yield* withGit(
        finalize({
          worktree: run.worktree.directory,
          baseSHA: turn.frozenBaseSHA,
          frozenHead: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
          permanentRef,
          ...(stored?.permanentRef === permanentRef && stored.finalCommit
            ? {
                expectedPermanentCommit: stored.finalCommit,
                ...(stored.finalIndexTree ? { expectedFinalIndexTree: stored.finalIndexTree } : {}),
              }
            : {}),
        }),
      ).pipe(Effect.mapError(error))
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      yield* withGit(
        importResultRef({
          canonical: chat.repository.root,
          sourceRepository: run.worktree.host ?? run.worktree.directory,
          sourceRef: result.permanentRef,
          destinationRef: result.permanentRef,
          expectedCommit: result.finalCommit,
          ...(stored?.finalCommit ? { expectedDestinationCommit: stored.finalCommit } : {}),
        }),
      ).pipe(Effect.mapError(error))
      yield* withGit(
        importResultRef({
          canonical: chat.repository.root,
          sourceRepository: run.worktree.host ?? run.worktree.directory,
          sourceRef: result.finalIndexRef,
          destinationRef: result.finalIndexRef,
          expectedCommit: result.finalIndexTree,
          objectType: "tree",
          ...(stored?.finalIndexTree ? { expectedDestinationCommit: stored.finalIndexTree } : {}),
        }),
      ).pipe(Effect.mapError(error))
      // The contestant's real HEAD, which a detached winner's commits hang from and which the
      // wrapper commit does not reach when HEAD left the frozen base's line.
      yield* withGit(
        importWinnerRef({
          canonical: chat.repository.root,
          sourceRepository: run.worktree.directory,
          sourceRef: "HEAD",
          destinationRef: `${permanentRef}-head`,
          expected: result.rawHead,
        }),
      ).pipe(Effect.mapError(error))
      // Every ref the contestant moved, its own branch included. Their objects are imported now,
      // under the run's permanent ref, so the vote can review and apply them without the host.
      const host = run.worktree.host
      let refChanges: readonly RefChange[] = []
      const frozenHead = turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA
      if (!host && result.branch && result.branch === stored?.branchAtRun && result.rawHead !== frozenHead) {
        // A worktree without a host copy has no ref snapshot. Its own branch is the one ref the
        // vote needs, and it started at the frozen head.
        const ref = `refs/heads/${result.branch}`
        refChanges = [{ ref, before: frozenHead, after: result.rawHead }]
        yield* withGit(
          importWinnerRef({
            canonical: chat.repository.root,
            sourceRepository: run.worktree.directory,
            sourceRef: ref,
            destinationRef: `${permanentRef}-refs/heads/${result.branch}`,
            expected: result.rawHead,
          }),
        ).pipe(Effect.mapError(error))
      }
      if (host) {
        refChanges = yield* withGit(diffHostRefs({ host, exclude: [] })).pipe(Effect.mapError(error))
        for (const change of refChanges) {
          if (!change.after) continue
          yield* withGit(
            importWinnerRef({
              canonical: chat.repository.root,
              sourceRepository: host,
              sourceRef: change.ref,
              destinationRef: `${permanentRef}-refs/${change.ref.slice("refs/".length)}`,
              expected: change.after,
            }),
          ).pipe(Effect.mapError(error))
        }
      }
      const diff = result.diff.reduce(
        (total, item) => ({
          files: total.files + 1,
          additions: total.additions + item.additions,
          deletions: total.deletions + item.deletions,
        }),
        { files: 0, additions: 0, deletions: 0 },
      )
      const branchChanged = result.branch !== stored?.branchAtRun
      yield* promise(() =>
        store.updateRun(run.runID, {
          rawHead: result.rawHead,
          ...(result.branch ? { finalBranch: result.branch } : {}),
          branchChanged,
          refChanges,
          ...(result.agentCommit ? { agentCommit: result.agentCommit } : {}),
          agentCommits: result.agentCommits,
          wrapperCreated: result.wrapperCreated,
          finalCommit: result.finalCommit,
          finalTree: result.finalTree,
          finalIndexTree: result.finalIndexTree,
          fullyCommitted: result.fullyCommitted,
          baseIsAncestor: result.baseIsAncestor,
          // Where the winner's history went is the review's question at the vote, not a reason to
          // refuse it here.
          applicability: "applicable",
          permanentRef: result.permanentRef,
          refVerifiedAt: new Date(),
          diff,
        }),
      )
      const archived = yield* archive(store, turn, run, runState, runError)
      return { result, ...archived }
    })

    /**
     * Let a contestant open the uploads its prompt names. A contestant may not read outside its
     * worktree, and each upload sits alone in its own directory, so this admits those files only.
     * A failure leaves the file unreadable to that side rather than failing the turn.
     */
    const allowReading = Effect.fnUntraced(function* (
      worktree: string,
      sessionID: SessionID,
      directories: readonly string[],
    ) {
      if (directories.length === 0) return
      yield* inDirectory(
        worktree,
        Effect.gen(function* () {
          const current = (yield* sessions.get(sessionID)).permission ?? []
          const missing = directories
            .map((directory) => ({
              permission: "external_directory",
              pattern: `${directory}/*`,
              action: "allow" as const,
            }))
            .filter(
              (rule) =>
                !current.some(
                  (existing) =>
                    existing.permission === rule.permission &&
                    existing.pattern === rule.pattern &&
                    existing.action === rule.action,
                ),
            )
          if (missing.length > 0) yield* sessions.setPermission({ sessionID, permission: [...current, ...missing] })
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena could not open uploads to a contestant", { sessionID, cause }),
        ),
      )
    })

    const runPrompt = Effect.fn("Arena.runPrompt")(function* (
      store: Store,
      run: SideRuntime,
      prompt: ArenaAttachments.ContestantPrompt,
      agent: string,
      preservePromptBoundary = false,
      hostDirectory = run.worktree.directory,
    ) {
      const turn = yield* promise(() => store.turn(run.turnID))
      if (turn?.state === "stopping" || turn?.state === "early_selected") return Exit.void
      const storedRun = yield* promise(() => store.run(run.runID))
      yield* inDirectory(run.worktree.directory, permissions.setAutoAccept(storedRun?.autoAccept === true))
      const startedAt = new Date()
      const promptMessageID = MessageID.ascending()
      yield* promise(() =>
        store.updateRun(run.runID, {
          startedAt,
          ...(preservePromptBoundary ? {} : { promptMessageID }),
        }),
      )
      const beforeDispatch = yield* promise(() => store.turn(run.turnID))
      if (beforeDispatch?.state === "stopping" || beforeDispatch?.state === "early_selected") return Exit.void
      yield* allowReading(run.worktree.directory, run.sessionID, prompt.readable)
      if (hostDirectory !== run.worktree.directory) promptHosts.set(run.sessionID, hostDirectory)
      const result = yield* Effect.exit(
        inDirectory(
          hostDirectory,
          prompts.prompt({
            sessionID: run.sessionID,
            messageID: promptMessageID,
            model: {
              providerID: ProviderV2.ID.make("arena"),
              modelID: ModelV2.ID.make(contestant.id),
            },
            agent,
            variant: "high",
            system: contestantSystemInstruction(run.worktree.directory, isToolExecutionGated(run.sessionID)),
            parts: prompt.parts,
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (promptHosts.get(run.sessionID) === hostDirectory) promptHosts.delete(run.sessionID)
            }),
          ),
        ),
      )
      if (Exit.isSuccess(result) && result.value?.info.role === "assistant") {
        const env = previewEnvironment(run.worktree.directory)
        yield* Effect.forEach(result.value.parts, (part) => sessions.updatePart(localizeArenaEnvironment(part, env)), {
          discard: true,
        })
      }
      yield* promise(() => store.updateRun(run.runID, { completedAt: new Date() }))
      return result
    })

    const settleSide = Effect.fn("Arena.settleSide")(function* (
      store: Store,
      turn: TurnDocument,
      run: SideRuntime,
      prompt: ArenaAttachments.ContestantPrompt,
      agent: string,
      preservePromptBoundary = false,
      environmentSettled: Effect.Effect<void> = Effect.void,
      stoppedBySibling: () => boolean = () => false,
    ) {
      const promptExit = yield* runPrompt(store, run, prompt, agent, preservePromptBoundary)
      return yield* settlePromptExit(store, turn, run, promptExit, environmentSettled, stoppedBySibling)
    })

    const settlePromptExit = Effect.fn("Arena.settlePromptExit")(function* (
      store: Store,
      turn: TurnDocument,
      run: SideRuntime,
      promptExit: Exit.Exit<SessionV1.WithParts | void, unknown>,
      environmentSettled: Effect.Effect<void> = Effect.void,
      /** The battle stopped this side because the other side's environment setup failed. */
      stoppedBySibling: () => boolean = () => false,
    ) {
      // Finalization writes Git state too. Even a tool-free answer must wait until the slot's
      // verification has finished observing the frozen tree.
      yield* environmentSettled
      const current = yield* promise(() => store.turn(turn._id))
      const stopped = current?.state === "stopping" || current?.state === "early_selected" || stoppedBySibling()
      const outcome = yield* Effect.exit(finalizeSide(store, turn, run, promptExit, stopped))
      if (Exit.isSuccess(outcome)) {
        const settled = yield* promise(() => store.run(run.runID))
        const selectable =
          !stopped &&
          settled?.runState === "complete" &&
          settled.archiveComplete === true &&
          !!settled.finalCommit &&
          !!settled.finalTree &&
          !!settled.permanentRef
        yield* promise(() => store.updateRun(run.runID, { selectable, finalizedAt: new Date() }))
        yield* promise(() =>
          store.markRunFinalized({
            turnID: turn._id,
            side: run.side,
            selectable,
            at: new Date(),
          }),
        )
        return outcome
      }
      const detail = Cause.pretty(outcome.cause)
      yield* promise(() =>
        store.updateRun(run.runID, {
          runState: "error",
          durationMs: null,
          selectable: false,
          error: `Arena result finalization failed\n${detail}`,
          completedAt: new Date(),
        }),
      )
      const archived = yield* Effect.exit(archive(store, turn, run, "error", detail))
      if (Exit.isSuccess(archived)) {
        yield* promise(() => store.updateRun(run.runID, { selectable: false, finalizedAt: new Date() }))
        yield* promise(() =>
          store.markRunFinalized({
            turnID: turn._id,
            side: run.side,
            selectable: false,
            at: new Date(),
          }),
        )
      }
      return outcome
    })

    // A session runner is registered against the instance that dispatched its prompt: the worktree's,
    // or for an early cold or refreshed request the canonical checkout's. Cancelling from any other
    // instance finds no runner and silently does nothing, leaving the contestant running to
    // completion. Descendant sessions start from tools, which always run in the worktree.
    const cancelRun = Effect.fn("Arena.cancelRun")(function* (directory: string, sessionID: SessionID) {
      const children = yield* descendants(sessionID)
      yield* Effect.all(
        [
          inDirectory(promptHosts.get(sessionID) ?? directory, prompts.cancel(sessionID)),
          inDirectory(
            directory,
            Effect.forEach(children, (id) => prompts.cancel(id), { discard: true }),
          ),
        ],
        { concurrency: 2, discard: true },
      )
    })

    const cancelUntilSettled = Effect.fn("Arena.cancelUntilSettled")(function* (
      store: Store,
      runID: string,
      sessionID: SessionID,
      directory: string,
    ) {
      while (true) {
        const current = yield* promise(() => store.run(runID))
        if (!current || current.runState !== "pending") return
        yield* cancelRun(directory, sessionID)
        yield* Effect.sleep(Duration.millis(25))
      }
    })

    const startUtility = Effect.fn("Arena.startUtility")(function* (
      store: Store,
      turn: TurnDocument,
      a: { result: Pick<FinalizedResult, "finalCommit">; transcript: string; artifactID: string },
      b: { result: Pick<FinalizedResult, "finalCommit">; transcript: string; artifactID: string },
      canonical: string,
    ) {
      yield* promise(() => store.updateTurn(turn._id, { comparisonState: "running" }))
      const evidence = yield* withGit(
        compare({
          canonical,
          baseCommit: turn.frozenBaseSHA,
          aCommit: a.result.finalCommit,
          bCommit: b.result.finalCommit,
        }),
      ).pipe(Effect.mapError(error))
      const patchArtifacts = [
        { id: `${turn._id}|comparison-base-to-a`, patch: evidence.baseToA },
        { id: `${turn._id}|comparison-base-to-b`, patch: evidence.baseToB },
        { id: `${turn._id}|comparison-a-to-b`, patch: evidence.patch },
      ] as const
      yield* Effect.forEach(
        patchArtifacts,
        (artifact) =>
          promise(() =>
            store.storeArtifact({
              _id: artifact.id,
              turnID: turn._id,
              kind: "patch",
              mimeType: "text/x-diff",
              encoding: "utf8",
              compression: "none",
              data: encoder.encode(artifact.patch),
              createdAt: new Date(),
            }),
          ),
        { concurrency: 3, discard: true },
      )
      const comparison = yield* promise(() =>
        generateComparison({
          store,
          turnID: turn._id,
          userPrompt: turn.userPrompt,
          userAttachments: ArenaAttachments.describeForJudge(turn.userAttachments),
          baseCommit: turn.frozenBaseSHA,
          aCommit: a.result.finalCommit,
          bCommit: b.result.finalCommit,
          files: evidence.fileFacts,
          aToB: evidence.patch,
          aToBTruncated: evidence.truncated,
          baseTree: evidence.baseTree,
          aTree: evidence.aTree,
          bTree: evidence.bTree,
          baseToA: evidence.baseToA,
          baseToATruncated: evidence.baseToATruncated,
          baseToB: evidence.baseToB,
          baseToBTruncated: evidence.baseToBTruncated,
          transcriptA: a.transcript,
          transcriptB: b.transcript,
          artifactIDs: [a.artifactID, b.artifactID, ...patchArtifacts.map((artifact) => artifact.id)],
        }),
      )
      yield* promise(() =>
        store.updateTurn(turn._id, {
          comparisonState: comparison.state === "complete" ? "complete" : "failed",
          comparisonID: comparison._id,
        }),
      )
    })

    const finalizeReadyTurn = Effect.fn("Arena.finalizeReadyTurn")(function* (
      store: Store,
      turn: TurnDocument,
      canonical: string,
    ) {
      const currentRecorder = recorder
      if (currentRecorder) yield* promise(() => currentRecorder.flush(turn._id))
      const current = yield* promise(() => store.turn(turn._id))
      if (current?.resolution?.kind === "early" && current.appliedSide) {
        return yield* promote(store, current, current.appliedSide, current.resolution, current.vote, true)
      }
      if (current?.state === "stopping") {
        yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
        return
      }
      const claimed = yield* promise(() => store.claimTurnFinalization(turn._id))
      if (!claimed.claimed) return
      const inputs = yield* Effect.all([comparisonInput(store, turn, "a"), comparisonInput(store, turn, "b")]).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* promise(() => store.updateTurn(turn._id, { comparisonState: "failed" }))
            yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
            yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
            yield* Effect.logError("Arena finalization input failed", { turnID: turn._id, cause })
            return null
          }),
        ),
      )
      if (!inputs) return
      yield* promise(() => store.transitionTurn(turn._id, "awaiting_vote"))
      yield* forkSpareSlot(store, turn, canonical)
      yield* startUtility(store, turn, inputs[0], inputs[1], canonical).pipe(
        Effect.catchCause((cause) =>
          promise(() =>
            store.updateTurn(turn._id, {
              comparisonState: "failed",
              comparisonID: undefined,
            }),
          ).pipe(Effect.andThen(Effect.logWarning("Arena comparison failed", { cause }))),
        ),
        Effect.forkIn(scope),
      )
    })

    /** Every past run's port bank and preview URLs, so a copied transcript can be retargeted. */
    const historicalEnvironmentsForChat = Effect.fn("Arena.historicalEnvironmentsForChat")(function* (
      store: Store,
      chatID: string,
    ) {
      return (yield* promise(() => store.runsForChat(chatID))).map((run) => ({
        portAliases: run.portAliases,
        previewUrls: Object.fromEntries(
          (run.services ?? []).flatMap((service) =>
            service.proxyRoutes.flatMap((route) => (route.alias && route.url ? [[route.alias, route.url]] : [])),
          ),
        ),
      }))
    })

    /** Sessions forked at warm-up that no turn will ever use. */
    const disposeWarmSessions = (ids: readonly (string | undefined)[]) =>
      Effect.forEach(
        ids.flatMap((id) => (id ? [id] : [])),
        (id) => sessions.remove(SessionID.make(id)).pipe(Effect.ignore),
        { discard: true },
      )

    /**
     * Warm slots of these records that no run took over. A slot a send used became that run's
     * worktree, and its forked session became the run's own; only the rest may be removed.
     */
    const unusedWarmSlots = (records: readonly WarmPreparation[], runs: readonly RunDocument[]) => {
      const runPaths = new Set(runs.map((run) => run.worktree))
      const runSessions = new Set(runs.map((run) => run.rootSessionID))
      return records.flatMap((preparation) =>
        Object.values(preparation.worktrees).flatMap((slot) =>
          slot && !runPaths.has(slot.directory)
            ? [
                {
                  ...slot,
                  forkedSessionID: runSessions.has(slot.forkedSessionID ?? "") ? undefined : slot.forkedSessionID,
                },
              ]
            : [],
        ),
      )
    }

    /**
     * Whether the session forked at warm-up is the one this send can prompt. Everything the fork
     * copied has to be unchanged: the canonical session and its transcript, and the port bank its
     * paths were localized against, which is process-local and so also requires a trusted pair.
     */
    const usableWarmFork = (
      trusted: boolean,
      turn: TurnDocument,
      warm: WarmWorktreeRecord,
      directory: string,
      sourceID: string,
      portAliases: PreviewRoute["portAliases"],
    ) => {
      if (!warm.forkedSessionID || !warm.forkMessageMap || !warm.portAliases) return undefined
      if (!trusted) return undefined
      if (warm.directory !== directory) return undefined
      if (warm.forkSourceSessionID !== sourceID || warm.forkTranscriptHash !== turn.canonicalTranscriptHash) {
        return undefined
      }
      if (PORT_ALIASES.some((alias) => warm.portAliases?.[alias] !== portAliases[alias])) return undefined
      return { forkedSessionID: warm.forkedSessionID, forkMessageMap: warm.forkMessageMap }
    }

    /**
     * Fork the canonical session into each warm worktree now rather than at send. The port bank
     * is allocated here too, because the copied transcript is retargeted to it. A fork that fails
     * leaves its slot as it was: the send forks then, as it always could.
     */
    const prepareWarmSessions = Effect.fn("Arena.prepareWarmSessions")(function* (
      store: Store,
      chat: ChatDocument,
      generation: number,
      slots: readonly WarmWorktreeRecord[],
      forked: (sessionID: string) => void,
    ) {
      const current = yield* promise(() => store.chat(chat._id))
      if (!current || current.activeTurnID || current.status === "battle_active") return slots
      const sourceID = SessionID.make(current.canonicalSessionID)
      const source = yield* Effect.exit(sessions.get(sourceID))
      const transcript = yield* Effect.exit(sessions.messages({ sessionID: sourceID }))
      if (Exit.isFailure(source) || Exit.isFailure(transcript)) return slots
      const transcriptHash = digest(transcript.value)
      const agent = source.value.agent ?? "build"
      const branch = current.canonicalCheckout?.branch ?? current.arenaBranch
      const historicalEnvironments = yield* historicalEnvironmentsForChat(store, chat._id)
      // Both forks at once: each writes its own session into its own directory.
      return yield* Effect.forEach(
        slots,
        (slot) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.exit(
              Effect.gen(function* () {
                const preview = yield* promise(() =>
                  allocatePreview({
                    directory: slot.directory,
                    chatID: chat._id,
                    turnIndex: generation,
                    side: slot.side,
                    context: {
                      ...(branch ? { branch } : {}),
                      trunkDirectory: chat.repository.root,
                      trunkBranch: current.canonicalCheckout?.branch ?? current.arenaBranch,
                    },
                  }),
                )
                const env = previewEnvironment(slot.directory)
                const messageMapping = new Map<string, string>()
                const session = yield* forkInto({
                  sessionID: sourceID,
                  destination: slot.directory,
                  roots: { canonical: chat.repository.root, worktree: slot.directory },
                  pathMode: "transcript",
                  onMessageMapping(mapping) {
                    mapping.forEach((target, from) => messageMapping.set(from, target))
                  },
                  part(part, message) {
                    if (message.role === "user") return part
                    const canonicalEnvironment = historicalEnvironments.reduce(
                      (value, historical) => canonicalizeArenaEnvironment(value, historical),
                      part,
                    )
                    return localizeArenaEnvironment(canonicalEnvironment, env)
                  },
                }).pipe(Effect.mapError(error))
                forked(session.id)
                yield* sessions.setAgentModel({
                  sessionID: session.id,
                  agent,
                  model: {
                    providerID: ProviderV2.ID.make("arena"),
                    id: ModelV2.ID.make(contestant.id),
                    variant: "high",
                  },
                  time: Date.now(),
                })
                yield* sessions.setPermission({
                  sessionID: session.id,
                  permission: contestantPermissions(source.value.permission),
                })
                return {
                  ...slot,
                  forkedSessionID: session.id,
                  forkSourceSessionID: sourceID,
                  forkTranscriptHash: transcriptHash,
                  forkMessageMap: Object.fromEntries(messageMapping),
                  portAliases: preview.portAliases,
                } satisfies WarmWorktreeRecord
              }),
            )
            if (Exit.isSuccess(outcome)) return outcome.value
            yield* Effect.logWarning("Arena warm session fork failed; the send will fork instead", {
              chatID: chat._id,
              generation,
              side: slot.side,
              cause: outcome.cause,
            })
            return slot
          }),
        { concurrency: 2 },
      )
    })

    const executeBattle = Effect.fn("Arena.executeBattle")(function* (
      store: Store,
      turn: TurnDocument,
      prompt: ArenaAttachments.ContestantPrompt,
      warmForksTrusted: boolean,
      autoAccept: boolean,
    ) {
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const sourceID = SessionID.make(turn.sourceCanonicalSessionID)
      const source = yield* sessions.get(sourceID).pipe(Effect.mapError(error))
      const agent = source.agent ?? "build"
      const copyManifest = yield* copyManifestForTurn(store, turn)
      const contestantSnapshot = {
        frozenHead: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
        indexTree: turn.baseSnapshot?.indexTree ?? turn.frozenBaseSHA,
        workingTree: turn.baseSnapshot?.tree ?? turn.frozenBaseSHA,
      }
      const discardBattleSeed = Effect.sync(() => {
        turnCopyManifests.delete(turn._id)
      })
      // A losing environment whose process could not be stopped keeps its
      // persistent side branch checked out. Retry that cleanup before touching
      // the retained winner so a failed retry cannot consume the winner's
      // one-shot transition and cannot strand every later battle on the branch.
      yield* retryFailedRunCleanups(store, chat, turn._id).pipe(Effect.onError(() => discardBattleSeed))
      // The previous winner is released while this turn runs. Nothing it records reaches a prompt, so
      // the send waits only when the winner still serves one of its ports: a contestant must not
      // reach the previous preview through a URL in the history. Otherwise the release runs in the
      // background, and its worktree removal takes the repository lock once the sides let go of it.
      // A background release from the previous send may still be running; read the chat after it so
      // this send does not stop and remove the same run again.
      const inFlight = retainedReleases.get(chat._id)
      if (inFlight) yield* trackOperation(store, turn._id, "releasing_environment", Fiber.await(inFlight))
      const releaseChat = inFlight ? ((yield* promise(() => store.chat(chat._id))) ?? chat) : chat
      const retainedServing = yield* retainedWinnerServing(store, releaseChat)
      const releaseRetained = consumeRetainedWinner(store, releaseChat, turn, copyOmissions(copyManifest.entries)).pipe(
        preparationPhase("release-retained-winner", { chatID: chat._id, turnID: turn._id }),
      )
      const retainedRelease = retainedServing ? yield* releaseRetained.pipe(Effect.forkChild) : undefined
      if (!retainedServing) yield* releaseRetainedInBackground(store, releaseChat, releaseRetained)
      const setupWorktrees = new Map<string, Worktree.Info>()
      const previewWorktrees = new Set<string>()
      const environmentSetups = new Map<
        Side,
        { readonly removedPaths: readonly string[]; readonly complete: Effect.Effect<SlotSyncTimings, Error> }
      >()
      const executionGates = new Map<Side, ReturnType<typeof gateToolExecution>>()
      const earlyPrompts = new Map<
        Side,
        {
          readonly fiber: Fiber.Fiber<Exit.Exit<SessionV1.WithParts | void, unknown>, unknown>
          readonly sessionID: SessionID
          readonly directory: string
        }
      >()
      const environmentSettled = {
        a: yield* Deferred.make<void>(),
        b: yield* Deferred.make<void>(),
      }
      const copyStop = new AbortController()
      environmentCopyStops.set(turn._id, copyStop)
      // Sides cancelled because the other side's environment setup failed. They end as stopped
      // sides, not failed ones: nothing went wrong in them.
      const stoppedBySibling = new Set<Side>()
      /** Whether a side's copy ended because the battle was stopped, not because it failed. */
      const copyStopped = (cause: Cause.Cause<unknown>) =>
        copyStop.signal.aborted && Cause.squash(cause) === copyStop.signal.reason
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const gate of executionGates.values()) gate.dispose()
          if (environmentCopyStops.get(turn._id) === copyStop) environmentCopyStops.delete(turn._id)
        }),
      )
      const refreshing = turn.warmPreparation?.state === "pending"
      const sideTimings = new Map<Side, NonNullable<TurnSetupTimings["sides"]>[Side] & SlotSyncTimings>()
      const makeSide = Effect.fnUntraced(function* (side: Side) {
        const sideStartedAt = Date.now()
        let prepareMs = 0
        let forkMs = 0
        let forkedAtWarmup = false
        const branch = (chat.canonicalCheckout?.branch ?? chat.arenaBranch) || undefined
        const worktreeName = contestantWorktreeName(chat._id, turn.turnIndex, side)
        const warm =
          turn.warmPreparation?.state === "ready" || refreshing ? turn.warmPreparation?.worktrees[side] : undefined
        const context = { chatID: chat._id, turnID: turn._id, side }
        // A reused side is complete and prompts in its own instance. A cold or refreshed side is
        // staged at a path known now, so its request can leave from the canonical instance first.
        const reused = warm !== undefined && !refreshing
        // In the resolved form the claim uses, since the request is bound to this exact path.
        const slotRoot = isolatedRoot(yield* promise(() => realpath(chat.repository.root)))
        const plannedDirectory = warm?.directory ?? join(slotRoot, worktreeName)
        let info: Worktree.Info = {
          name: warm?.name ?? worktreeName,
          branch: warm?.branch ?? branch,
          directory: plannedDirectory,
          host: hostRepoPath(plannedDirectory),
        }
        if (reused) setupWorktrees.set(info.directory, info)
        else yield* promise(() => mkdir(info.directory, { recursive: true }))

        // A warm bank was reserved at warm-up. If a port has been taken since, the fresh bank no
        // longer matches the warm fork's, so the fork below is made now instead.
        if (warm) yield* promise(() => releaseTakenBank(info.directory))
        const preview = yield* promise(() =>
          allocatePreview({
            directory: info.directory,
            chatID: chat._id,
            turnIndex: turn.turnIndex,
            side,
            context: {
              ...(branch ? { branch } : {}),
              trunkDirectory: chat.repository.root,
              trunkBranch: chat.canonicalCheckout?.branch ?? chat.arenaBranch,
            },
          }),
        )
        previewWorktrees.add(info.directory)
        const env = previewEnvironment(info.directory)
        const forkStartedAt = Date.now()
        const warmFork = warm
          ? usableWarmFork(warmForksTrusted, turn, warm, info.directory, sourceID, preview.portAliases)
          : undefined
        if (warm?.forkedSessionID && !warmFork) {
          // Forked from an older transcript or in another process; nothing else refers to it.
          yield* disposeWarmSessions([warm.forkedSessionID])
        }
        const messageMapping = new Map<string, string>(warmFork ? Object.entries(warmFork.forkMessageMap) : [])
        let forkedID: SessionID
        if (warmFork) {
          forkedID = SessionID.make(warmFork.forkedSessionID)
          forkedAtWarmup = true
        } else {
          // Keep concrete URLs in the canonical chat for the reader. Contestant copies normalize
          // every historical run here, then retarget those references to this side's environment.
          const historicalEnvironments = yield* historicalEnvironmentsForChat(store, chat._id)
          const forked = yield* forkInto({
            sessionID: sourceID,
            destination: info.directory,
            roots: { canonical: chat.repository.root, worktree: info.directory },
            pathMode: "transcript",
            onMessageMapping(mapping) {
              mapping.forEach((target, source) => messageMapping.set(source, target))
            },
            part(part, message) {
              if (message.role === "user") return part
              const canonicalEnvironment = historicalEnvironments.reduce(
                (current, historical) => canonicalizeArenaEnvironment(current, historical),
                part,
              )
              return localizeArenaEnvironment(canonicalEnvironment, env)
            },
          }).pipe(Effect.mapError(error))
          yield* sessions.setAgentModel({
            sessionID: forked.id,
            agent,
            model: {
              providerID: ProviderV2.ID.make("arena"),
              id: ModelV2.ID.make(contestant.id),
              variant: "high",
            },
            time: Date.now(),
          })
          yield* sessions.setPermission({
            sessionID: forked.id,
            permission: contestantPermissions(source.permission),
          })
          forkedID = forked.id
        }
        forkMs = Date.now() - forkStartedAt
        const selected = turn.placement[side]
        const runID = turn.runIDs[side]
        const mappingArtifactID = `${runID}|fork-message-map`
        const now = new Date()
        const currentTurn = yield* promise(() => store.turn(turn._id))
        const run: RunDocument = {
          _id: runID,
          turnID: turn._id,
          side,
          rootSessionID: forkedID,
          descendantSessionIDs: [],
          sourceCanonicalSessionID: sourceID,
          forkOperationID: operationID({ turnID: turn._id, operation: "fork", side }),
          moveOperationID: operationID({ turnID: turn._id, operation: "move", side }),
          mappingArtifactID,
          proxyAssignmentID: selected.assignmentID,
          assignment: selected,
          worktree: info.directory,
          ...(branch ? { branchAtRun: branch } : {}),
          worktreeName: basename(info.directory),
          copyManifestID: copyManifest.manifestID,
          copyOmissions: copyOmissions(copyManifest.entries),
          portAliases: preview.portAliases,
          services: [previewEnvironmentService(preview, now)],
          retention: "none",
          worktreeCreatedAt: now,
          ...(reused ? { readyAt: now } : {}),
          runState: "pending",
          durationMs: null,
          selectable: false,
          retries: [],
          permissionOutcomes: [],
          autoAccept: currentTurn?.autoAccept ?? autoAccept,
          questionOutcomes: [],
          toolCount: 0,
          testCommands: [],
          createdAt: now,
          updatedAt: now,
        }
        yield* promise(() => store.saveRun(run))
        yield* promise(() =>
          store.storeArtifact({
            _id: mappingArtifactID,
            runID,
            turnID: turn._id,
            kind: "other",
            mimeType: "application/json",
            encoding: "json",
            compression: "none",
            data: encoder.encode(
              JSON.stringify({
                version: "arena-fork-message-map-v1",
                sourceSessionID: sourceID,
                targetSessionID: forkedID,
                messages: Object.fromEntries(messageMapping),
              }),
            ),
            createdAt: now,
          }),
        )
        const proxyAssignment = {
          runID,
          rootSessionID: forkedID,
          scopeID: turn._id,
          assignmentID: selected.assignmentID,
          telemetry: true,
        }
        registry.assign(forkedID, proxyAssignment)
        const currentRecorder = recorder
        if (currentRecorder) {
          yield* promise(() =>
            currentRecorder.register({
              turnID: turn._id,
              runID,
              rootSessionID: forkedID,
              directory: info.directory,
              assignment: proxyAssignment,
            }),
          )
        }
        const runtime = {
          side,
          turnID: turn._id,
          runID,
          sessionID: forkedID,
          worktree: info,
          assignment: selected,
        } satisfies SideRuntime

        let earlyPrompt: Fiber.Fiber<Exit.Exit<SessionV1.WithParts | void, unknown>, unknown> | undefined
        if (!reused) {
          const directory = info.directory
          const base = Promise.withResolvers<boolean>()
          const gate = gateToolExecution(forkedID, {
            worktree: directory,
            copiedPaths: copiedRoots(copyManifest),
            // Nothing may load an instance at the path before the staged worktree is there: one
            // opened on the empty reservation would keep treating it as a directory without git.
            provide: (effect) =>
              Effect.promise(() => base.promise).pipe(
                Effect.flatMap((ready) => (ready ? inDirectory(directory, effect) : Effect.interrupt)),
              ),
          })
          gate.base.then(
            () => base.resolve(true),
            () => base.resolve(false),
          )
          executionGates.set(side, gate)
          const dispatch = waitForInitialDispatch(forkedID)
          const fiber = yield* runPrompt(store, runtime, prompt, agent, false, chat.repository.root).pipe(
            Effect.forkIn(scope, { startImmediately: true }),
          )
          earlyPrompts.set(side, { fiber, sessionID: forkedID, directory })
          const settledBeforeDispatch = Fiber.join(fiber).pipe(
            Effect.flatMap(() => promise(() => store.turn(turn._id))),
            Effect.flatMap((current) =>
              current?.state === "stopping" || current?.state === "early_selected"
                ? Effect.void
                : Effect.fail(new Error(`Arena side ${side.toUpperCase()} settled before its request was dispatched`)),
            ),
            Effect.tap(() => Effect.sync(() => dispatch.cancel(new Error("Arena prompt stopped before dispatch")))),
          )
          // Staging starts once the request has left, so it cannot compete with the dispatch.
          yield* Effect.raceFirst(promise(() => dispatch.promise), settledBeforeDispatch).pipe(
            Effect.tapError((dispatchError) => Effect.sync(() => dispatch.cancel(dispatchError))),
            preparationPhase("dispatch-initial-request", context),
          )
          earlyPrompt = fiber
        }

        const prepareStartedAt = Date.now()
        let sync: SlotSyncTimings
        if (reused) {
          sync = { syncPath: "reused", syncMs: 0 }
        } else {
          const commonGitDir = yield* canonicalCommonDir(chat)
          const metadataFingerprint = yield* promise(() => hostMetadataFingerprint(commonGitDir))
          const stageSlot = Effect.fnUntraced(function* (previous?: WarmWorktreeRecord) {
            const started = performance.now()
            const adopted = previous
              ? yield* adoptSlot({
                  chat,
                  from: previous.directory,
                  to: previous.directory,
                  name: previous.name,
                  branch,
                  head: contestantSnapshot.frozenHead,
                  roots: copiedDirectoryRoots(copyManifest),
                  metadataFingerprint,
                })
              : undefined
            const staged = adopted
              ? adopted.info
              : yield* claimSlot({
                  chat,
                  // The request is already bound to the planned path, so a replacement goes there too.
                  name: relativePath(slotRoot, plannedDirectory),
                  branch,
                  head: contestantSnapshot.frozenHead,
                  metadataFingerprint,
                })
            setupWorktrees.set(staged.directory, staged)
            const adoptMs = Math.round(performance.now() - started)
            const pending = yield* prepareSlotContent({
              chat,
              directory: staged.directory,
              branch,
              base: contestantSnapshot,
              manifest: copyManifest,
              observeSlot: adopted
                ? adopted.observeSlot
                : Effect.succeed({ complete: false, changed: new Set(), reason: "a new worktree has no history" }),
              indexRebuilt: adopted ? !adopted.info.indexKept : undefined,
              signal: copyStop.signal,
            })
            const syncPath: SlotSyncTimings["syncPath"] = previous ? "refreshed" : "created"
            const complete = pending.complete.pipe(
              Effect.map((synced) => ({
                timings: { syncPath, syncMs: Math.round(performance.now() - started), adoptMs, ...synced.timings },
                reasons: synced.reasons,
              })),
              Effect.tap((synced) => logSlotSync(context, staged.directory, synced.timings, synced.reasons)),
              Effect.map((synced) => synced.timings),
            )
            return { info: staged, removedPaths: pending.removedPaths, complete, syncPath, adoptMs }
          })
          const staged = yield* stageSlot(warm).pipe(
            Effect.catchCause((cause) => {
              if (!warm) return Effect.failCause(cause)
              return retireSlot(chat, warm.directory).pipe(Effect.andThen(stageSlot()))
            }),
            preparationPhase("prepare-worktree-code", context),
          )
          if (staged.info.directory !== plannedDirectory) {
            return yield* Effect.fail(
              new Error(`Arena side ${side.toUpperCase()} was staged at an unexpected path: ${staged.info.directory}`),
            )
          }
          info = staged.info
          sync = { syncPath: staged.syncPath, syncMs: 0, adoptMs: staged.adoptMs }
          environmentSetups.set(side, { removedPaths: staged.removedPaths, complete: staged.complete })
          // Anything opened at the path before the staged worktree existed described something else.
          yield* instances.disposeDirectory(info.directory)
        }
        // A fresh host is a copy of the canonical git directory; a warm host was copied at the
        // end of the previous turn. Either way, refresh the ref names and `origin`, then
        // record where every ref points so finalize can tell which ones the contestant moved.
        if (info.host) {
          yield* withGit(
            mirrorCanonicalRefs({
              canonical: chat.repository.root,
              host: info.host,
              ...(turn.baseSnapshot?.permanentRef ? { requiredRefs: [turn.baseSnapshot.permanentRef] } : {}),
              fetchChangedOnly: reused && warm?.refsMirrored === true,
            }),
          ).pipe(
            Effect.mapError(error),
            preparationPhase("mirror-refs", { chatID: chat._id, turnID: turn._id, side }),
          )
          yield* withGit(snapshotHostRefs({ host: info.host })).pipe(
            Effect.mapError(error),
            preparationPhase("snapshot-host-refs", { chatID: chat._id, turnID: turn._id, side }),
          )
        }
        if (reused && !isWarmPairTrusted(store, chat._id, turn.turnIndex)) {
          const verified = yield* withGit(snapshotBase({ canonical: info.directory })).pipe(Effect.mapError(error))
          if (
            verified.canonicalHead !== contestantSnapshot.frozenHead ||
            (verified.branch || undefined) !== branch ||
            verified.indexTree !== contestantSnapshot.indexTree ||
            verified.baseTree !== contestantSnapshot.workingTree
          ) {
            return yield* Effect.fail(new Error(`Warm side ${side.toUpperCase()} is no longer valid`))
          }
          if (!warm.contentFingerprint) {
            return yield* Effect.fail(new Error(`Warm side ${side.toUpperCase()} has no copied-content identity`))
          }
          const contentFingerprint = yield* promise(() =>
            fingerprintCopiedContent({ targetRoot: info.directory, manifest: copyManifest }),
          )
          if (contentFingerprint !== warm.contentFingerprint) {
            return yield* Effect.fail(new Error(`Warm side ${side.toUpperCase()} copied content changed before use`))
          }
        }
        prepareMs = Date.now() - prepareStartedAt
        // A warm side was prepared when warm preparation finished; doing it again here would only
        // compete with the prompt for the engine's thread.
        if (reused && !preparedContestants.has(info.directory)) {
          yield* prepareContestant(info.directory, { chatID: chat._id, turnID: turn._id, side })
        }
        const pending = environmentSetups.get(side)
        if (pending) {
          executionGates.get(side)?.baseReady(pending.removedPaths)
          yield* promise(() => store.updateRun(runID, { readyAt: new Date() }))
        }
        sideTimings.set(side, { totalMs: Date.now() - sideStartedAt, prepareMs, forkMs, forkedAtWarmup, ...sync })
        return { run: { ...runtime, worktree: info } satisfies SideRuntime, earlyPrompt }
      })

      const repositoryLock = chat.canonicalCheckout?.commonGitDir ?? chat.repository.root
      const discardSetup = Effect.all(
        [
          Effect.sync(() => {
            for (const gate of executionGates.values()) gate.fail(new Error("Arena side setup did not complete"))
          }),
          // A request that already left must not keep running for a battle that will not start.
          Effect.forEach(
            Array.from(earlyPrompts.values()),
            (early) =>
              cancelRun(early.directory, early.sessionID).pipe(
                Effect.andThen(Fiber.interrupt(early.fiber)),
                Effect.ignore,
              ),
            { concurrency: 2, discard: true },
          ),
          Effect.forEach(
            Array.from(previewWorktrees),
            (directory) => promise(() => endOwnership(directory)).pipe(Effect.ignore),
            { concurrency: 2, discard: true },
          ),
          Effect.forEach(
            Array.from(setupWorktrees.values()),
            (info) =>
              forgetSlot(info.directory).pipe(
                Effect.andThen(
                  inDirectory(chat.repository.root, worktrees.remove({ directory: info.directory, keepBranch: false })),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Arena setup worktree cleanup failed", {
                    turnID: turn._id,
                    directory: info.directory,
                    cause,
                  }),
                ),
              ),
            { concurrency: 2, discard: true },
          ),
          Effect.sync(() => {
            turnCopyManifests.delete(turn._id)
          }),
        ],
        { discard: true },
      ).pipe(Effect.ignore)
      // Both sides are prepared at once: each has its own host repository and its own session. The
      // claim's shared steps tolerate a concurrent twin: the trash sweep removes with `force`, and
      // the exclude and config-boundary writes are serialized per file. The whole setup still runs under
      // the repository lock so canonical snapshot mutations wait.
      const sides = yield* Effect.exit(
        trackOperation(
          store,
          turn._id,
          "preparing_workspaces",
          withRepositoryMutation(
            repositoryLock,
            Effect.all(
              [
                makeSide("a").pipe(preparationPhase("prepare-side", { chatID: chat._id, turnID: turn._id, side: "a" })),
                makeSide("b").pipe(preparationPhase("prepare-side", { chatID: chat._id, turnID: turn._id, side: "b" })),
              ],
              {
                concurrency: 2,
              },
            ).pipe(Effect.onError(() => discardSetup)),
          ),
        ),
      )
      // Awaited outside the lock, which its worktree removal needs, and even when a side failed:
      // interrupting it midway would leave the retained winner marked as stopping.
      const released = retainedRelease
        ? yield* trackOperation(store, turn._id, "releasing_environment", Fiber.await(retainedRelease))
        : Exit.void
      if (Exit.isFailure(sides)) return yield* Effect.failCause(sides.cause)
      if (Exit.isFailure(released)) {
        yield* withRepositoryMutation(repositoryLock, discardSetup)
        return yield* Effect.failCause(released.cause)
      }
      const [preparedA, preparedB] = sides.value
      const runA = preparedA.run
      const runB = preparedB.run
      turnCopyManifests.delete(turn._id)
      yield* promise(() => store.transitionTurn(turn._id, "worktrees_ready"))
      const setupTimings: TurnSetupTimings = {
        ...(turn.setupTimings ?? {
          preCreationMs: 0,
          freezeMs: 0,
          warmPath: "cold",
          warmMs: 0,
          assignmentWaitMs: 0,
        }),
        sides: Object.fromEntries(sideTimings),
        setupMs: Date.now() - turn.createdAt.getTime(),
      }
      yield* promise(() => store.updateTurn(turn._id, { setupTimings })).pipe(Effect.ignore)
      yield* Effect.logInfo("Arena turn setup timings", {
        turnID: turn._id,
        ...setupTimings,
        sides: JSON.stringify(setupTimings.sides),
      })

      const finalizeRuns = Effect.fnUntraced(function* (
        outcomeA: Exit.Exit<FinalizedSide, unknown>,
        outcomeB: Exit.Exit<FinalizedSide, unknown>,
      ) {
        if (Exit.isFailure(outcomeA) || Exit.isFailure(outcomeB)) {
          const currentRecorder = recorder
          if (currentRecorder) yield* promise(() => currentRecorder.flush(turn._id))
          const current = yield* promise(() => store.turn(turn._id))
          if (current?.resolution?.kind === "early" && current.appliedSide) {
            return yield* promote(store, current, current.appliedSide, current.resolution, current.vote, true).pipe(
              Effect.catchCause((cause) =>
                promise(() =>
                  store.updateTurn(turn._id, {
                    gitApplication: { state: "failed", reason: Cause.pretty(cause) },
                  }),
                ).pipe(
                  Effect.andThen(promise(() => store.transitionTurn(turn._id, "application_failed"))),
                  Effect.as(undefined),
                ),
              ),
            )
          }
          yield* promise(() => store.updateTurn(turn._id, { comparisonState: "failed" }))
          if (current?.state === "running") yield* promise(() => store.transitionTurn(turn._id, "finalizing"))
          yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
          yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
          return
        }
        yield* finalizeReadyTurn(store, turn, chat.repository.root)
      })

      // Both refreshed environments must pass the pair fingerprint check before either can
      // mutate files. Cold sides retain their independent completion gates.
      const settleEnvironment = Effect.fnUntraced(function* (run: SideRuntime, outcome: Exit.Exit<void, unknown>) {
        const gate = executionGates.get(run.side)
        if (Exit.isSuccess(outcome)) gate?.release()
        else gate?.fail(Cause.squash(outcome.cause))
        yield* Deferred.succeed(environmentSettled[run.side], undefined)
        // Stop cancels both runs itself.
        if (Exit.isFailure(outcome) && !copyStopped(outcome.cause)) {
          // One side without its environment leaves nothing fair to compare, so the other side
          // stops too rather than running on for a battle that cannot be voted. Its copy stops as
          // Stop stops it, so it still resolves as a stopped side.
          stoppedBySibling.add(run.side === "a" ? "b" : "a")
          copyStop.abort(new Error("Arena battle was stopped because the other side's environment setup failed"))
          yield* Effect.forEach(
            [runA, runB],
            (target) => cancelUntilSettled(store, target.runID, target.sessionID, target.worktree.directory),
            { concurrency: 2, discard: true },
          )
        }
      })
      const finishEnvironmentsWork = Effect.gen(function* () {
        const results = yield* Effect.forEach(
          [runA, runB],
          (run) =>
            Effect.gen(function* () {
              const setup = environmentSetups.get(run.side)
              if (!setup) {
                yield* settleEnvironment(run, Exit.void)
                return { side: run.side, outcome: Exit.void }
              }
              const complete = setup.complete.pipe(
                preparationPhase("prepare-worktree-environment", {
                  chatID: chat._id,
                  turnID: turn._id,
                  side: run.side,
                  directory: run.worktree.directory,
                }),
                Effect.tap((sync) =>
                  Effect.sync(() => {
                    const timing = sideTimings.get(run.side)
                    if (timing) sideTimings.set(run.side, { ...timing, ...sync })
                    const state = slotStates.get(slotKey(run.worktree.directory))
                    if (state) {
                      const { stoppedAt: _stoppedAt, ...running } = state
                      slotStates.set(slotKey(run.worktree.directory), running)
                    }
                  }),
                ),
                Effect.asVoid,
              )
              const outcome = yield* Effect.exit(trackOperation(store, turn._id, "copying_environment", complete))
              if (!refreshing) yield* settleEnvironment(run, outcome)
              return { side: run.side, outcome }
            }),
          { concurrency: 2 },
        )
        const outcomes = new Map(results.map((result) => [result.side, result.outcome]))
        if (refreshing) {
          yield* sweepSlotTrash(chat)
          const refreshed = yield* Effect.exit(
            Effect.gen(function* () {
              for (const { outcome } of results) {
                if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
              }
              const records = yield* Effect.forEach(
                [runA, runB],
                (run) =>
                  Effect.gen(function* () {
                    const contentFingerprint = yield* promise(() =>
                      fingerprintCopiedContent({ targetRoot: run.worktree.directory, manifest: copyManifest }),
                    )
                    return {
                      ...turn.warmPreparation?.worktrees[run.side],
                      side: run.side,
                      name: run.worktree.name,
                      directory: run.worktree.directory,
                      branch: run.worktree.branch,
                      sourceHead: contestantSnapshot.frozenHead,
                      sourceCommit: turn.frozenBaseSHA,
                      sourceIndexTree: contestantSnapshot.indexTree,
                      sourceWorkingTree: contestantSnapshot.workingTree,
                      copyManifestID: copyManifest.manifestID,
                      contentFingerprint,
                      ready: true,
                      refsMirrored: true,
                      sync: sideTimings.get(run.side),
                    } satisfies WarmWorktreeRecord
                  }),
                { concurrency: 2 },
              )
              const [a, b] = records
              if (!a || !b || a.contentFingerprint !== b.contentFingerprint) {
                return yield* Effect.fail(new Error("Refreshed warm pair copied content differs between sides"))
              }
              yield* promise(() =>
                store.updateTurn(turn._id, {
                  warmPreparation: { generation: turn.turnIndex, state: "ready", worktrees: { a, b } },
                }),
              )
            }),
          )
          if (Exit.isFailure(refreshed) && turn.warmPreparation) {
            yield* promise(() =>
              store.updateTurn(turn._id, {
                warmPreparation: {
                  ...turn.warmPreparation!,
                  state: "failed",
                  error: Cause.pretty(refreshed.cause),
                },
              }),
            )
          }
          for (const run of [runA, runB]) outcomes.set(run.side, refreshed)
          yield* Effect.forEach([runA, runB], (run) => settleEnvironment(run, refreshed), {
            concurrency: 2,
            discard: true,
          })
        }
        yield* promise(() =>
          store.updateTurn(turn._id, {
            setupTimings: { ...setupTimings, sides: Object.fromEntries(sideTimings) },
          }),
        ).pipe(Effect.ignore)
        return outcomes
      })
      const finishEnvironments = yield* Effect.cached(finishEnvironmentsWork)
      const settlePreparedSide = Effect.fnUntraced(function* (side: typeof preparedA) {
        const run = side.run
        const settled = Deferred.await(environmentSettled[run.side])
        const early = side.earlyPrompt
        const settle = early
          ? Fiber.await(early).pipe(
              Effect.flatMap((joined) =>
                settlePromptExit(
                  store,
                  turn,
                  run,
                  Exit.isSuccess(joined) ? joined.value : Exit.failCause(joined.cause),
                  settled,
                  () => stoppedBySibling.has(run.side),
                ),
              ),
            )
          : settleSide(store, turn, run, prompt, agent, false, settled, () => stoppedBySibling.has(run.side))
        const [prepared, outcome] = yield* Effect.all([finishEnvironments, settle], { concurrency: "unbounded" })
        const setup = prepared.get(run.side)
        // A copy cut short by Stop leaves the tracked files the contestant worked on intact. The
        // side resolves as a stopped side, and its result can still be kept.
        if (setup && Exit.isFailure(setup) && !copyStopped(setup.cause)) {
          // Its tree came from an environment that never became usable, so it may hold edits made
          // outside the contestant. The stop resolution must not offer to keep it.
          yield* promise(() =>
            store.updateRun(run.runID, {
              applicability: "blocked",
              selectable: false,
              error: `Arena environment setup failed\n${Cause.pretty(setup.cause)}`,
            }),
          )
          return Exit.fail(Cause.squash(setup.cause))
        }
        return outcome
      })

      const running = yield* promise(() => store.transitionTurn(turn._id, "running")).pipe(
        Effect.as(true),
        Effect.catch((transitionError) =>
          promise(() => store.turn(turn._id)).pipe(
            Effect.flatMap((current) =>
              current?.state === "stopping" ? Effect.succeed(false) : Effect.fail(transitionError),
            ),
          ),
        ),
      )
      if (!running) {
        const [outcomeA, outcomeB] = yield* Effect.all([settlePreparedSide(preparedA), settlePreparedSide(preparedB)], {
          concurrency: 2,
        })
        return yield* finalizeRuns(outcomeA, outcomeB)
      }

      const beforePrompt = yield* promise(() => store.turn(turn._id))
      if (beforePrompt?.state === "stopping") {
        const [outcomeA, outcomeB] = yield* Effect.all([settlePreparedSide(preparedA), settlePreparedSide(preparedB)], {
          concurrency: 2,
        })
        return yield* finalizeRuns(outcomeA, outcomeB)
      }
      const [outcomeA, outcomeB] = yield* Effect.all([settlePreparedSide(preparedA), settlePreparedSide(preparedB)], {
        concurrency: 2,
      })
      return yield* finalizeRuns(outcomeA, outcomeB)
    })

    const startTurnUnlocked = Effect.fn("Arena.startTurnUnlocked")(function* (
      store: Store,
      id: string,
      userPrompt: string,
      rawParticipantID?: string,
      receivedAt?: number,
      autoAccept = false,
      attachments: readonly ArenaAttachments.Input[] = [],
    ) {
      const prompt = userPrompt.trim()
      if (!prompt && attachments.length === 0) return yield* Effect.fail(new Error("Arena prompt cannot be empty"))
      const contestantPrompt = yield* ArenaAttachments.prepare(prompt, attachments, image.normalize)
      const sendStartedAt = Date.now()
      const admissionWaitMs = receivedAt === undefined ? 0 : Math.max(0, sendStartedAt - receivedAt)
      const admittedParticipantID = yield* Effect.try({
        try: () => participantID(rawParticipantID),
        catch: error,
      })
      const storedChat = yield* promise(() => store.chat(id))
      if (!storedChat) return yield* Effect.fail(new Error(`Arena chat not found: ${id}`))
      if (storedChat.checkoutEvicted) {
        return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
      }
      const storedCheckoutRoot = storedChat.canonicalCheckout?.root ?? storedChat.repository.root
      if (yield* promise(() => store.checkoutEviction(storedCheckoutRoot))) {
        return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
      }
      const chat = yield* reconcileCanonicalAvailability(store, storedChat)
      if (chat.checkoutEvicted) {
        return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
      }
      if (chat.status === "blocked") {
        return yield* Effect.fail(new Error(chat.blockedReason ?? canonicalUnavailableReason))
      }
      if (chat.status !== "ready" || chat.activeTurnID) {
        return yield* Effect.fail(new Error("Arena chat already has an active battle"))
      }
      if (activeNormalTurns.active(chat.canonicalSessionID)) {
        return yield* Effect.fail(new Error("Arena chat has an active normal turn"))
      }
      // A conflicted trunk cannot be snapshotted, but the chat stays usable: refuse only the
      // battle so a single agent can still be asked to resolve the conflicts in place. The
      // reconcile above already refreshed this list.
      const conflicts = chat.trunkConflicts ?? []
      if (conflicts.length > 0) {
        return yield* Effect.fail(new Error(trunkConflictReason(conflicts)))
      }
      const turnID = makeTurnID(chat._id, chat.turnCount)
      // The pair is drawn while the base freezes, so the send waits once for both. The draw is
      // account- and turn-scoped and idempotent on the control plane, so a send refused after this
      // point leaves an unused set and nothing else.
      const pairDraw = createBattleAssignments(turnID)
      pairDraw.catch(() => undefined)
      const freezeStartedAt = Date.now()
      const baseExit = yield* withRepositoryMutation(
        chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
        Effect.gen(function* () {
          const latest = yield* promise(() => store.chat(chat._id))
          const checkoutRoot = latest?.canonicalCheckout?.root ?? latest?.repository.root ?? chat.repository.root
          if (
            !latest ||
            latest.status !== "ready" ||
            latest.activeTurnID ||
            latest.checkoutEvicted ||
            (yield* promise(() => store.checkoutEviction(checkoutRoot)))
          ) {
            return yield* Effect.fail(new Error("Arena checkout is currently being evicted"))
          }
          // Only a Git snapshot failure makes the canonical checkout unavailable.
          // Admission refusals above leave the chat ready to resume after restoration.
          return yield* Effect.exit(
            withGit(
              snapshotBase({
                canonical: latest.repository.root,
                permanentRef: `${refRoot({ chatID: latest._id, turnIndex: latest.turnCount })}/base`,
              }),
            ).pipe(Effect.mapError(error)),
          )
        }),
      )
      if (Exit.isFailure(baseExit)) {
        // A merge can finish conflicting between the reconcile above and here. Blocking the chat
        // for that would close the single-agent escape this guard exists to keep open, so refuse
        // the battle the same way and record what snapshotBase saw.
        const raced = trunkConflictPaths(Cause.squash(baseExit.cause))
        if (raced) {
          yield* recordTrunkState(store, chat._id, { conflicts: raced })
          return yield* Effect.fail(new Error(trunkConflictReason(raced)))
        }
        const blocked = yield* blockCanonicalCheckout(store, chat, Cause.pretty(baseExit.cause))
        return yield* Effect.fail(new Error(blocked.blockedReason ?? canonicalUnavailableReason))
      }
      const base = baseExit.value
      const freezeMs = Date.now() - freezeStartedAt
      const discardBaseRef = base.permanentRef
        ? withRepositoryMutation(
            chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
            withGit(
              removeRef({
                canonical: chat.repository.root,
                ref: base.permanentRef,
                expectedCommit: base.baseCommit,
              }),
            ),
          ).pipe(Effect.ignore)
        : Effect.void
      if (base.root !== chat.repository.root) {
        yield* discardBaseRef
        return yield* Effect.fail(new Error("Canonical checkout root changed outside Arena"))
      }
      const sourceID = SessionID.make(chat.canonicalSessionID)
      const transcript = yield* sessions.messages({ sessionID: sourceID }).pipe(
        Effect.mapError(error),
        Effect.onError(() => discardBaseRef),
      )
      const transcriptHash = digest(transcript)
      if (base.canonicalHead !== chat.currentCanonicalSHA && transcriptHash !== chat.canonicalTranscriptHash) {
        yield* discardBaseRef
        return yield* Effect.fail(
          new Error("Arena canonical Git state and transcript changed without a reconciled single-agent turn"),
        )
      }
      const copyConfiguration = yield* promise(() => arenaCopyConfiguration(base.root)).pipe(
        Effect.onError(() => discardBaseRef),
      )
      const copyManifestID = `${turnID}|copy-manifest`
      const ignoredSeedID = `${turnID}|ignored-seed`
      const warmStartedAt = Date.now()
      // Warming can finish while snapshotBase waits for the repository lock. Keep
      // this turn's admitted snapshot, but read the generation published by that work.
      const currentChat = yield* promise(() => store.chat(chat._id)).pipe(Effect.onError(() => discardBaseRef))
      const warmChat = { ...chat, warmGeneration: currentChat?.warmGeneration }
      const reused = yield* reuseWarmPairForTurn(store, warmChat, base, copyConfiguration, copyManifestID).pipe(
        Effect.onError(() => discardBaseRef),
      )
      const copyManifest = reused
        ? reused.copyManifest
        : ({
            ...(yield* promise(() =>
              createIgnoredContentSnapshot({ canonical: base.root, policy: copyConfiguration }),
            ).pipe(Effect.onError(() => discardBaseRef))),
            manifestID: copyManifestID,
          } satisfies CopyManifest)
      turnCopyManifests.set(turnID, copyManifest)
      const discardUnactivatedCopy = Effect.all(
        [promise(() => store.artifacts.deleteOne({ _id: copyManifestID, turnID })), discardBaseRef],
        { discard: true },
      ).pipe(Effect.ensuring(Effect.sync(() => turnCopyManifests.delete(turnID))))
      yield* promise(() =>
        store.storeArtifact({
          _id: copyManifestID,
          turnID,
          kind: "other",
          mimeType: "application/json",
          encoding: "json",
          compression: "none",
          data: encoder.encode(JSON.stringify(copyManifest)),
          createdAt: new Date(copyManifest.createdAt),
        }),
      ).pipe(Effect.onError(() => discardUnactivatedCopy.pipe(Effect.ignore)))
      // Refresh invalidates environment trust, but the session and its process-local port bank
      // can still be reused after the fork's own transcript and port checks.
      const warmForksTrusted = isWarmPairTrusted(store, chat._id, chat.turnCount)
      const warmPreparation =
        reused?.warmPreparation ??
        (yield* claimWarmPairForRefresh(store, warmChat).pipe(
          Effect.onError(() => discardUnactivatedCopy.pipe(Effect.ignore)),
        ))
      const warmMs = Date.now() - warmStartedAt
      const warmPath: TurnSetupTimings["warmPath"] = reused ? "reused" : warmPreparation ? "refreshed" : "cold"
      // Before the pair is placed: nothing a contestant or a terminal left beside a worktree since
      // the pair was prepared reaches this turn's contestants.
      yield* sweepSlotPool(
        store,
        chat,
        new Set(
          [warmPreparation?.worktrees.a?.directory, warmPreparation?.worktrees.b?.directory].filter(
            (directory): directory is string => directory !== undefined,
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena could not sweep a chat's worktree directory", { chatID: chat._id, cause }),
        ),
      )
      // Whatever the pair became, this turn owns it now; nothing is left to keep warm. The
      // worktrees' own watches keep running: they cover the battle too, up to the next sync.
      warmMarks.delete(warmPairKey(chat._id, chat.turnCount))
      const assignmentWaitStartedAt = Date.now()
      const pair = yield* promise(() => pairDraw).pipe(Effect.onError(() => discardUnactivatedCopy.pipe(Effect.ignore)))
      const assignmentWaitMs = Date.now() - assignmentWaitStartedAt
      const placed = {
        a: assignment(pair.a),
        b: assignment(pair.b),
      }
      const now = new Date()
      const turn: TurnDocument = {
        _id: turnID,
        chatID: chat._id,
        ...(admittedParticipantID ? { participantID: admittedParticipantID } : {}),
        turnIndex: chat.turnCount,
        userPrompt: prompt,
        ...(contestantPrompt.summary.length > 0 ? { userAttachments: contestantPrompt.summary } : {}),
        frozenBaseSHA: base.baseCommit,
        ...(base.permanentRef
          ? {
              baseSnapshot: {
                canonicalHead: base.canonicalHead,
                tree: base.baseTree,
                indexTree: base.indexTree,
                permanentRef: base.permanentRef,
              },
            }
          : {}),
        copySnapshot: {
          manifestID: copyManifestID,
          ignoredSeedID,
          resolvedPolicy: copyManifest.resolvedPolicy,
        },
        setupTimings: {
          preCreationMs: now.getTime() - sendStartedAt,
          admissionWaitMs,
          freezeMs,
          warmPath,
          warmMs,
          assignmentWaitMs,
        },
        ...(warmPreparation ? { warmPreparation } : {}),
        sourceCanonicalSessionID: sourceID,
        autoAccept,
        canonicalTranscriptHash: transcriptHash,
        pair: [pair.a.assignmentID, pair.b.assignmentID],
        placement: placed,
        runIDs: {
          a: operationID({ turnID, operation: "run", side: "a" }),
          b: operationID({ turnID, operation: "run", side: "b" }),
        },
        state: "creating",
        transitionTimestamps: { creating: now },
        finalizedSides: [],
        selectableSides: [],
        comparisonState: "pending",
        createdAt: now,
        updatedAt: now,
      }
      if (activeNormalTurns.active(chat.canonicalSessionID)) {
        yield* discardUnactivatedCopy
        return yield* Effect.fail(new Error("Arena chat has an active normal turn"))
      }
      activatingBattles.add(chat.canonicalSessionID)
      if (activeNormalTurns.active(chat.canonicalSessionID)) {
        activatingBattles.delete(chat.canonicalSessionID)
        yield* discardUnactivatedCopy
        return yield* Effect.fail(new Error("Arena chat has an active normal turn"))
      }
      const activation = yield* promise(() =>
        store.activateTurn(chat._id, turn, {
          previous: {
            branch: chat.arenaBranch,
            head: chat.currentCanonicalSHA,
            sessionID: chat.canonicalSessionID,
            transcriptHash: chat.canonicalTranscriptHash,
            transcriptVersion: chat.canonicalTranscriptVersion,
          },
          branch: base.branch,
          head: base.canonicalHead,
          indexTree: base.indexTree,
          sessionID: sourceID,
          transcriptHash,
          transcriptChanged: chat.canonicalTranscriptHash !== transcriptHash,
        }),
      ).pipe(
        Effect.onError(() => discardUnactivatedCopy.pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => activatingBattles.delete(chat.canonicalSessionID))),
      )
      if (!activation.activated) {
        yield* discardUnactivatedCopy
        return yield* respond(store, chat._id)
      }
      const activeTurn = activation.turn
      yield* executeBattle(store, activeTurn, contestantPrompt.prompt, warmForksTrusted, autoAccept).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* promise(() => store.turn(activeTurn._id))
            if (current?.warmPreparation?.state === "pending") {
              yield* promise(() =>
                store.updateTurn(activeTurn._id, {
                  warmPreparation: { ...current.warmPreparation!, state: "failed", error: Cause.pretty(cause) },
                }),
              )
            }
            if (current && !isFinalState(current.state) && current.state !== "creation_failed") {
              if (current.state === "creating" || current.state === "worktrees_ready") {
                yield* promise(() => store.transitionTurn(activeTurn._id, "creation_failed")).pipe(Effect.ignore)
              } else if (current.state === "finalizing" || current.state === "stopping") {
                yield* promise(() => store.transitionTurn(activeTurn._id, "finalization_failed")).pipe(Effect.ignore)
              } else if (current.state === "early_selected") {
                yield* promise(() => store.transitionTurn(activeTurn._id, "application_failed")).pipe(Effect.ignore)
              } else if (current.state === "running") {
                yield* promise(() => store.transitionTurn(activeTurn._id, "interrupted_recovery")).pipe(Effect.ignore)
              }
            }
            if (current?.comparisonState !== "skipped") {
              yield* promise(() =>
                store.updateTurn(activeTurn._id, {
                  comparisonState: "failed",
                  failureReason: Cause.pretty(cause),
                }),
              ).pipe(Effect.ignore)
            }
            const activeChat = yield* promise(() => store.chat(activeTurn.chatID))
            const failed = yield* promise(() => store.turn(activeTurn._id))
            if (!activeChat || activeChat.activeTurnID !== activeTurn._id || !failed) return
            if (
              failed.state !== "creation_failed" &&
              failed.state !== "finalization_failed" &&
              failed.state !== "interrupted_recovery"
            )
              return
            const failureState = failed.state
            const revealed = yield* promise(() => modelsForDecision(failed, "aborted"))
            const aborted = yield* promise(() =>
              store.recordAbort({
                turnID: activeTurn._id,
                expectedState: failureState,
                reason: "Arena battle failed before resolution",
                models: revealed.models,
                at: new Date(),
              }),
            )
            if (!aborted.recorded && aborted.turn.resolution?.kind !== "aborted") return
            yield* revealTelemetry(failed, revealed.metrics)
            yield* promise(() => store.transitionTurn(activeTurn._id, "discarding"))
            yield* cleanup(store, activeTurn, activeChat.repository.root)
            const canonical = yield* withGit(inspectCanonical(activeChat.repository.root)).pipe(Effect.mapError(error))
            yield* promise(() => store.transitionTurn(activeTurn._id, "discarded"))
            yield* promise(() =>
              store.completeTurn({
                chatID: activeChat._id,
                turnID: activeTurn._id,
                canonicalSHA: canonical.head,
                canonicalSessionID: activeChat.canonicalSessionID,
                ...(canonical.branch ? { branch: canonical.branch } : {}),
                detached: canonical.detached,
                indexTree: canonical.indexTree,
                trunkConflicts: canonical.conflicts,
                completedAt: new Date(),
              }),
            )
            yield* Effect.logError("Arena battle failed", { turnID: activeTurn._id, cause })
          }),
        ),
        Effect.forkIn(scope),
      )
      // The chat holds a pair only for its first turn, which now owns it or went without it.
      // After the battle is running, so nothing here can keep an activated turn from starting.
      if (activeTurn.turnIndex === 0 && currentChat?.initialWarmPreparation) {
        yield* writeWarmRecord(store, { kind: "chat", chatID: chat._id }, undefined).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Arena could not clear the first turn's warm record", { chatID: chat._id, cause }),
          ),
        )
      }
      return yield* respond(store, chat._id)
    })

    const startTurn = Effect.fn("Arena.startTurn")(function* (
      id: string,
      userPrompt: string,
      rawParticipantID?: string,
      autoAccept = false,
      attachments: readonly ArenaAttachments.Input[] = [],
    ) {
      // Recovery may finish a promotion and warm its next pair. Run it before taking
      // the same chat lock that warming uses, so startup cannot wait on itself.
      const receivedAt = Date.now()
      const store = yield* available()
      const lock = turnStartLock(id)
      const admission = startTurnUnlocked(store, id, userPrompt, rawParticipantID, receivedAt, autoAccept, attachments)
      return yield* Effect.gen(function* () {
        const immediate = yield* lock.withPermitsIfAvailable(1)(admission)
        if (Option.isSome(immediate)) return immediate.value
        yield* Effect.logInfo("Arena turn waiting for preparation", { chatID: id })
        return yield* lock.withPermits(1)(admission)
      }).pipe(preparationPhase("admission", { chatID: id }))
    })

    // A contestant's run reads complete as soon as its answer lands, but its side joins `finalizedSides`
    // only once its result is committed, a second or more later, and a resume cannot be claimed before
    // then. A turn whose sides have all finished also passes through `finalizing` on its way to the vote.
    // A reply sent in either window waits for the turn to settle rather than failing to reach the side.
    const settledReplyTurn = Effect.fn("Arena.settledReplyTurn")(function* (
      store: Store,
      id: string,
      sides: readonly Side[],
    ) {
      const deadline = Date.now() + REPLY_SETTLE_TIMEOUT_MS
      while (true) {
        const turn = yield* promise(() => store.turn(id))
        if (!turn) return turn
        const runs = yield* promise(() => store.runsForTurn(id))
        const settling =
          turn.state === "finalizing" ||
          (turn.state === "running" &&
            sides.some(
              (side) =>
                runs.find((run) => run.side === side)?.runState === "complete" &&
                !(turn.finalizedSides ?? []).includes(side),
            ))
        if (!settling || Date.now() >= deadline) return turn
        yield* Effect.sleep(Duration.millis(50))
      }
    })

    const reply = Effect.fn("Arena.reply")(function* (
      id: string,
      userPrompt: string,
      target: ReplyTarget,
      attachments: readonly ArenaAttachments.Input[] = [],
    ) {
      const store = yield* available()
      const text = userPrompt.trim()
      if (!text && attachments.length === 0) return yield* Effect.fail(new Error("Arena reply cannot be empty"))
      const { prompt } = yield* ArenaAttachments.prepare(text, attachments, image.normalize)
      const requestedSides: readonly Side[] = target === "both" ? ["a", "b"] : [target]
      const turn = yield* settledReplyTurn(store, id, requestedSides)
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.state !== "running" && turn.state !== "awaiting_vote") {
        return yield* Effect.fail(new Error("Arena replies can only be sent before the battle is resolved"))
      }
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const source = yield* sessions.get(SessionID.make(turn.sourceCanonicalSessionID)).pipe(Effect.mapError(error))
      const agent = source.agent ?? "build"
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const selected = requestedSides.map((side) => runs.find((run) => run.side === side))
      if (selected.some((run) => !run)) {
        return yield* Effect.fail(new Error("Arena reply target is unavailable"))
      }
      const selectedRuns = selected as RunDocument[]
      // A reply to both while one side still works and the other has finished goes to each the way
      // it can take it: the finished side resumes and the working side is steered, with one message.
      const finished = selectedRuns.filter((run) => run.runState === "complete")
      const working = selectedRuns.filter((run) => run.runState === "pending")
      if (finished.length + working.length !== selectedRuns.length) {
        return yield* Effect.fail(new Error("Arena reply target cannot take a message right now"))
      }
      if (turn.state === "awaiting_vote" && working.length > 0) {
        return yield* Effect.fail(new Error("Arena replies after the battle finished can only resume contestants"))
      }
      const finishedSides = finished.map((run) => run.side)
      const claimed =
        finished.length === 0
          ? undefined
          : yield* promise(() =>
              turn.state === "awaiting_vote"
                ? store.claimReplyContinuation(turn._id, finishedSides)
                : store.claimRunningReplyContinuation(turn._id, finishedSides),
            )
      // Nothing goes to either side when the resume cannot be claimed, so both always get the same
      // message, and the reply fails so the app keeps it rather than clearing it as sent.
      if (claimed && !claimed.claimed) {
        return yield* Effect.fail(new Error("The battle changed before your reply was delivered. Send it again."))
      }
      // Counted once the reply is certain to go out, whether it resumes a finished contestant or
      // redirects a working one.
      yield* promise(() => store.countSteer(turn._id))
      if (claimed) {
        const resumedRuns = yield* Effect.gen(function* () {
          if (turn.state === "awaiting_vote") {
            yield* promise(() => store.clearComparison(turn._id, claimed.comparisonID))
          }
          return yield* Effect.forEach(finished, (run) => promise(() => store.resetRunForReply(run._id)))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* promise(() => store.updateTurn(turn._id, { comparisonState: "failed" }))
              const current = yield* promise(() => store.turn(turn._id))
              if (current?.state === "running") yield* promise(() => store.transitionTurn(turn._id, "finalizing"))
              yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
              yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
              return yield* Effect.failCause(cause)
            }),
          ),
        )
        const continuation = Effect.gen(function* () {
          const outcomes = yield* Effect.forEach(
            resumedRuns,
            (run) =>
              settleSide(
                store,
                turn,
                {
                  side: run.side,
                  turnID: run.turnID,
                  runID: run._id,
                  sessionID: SessionID.make(run.rootSessionID),
                  worktree: { name: `turn-${turn.turnIndex}-${run.side}`, directory: run.worktree },
                  assignment: run.assignment,
                },
                prompt,
                agent,
                true,
              ),
            { concurrency: 2 },
          )
          const current = yield* promise(() => store.turn(turn._id))
          if (outcomes.some(Exit.isFailure)) {
            yield* promise(() => store.updateTurn(turn._id, { comparisonState: "failed" }))
            if (current?.state === "running") yield* promise(() => store.transitionTurn(turn._id, "finalizing"))
            yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
            yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
            return
          }
          yield* finalizeReadyTurn(store, turn, chat.repository.root)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const current = yield* promise(() => store.turn(turn._id))
              if (current?.state === "running") {
                yield* promise(() => store.transitionTurn(turn._id, "finalizing"))
                yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
                yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
              } else if (current?.state === "finalizing") {
                yield* promise(() => store.transitionTurn(turn._id, "finalization_failed"))
                yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
              } else if (current?.state === "finalization_failed") {
                yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
              } else if (current?.state === "stopping") {
                yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
              }
              yield* Effect.logError("Arena completed-result reply failed", {
                turnID: turn._id,
                target,
                cause,
              })
            }).pipe(Effect.catchCause(() => Effect.logError("Arena completed-result reply failed", { cause }))),
          ),
        )
        yield* continuation.pipe(Effect.forkIn(scope))
      }
      if (working.length === 0) return yield* respond(store, turn.chatID)
      const dispatch = Effect.forEach(
        working,
        (run) => {
          // A working contestant whose request started early is still run by its host's runner.
          return allowReading(run.worktree, SessionID.make(run.rootSessionID), prompt.readable).pipe(
            Effect.andThen(
              inDirectory(
                promptHosts.get(SessionID.make(run.rootSessionID)) ?? run.worktree,
                prompts.prompt({
                  sessionID: SessionID.make(run.rootSessionID),
                  model: {
                    providerID: ProviderV2.ID.make("arena"),
                    modelID: ModelV2.ID.make(contestant.id),
                  },
                  agent,
                  variant: "high",
                  system: contestantSystemInstruction(run.worktree),
                  parts: prompt.parts,
                }),
              ),
            ),
          )
        },
        { concurrency: 2, discard: true },
      ).pipe(Effect.catchCause((cause) => Effect.logError("Arena reply failed", { turnID: turn._id, target, cause })))
      yield* dispatch.pipe(Effect.forkIn(scope))
      return yield* respond(store, turn.chatID)
    })

    const disposeRunSessions = Effect.fn("Arena.disposeRunSessions")(function* (run: RunDocument) {
      const root = SessionID.make(run.rootSessionID)
      const ids = [...(yield* descendants(root)), root]
      yield* Effect.forEach(ids, (sessionID) => sessions.remove(sessionID).pipe(Effect.ignore), {
        discard: true,
      })
      clearToolExecutionEnvironment(root)
    })

    const captureRunServices = Effect.fn("Arena.captureRunServices")(function* (store: Store, run: RunDocument) {
      const services = yield* discoverRunServices(run)
      yield* promise(() => store.updateRun(run._id, { services }))
      return services
    })

    const stopRunServices = Effect.fn("Arena.stopRunServices")(function* (store: Store, run: RunDocument) {
      const captured = yield* captureRunServices(store, run)
      const candidates = [...(run.services ?? []), ...captured].filter((service) => service.kind !== "environment")
      const services = [
        ...new Map(
          candidates.map((service) => [
            service.managedTerminalID
              ? `terminal:${service.managedTerminalID}`
              : `group:${service.processGroupID ?? "unknown"}:${service.command}:${service.relativeCwd}`,
            service,
          ]),
        ).values(),
      ]
      const stopped = yield* promise(() => stopOwnedServices(services, { worktree: run.worktree, graceMs: 250 }))
      yield* promise(() =>
        store.updateRun(run._id, {
          services: [...captured.filter((service) => service.kind === "environment"), ...services],
        }),
      )
      return stopped
    })

    /**
     * End what a stopped run holds besides its worktree: its preview route and its sessions. Returns
     * the services it had, every route inactive, as the record the run keeps of its environment.
     */
    const endRunEnvironment = Effect.fnUntraced(function* (store: Store, run: RunDocument, at: Date) {
      yield* promise(() => endOwnership(run.worktree))
      const latest = yield* promise(() => store.run(run._id))
      const historicalPreview = previewRoute(run.worktree)
      const historicalServices = [
        ...(historicalPreview ? [previewEnvironmentService(historicalPreview, at)] : []),
        ...(latest?.services ?? [])
          .filter((service) => service.kind !== "environment")
          .map((service) => ({
            ...service,
            proxyRoutes: service.proxyRoutes.map((route) => ({ ...route, active: false })),
          })),
      ]
      yield* disposeRunSessions(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena retained session cleanup failed", { runID: run._id, cause }),
        ),
      )
      return historicalServices
    })

    const removeStoppedRun = Effect.fn("Arena.removeStoppedRun")(function* (
      store: Store,
      chat: ChatDocument,
      run: RunDocument,
    ) {
      const at = new Date()
      const historicalServices = yield* endRunEnvironment(store, run, at)
      yield* forgetSlot(run.worktree)
      yield* withRepositoryMutation(
        chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
        inDirectory(chat.repository.root, worktrees.remove({ directory: run.worktree, keepBranch: false })),
      )
      yield* promise(() =>
        store.updateRun(run._id, {
          retention: "none",
          services: historicalServices,
          worktreeRemovedAt: at,
          projectRegistrationRemovedAt: at,
        }),
      )
    })

    /**
     * Let go of a stopped run's worktree without removing it: the next pair adopts it, and only
     * what changed since is written again. The run gives up everything it held in the directory
     * (its preview route, its sessions, the directory's instance and preparation), so nothing is
     * left writing into it. The run's release marker is written last, since that write is what
     * makes the worktree free; the worktree's watch keeps running until it is adopted.
     */
    const releaseRunSlot = Effect.fn("Arena.releaseRunSlot")(function* (store: Store, run: RunDocument) {
      const at = new Date()
      const historicalServices = yield* endRunEnvironment(store, run, at)
      yield* stopPreparation(run.worktree)
      yield* instances.disposeDirectory(run.worktree)
      markSlotStopped(run.worktree)
      yield* promise(() =>
        store.updateRun(run._id, {
          retention: "none",
          services: historicalServices,
          worktreeRemovedAt: at,
          projectRegistrationRemovedAt: at,
        }),
      )
    })

    const watchChat = (chatID: string) =>
      Effect.sync(() => {
        watchedChats.set(chatID, (watchedChats.get(chatID) ?? 0) + 1)
      })
    const unwatchChat = (chatID: string) =>
      Effect.sync(() => {
        const open = (watchedChats.get(chatID) ?? 1) - 1
        if (open > 0) {
          watchedChats.set(chatID, open)
          return
        }
        watchedChats.delete(chatID)
        unwatchedSince.set(chatID, Date.now())
      })

    /** The chat's contestant worktrees that hold a loaded instance. */
    const loadedWorktrees = Effect.fnUntraced(function* (chat: ChatDocument) {
      const pool = slotPool(chat)
      const names = yield* Effect.promise(() => readdir(pool).catch(() => [] as string[]))
      const worktrees = names.flatMap((name) =>
        name === TRASH_DIRNAME || hostedWorktree(name) !== undefined ? [] : [join(pool, name)],
      )
      return yield* Effect.filter(worktrees, (directory) => instances.loaded(directory))
    })

    /**
     * Dispose the instances of an idle chat's contestant worktrees. Nothing else changes: a retained
     * winner keeps its services, the warm pair stays trusted, and both boot again at the next send.
     * A worktree still being prepared keeps the whole chat loaded until a later pass.
     */
    const unloadChat = Effect.fnUntraced(function* (store: Store, chatID: string) {
      const chat = yield* promise(() => store.chat(chatID))
      if (!chat || chat.status !== "ready" || watchedChats.has(chatID)) return
      const worktrees = yield* loadedWorktrees(chat)
      if (worktrees.length === 0 || worktrees.some((directory) => preparations.has(directory))) return
      for (const directory of worktrees) {
        yield* stopPreparation(directory)
        yield* instances.disposeDirectory(directory)
      }
      yield* Effect.logInfo("Arena unloaded an idle chat", { chatID, worktrees: worktrees.length })
    })

    const unloadIdleChats = Effect.fnUntraced(function* () {
      const store = yield* getStore
      const now = Date.now()
      const chats = yield* promise(() => store.chats.find({ status: "ready" }).toArray())
      for (const chat of chats) {
        if (watchedChats.has(chat._id)) continue
        const since = unwatchedSince.get(chat._id)
        if (since === undefined) {
          unwatchedSince.set(chat._id, now)
          continue
        }
        if (now - since < idleUnloadMs() || (yield* loadedWorktrees(chat)).length === 0) continue
        yield* turnStartLock(chat._id).withPermits(1)(unloadChat(store, chat._id))
      }
    })

    const checkoutRootIdentities = (root: string) => {
      const absolute = resolvePath(root)
      const identities = new Set([absolute])
      try {
        identities.add(resolvePath(realpathSync.native(absolute)))
      } catch {
        // The checkout may already have been removed. Its absolute path still
        // identifies the durable records written before eviction.
      }
      return identities
    }
    const checkoutChats = Effect.fn("Arena.checkoutChats")(function* (store: Store, worktreeRoot: string) {
      const targetIdentities = checkoutRootIdentities(worktreeRoot)
      const chats = yield* promise(() => store.chats.find({}).toArray())
      return chats.filter((chat) => {
        const roots = [chat.canonicalCheckout?.root, chat.repository.root].filter(
          (root): root is string => typeof root === "string",
        )
        return roots.some((root) => {
          for (const identity of checkoutRootIdentities(root)) {
            if (targetIdentities.has(identity)) return true
          }
          return false
        })
      })
    })
    const checkoutChatFilter = (chats: readonly ChatDocument[]) => ({
      _id: { $in: chats.map((chat) => chat._id) },
    })

    const retainedRunMatchesResult = Effect.fn("Arena.retainedRunMatchesResult")(function* (run: RunDocument) {
      if (!run.rawHead || !run.finalCommit || !run.finalTree || !run.finalIndexTree) return false
      const current = yield* Effect.exit(
        withGit(snapshotBase({ canonical: run.worktree })).pipe(Effect.mapError(error)),
      )
      return (
        Exit.isSuccess(current) &&
        current.value.frozenHead === run.rawHead &&
        current.value.baseTree === run.finalTree &&
        current.value.indexTree === run.finalIndexTree
      )
    })

    const inspectCheckout = Effect.fn("Arena.inspectCheckout")(function* (worktreeRoot: string) {
      const store = yield* available()
      const chats = yield* checkoutChats(store, worktreeRoot)
      if (chats.length === 0) {
        const claimed = yield* promise(() => store.checkoutEviction(worktreeRoot))
        return {
          eligible: true,
          lastActivityAt: null,
          ...(claimed ? { reason: "checkout eviction is already claimed" } : {}),
        } satisfies ArenaCheckoutInspection
      }
      let latest: Date | undefined
      const details = new Map<string, { turns: TurnDocument[]; runs: RunDocument[]; activity?: Date }>()
      for (const chat of chats) {
        const turns = yield* promise(() => store.turnsForChat(chat._id))
        const runs = yield* promise(() => store.runsForChat(chat._id))
        const activity = latestArenaChatActivity(turns, runs)
        details.set(chat._id, { turns, runs, ...(activity ? { activity } : {}) })
        if (activity && (!latest || activity > latest)) latest = activity
        if (chat.checkoutEvicted) continue
        if (chat.status !== "ready" || chat.activeTurnID) {
          return {
            eligible: false,
            lastActivityAt: latest?.toISOString() ?? null,
            reason: `chat ${chat._id} is ${chat.activeTurnID ? "active" : chat.status}`,
          } satisfies ArenaCheckoutInspection
        }
        const retained = chat.retainedWinner
        if (retained) {
          const run = yield* promise(() => store.run(retained.runID))
          if (!run) {
            return {
              eligible: false,
              lastActivityAt: latest?.toISOString() ?? null,
              reason: `chat ${chat._id} retained contestant result is incomplete`,
            } satisfies ArenaCheckoutInspection
          }
          if (!(yield* retainedRunMatchesResult(run)))
            return {
              eligible: false,
              lastActivityAt: latest?.toISOString() ?? null,
              reason: `chat ${chat._id} retained contestant result is incomplete or code is newer than its archived result`,
            } satisfies ArenaCheckoutInspection
        }
      }
      for (const chat of chats) {
        const activity = details.get(chat._id)?.activity
        if (activity && (!chat.lastChatActivityAt || chat.lastChatActivityAt.getTime() !== activity.getTime())) {
          yield* promise(() => store.updateChat({ _id: chat._id }, { $set: { lastChatActivityAt: activity } }))
        }
      }
      return { eligible: true, lastActivityAt: latest?.toISOString() ?? null } satisfies ArenaCheckoutInspection
    })

    const prepareCheckout = Effect.fn("Arena.prepareCheckout")(function* (worktreeRoot: string) {
      const store = yield* available()
      // Every chat's start lock first, in one order, as admission and warm-up take them: no pair
      // is being built while the checkout's worktrees are taken away.
      const chatIDs = (yield* checkoutChats(store, worktreeRoot)).map((chat) => chat._id).toSorted()
      const withStartLocks = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        chatIDs.reduceRight((inner, chatID) => turnStartLock(chatID).withPermits(1)(inner), effect)
      yield* withStartLocks(
        checkoutCleanupLock(worktreeRoot).withPermits(1)(
          Effect.gen(function* () {
            const chats = yield* checkoutChats(store, worktreeRoot)
            const lockKey = chats[0]?.canonicalCheckout?.commonGitDir ?? worktreeRoot
            const claimed = yield* withRepositoryMutation(
              lockKey,
              Effect.gen(function* () {
                const current = yield* checkoutChats(store, worktreeRoot)
                for (const chat of current) {
                  if (chat.checkoutEvicted) continue
                  if (chat.status !== "ready" || chat.activeTurnID) {
                    return yield* Effect.fail(
                      new Error(`Arena checkout cannot be evicted while chat ${chat._id} is active`),
                    )
                  }
                  if (activeNormalTurns.active(chat.canonicalSessionID)) {
                    return yield* Effect.fail(
                      new Error(`Arena checkout cannot be evicted while chat ${chat._id} has an active turn`),
                    )
                  }
                  const turns = yield* promise(() => store.turnsForChat(chat._id))
                  if (warmRecordsOf(chat, turns).some((preparation) => preparation.state === "pending")) {
                    return yield* Effect.fail(
                      new Error(`Arena checkout cannot be evicted while chat ${chat._id} is preparing environments`),
                    )
                  }
                }
                yield* promise(() => store.claimCheckoutEviction(worktreeRoot))
                yield* promise(() =>
                  store.chats.updateMany(
                    {
                      ...checkoutChatFilter(current),
                      status: "ready",
                      activeTurnID: { $exists: false },
                    },
                    { $set: { checkoutEvicted: true, updatedAt: new Date() } },
                  ),
                )
                const claimedChats = yield* checkoutChats(store, worktreeRoot)
                if (
                  claimedChats.some((chat) => !chat.checkoutEvicted || chat.activeTurnID || chat.status !== "ready")
                ) {
                  return yield* Effect.fail(new Error("Arena checkout became active while eviction was being prepared"))
                }
                const turns = (yield* Effect.forEach(
                  claimedChats,
                  (chat) => promise(() => store.turnsForChat(chat._id)),
                  {
                    concurrency: 4,
                  },
                )).flat()
                const runs = (yield* Effect.forEach(turns, (turn) => promise(() => store.runsForTurn(turn._id)), {
                  concurrency: 4,
                })).flat()
                return { claimedChats, turns, runs }
              }),
            )
            // A spare still being built or a worktree still being released would race the removals.
            yield* Effect.forEach(claimed.claimedChats, (chat) => endSlotWork(chat._id), {
              concurrency: "unbounded",
              discard: true,
            })
            // Read again: a release that finished during the wait left its worktree to the pool.
            const runs = yield* Effect.forEach(
              claimed.runs,
              (run) => promise(() => store.run(run._id)).pipe(Effect.map((latest) => latest ?? run)),
              { concurrency: 4 },
            )
            yield* Effect.forEach(
              runs.filter((run) => !run.worktreeRemovedAt),
              (run) =>
                Effect.gen(function* () {
                  const stopped = yield* stopRunServices(store, run)
                  if (stopped.some((item) => item.status === "failed" || !item.verified)) {
                    return yield* Effect.fail(new Error(`Arena could not stop services for ${run._id}`))
                  }
                  const turn = claimed.turns.find((candidate) => candidate._id === run.turnID)
                  const chat = turn
                    ? claimed.claimedChats.find((candidate) => candidate._id === turn.chatID)
                    : undefined
                  if (chat?.retainedWinner?.runID === run._id) {
                    const latest = yield* promise(() => store.run(run._id))
                    if (!latest || !(yield* retainedRunMatchesResult(latest))) {
                      return yield* Effect.fail(
                        new Error(`Arena retained contestant code changed while checkout eviction was preparing`),
                      )
                    }
                  }
                  if (chat) yield* removeStoppedRun(store, chat, run)
                }),
              { concurrency: 1, discard: true },
            )
            const warmRecords = claimed.claimedChats.map((chat) => ({
              chatID: chat._id,
              records: warmRecordsOf(
                chat,
                claimed.turns.filter((turn) => turn.chatID === chat._id),
              ),
            }))
            for (const { chatID, records } of warmRecords) {
              for (const { generation } of records) {
                distrustWarmPair(store, chatID, generation)
                warmMarks.delete(warmPairKey(chatID, generation))
              }
            }
            const warmSlots = unusedWarmSlots(
              warmRecords.flatMap((chat) => chat.records),
              runs,
            )
            yield* Effect.forEach(
              [...new Set(warmSlots.map((slot) => slot.directory))],
              (directory) =>
                forgetSlot(directory).pipe(
                  Effect.andThen(inDirectory(worktreeRoot, worktrees.remove({ directory, keepBranch: false }))),
                  Effect.mapError(error),
                ),
              { concurrency: 1 },
            )
            yield* disposeWarmSessions(warmSlots.map((slot) => slot.forkedSessionID))
            // Released worktrees nobody adopted yet, spares, and anything else each chat left.
            yield* Effect.forEach(claimed.claimedChats, (chat) => retireSlotPool(chat), { discard: true })
            yield* promise(() =>
              store.chats.updateMany(checkoutChatFilter(claimed.claimedChats), {
                $set: { checkoutEvicted: true, updatedAt: new Date() },
                // A first pair's record goes with its worktrees; the chat prepares another once restored.
                $unset: { retainedWinner: "", warmGeneration: "", initialWarmPreparation: "" },
              }),
            )
          }),
        ),
      )
    })

    const releaseCheckout = Effect.fn("Arena.releaseCheckout")(function* (worktreeRoot: string) {
      const store = yield* available()
      yield* checkoutCleanupLock(worktreeRoot).withPermits(1)(
        Effect.gen(function* () {
          const chats = yield* checkoutChats(store, worktreeRoot)
          yield* promise(() =>
            store.chats.updateMany(checkoutChatFilter(chats), {
              $unset: { checkoutEvicted: "" },
              $set: { updatedAt: new Date() },
            }),
          )
          yield* promise(() => store.releaseCheckoutEviction(worktreeRoot))
        }),
      )
    })

    /** Whether the retained winner still accepts connections on a port it was given or opened. */
    const retainedWinnerServing = Effect.fn("Arena.retainedWinnerServing")(function* (
      store: Store,
      chat: ChatDocument,
    ) {
      const retained = chat.retainedWinner
      if (!retained) return false
      const run = yield* promise(() => store.run(retained.runID))
      if (!run || run.worktreeRemovedAt) return false
      const ports = [
        ...Object.values(run.portAliases ?? {}),
        ...(run.services ?? []).flatMap((service) => service.listeners.map((listener) => listener.port)),
      ].filter((port): port is number => typeof port === "number")
      return yield* promise(() => anyListening(ports))
    })

    // One release per chat at a time: a send that follows a background release waits for it before
    // starting its own, rather than stopping and removing the same run twice.
    const retainedReleases = new Map<string, Fiber.Fiber<unknown, unknown>>()
    // The loser a chat's last vote is letting go of, for archive and eviction to wait on.
    const slotReleases = new Map<string, Fiber.Fiber<unknown, unknown>>()
    // The spare worktree a chat's first turn is building, one per chat, with where it lands.
    const spareCreations = new Map<string, { readonly fiber: Fiber.Fiber<void>; readonly directory: string }>()

    /**
     * Wait, up to `limit`, for the chat's spare creation and its retained winner's and loser's
     * releases, the jobs that change which of its worktrees are free. A spare still being built
     * after that is returned as reserved, so nothing takes it half made; a release still running
     * has not marked its worktree released, so it is not free yet anyway.
     */
    const settleSlotWork = Effect.fnUntraced(function* (chatID: string, limit: Duration.Input) {
      const spare = spareCreations.get(chatID)
      const jobs = [spare?.fiber, retainedReleases.get(chatID), slotReleases.get(chatID)].filter(
        (fiber): fiber is Fiber.Fiber<unknown, unknown> => fiber !== undefined,
      )
      // Together, so the limit bounds the whole wait rather than each job's.
      yield* Effect.forEach(jobs, (fiber) => Fiber.await(fiber).pipe(Effect.timeoutOption(limit)), {
        concurrency: "unbounded",
        discard: true,
      })
      const reserved = new Set<string>()
      if (spare && spare.fiber.pollUnsafe() === undefined) reserved.add(spare.directory)
      return reserved
    })

    /**
     * For archive and eviction, which take every worktree the chat has: wait as warm-up does,
     * then stop a spare that is still being built, since nothing will adopt it.
     */
    const endSlotWork = Effect.fnUntraced(function* (chatID: string) {
      yield* settleSlotWork(chatID, Duration.seconds(30))
      const spare = spareCreations.get(chatID)
      if (spare) yield* Fiber.interrupt(spare.fiber)
    })

    /**
     * Give a chat's first vote a third worktree to adopt. The next pair needs two free worktrees
     * while the retained winner keeps its own until the next send, and the first turn has only
     * its two, so one more is built while the user reads the results rather than after the vote.
     * It is synced to this turn's base; the warm-up that adopts it syncs it to the next one.
     * Nothing waits on it and nothing fails with it.
     */
    const ensureSpareSlot = Effect.fn("Arena.ensureSpareSlot")(function* (
      store: Store,
      turn: TurnDocument,
      name: string,
    ) {
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat || chat.status !== "battle_active" || chat.activeTurnID !== turn._id) return
      const entries = yield* Effect.promise(() => readdir(slotPool(chat), { withFileTypes: true }).catch(() => []))
      // Arena's own worktrees only: a contestant's `git worktree add ../x` must not stand in for a spare.
      const linked = yield* Effect.forEach(
        entries.filter((entry) => entry.isDirectory() && hostedWorktree(entry.name) === undefined),
        (entry) => Effect.promise(() => isPoolWorktree(join(slotPool(chat), entry.name))),
      )
      if (linked.filter(Boolean).length >= SLOT_POOL_TARGET) return
      const manifestID = turn.copySnapshot?.manifestID
      if (!manifestID) return
      const manifest = yield* copyManifestByID(store, manifestID, turn._id)
      const base = {
        frozenHead: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
        indexTree: turn.baseSnapshot?.indexTree ?? turn.frozenBaseSHA,
        workingTree: turn.baseSnapshot?.tree ?? turn.frozenBaseSHA,
      }
      const branch = (chat.canonicalCheckout?.branch ?? chat.arenaBranch) || undefined
      const commonGitDir = yield* canonicalCommonDir(chat)
      const context = { chatID: chat._id, turnID: turn._id }
      const started = performance.now()
      let directory: string | undefined
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          // Only the host copy and the registration need the lock; a vote arriving now waits
          // on the lock for its promotion, so the checkout and the clones run after it.
          const info = yield* withRepositoryMutation(
            chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
            Effect.gen(function* () {
              const metadataFingerprint = yield* promise(() => hostMetadataFingerprint(commonGitDir))
              return yield* claimSlot({ chat, name, branch, head: base.frozenHead, metadataFingerprint })
            }),
          )
          directory = info.directory
          const adoptMs = Math.round(performance.now() - started)
          const synced = yield* syncSlotContent({
            chat,
            directory: info.directory,
            branch,
            base,
            manifest,
            observeSlot: Effect.succeed({
              complete: false,
              changed: new Set(),
              reason: "a new worktree has no history",
            }),
          })
          yield* logSlotSync(context, info.directory, {
            syncPath: "created",
            syncMs: Math.round(performance.now() - started),
            adoptMs,
            ...synced.timings,
          })
        }),
      )
      if (Exit.isSuccess(outcome)) return
      yield* Effect.logWarning("Arena spare worktree creation failed", { ...context, name, cause: outcome.cause })
      yield* retireSlot(chat, directory ?? join(isolatedRoot(chat.repository.root), name)).pipe(Effect.ignore)
    })

    const forkSpareSlot = Effect.fnUntraced(function* (store: Store, turn: TurnDocument, canonical: string) {
      if (spareCreations.has(turn.chatID)) return
      const name = `${chatSlug(turn.chatID)}/spare-${randomBytes(4).toString("hex")}`
      const fiber = yield* ensureSpareSlot(store, turn, name).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena spare worktree creation failed", { chatID: turn.chatID, cause }),
        ),
        Effect.forkIn(scope),
      )
      spareCreations.set(turn.chatID, { fiber, directory: join(isolatedRoot(canonical), name) })
      fiber.addObserver(() => {
        if (spareCreations.get(turn.chatID)?.fiber === fiber) spareCreations.delete(turn.chatID)
      })
    })

    const releaseRetainedInBackground = Effect.fn("Arena.releaseRetainedInBackground")(function* (
      store: Store,
      chat: ChatDocument,
      release: Effect.Effect<void, unknown>,
    ) {
      const runID = chat.retainedWinner?.runID
      if (!runID) return
      const fiber = yield* release.pipe(
        // A failed release fails no turn. The run is marked so the next send retries it, whether or not
        // a newer winner has taken the chat's retained slot by then.
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena retained winner release failed", { chatID: chat._id, runID, cause }).pipe(
            Effect.andThen(
              promise(() => store.run(runID)).pipe(
                Effect.flatMap((run) =>
                  run && !run.worktreeRemovedAt
                    ? promise(() => store.updateRun(runID, { retention: "cleanup_failed" }))
                    : Effect.void,
                ),
                Effect.ignore,
              ),
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => retainedReleases.delete(chat._id))),
        Effect.forkIn(scope),
      )
      retainedReleases.set(chat._id, fiber)
    })

    const consumeRetainedWinner = Effect.fn("Arena.consumeRetainedWinner")(function* (
      store: Store,
      chat: ChatDocument,
      turn: TurnDocument,
      omissions: readonly CopyOmission[],
    ) {
      const retained = chat.retainedWinner
      if (!retained) return
      const run = yield* promise(() => store.run(retained.runID))
      if (!run) return yield* Effect.fail(new Error(`Arena retained winner is missing: ${retained.runID}`))
      yield* promise(() =>
        store.updateChat(
          { _id: chat._id, "retainedWinner.runID": retained.runID },
          { $set: { "retainedWinner.state": "stopping", updatedAt: new Date() } },
        ),
      )
      const stopped = yield* stopRunServices(store, run)
      const transition = buildEnvironmentTransition({
        id: `${turn._id}|environment-transition`,
        previousWinningRunID: run._id,
        stopRecords: stopped,
        copyOmissions: omissions,
      })
      yield* promise(() =>
        store.updateTurn(turn._id, {
          transitionEventID: transition.id,
          transitionEvent: transition,
        }),
      )
      const failures = stopped.filter((record) => record.status === "failed" || !record.verified)
      if (failures.length > 0) {
        yield* promise(() =>
          store.updateChat(
            { _id: chat._id, "retainedWinner.runID": retained.runID },
            { $set: { "retainedWinner.state": "cleanup_failed", updatedAt: new Date() } },
          ),
        )
        yield* promise(() => store.updateRun(run._id, { retention: "cleanup_failed" }))
        return yield* Effect.fail(
          new Error(
            `Arena could not stop ${failures.length} retained winner service${failures.length === 1 ? "" : "s"}`,
          ),
        )
      }
      // Released, not removed: the next pair adopts its worktree.
      yield* releaseRunSlot(store, run)
      yield* promise(() =>
        store.updateChat(
          { _id: chat._id, "retainedWinner.runID": retained.runID },
          { $unset: { retainedWinner: "" }, $set: { updatedAt: new Date() } },
        ),
      )
    })

    const retryFailedRunCleanups = Effect.fn("Arena.retryFailedRunCleanups")(function* (
      store: Store,
      chat: ChatDocument,
      currentTurnID: string,
    ) {
      const turns = yield* promise(() => store.turnsForChat(chat._id))
      const priorRuns = yield* Effect.forEach(
        turns.filter((candidate) => candidate._id !== currentTurnID),
        (candidate) => promise(() => store.runsForTurn(candidate._id)),
        { concurrency: 4 },
      )
      const failed = priorRuns
        .flat()
        .filter(
          (run) =>
            run.retention === "cleanup_failed" && run._id !== chat.retainedWinner?.runID && !run.worktreeRemovedAt,
        )
      yield* Effect.forEach(
        failed,
        (run) =>
          Effect.gen(function* () {
            const stopped = yield* stopRunServices(store, run)
            const failures = stopped.filter((record) => record.status === "failed" || !record.verified)
            if (failures.length > 0) {
              yield* promise(() =>
                store.updateTurn(run.turnID, {
                  cleanup: {
                    state: "failed",
                    error: `Arena could not stop ${failures.length} previously losing service${failures.length === 1 ? "" : "s"}`,
                  },
                }),
              )
              return yield* Effect.fail(
                new Error(
                  `Arena could not stop ${failures.length} previously losing service${failures.length === 1 ? "" : "s"}`,
                ),
              )
            }
            yield* removeStoppedRun(store, chat, run)
            yield* promise(() => store.updateTurn(run.turnID, { cleanup: { state: "complete" } }))
          }),
        { concurrency: 1, discard: true },
      )
    })

    const reuseWarmPairForTurn = Effect.fn("Arena.reuseWarmPairForTurn")(function* (
      store: Store,
      chat: ChatDocument,
      base: SnapshotBase,
      copyConfiguration: unknown,
      manifestID: string,
    ) {
      if (chat.warmGeneration !== chat.turnCount) return undefined
      const found = yield* warmRecordFor(store, chat)
      const preparation = found?.preparation.state === "ready" ? found.preparation : undefined
      const a = preparation?.worktrees.a
      const b = preparation?.worktrees.b
      if (!found || !preparation || !a || !b) return undefined
      const ownerTurnID = found.owner.kind === "turn" ? found.owner.turn._id : undefined
      const decided = yield* Effect.exit(
        Effect.gen(function* () {
          // The whole starting point, not only the commit that encodes HEAD and the working tree:
          // an index or branch the checkout changed since warm-up is as much a change as a file.
          const sameBase = (slot: WarmWorktreeRecord) =>
            slot.sourceHead === base.frozenHead &&
            slot.sourceCommit === base.baseCommit &&
            slot.sourceIndexTree === base.indexTree &&
            slot.sourceWorkingTree === base.baseTree &&
            (slot.branch || undefined) === (base.branch || undefined)
          if (!sameBase(a) || !sameBase(b)) return "the checkout's git state changed since warm-up"
          if (a.copyManifestID !== b.copyManifestID) return "the warm sides were copied from different manifests"
          const sourceManifest = yield* copyManifestByID(store, a.copyManifestID, ownerTurnID)
          const usable = warmPairIsUsable(
            store,
            chat._id,
            chat.turnCount,
            [a.directory, b.directory],
            copiedDirectoryRoots(sourceManifest),
          )
          if (!usable.usable) return usable.reason
          // Independent reads of the checkout and of both worktrees, so the send waits for the
          // slowest rather than their sum.
          const [metadata, unchanged, heldA, heldB] = yield* Effect.all(
            [
              promise(() => hostMetadataFingerprint(base.commonGitDir)),
              promise(() =>
                matchesIgnoredContentSnapshot({
                  canonical: base.root,
                  policy: copyConfiguration,
                  manifest: sourceManifest,
                }),
              ),
              slotHoldsManifest(a.directory, sourceManifest),
              slotHoldsManifest(b.directory, sourceManifest),
            ],
            { concurrency: "unbounded" },
          )
          if ([a, b].some((slot) => slotStates.get(slotKey(slot.directory))?.metadataFingerprint !== metadata)) {
            return "the checkout's git config, hooks or info changed since warm-up"
          }
          if (!unchanged) return "the checkout's ignored roots changed since warm-up"
          if (heldA ?? heldB) return heldA ?? heldB
          const copyManifest = { ...sourceManifest, manifestID }
          return {
            copyManifest,
            warmPreparation: {
              generation: chat.turnCount,
              state: "ready" as const,
              worktrees: {
                a: { ...a, copyManifestID: manifestID },
                b: { ...b, copyManifestID: manifestID },
              },
            },
          }
        }),
      )
      if (Exit.isSuccess(decided) && typeof decided.value !== "string") return decided.value
      yield* Effect.logInfo("Arena warm pair cannot be reused", {
        chatID: chat._id,
        generation: chat.turnCount,
        reason: Exit.isSuccess(decided) ? decided.value : Cause.pretty(decided.cause),
      })
      return undefined
    })

    /** Reserve the existing pair for the admitted turn; its environment finishes beside the prompt. */
    const claimWarmPairForRefresh = Effect.fn("Arena.claimWarmPairForRefresh")(function* (
      store: Store,
      chat: ChatDocument,
    ) {
      if (chat.warmGeneration !== chat.turnCount) return undefined
      const found = yield* warmRecordFor(store, chat)
      const preparation = found?.preparation.state === "ready" ? found.preparation : undefined
      if (!found || !preparation?.worktrees.a || !preparation.worktrees.b) return undefined
      distrustWarmPair(store, chat._id, chat.turnCount)
      // Admission holds the start lock. Only the new turn owns the pending refresh; leaving a
      // pending record on the previous turn would keep the checkout from ever being evicted.
      return { ...preparation, state: "pending" as const }
    })

    /**
     * Admission and warming share the per-chat start lock. Keep this check inside the
     * repository lock as a safeguard against externally changed/recovered chat state:
     * adopting a worktree already in use would take it from underneath its run.
     */
    const warmPairIsSuperseded = Effect.fn("Arena.warmPairIsSuperseded")(function* (
      store: Store,
      chatID: string,
      generation: number,
      yieldToPrompts: boolean,
    ) {
      const current = yield* promise(() => store.chat(chatID))
      return (
        current?.activeTurnID !== undefined ||
        current?.status === "battle_active" ||
        current?.status === "archived" ||
        current?.checkoutEvicted === true ||
        current?.turnCount !== generation ||
        // A prompt sent to the agent since the first pair began: it is waiting on this lock.
        ((generation === 0 || yieldToPrompts) && activeNormalTurns.active(current.canonicalSessionID))
      )
    })

    /**
     * The next turn's pair, prepared while the user reads the result, or for a chat's first turn
     * while the user writes the prompt. Each side adopts a worktree an earlier turn let go of (the
     * loser, the previous winner, or the spare) and is synced to the checkout as it is now, so
     * only what changed is written; a side with nothing to adopt is created. The result is
     * published only once both sides are verified and forked into.
     */
    const prepareWarmPair = Effect.fn("Arena.prepareWarmPair")(function* (
      store: Store,
      chat: ChatDocument,
      owner: WarmOwner,
      /** Stand down for a prompt sent to the chat's agent meanwhile, whatever the generation. */
      yieldToPrompts = false,
    ) {
      const generation = owner.kind === "turn" ? owner.turn.turnIndex + 1 : 0
      const existing = owner.kind === "turn" ? owner.turn.warmPreparation : chat.initialWarmPreparation
      // A ready pair this process did not prepare, one left by a restart, is prepared again in
      // place: its two worktrees are free once the record below replaces it.
      const replaced = existing?.generation === generation && existing.state === "ready" ? existing : undefined
      if (replaced && isWarmPairTrusted(store, chat._id, generation)) return
      // The turn this work is logged under; the first pair has none.
      const turnID = owner.kind === "turn" ? owner.turn._id : undefined
      const pending = { generation, state: "pending" as const, worktrees: {} }
      // An artifact is written once per ID, and the first pair can be prepared again after a
      // failure or a stand-down, so each of its attempts stores its manifest under an ID of its own
      // and removes it when the attempt leaves nothing that refers to it.
      const manifestID = turnID
        ? `${turnID}|warm-${generation}-copy-manifest`
        : `${chat._id}|warm-${generation}-${randomBytes(4).toString("hex")}-copy-manifest`
      const discardAttemptManifest = turnID
        ? Effect.void
        : promise(() => store.artifacts.deleteOne({ _id: manifestID })).pipe(Effect.ignore)
      const key = warmPairKey(chat._id, generation)
      distrustWarmPair(store, chat._id, generation)
      warmMarks.delete(key)
      yield* writeWarmRecord(store, owner, pending)
      if (replaced) {
        // Nothing refers to the replaced pair's forks and manifest any more. A turn's manifest ID
        // is the one this attempt stores under, and a store keeps the first artifact written
        // under an ID, so the old one has to go before the new one is stored.
        const replacedSlots = Object.values(replaced.worktrees)
        yield* disposeWarmSessions(replacedSlots.map((slot) => slot?.forkedSessionID))
        const replacedManifests = new Set(replacedSlots.flatMap((slot) => (slot ? [slot.copyManifestID] : [])))
        yield* Effect.forEach(
          replacedManifests,
          (id) => promise(() => store.artifacts.deleteOne({ _id: id })).pipe(Effect.ignore),
          { discard: true },
        )
      }
      const lock = chat.canonicalCheckout?.commonGitDir ?? chat.repository.root
      const startedAt = performance.now()
      let superseded = false
      // Every worktree this attempt adopted or created: after a failure none is in a known state.
      const touched = new Set<string>()
      const forkedSessions: string[] = []
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          // Listed while the snapshot is taken rather than under the lock. The processes that
          // matter, a shell left in a released worktree, were there before this began.
          const working = yield* Effect.forkChild(
            Effect.promise(async () => {
              const runs = await store.runsForChat(chat._id).catch(() => [])
              const owned = new Set(runs.flatMap((run) => (run.worktreeRemovedAt ? [] : [basename(run.worktree)])))
              return slotPoolProcesses(slotPool(chat), owned)
            }),
          )
          // Followed from before the snapshot, so the manifest's identities are covered.
          yield* promise(() => journal.begin(chat._id, chat.repository.root, []))
          const base = yield* withRepositoryMutation(
            lock,
            withGit(snapshotBase({ canonical: chat.repository.root })),
          ).pipe(Effect.mapError(error))
          const configuration = yield* promise(() => arenaCopyConfiguration(base.root))
          const raw = yield* promise(() =>
            createIgnoredContentSnapshot({ canonical: base.root, policy: configuration }),
          )
          const manifest: CopyManifest = { ...raw, manifestID }
          const roots = copiedDirectoryRoots(manifest)
          yield* promise(() => journal.retarget(chat._id, roots))
          yield* promise(() => journal.renew(chat._id))
          // Taken before either side clones anything, so a write to the checkout that either
          // clone could have missed is still reported at the send.
          const warmMark = journal.mark(chat._id)
          yield* promise(() =>
            store.storeArtifact({
              _id: manifestID,
              ...(turnID ? { turnID } : {}),
              kind: "other",
              mimeType: "application/json",
              encoding: "json",
              compression: "none",
              data: encoder.encode(JSON.stringify(manifest)),
              createdAt: new Date(manifest.createdAt),
            }),
          )
          // The spare and the previous winner's release decide which worktrees are free.
          const reserved = yield* settleSlotWork(chat._id, Duration.seconds(5))
          const listed = yield* Fiber.join(working)
          const branch = base.branch || undefined
          const snapshot = { frozenHead: base.frozenHead, indexTree: base.indexTree, workingTree: base.baseTree }
          const targets = {
            a: join(isolatedRoot(chat.repository.root), contestantWorktreeName(chat._id, generation, "a")),
            b: join(isolatedRoot(chat.repository.root), contestantWorktreeName(chat._id, generation, "b")),
          }
          const newSlot: Effect.Effect<RootObservation> = Effect.succeed({
            complete: false,
            changed: new Set(),
            reason: "a new worktree has no history",
          })
          // Only the pool scan and the host copies take the repository lock: a host is a copy of the
          // checkout's git directory, which a promotion or a snapshot in another chat of the same
          // repository writes. The file sync, the instances and the forks touch only this chat's
          // pool and sessions, which the start lock the caller holds keeps to this preparation, so a
          // vote, a send or an agent prompt in another chat does not wait for them.
          const claimed = yield* withRepositoryMutation(
            lock,
            Effect.gen(function* () {
              if (yield* warmPairIsSuperseded(store, chat._id, generation, yieldToPrompts)) {
                superseded = true
                return yield* Effect.fail(new Error("Arena warm preparation stood down for a turn that started"))
              }
              // Taken before the host copies, so a change that lands during them reads as a change.
              const metadataFingerprint = yield* promise(() => hostMetadataFingerprint(base.commonGitDir))
              const free = yield* scanSlotPool(store, chat, reserved, listed)
              const sources = assignSlots(free, targets, directoryIdentity)

              const claimSide = Effect.fnUntraced(function* (side: Side) {
                const name = contestantWorktreeName(chat._id, generation, side)
                const from = sources[side]
                const started = performance.now()
                if (from) {
                  touched.add(targets[side])
                  const adopted = yield* Effect.exit(
                    adoptSlot({
                      chat,
                      from,
                      to: targets[side],
                      name,
                      branch,
                      head: base.frozenHead,
                      roots,
                      metadataFingerprint,
                    }),
                  )
                  if (Exit.isSuccess(adopted)) {
                    return {
                      side,
                      name,
                      from,
                      started,
                      adoptMs: Math.round(performance.now() - started),
                      info: adopted.value.info,
                      observeSlot: adopted.value.observeSlot,
                      indexRebuilt: !adopted.value.info.indexKept,
                    }
                  }
                  if (Cause.hasInterrupts(adopted.cause)) return yield* Effect.failCause(adopted.cause)
                  // Whatever the adopt left is in no known state; it goes, and this side starts over.
                  yield* Effect.logWarning("Arena could not adopt a worktree; creating one instead", {
                    chatID: chat._id,
                    turnID,
                    side,
                    from,
                    cause: adopted.cause,
                  })
                  yield* retireSlot(chat, from).pipe(Effect.ignore)
                  yield* retireSlot(chat, targets[side]).pipe(Effect.ignore)
                }
                touched.add(targets[side])
                const info = yield* claimSlot({ chat, name, branch, head: base.frozenHead, metadataFingerprint })
                touched.add(info.directory)
                return {
                  side,
                  name,
                  from: undefined,
                  started,
                  adoptMs: Math.round(performance.now() - started),
                  info,
                  observeSlot: newSlot,
                  indexRebuilt: undefined,
                }
              })

              const sides = yield* Effect.forEach(["a", "b"] as const, claimSide, { concurrency: 2 })
              return { metadataFingerprint, free, sources, sides }
            }),
          )

          const syncSide = Effect.fnUntraced(function* (slot: (typeof claimed.sides)[number]) {
            const context = { chatID: chat._id, turnID, side: slot.side }
            const synced = yield* Effect.exit(
              syncSlotContent({
                chat,
                directory: slot.info.directory,
                branch,
                base: snapshot,
                manifest,
                observeSlot: slot.observeSlot,
                indexRebuilt: slot.indexRebuilt,
              }),
            )
            if (Exit.isSuccess(synced)) {
              const sync: SlotSyncTimings = {
                syncPath: slot.from ? "adopted" : "created",
                syncMs: Math.round(performance.now() - slot.started),
                adoptMs: slot.adoptMs,
                ...synced.value.timings,
              }
              yield* logSlotSync(
                slot.from ? { ...context, from: slot.from } : context,
                slot.info.directory,
                sync,
                synced.value.reasons,
              )
              return { side: slot.side, info: slot.info, sync }
            }
            if (!slot.from || Cause.hasInterrupts(synced.cause)) return yield* Effect.failCause(synced.cause)
            // An adopted worktree that did not sync is in no known state; this side starts over.
            yield* Effect.logWarning("Arena could not adopt a worktree; creating one instead", {
              ...context,
              from: slot.from,
              cause: synced.cause,
            })
            const started = performance.now()
            const info = yield* withRepositoryMutation(
              lock,
              Effect.gen(function* () {
                yield* retireSlot(chat, slot.info.directory).pipe(Effect.ignore)
                const created = yield* claimSlot({
                  chat,
                  name: slot.name,
                  branch,
                  head: base.frozenHead,
                  metadataFingerprint: claimed.metadataFingerprint,
                })
                touched.add(created.directory)
                return created
              }),
            )
            const adoptMs = Math.round(performance.now() - started)
            const created = yield* syncSlotContent({
              chat,
              directory: info.directory,
              branch,
              base: snapshot,
              manifest,
              observeSlot: newSlot,
            })
            const sync: SlotSyncTimings = {
              syncPath: "created",
              syncMs: Math.round(performance.now() - started),
              adoptMs,
              ...created.timings,
            }
            yield* logSlotSync(context, info.directory, sync, created.reasons)
            return { side: slot.side, info, sync }
          })

          const prepared = yield* Effect.forEach(claimed.sides, syncSide, { concurrency: 2 })
          // After the adopts: one racing them could delete an old host before its index moved.
          yield* sweepSlotTrash(chat)
          const [preparedA, preparedB] = prepared
          if (!preparedA || !preparedB) return yield* Effect.fail(new Error("Warm pair preparation lost a side"))
          // Both worktrees are verified, so their instances can start booting now, alongside the
          // mirror and the forks, rather than after the pair is published. A failure below retires
          // the worktrees, which stops these first.
          yield* Effect.forEach(
            prepared,
            (slot) => prepareContestant(slot.info.directory, { chatID: chat._id, turnID, side: slot.side }),
            { discard: true },
          )
          const fingerprints = yield* Effect.forEach(
            prepared,
            (side) => promise(() => fingerprintCopiedContent({ targetRoot: side.info.directory, manifest })),
            { concurrency: 2 },
          )
          if (fingerprints[0] !== fingerprints[1]) {
            return yield* Effect.fail(new Error("Warm pair copied content differs between sides"))
          }
          const records = prepared.map(
            (slot, index) =>
              ({
                side: slot.side,
                name: basename(slot.info.directory),
                directory: slot.info.directory,
                ...(branch ? { branch } : {}),
                sourceHead: base.frozenHead,
                sourceCommit: base.baseCommit,
                sourceIndexTree: base.indexTree,
                sourceWorkingTree: base.baseTree,
                copyManifestID: manifestID,
                contentFingerprint: fingerprints[index],
                ready: true,
                sync: slot.sync,
              }) satisfies WarmWorktreeRecord,
          )
          // A fresh host holds exactly the checkout's refs minus Arena's own, so this mirror
          // should find nothing to do; it also copies `origin`. A failure here only costs the
          // send a full mirror.
          const mirrorWarmHost = (slot: WarmWorktreeRecord) =>
            withGit(mirrorCanonicalRefs({ canonical: chat.repository.root, host: hostRepoPath(slot.directory) })).pipe(
              preparationPhase("mirror-refs", { chatID: chat._id, turnID, side: slot.side }),
              Effect.as({ ...slot, refsMirrored: true }),
              Effect.catchCause((cause) =>
                Effect.logWarning("Arena warm ref mirror failed; the send mirrors in full", {
                  chatID: chat._id,
                  side: slot.side,
                  cause,
                }).pipe(Effect.as(slot)),
              ),
            )
          // The mirror reads the checkout's refs, so it takes the lock again, as the retirements do.
          const mirrored = yield* withRepositoryMutation(
            lock,
            Effect.gen(function* () {
              const mirrored = yield* Effect.forEach(records, mirrorWarmHost, { concurrency: 2 })
              // One free worktree is enough to spare; the rest would only be watched and kept.
              const unused = claimed.free.filter(
                (directory) => directory !== claimed.sources.a && directory !== claimed.sources.b,
              )
              yield* Effect.forEach(
                unused.slice(1),
                (directory) =>
                  retireSlot(chat, directory).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Arena could not retire a surplus worktree", {
                        chatID: chat._id,
                        directory,
                        cause,
                      }),
                    ),
                  ),
                { discard: true },
              )
              return mirrored
            }),
          )
          // Forked under the start lock the caller holds, so a send to this chat waits for a ready
          // pair instead of taking directories a fork is still writing into.
          const [a, b] = yield* prepareWarmSessions(store, chat, generation, mirrored, (id) => forkedSessions.push(id))
          if (!a || !b) return yield* Effect.fail(new Error("Warm pair preparation lost a side"))
          // Publish readiness before the caller hands the start lock to a waiting send, so it can
          // claim this pair as soon as its snapshot is ready.
          yield* writeWarmRecord(store, owner, { generation, state: "ready", worktrees: { a, b } })
          if (warmMark) warmMarks.set(key, warmMark)
          trustWarmPair(store, chat._id, generation)
          yield* promise(() =>
            store.updateChat({ _id: chat._id }, { $set: { warmGeneration: generation, updatedAt: new Date() } }),
          )
          return { a, b }
        }),
      )
      if (superseded) {
        // The turn that superseded this builds its own pair. Leave no warm record: the turn
        // then prepares both sides, which is the fallback a missing pair already has, and the
        // readiness strip stays quiet because nothing failed. A first pair that stood down for
        // the agent's own prompt is prepared again the next time the chat is opened.
        yield* writeWarmRecord(store, owner, undefined)
        distrustWarmPair(store, chat._id, generation)
        yield* disposeWarmSessions(forkedSessions)
        yield* discardAttemptManifest
        // This attempt began the journal; a chat that is gone has no turn to keep it for.
        const current = yield* promise(() => store.chat(chat._id))
        if (current?.status === "archived" || current?.checkoutEvicted) {
          yield* promise(() => journal.stop(chat._id)).pipe(Effect.ignore)
        }
        yield* Effect.logInfo("Arena warm preparation stood down for a turn that started", {
          chatID: chat._id,
          turnID,
          generation,
        })
        return
      }
      if (Exit.isFailure(outcome)) {
        yield* withRepositoryMutation(
          lock,
          Effect.forEach(touched, (directory) => retireSlot(chat, directory).pipe(Effect.ignore), {
            concurrency: 2,
            discard: true,
          }),
        )
        yield* writeWarmRecord(store, owner, { ...pending, state: "failed", error: Cause.pretty(outcome.cause) })
        distrustWarmPair(store, chat._id, generation)
        warmMarks.delete(key)
        yield* disposeWarmSessions(forkedSessions)
        yield* discardAttemptManifest
        yield* promise(() =>
          store.updateChat({ _id: chat._id }, { $set: { warmGeneration: generation, updatedAt: new Date() } }),
        )
        return
      }
      yield* Effect.logInfo("Arena warm pair prepared", {
        chatID: chat._id,
        turnID,
        generation,
        durationMs: Math.round(performance.now() - startedAt),
        sides: JSON.stringify({ a: outcome.value.a.sync, b: outcome.value.b.sync }),
      })
    })

    /**
     * Warming stays after completion, in the detached vote task. Serialize it with admission
     * before either path snapshots or claims this generation. A submission that arrives during
     * warming reuses the completed pair; if admission wins, skip warming before copying anything.
     * The generation check also prevents delayed housekeeping from warming an obsolete turn.
     */
    const prepareWarmPairAfterCompletion = Effect.fn("Arena.prepareWarmPairAfterCompletion")(function* (
      store: Store,
      chat: ChatDocument,
      turn: TurnDocument,
    ) {
      yield* turnStartLock(chat._id)
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* promise(() => store.chat(chat._id))
            if (
              !current ||
              current.status !== "ready" ||
              current.activeTurnID ||
              current.checkoutEvicted ||
              current.turnCount !== turn.turnIndex + 1
            )
              return
            yield* prepareWarmPair(store, current, { kind: "turn", turn })
          }),
        )
        .pipe(
          preparationPhase("warm", { chatID: chat._id, turnID: turn._id }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Arena warm preparation failed", { chatID: chat._id, turnID: turn._id, cause }),
          ),
        )
    })

    // A chat's first pair while it is being prepared, so opening the chat again joins it.
    const initialWarmUps = new Map<string, Fiber.Fiber<void>>()
    // Chats whose first pair failed in this process: failures in a row, and when the next try may start.
    const initialWarmRetries = new Map<string, { readonly failures: number; readonly at: number }>()

    /**
     * Whether a chat's first turn still wants a pair: nothing sent, nothing in the way of a send,
     * and no pair ready. A conflicted trunk refuses the send, so it gets no pair either. Nor does
     * a chat whose agent is working: the checkout is half edited, the transcript is still being
     * written, and the agent's next edits would leave the pair stale.
     */
    const wantsInitialWarmPair = (chat: ChatDocument) =>
      chat.turnCount === 0 &&
      chat.status === "ready" &&
      !chat.activeTurnID &&
      !chat.checkoutEvicted &&
      !chat.trunkConflicts?.length &&
      !activeNormalTurns.active(chat.canonicalSessionID) &&
      chat.initialWarmPreparation?.state !== "ready"

    /**
     * Prepare a chat's first pair once it has been open a moment without a send, so its first
     * send reuses a pair as every later one does. Opening or subscribing never waits on this, and
     * a failure only leaves that send to build its own pair. Like the warm-up after a vote it runs
     * under the start lock, so a send arriving meanwhile waits for the pair and then reuses it.
     */
    const warmInitialPair = Effect.fnUntraced(function* (store: Store, chat: ChatDocument) {
      if (!initialWarmEnabled()) return
      // A pending record is a warm-up or a send's refresh running now; one a stopped process left
      // is cleared at startup.
      if (!wantsInitialWarmPair(chat) || chat.initialWarmPreparation?.state === "pending") return
      const chatID = chat._id
      if (initialWarmUps.has(chatID)) return
      if ((initialWarmRetries.get(chatID)?.at ?? 0) > Date.now()) return
      const owner: WarmOwner = { kind: "chat", chatID }
      const fiber = yield* Effect.sleep(Duration.millis(INITIAL_WARM_DELAY_MS)).pipe(
        Effect.andThen(
          turnStartLock(chatID)
            .withPermits(1)(
              Effect.gen(function* () {
                const current = yield* promise(() => store.chat(chatID))
                if (!current || !wantsInitialWarmPair(current)) return
                const checkout = current.canonicalCheckout?.root ?? current.repository.root
                if (yield* promise(() => store.checkoutEviction(checkout))) return
                const attempt = yield* Effect.exit(prepareWarmPair(store, current, owner))
                // A stand-down leaves no record and is no failure; the next open simply tries again.
                const state = (yield* warmRecordFor(store, current))?.preparation.state
                if (state === "ready") initialWarmRetries.delete(chatID)
                else if (state === "failed" || Exit.isFailure(attempt)) {
                  const failures = (initialWarmRetries.get(chatID)?.failures ?? 0) + 1
                  const wait = Math.min(INITIAL_WARM_RETRY_MS * 2 ** (failures - 1), INITIAL_WARM_RETRY_MAX_MS)
                  initialWarmRetries.set(chatID, { failures, at: Date.now() + wait })
                }
                if (Exit.isFailure(attempt)) return yield* Effect.failCause(attempt.cause)
              }),
            )
            .pipe(preparationPhase("warm", { chatID })),
        ),
        Effect.catchCause((cause) => Effect.logWarning("Arena initial warm preparation failed", { chatID, cause })),
        Effect.forkIn(scope),
      )
      initialWarmUps.set(chatID, fiber)
      fiber.addObserver(() => {
        if (initialWarmUps.get(chatID) === fiber) initialWarmUps.delete(chatID)
      })
    })

    /**
     * The chat's next pair when a restart left it ready but untrusted and nothing is about to use
     * or change it: the chat is idle the way a send is admitted, and the pair is its next turn's.
     */
    const restartedWarmPair = Effect.fnUntraced(function* (store: Store, chat: ChatDocument) {
      const idle =
        chat.status === "ready" &&
        !chat.activeTurnID &&
        !chat.checkoutEvicted &&
        !chat.trunkConflicts?.length &&
        !activeNormalTurns.active(chat.canonicalSessionID)
      if (!idle || chat.warmGeneration !== chat.turnCount) return undefined
      if (yield* promise(() => store.checkoutEviction(chat.canonicalCheckout?.root ?? chat.repository.root))) {
        return undefined
      }
      // The canonical session moves to the winner at every vote, so a pass on it came after the
      // last battle: the user is working with the agent, whose next edits would leave the pair
      // stale.
      if (yield* promise(() => store.latestSingleAgentRating(chat.canonicalSessionID))) return undefined
      const found = yield* warmRecordFor(store, chat)
      if (found?.preparation.state !== "ready" || isWarmPairTrusted(store, chat._id, chat.turnCount)) return undefined
      return found
    })

    /**
     * A restart leaves every ready pair untrusted, and a send refreshes an untrusted pair: a new
     * host, a new fork, and a clone of every ignored root this process has no record of. The
     * chat worked in last is the one most likely to be sent to next, so its pair is prepared
     * again in the background and that send reuses it. Only that chat: an older one is less
     * likely to be sent to than to hold up, while its host copies take the repository lock, a
     * vote or a prompt in the chat the user is in. The others keep their pairs for a refresh at
     * their next send. Like the warm-up after a vote it runs under the start lock, so a send
     * arriving meanwhile waits for the pair and then reuses it; unlike it, it stands down for a
     * prompt to the chat's agent that comes before its build claims the two worktrees.
     */
    const rewarmLatestPair = Effect.fnUntraced(function* (store: Store) {
      const chats = yield* promise(() => store.chats.find({}).toArray())
      const latest = chats
        .filter((chat) => chat.status !== "archived")
        .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0]
      if (!latest || !(yield* restartedWarmPair(store, latest))) return
      const chatID = latest._id
      yield* Effect.sleep(Duration.millis(RESTART_REWARM_DELAY_MS))
      yield* turnStartLock(chatID)
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* promise(() => store.chat(chatID))
            const found = current ? yield* restartedWarmPair(store, current) : undefined
            if (!current || !found) return
            const generation = current.turnCount
            yield* Effect.logInfo("Arena re-warming the latest pair after a restart", { chatID, generation })
            yield* prepareWarmPair(store, current, found.owner, true)
            // A stand-down leaves no record.
            const outcome = (yield* warmRecordFor(store, current))?.preparation.state ?? "stood down"
            yield* Effect.logInfo("Arena re-warmed the latest pair after a restart", { chatID, generation, outcome })
          }),
        )
        .pipe(preparationPhase("warm", { chatID }))
    })

    const retainWinnerAndStopLoser = Effect.fn("Arena.retainWinnerAndStopLoser")(function* (
      store: Store,
      chat: ChatDocument,
      turn: TurnDocument,
      winner: RunDocument,
      runs: readonly RunDocument[],
    ) {
      if (!winner.finalCommit) return yield* Effect.fail(new Error("Arena winner has no final commit"))
      const services = yield* captureRunServices(store, winner)
      const current = yield* promise(() => store.turn(turn._id))
      if (current?.applyBaseChoice === "discard_winner") return
      yield* promise(() =>
        store.updateRun(winner._id, {
          services,
          retention: "retained_until_next_send",
        }),
      )
      yield* promise(() =>
        store.updateChat(
          { _id: chat._id, activeTurnID: turn._id },
          {
            $set: {
              retainedWinner: {
                runID: winner._id,
                worktree: winner.worktree,
                resultRef: `${refRoot(turn)}/selected`,
                state: "live",
              },
              updatedAt: new Date(),
            },
          },
        ),
      )

      const loser = runs.find((run) => run.side !== winner.side)
      if (!loser) {
        yield* promise(() => store.updateTurn(turn._id, { cleanup: { state: "complete" } }))
        return
      }
      // The loser's run is over, so its instance and its services are all that can still write
      // into the worktree. Stopping them here starts the settle window of the worktree's watch
      // while the winner is still being applied, instead of when the warm-up adopts it.
      // Stopping the loser's services stays inline: its port is the next turn's side-B port,
      // so a server still holding it has to be gone before anything dispatches. Unlinking its
      // worktree does not — that is a 5 GB tree nobody is waiting on, and it used to sit
      // between the vote and the chat becoming ready.
      const loserCleanup = yield* Effect.exit(
        trackOperation(
          store,
          turn._id,
          "releasing_loser",
          Effect.gen(function* () {
            yield* stopPreparation(loser.worktree)
            yield* instances.disposeDirectory(loser.worktree)
            const instanceStoppedAt = Date.now()
            const stopped = yield* stopRunServices(store, loser)
            const failures = stopped.filter((record) => record.status === "failed" || !record.verified)
            if (failures.length > 0) {
              yield* promise(() => store.updateRun(loser._id, { retention: "cleanup_failed" }))
              return yield* Effect.fail(
                new Error(`Arena could not stop ${failures.length} losing service${failures.length === 1 ? "" : "s"}`),
              )
            }
            return { instanceStoppedAt, stoppedCount: stopped.length }
          }),
        ),
      )
      if (Exit.isFailure(loserCleanup)) {
        yield* promise(() =>
          store.updateTurn(turn._id, { cleanup: { state: "failed", error: Cause.pretty(loserCleanup.cause) } }),
        )
        return
      }
      const { instanceStoppedAt, stoppedCount } = loserCleanup.value
      // With no service to stop, the instance was the last writer; the scan that found nothing
      // does not have to count against the settle window.
      markSlotStopped(loser.worktree, stoppedCount === 0 ? instanceStoppedAt : Date.now())
      // Left `pending` for `removeLoserWorktree`, which runs once the chat is `ready`.
      yield* promise(() => store.updateTurn(turn._id, { cleanup: { state: "pending" } }))
      return loser
    })

    /**
     * The other half of the loser's cleanup, split off so it runs after `completeTurn`: the
     * loser lets go of its worktree, which the next pair then adopts. Ordering, not forking: the
     * tail of a promotion is already detached from the vote, and the warm-up that follows needs
     * the worktree released.
     *
     * A release that fails is reported after the fact rather than holding the turn open. The
     * worktree then stays owned, and the next pair is built without it.
     */
    const removeLoserWorktree = Effect.fn("Arena.removeLoserWorktree")(function* (
      store: Store,
      chat: ChatDocument,
      turn: TurnDocument,
      loser: RunDocument,
    ) {
      // In the service's scope and tracked, so archive and eviction wait for it rather than
      // remove the worktree while it is being released.
      const release = yield* releaseRunSlot(store, loser).pipe(Effect.forkIn(scope))
      slotReleases.set(chat._id, release)
      release.addObserver(() => {
        if (slotReleases.get(chat._id) === release) slotReleases.delete(chat._id)
      })
      const removal = yield* Fiber.await(release)
      if (Exit.isFailure(removal)) {
        yield* Effect.logWarning("Arena losing worktree release failed", {
          turnID: turn._id,
          runID: loser._id,
          cause: removal.cause,
        })
      }
      yield* promise(() =>
        store.updateTurn(turn._id, {
          cleanup: Exit.isFailure(removal)
            ? { state: "failed", error: Cause.pretty(removal.cause) }
            : { state: "complete" },
        }),
      )
    })

    const cleanup = Effect.fn("Arena.cleanup")(function* (store: Store, turn: TurnDocument, _canonical: string) {
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const runs = yield* ensureArchives(store, turn)
      const currentRecorder = recorder
      if (currentRecorder) {
        yield* promise(() => currentRecorder.flush(turn._id))
        runs.forEach((run) => currentRecorder.unregister(run._id))
      }
      const failures = yield* Effect.forEach(
        runs,
        (run) =>
          Effect.gen(function* () {
            const stopped = yield* stopRunServices(store, run)
            const stopFailures = stopped.filter((record) => record.status === "failed" || !record.verified)
            if (stopFailures.length > 0) {
              yield* promise(() => store.updateRun(run._id, { retention: "cleanup_failed" }))
              return yield* Effect.fail(new Error("Arena could not verify service shutdown"))
            }
            yield* removeStoppedRun(store, chat, run)
          }).pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) =>
              Effect.logWarning("Arena worktree cleanup failed", {
                turnID: turn._id,
                runID: run._id,
                cause,
              }).pipe(Effect.as({ runID: run._id, error: Cause.pretty(cause) })),
            ),
          ),
        { concurrency: 2 },
      )
      const errors = failures.filter((failure) => failure !== undefined)
      if (turn.applyBaseChoice === "discard_winner" && turn.appliedSide) {
        const winner = runs.find((run) => run.side === turn.appliedSide)
        if (winner) {
          yield* promise(() =>
            store.chats.updateOne(
              { _id: chat._id, activeTurnID: turn._id, "retainedWinner.runID": winner._id },
              { $unset: { retainedWinner: "" }, $set: { updatedAt: new Date() } },
            ),
          )
        }
      }
      yield* promise(() =>
        store.updateTurn(turn._id, {
          cleanup: errors.length
            ? {
                state: "failed",
                error: errors.map((failure) => `${failure.runID}: ${failure.error}`).join("\n"),
              }
            : { state: "complete" },
        }),
      )
    })

    /**
     * Finish a parked promotion by discarding the selected result itself. A review parks after the
     * winner's transcript is grafted, so this path must not graft it again and must not run Git
     * promotion. The canonical transcript is read after cleanup
     * so messages the developer sent while the divergence was paused remain in the conversation.
     */
    const discardWinner = Effect.fn("Arena.discardWinner")(function* (store: Store, turn: TurnDocument) {
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const runs = yield* ensureArchives(store, turn)
      const winner = turn.appliedSide ? runs.find((run) => run.side === turn.appliedSide) : undefined

      // Write this before cleanup. If the daemon stops after the claim but before cleanup, startup
      // recovery sees the durable discarded marker and cannot fall through to Git application.
      yield* promise(() =>
        store.updateTurn(turn._id, {
          gitApplication: {
            state: "discarded",
            reason: "The winning result was discarded; the canonical checkout was left untouched.",
            ...(winner?.finalCommit ? { resultCommit: winner.finalCommit } : {}),
            ...(turn.gitApplication?.baseCommit ? { baseCommit: turn.gitApplication.baseCommit } : {}),
          },
        }),
      )
      yield* promise(() => store.transitionTurn(turn._id, "discarding"))
      yield* cleanup(store, turn, chat.repository.root)

      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(chat.canonicalSessionID) })
        .pipe(Effect.mapError(error))
      yield* recordCanonicalTranscript(store, chat._id, messages)
      const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
      yield* promise(() => store.transitionTurn(turn._id, "discarded"))
      yield* promise(() =>
        store.completeTurn({
          chatID: chat._id,
          turnID: turn._id,
          canonicalSHA: canonical.head,
          canonicalSessionID: chat.canonicalSessionID,
          ...(canonical.branch ? { branch: canonical.branch } : {}),
          detached: canonical.detached,
          indexTree: canonical.indexTree,
          trunkConflicts: canonical.conflicts,
          completedAt: new Date(),
        }),
      )
      return yield* respond(store, chat._id)
    })

    const recoverExecutingTurn = Effect.fn("Arena.recoverExecutingTurn")(function* (
      store: Store,
      turn: TurnDocument,
      canonical: string,
    ) {
      if (turn.state === "early_selected" && turn.resolution?.kind === "early" && turn.appliedSide) {
        const runs = yield* promise(() => store.runsForTurn(turn._id))
        const unfinished = runs.filter((run) => !run.finalizedAt)
        yield* Effect.forEach(
          unfinished,
          (saved) =>
            Effect.gen(function* () {
              const runtime: SideRuntime = {
                side: saved.side,
                turnID: saved.turnID,
                runID: saved._id,
                sessionID: SessionID.make(saved.rootSessionID),
                worktree: {
                  name: `turn-${turn.turnIndex}-${saved.side}`,
                  directory: saved.worktree,
                },
                assignment: saved.assignment,
              }
              yield* cancelRun(runtime.worktree.directory, runtime.sessionID)
              const settled = yield* Effect.exit(
                finalizeSide(
                  store,
                  turn,
                  runtime,
                  Exit.fail(new Error("Arena process restarted after an early selection")),
                  true,
                  "interrupted",
                ),
              )
              if (Exit.isFailure(settled)) return
              yield* promise(() => store.updateRun(saved._id, { selectable: false, finalizedAt: new Date() }))
              yield* promise(() =>
                store.markRunFinalized({
                  turnID: turn._id,
                  side: saved.side,
                  selectable: false,
                  at: new Date(),
                }),
              )
            }),
          { concurrency: 2, discard: true },
        )
        return yield* promote(store, turn, turn.appliedSide, turn.resolution, turn.vote, true).pipe(
          Effect.catchCause((cause) =>
            promise(() =>
              store.updateTurn(turn._id, {
                gitApplication: { state: "failed", reason: Cause.pretty(cause) },
              }),
            ).pipe(
              Effect.andThen(promise(() => store.transitionTurn(turn._id, "application_failed"))),
              Effect.as(undefined),
            ),
          ),
        )
      }
      if (turn.state !== "interrupted_recovery") {
        yield* promise(() => store.transitionTurn(turn._id, "interrupted_recovery"))
      }
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const recovered = new Map<
        Side,
        { result: Pick<FinalizedResult, "finalCommit">; transcript: string; artifactID: string }
      >()
      yield* Effect.forEach(
        runs,
        (saved) =>
          Effect.gen(function* () {
            const runtime: SideRuntime = {
              side: saved.side,
              turnID: saved.turnID,
              runID: saved._id,
              sessionID: SessionID.make(saved.rootSessionID),
              worktree: { name: `turn-${turn.turnIndex}-${saved.side}`, directory: saved.worktree },
              assignment: saved.assignment,
            }
            const interrupted = "Arena process restarted while the contestant was executing"
            const result = saved.finalCommit
              ? yield* promise(() =>
                  store.updateRun(saved._id, {
                    runState: "interrupted",
                    durationMs: null,
                    error: interrupted,
                    completedAt: new Date(),
                  }),
                ).pipe(
                  Effect.andThen(archive(store, turn, runtime, "interrupted", interrupted)),
                  Effect.map((archived) => ({
                    result: { finalCommit: saved.finalCommit! },
                    ...archived,
                  })),
                )
              : yield* finalizeSide(store, turn, runtime, Exit.fail(new Error(interrupted)), true, "interrupted")
            recovered.set(saved.side, result)
          }).pipe(
            Effect.catchCause((cause) =>
              promise(() =>
                store.updateRun(saved._id, {
                  runState: "interrupted",
                  durationMs: null,
                  error: Cause.pretty(cause),
                  completedAt: new Date(),
                }),
              ).pipe(
                Effect.andThen(
                  Effect.logWarning("Arena could not archive an interrupted side", {
                    turnID: turn._id,
                    runID: saved._id,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        { concurrency: 2, discard: true },
      )
      yield* promise(() => store.transitionTurn(turn._id, "awaiting_stop_resolution"))
      const a = recovered.get("a")
      const b = recovered.get("b")
      if (a && b && turn.comparisonState !== "complete") {
        yield* startUtility(store, turn, a, b, canonical).pipe(
          Effect.catchCause((cause) =>
            promise(() => store.updateTurn(turn._id, { comparisonState: "failed" })).pipe(
              Effect.andThen(
                Effect.logWarning("Arena interrupted comparison failed", {
                  turnID: turn._id,
                  cause,
                }),
              ),
            ),
          ),
          Effect.forkIn(scope),
        )
      } else if (!a || !b) {
        yield* promise(() => store.updateTurn(turn._id, { comparisonState: "failed" }))
      }
    })

    /**
     * A pending pair was being prepared or refreshed when the previous process stopped, and
     * nothing will finish it: its record goes, so the send builds its pair as with none and the
     * chat's first pair is prepared again when the chat is opened. Left, it would keep the first
     * pair from ever being prepared and the checkout from being evicted. Worktrees it had reached
     * stay in the pool, free for the next warm-up to adopt and sync. Cleared for a chat whose
     * checkout is missing too, since nothing else would clear it once the checkout is back.
     */
    const clearInterruptedWarmPair = Effect.fnUntraced(function* (store: Store, chat: ChatDocument) {
      const found = yield* warmRecordFor(store, chat)
      if (found?.preparation.state !== "pending") return false
      yield* writeWarmRecord(store, found.owner, undefined)
      yield* disposeWarmSessions(Object.values(found.preparation.worktrees).map((slot) => slot?.forkedSessionID))
      yield* Effect.logInfo("Arena warm pair was interrupted by the daemon stopping", {
        chatID: chat._id,
        generation: found.preparation.generation,
      })
      return true
    })

    /**
     * The next pair as the previous process left it. A ready pair was not watched while the
     * daemon was down, so it is never reused as it stands; it is kept untrusted, and the next send
     * brings it to its base where it stands (a fresh host and the same sync as warm-up), which
     * writes only what changed and is exact whatever happened meanwhile. Only a pair that is
     * structurally gone is removed.
     */
    const reconcileWarmPair = Effect.fn("Arena.reconcileWarmPair")(function* (store: Store, chat: ChatDocument) {
      if (yield* clearInterruptedWarmPair(store, chat)) return
      if (chat.warmGeneration !== chat.turnCount) return
      const found = yield* warmRecordFor(store, chat)
      const preparation = found?.preparation.state === "ready" ? found.preparation : undefined
      const a = preparation?.worktrees.a
      const b = preparation?.worktrees.b
      if (!found || !preparation || !a || !b) return
      distrustWarmPair(store, chat._id, chat.turnCount)
      const reconciled = yield* Effect.exit(
        Effect.gen(function* () {
          if (a.directory === b.directory || a.copyManifestID !== b.copyManifestID) {
            return yield* Effect.fail(new Error("Persisted warm pair identity does not match"))
          }
          const manifest = yield* copyManifestByID(
            store,
            a.copyManifestID,
            found.owner.kind === "turn" ? found.owner.turn._id : undefined,
          )
          if (manifest.canonicalRoot !== chat.repository.root) {
            return yield* Effect.fail(new Error("Persisted warm pair belongs to a different trunk worktree"))
          }
          for (const slot of [a, b]) {
            const link = yield* Effect.promise(() => lstat(join(slot.directory, ".git")).catch(() => undefined))
            if (!link?.isFile()) {
              return yield* Effect.fail(new Error(`Warm side ${slot.side.toUpperCase()} is no longer a worktree`))
            }
          }
        }),
      )
      if (Exit.isSuccess(reconciled)) {
        yield* Effect.logInfo("Arena warm pair was not observed while the daemon was down", {
          chatID: chat._id,
          generation: chat.turnCount,
        })
        return
      }
      yield* withRepositoryMutation(
        chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
        Effect.forEach([a, b], (slot) => retireSlot(chat, slot.directory).pipe(Effect.ignore), {
          concurrency: 1,
          discard: true,
        }),
      )
      yield* writeWarmRecord(store, found.owner, {
        ...preparation,
        state: "failed",
        error: Cause.pretty(reconciled.cause),
      })
      yield* disposeWarmSessions([a.forkedSessionID, b.forkedSessionID])
    })

    const reconcileComparisons = Effect.fn("Arena.reconcileComparisons")(function* (store: Store) {
      if (reconciledComparisonStores.has(store)) return
      const turns = (yield* promise(() => store.turns.find({}).toArray())).filter(
        (turn) => turn.comparisonState === "pending" || turn.comparisonState === "running",
      )
      yield* Effect.forEach(
        turns,
        (turn) =>
          Effect.gen(function* () {
            const comparison = yield* promise(() => store.comparisons.findOne({ turnID: turn._id }))
            if (comparison?.state === "complete" || comparison?.state === "failed") {
              yield* promise(() =>
                store.updateTurn(turn._id, {
                  comparisonState: comparison.state,
                  comparisonID: comparison._id,
                }),
              )
              return
            }
            if (comparison) {
              yield* promise(() =>
                store.updateComparison(comparison._id, {
                  state: "failed",
                  error: "Arena utility comparison was interrupted by a process restart",
                }),
              )
            }
            yield* promise(() =>
              store.updateTurn(turn._id, {
                comparisonState: "failed",
                ...(comparison ? { comparisonID: comparison._id } : {}),
              }),
            )
          }),
        { concurrency: 1, discard: true },
      )
      reconciledComparisonStores.add(store)
    })

    /**
     * Rebuild analytics rows that are missing or were computed against an older
     * definition. The write that produces them at vote time is a forked fiber, and a
     * fiber killed when the scope closes is interrupted rather than failed, so it
     * leaves no error behind — a daemon restart between the vote and the write loses
     * the row silently and nothing ever retries. Everything the row is derived from
     * is durable, so the repair is to recompute rather than to make the write
     * synchronous and let analytics delay a vote.
     *
     * Bounded per startup: this is catch-up work, not a migration that has to finish
     * before the daemon is useful, and the query is a no-op once it has.
     */
    const reconcileBattleMetrics = Effect.fn("Arena.reconcileBattleMetrics")(function* (store: Store) {
      const stale = yield* promise(() => store.staleBattleMetrics(battleMetricsSchemaVersion, 200))
      if (stale.length === 0) return
      yield* Effect.logInfo("Arena rebuilding battle metrics", { turns: stale.length })
      let rebuilt = 0
      yield* Effect.forEach(
        stale,
        (turn) =>
          recordBattleMetrics(store, turn._id).pipe(
            Effect.andThen(Effect.sync(() => void (rebuilt += 1))),
            // One unreadable turn must not stop the rest of the catch-up.
            Effect.catchCause((cause) =>
              Effect.logWarning("Arena could not rebuild battle metrics", { turnID: turn._id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      )
      yield* Effect.logInfo("Arena rebuilt battle metrics", { rebuilt, of: stale.length })
    })

    recoverInterrupted = Effect.fn("Arena.recoverInterrupted")(function* (store: Store) {
      yield* reconcileComparisons(store)
      const chats = yield* promise(() => store.chats.find({}).toArray())
      yield* Effect.forEach(
        chats,
        (chat) =>
          Effect.gen(function* () {
            // An archive the previous process did not finish leaves worktrees or trash in the pool.
            // In the background: nothing waits on an archived chat, and recovery gates every call.
            if (chat.status === "archived") {
              yield* retireSlotPool(chat).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Arena could not clear an archived chat's worktrees", { chatID: chat._id, cause }),
                ),
                Effect.forkIn(scope),
              )
              return
            }
            const currentChat =
              (chat.status === "ready" || chat.status === "blocked") && !chat.checkoutEvicted
                ? yield* reconcileCanonicalAvailability(store, chat)
                : chat
            if (currentChat.status === "blocked") {
              yield* clearInterruptedWarmPair(store, currentChat)
              return
            }
            if (currentChat.status === "ready") {
              if (currentChat.activeTurnID) return
              const turns = yield* promise(() => store.turnsForChat(currentChat._id))
              yield* reconcileWarmPair(store, currentChat)
              // Trees a previous process moved aside and did not finish deleting.
              yield* sweepSlotTrash(currentChat)
              const stranded = turns.at(-1)
              if (
                stranded?.state !== "cleanup_pending" ||
                stranded.cleanup?.state !== "complete" ||
                stranded.resultingCanonicalSHA !== currentChat.currentCanonicalSHA ||
                !stranded.canonicalUserMessageID
              )
                return
              yield* ensureArchives(store, stranded)
              const messages = yield* sessions
                .messages({ sessionID: SessionID.make(chat.canonicalSessionID) })
                .pipe(Effect.mapError(error))
              yield* recordCanonicalTranscript(store, currentChat._id, messages)
              yield* promise(() => store.transitionTurn(stranded._id, "complete"))
              return
            }
            if (currentChat.status !== "battle_active") return
            if (!currentChat.activeTurnID) {
              yield* promise(() =>
                store.updateChat(
                  { _id: currentChat._id, status: "battle_active", activeTurnID: { $exists: false } },
                  { $set: { status: "failed", updatedAt: new Date() } },
                ),
              )
              return
            }
            const turn = yield* promise(() => store.turn(currentChat.activeTurnID!))
            if (!turn) {
              yield* promise(() =>
                store.updateChat(
                  {
                    _id: currentChat._id,
                    status: "battle_active",
                    activeTurnID: currentChat.activeTurnID,
                  },
                  { $set: { status: "failed", updatedAt: new Date() } },
                ),
              )
              return
            }

            if (
              turn.state === "creating" ||
              turn.state === "worktrees_ready" ||
              turn.state === "running" ||
              turn.state === "early_selected" ||
              turn.state === "finalizing" ||
              turn.state === "stopping" ||
              turn.state === "creation_failed" ||
              turn.state === "finalization_failed" ||
              turn.state === "interrupted_recovery"
            ) {
              yield* recoverExecutingTurn(store, turn, chat.repository.root)
              return
            }

            if (turn.state === "application_failed" && turn.gitApplication?.state === "conflicted") {
              yield* ensureArchives(store, turn)
              if (!turn.resolution || turn.resolution.kind === "aborted" || !turn.appliedSide) return
              const claimed = yield* promise(() => store.claimTransition(turn._id, "application_failed", "applying"))
              if (claimed.claimed) {
                yield* promote(store, claimed.turn, turn.appliedSide, turn.resolution, turn.vote, true)
              }
              return
            }

            if (turn.state === "applying") {
              if (turn.applyBaseChoice === "discard_winner") {
                yield* discardWinner(store, turn)
                return
              }
              const runs = yield* ensureArchives(store, turn)
              if (!turn.resolution || turn.resolution.kind === "aborted" || !turn.appliedSide) {
                yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
                return
              }
              const winner = runs.find((run) => run.side === turn.appliedSide)
              if (turn.gitApplication?.state === "applied" && turn.resultingCanonicalSHA) {
                yield* promise(() => store.transitionTurn(turn._id, "canonicalizing"))
                yield* promise(() => store.transitionTurn(turn._id, "canonicalization_failed"))
                const retry = yield* promise(() => store.turn(turn._id))
                if (!retry) return yield* Effect.fail(new Error(`Arena turn not found: ${turn._id}`))
                yield* promote(store, retry, turn.appliedSide, turn.resolution, turn.vote, true)
                return
              }
              if (
                turn.gitApplication?.state === "conflicted" ||
                turn.gitApplication?.state === "manual" ||
                turn.gitApplication?.state === "blocked" ||
                turn.gitApplication?.state === "failed"
              ) {
                yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
                return
              }
              const safetyRef = `${refRoot(turn)}/public-safety`
              yield* withRepositoryMutation(
                chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
                withGit(
                  recoverFailedPromotion({
                    canonical: chat.repository.root,
                    safetyRef,
                    expectedBranch: chat.arenaBranch,
                    expectedDetached: chat.canonicalCheckout?.detached,
                    ...(winner?.branchChanged && winner.finalBranch ? { targetBranch: winner.finalBranch } : {}),
                  }),
                ),
              ).pipe(Effect.mapError(error))
              const failed = yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
              const claimed = yield* promise(() => store.claimTransition(turn._id, "application_failed", "applying"))
              if (claimed.claimed) {
                yield* promote(store, failed, turn.appliedSide, turn.resolution, turn.vote, true)
              }
              return
            }

            if (turn.state === "canonicalizing") {
              yield* ensureArchives(store, turn)
              yield* promise(() => store.transitionTurn(turn._id, "canonicalization_failed"))
              return
            }

            if (turn.state === "cleanup_pending") {
              if (!turn.resultingCanonicalSHA || !turn.canonicalUserMessageID) return
              const runs = yield* ensureArchives(store, turn)
              const winner = runs.find((run) => run.side === turn.appliedSide)
              if (!winner) return yield* Effect.fail(new Error("Arena recovery could not find the selected run"))
              const loser = yield* retainWinnerAndStopLoser(store, chat, turn, winner, runs)
              const messages = yield* sessions
                .messages({ sessionID: SessionID.make(chat.canonicalSessionID) })
                .pipe(Effect.mapError(error))
              yield* recordCanonicalTranscript(store, chat._id, messages)
              const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
              yield* promise(() => store.transitionTurn(turn._id, "complete"))
              yield* promise(() =>
                store.completeTurn({
                  chatID: chat._id,
                  turnID: turn._id,
                  canonicalSHA: canonical.head,
                  canonicalSessionID: chat.canonicalSessionID,
                  ...(canonical.branch ? { branch: canonical.branch } : {}),
                  detached: canonical.detached,
                  indexTree: canonical.indexTree,
                  trunkConflicts: canonical.conflicts,
                  completedAt: new Date(),
                }),
              )
              if (loser) yield* removeLoserWorktree(store, chat, turn, loser)
              const refreshedTurn = yield* promise(() => store.turn(turn._id))
              if (refreshedTurn) yield* prepareWarmPairAfterCompletion(store, chat, refreshedTurn)
              return
            }

            if (turn.state === "discarding") {
              yield* cleanup(store, turn, chat.repository.root)
              const messages = yield* sessions
                .messages({ sessionID: SessionID.make(chat.canonicalSessionID) })
                .pipe(Effect.mapError(error))
              yield* recordCanonicalTranscript(store, chat._id, messages)
              const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
              yield* promise(() => store.transitionTurn(turn._id, "discarded"))
              yield* promise(() =>
                store.completeTurn({
                  chatID: chat._id,
                  turnID: turn._id,
                  canonicalSHA: canonical.head,
                  canonicalSessionID: chat.canonicalSessionID,
                  ...(canonical.branch ? { branch: canonical.branch } : {}),
                  detached: canonical.detached,
                  indexTree: canonical.indexTree,
                  trunkConflicts: canonical.conflicts,
                  completedAt: new Date(),
                }),
              )
              return
            }

            if (turn.state === "complete" || turn.state === "discarded") {
              if (turn.state === "complete" && turn.canonicalUserMessageID) {
                const messages = yield* sessions
                  .messages({ sessionID: SessionID.make(chat.canonicalSessionID) })
                  .pipe(Effect.mapError(error))
                yield* recordCanonicalTranscript(store, chat._id, messages)
              }
              const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
              yield* promise(() =>
                store.completeTurn({
                  chatID: chat._id,
                  turnID: turn._id,
                  canonicalSHA: canonical.head,
                  canonicalSessionID: chat.canonicalSessionID,
                  ...(canonical.branch ? { branch: canonical.branch } : {}),
                  detached: canonical.detached,
                  indexTree: canonical.indexTree,
                  trunkConflicts: canonical.conflicts,
                  completedAt: new Date(),
                }),
              )
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Arena startup recovery failed", {
                chatID: chat._id,
                detail: Cause.pretty(cause),
                cause,
              }).pipe(Effect.andThen(Effect.fail(new Error(`Arena startup recovery failed for chat ${chat._id}`)))),
            ),
          ),
        { concurrency: 1, discard: true },
      )
      // In the background: recovery gates every call, and a failure only leaves the send to refresh.
      yield* rewarmLatestPair(store).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arena could not re-warm the latest pair after a restart", { cause }),
        ),
        Effect.forkIn(scope),
      )
      // Last: the chats above may have just resolved turns of their own.
      yield* reconcileBattleMetrics(store)
      if (idleUnloadStarted) return
      idleUnloadStarted = true
      // Wakes every second but passes at most once a minute, or once per threshold when it is shorter.
      let lastPass = 0
      yield* Effect.suspend(() => {
        if (Date.now() - lastPass < Math.min(60_000, idleUnloadMs())) return Effect.void
        lastPass = Date.now()
        return unloadIdleChats().pipe(
          Effect.catchCause((cause) => Effect.logWarning("Arena could not unload idle chats", { cause })),
        )
      }).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever, Effect.forkIn(scope))
    })

    // Copies the winner's messages for this turn into the chat's canonical session. The canonical
    // session is created once and never relocated, so a contestant's conversation is grafted onto it
    // rather than replacing it. Paths are rewritten on the way in because the contestant worktree the
    // transcript refers to is removed moments later by cleanup.
    //
    // The id bookkeeping mirrors Session.fork: assistant parentID has to be remapped through idMap or
    // the copied thread loses its structure.
    const graft = Effect.fn("Arena.graft")(function* (
      store: Store,
      chat: ChatDocument,
      turn: TurnDocument,
      winner: RunDocument,
    ) {
      const boundary = winner.promptMessageID
      if (!boundary) return
      // Already copied. The drop below cannot tell the winner's transcript from anything written
      // after it, and a parked promotion is exactly when something is: the prompt asking an agent
      // to resolve the conflict, and the whole conversation that resolves it, all sorting after
      // the anchor. Retrying used to delete that along with the copy it was replacing, so the
      // work that cleared the conflict vanished from the chat the moment it succeeded.
      if (turn.canonicalGraftedAt) return
      const canonical = SessionID.make(chat.canonicalSessionID)

      // A graft interrupted partway leaves the prompt message recorded but the rest of the turn
      // missing. Retrying has to drop that remnant first, otherwise the retry appends a second copy
      // alongside the first. Safe only because the marker above sends a finished graft home: an
      // interrupted one is joined before the turn can park, so nobody else has written here yet.
      const anchor = turn.canonicalUserMessageID
      if (anchor) {
        const existing = yield* sessions.messages({ sessionID: canonical }).pipe(Effect.mapError(error))
        yield* Effect.forEach(
          existing.filter((message) => message.info.id >= anchor),
          (message) =>
            sessions.removeMessage({
              sessionID: canonical,
              messageID: MessageID.make(message.info.id),
            }),
          { discard: true },
        )
      }

      const source = yield* sessions
        .messages({ sessionID: SessionID.make(winner.rootSessionID) })
        .pipe(Effect.mapError(error))
      const paths = {
        worktrees: yield* promise(() => store.worktreesForChat(chat._id)),
        canonical: chat.repository.root,
      }
      const canonicalize = <T>(value: T, role?: string) =>
        promise(() => canonicalizeTranscriptPaths(value, paths, role))
      const idMap = new Map<string, MessageID>()
      for (const message of source) {
        if (message.info.id < boundary) continue
        const id = MessageID.ascending()
        idMap.set(message.info.id, id)
        const parentID =
          message.info.role === "assistant" && message.info.parentID ? idMap.get(message.info.parentID) : undefined
        const cloned = yield* sessions.updateMessage(
          yield* canonicalize({ ...message.info, sessionID: canonical, id, ...(parentID ? { parentID } : {}) }),
        )
        // Persisted before the rest of the turn is copied so an interrupted graft is recoverable.
        if (message.info.id === boundary) {
          yield* promise(() => store.updateTurn(turn._id, { canonicalUserMessageID: cloned.id }))
        }
        for (const part of message.parts) {
          const next = yield* canonicalize(
            {
              ...part,
              id: PartID.ascending(),
              messageID: cloned.id,
              sessionID: canonical,
            },
            message.info.role,
          )
          if (next.type === "compaction" && next.tail_start_id) next.tail_start_id = idMap.get(next.tail_start_id)
          yield* sessions.updatePart(next)
        }
      }
      yield* promise(() => store.updateTurn(turn._id, { canonicalGraftedAt: new Date() }))
    })

    const transcriptFor = Effect.fn("Arena.transcriptFor")(function* (store: Store, run: RunDocument) {
      if (!run.transcriptArchiveID) return undefined
      const archive = yield* promise(() => store.sessionArchive(run._id))
      const artifactID = archive?.artifactIDs[0]
      if (!artifactID) return undefined
      const artifact = yield* promise(() => store.artifact(artifactID))
      if (!artifact) return undefined
      return yield* Effect.try({ try: () => ArenaTranscriptArtifact.decode(artifact), catch: error })
    })

    /**
     * Derive the analytics row for a resolved turn. Idempotent on
     * `${turnID}|${side}`, so a retried promote overwrites rather than
     * duplicates and a definition change can be replayed over history.
     */
    const recordBattleMetrics = Effect.fn("Arena.recordBattleMetrics")(function* (store: Store, turnID: string) {
      const turn = yield* promise(() => store.turn(turnID))
      if (!turn) return
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return
      const runs = yield* promise(() => store.runsForTurn(turnID))
      const generations = yield* promise(() => store.generationsForRuns(runs.map((run) => run._id)))
      const reviewEvents = yield* promise(() => store.reviewEventsForTurn(turnID))
      const transcripts: Partial<Record<Side, unknown>> = {}
      for (const run of runs) {
        const transcript = yield* transcriptFor(store, run)
        if (transcript !== undefined) transcripts[run.side] = transcript
      }
      const row = ArenaMetrics.computeBattleMetrics({
        chat,
        turn,
        runs,
        generations,
        reviewEvents,
        transcripts,
        computedAt: new Date(),
      })
      yield* promise(() => store.saveBattleMetrics(row))
    })

    /**
     * Everything the vote will write, decided before anything is: the branch the trunk ends on
     * and what happens to it, every other ref the winner moved, and the developer's uncommitted
     * edits. What `decideRef` settles on its own is applied; everything else is a review item,
     * answered from `turn.reviewAnswers` when an answer matches the situation it describes now.
     * A plan with open items writes nothing -- the promotion parks on them.
     */
    const planWinner = Effect.fn("Arena.planWinner")(function* (
      chat: ChatDocument,
      turn: TurnDocument,
      winner: RunDocument,
      source: { readonly branch?: string; readonly detached?: boolean },
    ) {
      const root = chat.repository.root
      const answers = turn.reviewAnswers
      const operation = yield* withGit(repositoryOperation(root)).pipe(Effect.mapError(error))
      if (operation) {
        const items: ReviewItem[] = [{ kind: "busy", key: "@busy", fingerprint: operation, operation }]
        return { kind: "review" as const, items, planned: [] as PlannedRef[], switchTo: undefined as string | undefined }
      }
      const frozenHead = turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA
      const permanentRef = winner.permanentRef ?? `${refRoot(turn)}/${winner.side}`
      const canonical = yield* withGit(inspectCanonical(root)).pipe(Effect.mapError(error))
      // A run finalized before the real HEAD was imported may have no commit to move a branch to.
      // Its files alone are measured against the chat branch, which loses what the winner moved
      // between branches, so a switch without the commit stops for the developer instead.
      const rawHead =
        winner.rawHead && (yield* withGit(containsCommit({ repository: root, commit: winner.rawHead })))
          ? winner.rawHead
          : undefined
      if (winner.branchChanged && winner.rawHead && !rawHead) {
        return yield* Effect.fail(
          new OperationError(
            "winner_head_missing",
            `This result was recorded by an older version of Arena without the winner's commits, so it cannot be moved to ${winner.finalBranch ?? "a new branch"}. Discard it, or apply its files by hand from ${refRoot(turn)}/selected.`,
          ),
        )
      }
      const items: ReviewItem[] = []
      const planned: PlannedRef[] = []
      let targetBranch = winner.branchChanged ? winner.finalBranch : undefined
      let checkoutAction: { action: BranchAction; start?: string; agent: string } | undefined
      let checkoutMove: CheckoutMove | undefined
      let takeTargetFrom: string[] | undefined
      let checkoutOpen = false
      // While the checkout's own branch waits for an answer, the files are measured as if the
      // developer keeps theirs, so the one callout can list them with everything else.
      let assumedCheckout: { action: BranchAction; agent: string } | undefined
      let targetOpen = false

      // A winner that left its branch for a detached HEAD with new commits: those commits are on
      // no branch, so Arena puts them on a new one under the first free `arena/turn-N` name.
      if (winner.branchChanged && !winner.finalBranch && rawHead && rawHead !== frozenHead) {
        for (let attempt = 1; !targetBranch; attempt++) {
          const name = `arena/turn-${turn.turnIndex + 1}${attempt > 1 ? `-${attempt}` : ""}`
          const target = yield* withGit(inspectBranchTarget({ canonical: root, branch: name })).pipe(Effect.mapError(error))
          if (target.valid && !target.tip) targetBranch = name
        }
        checkoutAction = { action: "agent", agent: rawHead }
        checkoutMove = { ref: `refs/heads/${targetBranch}` }
      }

      // The trunk cannot switch to a branch another worktree has checked out without taking it.
      if (targetBranch && !checkoutOpen) {
        const target = yield* withGit(inspectBranchTarget({ canonical: root, branch: targetBranch })).pipe(
          Effect.mapError(error),
        )
        if (target.valid && target.checkedOutAt) {
          const fingerprint = `${targetBranch}:${target.checkedOutAt}`
          const answer = answerFor(answers, { key: "@occupied", fingerprint })
          if (answer?.choice === "take") takeTargetFrom = [target.checkedOutAt]
          else if (answer?.choice === "stay") targetBranch = undefined
          else {
            checkoutOpen = true
            targetOpen = true
            items.push({
              kind: "occupied",
              key: "@occupied",
              fingerprint,
              branch: targetBranch,
              path: target.checkedOutAt,
              proposal: "take",
              choices: ["take", "stay"],
            })
          }
        }
      }

      const checkoutBranch = targetBranch ?? (source.detached ? undefined : canonical.branch)
      const observed = yield* withGit(
        observeWinnerRefs({
          canonical: root,
          changes: winner.refChanges ?? [],
          sourceRefPrefix: `${permanentRef}-refs`,
          ...(checkoutBranch ? { checkoutBranch } : {}),
        }),
      ).pipe(Effect.mapError(error))
      const writes: RefWrite[] = []
      const skipped = [...observed.skipped]
      let checkoutObserved = false
      for (const ref of observed.refs) {
        const decision = decideRef(ref)
        const answer = answerFor(answers, { key: ref.ref, fingerprint: ref.fingerprint })
        const action = resolveRef(decision, answer?.choice as BranchAction | undefined)
        if (ref.checkout) checkoutObserved = true
        if (decision.kind === "ask" && action === undefined) {
          if (ref.checkout) {
            checkoutOpen = true
            if (ref.yours) assumedCheckout = { action: "yours", agent: ref.agent ?? ref.yours }
          }
          items.push({
            kind: "ref",
            key: ref.ref,
            fingerprint: ref.fingerprint,
            namespace: ref.namespace,
            agentMove: ref.agentMove,
            yourMove: ref.yourMove,
            proposal: decision.proposal,
            choices: decision.choices,
            checkout: ref.checkout,
            ...(ref.checkedOutAt ? { checkedOutAt: ref.checkedOutAt } : {}),
            // The files the replay Arena could not make would conflict on, for the callout to list.
            ...(ref.clash.agent_on_yours || ref.clash.yours_on_agent
              ? { clash: ref.clash.agent_on_yours ?? ref.clash.yours_on_agent ?? [] }
              : {}),
            ...(ref.agent ? { agentRef: `${permanentRef}-refs/${ref.ref.slice("refs/".length)}` } : {}),
            ...(ref.lost !== undefined ? { lost: ref.lost } : {}),
            ...(ref.lostSubjects?.length ? { lostSubjects: ref.lostSubjects } : {}),
            ...(ref.rewound ? { rewound: true } : {}),
            ...(ref.agentSubject ? { agentSubject: ref.agentSubject } : {}),
          })
          continue
        }
        if (decision.kind === "skip") {
          skipped.push({
            ref: ref.ref,
            action: "skipped",
            reason: `${refLabel(ref.ref)} follows the server, so it was left for the next fetch.`,
          })
          continue
        }
        if (action === undefined || action === "yours") {
          if (ref.checkout && ref.yours) checkoutAction = { action: "yours", agent: ref.agent ?? ref.yours }
          // The agent's side is dropped from the developer's refs, never silently: the card says
          // so, and the battle refs keep the agent's version.
          if (decision.kind !== "none") {
            skipped.push({
              ref: ref.ref,
              action: "skipped",
              reason: keptReason(ref, `${permanentRef}-refs/${ref.ref.slice("refs/".length)}`),
            })
          }
          continue
        }
        if (decision.kind === "apply") planned.push({ ref: ref.ref, action })
        if (ref.checkout) {
          // The trunk's own branch is written with the checkout, never by the ref transaction.
          if (ref.agent) {
            checkoutAction = { action, ...(ref.start ? { start: ref.start } : {}), agent: ref.agent }
            checkoutMove = {
              ref: ref.ref,
              ...(ref.yours ? { before: ref.yours } : {}),
              ...(action === "agent_on_yours" || action === "yours_on_agent" ? { how: action } : {}),
            }
          }
          continue
        }
        if (action === "combine") continue
        writes.push({
          ref: ref.ref,
          action,
          ...(ref.start ? { start: ref.start } : {}),
          ...(ref.agent ? { agent: ref.agent } : {}),
          ...(ref.yours ? { yours: ref.yours } : {}),
          ...(ref.checkedOutAt ? { checkedOutAt: ref.checkedOutAt } : {}),
        })
      }

      // The trunk's branch did not move in the winner. A switch still lands on the branch as the
      // developer has it; a detached trunk nobody moved takes the winner's HEAD.
      if (!checkoutOpen && !checkoutAction && rawHead && !checkoutObserved) {
        if (targetBranch) {
          const target = yield* withGit(inspectBranchTarget({ canonical: root, branch: targetBranch })).pipe(
            Effect.mapError(error),
          )
          checkoutAction = { action: target.valid && target.tip ? "yours" : "agent", agent: rawHead }
          const before = target.valid ? target.tip : undefined
          checkoutMove = { ref: `refs/heads/${targetBranch}`, ...(before ? { before } : {}) }
        } else if (source.detached && canonical.detached && canonical.head === frozenHead && rawHead !== frozenHead) {
          checkoutAction = { action: "agent", start: frozenHead, agent: rawHead }
        }
      }

      // Measure the result against the developer's own files: their uncommitted edits, and their
      // new commits on the checkout's branch. Where the winner meets them, nothing is written
      // until the developer chooses. An open checkout question is measured as keeping theirs.
      let publicChoice: PublicChoice | undefined
      const measuredCheckout = checkoutOpen ? assumedCheckout : checkoutAction
      if (!targetOpen && (!checkoutOpen || assumedCheckout)) {
        const dry = yield* withGit(
          promoteWinnerState({
            canonical: root,
            ...(source.branch ? { expectedBranch: source.branch } : {}),
            ...(source.detached ? { expectedDetached: true } : {}),
            ...(targetBranch ? { targetBranch } : {}),
            frozenHead,
            baseWorkingTree: turn.baseSnapshot?.tree ?? turn.frozenBaseSHA,
            baseIndexTree: turn.baseSnapshot?.indexTree ?? turn.frozenBaseSHA,
            resultCommit: winner.finalCommit!,
            finalIndexTree: winner.finalIndexTree!,
            ...(measuredCheckout ? { checkoutAction: measuredCheckout } : {}),
            ...(takeTargetFrom ? { takeTargetFrom } : {}),
            safetyRef: `${refRoot(turn)}/public-safety`,
            dryRun: true,
          }),
        ).pipe(Effect.mapError(error))
        // Markers the developer already chose for the checkout's branch are not asked about again.
        const combined = checkoutAction?.action === "combine"
        const paths = [...new Set([...(combined ? dry.publicConflicts : dry.conflicts), ...dry.atRisk])].sort()
        if (paths.length > 0) {
          const fingerprint = yield* withGit(editsFingerprint(root, paths)).pipe(Effect.mapError(error))
          const answer = answerFor(answers, { key: "@edits", fingerprint })
          if (answer?.choice === "agent" || answer?.choice === "yours") publicChoice = { action: answer.choice, paths }
          else if (answer?.choice === "combine") {
            // Markers where a file can hold them; a file that cannot keeps the developer's copy.
            if (dry.atRisk.length > 0) publicChoice = { action: "yours", paths: [...dry.atRisk] }
          } else {
            items.push({
              kind: "edits",
              key: "@edits",
              fingerprint,
              paths,
              unmergeable: [...dry.atRisk].sort(),
              choices: ["combine", "agent", "yours"],
            })
          }
        }
      }

      if (items.length > 0) {
        return { kind: "review" as const, items, planned, ...(targetBranch ? { switchTo: targetBranch } : {}) }
      }
      return {
        kind: "apply" as const,
        ...(targetBranch ? { targetBranch } : {}),
        ...(checkoutAction ? { checkoutAction } : {}),
        ...(takeTargetFrom ? { takeTargetFrom } : {}),
        ...(checkoutMove ? { checkoutMove } : {}),
        ...(publicChoice ? { publicChoice } : {}),
        writes,
        skipped,
      }
    })

    const promote: (
      store: Store,
      turn: TurnDocument,
      side: Side,
      resolution:
        | ReturnType<typeof voteResolution>
        | ReturnType<typeof stoppedResolution>
        | ReturnType<typeof earlyResolution>,
      vote?: Vote,
      retry?: boolean,
      rawParticipantID?: string,
    ) => Effect.Effect<ReturnType<typeof project>, Error> = Effect.fn("Arena.promote")(function* (
      store: Store,
      turn: TurnDocument,
      side: Side,
      resolution:
        | ReturnType<typeof voteResolution>
        | ReturnType<typeof stoppedResolution>
        | ReturnType<typeof earlyResolution>,
      vote?: Vote,
      retry = false,
      rawParticipantID?: string,
    ) {
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      if (!retry) {
        const revealed = yield* promise(() => resolvedPlacement(turn, assignmentDecision(resolution)))
        resolution = committedResolution(resolution, revealed.decision)
        side = resolution.appliedSide ?? side
        vote = resolution.kind === "vote" ? resolution.vote : resolution.kind === "early" ? resolution.vote : undefined
        const recorded = yield* promise(() =>
          store.recordResolution({
            turnID: turn._id,
            resolution,
            vote,
            participantID: participantID(rawParticipantID),
            appliedSide: side,
            models: revealed.models,
            expectedState:
              turn.state === "awaiting_stop_resolution"
                ? "awaiting_stop_resolution"
                : resolution.kind === "vote"
                  ? "awaiting_vote"
                  : "awaiting_stop_resolution",
            at: new Date(),
          }),
        )
        if (!recorded.recorded) return yield* respond(store, turn.chatID)
        yield* revealTelemetry(recorded.turn, revealed.metrics)
        if (resolution.kind === "vote") {
          const acknowledged = yield* respond(store, turn.chatID)
          yield* promote(store, recorded.turn, side, resolution, vote, true, rawParticipantID).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const current = yield* promise(() => store.turn(turn._id))
                if (current?.state === "applying") {
                  yield* promise(() =>
                    store.updateTurn(turn._id, {
                      gitApplication: { state: "failed", reason: Cause.pretty(cause) },
                    }),
                  )
                  yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
                }
                yield* Effect.logError("Arena background vote application failed", { turnID: turn._id, cause })
              }),
            ),
            Effect.forkIn(scope),
          )
          return acknowledged
        }
      }
      const runs = yield* trackOperation(store, turn._id, "preserving_results", ensureArchives(store, turn))
      // Analytics only. Forked and swallowed so a metrics failure can never
      // block or fail a vote.
      yield* recordBattleMetrics(store, turn._id).pipe(
        Effect.catchCause((cause) => Effect.logError("Arena battle metrics failed", { turnID: turn._id, cause })),
        Effect.forkIn(scope),
      )
      const winner = runs.find((run) => run.side === side)
      if (!winner?.finalCommit || !winner.finalIndexTree || winner.applicability === "blocked") {
        yield* promise(() => store.transitionTurn(turn._id, "applying"))
        yield* promise(() =>
          store.updateTurn(turn._id, {
            gitApplication: {
              state: "blocked",
              reason:
                winner?.applicability === "blocked"
                  ? "The selected contestant's environment setup failed, so its result cannot be applied"
                  : "The selected result does not contain a complete finalized Git state",
              ...(winner?.finalCommit ? { resultCommit: winner.finalCommit } : {}),
            },
          }),
        )
        yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
        return yield* respond(store, turn.chatID)
      }
      const resultCommit = winner.finalCommit
      const selectedRef = `${refRoot(turn)}/selected`
      const safetyRef = `${refRoot(turn)}/public-safety`
      yield* withGit(selectResult({ canonical: chat.repository.root, selectedRef, resultCommit })).pipe(
        Effect.mapError(error),
      )

      if (turn.applyBaseChoice === "discard_winner") {
        return yield* discardWinner(store, turn)
      }

      const resumeCanonicalization =
        retry && turn.gitApplication?.state === "applied" && turn.resultingCanonicalSHA !== undefined
      const resumeResolvedConflict = retry && turn.gitApplication?.state === "conflicted"
      const parkedConflicts = resumeResolvedConflict ? [...(turn.gitApplication?.conflicts ?? [])] : []
      const currentCanonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
      // A winner that switched branches leaves the trunk on another branch once applied, so a retry
      // may find it there; the branch the promotion starts from is the chat's own.
      const switching = winner.branchChanged === true
      const promotionSourceBranch = switching ? chat.arenaBranch : currentCanonical.branch
      const promotionSourceDetached = switching ? chat.canonicalCheckout?.detached : currentCanonical.detached
      const recordedPromotionBranch =
        turn.gitApplication?.state === "applied" || turn.gitApplication?.state === "conflicted"
          ? turn.gitApplication.branch
          : undefined
      // The branch an interrupted attempt was switching to, for its recovery to put back.
      const interruptedTarget =
        (turn.gitApplication?.state === "pending" || turn.gitApplication?.state === "failed") &&
        turn.gitApplication.branch !== undefined &&
        turn.gitApplication.branch !== promotionSourceBranch
          ? turn.gitApplication.branch
          : undefined
      let canonicalBranchAfterPromotion = recordedPromotionBranch ?? promotionSourceBranch
      let refOutcomes: readonly RefOutcome[] = turn.gitApplication?.refs ?? []
      let switchedTo = turn.gitApplication?.switchedTo
      let setAside = turn.gitApplication?.discardedRef !== undefined
      // A failure before the checkout is written leaves it as it was. The developer's own moves
      // -- switching the trunk's branch, taking a branch the review chose -- park the turn as
      // manual; anything else is a failure the retry can repeat.
      const recordApplicationFailure = (applicationError: unknown) => {
        const partial = applicationError instanceof PartialApplyError ? applicationError.partial : undefined
        const manual =
          partial !== undefined ||
          (applicationError instanceof OperationError &&
          (applicationError.operation === "verify_canonical_branch" ||
            applicationError.operation === "target_branch_checked_out" ||
            applicationError.operation === "promote_checkout_branch" ||
            applicationError.operation === "winner_head_missing" ||
            applicationError.operation === "write_winner_refs"))
        return promise(() =>
          store.updateTurn(turn._id, {
            gitApplication: {
              state: manual ? "manual" : "failed",
              reason: applicationError instanceof Error ? applicationError.message : String(applicationError),
              resultCommit,
              ...(applicationError instanceof PublicEditsAtRiskError ? { conflicts: [...applicationError.paths] } : {}),
              ...(partial ? { partial } : {}),
              ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
              baseCommit: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
            },
          }),
        ).pipe(Effect.andThen(promise(() => store.transitionTurn(turn._id, "application_failed"))), Effect.ignore)
      }

      // Some Store implementations update admitted documents in place, so the claim that
      // moved the turn back to `applying`/`canonicalizing` may already be visible here.
      // Durable Git application metadata is the resumption marker, not the stale state value.
      let applied: { readonly resultingHead: string; readonly conflicts: readonly string[] }

      // The winner's transcript and its environment are copied while the checkout is being
      // written, not after it. Neither reads the checkout: the graft moves messages between
      // sessions, and retaining the winner discovers and stops processes. Serially they were
      // the two seconds after the git apply that the chat sat empty for.
      //
      // Interrupted by an apply that fails out below, which is what the graft's remnant drop
      // and the retry already handle. Retaining early does mean a failed apply leaves the
      // loser's services stopped and the winner marked retained; the retry re-runs both.
      const grafting = yield* Effect.forkChild(
        trackOperation(store, turn._id, "updating_conversation", graft(store, chat, turn, winner)).pipe(
          Effect.tapError(() =>
            promise(() => store.transitionTurn(turn._id, "canonicalization_failed")).pipe(Effect.ignore),
          ),
        ),
      )
      const retaining = yield* Effect.forkChild(retainWinnerAndStopLoser(store, chat, turn, winner, runs))
      // A park hands the chat back to the user, so the copy has to be finished before that
      // happens. `graft` is forked alongside the apply and dies with this effect, so a park that
      // returned without waiting left a half-copied transcript sitting above whatever the user
      // wrote next — and a half-copy is the one thing the retry cannot replace without taking
      // their messages with it. Failures are the graft's own to report; this only waits.
      const settleGraft = Fiber.join(grafting).pipe(Effect.ignore)

      if (resumeCanonicalization) {
        const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
        if (
          canonical.branch !== canonicalBranchAfterPromotion ||
          (turn.resultingCanonicalSHA !== undefined && canonical.head !== turn.resultingCanonicalSHA)
        ) {
          yield* promise(() => store.transitionTurn(turn._id, "canonicalization_failed"))
          return yield* Effect.fail(new Error("The checkout changed before Arena could resume canonicalization"))
        }
        applied = { resultingHead: canonical.head, conflicts: [] }
      } else if (resumeResolvedConflict) {
        // The winner is already in the checkout -- the promotion wrote it in one step and the
        // conflicted paths carry its markers. So there is nothing to apply again: the resume only
        // asks whether the markers are gone, and hands the chat back when they are not.
        const unresolved = yield* withGit(
          unresolvedConflictPaths({ canonical: chat.repository.root, paths: parkedConflicts }),
        ).pipe(Effect.mapError(error))
        // A promotion parked by an older daemon left unmerged index entries behind; this one
        // never does, and everything downstream -- the trunk guard, `finishWinnerPromotion` --
        // reads an unmerged index as a merge in progress. Settle it, without rewriting a file to
        // do it: the markers on disk are the user's work, half done or finished.
        yield* withRepositoryMutation(
          chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
          withGit(acceptWinnerConflicts({ canonical: chat.repository.root, materialize: false })),
        ).pipe(Effect.ignore)
        if (unresolved.length > 0) {
          yield* promise(() =>
            store.updateTurn(turn._id, {
              gitApplication: {
                ...turn.gitApplication,
                state: "conflicted",
                conflicts: unresolved,
                reason: parkedConflictReason,
              },
            }),
          )
          yield* settleGraft
          yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
          return yield* respond(store, turn.chatID)
        }
        const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
        if (canonical.branch !== canonicalBranchAfterPromotion) {
          yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
          return yield* Effect.fail(new Error("The checkout branch changed while resolving Arena conflicts"))
        }
        applied = { resultingHead: canonical.head, conflicts: [] }
        yield* promise(() =>
          store.updateTurn(turn._id, {
            resultingCanonicalSHA: canonical.head,
            applicationAt: new Date(),
            gitApplication: {
              state: "applied",
              resultCommit,
              ...(refOutcomes.length > 0 ? { refs: refOutcomes } : {}),
              ...(switchedTo ? { switchedTo } : {}),
              ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
              ...(setAside ? { discardedRef: safetyRef } : {}),
            },
          }),
        )
        yield* promise(() => store.transitionTurn(turn._id, "canonicalizing"))
      } else {
        yield* promise(() => store.transitionTurn(turn._id, "applying"))
        if (retry && (turn.gitApplication?.state === "pending" || turn.gitApplication?.state === "failed")) {
          yield* withRepositoryMutation(
            chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
            withGit(
              recoverFailedPromotion({
                canonical: chat.repository.root,
                safetyRef,
                expectedBranch: promotionSourceBranch,
                expectedDetached: promotionSourceDetached,
                ...(interruptedTarget ? { targetBranch: interruptedTarget } : {}),
              }),
            ),
          ).pipe(Effect.mapError(error))
        }
        // Decide everything before writing anything. A plan with open items parks on them; the
        // developer's answers come back through `retryResolution` and the next plan uses them.
        const plan = yield* trackOperation(
          store,
          turn._id,
          "checking_workspace",
          withRepositoryMutation(
            chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
            planWinner(chat, turn, winner, { branch: promotionSourceBranch, detached: promotionSourceDetached }),
          ),
        ).pipe(Effect.tapError(recordApplicationFailure))
        if (plan.kind === "review") {
          yield* promise(() =>
            store.updateTurn(turn._id, {
              gitApplication: {
                state: "review",
                reason: reviewReason(plan.items),
                resultCommit,
                review: {
                  items: plan.items,
                  planned: plan.planned,
                  ...(plan.switchTo ? { switchTo: plan.switchTo } : {}),
                },
                ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
                baseCommit: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
              },
            }),
          )
          yield* settleGraft
          yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
          return yield* respond(store, turn.chatID)
        }
        const targetBranch = plan.targetBranch
        canonicalBranchAfterPromotion = targetBranch ?? promotionSourceBranch
        setAside = plan.publicChoice?.action === "agent"
        yield* promise(() =>
          store.updateTurn(turn._id, {
            gitApplication: {
              state: "pending",
              resultCommit,
              ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
            },
          }),
        )
        // Every other ref is locked and checked before the checkout is touched, so a ref that moved,
        // or one another Git process holds, fails while nothing has changed. The checkout is written
        // under those locks and the refs after it. A refusal that late puts the checkout back; if
        // even that fails, the turn records the checkout as partial so the developer restores it
        // instead of building on it.
        const partial: PartialApply = {
          ...(promotionSourceBranch ? { expectedBranch: promotionSourceBranch } : {}),
          ...(promotionSourceDetached ? { expectedDetached: true } : {}),
          ...(targetBranch ? { targetBranch } : {}),
        }
        const written = yield* trackOperation(
          store,
          turn._id,
          "applying_changes",
          withRepositoryMutation(
            chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
            Effect.acquireUseRelease(
              withGit(
                holdWinnerRefs({
                  canonical: chat.repository.root,
                  writes: plan.writes,
                  backupPrefix: `${refRoot(turn)}/replaced`,
                }),
              ),
              (held) =>
                Effect.gen(function* () {
                  const promoted = yield* withGit(
                    promoteWinnerState({
                      canonical: chat.repository.root,
                      ...(promotionSourceBranch ? { expectedBranch: promotionSourceBranch } : {}),
                      ...(promotionSourceDetached ? { expectedDetached: true } : {}),
                      ...(targetBranch ? { targetBranch } : {}),
                      frozenHead: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
                      baseWorkingTree: turn.baseSnapshot?.tree ?? turn.frozenBaseSHA,
                      baseIndexTree: turn.baseSnapshot?.indexTree ?? turn.frozenBaseSHA,
                      resultCommit,
                      finalIndexTree: winner.finalIndexTree!,
                      ...(plan.checkoutAction ? { checkoutAction: plan.checkoutAction } : {}),
                      ...(plan.takeTargetFrom ? { takeTargetFrom: plan.takeTargetFrom } : {}),
                      ...(plan.publicChoice ? { publicChoice: plan.publicChoice } : {}),
                      safetyRef,
                      retainSafetyRef: true,
                    }),
                  )
                  const refs = yield* held.commit.pipe(
                    Effect.catch((refused) =>
                      withGit(
                        recoverFailedPromotion({
                          canonical: chat.repository.root,
                          safetyRef,
                          ...partial,
                        }),
                      ).pipe(
                        Effect.matchEffect({
                          onSuccess: () => Effect.fail(refused),
                          onFailure: (undo) => Effect.fail(new PartialApplyError(refused, undo, partial)),
                        }),
                      ),
                    ),
                  )
                  const moved = plan.checkoutMove
                    ? yield* withGit(
                        reportCheckoutMove({
                          canonical: chat.repository.root,
                          move: plan.checkoutMove,
                          after: promoted.resultingHead,
                          backupPrefix: `${refRoot(turn)}/replaced`,
                        }),
                      )
                    : undefined
                  return { promoted, refs: moved ? [moved, ...refs] : refs }
                }),
              (held) => held.abort,
            ),
          ),
        ).pipe(Effect.mapError(error), Effect.tapError(recordApplicationFailure))
        applied = written.promoted
        refOutcomes = [...written.refs, ...plan.skipped]
        switchedTo = targetBranch

        const conflicts = appliedConflicts(applied)
        if (conflicts.length > 0) {
          // The winner is in the checkout and these paths carry its markers. The developer agreed
          // to them in the review, so the turn parks rather than failing: the chat stays usable,
          // the callout offers an agent to resolve, and the retry finishes it once they are gone.
          yield* promise(() =>
            store.updateTurn(turn._id, {
              resultingCanonicalSHA: applied.resultingHead,
              applicationAt: new Date(),
              gitApplication: {
                state: "conflicted",
                reason: parkedConflictReason,
                resultCommit,
                conflicts,
                ...(refOutcomes.length > 0 ? { refs: refOutcomes } : {}),
                ...(switchedTo ? { switchedTo } : {}),
                ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
                baseCommit: turn.baseSnapshot?.canonicalHead ?? turn.frozenBaseSHA,
                ...(setAside ? { discardedRef: safetyRef } : {}),
              },
            }),
          )
          yield* settleGraft
          yield* promise(() => store.transitionTurn(turn._id, "application_failed"))
          return yield* respond(store, turn.chatID)
        }

        yield* promise(() =>
          store.updateTurn(turn._id, {
            resultingCanonicalSHA: applied.resultingHead,
            applicationAt: new Date(),
            gitApplication: {
              state: "applied",
              resultCommit,
              ...(refOutcomes.length > 0 ? { refs: refOutcomes } : {}),
              ...(switchedTo ? { switchedTo } : {}),
              ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
              ...(setAside ? { discardedRef: safetyRef } : {}),
            },
          }),
        )
        yield* promise(() => store.transitionTurn(turn._id, "canonicalizing"))
      }

      yield* trackOperation(
        store,
        turn._id,
        "applying_changes",
        withRepositoryMutation(
          chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
          withGit(
            finishWinnerPromotion({
              canonical: chat.repository.root,
              safetyRef,
              ...(setAside ? { retainSafetyRef: true } : {}),
            }),
          ),
        ),
      ).pipe(
        Effect.mapError(error),
        Effect.tapError(() =>
          promise(() => store.transitionTurn(turn._id, "canonicalization_failed")).pipe(Effect.ignore),
        ),
      )
      const rootID = SessionID.make(winner.rootSessionID)
      const canonicalID = SessionID.make(chat.canonicalSessionID)
      yield* Fiber.join(grafting)
      const messages = yield* sessions.messages({ sessionID: canonicalID }).pipe(Effect.mapError(error))
      yield* promise(() =>
        store.updateTurn(turn._id, {
          resultingCanonicalSHA: applied.resultingHead,
          promotedSessionID: rootID,
          canonicalizationAt: new Date(),
          // A conflicted promotion parks before this point, so the turn is only canonicalized
          // once it is genuinely applied. This write replaces the whole record, so the refs the
          // winner carried and the discard's recovery ref are both repeated here -- otherwise
          // canonicalization silently drops the only pointer to the discarded work.
          gitApplication: {
            state: "applied",
            resultCommit,
            ...(refOutcomes.length > 0 ? { refs: refOutcomes } : {}),
            ...(switchedTo ? { switchedTo } : {}),
            ...(canonicalBranchAfterPromotion ? { branch: canonicalBranchAfterPromotion } : {}),
            ...(setAside ? { discardedRef: safetyRef } : {}),
          },
        }),
      )
      yield* promise(() => store.transitionTurn(turn._id, "cleanup_pending"))
      const loser = yield* Fiber.join(retaining)
      yield* recordCanonicalTranscript(store, chat._id, messages)
      const completedCanonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
      yield* promise(() => store.transitionTurn(turn._id, "complete"))
      yield* promise(() =>
        store.completeTurn({
          chatID: chat._id,
          turnID: turn._id,
          canonicalSHA: completedCanonical.head,
          canonicalSessionID: canonicalID,
          ...(completedCanonical.branch ? { branch: completedCanonical.branch } : {}),
          detached: completedCanonical.detached,
          indexTree: completedCanonical.indexTree,
          trunkConflicts: completedCanonical.conflicts,
          completedAt: new Date(),
        }),
      )
      // Past this point the chat is `ready` and the user's next prompt can start a turn.
      // Everything below is housekeeping that turn does not depend on.
      if (loser) yield* removeLoserWorktree(store, chat, turn, loser)
      yield* prepareWarmPairAfterCompletion(store, chat, turn)
      return yield* respond(store, chat._id)
    })

    const vote = Effect.fn("Arena.vote")(function* (id: string, selected: Vote, rawParticipantID?: string) {
      const store = yield* available()
      const votingParticipantID = yield* Effect.try({
        try: () => participantID(rawParticipantID),
        catch: error,
      })
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.resolution) return yield* respond(store, turn.chatID)
      if (turn.state === "running") {
        if (selected === "tie") return yield* Effect.fail(new Error("Arena ties require both contestant results"))
        const revealed = yield* promise(() => resolvedPlacement(turn, `select:${selected}`))
        const committed = committedResolution(earlyResolution(selected), revealed.decision)
        if (committed.kind !== "early") {
          return yield* Effect.fail(new Error(`Arena battle was already resolved as ${revealed.decision}`))
        }
        const claimed = yield* promise(() =>
          store.claimEarlyResolution({
            turnID: turn._id,
            side: committed.vote,
            participantID: votingParticipantID,
            models: revealed.models,
            at: new Date(),
          }),
        )
        if (!claimed.claimed) {
          if (claimed.turn.resolution) return yield* respond(store, turn.chatID)
          return yield* Effect.fail(new Error("Arena selected result is not ready for an early vote"))
        }
        yield* revealTelemetry(claimed.turn, revealed.metrics)
        const other = committed.vote === "a" ? "b" : "a"
        const run = yield* promise(() => store.run(claimed.turn.runIDs[other]))
        if (run) {
          // Cancellation may have to interrupt a provider or shell process. Start it immediately,
          // but do not hold the durable vote acknowledgement open while that process winds down.
          yield* cancelUntilSettled(store, run._id, SessionID.make(run.rootSessionID), run.worktree).pipe(
            Effect.forkIn(scope),
          )
        }
        return yield* respond(store, turn.chatID)
      }
      if (turn.state === "awaiting_stop_resolution" && selected === "tie") {
        const resolved = voteResolution(selected)
        return yield* promote(store, turn, resolved.appliedSide, resolved, selected, false, votingParticipantID)
      }
      if (turn.state !== "awaiting_vote") return yield* Effect.fail(new Error("Arena turn is not ready for a vote"))
      const resolved = voteResolution(selected)
      return yield* promote(store, turn, resolved.appliedSide, resolved, selected, false, votingParticipantID)
    })

    const recordReview = Effect.fn("Arena.recordReview")(function* (
      id: string,
      events: readonly ReviewEventInput[],
      rawParticipantID?: string,
      ipAddress?: string,
    ) {
      const store = yield* available()
      const reviewParticipantID = yield* Effect.try({
        try: () => participantID(rawParticipantID),
        catch: error,
      })
      if (events.length > reviewFlushLimit) {
        return yield* Effect.fail(new Error(`Arena review flush exceeds ${reviewFlushLimit} events`))
      }
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      const chat = yield* promise(() => store.chat(turn.chatID))
      // One stamp for the flush. Ordering within it comes from the client's
      // offsets, which is the only clock that measures a single review.
      const receivedAt = new Date()
      const documents = events.map(
        ({ id: eventID, clientAtMs, ...event }): ReviewEventDocument => ({
          ...event,
          _id: eventID,
          clientAt: new Date(clientAtMs),
          turnID: turn._id,
          chatID: turn.chatID,
          ...(reviewParticipantID ? { participantID: reviewParticipantID } : {}),
          ...(chat?.userId ? { userId: chat.userId } : {}),
          ...(ipAddress ? { ipAddress } : {}),
          receivedAt,
        }),
      )
      const accepted = yield* promise(() => store.saveReviewEvents(documents))
      // A flush can land after the vote already triggered the rollup — the card
      // unmounts and flushes while promote is running — so a late batch on a
      // resolved turn recomputes the row. The write replaces, so this is free.
      if (turn.resolution && accepted > 0) {
        yield* recordBattleMetrics(store, turn._id).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Arena battle metrics refresh failed", { turnID: turn._id, cause }),
          ),
          Effect.forkIn(scope),
        )
      }
      return { accepted, received: events.length }
    })

    const retryResolution: Interface["retryResolution"] = Effect.fn("Arena.retryResolution")(function* (
      id: string,
      mode?: ApplyBaseChoice | "restore_workspace",
      answers?: readonly ReviewAnswer[],
    ) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.state !== "application_failed" && turn.state !== "canonicalization_failed") {
        return yield* Effect.fail(new Error("Arena resolution is not ready to retry"))
      }
      // An agent asked to resolve the markers runs as an ordinary turn on this chat's session.
      // Retrying under it would have both writing the same checkout, and the retry would read a
      // tree the agent is still half way through.
      const retryChat = yield* promise(() => store.chat(turn.chatID))
      if (retryChat && activeNormalTurns.active(retryChat.canonicalSessionID)) {
        return yield* Effect.fail(
          new Error("An agent is still working in this workspace. Wait for it to finish, then retry."),
        )
      }
      if (!turn.resolution || turn.resolution.kind === "aborted" || !turn.appliedSide) {
        return yield* Effect.fail(new Error("Arena turn has no applicable recorded resolution"))
      }
      // A checkout an apply left half written is put back before anything else runs on it: a retry
      // would plan against it, and a discard would leave it as it is.
      const partial = turn.gitApplication?.partial
      if (partial && retryChat) {
        yield* withRepositoryMutation(
          retryChat.canonicalCheckout?.commonGitDir ?? retryChat.repository.root,
          withGit(
            recoverFailedPromotion({
              canonical: retryChat.repository.root,
              safetyRef: `${refRoot(turn)}/public-safety`,
              ...partial,
            }),
          ),
        ).pipe(Effect.mapError((cause) => new Error(`Arena could not restore your workspace: ${error(cause).message}`)))
        const { partial: _restored, ...application } = turn.gitApplication!
        yield* promise(() =>
          store.updateTurn(turn._id, {
            gitApplication: {
              ...application,
              reason: "Arena put your workspace back the way it was before the apply. The winning changes are not applied.",
            },
          }),
        )
        if (mode === "restore_workspace") return yield* respond(store, turn.chatID)
        return yield* retryResolution(id, mode, answers)
      }
      if (mode === "restore_workspace") return yield* respond(store, turn.chatID)
      // Discarding the winner is open while nothing of it is in the checkout. Claim the answer and
      // the transition together so recovery cannot apply a winner the developer discarded.
      if (mode === "discard_winner") {
        const discardable = ["review", "manual", "blocked", "failed"]
        if (turn.state !== "application_failed" || !discardable.includes(turn.gitApplication?.state ?? "")) {
          return yield* Effect.fail(new Error("The winning result can only be discarded before it is applied"))
        }
        const claimed = yield* promise(() =>
          store.claimApplyBaseChoice({ turnID: turn._id, choice: mode, at: new Date() }),
        )
        if (!claimed.claimed) return yield* respond(store, turn.chatID)
        return yield* discardWinner(store, claimed.turn)
      }
      if (turn.state === "application_failed" && turn.gitApplication?.state === "blocked") {
        return yield* Effect.fail(new Error("Arena resolution requires manual Git handling"))
      }
      const claimed = yield* promise(() =>
        store.claimTransition(
          turn._id,
          turn.state,
          turn.state === "application_failed" ? "applying" : "canonicalizing",
        ),
      )
      if (!claimed.claimed) return yield* respond(store, turn.chatID)
      // Persisted so a daemon restart mid-apply resumes with the answers instead of asking again.
      const reviewAnswers = answers?.length ? mergeAnswers(turn.reviewAnswers, answers) : turn.reviewAnswers
      if (answers?.length) yield* promise(() => store.updateTurn(turn._id, { reviewAnswers }))
      return yield* promote(
        store,
        reviewAnswers ? { ...turn, reviewAnswers } : turn,
        turn.appliedSide,
        turn.resolution,
        turn.vote,
        true,
      )
    })

    const retryComparison = Effect.fn("Arena.retryComparison")(function* (id: string) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.comparisonState !== "failed") {
        return yield* Effect.fail(new Error("Arena comparison is not in a failed state"))
      }
      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      const inputs = yield* Effect.forEach(["a", "b"] as const, (side) => comparisonInput(store, turn, side))
      yield* startUtility(store, turn, inputs[0], inputs[1], chat.repository.root).pipe(
        Effect.catchCause((cause) =>
          // Keep the existing comparisonID: it still points at the failed record and its request and
          // response artifacts, which are the only forensic trace of why the utility model failed.
          promise(() => store.updateTurn(turn._id, { comparisonState: "failed" })).pipe(
            Effect.andThen(Effect.logWarning("Arena comparison retry failed", { turnID: turn._id, cause })),
          ),
        ),
        Effect.forkIn(scope),
      )
      // startUtility flips the turn to "running" before its first await, so the snapshot the caller
      // receives already reflects the retry rather than the stale failure.
      return yield* respond(store, turn.chatID)
    })

    // Rebuilds the comparison inputs a finished run already persisted, so a retry does not depend on
    // the in-memory results that only exist while the battle is executing.
    const comparisonInput = Effect.fn("Arena.comparisonInput")(function* (
      store: Store,
      turn: TurnDocument,
      side: Side,
    ) {
      const run = yield* promise(() => store.run(turn.runIDs[side]))
      if (!run?.finalCommit) {
        return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} has no finalized result to compare`))
      }
      const artifactID = `${run._id}|transcript`
      const artifact = yield* promise(() => store.artifacts.findOne({ _id: artifactID }))
      if (!artifact) {
        return yield* Effect.fail(new Error(`Arena side ${side.toUpperCase()} has no archived transcript to compare`))
      }
      const archived = ArenaTranscriptArtifact.decode(artifact) as ReadonlyArray<{
        readonly sessionID: string
        readonly messages: readonly unknown[]
      }>
      const root = archived.find((item) => item.sessionID === run.rootSessionID)
      const hidden = new Set(
        Object.values(turn.placement).flatMap((assignment) => [
          assignment.assignmentID,
          ...(assignment.model ? [assignment.model] : []),
        ]),
      )
      return {
        result: { finalCommit: run.finalCommit },
        artifactID,
        transcript: comparisonTimeline(root?.messages ?? [], run.promptMessageID, hidden),
      }
    })

    const stop = Effect.fn("Arena.stop")(function* (id: string) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.state === "awaiting_stop_resolution") {
        return yield* respond(store, turn.chatID)
      }
      if (turn.state !== "running") {
        return yield* Effect.fail(new Error("Arena battle cannot be stopped in its current state"))
      }
      yield* promise(() => store.transitionTurn(turn._id, "stopping"))
      environmentCopyStops.get(turn._id)?.abort(new Error("Arena battle was stopped during environment setup"))
      const runs = yield* promise(() => store.runsForTurn(turn._id))
      const cancel = Effect.forEach(runs, (run) => cancelRun(run.worktree, SessionID.make(run.rootSessionID)), {
        concurrency: 2,
        discard: true,
      })
      yield* cancel
      // A stop can win the database transition immediately before prompt fibers
      // enter SessionPrompt. Yield once and cancel again so both sides observe it.
      yield* Effect.yieldNow
      yield* cancel
      return yield* respond(store, turn.chatID)
    })

    const resolveStop = Effect.fn("Arena.resolveStop")(function* (id: string, selected: StopResolution) {
      const store = yield* available()
      const turn = yield* promise(() => store.turn(id))
      if (!turn) return yield* Effect.fail(new Error(`Arena turn not found: ${id}`))
      if (turn.resolution) return yield* respond(store, turn.chatID)
      if (turn.state !== "awaiting_stop_resolution") {
        return yield* Effect.fail(new Error("Arena stopped battle is not ready for resolution"))
      }
      const resolved = stoppedResolution(selected)
      if (resolved.appliedSide) {
        const side = resolved.appliedSide
        const runs = yield* promise(() => store.runsForTurn(turn._id))
        if (runs.find((run) => run.side === side)?.applicability === "blocked") {
          return yield* Effect.fail(new Error("Arena side cannot be kept because its environment setup failed"))
        }
        return yield* promote(store, turn, side, resolved)
      }

      const chat = yield* promise(() => store.chat(turn.chatID))
      if (!chat) return yield* Effect.fail(new Error(`Arena chat not found: ${turn.chatID}`))
      yield* ensureArchives(store, turn)
      const revealed = yield* promise(() => modelsForDecision(turn, "discard"))
      const recorded = yield* promise(() =>
        store.recordResolution({
          turnID: turn._id,
          resolution: resolved,
          models: revealed.models,
          expectedState: "awaiting_stop_resolution",
          at: new Date(),
        }),
      )
      if (!recorded.recorded) return yield* respond(store, turn.chatID)
      yield* revealTelemetry(recorded.turn, revealed.metrics)
      yield* promise(() => store.transitionTurn(turn._id, "discarding"))
      yield* cleanup(store, turn, chat.repository.root)
      const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
      yield* promise(() => store.transitionTurn(turn._id, "discarded"))
      yield* promise(() =>
        store.completeTurn({
          chatID: chat._id,
          turnID: turn._id,
          canonicalSHA: canonical.head,
          canonicalSessionID: chat.canonicalSessionID,
          ...(canonical.branch ? { branch: canonical.branch } : {}),
          detached: canonical.detached,
          indexTree: canonical.indexTree,
          trunkConflicts: canonical.conflicts,
          completedAt: new Date(),
        }),
      )
      return yield* respond(store, chat._id)
    })

    const archiveSession = Effect.fn("Arena.archiveSession")(function* (sessionID: string) {
      const store = yield* available()
      const found = yield* promise(() => store.chatForSession(sessionID))
      if (!found) return null
      if (found.status === "archived") return yield* respond(store, found._id)
      // Warm-up adopts and creates the chat's worktrees under this lock, so none is being built
      // while they are taken away, and none is started after.
      return yield* turnStartLock(found._id).withPermits(1)(archiveChat(store, found))
    })

    const archiveChat = Effect.fn("Arena.archiveChat")(function* (store: Store, found: ChatDocument) {
      let chat: ChatDocument = (yield* promise(() => store.chat(found._id))) ?? found
      const archivedChatID = chat._id
      if (chat.status === "archived") return yield* respond(store, chat._id)

      const deadline = Date.now() + 30_000
      while (chat.activeTurnID) {
        const turn = yield* promise(() => store.turn(chat.activeTurnID!))
        if (!turn) return yield* Effect.fail(new Error(`Arena active turn not found: ${chat.activeTurnID}`))

        if (turn.state === "running") {
          yield* promise(() => store.transitionTurn(turn._id, "stopping"))
          environmentCopyStops.get(turn._id)?.abort(new Error("Arena battle was stopped during environment setup"))
          const runs = yield* promise(() => store.runsForTurn(turn._id))
          yield* Effect.forEach(
            runs,
            (run) => cancelRun(run.worktree, SessionID.make(run.rootSessionID)).pipe(Effect.ignore),
            { concurrency: 2, discard: true },
          )
          yield* Effect.yieldNow
          yield* Effect.forEach(
            runs,
            (run) => cancelRun(run.worktree, SessionID.make(run.rootSessionID)).pipe(Effect.ignore),
            { concurrency: 2, discard: true },
          )
        } else if (turn.state === "awaiting_vote" || turn.state === "awaiting_stop_resolution") {
          const expectedState: "awaiting_vote" | "awaiting_stop_resolution" = turn.state
          yield* ensureArchives(store, turn)
          const resolved = stoppedResolution("discard")
          const revealed = yield* promise(() => modelsForDecision(turn, "discard"))
          const recorded = yield* promise(() =>
            store.recordResolution({
              turnID: turn._id,
              resolution: resolved,
              models: revealed.models,
              expectedState,
              at: new Date(),
            }),
          )
          if (recorded.recorded || recorded.turn.resolution?.kind === "stopped") {
            yield* revealTelemetry(recorded.turn, revealed.metrics)
            yield* promise(() => store.transitionTurn(turn._id, "discarding"))
            yield* cleanup(store, turn, chat.repository.root)
            const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
            yield* promise(() => store.transitionTurn(turn._id, "discarded"))
            yield* promise(() =>
              store.completeTurn({
                chatID: chat._id,
                turnID: turn._id,
                canonicalSHA: canonical.head,
                canonicalSessionID: chat.canonicalSessionID,
                ...(canonical.branch ? { branch: canonical.branch } : {}),
                detached: canonical.detached,
                indexTree: canonical.indexTree,
                trunkConflicts: canonical.conflicts,
                completedAt: new Date(),
              }),
            )
          }
        } else if (
          turn.state === "creation_failed" ||
          turn.state === "finalization_failed" ||
          turn.state === "interrupted_recovery"
        ) {
          const expectedState: "creation_failed" | "finalization_failed" | "interrupted_recovery" = turn.state
          const revealed = yield* promise(() => modelsForDecision(turn, "aborted"))
          const recorded = yield* promise(() =>
            store.recordAbort({
              turnID: turn._id,
              expectedState,
              reason: "Arena workspace was archived before resolution",
              models: revealed.models,
              at: new Date(),
            }),
          )
          if (recorded.recorded || recorded.turn.resolution?.kind === "aborted") {
            yield* revealTelemetry(recorded.turn, revealed.metrics)
            yield* promise(() => store.transitionTurn(turn._id, "discarding"))
            yield* cleanup(store, turn, chat.repository.root)
            const canonical = yield* withGit(inspectCanonical(chat.repository.root)).pipe(Effect.mapError(error))
            yield* promise(() => store.transitionTurn(turn._id, "discarded"))
            yield* promise(() =>
              store.completeTurn({
                chatID: chat._id,
                turnID: turn._id,
                canonicalSHA: canonical.head,
                canonicalSessionID: chat.canonicalSessionID,
                ...(canonical.branch ? { branch: canonical.branch } : {}),
                detached: canonical.detached,
                indexTree: canonical.indexTree,
                trunkConflicts: canonical.conflicts,
                completedAt: new Date(),
              }),
            )
          }
        } else if (
          turn.state === "application_failed" ||
          turn.state === "canonicalization_failed" ||
          turn.state === "complete" ||
          turn.state === "discarded"
        ) {
          break
        }

        chat = (yield* promise(() => store.chat(archivedChatID))) ?? chat
        if (!chat.activeTurnID) break
        if (Date.now() >= deadline) {
          return yield* Effect.fail(new Error(`Arena turn did not settle before workspace archive: ${turn.state}`))
        }
        yield* Effect.sleep(Duration.millis(25))
      }

      // A spare still being built or a worktree still being released would race the removals below.
      yield* endSlotWork(chat._id)
      const turns = yield* promise(() => store.turnsForChat(chat._id))
      const runs = (yield* Effect.forEach(turns, (turn) => promise(() => store.runsForTurn(turn._id)), {
        concurrency: 4,
      })).flat()
      yield* Effect.forEach(
        runs.filter((run) => !run.worktreeRemovedAt),
        (run) =>
          Effect.gen(function* () {
            const stopped = yield* stopRunServices(store, run)
            const failures = stopped.filter((record) => record.status === "failed" || !record.verified)
            if (failures.length > 0) {
              return yield* Effect.fail(new Error(`Arena could not stop services for archived run ${run._id}`))
            }
            yield* removeStoppedRun(store, chat, run)
          }),
        { concurrency: 1, discard: true },
      )

      const warmSlots = unusedWarmSlots(warmRecordsOf(chat, turns), runs)
      const warmPaths = new Set(warmSlots.map((slot) => slot.directory))
      yield* withRepositoryMutation(
        chat.canonicalCheckout?.commonGitDir ?? chat.repository.root,
        Effect.forEach(
          warmPaths,
          (directory) =>
            forgetSlot(directory).pipe(
              Effect.andThen(inDirectory(chat.repository.root, worktrees.remove({ directory, keepBranch: false }))),
              Effect.mapError(error),
            ),
          { concurrency: 1, discard: true },
        ),
      )
      yield* Effect.forEach(
        turns.filter((turn) => turn.warmPreparation),
        (turn) =>
          promise(() =>
            store.updateTurn(turn._id, {
              warmPreparation: {
                ...turn.warmPreparation!,
                state: "failed",
                error: "Arena workspace archived",
              },
            }),
          ),
        { concurrency: 4, discard: true },
      )
      yield* disposeWarmSessions(warmSlots.map((slot) => slot.forkedSessionID))
      // Released worktrees nobody adopted yet, the spare, and anything else under the chat, deleted
      // before the archive answers: the engine can stop right after, taking a background delete with it.
      yield* retireSlotPool(chat, { wait: true })
      yield* promise(() =>
        store.updateChat(
          { _id: chat._id },
          {
            $set: { status: "archived", updatedAt: new Date() },
            $unset: {
              activeTurnID: "",
              retainedWinner: "",
              warmGeneration: "",
              initialWarmPreparation: "",
              blockedReason: "",
              trunkConflicts: "",
            },
          },
        ),
      )
      return yield* respond(store, chat._id)
    })

    const stream = (rawSessionID: string, turnID?: string, rawUserID?: string) =>
      Effect.gen(function* () {
        const store = yield* available()
        // Initialize a new chat while the HTTP request's instance scope is still open.
        // Cold configuration acquisition cannot outlive that scope in the response body.
        const chat = yield* promise(() => store.chatForSession(rawSessionID))
        if (!chat) yield* ensureChat(rawSessionID, rawUserID)
        else {
          yield* claimOwnership(store, chat, rawSessionID, accountID(rawUserID))
          yield* reconcileCanonicalAvailability(store, chat)
          // A subscribe is the app's way of asking what is true now, so it re-reads the checkout
          // for both conflict callouts, not just the trunk's. A parked promotion clears when the
          // markers go, and nothing writes when they do -- so without this the callout would
          // stand over a resolved checkout until the session was attached again.
          yield* resumeResolvedPromotion(store, chat)
          yield* warmInitialPair(store, chat)
        }
        if (!recorder) return yield* Effect.fail(new Error("Arena recorder unavailable"))
        const live = recorder.live
        const read = (full: boolean) =>
          Effect.gen(function* () {
            const chat = yield* promise(() => store.chatForSession(rawSessionID))
            if (!chat) return yield* Effect.fail(new Error("Arena chat unavailable"))
            const current = yield* promise(() =>
              turnID
                ? store.snapshotTurn(turnID, Number.MAX_SAFE_INTEGER)
                : store.snapshot(chat._id, Number.MAX_SAFE_INTEGER),
            )
            if (current.chat._id !== chat._id)
              return yield* Effect.fail(new Error("Arena turn does not belong to this session"))
            return yield* projectSnapshot(current, full ? -1 : 0, { controlsOnly: !full, discoverServices: false })
          })
        // The branch answer the poll last ran a full inspection for. Boxed, because a detached
        // checkout answers `undefined`.
        let inspectedBranch: { readonly branch: string | undefined } | undefined
        const discover = Effect.gen(function* () {
          const chat = yield* promise(() => store.chatForSession(rawSessionID))
          if (!chat) return
          // Filesystem repairs have no Store event. Check only blocked chats here;
          // recovery publishes a control change without rereading transcripts.
          if (chat.status === "blocked") {
            yield* reconcileCanonicalAvailability(store, chat)
            return
          }
          // Cutting or switching a branch has no Store event either, and the app subscribes once
          // and then listens, so nothing else would re-read the checkout while the chat sits
          // ready. Reading the branch is a single git process; the full inspection runs only when
          // that answer stops matching what the chat recorded.
          if (chat.status === "ready") {
            const branch = yield* withGit(readCanonicalBranch(chat.repository.root)).pipe(Effect.mapError(error))
            if (branch === chat.canonicalCheckout?.branch) {
              inspectedBranch = undefined
              return
            }
            // A head that moved with the branch (another chat's vote switched and committed) is not
            // recorded here, so the answer keeps disagreeing until this chat's next turn. Inspect
            // once per answer, not once a second for as long as the chat stays open.
            if (inspectedBranch && inspectedBranch.branch === branch) return
            inspectedBranch = { branch }
            yield* reconcileCanonicalAvailability(store, chat)
            return
          }
          if (chat.status !== "battle_active") return
          const runs = yield* promise(() => store.runsForTurn(turnID ?? chat.activeTurnID ?? ""))
          for (const run of runs) {
            if (run.worktreeRemovedAt) continue
            const services = yield* discoverRunServices(run)
            if (JSON.stringify(services) !== JSON.stringify(run.services))
              yield* promise(() => store.updateRun(run._id, { services }))
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Arena stream service discovery failed", { cause })))
        const observedChat = yield* promise(() => store.chatForSession(rawSessionID))
        if (!observedChat) return yield* Effect.fail(new Error("Arena chat unavailable"))
        const frames = createArenaStream({
          live,
          read,
          discover,
          onChange: (listener) => store.onChange(listener, observedChat._id),
        })
        return frames.pipe(Stream.onStart(watchChat(observedChat._id)), Stream.ensuring(unwatchChat(observedChat._id)))
      })

    return Service.of({
      activity,
      stream,
      session: ensureChat,
      archiveSession,
      inspectCheckout,
      prepareCheckout,
      releaseCheckout,
      snapshot,
      turn: turnSnapshot,
      diff: comparisonDiff,
      inspect,
      inspectTree,
      inspectFile,
      replyPermission,
      setAutoAccept,
      replyQuestion,
      rejectQuestion,
      beginNormalTurn,
      recordNormalTurn,
      singleAgentVote,
      startTurn,
      reply,
      vote,
      recordReview,
      retryResolution,
      retryComparison,
      stop,
      resolveStop,
    })
  }),
)

function sampleProfiles() {
  // The control plane owns the pool; the desktop hashes only the routing contract version.
  return ["control-plane-assignments-v1"]
}
function parseNumstat(text: string) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [rawAdditions, rawDeletions, ...rawPath] = line.split("\t")
      const path = rawPath.join("\t")
      if (!rawAdditions || !rawDeletions || !path) return []
      const binary = rawAdditions === "-" || rawDeletions === "-"
      return [
        {
          path,
          additions: binary ? 0 : Number.parseInt(rawAdditions, 10) || 0,
          deletions: binary ? 0 : Number.parseInt(rawDeletions, 10) || 0,
          binary,
        },
      ]
    })
}

function parseStatus(text: string) {
  return text.split("\0").flatMap((item) => {
    if (item.length < 4) return []
    const code = item.slice(0, 2)
    const file = item.slice(3)
    if (!file) return []
    const status =
      code === "??"
        ? "added"
        : code.includes("U")
          ? "modified"
          : code.includes("A") && !code.includes("D")
            ? "added"
            : code.includes("D") && !code.includes("A")
              ? "deleted"
              : "modified"
    return [{ code, file, status }]
  })
}

export * as ArenaService from "./service"
