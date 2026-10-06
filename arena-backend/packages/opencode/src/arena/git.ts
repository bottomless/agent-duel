import type { ComparisonFileFact } from "./comparison-evidence"
import { Effect, Semaphore, Stream } from "effect"
import { randomUUID } from "crypto"
import { spawn } from "child_process"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "fs/promises"
import { tmpdir } from "os"
import { basename, dirname, join, resolve } from "path"
import { Git } from "@/git"
import { IGNORED_PATHS_COMMAND, parseIgnoredPaths } from "./warm"
import type { RefChange, RefOutcome } from "./ref-types"
import type { AgentMove, BranchAction, RefNamespace, RefObservation, YourMove } from "./branch-review"

export type { RefChange, RefOutcome } from "./ref-types"

export type Side = "a" | "b"

export type DiffStat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

export type FinalizeInput = {
  readonly worktree: string
  readonly baseSHA: string
  /** Frozen canonical HEAD. Use this when `baseSHA` is a hidden dirty-tree evidence commit. */
  readonly frozenHead?: string
  readonly permanentRef: string
  /** Previous result admitted to this pre-vote side ref, when continuing a completed run. */
  readonly expectedPermanentCommit?: string
  /** Previous admitted index tree for the same continuing run. */
  readonly expectedFinalIndexTree?: string
  /** Optional side ref used by callers that retain the contestant's real commit tip. */
  readonly agentCommitRef?: string
  /** Deprecated compatibility flag; real commits are never rewritten to a wrapper parent. */
  readonly forceBaseParent?: boolean
}

export type FinalizedResult = {
  readonly rawHead: string
  readonly branch?: string
  readonly statusBefore: string
  readonly statusAfter: string
  readonly wrapperCreated: boolean
  readonly finalCommit: string
  readonly finalTree: string
  /** The contestant's real commit tip, when at least one commit was made. */
  readonly agentCommit?: string
  /** Ordered real commits after the frozen base (oldest first). */
  readonly agentCommits: readonly string[]
  /** Alias retained for callers that describe this as a commit chain. */
  readonly commitChain: readonly string[]
  /** Index tree at finalization, before any archival snapshot index is used. */
  readonly finalIndexTree: string
  /** Private ref that makes `finalIndexTree` transferable from an isolated repository. */
  readonly finalIndexRef: string
  /** True only when the contestant has no residual index/worktree/untracked state. */
  readonly fullyCommitted: boolean
  readonly baseIsAncestor: boolean
  readonly permanentRef: string
  readonly diff: readonly DiffStat[]
}

export type ApplyInput = {
  readonly canonical: string
  readonly expectedBaseSHA: string
  readonly expectedBranch?: string
  readonly resultCommit: string
  readonly selectedRef?: string
}

export type SnapshotBaseInput = {
  readonly canonical: string
  readonly permanentRef?: string
}

export type SnapshotBase = {
  readonly root: string
  readonly commonGitDir: string
  readonly canonicalHead: string
  /** The real canonical commit contestants must retain as their commit parent. */
  readonly frozenHead: string
  readonly branch?: string
  readonly clean: boolean
  readonly baseCommit: string
  readonly baseTree: string
  readonly indexTree: string
  readonly permanentRef?: string
}

export type ApplySnapshotInput = {
  readonly canonical: string
  readonly expectedCanonicalHead: string
  readonly expectedBranch?: string
  readonly expectedBaseCommit: string
  readonly expectedBaseTree: string
  readonly expectedIndexTree: string
  readonly resultCommit: string
  readonly selectedRef?: string
}

export type ReanchorInput = {
  readonly canonical: string
  readonly baseCommit: string
  readonly resultCommit: string
  readonly permanentRef: string
}

export type ApplyResult = {
  readonly previousHead: string
  readonly resultingHead: string
  readonly branch?: string
  readonly conflicts?: readonly string[]
}

/** State left behind while a selected result is being promoted. */
export type PromotionPreparation = {
  readonly previousHead: string
  readonly branch?: string
  readonly safetyRef: string
  readonly safetyIndexRef: string
  readonly conflicts: readonly string[]
}

export type PromotionApplyResult = {
  readonly resultingHead: string
  readonly conflicts: readonly string[]
}

export type PromoteWinnerStateInput = {
  readonly canonical: string
  readonly expectedBranch?: string
  readonly expectedDetached?: boolean
  /**
   * Branch the winner ended on when it differs from the public branch. A name that does not
   * exist in the canonical repository is created; an existing one moves as `checkoutAction` says.
   */
  readonly targetBranch?: string
  readonly frozenHead: string
  readonly baseWorkingTree: string
  readonly baseIndexTree: string
  readonly resultCommit: string
  readonly finalIndexTree: string
  readonly safetyRef: string
  /** Keep recovery refs until the service persists the promotion result. */
  readonly retainSafetyRef?: boolean
  /**
   * What happens to the branch the checkout ends on, decided by the review. The values are the
   * ones the decision was made on: `yours` is that branch's tip in the checkout, `agent` the
   * winner's. Without it the winner made no commits there, and only its files are applied.
   */
  readonly checkoutAction?: {
    readonly action: BranchAction
    readonly start?: string
    readonly agent: string
  }
  /** Worktrees the developer agreed to take `targetBranch` from; each is detached at its commit. */
  readonly takeTargetFrom?: readonly string[]
  /**
   * The developer's answer for the files where the winner meets their own work. `agent` gives
   * those files the winner's version and leaves the developer's edits to them on the safety refs;
   * `yours` keeps the files exactly as the developer has them and drops the winner's change there.
   * Every other file merges as usual.
   */
  readonly publicChoice?: PublicChoice
  /** Compute the result and report what it would conflict on or lose, writing nothing. */
  readonly dryRun?: boolean
}

export type PublicChoice = { readonly action: "agent" | "yours"; readonly paths: readonly string[] }

export type PromoteWinnerStateResult = {
  readonly resultingHead: string
  readonly conflicts: readonly string[]
  /** The conflicts that involve the developer's uncommitted edits. */
  readonly publicConflicts: readonly string[]
  /** Developer edits the result would not carry. Only a dry run returns any; a write fails instead. */
  readonly atRisk: readonly string[]
  readonly safetyRef: string
}

export type CanonicalState = {
  readonly root: string
  readonly commonGitDir: string
  readonly head: string
  readonly branch?: string
  readonly detached: boolean
  // Absent while the checkout holds unresolved merge conflicts: git write-tree refuses an
  // unmerged index, so the tree simply does not exist until the conflicts are resolved.
  readonly indexTree?: string
  readonly conflicts: readonly string[]
  readonly clean: boolean
}

// A run of lines retained from one side's file, 1-based. Present only when the file was
// too big to send whole and the comparison kept windows around the changed regions.
export type FileRegion = {
  readonly start: number
  readonly lines: number
}

export type FileContent = {
  readonly content: string
  readonly truncated: boolean
  readonly missing: boolean
  // Absent means `content` is the whole file. Present means it is the retained regions
  // joined in order, and every side of the same file carries the same number of them.
  readonly regions?: readonly FileRegion[]
  // Lines in the whole file, sent with regions so the reader can be told about the part
  // after the last window as well as the parts between them.
  readonly lines?: number
}

// One row per file touched by either contestant, carrying its content at all three
// revisions so the UI can render a base-centered three-way comparison (Agent A left,
// base center, Agent B right) instead of two unrelated two-way patches.
export type ThreeWayFile = {
  readonly file: string
  readonly binary: boolean
  readonly additionsA: number
  readonly deletionsA: number
  readonly additionsB: number
  readonly deletionsB: number
  readonly base?: FileContent
  readonly a?: FileContent
  readonly b?: FileContent
}

export type BattleRefs = {
  readonly base: string
  readonly a: string
  readonly b: string
  readonly selected: string
}

export type SideBranchInput = {
  readonly repository: string
  readonly branch: string
  readonly baseCommit: string
  /** Existing registered worktree to attach. Omit when only resetting the branch. */
  readonly worktree?: string
}

export type SideBranchResult = {
  readonly branch: string
  readonly baseCommit: string
  readonly worktree?: string
}

export type WorktreeAttachment = {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
  readonly tree: string
}

export type PrepareContestantStateInput = {
  readonly worktree: string
  readonly frozenHead: string
  readonly indexTree: string
  readonly workingTree: string
}

export type PreparedContestantState = {
  readonly worktree: string
  readonly head: string
  readonly branch?: string
  readonly indexTree: string
  readonly workingTree: string
}

export type VerifyContestantStateInput = {
  /** Root of a linked worktree of a contestant host. */
  readonly worktree: string
  readonly frozenHead: string
  /** Branch HEAD must be attached to. Absent means HEAD is detached at `frozenHead`. */
  readonly branch?: string
  readonly indexTree: string
  readonly workingTree: string
}

export type SyncContestantStateInput = VerifyContestantStateInput & {
  /**
   * Rewrite every tracked file, not only the ones whose stat data says they changed. An unchanged
   * blob is never smudged again, so a change to what shapes checked-out content (attributes, eol
   * or filter config) only reaches a kept worktree this way.
   */
  readonly forceCheckout?: boolean
}

export type SyncedContestantState = {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
  /** The kept index carried per-entry flags, would not load, or `forceCheckout` was set. */
  readonly indexRebuilt: boolean
  readonly cleanPasses: number
  readonly caseFixes: number
  readonly nestedGitRemoved: number
  readonly gitlinksEmptied: number
  /** FIFOs, sockets and device nodes, which git neither tracks nor cleans. */
  readonly specialFilesRemoved: number
}

export type VerifiedContestantState = {
  readonly worktree: string
  readonly branch?: string
  readonly head: string
}

export type ComparisonEvidence = {
  readonly fileFacts: readonly ComparisonFileFact[]
  readonly baseTree: string
  readonly aTree: string
  readonly bTree: string
  readonly baseToA: string
  readonly baseToATruncated: boolean
  readonly baseToB: string
  readonly baseToBTruncated: boolean
  readonly patch: string
  readonly truncated: boolean
  readonly stats: readonly DiffStat[]
  readonly files: readonly ThreeWayFile[]
  readonly filesTruncated: boolean
  // Absent when merge-tree could not run; the viewer then falls back to the three columns.
  readonly divergence: Divergence
}

// How the two contestants' work on one file relates, decided by git's three-way merge of
// A and B over the frozen base rather than by any line heuristic on the client:
// `diverging` is a merge conflict (same region, different content), `compatible` merged
// cleanly (both touched it, different regions), `identical` is the same result on both
// sides, and `only_a`/`only_b` means the other side left the file alone.
export type DivergenceStatus = "identical" | "only_a" | "only_b" | "compatible" | "diverging" | "binary"

export type DivergenceFile = {
  readonly file: string
  readonly status: DivergenceStatus
  // The file as merge-tree wrote it -- both sides' clean edits applied, conflicts left as
  // zdiff3 blocks -- only for compatible and diverging files small enough to send whole.
  readonly merged?: FileContent
}

export type Divergence = {
  readonly mergeTree: string
  readonly conflicted: boolean
  // Same set and order as `ComparisonEvidence.files`.
  readonly files: readonly DivergenceFile[]
}

/**
 * The snapshotBase refusal that means the trunk index is unmerged, not that the checkout is gone.
 * Callers branch on it to refuse one battle instead of blocking the whole chat.
 */
export const TRUNK_CONFLICT_OPERATION = "verify_trunk_conflicts"

export class OperationError extends Error {
  readonly operation: string
  // The paths the failure is about, carried so a caller can persist them without inspecting the
  // checkout again and racing whatever changed it. TRUNK_CONFLICT_OPERATION sets the unmerged
  // ones; `PublicEditsAtRiskError` narrows this to the edits it refused to risk.
  readonly paths?: readonly string[]

  constructor(operation: string, message: string, paths?: readonly string[]) {
    super(message)
    this.name = "ArenaGitOperationError"
    this.operation = operation
    if (paths) this.paths = paths
  }
}

/**
 * The promotion stopped before it touched the checkout because a developer edit would not have
 * survived the merge. `paths` names the files; the message tells the developer what to do.
 */
export class PublicEditsAtRiskError extends OperationError {
  override readonly paths: readonly string[]

  constructor(paths: readonly string[], message: string) {
    super("verify_public_edits_survive", message, paths)
    this.name = "ArenaGitPublicEditsAtRiskError"
    this.paths = paths
  }
}

// Wrapper commits are transport objects, not user-authored history. A fixed
// timestamp makes the object ID deterministic so a restart can safely repeat
// finalization after the ref was written but before Mongo was updated.
const wrapperDate = "2000-01-01T00:00:00.000Z"

// Bounds on the three-way file content fetched per comparison. Battles are scoped
// coding tasks, not bulk migrations, so a modest cap keeps the response bounded
// without needing a follow-up "load more" round trip for the common case.
const MAX_THREE_WAY_FILES = 25
// Review RPCs and end-of-battle utilities share the same local CPU budget.
const comparisonSlot = Semaphore.makeUnsafe(1)
// What one side of one file may put on the wire. Sending whole files is what the viewer
// wants -- full context, real line numbers -- so anything under the first bound is sent
// as-is. Past it the file is reduced to windows around the parts that actually changed,
// which is the difference between showing a lockfile's one edited dependency and showing
// the first 8,810 lines of a 30,042-line file that does not contain it.
const MAX_WHOLE_FILE_BYTES = 128 * 1024
const MAX_RETAINED_BYTES = 256 * 1024
// The daemon has to hold a file to slice windows out of it. This bounds that read; a blob
// past it is windowed from the prefix it could read and reported as truncated.
const MAX_BLOB_READ_BYTES = 4 * 1024 * 1024
// A merged file carries both sides of every conflict, so it may run to twice a whole file.
const MAX_MERGED_FILE_BYTES = 2 * MAX_WHOLE_FILE_BYTES
// Lines kept either side of a changed run. Enough to read a hunk in context without
// pulling in its neighbours.
const WINDOW_CONTEXT_LINES = 24

function output(result: Git.Result) {
  return result.text().trim()
}

const run = Effect.fn("ArenaGit.run")(function* (
  git: Git.Interface,
  cwd: string,
  operation: string,
  args: string[],
  options?: Pick<Git.Options, "env" | "stdin" | "maxOutputBytes">,
) {
  const result = yield* git.run(args, { cwd, ...options })
  if (result.exitCode === 0) return result
  const detail = result.stderr.toString("utf8").trim() || output(result) || `git ${args[0]} failed`
  return yield* Effect.fail(new OperationError(operation, detail))
})

const read = Effect.fn("ArenaGit.read")(function* (
  git: Git.Interface,
  cwd: string,
  operation: string,
  args: string[],
  options?: Pick<Git.Options, "env" | "stdin" | "maxOutputBytes">,
) {
  return output(yield* run(git, cwd, operation, args, options))
})

const readBranch = Effect.fn("ArenaGit.readBranch")(function* (git: Git.Interface, root: string) {
  const result = yield* git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })
  if (result.exitCode !== 0) return undefined
  return output(result) || undefined
})

/**
 * The checkout's index as a tree object, read from a copy of the index file.
 *
 * `git write-tree` holds `index.lock` while it runs, and `--no-optional-locks` does not lift that:
 * it writes the cache tree back into the index. Every chat of a repository reads the same checkout,
 * and the stream poll inspects it once a second, so a read on the real index made another chat's
 * vote fail on "Unable to create index.lock". The copy is one atomic snapshot of the file, since
 * git replaces the index by renaming its lock over it. A missing index reads as the empty tree,
 * which is what git answers for one.
 */
const readIndexTree = Effect.fn("ArenaGit.readIndexTree")(function* (
  git: Git.Interface,
  root: string,
  operation: string,
) {
  const source = yield* read(git, root, "find_canonical_index", [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ])
  const index = join(tmpdir(), `opencode-arena-index-${randomUUID()}`)
  return yield* Effect.tryPromise({
    try: () =>
      copyFile(source, index).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause
      }),
    catch: (cause) => new OperationError("copy_canonical_index", String(cause)),
  }).pipe(
    Effect.andThen(read(git, root, operation, ["write-tree"], { env: { GIT_INDEX_FILE: index } })),
    Effect.ensuring(
      Effect.promise(() =>
        Promise.all([unlink(index).catch(() => undefined), unlink(`${index}.lock`).catch(() => undefined)]),
      ),
    ),
  )
})

function parseStats(text: string): DiffStat[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [rawAdditions, rawDeletions, ...path] = line.split("\t")
      const file = path.join("\t")
      if (!rawAdditions || !rawDeletions || !file) return []
      const binary = rawAdditions === "-" || rawDeletions === "-"
      return [
        {
          file,
          additions: binary ? 0 : Number.parseInt(rawAdditions, 10) || 0,
          deletions: binary ? 0 : Number.parseInt(rawDeletions, 10) || 0,
          binary,
        },
      ]
    })
}

function gitlinks(text: string) {
  return new Set(
    text.split("\0").flatMap((entry) => {
      const match = entry.match(/^160000 [0-9a-f]+ \d+\t([\s\S]+)$/)
      return match?.[1] ? [match[1]] : []
    }),
  )
}

const isAncestor = Effect.fn("ArenaGit.isAncestor")(function* (
  git: Git.Interface,
  cwd: string,
  base: string,
  result: string,
) {
  const checked = yield* git.run(["merge-base", "--is-ancestor", base, result], { cwd })
  if (checked.exitCode === 0) return true
  if (checked.exitCode === 1) return false
  const detail = checked.stderr.toString("utf8").trim() || "Failed to inspect result ancestry"
  return yield* Effect.fail(new OperationError("inspect_ancestry", detail))
})

// The checkout's HEAD is authoritative. A side ref is only a recovery aid and must not be
// allowed to hide a commit made after the battle started. Empty commits are deliberately
// retained: `rev-list` reports them even when their tree is unchanged.
const readCommitChain = Effect.fn("ArenaGit.readCommitChain")(function* (
  git: Git.Interface,
  cwd: string,
  base: string,
  head: string,
) {
  if (base === head) return [] as string[]
  const descendants = yield* isAncestor(git, cwd, base, head)
  if (!descendants) return [head]
  const commits = yield* read(git, cwd, "read_agent_commit_chain", ["rev-list", "--reverse", `${base}..${head}`])
  return commits.split(/\r?\n/).filter(Boolean)
})

export const preserveRef = Effect.fn("ArenaGit.preserveRef")(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  commit: string,
) {
  yield* run(git, cwd, "validate_ref", ["check-ref-format", ref])
  const current = yield* git.run(["rev-parse", "--verify", "--quiet", ref], { cwd })
  if (current.exitCode === 0) {
    const value = output(current)
    if (value === commit) return
    return yield* Effect.fail(
      new OperationError("preserve_ref", `Permanent battle ref ${ref} points to ${value}, not ${commit}`),
    )
  }
  if (current.exitCode !== 1) {
    const detail = current.stderr.toString("utf8").trim() || "Failed to inspect permanent battle ref"
    return yield* Effect.fail(new OperationError("preserve_ref", detail))
  }
  yield* run(git, cwd, "preserve_ref", ["update-ref", ref, commit])
  const verified = yield* read(git, cwd, "verify_ref", ["rev-parse", "--verify", ref])
  if (verified !== commit) {
    return yield* Effect.fail(new OperationError("verify_ref", "Permanent battle ref verification failed"))
  }
})

const advanceRef = Effect.fn("ArenaGit.advanceRef")(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  commit: string,
  expectedCommit: string,
) {
  yield* run(git, cwd, "validate_ref", ["check-ref-format", ref])
  const current = yield* git.run(["rev-parse", "--verify", "--quiet", ref], { cwd })
  if (current.exitCode !== 0) {
    const detail = current.stderr.toString("utf8").trim() || "Pre-vote battle ref is missing"
    return yield* Effect.fail(new OperationError("advance_ref", detail))
  }
  const value = output(current)
  if (value === commit) return
  if (value !== expectedCommit) {
    return yield* Effect.fail(
      new OperationError("advance_ref", `Pre-vote battle ref changed from ${expectedCommit} to ${value}`),
    )
  }

  const updated = yield* git.run(["update-ref", ref, commit, expectedCommit], { cwd })
  if (updated.exitCode !== 0) {
    const after = yield* git.run(["rev-parse", "--verify", "--quiet", ref], { cwd })
    if (after.exitCode === 0 && output(after) === commit) return
    const detail = updated.stderr.toString("utf8").trim() || "Pre-vote battle ref changed concurrently"
    return yield* Effect.fail(new OperationError("advance_ref", detail))
  }
  const verified = yield* read(git, cwd, "verify_ref", ["rev-parse", "--verify", ref])
  if (verified !== commit) {
    return yield* Effect.fail(new OperationError("verify_ref", "Pre-vote battle ref verification failed"))
  }
})

/** Remove an unadmitted battle ref only when it still points at the expected object. */
export const removeRef = Effect.fn("ArenaGit.removeRef")(function* (input: {
  readonly canonical: string
  readonly ref: string
  readonly expectedCommit: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_repository_root", ["rev-parse", "--show-toplevel"])
  const current = yield* git.run(["rev-parse", "--verify", "--quiet", input.ref], { cwd: root })
  if (current.exitCode === 1) return false
  if (current.exitCode !== 0 || output(current) !== input.expectedCommit) {
    return yield* Effect.fail(new OperationError("remove_ref", "Battle ref no longer matches the unadmitted snapshot"))
  }
  yield* run(git, root, "remove_ref", ["update-ref", "-d", input.ref, input.expectedCommit])
  return true
})

/** Return the permanent refs for one turn. `chat` must already be a stable ref-safe slug. */
export function battleRefs(chat: string, turn: number): BattleRefs {
  const root = `refs/battles/${chat}/turn-${turn}`
  return {
    base: `${root}/base`,
    a: `${root}/a`,
    b: `${root}/b`,
    selected: `${root}/selected`,
  }
}

/** Build the stable branch name shared by every turn of a chat side. */
export function sideBranchName(chatSlug: string, side: Side): string {
  return `agent-duel/${chatSlug}-agent-${side}`
}

type WorktreeRecord = {
  readonly path: string
  readonly branch?: string
  readonly bare?: true
}

function parseWorktrees(text: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let current: { path?: string; branch?: string; bare?: true } = {}
  const flush = () => {
    if (current.path) {
      records.push({
        path: current.path,
        ...(current.branch ? { branch: current.branch } : {}),
        ...(current.bare ? { bare: true } : {}),
      })
    }
    current = {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length).trim()
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim()
    else if (line.trim() === "bare") current.bare = true
  }
  flush()
  return records
}

const inspectWorktrees = Effect.fn("ArenaGit.inspectWorktrees")(function* (git: Git.Interface, root: string) {
  return parseWorktrees(yield* read(git, root, "read_repository_worktrees", ["worktree", "list", "--porcelain"]))
})

export type MirrorRefsInput = {
  /** Canonical checkout root or any directory inside it. */
  readonly canonical: string
  /** Bare host repository of one contestant. */
  readonly host: string
  /** Private refs whose objects this turn needs without exposing the refs to the contestant. */
  readonly requiredRefs?: readonly string[]
  /**
   * The host already went through a full mirror and nothing has copied into it since, so only
   * refs whose value moved, and the required refs, can name objects it lacks. Fetching every
   * mirrored ref again costs a local fetch that advertises all of the checkout's refs.
   */
  readonly fetchChangedOnly?: boolean
}

export type MirrorRefsResult = {
  readonly updated: number
  readonly deleted: number
  /** True when the canonical repository has an `origin` remote and it was copied. */
  readonly origin: boolean
}

const MIRRORED_NAMESPACES = ["refs/heads/", "refs/remotes/", "refs/tags/"]
const MIRROR_EXCLUDED_PREFIXES = ["refs/battles/", "refs/heads/agent-duel/"]
// `%(symref)` is the third column and is empty for an ordinary ref. It is the only thing that
// tells a symbolic ref apart in this listing: `for-each-ref` reports one with its target's object
// id, so `refs/remotes/origin/HEAD` looks exactly like an ordinary ref that moves whenever
// `refs/remotes/origin/main` moves. `parseRefList` ignores the column; `parseSymbolicRefs` reads it.
const REF_LIST_FORMAT = "--format=%(objectname) %(refname) %(symref)"
const HEADS_PREFIX = "refs/heads/"
const TAGS_PREFIX = "refs/tags/"
const REMOTES_PREFIX = "refs/remotes/"
const SIDE_BRANCH_PREFIX = "refs/heads/agent-duel/"
/**
 * Where a host records every ref at side setup: `refs/heads/main` at
 * `refs/agent-duel/start/heads/main`. Compared with the live refs at finalize.
 */
const REF_SNAPSHOT_ROOT = "refs/agent-duel/start/"

/** How the UI names a ref: `refs/heads/x` is `x`, `refs/tags/x` is `tag x`, `refs/remotes/x` is `x`. */
export function refLabel(ref: string) {
  if (ref.startsWith(HEADS_PREFIX)) return ref.slice(HEADS_PREFIX.length)
  if (ref.startsWith(TAGS_PREFIX)) return `tag ${ref.slice(TAGS_PREFIX.length)}`
  if (ref.startsWith(REMOTES_PREFIX)) return ref.slice(REMOTES_PREFIX.length)
  return ref
}

/** `refs/heads/main` -> `heads/main`, the part that follows `refs/`. */
function refTail(ref: string) {
  return ref.startsWith("refs/") ? ref.slice("refs/".length) : ref
}

const updateRefs = Effect.fn("ArenaGit.updateRefs")(function* (
  git: Git.Interface,
  cwd: string,
  operation: string,
  lines: readonly string[],
) {
  if (lines.length === 0) return
  yield* run(git, cwd, operation, ["update-ref", "--stdin"], {
    stdin: Stream.make(new TextEncoder().encode(`${lines.join("\n")}\n`)),
  })
})

/**
 * One guarded ref write that reports its own failure instead of failing the Effect, as the git
 * message's first line. A guard that does not hold is the developer's business rather than a
 * broken invariant: the ref moved between the read and the write, or its name collides with one
 * they already have, since git cannot hold both `refs/heads/x` and `refs/heads/x/y`. Callers that
 * must not lose the rest of their work use this; everything else uses `updateRefs`.
 */
function updateRefMessage(detail: string) {
  const first = detail.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? ""
  // `fatal: prepare: cannot lock ref ...`: the step's name means nothing to the developer.
  const message = first
    .trim()
    .replace(/^(?:fatal|error|warning):\s*/, "")
    .replace(/^(?:start|prepare|commit|abort):\s*/, "")
    .replace(/\.+$/, "")
  return message || "git update-ref failed"
}

/**
 * Names the developer's current version of each path, staged and in the worktree. An answer about
 * their edits is matched to this, so a file edited again after the answer is asked about again
 * instead of being replaced on the strength of the earlier answer.
 */
export const editsFingerprint = Effect.fn("ArenaGit.editsFingerprint")(function* (
  canonical: string,
  paths: readonly string[],
) {
  const git = yield* Git.Service
  const root = yield* read(git, canonical, "find_edits_fingerprint_root", ["rev-parse", "--show-toplevel"])
  const staged = new Map<string, string>()
  const listed = yield* run(git, root, "read_edits_index", ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths])
  for (const entry of listed.text().split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    // `<mode> <oid> <stage>\t<path>`; a conflicted path lists each stage.
    const [, oid, stage] = entry.slice(0, tab).split(" ")
    const path = entry.slice(tab + 1)
    staged.set(path, [staged.get(path), `${stage}=${oid}`].filter(Boolean).join(","))
  }
  const files: string[] = []
  for (const path of paths) {
    const stat = yield* Effect.promise(() => lstat(join(root, path)).catch(() => undefined))
    if (stat?.isFile() || stat?.isSymbolicLink()) files.push(path)
  }
  const hashed =
    files.length > 0
      ? (yield* run(git, root, "hash_edits_worktree", ["hash-object", "--stdin-paths"], {
          stdin: Stream.make(new TextEncoder().encode(`${files.join("\n")}\n`)),
        }))
          .text()
          .split("\n")
          .filter(Boolean)
      : []
  const worktree = new Map(files.map((path, index) => [path, hashed[index]]))
  return paths.map((path) => `${path}:${staged.get(path) ?? "-"}:${worktree.get(path) ?? "-"}`).join("\0")
})

/** An `update-ref` transaction Git has prepared: every ref is locked and checked, none written. */
export interface HeldRefTransaction {
  /** Writes the refs. Resolves to Git's refusal, or undefined once they are written. */
  readonly commit: Effect.Effect<string | undefined>
  /** Releases the locks without writing. Safe to call after `commit`. */
  readonly abort: Effect.Effect<void>
}

/**
 * Starts `git update-ref --stdin` and stops at `prepare`, which takes every lock and checks every
 * old value. The process stays open, holding the locks, until `commit` or `abort`; a ref that
 * moved fails here, before the caller has changed anything. `Git.Service` runs a command to
 * completion, so this one is spawned directly.
 */
function holdRefTransaction(cwd: string, lines: string) {
  return Effect.callback<HeldRefTransaction, OperationError>((resume) => {
    const child = spawn("git", ["update-ref", "--stdin"], { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let prepared = false
    let done = false
    const exited = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1))
      child.on("error", (error) => {
        stderr += error.message
        resolve(1)
      })
    })
    const finish = (verb: "commit" | "abort") =>
      Effect.promise(async () => {
        if (!done) {
          done = true
          child.stdin.end(`${verb}\n`)
        }
        const code = await exited
        return verb === "commit" && (code !== 0 || !/^commit: ok$/m.test(stdout)) ? updateRefMessage(stderr || stdout) : undefined
      })
    const held: HeldRefTransaction = { commit: finish("commit"), abort: Effect.asVoid(finish("abort")) }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (!prepared && /^prepare: ok$/m.test(stdout)) {
        prepared = true
        resume(Effect.succeed(held))
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    void exited.then(() => {
      if (!prepared) resume(Effect.fail(new OperationError("write_winner_refs", updateRefMessage(stderr || stdout))))
    })
    child.stdin.on("error", () => {})
    child.stdin.write(`start\n${lines}\nprepare\n`)
    // Interrupted while waiting for the locks: let go of them.
    return Effect.sync(() => {
      if (!prepared && !done) {
        done = true
        child.kill()
      }
    })
  })
}

function parseRefList(text: string) {
  const refs = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const [oid, ref] = line.trim().split(" ")
    if (oid && ref) refs.set(ref, oid)
  }
  return refs
}

/** The symbolic refs in a `REF_LIST_FORMAT` listing, by the ref each one points at. */
function parseSymbolicRefs(text: string) {
  const symbolic = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const [oid, ref, target] = line.trim().split(" ")
    if (oid && ref && target) symbolic.set(ref, target)
  }
  return symbolic
}

/**
 * Refresh the canonical ref names and `origin` in a contestant host. A fresh host is a copy
 * of the canonical git directory, so this is a no-op there apart from the prune; a warm host
 * was copied at the end of the previous turn, so the canonical refs may have moved since.
 * Branches checked out in a host worktree are the contestant's own and are never touched.
 * Every other host ref in a mirrored namespace that the canonical does not have is removed,
 * and so is every ref the copy brought along under `refs/battles/` or `refs/heads/agent-duel/`:
 * those are Arena's private refs from earlier turns and mean nothing to a contestant.
 */
export const mirrorCanonicalRefs = Effect.fn("ArenaGit.mirrorCanonicalRefs")(function* (input: MirrorRefsInput) {
  const git = yield* Git.Service
  const hostWorktrees = parseWorktrees(
    yield* read(git, input.host, "read_host_worktrees", ["worktree", "list", "--porcelain"]),
  )
  const protectedRefs = new Set(hostWorktrees.flatMap((item) => (item.branch ? [`refs/heads/${item.branch}`] : [])))
  const mirrored = (ref: string) =>
    MIRRORED_NAMESPACES.some((namespace) => ref.startsWith(namespace)) &&
    !MIRROR_EXCLUDED_PREFIXES.some((prefix) => ref.startsWith(prefix)) &&
    !protectedRefs.has(ref)
  const listArgs = ["for-each-ref", REF_LIST_FORMAT, ...MIRRORED_NAMESPACES]
  const sourceListing = yield* read(git, input.canonical, "read_canonical_refs", listArgs)
  const existingListing = yield* read(git, input.host, "read_host_refs", listArgs)
  const source = parseRefList(sourceListing)
  const existing = parseRefList(existingListing)
  // A symbolic ref is never updated, never deleted, and never fetched: it follows its target, so
  // writing it moves the target instead. `for-each-ref` reports `refs/remotes/origin/HEAD` with
  // the object id of `refs/remotes/origin/main`, so keeping it would put both names in one
  // transaction and git refuses that outright, and a delete would remove the target rather than
  // the symref. The clone's own `origin/HEAD` is the case that arises in practice.
  for (const ref of parseSymbolicRefs(sourceListing).keys()) source.delete(ref)
  for (const ref of parseSymbolicRefs(existingListing).keys()) existing.delete(ref)
  const stale = parseRefList(
    yield* read(git, input.host, "read_host_excluded_refs", [
      "for-each-ref",
      REF_LIST_FORMAT,
      ...MIRROR_EXCLUDED_PREFIXES,
    ]),
  )
  const wanted = [...(input.requiredRefs ?? [])]
  const updates: string[] = []
  const deletes: string[] = []
  for (const [ref, oid] of source) {
    if (!mirrored(ref)) continue
    if (existing.get(ref) === oid) {
      if (!input.fetchChangedOnly) wanted.push(ref)
      continue
    }
    wanted.push(ref)
    updates.push(`update ${ref} ${oid}`)
  }
  for (const ref of existing.keys()) {
    if (!mirrored(ref) || source.has(ref)) continue
    deletes.push(`delete ${ref}`)
  }
  for (const ref of stale.keys()) {
    if (protectedRefs.has(ref)) continue
    deletes.push(`delete ${ref}`)
  }
  // A host owns its objects, and they stop at the moment it was copied. `update-ref` refuses to
  // point a ref at an object the repository does not have, and the transaction is atomic, so one
  // new canonical commit would otherwise fail the whole mirror. Every mirrored canonical ref is
  // fetched, not only the ones whose value moved, unless the host was already mirrored whole
  // (`fetchChangedOnly`): `copyGitState` copies a live `.git` in readdir order, so a commit or a
  // `git gc` in the canonical between the read of `objects/` and the read of `refs/` leaves the
  // host with an unchanged ref naming an object it lacks. Git checks the connectivity of the
  // wanted tips before deciding it has nothing to do, so a tip with a missing object is requested
  // even though the local ref already names it. The fetch writes no ref of its own, which leaves
  // the transaction below in charge of every ref value. The names go over stdin rather than the
  // command line so a repository with thousands of refs cannot hit the argv limit.
  if (wanted.length > 0) {
    const requested = [...new Set(wanted)]
    yield* run(
      git,
      input.host,
      "fetch_canonical_objects",
      ["fetch", "--stdin", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", input.canonical],
      { stdin: Stream.make(new TextEncoder().encode(`${requested.join("\n")}\n`)) },
    )
  }
  // Deletes go first in their own transaction: git refuses to delete `refs/heads/foo` and create
  // `refs/heads/foo/bar` in one `update-ref --stdin` transaction ("cannot lock ref").
  yield* updateRefs(git, input.host, "mirror_canonical_ref_deletes", deletes)
  yield* updateRefs(git, input.host, "mirror_canonical_ref_updates", updates)
  const updated = updates.length
  const deleted = deletes.length

  const url = yield* git.run(["config", "--get", "remote.origin.url"], { cwd: input.canonical })
  if (url.exitCode !== 0) return { updated, deleted, origin: false } satisfies MirrorRefsResult
  yield* run(git, input.host, "mirror_origin_url", ["config", "remote.origin.url", output(url)])
  const fetch = yield* git.run(["config", "--get-all", "remote.origin.fetch"], { cwd: input.canonical })
  const specs =
    fetch.exitCode === 0 ? output(fetch).split(/\r?\n/).filter(Boolean) : ["+refs/heads/*:refs/remotes/origin/*"]
  // `--unset-all` exits 5 when the key is absent; a fresh host has no fetch spec yet.
  yield* git.run(["config", "--unset-all", "remote.origin.fetch"], { cwd: input.host })
  for (const spec of specs) {
    yield* run(git, input.host, "mirror_origin_fetch", ["config", "--add", "remote.origin.fetch", spec])
  }
  const pushUrl = yield* git.run(["config", "--get", "remote.origin.pushurl"], { cwd: input.canonical })
  if (pushUrl.exitCode === 0) {
    yield* run(git, input.host, "mirror_origin_pushurl", ["config", "remote.origin.pushurl", output(pushUrl)])
  } else {
    yield* git.run(["config", "--unset", "remote.origin.pushurl"], { cwd: input.host })
  }
  return { updated, deleted, origin: true } satisfies MirrorRefsResult
})

const listHostRefs = Effect.fn("ArenaGit.listHostRefs")(function* (git: Git.Interface, host: string) {
  const listing = yield* read(git, host, "read_host_mirrored_refs", [
    "for-each-ref",
    REF_LIST_FORMAT,
    ...MIRRORED_NAMESPACES,
  ])
  const live = parseRefList(listing)
  // A symbolic ref carries no object of its own; `refs/remotes/origin/HEAD` appears to move only
  // because `refs/remotes/origin/main` moved, and that is reported under its own name. Recording
  // one would make carry-over write the target a second time, under a name nobody asked about.
  for (const ref of parseSymbolicRefs(listing).keys()) live.delete(ref)
  for (const ref of Array.from(live.keys())) {
    if (ref.startsWith(SIDE_BRANCH_PREFIX)) live.delete(ref)
  }
  const start = parseRefList(
    yield* read(git, host, "read_ref_snapshot", ["for-each-ref", REF_LIST_FORMAT, REF_SNAPSHOT_ROOT]),
  )
  return { live, start }
})

/**
 * Record where every host branch, tag, and remote-tracking ref points at side setup, under
 * `refs/agent-duel/start/`. Git keeps no such record itself. The refs live in the host rather
 * than in memory or the store, so `finalize` can read them later without the store. Side
 * branches (`agent-duel/*`) and symbolic refs are not recorded. A previous snapshot is replaced.
 */
export const snapshotHostRefs = Effect.fn("ArenaGit.snapshotHostRefs")(function* (input: { readonly host: string }) {
  const git = yield* Git.Service
  const { live, start } = yield* listHostRefs(git, input.host)
  const deletes = Array.from(start.keys(), (ref) => `delete ${ref}`)
  const updates = Array.from(live, ([ref, oid]) => `update ${REF_SNAPSHOT_ROOT}${refTail(ref)} ${oid}`)
  // Two transactions rather than one, for the same reason `mirrorCanonicalRefs` splits its own:
  // a previous snapshot of `refs/heads/foo` and a new one of `refs/heads/foo/bar` cannot be
  // deleted and created together, and git fails the whole transaction rather than the one ref.
  // The cost is a window in which a crash leaves no snapshot, which makes the next diff report
  // every ref as created -- a wrong report, and no write to the developer's repository.
  yield* updateRefs(git, input.host, "clear_ref_snapshot", deletes)
  yield* updateRefs(git, input.host, "write_ref_snapshot", updates)
  return { count: updates.length }
})

/**
 * The refs a contestant moved, created, or deleted since `snapshotHostRefs`, by full name.
 * `exclude` names the refs the promotion handles itself: the chat branch and the branch the
 * contestant ended on. Side branches and symbolic refs are never reported. Object ids are compared
 * as `for-each-ref` reports them, so an annotated tag is its tag object.
 */
export const diffHostRefs = Effect.fn("ArenaGit.diffHostRefs")(function* (input: {
  readonly host: string
  readonly exclude: readonly string[]
}) {
  const git = yield* Git.Service
  const { live, start } = yield* listHostRefs(git, input.host)
  const excluded = new Set(input.exclude)
  const names = new Set<string>(live.keys())
  for (const ref of start.keys()) names.add(`refs/${ref.slice(REF_SNAPSHOT_ROOT.length)}`)
  const changes: RefChange[] = []
  for (const ref of Array.from(names).sort()) {
    if (excluded.has(ref)) continue
    const before = start.get(`${REF_SNAPSHOT_ROOT}${refTail(ref)}`)
    const after = live.get(ref)
    if (before === after) continue
    changes.push({ ref, ...(before ? { before } : {}), ...(after ? { after } : {}) })
  }
  return changes as readonly RefChange[]
})

/**
 * Bring one ref from a host into the canonical repository under a private name, exactly as
 * it is. Unlike `importResultRef` nothing is peeled, so an annotated tag arrives as its tag
 * object. A destination already holding `expected` is left alone.
 */
export const importWinnerRef = Effect.fn("ArenaGit.importWinnerRef")(function* (input: {
  readonly canonical: string
  readonly sourceRepository: string
  readonly sourceRef: string
  readonly destinationRef: string
  /** Exact object id the destination must hold afterwards; never peeled. */
  readonly expected: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_import_winner_ref_root", ["rev-parse", "--show-toplevel"])
  yield* run(git, root, "validate_winner_ref", ["check-ref-format", input.destinationRef])
  const current = yield* git.run(["rev-parse", "--verify", "--quiet", input.destinationRef], { cwd: root })
  if (current.exitCode === 0 && output(current) === input.expected) return
  if (current.exitCode !== 0 && current.exitCode !== 1) {
    const detail = current.stderr.toString("utf8").trim() || "Failed to inspect the imported ref"
    return yield* Effect.fail(new OperationError("inspect_winner_ref", detail))
  }
  // `+` lets a retry replace a destination left by an earlier attempt. If verification below
  // fails, the destination is already replaced; acceptable since it is a private battle ref Arena owns.
  yield* run(git, root, "import_winner_ref", [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    input.sourceRepository,
    `+${input.sourceRef}:${input.destinationRef}`,
  ])
  const imported = yield* read(git, root, "verify_winner_ref", ["rev-parse", "--verify", input.destinationRef])
  if (imported !== input.expected) {
    return yield* Effect.fail(
      new OperationError("verify_winner_ref", `Imported ${input.sourceRef} is ${imported}, expected ${input.expected}`),
    )
  }
})

/** A ref the winner changed, measured against the developer's repository for `decideRef`. */
export type ObservedRef = RefObservation & {
  readonly ref: string
  /** Where the ref was when the contestant's host was set up. */
  readonly start?: string
  /** Where the winner left it. */
  readonly agent?: string
  /** Where the developer's repository has it now. */
  readonly yours?: string
  /** The other worktree that has this branch checked out. */
  readonly checkedOutAt?: string
  /** Commits on the developer's ref that the agent's would no longer have, for the callout's words. */
  readonly lost?: number
  /** Subjects of the newest of those commits, up to three, newest first. */
  readonly lostSubjects?: readonly string[]
  /** The subject of the commit the agent left the ref on. */
  readonly agentSubject?: string
  /** Changes whenever any input to the decision changes, so a stored answer can be matched to it. */
  readonly fingerprint: string
}

function refNamespace(ref: string): RefNamespace | undefined {
  if (ref.startsWith(HEADS_PREFIX)) return "branch"
  if (ref.startsWith(TAGS_PREFIX)) return "tag"
  if (ref.startsWith(REMOTES_PREFIX)) return "remote"
  return undefined
}

function refFingerprint(values: readonly (string | undefined)[]) {
  return values.map((value) => value ?? "-").join(":")
}

const firstParentChain = Effect.fn("ArenaGit.firstParentChain")(function* (
  git: Git.Interface,
  root: string,
  base: string,
  tip: string,
) {
  const listing = yield* read(git, root, "read_ref_replay_chain", [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${base}..${tip}`,
  ])
  return listing.split(/\r?\n/).filter(Boolean)
})

/** The paths replaying `base..tip` onto `onto` would conflict on; empty when it replays cleanly. */
const replayClash = Effect.fn("ArenaGit.replayClash")(function* (
  git: Git.Interface,
  root: string,
  input: { readonly base: string; readonly tip: string; readonly onto: string },
) {
  const chain = yield* firstParentChain(git, root, input.base, input.tip)
  const replayed = yield* replayCommits(git, root, input.onto, chain, true)
  return replayed.conflict ?? []
})

const mergeBase = Effect.fn("ArenaGit.mergeBase")(function* (git: Git.Interface, root: string, a: string, b: string) {
  const result = yield* git.run(["merge-base", a, b], { cwd: root })
  if (result.exitCode === 0) return output(result)
  if (result.exitCode === 1) return undefined
  const detail = result.stderr.toString("utf8").trim() || "Failed to find a merge base"
  return yield* Effect.fail(new OperationError("inspect_merge_base", detail))
})

/**
 * Measure every ref the winner changed against the developer's repository, without writing.
 * The winner's objects are read from its imported refs under `sourceRefPrefix`. Symbolic refs and
 * refs outside the carried namespaces are returned as skips: `diffHostRefs` produces neither, so
 * only a change stored by an older version reaches them.
 */
export const observeWinnerRefs = Effect.fn("ArenaGit.observeWinnerRefs")(function* (input: {
  readonly canonical: string
  readonly changes: readonly RefChange[]
  /** `${permanentRef}-refs`; each change's object is read from `<prefix>/<ref without refs/>`. */
  readonly sourceRefPrefix: string
  /** The branch the trunk has checked out once the winner is applied. */
  readonly checkoutBranch?: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_observe_refs_root", ["rev-parse", "--show-toplevel"])
  const trunk = resolve(root)
  const checkedOut = new Map<string, string>(
    (yield* inspectWorktrees(git, root)).flatMap((item) =>
      item.branch && resolve(item.path) !== trunk ? [[`${HEADS_PREFIX}${item.branch}`, item.path] as const] : [],
    ),
  )
  const listing = yield* read(git, root, "read_canonical_refs", ["for-each-ref", REF_LIST_FORMAT, ...MIRRORED_NAMESPACES])
  const current = parseRefList(listing)
  const symbolic = parseSymbolicRefs(listing)
  const ancestor = (base: string, head: string) => isAncestor(git, root, base, head)
  const refs: ObservedRef[] = []
  const skipped: RefOutcome[] = []
  for (const change of input.changes) {
    const { ref } = change
    const namespace = refNamespace(ref)
    if (!namespace) {
      skipped.push({ ref, action: "skipped", reason: `${refLabel(ref)} is outside the refs a battle carries over.` })
      continue
    }
    const target = symbolic.get(ref)
    if (target) {
      skipped.push({ ref, action: "skipped", reason: `${refLabel(ref)} is a symbolic ref for ${refLabel(target)}.` })
      continue
    }
    const start = change.before
    const agent = change.after
    const yours = current.get(ref)
    // Git cannot hold `a` and `a/b` at once. A name the developer's repository already uses as a
    // directory, or under one, cannot be written and would refuse the whole transaction.
    const collision =
      agent && !yours
        ? Array.from(current.keys()).find((other) => other.startsWith(`${ref}/`) || ref.startsWith(`${other}/`))
        : undefined
    if (collision) {
      skipped.push({ ref, action: "skipped", reason: `${refLabel(ref)} could not be written: '${collision}' exists.` })
      continue
    }
    if (agent) {
      const source = yield* git.run(["rev-parse", "--verify", "--quiet", `${input.sourceRefPrefix}/${refTail(ref)}`], {
        cwd: root,
      })
      if (source.exitCode !== 0 || output(source) !== agent) {
        return yield* Effect.fail(
          new OperationError("winner_ref_missing", `The imported object of ${refLabel(ref)} is missing or changed`),
        )
      }
    }
    // A tag names one object, so any move is a rewrite; branches and remote-tracking refs are
    // commit lines and are measured by ancestry.
    const lineage = namespace !== "tag"
    let agentMove: AgentMove = "rewrote"
    if (!start) agentMove = "created"
    else if (!agent) agentMove = "deleted"
    else if (lineage && (yield* ancestor(start, agent))) agentMove = "added"
    let yourMove: YourMove = "rewrote"
    if (yours === start) yourMove = "untouched"
    else if (!start) yourMove = "created"
    else if (!yours) yourMove = "deleted"
    else if (lineage && (yield* ancestor(start, yours))) yourMove = "added"
    const bothGone = agent === undefined && yours === undefined
    // Holding the agent's tip settles a rewrite only when that tip is new. A rewind lands on a
    // commit the battle started with, which the developer's branch holds without having taken it.
    const containsAgent =
      agent !== undefined &&
      yours !== undefined &&
      lineage &&
      (yield* ancestor(agent, yours)) &&
      (agentMove !== "rewrote" || !start || !(yield* ancestor(agent, start)))
    const settled = agent === yours || bothGone || containsAgent
    // Only an untouched ref, or one the developer moved forward along the same line, may follow
    // the agent forward: a ref they rewound is an ancestor of the agent's tip too, and following
    // the agent would undo that rewind.
    const followsYours = yours === undefined ? start === undefined : lineage && !!agent && (yield* ancestor(yours, agent))
    const fastForward = agent !== undefined && (yours === start || yourMove === "added") && followsYours
    const clash: ObservedRef["clash"] = {}
    if (!settled && lineage && agent && yours) {
      if (agentMove === "added" || agentMove === "created") {
        const base = start ?? (yield* mergeBase(git, root, yours, agent))
        if (base) clash.agent_on_yours = yield* replayClash(git, root, { base, tip: agent, onto: yours })
      }
      if (agentMove === "rewrote" && yourMove === "added" && start) {
        clash.yours_on_agent = yield* replayClash(git, root, { base: start, tip: yours, onto: agent })
      }
    }
    const checkedOutAt = namespace === "branch" ? checkedOut.get(ref) : undefined
    // What the developer would see change, in their terms: commits that leave the ref, and where
    // it lands. Only for a ref that is still a question.
    let described:
      | { lost: number; lostSubjects: readonly string[]; rewound: boolean; agentSubject: string }
      | undefined
    if (!settled && agent && yours) {
      const lost = Number(yield* read(git, root, "count_lost_commits", ["rev-list", "--count", `${agent}..${yours}`]))
      const subjects = lost > 0 ? yield* read(git, root, "read_lost_subjects", ["log", "-3", "--format=%s", `${agent}..${yours}`]) : ""
      described = {
        lost,
        lostSubjects: subjects.split("\n").filter(Boolean),
        rewound: yield* ancestor(agent, yours),
        agentSubject: yield* read(git, root, "read_agent_subject", ["log", "-1", "--format=%s", agent]),
      }
    }
    refs.push({
      ref,
      namespace,
      agentMove,
      yourMove,
      settled,
      fastForward,
      checkout: input.checkoutBranch !== undefined && ref === `${HEADS_PREFIX}${input.checkoutBranch}`,
      checkedOutElsewhere: checkedOutAt !== undefined,
      clash,
      ...(start ? { start } : {}),
      ...(agent ? { agent } : {}),
      ...(yours ? { yours } : {}),
      ...(checkedOutAt ? { checkedOutAt } : {}),
      ...(described ?? {}),
      fingerprint: refFingerprint([start, agent, yours, checkedOutAt]),
    })
  }
  return { refs: refs as readonly ObservedRef[], skipped: skipped as readonly RefOutcome[] }
})

/**
 * Where a branch the trunk may switch to stands: its tip, and the other worktree that has it
 * checked out. Both are undefined for a name that does not exist or is free.
 */
export const inspectBranchTarget = Effect.fn("ArenaGit.inspectBranchTarget")(function* (input: {
  readonly canonical: string
  readonly branch: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_branch_target_root", ["rev-parse", "--show-toplevel"])
  const ref = `${HEADS_PREFIX}${input.branch}`
  const valid = yield* git.run(["check-ref-format", ref], { cwd: root })
  if (valid.exitCode !== 0) return { valid: false as const }
  const tip = yield* git.run(["rev-parse", "--verify", "--quiet", ref], { cwd: root })
  if (tip.exitCode !== 0 && tip.exitCode !== 1) {
    return yield* Effect.fail(new OperationError("inspect_branch_target", `Failed to inspect ${input.branch}`))
  }
  const trunk = resolve(root)
  const checkedOutAt = (yield* inspectWorktrees(git, root)).find(
    (item) => item.branch === input.branch && resolve(item.path) !== trunk,
  )?.path
  return {
    valid: true as const,
    ...(tip.exitCode === 0 ? { tip: output(tip) } : {}),
    ...(checkedOutAt ? { checkedOutAt } : {}),
  }
})

/** One ref write the developer accepted, with the values it was decided on. */
export type RefWrite = Pick<ObservedRef, "ref" | "start" | "agent" | "yours" | "checkedOutAt"> & {
  readonly action: Exclude<BranchAction, "yours" | "combine">
}

/** Where the commit a write replaces is kept: `<prefix>/<ref without refs/>`. */
export function refBackupName(prefix: string, ref: string) {
  return `${prefix}/${refTail(ref)}`
}

/** The trunk's own branch as the plan moves it; the checkout writes it, not the ref transaction. */
export type CheckoutMove = {
  readonly ref: string
  /** The branch's tip before the vote; absent for a branch the vote creates. */
  readonly before?: string
  readonly how?: "agent_on_yours" | "yours_on_agent"
}

/**
 * Report what the checkout did to its branch, in the terms `writeWinnerRefs` reports the others.
 * A plain fast-forward is the ordinary battle and is not reported. Commits the branch no longer
 * reaches are kept under `backupPrefix`, as a ref write keeps them.
 */
export const reportCheckoutMove = Effect.fn("ArenaGit.reportCheckoutMove")(function* (input: {
  readonly canonical: string
  readonly move: CheckoutMove
  readonly after: string
  readonly backupPrefix: string
}) {
  const git = yield* Git.Service
  const { ref, before, how } = input.move
  if (before === input.after) return undefined
  if (!before) return { ref, action: "created" } satisfies RefOutcome
  const root = yield* read(git, input.canonical, "find_report_checkout_root", ["rev-parse", "--show-toplevel"])
  const removed = (yield* isAncestor(git, root, before, input.after))
    ? 0
    : Number.parseInt(yield* read(git, root, "count_replaced_checkout_commits", ["rev-list", "--count", `${input.after}..${before}`]), 10)
  if (removed === 0 && !how) return undefined
  const backupRef = refBackupName(input.backupPrefix, ref)
  if (removed > 0) yield* run(git, root, "keep_replaced_checkout_tip", ["update-ref", backupRef, before])
  return {
    ref,
    action: "updated",
    ...(removed > 0 ? { removed, backupRef } : {}),
    ...(how ? { how } : {}),
  } satisfies RefOutcome
})

/**
 * Write every accepted ref in one `update-ref` transaction, so they all land or none does. Each
 * update is guarded by the value the decision was made on; a ref that moved since then fails the
 * whole write rather than being overwritten. The value a write replaces is kept under
 * `backupPrefix` in the same transaction. A branch another worktree has checked out is taken by
 * detaching that worktree at its commit first, which leaves its index and files alone; a failed
 * transaction attaches it again.
 */
export const writeWinnerRefs = Effect.fn("ArenaGit.writeWinnerRefs")(function* (input: {
  readonly canonical: string
  readonly writes: readonly RefWrite[]
  readonly backupPrefix: string
}) {
  const held = yield* holdWinnerRefs(input)
  return yield* held.commit
})

/** Winner refs Git has locked and checked, written by `commit`, released by `abort`. */
export interface HeldWinnerRefs {
  readonly commit: Effect.Effect<readonly RefOutcome[], OperationError>
  readonly abort: Effect.Effect<void>
}

/**
 * `writeWinnerRefs` in two steps. This one works out every write and has Git lock and check them;
 * nothing is written. The service holds them while it writes the checkout, so a ref that moved
 * or is locked by another Git process fails before the checkout changes, not after.
 */
export const holdWinnerRefs = Effect.fn("ArenaGit.holdWinnerRefs")(function* (input: {
  readonly canonical: string
  readonly writes: readonly RefWrite[]
  readonly backupPrefix: string
}) {
  const git = yield* Git.Service
  if (input.writes.length === 0) {
    return { commit: Effect.succeed([] as readonly RefOutcome[]), abort: Effect.void } satisfies HeldWinnerRefs
  }
  const root = yield* read(git, input.canonical, "find_write_refs_root", ["rev-parse", "--show-toplevel"])
  const lines: string[] = []
  const outcomes: RefOutcome[] = []
  for (const write of input.writes) {
    let target = write.agent
    if (write.action !== "agent") {
      const onto = write.action === "agent_on_yours" ? write.yours : write.agent
      const tip = write.action === "agent_on_yours" ? write.agent : write.yours
      const base = write.action === "agent_on_yours" ? (write.start ?? (onto && tip ? yield* mergeBase(git, root, onto, tip) : undefined)) : write.start
      if (!onto || !tip || !base) {
        return yield* Effect.fail(new OperationError("write_winner_refs", `${refLabel(write.ref)} cannot be combined`))
      }
      const replayed = yield* replayCommits(git, root, onto, yield* firstParentChain(git, root, base, tip), true)
      if (replayed.conflict) {
        return yield* Effect.fail(
          new OperationError("write_winner_refs", `${refLabel(write.ref)} no longer combines cleanly`, replayed.conflict),
        )
      }
      target = replayed.head
    }
    const backupRef = write.yours ? refBackupName(input.backupPrefix, write.ref) : undefined
    if (write.yours && backupRef) lines.push(`update ${backupRef} ${write.yours}`)
    if (!target) {
      if (write.yours) lines.push(`delete ${write.ref} ${write.yours}`)
      outcomes.push({ ref: write.ref, action: "deleted", ...(backupRef ? { backupRef } : {}) })
      continue
    }
    const zero = "0".repeat(target.length)
    lines.push(`update ${write.ref} ${target} ${write.yours ?? zero}`)
    const removed =
      write.yours === undefined || (yield* isAncestor(git, root, write.yours, target))
        ? 0
        : Number.parseInt(yield* read(git, root, "count_replaced_commits", ["rev-list", "--count", `${target}..${write.yours}`]), 10)
    outcomes.push({
      ref: write.ref,
      action: write.yours ? "updated" : "created",
      ...(removed > 0 && backupRef ? { removed, backupRef } : {}),
      ...(write.action === "agent" ? {} : { how: write.action }),
    })
  }
  const transaction = yield* holdRefTransaction(root, lines.join("\n"))
  const commit = Effect.gen(function* () {
    const detached: { readonly path: string; readonly ref: string }[] = []
    const reattach = Effect.forEach(detached, (item) => git.run(["symbolic-ref", "HEAD", item.ref], { cwd: item.path }))
    for (const write of input.writes) {
      if (!write.checkedOutAt) continue
      const head = yield* read(git, write.checkedOutAt, "read_taken_worktree_head", ["rev-parse", "--verify", "HEAD"]).pipe(
        Effect.tapError(() => Effect.andThen(reattach, transaction.abort)),
      )
      yield* run(git, write.checkedOutAt, "detach_taken_worktree", ["update-ref", "--no-deref", "HEAD", head, head]).pipe(
        Effect.tapError(() => Effect.andThen(reattach, transaction.abort)),
      )
      detached.push({ path: write.checkedOutAt, ref: write.ref })
    }
    const refused = yield* transaction.commit
    if (refused) {
      yield* reattach
      return yield* Effect.fail(new OperationError("write_winner_refs", refused))
    }
    return outcomes as readonly RefOutcome[]
  })
  return { commit, abort: transaction.abort } satisfies HeldWinnerRefs
})

/**
 * Reset a persistent side branch to the frozen base. Git refuses to move a branch checked
 * out in another worktree; inspect the shared worktree registry first so callers get a
 * useful operation error and never bypass that protection with `update-ref`.
 */
export const resetSideBranch = Effect.fn("ArenaGit.resetSideBranch")(function* (
  input: Omit<SideBranchInput, "worktree">,
) {
  const git = yield* Git.Service
  const root = yield* read(git, input.repository, "find_repository_root", ["rev-parse", "--show-toplevel"])
  yield* run(git, root, "validate_side_branch", ["check-ref-format", input.branch])
  const worktrees = yield* inspectWorktrees(git, root)
  const checkedOut = worktrees.find((item) => item.branch === input.branch)
  if (checkedOut) {
    return yield* Effect.fail(
      new OperationError("reset_side_branch", `Side branch ${input.branch} is checked out at ${checkedOut.path}`),
    )
  }
  const existing = yield* git.run(["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], { cwd: root })
  const args =
    existing.exitCode === 0
      ? ["branch", "--force", input.branch, input.baseCommit]
      : ["branch", input.branch, input.baseCommit]
  if (existing.exitCode !== 0 && existing.exitCode !== 1) {
    return yield* Effect.fail(new OperationError("inspect_side_branch", "Failed to inspect side branch"))
  }
  yield* run(git, root, "reset_side_branch", args)
  const commit = yield* read(git, root, "verify_side_branch", ["rev-parse", `refs/heads/${input.branch}`])
  if (commit !== input.baseCommit) {
    return yield* Effect.fail(new OperationError("verify_side_branch", "Side branch reset did not reach frozen base"))
  }
  return { branch: input.branch, baseCommit: commit } satisfies SideBranchResult
})

/** Attach an already registered worktree to a persistent side branch after safety checks. */
export const attachSideBranch = Effect.fn("ArenaGit.attachSideBranch")(function* (input: SideBranchInput) {
  const git = yield* Git.Service
  const worktree = input.worktree
  if (!worktree) {
    return yield* Effect.fail(new OperationError("attach_side_branch", "A worktree is required to attach a side branch"))
  }
  const root = yield* read(git, input.repository, "find_repository_root", ["rev-parse", "--show-toplevel"])
  const worktrees = yield* inspectWorktrees(git, root)
  const target = worktrees.find((item) => item.path === worktree)
  if (!target) {
    return yield* Effect.fail(
      new OperationError("attach_side_branch", `Worktree is not registered: ${worktree}`),
    )
  }
  const checkedOut = worktrees.find((item) => item.branch === input.branch && item.path !== worktree)
  if (checkedOut) {
    return yield* Effect.fail(
      new OperationError("attach_side_branch", `Side branch ${input.branch} is checked out at ${checkedOut.path}`),
    )
  }
  yield* run(git, worktree, "attach_side_branch", ["checkout", "--force", input.branch])
  const branch = yield* read(git, worktree, "verify_attached_branch", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ])
  const commit = yield* read(git, worktree, "verify_attached_commit", ["rev-parse", "--verify", "HEAD"])
  if (branch !== input.branch || commit !== input.baseCommit) {
    return yield* Effect.fail(
      new OperationError("verify_attached_branch", "Attached side branch does not match frozen base"),
    )
  }
  return { branch, baseCommit: commit, worktree } satisfies SideBranchResult
})

/** Reset a side branch and, when provided, attach its prepared registered worktree. */
export const prepareSideBranch = Effect.fn("ArenaGit.prepareSideBranch")(function* (input: SideBranchInput) {
  const reset = yield* resetSideBranch(input)
  if (!input.worktree) return reset
  return yield* attachSideBranch({ ...input, ...reset })
})

/** Detach a retained result from its persistent side branch without removing its directory. */
export const detachAtResult = Effect.fn("ArenaGit.detachAtResult")(function* (input: {
  readonly worktree: string
  readonly resultCommit: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.worktree, "find_retained_worktree", ["rev-parse", "--show-toplevel"])
  yield* run(git, root, "detach_retained_worktree", ["checkout", "--detach", "--force", input.resultCommit])
  const head = yield* read(git, root, "verify_retained_head", ["rev-parse", "--verify", "HEAD"])
  const branch = yield* readBranch(git, root)
  if (head !== input.resultCommit || branch !== undefined) {
    return yield* Effect.fail(new OperationError("verify_retained_detachment", "Retained result did not detach cleanly"))
  }
  return {
    worktree: root,
    head,
    tree: yield* read(git, root, "read_retained_tree", ["rev-parse", "HEAD^{tree}"]),
  } satisfies WorktreeAttachment
})

/** Refresh a warm worktree while its persistent side branch remains attached there. */
export const refreshAttachedSide = Effect.fn("ArenaGit.refreshAttachedSide")(function* (input: SideBranchInput) {
  const git = yield* Git.Service
  if (!input.worktree) {
    return yield* Effect.fail(new OperationError("refresh_attached_side", "A worktree is required"))
  }
  const root = yield* read(git, input.worktree, "find_warm_worktree", ["rev-parse", "--show-toplevel"])
  const branch = yield* readBranch(git, root)
  if (branch !== input.branch) {
    return yield* Effect.fail(
      new OperationError(
        "verify_warm_branch",
        `Warm worktree branch changed from ${input.branch} to ${branch ?? "a detached HEAD"}`,
      ),
    )
  }
  yield* run(git, root, "refresh_warm_branch", ["reset", "--hard", input.baseCommit])
  // A warm slot must become a copy of the new source, including deletions and
  // new omission decisions. Remove every old ignored/generated path as well as
  // untracked paths; the authoritative ignored seed is copied back afterward.
  yield* run(git, root, "clean_warm_worktree", ["clean", "-ffdx", "--", "."])
  const head = yield* read(git, root, "verify_warm_head", ["rev-parse", "--verify", "HEAD"])
  const tree = yield* read(git, root, "verify_warm_tree", ["rev-parse", "HEAD^{tree}"])
  if (head !== input.baseCommit) {
    return yield* Effect.fail(new OperationError("verify_warm_head", "Warm side did not reach the frozen base"))
  }
  return { worktree: root, branch, head, tree } satisfies WorktreeAttachment
})

/**
 * Refresh an isolated worktree without consulting the canonical repository's branch registry.
 * This is the safe path for detached contestants and repositories whose private worktree has
 * its own Git directory.
 */
export const refreshWorktree = Effect.fn("ArenaGit.refreshWorktree")(function* (input: {
  readonly worktree: string
  readonly baseCommit: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.worktree, "find_isolated_worktree", ["rev-parse", "--show-toplevel"])
  yield* run(git, root, "refresh_isolated_worktree", ["reset", "--hard", input.baseCommit])
  yield* run(git, root, "clean_isolated_worktree", ["clean", "-ffdx", "--", "."])
  const head = yield* read(git, root, "verify_isolated_head", ["rev-parse", "--verify", "HEAD"])
  const tree = yield* read(git, root, "verify_isolated_tree", ["rev-parse", "HEAD^{tree}"])
  if (head !== input.baseCommit) {
    return yield* Effect.fail(new OperationError("verify_isolated_head", "Isolated worktree did not reach base commit"))
  }
  const branch = yield* readBranch(git, root)
  return { worktree: root, ...(branch ? { branch } : {}), head, tree } satisfies WorktreeAttachment
})

/**
 * Check the frozen working tree out through the index, which then lists the snapshot's untracked
 * files as well. Git's own checkout replaces whatever untracked or ignored file, directory or
 * symlink stands where a snapshot path goes, never writes through a symlink, and removes the paths
 * the index held that the snapshot lacks; a patch applied instead refuses a path that already
 * exists, and an ignored copy of a file the snapshot un-ignores survives the clean before it.
 * Entries the checkout leaves unchanged keep their stat data, so only files that differ are
 * written. Submodules are never recursed into: a gitlink stays the empty directory
 * `git worktree add` leaves, whatever `submodule.recurse` says.
 */
function checkoutWorkingTree(git: Git.Interface, root: string, workingTree: string) {
  return run(git, root, "restore_contestant_worktree", [
    "read-tree",
    "--reset",
    "-u",
    "--no-recurse-submodules",
    workingTree,
  ])
}

/**
 * Replace the index with the frozen index tree and leave the files alone, which splits the checked
 * out working tree back into staged, unstaged and untracked paths. A one-tree read keeps the stat
 * data of every entry it does not change, so only the paths where the two trees disagree are
 * compared by content afterwards.
 */
function loadIndexTree(git: Git.Interface, root: string, indexTree: string) {
  return run(git, root, "restore_contestant_index", ["read-tree", "--reset", indexTree])
}

/** The first snapshot tree a restored contestant does not reproduce. */
function snapshotTreesMismatch(
  expected: { readonly indexTree: string; readonly workingTree: string },
  actual: { readonly indexTree: string; readonly workingTree: string },
) {
  if (actual.indexTree !== expected.indexTree) {
    return new OperationError("verify_contestant_index", "Contestant index does not match snapshot")
  }
  if (actual.workingTree !== expected.workingTree) {
    return new OperationError("verify_contestant_worktree", "Contestant worktree does not match snapshot")
  }
  return undefined
}

/**
 * Materialize a contestant's frozen starting state without changing its branch identity.
 * The frozen working tree is checked out first and the index tree loaded over it, which leaves
 * staged, unstaged, and nonignored-untracked paths represented separately.
 */
export const prepareContestantState = Effect.fn("ArenaGit.prepareContestantState")(function* (
  input: PrepareContestantStateInput,
) {
  const git = yield* Git.Service
  const root = yield* read(git, input.worktree, "find_contestant_worktree", ["rev-parse", "--show-toplevel"])
  const beforeBranch = yield* readBranch(git, root)
  const indexTree = yield* read(git, root, "verify_contestant_index_tree", ["rev-parse", `${input.indexTree}^{tree}`])
  const workingTree = yield* read(git, root, "verify_contestant_working_tree", ["rev-parse", `${input.workingTree}^{tree}`])
  yield* read(git, root, "verify_contestant_frozen_head", ["rev-parse", `${input.frozenHead}^{commit}`])

  yield* run(git, root, "reset_contestant_head", ["reset", "--hard", "--no-recurse-submodules", input.frozenHead])
  yield* checkoutWorkingTree(git, root, workingTree)
  // With the snapshot's untracked files in the index and its `.gitignore` files on disk.
  yield* run(git, root, "clean_contestant_worktree", ["clean", "-fd", "--", "."])
  if (indexTree !== workingTree) yield* loadIndexTree(git, root, indexTree)

  const head = yield* read(git, root, "verify_contestant_head", ["rev-parse", "--verify", "HEAD"])
  const afterBranch = yield* readBranch(git, root)
  if (head !== input.frozenHead) {
    return yield* Effect.fail(new OperationError("verify_contestant_head", "Contestant HEAD did not reach frozen HEAD"))
  }
  if (afterBranch !== beforeBranch) {
    return yield* Effect.fail(new OperationError("verify_contestant_branch", "Contestant branch identity changed"))
  }
  const afterIndexTree = yield* read(git, root, "verify_contestant_index", ["write-tree"])
  const afterWorkingTree = yield* readWorkingTree(git, root)
  const mismatch = snapshotTreesMismatch(
    { indexTree, workingTree },
    { indexTree: afterIndexTree, workingTree: afterWorkingTree },
  )
  if (mismatch) return yield* Effect.fail(mismatch)
  return {
    worktree: root,
    ...(afterBranch ? { branch: afterBranch } : {}),
    head,
    indexTree: afterIndexTree,
    workingTree: afterWorkingTree,
  } satisfies PreparedContestantState
})

const CONTESTANT_LOCATION = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir",
  "--git-path",
  "index",
]
const MAX_CLEAN_PASSES = 3
// The clean loop reads git's "Removing <path>" lines, which git would otherwise translate.
const MESSAGES_UNTRANSLATED = { LC_ALL: "C" }
const LAYOUT_READ_CONCURRENCY = 64

type ContestantProbe = {
  readonly root: string
  readonly gitDir: string
  readonly indexFile: string
  readonly frozenHead: string
  readonly headTree: string
  readonly indexTree: string
  readonly workingTree: string
  /** HEAD's commit. Absent when HEAD does not resolve, as on an unborn branch. */
  readonly head?: string
  /** The ref HEAD finally resolves to, or `HEAD` when it is detached. Absent with `head`. */
  readonly headRef?: string
}

function succeeded(result: Git.Result, operation: string) {
  if (result.exitCode === 0) return Effect.succeed(result.text())
  const detail = result.stderr.toString("utf8").trim() || output(result) || `git exited with ${result.exitCode}`
  return Effect.fail(new OperationError(operation, detail))
}

/**
 * Resolve a kept contestant worktree and the objects its frozen state names, and refuse to go on
 * unless git would operate on that worktree's own linked checkout. Callers reset, clean and delete
 * next. A worktree whose `.git` went missing resolves to whatever repository encloses it, and a
 * `.git` naming another worktree's admin directory would move that worktree's branch and rewrite
 * its index; the developer's canonical checkout is a candidate for both.
 */
const probeContestant = Effect.fn("ArenaGit.probeContestant")(function* (
  git: Git.Interface,
  input: VerifyContestantStateInput,
) {
  const objects = [
    `${input.indexTree}^{tree}`,
    `${input.workingTree}^{tree}`,
    `${input.frozenHead}^{commit}`,
    `${input.frozenHead}^{tree}`,
  ]
  // One process in the common case. rev-parse gives up at the first argument it cannot resolve,
  // and HEAD is the one a kept worktree can lack (an unborn branch), so a failure is repeated
  // without it: a missing object then fails with its own message, and an unresolved HEAD is left
  // to the caller, which rewrites or reports it.
  const combined = yield* git.run([...CONTESTANT_LOCATION, ...objects, "HEAD", "--symbolic-full-name", "HEAD"], {
    cwd: input.worktree,
  })
  const lines =
    combined.exitCode === 0
      ? output(combined).split(/\r?\n/)
      : [
          ...(yield* read(git, input.worktree, "find_contestant_worktree", CONTESTANT_LOCATION)).split(/\r?\n/),
          ...(yield* read(git, input.worktree, "verify_contestant_objects", ["rev-parse", ...objects])).split(/\r?\n/),
        ]
  const [root, gitDir, commonDir, indexFile, indexTree, workingTree, frozenHead, headTree, head, headRef] = lines
  if (!root || !gitDir || !commonDir || !indexFile || !indexTree || !workingTree || !frozenHead || !headTree) {
    return yield* Effect.fail(
      new OperationError("find_contestant_worktree", `Unexpected rev-parse output: ${lines.join(" ")}`),
    )
  }
  const expected = yield* Effect.promise(() => realpath(input.worktree).catch(() => resolve(input.worktree)))
  if (root !== expected) {
    return yield* Effect.fail(
      new OperationError("verify_contestant_location", `Contestant worktree ${expected} resolves to ${root}`),
    )
  }
  // The admin directory's `gitdir` names the worktree it belongs to; relative since
  // `worktree.useRelativePaths`.
  const registered = yield* Effect.promise(() =>
    readFile(join(gitDir, "gitdir"), "utf8")
      .then((text) => realpath(dirname(resolve(gitDir, text.trim()))))
      .catch(() => undefined),
  )
  if (basename(dirname(gitDir)) !== "worktrees" || dirname(dirname(gitDir)) !== commonDir || registered !== root) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_location",
        `Contestant worktree ${root} is not the linked worktree registered at ${gitDir}`,
      ),
    )
  }
  return {
    root,
    gitDir,
    indexFile,
    frozenHead,
    headTree,
    indexTree,
    workingTree,
    ...(head && headRef ? { head, headRef } : {}),
  } satisfies ContestantProbe
})

/**
 * The ref HEAD names directly, from `symbolic-ref --quiet --no-recurse HEAD`: `HEAD` itself when it
 * is detached (exit 1). A git without `--no-recurse` (exit 129) leaves only the ref HEAD finally
 * resolves to. Undefined when HEAD cannot be read at all.
 */
function firstHeadRef(attached: Git.Result, probe: ContestantProbe) {
  if (attached.exitCode === 0) return output(attached)
  if (attached.exitCode === 1) return "HEAD"
  if (attached.exitCode === 129) return probe.headRef
  return undefined
}

/** Whether a `clean` pass removed a `.gitignore`, which can turn a file it hid into an untracked one. */
function removedIgnoreFile(listing: string) {
  return listing.split(/\r?\n/).some((line) => {
    if (!line.startsWith("Removing ")) return false
    const printed = line.slice("Removing ".length)
    const path = printed.startsWith('"') && printed.endsWith('"') ? printed.slice(1, -1) : printed
    return !path.endsWith("/") && foldName(path.slice(path.lastIndexOf("/") + 1)) === ".gitignore"
  })
}

/**
 * Remove untracked, nonignored files, directories and nested repositories until none is left.
 * One pass is not always enough: `clean` reads an untracked `.gitignore` before removing it, so a
 * file that rule hid survives the pass as ignored and is untracked after it. Only a removed
 * `.gitignore` changes what the next pass sees, and the pass prints what it removed, so another
 * pass runs exactly when it can find something, without a dry run after every pass.
 */
const cleanUntracked = Effect.fn("ArenaGit.cleanUntracked")(function* (git: Git.Interface, root: string) {
  const options = { env: MESSAGES_UNTRANSLATED }
  for (let pass = 1; ; pass++) {
    const removed = yield* read(git, root, "clean_contestant_worktree", ["clean", "-ffd", "--", "."], options)
    if (!removedIgnoreFile(removed)) return pass
    if (pass < MAX_CLEAN_PASSES) continue
    const left = yield* read(git, root, "clean_contestant_worktree", ["clean", "-n", "-ffd", "--", "."], options)
    if (!left) return pass
    return yield* Effect.fail(
      new OperationError("clean_contestant_worktree", `Untracked files survived ${MAX_CLEAN_PASSES} passes:\n${left}`),
    )
  }
})

/** APFS matches names case- and normalization-insensitively; this is the key it matches on. */
function foldName(name: string) {
  return name.normalize("NFC").toLowerCase()
}

type TrackedLayout = {
  /** The names each directory holding snapshot paths must contain, by path ("" is the root). */
  readonly names: ReadonlyMap<string, ReadonlySet<string>>
  readonly gitlinks: ReadonlySet<string>
}

function trackedLayout(paths: Iterable<string>, gitlinks: Iterable<string>): TrackedLayout {
  const names = new Map<string, Set<string>>([["", new Set([".git"])]])
  for (const path of paths) {
    let child = path
    for (;;) {
      const slash = child.lastIndexOf("/")
      const parent = slash < 0 ? "" : child.slice(0, slash)
      const name = child.slice(slash + 1)
      const siblings = names.get(parent)
      // A name already recorded had its ancestors recorded with it.
      if (siblings?.has(name)) break
      if (siblings) siblings.add(name)
      else names.set(parent, new Set([name]))
      if (!parent) break
      child = parent
    }
  }
  return { names, gitlinks: new Set(gitlinks) }
}

/** `ls-tree -r -z` or `ls-files -s -z`, `-v` or not: the fields before the tab, and the path. */
function listedEntries(listing: string) {
  return listing.split("\0").flatMap((entry) => {
    const tab = entry.indexOf("\t")
    return tab < 0 ? [] : [{ fields: entry.slice(0, tab).split(" "), path: entry.slice(tab + 1) }]
  })
}

/** `ls-files -v -z`: the paths whose tag is not the plain cached `H`. */
function flaggedPaths(listing: string) {
  return listing.split("\0").flatMap((entry) => (entry && !entry.startsWith("H ") ? [entry.slice(2)] : []))
}

/** `missing` is an expected name with no entry at all; only sync acts on it. */
type LayoutFindingKind = "case" | "nested_git" | "gitlink" | "special" | "missing"

type LayoutFinding = {
  readonly kind: LayoutFindingKind
  readonly path: string
}

/** The layout checks in the order verification reports them. */
const LAYOUT_CHECKS: readonly {
  readonly kind: LayoutFindingKind
  readonly operation: string
  readonly message: string
}[] = [
  {
    kind: "case",
    operation: "verify_contestant_name_case",
    message: "Names differ from the snapshot only in case or Unicode normalization",
  },
  {
    kind: "nested_git",
    operation: "verify_contestant_nested_git",
    message: "Nested .git entries in tracked directories",
  },
  { kind: "gitlink", operation: "verify_contestant_gitlinks", message: "Gitlink directories are not empty" },
  {
    kind: "special",
    operation: "verify_contestant_special_files",
    message: "FIFOs, sockets or device nodes in tracked directories",
  },
]

function isMissingPath(cause: unknown) {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

async function sameEntry(left: string, right: string) {
  const [a, b] = await Promise.all([
    lstat(left, { bigint: true }),
    lstat(right, { bigint: true }).catch(() => undefined),
  ])
  return b !== undefined && a.ino === b.ino && a.dev === b.dev
}

/** Wait for every promise to settle, then throw the first failure. */
async function settleAll(promises: readonly Promise<unknown>[]) {
  const failed = (await Promise.allSettled(promises)).find((result) => result.status === "rejected")
  if (failed) throw failed.reason
}

/**
 * Visit `items` with at most `limit` visits in flight. The first failure aborts `stop`, so no item
 * starts after it and the visits still running give up before their next change, and the call
 * settles only once all of them have ended.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  stop: AbortController,
  visit: (item: T) => Promise<void>,
) {
  let next = 0
  const worker = async () => {
    while (next < items.length && !stop.signal.aborted) {
      await visit(items[next++]).catch((cause: unknown) => {
        stop.abort(cause)
        throw cause
      })
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
  stop.signal.throwIfAborted()
}

/**
 * Walk every directory that holds snapshot paths and find what git cannot see there, repairing it
 * when `repair` is set. With `core.ignoreCase` git treats `Src/A.txt` as `src/a.txt`, so a case-
 * or normalization-only rename survives reset and clean and passes both tree checks; it is renamed
 * back through a temporary name. `.git` is invisible to every git walk, so a nested repository or
 * gitfile inside a tracked directory would capture every git command run below it. Git never
 * populates a gitlink in a linked worktree, and it neither tracks nor cleans FIFOs, sockets and
 * device nodes. Directories are visited level by level, parents first, so a directory has its
 * exact name before anything inside it is touched, and only real directories are entered: a
 * symlink that replaced a tracked directory is never followed. Every change first checks that
 * `signal` has not aborted and that no other visit has failed.
 */
async function walkLayout(root: string, layout: TrackedLayout, repair: boolean, signal: AbortSignal) {
  const stop = new AbortController()
  const abort = () => stop.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  const change = () => stop.signal.throwIfAborted()
  const findings: LayoutFinding[] = []
  try {
    let level = [""]
    while (level.length > 0) {
      const next: string[] = []
      await forEachLimited(level, LAYOUT_READ_CONCURRENCY, stop, async (directory) => {
        const expected = layout.names.get(directory)
        if (!expected) return
        const absolute = directory ? join(root, directory) : root
        const entries = await readdir(absolute, { withFileTypes: true }).catch((cause: unknown) => {
          if (isMissingPath(cause)) return undefined
          throw cause
        })
        if (!entries) return
        const at = (name: string) => (directory ? `${directory}/${name}` : name)
        const present = new Set(entries.map((entry) => entry.name))
        const absent = new Map<string, string>()
        for (const name of expected) if (!present.has(name)) absent.set(foldName(name), name)
        for (const entry of entries) {
          let name = entry.name
          const exact = expected.has(name) ? undefined : absent.get(foldName(name))
          // Same inode under both names means the filesystem matched them; on a case-sensitive one
          // the two are different files and the extra one is not the snapshot's.
          if (exact !== undefined && (await sameEntry(join(absolute, name), join(absolute, exact)))) {
            findings.push({ kind: "case", path: at(exact) })
            if (repair) {
              const temporary = join(absolute, `.agent-duel-rename-${randomUUID()}`)
              change()
              await rename(join(absolute, name), temporary)
              change()
              await rename(temporary, join(absolute, exact))
            }
            absent.delete(foldName(name))
            name = exact
          }
          if (expected.has(name)) {
            if (!entry.isDirectory()) continue
            const path = at(name)
            if (layout.gitlinks.has(path)) {
              const contents = await readdir(join(absolute, name))
              if (contents.length === 0) continue
              findings.push({ kind: "gitlink", path })
              if (repair) {
                change()
                await settleAll(
                  contents.map((item) => rm(join(absolute, name, item), { recursive: true, force: true })),
                )
              }
            } else if (layout.names.has(path)) next.push(path)
            continue
          }
          if (foldName(name) === ".git") {
            findings.push({ kind: "nested_git", path: at(name) })
            if (repair) {
              change()
              await rm(join(absolute, name), { recursive: true, force: true })
            }
            continue
          }
          if (entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice()) {
            findings.push({ kind: "special", path: at(name) })
            if (repair) {
              change()
              await unlink(join(absolute, name))
            }
          }
        }
        for (const name of absent.values()) findings.push({ kind: "missing", path: at(name) })
      })
      level = next
    }
  } finally {
    signal.removeEventListener("abort", abort)
  }
  return findings
}

/**
 * The walk, with nothing of it outliving the effect. An interruption, as when a send supersedes a
 * warm sync, aborts the signal the walk checks before every change and then waits for it to settle:
 * the caller's fallback replaces the worktree, possibly at the same path, and must not race a
 * stray rename or delete.
 */
const reconcileLayout = Effect.fn("ArenaGit.reconcileLayout")(function* (
  root: string,
  layout: TrackedLayout,
  repair: boolean,
) {
  return yield* Effect.callback<LayoutFinding[], OperationError>((resume, signal) => {
    const walk = walkLayout(root, layout, repair, signal)
    walk.then(
      (findings) => resume(Effect.succeed(findings)),
      (cause: unknown) =>
        resume(
          Effect.fail(
            new OperationError(repair ? "repair_contestant_layout" : "verify_contestant_layout", String(cause)),
          ),
        ),
    )
    return Effect.promise(() =>
      walk.then(
        () => undefined,
        () => undefined,
      ),
    )
  })
})

function countFindings(findings: readonly LayoutFinding[], kind: LayoutFindingKind) {
  return findings.filter((finding) => finding.kind === kind).length
}

/** The layout of a frozen working tree, from `ls-tree -r -z` of it. */
function snapshotLayout(listing: string) {
  const entries = listedEntries(listing)
  return trackedLayout(
    entries.map((entry) => entry.path),
    entries.flatMap((entry) => (entry.fields[0] === "160000" ? [entry.path] : [])),
  )
}

/**
 * Bring a kept contestant worktree, in whatever state its previous occupant left it, to the exact
 * frozen starting state: HEAD and its branch identity (attached to `branch`, or detached), an index
 * equal to `indexTree` with no per-entry flags, `workingTree` on disk with exact names, and nothing
 * in a snapshot directory that git cannot see. Content the frozen `.gitignore` files ignore is left
 * alone; it belongs to the copy layer. The frozen objects must already be in the worktree's
 * repository. Run `verifyContestantState` after every other layer has touched the worktree.
 */
/**
 * Git with `core.ignoreStat` off. Under it git marks every index entry it writes assume-unchanged,
 * which hides an edited file from `status` and from verification, and verification refuses. The
 * contestant's own git still reads the checkout's setting.
 */
function trackingStat(git: Git.Interface): Git.Interface {
  return { ...git, run: (args, options) => git.run(args, { ...options, env: { ...STAT_TRACKED, ...options.env } }) }
}

/** The environment that turns `core.ignoreStat` off for one git command; see `trackingStat`. */
export const STAT_TRACKED = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.ignoreStat", GIT_CONFIG_VALUE_0: "false" }

export const syncContestantState = Effect.fn("ArenaGit.syncContestantState")(function* (
  input: SyncContestantStateInput,
) {
  const git = trackingStat(yield* Git.Service)
  // Read-only, and all needed before the first write. They may run in whatever repository encloses
  // a broken worktree, which the probe then refuses before anything is written.
  const [probe, flags, attached, snapshot] = yield* Effect.all(
    [
      probeContestant(git, input),
      git.run(["ls-files", "-v", "-z"], { cwd: input.worktree }),
      git.run(["symbolic-ref", "--quiet", "--no-recurse", "HEAD"], { cwd: input.worktree }),
      git.run(["ls-tree", "-r", "-z", input.workingTree], { cwd: input.worktree }),
    ],
    { concurrency: "unbounded" },
  )
  const root = probe.root
  const layout = snapshotLayout(yield* succeeded(snapshot, "read_snapshot_working_tree"))

  // Unpacking a tree keeps an index entry whose object id is unchanged, flags and all, so a
  // skip-worktree or assume-unchanged bit the previous occupant set would survive every step below
  // and hide a missing or edited file from git and from verification alike. Only a new index clears
  // them (`update-index` given both flags applies one). An index that does not load is rebuilt the
  // same way. The new index carries no stat data, so the reset rewrites every tracked file.
  const indexRebuilt = input.forceCheckout === true || flags.exitCode !== 0 || flaggedPaths(flags.text()).length > 0
  if (indexRebuilt) {
    yield* Effect.tryPromise({
      try: () => rm(probe.indexFile, { force: true }),
      catch: (cause) => new OperationError("rebuild_contestant_index", String(cause)),
    })
    yield* run(git, root, "rebuild_contestant_index", ["read-tree", probe.frozenHead])
  }

  // The ref HEAD names directly and the ref it resolves to must both be the branch: HEAD pointing
  // at a symbolic ref that points at the branch resolves the same way and is another checkout.
  const expectedRef = input.branch === undefined ? "HEAD" : `refs/heads/${input.branch}`
  if (firstHeadRef(attached, probe) !== expectedRef || probe.headRef !== expectedRef) {
    if (input.branch === undefined) {
      yield* run(git, root, "detach_contestant_head", ["update-ref", "--no-deref", "HEAD", probe.frozenHead])
    } else {
      yield* run(git, root, "validate_contestant_branch", ["check-ref-format", expectedRef])
      // --no-deref replaces a branch that is itself a symbolic ref instead of moving its target.
      yield* run(git, root, "write_contestant_branch", ["update-ref", "--no-deref", expectedRef, probe.frozenHead])
      yield* run(git, root, "attach_contestant_head", ["symbolic-ref", "HEAD", expectedRef])
    }
  }

  yield* run(git, root, "reset_contestant_head", ["reset", "--hard", "--no-recurse-submodules", "-q", probe.frozenHead])
  // The frozen working tree goes on disk before the clean, which runs with it as the index: the
  // clean then reads the frozen `.gitignore` files and removes exactly what is untracked and not
  // ignored under them, keeping the snapshot's own untracked files and whatever the frozen rules
  // ignore. Cleaning under HEAD's rules instead would keep an ignored copy of a file the snapshot
  // un-ignores and delete content only the snapshot's rules ignore.
  if (probe.workingTree !== probe.headTree) yield* checkoutWorkingTree(git, root, probe.workingTree)
  const cleanPasses = yield* cleanUntracked(git, root)
  if (probe.indexTree !== probe.workingTree) yield* loadIndexTree(git, root, probe.indexTree)

  const findings = yield* reconcileLayout(root, layout, true)
  // The reset and the checkout trust stat data they read through a symlink that replaced a tracked
  // directory, and the clean then removes that symlink as untracked, so a snapshot path can be
  // missing here. Checking the working tree out again writes every missing path.
  if (findings.some((finding) => finding.kind === "missing")) {
    yield* checkoutWorkingTree(git, root, probe.workingTree)
    if (probe.indexTree !== probe.workingTree) yield* loadIndexTree(git, root, probe.indexTree)
    findings.push(...(yield* reconcileLayout(root, layout, true)))
  }
  return {
    worktree: root,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    head: probe.frozenHead,
    indexRebuilt,
    cleanPasses,
    caseFixes: countFindings(findings, "case"),
    nestedGitRemoved: countFindings(findings, "nested_git"),
    gitlinksEmptied: countFindings(findings, "gitlink"),
    specialFilesRemoved: countFindings(findings, "special"),
  } satisfies SyncedContestantState
})

/**
 * Check that a contestant worktree is in the exact frozen starting state `syncContestantState`
 * produces, and that its host holds nothing a fresh host would not: no second worktree, no Arena
 * private refs. Fails with an `OperationError` whose operation names the first check that does not
 * hold. It changes no file and no ref; like any `write-tree` and `add`, it may write objects and
 * refresh the index's cached tree.
 */
export const verifyContestantState = Effect.fn("ArenaGit.verifyContestantState")(function* (
  input: VerifyContestantStateInput,
) {
  const git = yield* Git.Service
  const probe = yield* probeContestant(git, input)
  const root = probe.root
  // Independent reads, run together and judged afterwards in a fixed order, so the error still
  // names the first failing check.
  const [attached, listing, frozenIndex, snapshot, indexTree, workingTree, worktrees, privateRefs, privateDirectory] =
    yield* Effect.all(
      [
        git.run(["symbolic-ref", "--quiet", "--no-recurse", "HEAD"], { cwd: root }),
        git.run(["ls-files", "-v", "-s", "-z"], { cwd: root }),
        git.run(["ls-tree", "-r", "-z", "--name-only", probe.indexTree], { cwd: root }),
        git.run(["ls-tree", "-r", "-z", probe.workingTree], { cwd: root }),
        Effect.exit(read(git, root, "verify_contestant_index", ["write-tree"])),
        Effect.exit(readWorkingTreeState(git, root, probe.gitDir)),
        git.run(["worktree", "list", "--porcelain"], { cwd: root }),
        git.run(["for-each-ref", "--format=%(refname)", ...MIRROR_EXCLUDED_PREFIXES], { cwd: root }),
        Effect.promise(() =>
          lstat(join(root, ".agent-duel"))
            .then(() => true)
            .catch(() => false),
        ),
      ],
      { concurrency: "unbounded" },
    )

  if (probe.head !== probe.frozenHead) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_head",
        `Contestant HEAD is ${probe.head ?? "unresolved"}, not the frozen HEAD ${probe.frozenHead}`,
      ),
    )
  }
  // The first hop and the final ref both have to be the branch: HEAD pointing at a symbolic ref
  // that points at the branch resolves the same way and is still a different checkout.
  const firstRef = firstHeadRef(attached, probe)
  if (firstRef === undefined) {
    const detail = attached.stderr.toString("utf8").trim() || "Failed to read the contestant HEAD"
    return yield* Effect.fail(new OperationError("verify_contestant_branch", detail))
  }
  const expectedRef = input.branch === undefined ? "HEAD" : `refs/heads/${input.branch}`
  if (firstRef !== expectedRef || probe.headRef !== expectedRef) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_branch",
        `Contestant HEAD is ${firstRef} (resolving to ${probe.headRef}), not ${expectedRef}`,
      ),
    )
  }
  const entries = listedEntries(yield* succeeded(listing, "verify_contestant_index_flags"))
  const flagged = entries.flatMap((entry) => (entry.fields[0] === "H" ? [] : [entry.path]))
  if (flagged.length > 0) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_index_flags",
        `Index entries are flagged or unmerged: ${flagged.slice(0, 20).join(", ")}`,
        flagged,
      ),
    )
  }
  // `write-tree` leaves intent-to-add entries out, so an index holding one next to the frozen
  // entries still writes the frozen tree, while `git status` lists the path as added.
  const frozenPaths = new Set((yield* succeeded(frozenIndex, "verify_contestant_index")).split("\0"))
  const extra = entries.flatMap((entry) => (frozenPaths.has(entry.path) ? [] : [entry.path]))
  if (extra.length > 0) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_index",
        `Index entries the snapshot index lacks: ${extra.slice(0, 20).join(", ")}`,
        extra,
      ),
    )
  }
  const actualIndexTree = yield* indexTree
  const working = yield* workingTree
  const mismatch = snapshotTreesMismatch(
    { indexTree: probe.indexTree, workingTree: probe.workingTree },
    { indexTree: actualIndexTree, workingTree: working.tree },
  )
  if (mismatch) return yield* Effect.fail(mismatch)
  // The working-tree snapshot leaves untracked nested repositories out, so the tree check above
  // passes over one; `clean -ff` removes them in sync.
  if (working.nestedRepositories.length > 0) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_nested_repos",
        `Untracked nested repositories: ${working.nestedRepositories.join(", ")}`,
        working.nestedRepositories,
      ),
    )
  }

  const layout = snapshotLayout(yield* succeeded(snapshot, "read_snapshot_working_tree"))
  const findings = yield* reconcileLayout(root, layout, false)
  for (const check of LAYOUT_CHECKS) {
    const paths = findings.flatMap((finding) => (finding.kind === check.kind ? [finding.path] : [])).sort()
    if (paths.length === 0) continue
    return yield* Effect.fail(
      new OperationError(check.operation, `${check.message}: ${paths.slice(0, 20).join(", ")}`, paths),
    )
  }
  if (privateDirectory) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_private_dir",
        `${join(root, ".agent-duel")} exists in the contestant worktree`,
      ),
    )
  }
  const registered = parseWorktrees(yield* succeeded(worktrees, "verify_contestant_host_worktrees"))
  const [main, only] = registered
  const linked = only ? yield* Effect.promise(() => realpath(only.path).catch(() => only.path)) : undefined
  if (registered.length !== 2 || !main?.bare || linked !== root) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_host_worktrees",
        `The contestant host must hold only its bare repository and ${root}; it lists ${registered.map((item) => item.path).join(", ")}`,
      ),
    )
  }
  const refs = (yield* succeeded(privateRefs, "verify_contestant_host_refs")).split(/\r?\n/).filter(Boolean)
  if (refs.length > 0) {
    return yield* Effect.fail(
      new OperationError(
        "verify_contestant_host_refs",
        `The contestant host holds Arena refs: ${refs.join(", ")}`,
        refs,
      ),
    )
  }
  return {
    worktree: root,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    head: probe.frozenHead,
  } satisfies VerifiedContestantState
})

export const inspectWorktree = Effect.fn("ArenaGit.inspectWorktree")(function* (worktree: string) {
  const git = yield* Git.Service
  const root = yield* read(git, worktree, "find_worktree", ["rev-parse", "--show-toplevel"])
  const head = yield* read(git, root, "read_worktree_head", ["rev-parse", "--verify", "HEAD"])
  return {
    worktree: root,
    branch: yield* readBranch(git, root),
    head,
    tree: yield* read(git, root, "read_worktree_tree", ["rev-parse", "HEAD^{tree}"]),
  } satisfies WorktreeAttachment
})

/** Pin the selected result without conflating it with the merged canonical working tree. */
export const selectResult = Effect.fn("ArenaGit.selectResult")(function* (input: {
  readonly canonical: string
  readonly selectedRef: string
  readonly resultCommit: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_repository_root", ["rev-parse", "--show-toplevel"])
  yield* preserveRef(git, root, input.selectedRef, input.resultCommit)
  return input.resultCommit
})

/**
 * Seed the scratch index the working-tree snapshot is staged into.
 *
 * A copy of the checkout's own index, because `git add -A` re-hashes every file whose
 * index entry does not carry matching stat data — and `read-tree HEAD` writes entries with
 * no stat data at all, so it re-hashes the entire checkout. On a 5,700-file repository that
 * is 1.2s against 0.09s, and a snapshot is read twice per applied result. The copy is a
 * plain read of a file git only ever replaces by rename, so it is either the index before
 * or the index after a concurrent write, never half of one.
 *
 * Falls back to `read-tree HEAD` when there is no index to copy or it will not load. The
 * two seeds agree on the tree `add -A` leaves behind: it stages every non-ignored path in
 * the working tree and drops the entries for paths that are gone. They part company only
 * over `assume-unchanged` and `skip-worktree` entries, which the copy honours and the HEAD
 * seed silently overwrites.
 *
 * Reading the gitlinks back out of the seeded index doubles as the check that git can load
 * it, so the copy costs no more subprocesses than the `read-tree` it replaces. They are the
 * checkout's own gitlinks either way: the copy is the checkout's own index.
 */
const seedSnapshotIndex = Effect.fnUntraced(function* (
  git: Git.Interface,
  root: string,
  index: string,
  knownGitDir?: string,
) {
  const env = { GIT_INDEX_FILE: index }
  const gitDir = knownGitDir ?? (yield* read(git, root, "find_canonical_git_dir", ["rev-parse", "--absolute-git-dir"]))
  const copied = yield* Effect.tryPromise({
    try: () => copyFile(join(gitDir, "index"), index),
    catch: (cause) => new OperationError("copy_canonical_index", String(cause)),
  }).pipe(
    Effect.andThen(run(git, root, "read_canonical_gitlinks", ["ls-files", "--stage", "-z"], { env })),
    Effect.map((listed) => gitlinks(listed.text())),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (copied) return copied
  const canonical = gitlinks((yield* run(git, root, "read_canonical_gitlinks", ["ls-files", "--stage", "-z"])).text())
  // A copy that failed partway leaves bytes `read-tree` would refuse to load over.
  yield* Effect.promise(() => unlink(index).catch(() => undefined))
  yield* run(git, root, "initialize_snapshot_index", ["read-tree", "HEAD"], { env })
  return canonical
})

/**
 * The working tree as a tree object, and the untracked nested repositories it leaves out: `add -A`
 * stages one as a gitlink, which a snapshot must not carry.
 */
const readWorkingTreeState = Effect.fn("ArenaGit.readWorkingTreeState")(function* (
  git: Git.Interface,
  root: string,
  gitDir?: string,
) {
  const index = join(tmpdir(), `opencode-arena-index-${randomUUID()}`)
  return yield* Effect.gen(function* () {
    const env = { GIT_INDEX_FILE: index }
    const canonicalGitlinks = yield* seedSnapshotIndex(git, root, index, gitDir)
    yield* run(git, root, "stage_snapshot", ["add", "-A", "--", "."], { env })
    const snapshotGitlinks = gitlinks(
      (yield* run(git, root, "read_snapshot_gitlinks", ["ls-files", "--stage", "-z"], { env })).text(),
    )
    const nestedRepositories = Array.from(snapshotGitlinks).filter((path) => !canonicalGitlinks.has(path))
    yield* Effect.forEach(
      nestedRepositories,
      (path) =>
        run(git, root, "exclude_untracked_gitlink", ["rm", "--cached", "--force", "--ignore-unmatch", "--", path], {
          env,
        }),
      { discard: true },
    )
    const tree = yield* read(git, root, "write_snapshot_tree", ["write-tree"], { env })
    return { tree, nestedRepositories }
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        Promise.all([unlink(index).catch(() => undefined), unlink(`${index}.lock`).catch(() => undefined)]),
      ),
    ),
  )
})

const readWorkingTree = Effect.fn("ArenaGit.readWorkingTree")(function* (git: Git.Interface, root: string) {
  return (yield* readWorkingTreeState(git, root)).tree
})

/** List ignored setup output as collapsed copy roots for the second contestant. */
export const ignoredPaths = Effect.fn("ArenaGit.ignoredPaths")(function* (directory: string) {
  const git = yield* Git.Service
  const listed = yield* read(git, directory, "list_ignored", [...IGNORED_PATHS_COMMAND])
  return parseIgnoredPaths(listed)
})

export const snapshotBase = Effect.fn("ArenaGit.snapshotBase")(function* (input: SnapshotBaseInput) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_canonical_root", ["rev-parse", "--show-toplevel"])
  const commonGitDir = yield* read(git, root, "read_common_git_dir", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
  const trunkConflicts = yield* conflictPaths(git, root)
  if (trunkConflicts.length > 0) {
    return yield* Effect.fail(
      new OperationError(
        TRUNK_CONFLICT_OPERATION,
        `Unresolved merge conflicts: ${trunkConflicts.join(", ")}`,
        trunkConflicts,
      ),
    )
  }
  const canonicalHead = yield* read(git, root, "read_canonical_head", ["rev-parse", "--verify", "HEAD"])
  const branch = yield* readBranch(git, root)
  const status = yield* read(git, root, "read_canonical_status", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])
  const indexTree = yield* readIndexTree(git, root, "read_canonical_index")
  const baseTree = status
    ? yield* readWorkingTree(git, root)
    : yield* read(git, root, "read_head_tree", ["rev-parse", `${canonicalHead}^{tree}`])
  if (!status) {
    if (input.permanentRef) yield* preserveRef(git, root, input.permanentRef, canonicalHead)
    return {
      root,
      commonGitDir,
      canonicalHead,
      frozenHead: canonicalHead,
      branch,
      clean: true,
      baseCommit: canonicalHead,
      baseTree,
      indexTree,
      ...(input.permanentRef ? { permanentRef: input.permanentRef } : {}),
    } satisfies SnapshotBase
  }

  const baseCommit = yield* read(
    git,
    root,
    "create_snapshot_commit",
    ["commit-tree", baseTree, "-p", canonicalHead, "-m", "Arena base snapshot"],
    {
      env: {
        GIT_AUTHOR_NAME: "OpenCode Arena",
        GIT_AUTHOR_EMAIL: "arena@localhost",
        GIT_AUTHOR_DATE: wrapperDate,
        GIT_COMMITTER_NAME: "OpenCode Arena",
        GIT_COMMITTER_EMAIL: "arena@localhost",
        GIT_COMMITTER_DATE: wrapperDate,
      },
    },
  )
  if (input.permanentRef) yield* preserveRef(git, root, input.permanentRef, baseCommit)
  return {
    root,
    commonGitDir,
    canonicalHead,
    frozenHead: canonicalHead,
    branch,
    clean: false,
    baseCommit,
    baseTree,
    indexTree,
    ...(input.permanentRef ? { permanentRef: input.permanentRef } : {}),
  } satisfies SnapshotBase
})

export const reanchor = Effect.fn("ArenaGit.reanchor")(function* (input: ReanchorInput) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_canonical_root", ["rev-parse", "--show-toplevel"])
  const tree = yield* read(git, root, "read_reanchored_tree", ["rev-parse", `${input.resultCommit}^{tree}`])
  const commit = yield* read(
    git,
    root,
    "create_reanchored_commit",
    ["commit-tree", tree, "-p", input.baseCommit, "-m", "Arena result"],
    {
      env: {
        GIT_AUTHOR_NAME: "OpenCode Arena",
        GIT_AUTHOR_EMAIL: "arena@localhost",
        GIT_AUTHOR_DATE: wrapperDate,
        GIT_COMMITTER_NAME: "OpenCode Arena",
        GIT_COMMITTER_EMAIL: "arena@localhost",
        GIT_COMMITTER_DATE: wrapperDate,
      },
    },
  )
  yield* preserveRef(git, root, input.permanentRef, commit)
  return commit
})

export const finalize = Effect.fn("ArenaGit.finalize")(function* (input: FinalizeInput) {
  const git = yield* Git.Service
  const root = yield* read(git, input.worktree, "find_worktree_root", ["rev-parse", "--show-toplevel"])
  const rawHead = yield* read(git, root, "read_raw_head", ["rev-parse", "--verify", "HEAD"])
  const branchResult = yield* git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })
  const branch = branchResult.exitCode === 0 ? output(branchResult) || undefined : undefined
  const statusBefore = yield* read(git, root, "read_status_before", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])

  // Capture the contestant's real index before reading the complete working tree. The
  // latter uses a temporary index and therefore does not disturb the staged/unstaged
  // presentation that remains visible in the retained contestant worktree.
  const finalIndexTree = yield* read(git, root, "read_final_index", ["write-tree"])
  const finalTree = yield* readWorkingTree(git, root)
  const rawTree = yield* read(git, root, "read_raw_tree", ["rev-parse", `${rawHead}^{tree}`])
  const frozenHead = input.frozenHead ?? input.baseSHA
  const rawHeadDescendsFromBase = yield* isAncestor(git, root, frozenHead, rawHead)
  const agentCommits = yield* readCommitChain(git, root, frozenHead, rawHead)
  const wrapperCreated = finalTree !== rawTree || !rawHeadDescendsFromBase
  const finalCommit = wrapperCreated
    ? yield* read(
        git,
        root,
        "create_wrapper_commit",
        ["commit-tree", finalTree, "-p", rawHeadDescendsFromBase ? rawHead : input.baseSHA, "-m", "Arena result"],
        {
          env: {
            GIT_AUTHOR_NAME: "OpenCode Arena",
            GIT_AUTHOR_EMAIL: "arena@localhost",
            GIT_AUTHOR_DATE: wrapperDate,
            GIT_COMMITTER_NAME: "OpenCode Arena",
            GIT_COMMITTER_EMAIL: "arena@localhost",
            GIT_COMMITTER_DATE: wrapperDate,
          },
        },
      )
    : rawHead

  if (input.expectedPermanentCommit) {
    yield* advanceRef(git, root, input.permanentRef, finalCommit, input.expectedPermanentCommit)
  } else {
    yield* preserveRef(git, root, input.permanentRef, finalCommit)
  }
  const finalIndexRef = `${input.permanentRef}-index`
  if (input.expectedFinalIndexTree) {
    yield* advanceRef(git, root, finalIndexRef, finalIndexTree, input.expectedFinalIndexTree)
  } else {
    yield* preserveRef(git, root, finalIndexRef, finalIndexTree)
  }
  // Applicability is about the frozen canonical history, never the synthetic dirty-tree
  // evidence commit used to render a comparison.
  const baseIsAncestor = yield* isAncestor(git, root, frozenHead, rawHead)
  const stats = yield* read(git, root, "read_diff_stats", [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--numstat",
    input.baseSHA,
    finalCommit,
    "--",
    ".",
  ])
  const statusAfter = yield* read(git, root, "read_status_after", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])
  const fullyCommitted = statusBefore.length === 0
  const agentCommit = agentCommits.at(-1)

  return {
    rawHead,
    ...(branch ? { branch } : {}),
    statusBefore,
    statusAfter,
    wrapperCreated,
    finalCommit,
    finalTree,
    ...(agentCommit ? { agentCommit } : {}),
    agentCommits,
    commitChain: agentCommits,
    finalIndexTree,
    finalIndexRef,
    fullyCommitted,
    baseIsAncestor,
    permanentRef: input.permanentRef,
    diff: parseStats(stats),
  } satisfies FinalizedResult
})

export const applyFastForward = Effect.fn("ArenaGit.applyFastForward")(function* (input: ApplyInput) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_canonical_root", ["rev-parse", "--show-toplevel"])
  const previousHead = yield* read(git, root, "read_canonical_head", ["rev-parse", "--verify", "HEAD"])
  if (previousHead !== input.expectedBaseSHA) {
    return yield* Effect.fail(
      new OperationError(
        "verify_canonical_head",
        `Canonical HEAD changed from ${input.expectedBaseSHA} to ${previousHead}`,
      ),
    )
  }

  const status = yield* read(git, root, "read_canonical_status", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])
  if (status) {
    return yield* Effect.fail(new OperationError("verify_canonical_status", "Canonical checkout has local changes"))
  }

  const branch = yield* readBranch(git, root)
  if (branch !== input.expectedBranch) {
    return yield* Effect.fail(
      new OperationError(
        "verify_canonical_branch",
        `Canonical branch changed from ${input.expectedBranch ?? "a detached HEAD"} to ${branch ?? "a detached HEAD"}`,
      ),
    )
  }
  if (!(yield* isAncestor(git, root, input.expectedBaseSHA, input.resultCommit))) {
    return yield* Effect.fail(
      new OperationError("verify_result_ancestry", "Contestant result does not descend from base"),
    )
  }
  if (input.selectedRef) yield* preserveRef(git, root, input.selectedRef, input.resultCommit)

  yield* run(git, root, "apply_fast_forward", ["merge", "--ff-only", "--no-edit", input.resultCommit])
  const resultingHead = yield* read(git, root, "verify_applied_head", ["rev-parse", "--verify", "HEAD"])
  if (resultingHead !== input.resultCommit) {
    return yield* Effect.fail(new OperationError("verify_applied_head", "Fast-forward did not reach contestant result"))
  }

  return { previousHead, resultingHead, branch } satisfies ApplyResult
})

export const applySnapshot = Effect.fn("ArenaGit.applySnapshot")(function* (input: ApplySnapshotInput) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_canonical_root", ["rev-parse", "--show-toplevel"])
  const previousHead = yield* read(git, root, "read_canonical_head", ["rev-parse", "--verify", "HEAD"])
  const branch = yield* readBranch(git, root)
  if (!(yield* isAncestor(git, root, input.expectedBaseCommit, input.resultCommit))) {
    return yield* Effect.fail(
      new OperationError("verify_result_ancestry", "Contestant result does not descend from snapshot base"),
    )
  }
  if (input.selectedRef) yield* preserveRef(git, root, input.selectedRef, input.resultCommit)

  const indexTree = yield* readIndexTree(git, root, "read_canonical_index")
  const currentTree = yield* readWorkingTree(git, root)
  const resultTree = yield* read(git, root, "read_result_tree", ["rev-parse", `${input.resultCommit}^{tree}`])
  if (currentTree === resultTree) return { previousHead, resultingHead: previousHead, branch } satisfies ApplyResult
  const merged =
    currentTree === input.expectedBaseTree
      ? { tree: resultTree, conflicts: [] as string[] }
      : yield* mergeIntoWorkingTree(git, root, {
          baseCommit: input.expectedBaseCommit,
          currentTree,
          resultCommit: input.resultCommit,
          parent: previousHead,
        })

  const patch = yield* run(git, root, "read_snapshot_result_patch", patchArgs(currentTree, merged.tree), {
    maxOutputBytes: 100 * 1024 * 1024,
  })
  if (patch.truncated) {
    return yield* Effect.fail(new OperationError("read_snapshot_result_patch", "Selected result patch is too large"))
  }
  if (patch.stdout.length > 0) {
    yield* run(git, root, "apply_snapshot_result", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      stdin: Stream.make(new TextEncoder().encode(patch.text())),
    })
  }
  const appliedTree = yield* readWorkingTree(git, root)
  if (appliedTree !== merged.tree) {
    return yield* Effect.fail(
      new OperationError("verify_applied_snapshot", "Applied working tree does not match the selected result"),
    )
  }
  const resultingIndex = yield* readIndexTree(git, root, "verify_canonical_index")
  if (resultingIndex !== indexTree) {
    return yield* Effect.fail(
      new OperationError("verify_canonical_index", "Applying the selected result changed the canonical index"),
    )
  }
  return {
    previousHead,
    resultingHead: previousHead,
    branch,
    ...(merged.conflicts.length > 0 ? { conflicts: merged.conflicts } : {}),
  } satisfies ApplyResult
})

const mergeIntoWorkingTree = Effect.fn("ArenaGit.mergeIntoWorkingTree")(function* (
  git: Git.Interface,
  root: string,
  input: { readonly baseCommit: string; readonly currentTree: string; readonly resultCommit: string; readonly parent: string },
) {
  const currentCommit = yield* read(
    git,
    root,
    "create_current_commit",
    ["commit-tree", input.currentTree, "-p", input.parent, "-m", "Arena canonical snapshot"],
    {
      env: {
        GIT_AUTHOR_NAME: "OpenCode Arena",
        GIT_AUTHOR_EMAIL: "arena@localhost",
        GIT_AUTHOR_DATE: wrapperDate,
        GIT_COMMITTER_NAME: "OpenCode Arena",
        GIT_COMMITTER_EMAIL: "arena@localhost",
        GIT_COMMITTER_DATE: wrapperDate,
      },
    },
  )
  const result = yield* git.run(
    ["merge-tree", "--write-tree", `--merge-base=${input.baseCommit}`, currentCommit, input.resultCommit],
    { cwd: root, maxOutputBytes: 16 * 1024 * 1024 },
  )
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail = result.stderr.toString("utf8").trim() || "git merge-tree failed"
    return yield* Effect.fail(new OperationError("merge_result_into_canonical", detail))
  }
  const [tree, ...rest] = output(result).split(/\r?\n/)
  if (!tree) {
    return yield* Effect.fail(
      new OperationError("merge_result_into_canonical", "git merge-tree returned no merged tree"),
    )
  }
  return { tree, conflicts: result.exitCode === 0 ? [] : conflictedPaths(rest) }
})

function conflictedPaths(lines: readonly string[]): string[] {
  const paths = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) break
    const path = line.split("\t").slice(1).join("\t").trim()
    if (path) paths.add(path)
  }
  return [...paths]
}

export const repositoryKey = Effect.fn("ArenaGit.repositoryKey")(function* (directory: string) {
  const git = yield* Git.Service
  return yield* read(git, directory, "read_common_git_dir", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
})

/** Check repository lineage without requiring the commit to be reachable from a branch. */
export const containsCommit = Effect.fn("ArenaGit.containsCommit")(function* (input: {
  readonly repository: string
  readonly commit: string
}) {
  const git = yield* Git.Service
  const result = yield* git.run(["cat-file", "-e", `${input.commit}^{commit}`], { cwd: input.repository })
  return result.exitCode === 0
})

/** Return Git's primary checkout path, repairing stale worktree registrations first. */
export const repositoryOwner = Effect.fn("ArenaGit.repositoryOwner")(function* (directory: string) {
  const git = yield* Git.Service
  const root = yield* read(git, directory, "find_repository_root", ["rev-parse", "--show-toplevel"])
  yield* run(git, root, "repair_repository_worktrees", ["worktree", "repair"])
  const worktrees = yield* inspectWorktrees(git, root)
  const owner = worktrees[0]?.path
  if (!owner) return yield* Effect.fail(new OperationError("read_repository_owner", "Git returned no worktrees"))
  return owner
})

/**
 * The canonical checkout's branch and nothing else, for the stream poll: a full inspection runs
 * six git commands, and asking every second what the developer has checked out must cost one.
 */
export const readCanonicalBranch = Effect.fn("ArenaGit.readCanonicalBranch")(function* (root: string) {
  const git = yield* Git.Service
  return yield* readBranch(git, root)
})

export const inspectCanonical = Effect.fn("ArenaGit.inspectCanonical")(function* (directory: string) {
  const git = yield* Git.Service
  const root = yield* read(git, directory, "find_canonical_root", ["rev-parse", "--show-toplevel"])
  const commonGitDir = yield* read(git, root, "read_common_git_dir", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
  const head = yield* read(git, root, "read_canonical_head", ["rev-parse", "--verify", "HEAD"])
  const branch = yield* readBranch(git, root)
  const status = yield* read(git, root, "read_canonical_status", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])
  const conflicts = yield* conflictPaths(git, root)
  return {
    root,
    commonGitDir,
    head,
    branch,
    detached: branch === undefined,
    ...(conflicts.length > 0 ? {} : { indexTree: yield* readIndexTree(git, root, "read_canonical_index") }),
    conflicts,
    clean: status.length === 0,
  } satisfies CanonicalState
})

const conflictPaths = Effect.fn("ArenaGit.conflictPaths")(function* (git: Git.Interface, root: string) {
  const files = yield* read(git, root, "read_conflicts", ["diff", "--name-only", "--diff-filter=U"])
  return files.split(/\r?\n/).filter(Boolean)
})

/** Read the checkout's standard unmerged paths without changing its Git state. */
export const inspectConflicts = Effect.fn("ArenaGit.inspectConflicts")(function* (canonical: string) {
  const git = yield* Git.Service
  const root = yield* read(git, canonical, "find_conflict_root", ["rev-parse", "--show-toplevel"])
  return yield* conflictPaths(git, root)
})

/** A replayed winner commit is not applied until Git's cherry-pick has been continued. */
export const hasCherryPickInProgress = Effect.fn("ArenaGit.hasCherryPickInProgress")(function* (canonical: string) {
  const git = yield* Git.Service
  const root = yield* read(git, canonical, "find_cherry_pick_root", ["rev-parse", "--show-toplevel"])
  const result = yield* git.run(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], { cwd: root })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  const detail = result.stderr.toString("utf8").trim() || "Failed to inspect cherry-pick state"
  return yield* Effect.fail(new OperationError("inspect_cherry_pick", detail))
})

/**
 * The Git operation the checkout is part way through, if any. A promotion writes HEAD, the index,
 * and the files, so it waits until the developer finishes or aborts a merge, rebase, cherry-pick,
 * or revert rather than writing under it.
 */
export const repositoryOperation = Effect.fn("ArenaGit.repositoryOperation")(function* (canonical: string) {
  const git = yield* Git.Service
  const root = yield* read(git, canonical, "find_operation_root", ["rev-parse", "--show-toplevel"])
  for (const [path, operation] of [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ] as const) {
    const location = yield* read(git, root, "locate_operation_state", ["rev-parse", "--git-path", path])
    const present = yield* Effect.promise(() =>
      lstat(resolve(root, location)).then(
        () => true,
        () => false,
      ),
    )
    if (present) return operation
  }
  return undefined
})

/** Keep conflict markers as ordinary dirty files so a completed turn never blocks later work. */
/**
 * Which of a promotion's conflicted paths still carry markers.
 *
 * The promotion writes its whole result in one step, so a conflicted path ends as an ordinary
 * dirty file: the index entry is HEAD's, nothing is unmerged, and no sequencer is left open.
 * `git diff --diff-filter=U` therefore cannot tell a checkout someone has resolved from one
 * nobody has touched. The markers can, and they are the only durable record of the work left,
 * so they are what the parked turn waits on.
 *
 * A path that is gone was resolved by deleting it, which is an answer like any other.
 */
export const unresolvedConflictPaths = Effect.fn("ArenaGit.unresolvedConflictPaths")(function* (input: {
  readonly canonical: string
  readonly paths: readonly string[]
}) {
  if (input.paths.length === 0) return [] as readonly string[]
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_conflict_marker_root", ["rev-parse", "--show-toplevel"])
  const unresolved = yield* Effect.forEach(
    input.paths,
    (path) =>
      Effect.tryPromise({
        try: async () => {
          const content = await readFile(join(root, path), "utf8").catch(() => null)
          if (content === null) return null
          return /^<<<<<<< /m.test(content) && /^>>>>>>> /m.test(content) ? path : null
        },
        catch: (cause) =>
          new OperationError("inspect_conflict_markers", cause instanceof Error ? cause.message : String(cause)),
      }),
    { concurrency: 8 },
  )
  return unresolved.filter((path): path is string => path !== null)
})

export const acceptWinnerConflicts = Effect.fn("ArenaGit.acceptWinnerConflicts")(function* (input: {
  readonly canonical: string
  /** Conflicts the promotion reported. They are already ordinary dirty files with markers. */
  readonly reported?: readonly string[]
  /**
   * Rewrite each unmerged path from the index's three stages before clearing it. Only safe while
   * those files are untouched: it overwrites whatever is on disk, so a resolution in progress
   * would go with it. Off when the caller is settling an index whose markers the user may
   * already have worked through.
   */
  readonly materialize?: boolean
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_accepted_conflict_root", ["rev-parse", "--show-toplevel"])
  const conflicts = yield* conflictPaths(git, root)

  // Some conflicts originate from cached-only patches, so explicitly materialize the
  // three-way result before clearing the unmerged index.
  if (conflicts.length > 0 && input.materialize !== false) {
    yield* run(git, root, "materialize_winner_conflicts", ["checkout", "--conflict=merge", "--", ...conflicts])
  }
  const cherryPick = yield* git.run(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"], { cwd: root })
  if (cherryPick.exitCode === 0) {
    yield* run(git, root, "quit_conflicted_winner_replay", ["cherry-pick", "--quit"])
  } else if (cherryPick.exitCode !== 1) {
    const detail = cherryPick.stderr.toString("utf8").trim() || "Failed to inspect cherry-pick state"
    return yield* Effect.fail(new OperationError("inspect_cherry_pick", detail))
  }
  if (conflicts.length > 0) {
    yield* run(git, root, "clear_winner_conflict_index", ["reset", "--mixed", "HEAD"])
  }

  const remaining = yield* conflictPaths(git, root)
  if (remaining.length > 0) {
    return yield* Effect.fail(
      new OperationError("accept_winner_conflicts", `Unresolved index entries remain: ${remaining.join(", ")}`),
    )
  }
  return { conflicts: [...new Set([...(input.reported ?? []), ...conflicts])] } as const
})

// Keep the index snapshot as a sibling ref. A child ref would make Git reject the pair
// because a ref cannot simultaneously be both an object and a directory.
const safetyIndexRef = (safetyRef: string) => `${safetyRef}-index`

const snapshotCommit = Effect.fn("ArenaGit.snapshotCommit")(function* (
  git: Git.Interface,
  root: string,
  tree: string,
  parent: string,
  message: string,
) {
  return yield* read(git, root, "create_promotion_snapshot", ["commit-tree", tree, "-p", parent, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "OpenCode Arena",
      GIT_AUTHOR_EMAIL: "arena@localhost",
      GIT_AUTHOR_DATE: wrapperDate,
      GIT_COMMITTER_NAME: "OpenCode Arena",
      GIT_COMMITTER_EMAIL: "arena@localhost",
      GIT_COMMITTER_DATE: wrapperDate,
    },
  })
})

/**
 * A tree-to-tree patch `git apply` reads back. Plumbing, because porcelain `git diff` follows the
 * developer's diff config: `diff.noprefix` and the prefix settings break apply's path stripping,
 * `color.ui=always` and textconv drivers put bytes in the patch that no blob holds, and
 * `diff.submodule` or `diff.ignoreSubmodules` rewrite or drop gitlink changes. The flags pin what
 * `diff-tree` already defaults to, so its output is the porcelain patch under default config.
 */
function patchArgs(from: string, to: string) {
  return [
    "diff-tree",
    "-r",
    "-p",
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--ignore-submodules=none",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    from,
    to,
  ]
}

const diffTrees = Effect.fn("ArenaGit.diffTrees")(function* (
  git: Git.Interface,
  root: string,
  from: string,
  to: string,
) {
  const patch = yield* run(git, root, "read_tree_delta", patchArgs(from, to), {
    maxOutputBytes: 100 * 1024 * 1024,
  })
  if (patch.truncated) return yield* Effect.fail(new OperationError("read_tree_delta", "Git tree delta is too large"))
  return patch.text()
})

/** Return the selected result's patch without creating a public commit. */
export const resultPatch = Effect.fn("ArenaGit.resultPatch")(function* (input: {
  readonly canonical: string
  readonly baseCommit: string
  readonly resultCommit: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_result_patch_root", ["rev-parse", "--show-toplevel"])
  return yield* diffTrees(git, root, input.baseCommit, input.resultCommit)
})

/** Import an isolated contestant ref into the canonical repository without moving its branch. */
export const importResultRef = Effect.fn("ArenaGit.importResultRef")(function* (input: {
  readonly canonical: string
  readonly sourceRepository: string
  readonly sourceRef: string
  readonly destinationRef: string
  readonly expectedCommit: string
  readonly objectType?: "commit" | "tree"
  /** Previous admitted destination value when finalization is continuing the same run. */
  readonly expectedDestinationCommit?: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_import_result_root", ["rev-parse", "--show-toplevel"])
  const objectType = input.objectType ?? "commit"
  const sourceCommit = yield* read(git, input.sourceRepository, "read_source_result_commit", [
    "rev-parse",
    "--verify",
    `${input.sourceRef}^{${objectType}}`,
  ])
  if (sourceCommit !== input.expectedCommit) {
    return yield* Effect.fail(
      new OperationError(
        "verify_source_result_commit",
        `Source result changed from ${input.expectedCommit} to ${sourceCommit}`,
      ),
    )
  }
  yield* run(git, root, "validate_destination_result_ref", ["check-ref-format", input.destinationRef])
  const current = yield* git.run(["rev-parse", "--verify", "--quiet", `${input.destinationRef}^{${objectType}}`], {
    cwd: root,
  })
  if (current.exitCode === 0 && output(current) === input.expectedCommit) return input.expectedCommit
  if (current.exitCode !== 0 && current.exitCode !== 1) {
    const detail = current.stderr.toString("utf8").trim() || "Failed to inspect imported result ref"
    return yield* Effect.fail(new OperationError("inspect_imported_result_ref", detail))
  }

  if (current.exitCode === 0) {
    const existing = output(current)
    if (!input.expectedDestinationCommit || existing !== input.expectedDestinationCommit) {
      return yield* Effect.fail(
        new OperationError("import_result_ref", `Destination result ref already points to ${existing}`),
      )
    }
    const incomingRef = `${input.destinationRef}-incoming-${randomUUID()}`
    yield* Effect.gen(function* () {
      yield* run(git, root, "import_result_ref", [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        input.sourceRepository,
        `${input.sourceRef}:${incomingRef}`,
      ])
      const imported = yield* read(git, root, "verify_incoming_result_commit", [
        "rev-parse",
        "--verify",
        `${incomingRef}^{${objectType}}`,
      ])
      if (imported !== input.expectedCommit) {
        return yield* Effect.fail(
          new OperationError(
            "verify_incoming_result_commit",
            `Imported result points to ${imported}, expected ${input.expectedCommit}`,
          ),
        )
      }
      yield* run(git, root, "advance_imported_result_ref", [
        "update-ref",
        input.destinationRef,
        input.expectedCommit,
        existing,
      ])
    }).pipe(
      Effect.ensuring(
        git.run(["update-ref", "-d", incomingRef], { cwd: root }).pipe(Effect.ignore),
      ),
    )
  } else {
    yield* run(git, root, "import_result_ref", [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      input.sourceRepository,
      `${input.sourceRef}:${input.destinationRef}`,
    ])
  }
  const destinationCommit = yield* read(git, root, "verify_imported_result_commit", [
    "rev-parse",
    "--verify",
    `${input.destinationRef}^{${objectType}}`,
  ])
  if (destinationCommit !== input.expectedCommit) {
    return yield* Effect.fail(
      new OperationError(
        "verify_imported_result_commit",
        `Imported result points to ${destinationCommit}, expected ${input.expectedCommit}`,
      ),
    )
  }
  return destinationCommit
})

/**
 * Save the exact public state, clear the checkout, and apply the selected result. The two
 * snapshot commits are reachable only through private refs: they are recovery objects, never
 * commits on the user's branch. The index snapshot is separate so staged and unstaged changes
 * can be reconstructed after a promotion.
 */
export const preparePromotion = Effect.fn("ArenaGit.preparePromotion")(function* (input: {
  readonly canonical: string
  readonly expectedBranch?: string
  readonly baseCommit: string
  readonly resultCommit: string
  readonly safetyRef: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_promotion_root", ["rev-parse", "--show-toplevel"])
  const branch = yield* readBranch(git, root)
  if (input.expectedBranch !== undefined && branch !== input.expectedBranch) {
    return yield* Effect.fail(
      new OperationError(
        "verify_canonical_branch",
        `Public branch changed from ${input.expectedBranch} to ${branch ?? "a detached HEAD"}`,
      ),
    )
  }
  const previousHead = yield* read(git, root, "read_promotion_head", ["rev-parse", "--verify", "HEAD"])
  if (!(yield* isAncestor(git, root, input.baseCommit, previousHead))) {
    return yield* Effect.fail(
      new OperationError("verify_public_ancestry", "The public branch no longer descends from the battle base"),
    )
  }
  yield* run(git, root, "validate_public_safety_ref", ["check-ref-format", input.safetyRef])
  const status = yield* read(git, root, "read_public_status", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ".",
  ])
  const indexTree = yield* readIndexTree(git, root, "read_public_index")
  const workingTree = status
    ? yield* readWorkingTree(git, root)
    : yield* read(git, root, "read_public_head_tree", ["rev-parse", `${previousHead}^{tree}`])
  const safety = yield* snapshotCommit(git, root, workingTree, previousHead, "Agent Duel public safety snapshot")
  const indexSnapshot = yield* snapshotCommit(git, root, indexTree, previousHead, "Agent Duel public index snapshot")
  const indexRef = safetyIndexRef(input.safetyRef)
  yield* preserveRef(git, root, input.safetyRef, safety)
  yield* preserveRef(git, root, indexRef, indexSnapshot)
  yield* run(git, root, "clear_public_for_promotion", ["reset", "--hard", previousHead])
  yield* run(git, root, "clean_public_for_promotion", ["clean", "-fd", "--", "."])

  const patch = yield* diffTrees(git, root, input.baseCommit, input.resultCommit)
  if (patch) {
    const applied = yield* git.run(["apply", "--3way", "--index", "--binary", "--whitespace=nowarn", "-"], {
      cwd: root,
      stdin: Stream.make(new TextEncoder().encode(patch)),
    })
    if (applied.exitCode !== 0) {
      const conflicts = yield* conflictPaths(git, root)
      if (conflicts.length > 0) return { previousHead, branch, safetyRef: input.safetyRef, safetyIndexRef: indexRef, conflicts }
      const detail = applied.stderr.toString("utf8").trim() || "Failed to apply the selected result"
      return yield* Effect.fail(new OperationError("apply_selected_result", detail))
    }
  }
  return { previousHead, branch, safetyRef: input.safetyRef, safetyIndexRef: indexRef, conflicts: [] } satisfies PromotionPreparation
})

const applyPatch = Effect.fn("ArenaGit.applyPatch")(function* (
  git: Git.Interface,
  root: string,
  patch: string,
  cached: boolean,
) {
  if (!patch) return [] as string[]
  const args = cached
    ? ["apply", "--3way", "--cached", "--binary", "--whitespace=nowarn", "-"]
    : ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"]
  const applied = yield* git.run(args, {
    cwd: root,
    stdin: Stream.make(new TextEncoder().encode(patch)),
  })
  if (applied.exitCode !== 0) {
    const conflicts = yield* conflictPaths(git, root)
    if (conflicts.length > 0) return conflicts
    const detail = applied.stderr.toString("utf8").trim() || "Failed to apply saved Git state"
    return yield* Effect.fail(new OperationError("apply_saved_state", detail))
  }
  return [] as string[]
})

// Recovery starts from a clean checkout. Restoring a saved index therefore has to materialize
// that index in the working tree too: `--cached` alone leaves a staged new file absent on disk.
const applyIndexAndWorktreePatch = Effect.fn("ArenaGit.applyIndexAndWorktreePatch")(function* (
  git: Git.Interface,
  root: string,
  patch: string,
) {
  if (!patch) return [] as string[]
  const applied = yield* git.run(["apply", "--3way", "--index", "--binary", "--whitespace=nowarn", "-"], {
    cwd: root,
    stdin: Stream.make(new TextEncoder().encode(patch)),
  })
  if (applied.exitCode !== 0) {
    const conflicts = yield* conflictPaths(git, root)
    if (conflicts.length > 0) return conflicts
    const detail = applied.stderr.toString("utf8").trim() || "Failed to restore saved index"
    return yield* Effect.fail(new OperationError("restore_saved_index", detail))
  }
  return [] as string[]
})

const applyPlainWorktreePatch = Effect.fn("ArenaGit.applyPlainWorktreePatch")(function* (
  git: Git.Interface,
  root: string,
  patch: string,
) {
  if (!patch) return [] as string[]
  const applied = yield* git.run(["apply", "--binary", "--whitespace=nowarn", "-"], {
    cwd: root,
    stdin: Stream.make(new TextEncoder().encode(patch)),
  })
  if (applied.exitCode === 0) return [] as string[]
  const detail = applied.stderr.toString("utf8").trim() || "Failed to apply exact Git state"
  return yield* Effect.fail(new OperationError("apply_exact_worktree_state", detail))
})

const promotionBranchMarkerRef = (safetyRef: string) => `${safetyRef}-created-branch`
// An existing target branch is restored from these two refs. The `-target-existing` ref is
// the marker that the branch predated the promotion; `-target-tip` is where it pointed.
const targetTipRef = (safetyRef: string) => `${safetyRef}-target-tip`
const targetExistingRef = (safetyRef: string) => `${safetyRef}-target-existing`
/** The commit the promotion moved an existing target branch to, so recovery knows it as its own. */
const targetWrittenRef = (safetyRef: string) => `${safetyRef}-target-written`

/** Promote real contestant commits, preserving their OIDs when the frozen branch is unchanged. */
export const applyPromotionState = Effect.fn("ArenaGit.applyPromotionState")(function* (input: {
  readonly canonical: string
  readonly expectedHead: string
  readonly baseCommit: string
  readonly frozenHead?: string
  readonly agentCommit?: string
  readonly agentCommits?: readonly string[]
  readonly resultCommit?: string
  readonly finalIndexTree?: string
  readonly fullyCommitted?: boolean
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_promotion_state_root", ["rev-parse", "--show-toplevel"])
  const head = yield* read(git, root, "read_precommit_head", ["rev-parse", "--verify", "HEAD"])
  if (head !== input.expectedHead) {
    return yield* Effect.fail(
      new OperationError("verify_precommit_head", `Public HEAD changed from ${input.expectedHead} to ${head}`),
    )
  }
  const conflicts = yield* conflictPaths(git, root)
  if (conflicts.length > 0) {
    return yield* Effect.fail(new OperationError("verify_conflicts", `Unresolved files: ${conflicts.join(", ")}`))
  }
  const commits = [...(input.agentCommits ?? (input.agentCommit ? [input.agentCommit] : []))]
  if (commits.length === 0) {
    // The selected patch is intentionally left as ordinary working-tree state. No wrapper
    // commit is introduced for a zero-commit contestant.
    yield* run(git, root, "leave_selected_result_uncommitted", ["reset", "--mixed", "HEAD"])
    return { resultingHead: head, conflicts: [] } satisfies PromotionApplyResult
  }

  const tip = commits[commits.length - 1]!
  const firstParent = yield* read(git, root, "read_first_agent_parent", ["rev-parse", `${commits[0]}^`])
  const branchResult = yield* git.run(["symbolic-ref", "--quiet", "HEAD"], { cwd: root })
  // `HEAD` itself is an updateable ref when the canonical checkout is detached. Updating it
  // retains exact OIDs just as updating the branch ref does.
  const branchRef = branchResult.exitCode === 0 ? output(branchResult) : "HEAD"
  const frozenHead = input.frozenHead ?? input.baseCommit
  const exact = head === frozenHead && firstParent === frozenHead
  if (exact) {
    // Discard the prepared patch and move the branch ref atomically to the contestant's
    // actual tip. This is the only path that can retain every original commit OID.
    yield* run(git, root, "install_agent_commit", ["update-ref", branchRef, tip, head])
    yield* run(git, root, "checkout_agent_commit", ["reset", "--hard", tip])
  } else {
    // A canonical branch that advanced after the battle started gets the ordered chain
    // replayed. Git's normal cherry-pick machinery is intentionally used so conflicts remain
    // visible in the index and worktree for the caller to resolve.
    yield* run(git, root, "reset_before_agent_replay", ["reset", "--hard", head])
    for (const commit of commits) {
      const replayed = yield* git.run(
        ["cherry-pick", "--allow-empty", "--keep-redundant-commits", commit],
        { cwd: root },
      )
      if (replayed.exitCode !== 0) {
        const replayConflicts = yield* conflictPaths(git, root)
        if (replayConflicts.length > 0) {
          return { resultingHead: head, conflicts: replayConflicts } satisfies PromotionApplyResult
        }
        const detail = replayed.stderr.toString("utf8").trim() || "Failed to replay contestant commit"
        return yield* Effect.fail(new OperationError("replay_agent_commit", detail))
      }
    }
  }

  if (input.fullyCommitted !== false || !input.resultCommit) {
    const resultingHead = yield* read(git, root, "read_promoted_head", ["rev-parse", "HEAD"])
    return { resultingHead, conflicts: [] } satisfies PromotionApplyResult
  }

  // Restore only the residual state after the real commit chain. The final index tree and
  // final commit tree are separate, so staged, unstaged, and untracked files stay distinct.
  const promoted = yield* read(git, root, "read_promoted_tip", ["rev-parse", "HEAD"])
  // Materialize the complete final worktree first. A cached-only patch would create an index
  // entry without creating the corresponding staged file in the worktree.
  const worktreePatch = yield* diffTrees(git, root, promoted, input.resultCommit)
  const worktreeConflicts = yield* applyPatch(git, root, worktreePatch, false)
  if (worktreeConflicts.length > 0) return { resultingHead: promoted, conflicts: worktreeConflicts } satisfies PromotionApplyResult
  const indexTree = input.finalIndexTree
    ? yield* diffTrees(git, root, promoted, input.finalIndexTree)
    : ""
  const stagedConflicts = yield* applyPatch(git, root, indexTree, true)
  if (stagedConflicts.length > 0) return { resultingHead: promoted, conflicts: stagedConflicts } satisfies PromotionApplyResult
  return { resultingHead: promoted, conflicts: [] } satisfies PromotionApplyResult
})

/**
 * Promote one complete contestant result while keeping the public baseline separate from the
 * contestant's private commit history. Public edits are merged as deltas; the frozen baseline is
 * never restored on top of a winner that already committed it.
 */
export const promoteWinnerState = Effect.fn("ArenaGit.promoteWinnerState")(function* (
  input: PromoteWinnerStateInput,
) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_winner_promotion_root", ["rev-parse", "--show-toplevel"])
  const branch = yield* readBranch(git, root)
  if (
    (input.expectedBranch !== undefined && branch !== input.expectedBranch) ||
    (input.expectedDetached === true && branch !== undefined)
  ) {
    return yield* Effect.fail(
      new OperationError(
        "verify_canonical_branch",
        `Public branch changed from ${input.expectedBranch ?? "a detached HEAD"} to ${branch ?? "a detached HEAD"}`,
      ),
    )
  }
  const targetBranchRef =
    input.targetBranch !== undefined && input.targetBranch !== branch
      ? `refs/heads/${input.targetBranch}`
      : undefined
  let existingTargetTip: string | undefined
  const targetWorktrees: string[] = []
  if (targetBranchRef) {
    yield* run(git, root, "validate_winner_target_branch", ["check-ref-format", targetBranchRef])
    const existingTarget = yield* git.run(["rev-parse", "--verify", "--quiet", targetBranchRef], { cwd: root })
    if (existingTarget.exitCode !== 0 && existingTarget.exitCode !== 1) {
      return yield* Effect.fail(
        new OperationError("inspect_target_branch", `Failed to inspect winning branch ${input.targetBranch}`),
      )
    }
    if (existingTarget.exitCode === 0) {
      existingTargetTip = output(existingTarget)
      const taken = new Set((input.takeTargetFrom ?? []).map((path) => resolve(path)))
      for (const item of yield* inspectWorktrees(git, root)) {
        if (item.branch !== input.targetBranch) continue
        if (!taken.has(resolve(item.path))) {
          return yield* Effect.fail(
            new OperationError(
              "target_branch_checked_out",
              `${input.targetBranch} is checked out at ${item.path}. Switch that worktree away from the branch, then retry.`,
            ),
          )
        }
        targetWorktrees.push(item.path)
      }
    }
  }
  const currentHead = yield* read(git, root, "read_winner_promotion_head", ["rev-parse", "--verify", "HEAD"])
  const baseWorkingTree = yield* read(git, root, "verify_base_working_tree", ["rev-parse", `${input.baseWorkingTree}^{tree}`])
  const baseIndexTree = yield* read(git, root, "verify_base_index_tree", ["rev-parse", `${input.baseIndexTree}^{tree}`])
  const resultTree = yield* read(git, root, "verify_winner_result_tree", ["rev-parse", `${input.resultCommit}^{tree}`])
  const finalIndexTree = yield* read(git, root, "verify_winner_index_tree", ["rev-parse", `${input.finalIndexTree}^{tree}`])
  const publicIndexTree = yield* readIndexTree(git, root, "read_public_winner_index")
  const publicWorkingTree = yield* readWorkingTree(git, root)
  const currentHeadTree = yield* read(git, root, "read_public_head_tree", ["rev-parse", `${currentHead}^{tree}`])

  yield* run(git, root, "validate_winner_safety_ref", ["check-ref-format", input.safetyRef])
  const indexSafetyRef = safetyIndexRef(input.safetyRef)
  if (!input.dryRun) {
    const safetyCommit = yield* snapshotCommit(git, root, publicWorkingTree, currentHead, "Agent Duel public safety snapshot")
    const safetyIndexCommit = yield* snapshotCommit(git, root, publicIndexTree, currentHead, "Agent Duel public index snapshot")
    yield* preserveRef(git, root, input.safetyRef, safetyCommit)
    yield* preserveRef(git, root, indexSafetyRef, safetyIndexCommit)
    if (existingTargetTip) {
      yield* preserveRef(git, root, targetTipRef(input.safetyRef), existingTargetTip)
      yield* preserveRef(git, root, targetExistingRef(input.safetyRef), existingTargetTip)
    }
  }

  // ---------------------------------------------------------------------------------------
  // Everything below computes the promoted state as trees in the object store. The checkout
  // is not touched until the final trees are known, so a failure anywhere before the write
  // step leaves the developer's files exactly as they were.
  // ---------------------------------------------------------------------------------------
  // While HEAD is frozen, W0/I0 already hold the developer's dirty state from the freeze, so their
  // edits are deltas from W0/I0; once HEAD moved, committed movement is in the branch and its tree
  // is the base. Setting the edits aside makes the public side equal its base, so the merges below
  // carry nothing of the developer's; the safety refs above still hold what was set aside.
  const frozen = currentHead === input.frozenHead
  const publicBase = frozen ? baseWorkingTree : currentHeadTree
  const publicIndexBase = frozen ? baseIndexTree : currentHeadTree
  const choice = input.publicChoice
  const chosen = new Set(choice?.paths ?? [])
  let publicWorktreeSide = publicWorkingTree
  let publicIndexSide = publicIndexTree
  if (choice?.action === "agent") {
    for (const path of chosen) {
      publicWorktreeSide = yield* replaceTreeEntry(git, root, publicWorktreeSide, path, yield* treeEntry(git, root, publicBase, path))
      publicIndexSide = yield* replaceTreeEntry(git, root, publicIndexSide, path, yield* treeEntry(git, root, publicIndexBase, path))
    }
  }

  // 1. The winner's real commits land on the branch they belong to.
  let resultingHead = currentHead
  // Trees the residual merge starts from: the last winner commit that reached the branch, or
  // the battle baseline for a winner that never committed.
  let residualBase = baseWorkingTree
  let residualIndexBase = baseIndexTree
  let residualOurs: string | undefined
  if (input.checkoutAction) {
    // The review decided this branch. `yours` is the checkout's own tip, or the target branch's
    // when the checkout switches; the winner's leftover edits are measured from its own tip.
    const { action, start, agent } = input.checkoutAction
    const yours = targetBranchRef ? existingTargetTip : currentHead
    residualBase = agent
    residualIndexBase = agent
    if (action === "agent") {
      resultingHead = agent
    } else if (!yours) {
      return yield* Effect.fail(new OperationError("promote_checkout_branch", "The checkout branch no longer exists"))
    } else if (action === "yours") {
      resultingHead = yours
    } else if (action === "combine") {
      // The branch keeps the developer's tip and the agent's changes, committed ones included,
      // land as edits in the files, with markers where the two clash.
      resultingHead = yours
      residualBase = start ?? (yield* read(git, root, "read_checkout_merge_base", ["merge-base", yours, agent]))
      residualIndexBase = residualBase
    } else {
      const onto = action === "agent_on_yours" ? yours : agent
      const tip = action === "agent_on_yours" ? agent : yours
      const base = start ?? (yield* read(git, root, "read_checkout_merge_base", ["merge-base", onto, tip]))
      const chain = (yield* read(git, root, "read_checkout_replay_chain", ["rev-list", "--first-parent", "--reverse", `${base}..${tip}`]))
        .split(/\r?\n/)
        .filter(Boolean)
      const replayed = yield* replayCommits(git, root, onto, chain, true)
      if (replayed.conflict) {
        return yield* Effect.fail(
          new OperationError("promote_checkout_branch", "The checkout branch no longer combines cleanly", replayed.conflict),
        )
      }
      resultingHead = replayed.head
    }
  } else if (targetBranchRef && existingTargetTip) {
    // Switching to an existing branch nobody decided on keeps it where it is; only the files move.
    resultingHead = existingTargetTip
  } else if (frozen) {
    // A winner that made no commits on a frozen branch is measured from W0/I0, and so is the branch.
    residualOurs = baseWorkingTree
  }
  const headTree = yield* read(git, root, "read_resulting_head_tree", ["rev-parse", `${resultingHead}^{tree}`])

  // 2. The winner's uncommitted residual (and any commit the replay could not land) merges
  //    onto the new head. Conflicts here are the winner against the moved branch.
  const winnerWorktree = yield* mergeTrees(git, root, residualBase, residualOurs ?? headTree, resultTree)
  const winnerIndex = yield* mergeTrees(
    git,
    root,
    residualIndexBase,
    residualOurs !== undefined ? baseIndexTree : headTree,
    finalIndexTree,
  )

  // 3. The developer's uncommitted work merges on top.
  const mergedWorktree = yield* mergeTrees(git, root, publicBase, publicWorktreeSide, winnerWorktree.tree)
  const mergedIndex = yield* mergeTrees(git, root, publicIndexBase, publicIndexSide, winnerIndex.tree)

  // A file the winner already conflicted on cannot take the developer's edit on top of its
  // markers. Merge it once more with the developer's own copy as the "ours" side instead, so
  // it ends with one set of markers that includes their edit.
  let worktreeTree = mergedWorktree.tree
  for (const path of winnerWorktree.conflicts) {
    const publicBlob = yield* treeEntry(git, root, publicWorktreeSide, path)
    const baseBlob = yield* treeEntry(git, root, publicBase, path)
    if (publicBlob === baseBlob) continue
    const remerged = yield* mergeBlobs(git, root, {
      base: yield* treeEntry(git, root, residualBase, path),
      ours: publicBlob,
      theirs: yield* treeEntry(git, root, resultTree, path),
    })
    worktreeTree = yield* replaceTreeEntry(git, root, worktreeTree, path, remerged)
  }
  const conflicts = [
    ...new Set([...winnerWorktree.conflicts, ...mergedWorktree.conflicts, ...winnerIndex.conflicts, ...mergedIndex.conflicts]),
  ].filter((path) => !chosen.has(path))

  // Conflicted index entries go back to HEAD; their markers live in the working tree. The one
  // exception is a staged copy the developer had not written to the working tree as well: that
  // copy exists nowhere else, so it stays in the index with its own markers against the winner.
  let indexTree = mergedIndex.tree
  const stagedCopiesKept = new Set<string>()
  for (const path of conflicts) {
    const staged = yield* treeEntry(git, root, publicIndexSide, path)
    const unique =
      staged !== undefined &&
      staged !== (yield* treeEntry(git, root, publicIndexBase, path)) &&
      staged !== (yield* treeEntry(git, root, publicWorktreeSide, path))
    let entry: string | undefined
    if (unique) {
      const winnerConflicted = winnerIndex.conflicts.includes(path)
      entry = yield* mergeBlobs(git, root, {
        base: yield* treeEntry(git, root, winnerConflicted ? residualIndexBase : publicIndexBase, path),
        ours: staged,
        theirs: yield* treeEntry(git, root, winnerConflicted ? finalIndexTree : winnerIndex.tree, path),
      })
      stagedCopiesKept.add(path)
    } else {
      entry = yield* treeEntry(git, root, headTree, path)
    }
    indexTree = yield* replaceTreeEntry(git, root, indexTree, path, entry)
  }

  // The files the developer answered for. `agent`: their edits are already out of the public
  // side, so what is left to settle is the winner against their commits, and the winner's copy
  // wins. `yours`: the file stays as it is on disk; its index entry follows the new HEAD unless
  // the developer had staged something of their own.
  for (const path of chosen) {
    if (choice?.action === "agent") {
      worktreeTree = yield* replaceTreeEntry(git, root, worktreeTree, path, yield* treeEntry(git, root, resultTree, path))
      if (winnerIndex.conflicts.includes(path)) {
        indexTree = yield* replaceTreeEntry(git, root, indexTree, path, yield* treeEntry(git, root, headTree, path))
      }
      continue
    }
    worktreeTree = yield* replaceTreeEntry(git, root, worktreeTree, path, yield* treeEntry(git, root, publicWorkingTree, path))
    const staged = yield* treeEntry(git, root, publicIndexTree, path)
    const unstaged = staged === (yield* treeEntry(git, root, currentHeadTree, path))
    indexTree = yield* replaceTreeEntry(git, root, indexTree, path, unstaged ? yield* treeEntry(git, root, headTree, path) : staged)
  }

  // Safety net: every developer edit must be reachable in the state about to be written. A
  // case this design does not handle yet stops here, with the checkout untouched, instead of
  // silently dropping work. The safety refs made above snapshot a state that still exists on
  // disk, so they go too; a retry after the developer commits or stashes starts clean.
  // Edits set aside are not "at risk" -- the safety refs are the answer to them. The check runs
  // against the substituted side, where it still catches a winner delta this design cannot place.
  const publicConflicts = [...new Set([...mergedWorktree.conflicts, ...mergedIndex.conflicts])].filter((path) => !chosen.has(path))
  const atRisk = yield* unrecoverablePublicEdits(git, root, {
    publicBase,
    publicWorkingTree: publicWorktreeSide,
    publicIndexBase,
    publicIndexTree: publicIndexSide,
    winnerWorktree: winnerWorktree.tree,
    winnerIndex: winnerIndex.tree,
    worktreeTree,
    indexTree,
    conflicts,
    stagedCopiesKept,
  })
  if (input.dryRun) {
    return {
      resultingHead,
      conflicts,
      publicConflicts,
      atRisk: atRisk.map((item) => item.path),
      safetyRef: input.safetyRef,
    } satisfies PromoteWinnerStateResult
  }
  if (atRisk.length > 0) {
    for (const ref of [
      input.safetyRef,
      indexSafetyRef,
      targetTipRef(input.safetyRef),
      targetExistingRef(input.safetyRef),
      targetWrittenRef(input.safetyRef),
    ]) {
      yield* run(git, root, "drop_unused_safety_ref", ["update-ref", "-d", ref])
    }
    return yield* Effect.fail(
      new PublicEditsAtRiskError(
        atRisk.map((item) => item.path),
        publicEditsAtRiskMessage(atRisk),
      ),
    )
  }

  // 4. Write the result. This is the only step that changes the checkout. A worktree the target
  // branch is taken from is detached at its own commit, which leaves its index and files alone.
  for (const path of targetWorktrees) {
    const head = yield* read(git, path, "read_taken_worktree_head", ["rev-parse", "--verify", "HEAD"])
    yield* run(git, path, "detach_taken_worktree", ["update-ref", "--no-deref", "HEAD", head, head])
  }
  if (targetBranchRef && existingTargetTip) {
    // Recorded before the move, and overwritten by a retry that writes another commit: recovery
    // accepts the branch at this commit, which a rewrite does not put above the saved tip.
    yield* run(git, root, "record_written_target_tip", ["update-ref", targetWrittenRef(input.safetyRef), resultingHead])
    yield* run(git, root, "move_existing_branch", ["update-ref", targetBranchRef, resultingHead, existingTargetTip])
    yield* run(git, root, "switch_to_existing_branch", ["symbolic-ref", "HEAD", targetBranchRef])
  } else if (targetBranchRef) {
    // The marker distinguishes a branch Arena created from one that predated a recovery.
    // Keep it with the safety refs until the service durably records the promotion.
    yield* preserveRef(git, root, promotionBranchMarkerRef(input.safetyRef), currentHead)
    yield* run(git, root, "create_winner_branch", ["branch", input.targetBranch!, resultingHead])
    yield* run(git, root, "switch_to_winner_branch", ["symbolic-ref", "HEAD", targetBranchRef])
  } else if (resultingHead !== currentHead) {
    const headRef = branch ? `refs/heads/${branch}` : "HEAD"
    yield* run(git, root, "advance_public_head", ["update-ref", headRef, resultingHead, currentHead])
  }
  yield* run(git, root, "write_promoted_index", ["read-tree", indexTree])
  yield* writeTreeToWorktree(git, root, publicWorkingTree, worktreeTree)
  yield* git.run(["update-index", "-q", "--refresh"], { cwd: root })

  const verifiedHead = yield* read(git, root, "verify_winner_promotion_head", ["rev-parse", "HEAD"])
  const verifiedTree = yield* readWorkingTree(git, root)
  if (verifiedHead !== resultingHead || verifiedTree !== worktreeTree) {
    return yield* Effect.fail(new OperationError("verify_winner_promotion", "Promoted winner state could not be verified"))
  }
  if (!input.retainSafetyRef) {
    yield* run(git, root, "delete_winner_safety_ref", ["update-ref", "-d", input.safetyRef])
    yield* run(git, root, "delete_winner_index_safety_ref", ["update-ref", "-d", indexSafetyRef])
    yield* run(git, root, "delete_winner_target_tip_ref", ["update-ref", "-d", targetTipRef(input.safetyRef)])
    yield* run(git, root, "delete_winner_target_existing_ref", ["update-ref", "-d", targetExistingRef(input.safetyRef)])
    yield* run(git, root, "delete_winner_target_written_ref", ["update-ref", "-d", targetWrittenRef(input.safetyRef)])
  }
  return { resultingHead, conflicts, publicConflicts, atRisk: [], safetyRef: input.safetyRef } satisfies PromoteWinnerStateResult
})

const arenaCommitterEnv = {
  GIT_COMMITTER_NAME: "OpenCode Arena",
  GIT_COMMITTER_EMAIL: "arena@localhost",
  GIT_COMMITTER_DATE: wrapperDate,
}

/** Wrap a tree in a parentless commit so merge-tree and friends can name it. */
const treeCommit = Effect.fn("ArenaGit.treeCommit")(function* (git: Git.Interface, root: string, tree: string) {
  return yield* read(git, root, "wrap_tree_commit", ["commit-tree", tree, "-m", "Agent Duel merge input"], {
    env: {
      GIT_AUTHOR_NAME: "OpenCode Arena",
      GIT_AUTHOR_EMAIL: "arena@localhost",
      GIT_AUTHOR_DATE: wrapperDate,
      ...arenaCommitterEnv,
    },
  })
})

/**
 * Three-way merge of trees in the object store with git's own merge engine. Conflicted files
 * come back with markers inside the tree, and their paths in `conflicts`. Nothing on disk moves.
 */
const mergeTrees = Effect.fn("ArenaGit.mergeTrees")(function* (
  git: Git.Interface,
  root: string,
  base: string,
  ours: string,
  theirs: string,
) {
  const resolve = (ref: string) => read(git, root, "resolve_merge_input", ["rev-parse", `${ref}^{tree}`])
  const [baseTree, oursTree, theirsTree] = [yield* resolve(base), yield* resolve(ours), yield* resolve(theirs)]
  if (oursTree === baseTree) return { tree: theirsTree, conflicts: [] as string[] }
  if (theirsTree === baseTree || theirsTree === oursTree) return { tree: oursTree, conflicts: [] as string[] }
  const [baseCommit, oursCommit, theirsCommit] = [
    yield* treeCommit(git, root, baseTree),
    yield* treeCommit(git, root, oursTree),
    yield* treeCommit(git, root, theirsTree),
  ]
  const merged = yield* git.run(
    ["merge-tree", "--write-tree", "-z", "--name-only", `--merge-base=${baseCommit}`, oursCommit, theirsCommit],
    { cwd: root, maxOutputBytes: 16 * 1024 * 1024 },
  )
  if (merged.exitCode !== 0 && merged.exitCode !== 1) {
    const detail = merged.stderr.toString("utf8").trim() || "git merge-tree failed"
    return yield* Effect.fail(new OperationError("merge_trees", detail))
  }
  const fields = merged.stdout.toString("utf8").split("\0")
  const tree = fields[0]?.trim()
  if (!tree) return yield* Effect.fail(new OperationError("merge_trees", "git merge-tree returned no tree"))
  const conflicts: string[] = []
  if (merged.exitCode === 1) {
    for (const field of fields.slice(1)) {
      if (field === "") break
      if (!conflicts.includes(field)) conflicts.push(field)
    }
  }
  // merge-tree labels the markers with the wrapper commits it was given. Name the sides instead.
  let labelled = tree
  for (const path of conflicts) {
    const blob = yield* treeEntry(git, root, tree, path)
    if (!blob) continue
    const content = (yield* run(git, root, "read_conflicted_blob", ["cat-file", "blob", blob], { maxOutputBytes: 100 * 1024 * 1024 })).stdout.toString("utf8")
    const relabelled = content
      .split("\n")
      .map((line) => (line === `<<<<<<< ${oursCommit}` ? "<<<<<<< ours" : line === `>>>>>>> ${theirsCommit}` ? ">>>>>>> theirs" : line))
      .join("\n")
    if (relabelled === content) continue
    const written = yield* read(git, root, "write_relabelled_blob", ["hash-object", "-w", "--stdin"], {
      stdin: Stream.make(new TextEncoder().encode(relabelled)),
    })
    labelled = yield* replaceTreeEntry(git, root, labelled, path, written)
  }
  return { tree: labelled, conflicts }
})

/** Replay commits one by one onto `onto` without a working tree; stop at the first conflict. */
const replayCommits = Effect.fn("ArenaGit.replayCommits")(function* (
  git: Git.Interface,
  root: string,
  onto: string,
  commits: readonly string[],
  firstParentOnly: boolean,
) {
  let head = onto
  let lastOriginal: string | undefined
  for (const commit of commits) {
    const parents = (yield* read(git, root, "read_replay_parents", ["rev-list", "--parents", "-n", "1", commit]))
      .split(/\s+/)
      .slice(1)
    const parent = parents[0]
    if (!parent) return yield* Effect.fail(new OperationError("replay_winner_commit", "A winner commit has no parent"))
    if (!firstParentOnly && parents.length > 1) {
      return yield* Effect.fail(new OperationError("replay_winner_commit", "A winner merge commit cannot be replayed"))
    }
    const merged = yield* mergeTrees(git, root, parent, head, commit)
    if (merged.conflicts.length > 0) return { head, lastOriginal, conflict: merged.conflicts }
    if (merged.tree === (yield* read(git, root, "read_replay_head_tree", ["rev-parse", `${head}^{tree}`]))) {
      // The commit adds nothing on top of the moved branch; keep it as an empty commit.
    }
    const [name, email, date, ...message] = (yield* read(git, root, "read_replay_author", [
      "log",
      "-1",
      "--format=%an%x00%ae%x00%aI%x00%B",
      commit,
    ])).split("\0")
    head = yield* read(git, root, "replay_winner_commit", ["commit-tree", merged.tree, "-p", head, "-m", message.join("\0")], {
      env: {
        GIT_AUTHOR_NAME: name ?? "OpenCode Arena",
        GIT_AUTHOR_EMAIL: email ?? "arena@localhost",
        GIT_AUTHOR_DATE: date ?? wrapperDate,
      },
    })
    lastOriginal = commit
  }
  return { head, lastOriginal, conflict: undefined }
})

/** The blob OID at `path` in `tree`, or undefined when the path is absent. */
type PublicEditLayer = "working" | "staged"
export type PublicEditAtRisk = { readonly path: string; readonly layers: readonly PublicEditLayer[] }

export function publicEditsAtRiskMessage(items: readonly PublicEditAtRisk[]): string {
  const describe = (item: PublicEditAtRisk) => {
    const copies = item.layers.includes("working") && item.layers.includes("staged")
      ? "staged and working copies"
      : item.layers.includes("staged")
        ? "staged copy"
        : "working copy"
    return `${item.path} (${copies})`
  }
  const count = items.length === 1 ? "one file" : `${items.length} files`
  return (
    `Agent Duel did not apply the winner. Your uncommitted work in ${count} would not survive the merge: ` +
    `${items.map(describe).join(", ")}. Commit or stash that work, then retry. The workspace was not changed.`
  )
}

/** Paths that differ between two trees, renames reported as delete plus add. */
const changedPaths = Effect.fn("ArenaGit.changedPaths")(function* (git: Git.Interface, root: string, from: string, to: string) {
  if (from === to) return [] as string[]
  const listing = yield* read(git, root, "list_changed_paths", ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to])
  return listing.split("\0").filter(Boolean)
})

/** Every blob OID reachable from a tree, at any path. */
const treeBlobs = Effect.fn("ArenaGit.treeBlobs")(function* (git: Git.Interface, root: string, tree: string) {
  const listing = yield* run(git, root, "list_tree_blobs", ["ls-tree", "-r", "-z", tree], { maxOutputBytes: 64 * 1024 * 1024 })
  const blobs = new Set<string>()
  for (const entry of listing.stdout.toString("utf8").split("\0")) {
    const [meta] = entry.split("\t")
    const [, type, oid] = (meta ?? "").split(" ")
    if (type === "blob" && oid) blobs.add(oid)
  }
  return blobs
})

/**
 * Developer edits that the promoted state would not carry. An edit survives when the written
 * tree holds the developer's blob at its path (or anywhere, after a rename), when the path is a
 * reported conflict whose markers carry the developer's side, or when the merge combined it
 * cleanly. A path whose result is exactly the winner's side while the developer's copy differs
 * has been dropped; a staged copy that neither the index (with markers) nor the worktree keeps
 * has been dropped too. A deletion is never lost content, so it is not reported.
 */
export const unrecoverablePublicEdits = Effect.fn("ArenaGit.unrecoverablePublicEdits")(function* (
  git: Git.Interface,
  root: string,
  input: {
    readonly publicBase: string
    readonly publicWorkingTree: string
    readonly publicIndexBase: string
    readonly publicIndexTree: string
    readonly winnerWorktree: string
    readonly winnerIndex: string
    readonly worktreeTree: string
    readonly indexTree: string
    readonly conflicts: readonly string[]
    /** Conflicted paths whose index entry was rebuilt with the developer's staged copy as its own side. */
    readonly stagedCopiesKept: ReadonlySet<string>
  },
) {
  const conflicted = new Set(input.conflicts)
  const surviving = yield* treeBlobs(git, root, input.worktreeTree)
  const at = (tree: string, path: string) => treeEntry(git, root, tree, path)
  const flagged = new Map<string, Set<PublicEditLayer>>()
  const flag = (path: string, layer: PublicEditLayer) => {
    const layers = flagged.get(path) ?? new Set<PublicEditLayer>()
    layers.add(layer)
    flagged.set(path, layers)
  }
  for (const path of yield* changedPaths(git, root, input.publicBase, input.publicWorkingTree)) {
    const developer = yield* at(input.publicWorkingTree, path)
    if (developer === undefined) continue
    if ((yield* at(input.worktreeTree, path)) === developer) continue
    if (conflicted.has(path) || surviving.has(developer)) continue
    const winner = yield* at(input.winnerWorktree, path)
    if ((yield* at(input.worktreeTree, path)) !== winner || winner === developer) continue
    flag(path, "working")
  }
  for (const path of yield* changedPaths(git, root, input.publicIndexBase, input.publicIndexTree)) {
    const developer = yield* at(input.publicIndexTree, path)
    if (developer === undefined) continue
    const written = yield* at(input.indexTree, path)
    if (written === developer || surviving.has(developer)) continue
    if (conflicted.has(path)) {
      if (!input.stagedCopiesKept.has(path) && (yield* at(input.publicWorkingTree, path)) !== developer) flag(path, "staged")
      continue
    }
    const winner = yield* at(input.winnerIndex, path)
    if (written !== winner || winner === developer) continue
    flag(path, "staged")
  }
  return [...flagged].map(([path, layers]) => ({ path, layers: [...layers] })) satisfies PublicEditAtRisk[]
})

const treeEntry = Effect.fn("ArenaGit.treeEntry")(function* (git: Git.Interface, root: string, tree: string, path: string) {
  const result = yield* git.run(["rev-parse", "--verify", "--quiet", `${tree}:${path}`], { cwd: root })
  return result.exitCode === 0 ? output(result) : undefined
})

/** Three-way merge of blobs with `git merge-file`; returns the merged blob OID. */
const mergeBlobs = Effect.fn("ArenaGit.mergeBlobs")(function* (
  git: Git.Interface,
  root: string,
  blobs: { readonly base?: string; readonly ours?: string; readonly theirs?: string },
) {
  const scratch = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-arena-merge-")))
  return yield* Effect.gen(function* () {
    const content = Effect.fn(function* (oid: string | undefined) {
      if (!oid) return Buffer.alloc(0)
      return (yield* run(git, root, "read_merge_blob", ["cat-file", "blob", oid], { maxOutputBytes: 100 * 1024 * 1024 })).stdout
    })
    const files = { ours: join(scratch, "ours"), base: join(scratch, "base"), theirs: join(scratch, "theirs") }
    const [ours, base, theirs] = [yield* content(blobs.ours), yield* content(blobs.base), yield* content(blobs.theirs)]
    yield* Effect.promise(() =>
      Promise.all([writeFile(files.ours, ours), writeFile(files.base, base), writeFile(files.theirs, theirs)]),
    )
    const merged = yield* git.run(
      ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", files.ours, files.base, files.theirs],
      { cwd: root, maxOutputBytes: 100 * 1024 * 1024 },
    )
    // merge-file exits with the conflict count, capped at 127; anything else is an error.
    if (merged.exitCode < 0 || merged.exitCode > 127) {
      const detail = merged.stderr.toString("utf8").trim() || "git merge-file failed"
      return yield* Effect.fail(new OperationError("merge_blobs", detail))
    }
    return yield* read(git, root, "write_merged_blob", ["hash-object", "-w", "--stdin"], {
      stdin: Stream.make(new Uint8Array(merged.stdout)),
    })
  }).pipe(Effect.ensuring(Effect.promise(() => rm(scratch, { recursive: true, force: true }).catch(() => undefined))))
})

/** Replace a path's blob while preserving its mode; new paths default to 100644. */
const replaceTreeEntry = Effect.fn("ArenaGit.replaceTreeEntry")(function* (
  git: Git.Interface,
  root: string,
  tree: string,
  path: string,
  blob: string | undefined,
) {
  const index = join(tmpdir(), `opencode-arena-index-${randomUUID()}`)
  return yield* Effect.gen(function* () {
    const env = { GIT_INDEX_FILE: index }
    yield* run(git, root, "load_tree_for_edit", ["read-tree", tree], { env })
    if (blob === undefined) {
      yield* run(git, root, "remove_tree_entry", ["update-index", "--force-remove", "--", path], { env })
    } else {
      const entry = yield* read(
        git,
        root,
        "read_tree_entry_mode",
        ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
        { env },
      )
      const mode = entry ? entry.slice(0, 6) : "100644"
      yield* run(git, root, "replace_tree_entry", ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], {
        env,
      })
    }
    return yield* read(git, root, "write_edited_tree", ["write-tree"], { env })
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        Promise.all([unlink(index).catch(() => undefined), unlink(`${index}.lock`).catch(() => undefined)]),
      ),
    ),
  )
})

/**
 * Bring the working tree from one snapshot to another by touching only the paths that differ.
 * Untracked files in the snapshots are ordinary entries; ignored files are in neither and are
 * never touched.
 */
const writeTreeToWorktree = Effect.fn("ArenaGit.writeTreeToWorktree")(function* (
  git: Git.Interface,
  root: string,
  from: string,
  to: string,
) {
  if (from === to) return
  const listing = yield* read(git, root, "read_worktree_delta", ["diff-tree", "-r", "-z", "--no-renames", from, to])
  const fields = listing.split("\0")
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]
    const path = fields[i + 1]
    if (!meta || !path) continue
    const [, dstMode, , dstOid, status] = meta.slice(1).split(" ")
    const target = join(root, path)
    if (status === "D" || !dstMode || !dstOid) {
      yield* Effect.promise(() => rm(target, { force: true, recursive: false }).catch(() => undefined))
      continue
    }
    if (dstMode === "160000") continue
    const blob = yield* run(git, root, "read_worktree_blob", ["cat-file", "blob", dstOid], { maxOutputBytes: 200 * 1024 * 1024 })
    yield* Effect.promise(async () => {
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true, recursive: true }).catch(() => undefined)
      if (dstMode === "120000") {
        await symlink(blob.stdout.toString("utf8"), target)
        return
      }
      await writeFile(target, blob.stdout, { mode: dstMode === "100755" ? 0o755 : 0o644 })
      if (dstMode === "100755") await chmod(target, 0o755)
    })
  }
})

/** Complete a successful promotion after its result has been durably persisted by the service. */
export const finishWinnerPromotion = Effect.fn("ArenaGit.finishWinnerPromotion")(function* (input: {
  readonly canonical: string
  readonly safetyRef: string
  /**
   * Keep the safety refs after a successful promotion. A discarded promotion is the one case
   * where they are the only copy of work the user had: deleting them would make the discard
   * unrecoverable, so they outlive the turn and the UI hands out the ref name.
   */
  readonly retainSafetyRef?: boolean
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_finish_winner_root", ["rev-parse", "--show-toplevel"])
  const conflicts = yield* conflictPaths(git, root)
  if (conflicts.length > 0) {
    return yield* Effect.fail(new OperationError("verify_winner_conflicts", `Unresolved files: ${conflicts.join(", ")}`))
  }
  if (input.retainSafetyRef) {
    yield* run(git, root, "delete_winner_branch_marker", ["update-ref", "-d", promotionBranchMarkerRef(input.safetyRef)])
    return
  }
  yield* run(git, root, "delete_winner_safety_ref", ["update-ref", "-d", input.safetyRef])
  yield* run(git, root, "delete_winner_index_safety_ref", ["update-ref", "-d", safetyIndexRef(input.safetyRef)])
  yield* run(git, root, "delete_winner_branch_marker", ["update-ref", "-d", promotionBranchMarkerRef(input.safetyRef)])
  yield* run(git, root, "delete_winner_target_tip_ref", ["update-ref", "-d", targetTipRef(input.safetyRef)])
  yield* run(git, root, "delete_winner_target_existing_ref", ["update-ref", "-d", targetExistingRef(input.safetyRef)])
  yield* run(git, root, "delete_winner_target_written_ref", ["update-ref", "-d", targetWrittenRef(input.safetyRef)])
})

/** Restore the exact pre-promotion state from the private safety refs. */
export const restorePublicChanges = Effect.fn("ArenaGit.restorePublicChanges")(function* (input: {
  readonly canonical: string
  readonly safetyRef: string
  readonly safetyIndexRef?: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_restore_root", ["rev-parse", "--show-toplevel"])
  const indexRef = input.safetyIndexRef ?? safetyIndexRef(input.safetyRef)
  const originalHead = yield* read(git, root, "read_public_safety_parent", ["rev-parse", `${input.safetyRef}^`])
  const indexTree = yield* read(git, root, "read_public_index_snapshot", ["rev-parse", `${indexRef}^{tree}`])
  const stagedPatch = yield* diffTrees(git, root, originalHead, indexTree)
  const stagedConflicts = yield* applyIndexAndWorktreePatch(git, root, stagedPatch)
  if (stagedConflicts.length > 0) return stagedConflicts
  const worktreePatch = yield* diffTrees(git, root, indexTree, input.safetyRef)
  return yield* applyPlainWorktreePatch(git, root, worktreePatch)
})

export const finishPublicRestore = Effect.fn("ArenaGit.finishPublicRestore")(function* (input: {
  readonly canonical: string
  readonly safetyRef: string
  readonly safetyIndexRef?: string
  readonly retainSafetyRef?: boolean
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_finish_restore_root", ["rev-parse", "--show-toplevel"])
  const conflicts = yield* conflictPaths(git, root)
  if (conflicts.length > 0) {
    return yield* Effect.fail(new OperationError("verify_public_restore", `Unresolved files: ${conflicts.join(", ")}`))
  }
  if (!input.retainSafetyRef) {
    yield* run(git, root, "delete_public_safety_ref", ["update-ref", "-d", input.safetyRef])
    yield* run(git, root, "delete_public_index_safety_ref", ["update-ref", "-d", input.safetyIndexRef ?? safetyIndexRef(input.safetyRef)])
  }
})

export const recoverFailedPromotion = Effect.fn("ArenaGit.recoverFailedPromotion")(function* (input: {
  readonly canonical: string
  readonly safetyRef: string
  readonly safetyIndexRef?: string
  readonly expectedBranch?: string
  readonly expectedDetached?: boolean
  readonly targetBranch?: string
}) {
  const git = yield* Git.Service
  const root = yield* read(git, input.canonical, "find_failed_promotion_root", ["rev-parse", "--show-toplevel"])
  const safety = yield* git.run(["show-ref", "--verify", "--quiet", input.safetyRef], { cwd: root })
  if (safety.exitCode === 1) return false
  if (safety.exitCode !== 0) return yield* Effect.fail(new OperationError("inspect_public_safety_ref", "Failed to inspect public safety ref"))
  const indexRef = input.safetyIndexRef ?? safetyIndexRef(input.safetyRef)
  const originalHead = yield* read(git, root, "read_failed_promotion_parent", ["rev-parse", `${input.safetyRef}^`])
  const branchMarkerRef = promotionBranchMarkerRef(input.safetyRef)
  const branchMarker = yield* git.run(["show-ref", "--verify", "--quiet", branchMarkerRef], { cwd: root })
  if (branchMarker.exitCode !== 0 && branchMarker.exitCode !== 1) {
    return yield* Effect.fail(new OperationError("inspect_winner_branch_marker", "Failed to inspect winner branch recovery state"))
  }
  const createdTargetBranch = branchMarker.exitCode === 0
  if (createdTargetBranch && !input.targetBranch) {
    return yield* Effect.fail(new OperationError("restore_winner_branch", "Winning branch recovery is missing its target branch"))
  }
  const existingMarker = yield* git.run(["show-ref", "--verify", "--quiet", targetExistingRef(input.safetyRef)], { cwd: root })
  if (existingMarker.exitCode !== 0 && existingMarker.exitCode !== 1) {
    return yield* Effect.fail(new OperationError("inspect_target_branch_marker", "Failed to inspect existing-branch recovery state"))
  }
  const movedExistingBranch = existingMarker.exitCode === 0
  if (movedExistingBranch && !input.targetBranch) {
    return yield* Effect.fail(new OperationError("restore_target_branch", "Existing-branch recovery is missing its target branch"))
  }
  if (movedExistingBranch) {
    // HEAD is still on the target branch. A `reset --hard` now would drag that branch along,
    // so detach first, then put the branch back where it was.
    const targetRef = `refs/heads/${input.targetBranch!}`
    const savedTip = yield* read(git, root, "read_saved_target_tip", ["rev-parse", "--verify", targetTipRef(input.safetyRef)])
    const currentTip = yield* read(git, root, "read_current_target_tip", ["rev-parse", "--verify", targetRef])
    const written = yield* git.run(["rev-parse", "--verify", "--quiet", targetWrittenRef(input.safetyRef)], { cwd: root })
    const writtenTip = written.exitCode === 0 ? output(written) : undefined
    // The branch may sit at the saved tip, at the commit the promotion wrote (a rewrite is not
    // above the saved tip), or at a replayed commit above the saved tip. Anything else means
    // someone moved it, and Arena must not move it back.
    if (currentTip !== savedTip && currentTip !== writtenTip && !(yield* isAncestor(git, root, savedTip, currentTip))) {
      return yield* Effect.fail(
        new OperationError("restore_target_branch", `The target branch ${input.targetBranch} moved during recovery`),
      )
    }
    yield* run(git, root, "detach_from_target_branch", ["checkout", "--detach", "--force", currentTip])
    if (currentTip !== savedTip) {
      yield* run(git, root, "restore_target_branch_tip", ["update-ref", targetRef, savedTip, currentTip])
    }
  }
  yield* run(git, root, "reset_failed_promotion", ["reset", "--hard", originalHead])
  yield* run(git, root, "clean_failed_promotion", ["clean", "-fd", "--", "."])
  if (createdTargetBranch || movedExistingBranch) {
    if (input.expectedBranch) {
      const originalBranchRef = `refs/heads/${input.expectedBranch}`
      const originalBranchHead = yield* read(git, root, "verify_original_promotion_branch", [
        "rev-parse",
        "--verify",
        originalBranchRef,
      ])
      if (originalBranchHead !== originalHead) {
        return yield* Effect.fail(
          new OperationError("restore_winner_branch", `The original branch ${input.expectedBranch} changed during recovery`),
        )
      }
      yield* run(git, root, "restore_original_promotion_branch", ["symbolic-ref", "HEAD", originalBranchRef])
      yield* run(git, root, "checkout_original_promotion_branch", ["reset", "--hard", originalHead])
    } else if (input.expectedDetached) {
      yield* run(git, root, "restore_original_detached_head", ["checkout", "--detach", "--force", originalHead])
    } else {
      return yield* Effect.fail(new OperationError("restore_winner_branch", "Original checkout identity is missing"))
    }
    if (createdTargetBranch) {
      yield* run(git, root, "delete_failed_winner_branch", [
        "update-ref",
        "-d",
        `refs/heads/${input.targetBranch!}`,
      ])
    }
  }
  const restored = yield* restorePublicChanges({ canonical: root, safetyRef: input.safetyRef, safetyIndexRef: indexRef }).pipe(
    Effect.provideService(Git.Service, git),
  )
  if (restored.length > 0) return yield* Effect.fail(new OperationError("restore_failed_promotion", restored.join(", ")))
  yield* run(git, root, "delete_failed_promotion_safety_ref", ["update-ref", "-d", input.safetyRef])
  yield* run(git, root, "delete_failed_promotion_index_ref", ["update-ref", "-d", indexRef])
  yield* run(git, root, "delete_failed_winner_branch_marker", ["update-ref", "-d", branchMarkerRef])
  yield* run(git, root, "delete_failed_target_tip_ref", ["update-ref", "-d", targetTipRef(input.safetyRef)])
  yield* run(git, root, "delete_failed_target_existing_ref", ["update-ref", "-d", targetExistingRef(input.safetyRef)])
  yield* run(git, root, "delete_failed_target_written_ref", ["update-ref", "-d", targetWrittenRef(input.safetyRef)])
  return true
})

// One changed run as git reports it with --unified=0: where it sits in the base file and
// where the same content sits in the side's file. A pure insertion has baseCount 0 and is
// anchored after baseStart; a pure deletion has sideCount 0.
export type PatchHunk = {
  readonly baseStart: number
  readonly baseCount: number
  readonly sideStart: number
  readonly sideCount: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseHunks(patch: string): PatchHunk[] {
  return patch.split(/\r?\n/).flatMap((line) => {
    const match = line.match(HUNK_HEADER)
    if (!match) return []
    return [
      {
        baseStart: Number.parseInt(match[1] ?? "0", 10),
        baseCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
        sideStart: Number.parseInt(match[3] ?? "0", 10),
        sideCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
      },
    ]
  })
}

type LineRange = { start: number; end: number }

function hunkBaseEnd(hunk: PatchHunk): number {
  return hunk.baseCount === 0 ? hunk.baseStart : hunk.baseStart + hunk.baseCount - 1
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    // Touching counts as overlapping: two windows a line apart would render as an
    // omission band with nothing in it.
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

// Where a base line lands in a side's file. `inclusive` counts a hunk that ends exactly at
// the line, which is what a window's last line wants; a window's first line wants the
// count before it. Both round outward, so a window never loses a line it should have kept.
function mapBaseLine(hunks: readonly PatchHunk[], line: number, inclusive: boolean): number {
  let delta = 0
  for (const hunk of hunks) {
    const anchor = inclusive ? hunk.baseStart : hunkBaseEnd(hunk) + 1
    if (anchor > line) break
    delta += hunk.sideCount - hunk.baseCount
  }
  return line + delta
}

function clampRange(range: LineRange, lines: number): LineRange {
  return { start: Math.max(1, Math.min(range.start, lines || 1)), end: Math.max(0, Math.min(range.end, lines)) }
}

// Turns the changed runs of both sides into windows over the base file, then carries each
// window into A's and B's own line numbering. The three sides come out with the same
// number of windows in the same order, which is what lets the viewer line them up: window
// k of A, base, and B all describe the same part of the file.
export function planWindows(input: {
  readonly hunksA: readonly PatchHunk[]
  readonly hunksB: readonly PatchHunk[]
  readonly baseLines: number
  readonly aLines: number
  readonly bLines: number
  readonly context?: number
}): { base: LineRange[]; a: LineRange[]; b: LineRange[] } {
  const context = input.context ?? WINDOW_CONTEXT_LINES
  const seeds = [...input.hunksA, ...input.hunksB].map((hunk) => ({
    start: hunk.baseStart - context,
    end: hunkBaseEnd(hunk) + context,
  }))
  let base = mergeRanges(seeds).map((range) => clampRange(range, input.baseLines))

  // Mapping rounds outward, so two base windows that do not touch can still produce
  // overlapping windows on a side. Overlap would duplicate lines, so fold them together in
  // base space and map again until every side comes out disjoint.
  for (let pass = 0; pass < 8; pass += 1) {
    const a = base.map((range) => mapWindow(input.hunksA, range, input.aLines))
    const b = base.map((range) => mapWindow(input.hunksB, range, input.bLines))
    const collision = base.findIndex(
      (_, index) => index > 0 && (a[index]!.start <= a[index - 1]!.end + 1 || b[index]!.start <= b[index - 1]!.end + 1),
    )
    if (collision === -1) return { base, a, b }
    base = mergeRanges([
      ...base.slice(0, collision - 1),
      { start: base[collision - 1]!.start, end: Math.max(base[collision - 1]!.end, base[collision]!.end) },
      ...base.slice(collision + 1),
    ])
  }
  return {
    base,
    a: base.map((range) => mapWindow(input.hunksA, range, input.aLines)),
    b: base.map((range) => mapWindow(input.hunksB, range, input.bLines)),
  }
}

export function mapWindows(hunks: readonly PatchHunk[], ranges: readonly LineRange[], lines: number): LineRange[] {
  return ranges.map((range) => mapWindow(hunks, range, lines))
}

function mapWindow(hunks: readonly PatchHunk[], range: LineRange, lines: number): LineRange {
  return clampRange({ start: mapBaseLine(hunks, range.start, false), end: mapBaseLine(hunks, range.end, true) }, lines)
}

// Slices a side's text down to the planned windows. Windows are dropped from the tail
// once the retained text passes the wire budget, and the caller drops the same ones from
// every side so the three stay in step.
export function countLines(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split("\n")
  // A file ending in a newline splits to a trailing empty entry that git does not number.
  return text.endsWith("\n") ? lines.length - 1 : lines.length
}

export function retainWindows(text: string, ranges: readonly LineRange[]): FileContent {
  const lines = text.split("\n")
  const kept: string[] = []
  const regions: FileRegion[] = []
  for (const range of ranges) {
    if (range.end < range.start) continue
    const slice = lines.slice(range.start - 1, range.end)
    if (slice.length === 0) continue
    kept.push(...slice)
    regions.push({ start: range.start, lines: slice.length })
  }
  return { content: kept.join("\n"), truncated: false, missing: false, regions }
}

// The degenerate retention: no shared axis to plan windows on, so keep as much of the head
// of this side as the budget allows, cut on a line boundary.
function headWindow(side: FileContent, budget: number): FileContent {
  if (side.missing || side.content.length <= budget) return side
  const lines = side.content.split("\n")
  let kept = 0
  let bytes = 0
  while (kept < lines.length && bytes + lines[kept]!.length + (kept > 0 ? 1 : 0) <= budget) {
    bytes += lines[kept]!.length + (kept > 0 ? 1 : 0)
    kept += 1
  }
  return {
    content: lines.slice(0, kept).join("\n"),
    truncated: true,
    missing: false,
    regions: kept > 0 ? [{ start: 1, lines: kept }] : [],
    lines: countLines(side.content),
  }
}

// One retention decision for a whole file: the same windows are kept on every side, and
// the same ones are dropped when the wire budget runs out, so the three columns can never
// disagree about which part of the file the reader is looking at. A side that does not
// have the file at all keeps its missing marker and no windows.
export function windowFile(input: {
  readonly base: FileContent
  readonly a: FileContent
  readonly b: FileContent
  readonly hunksA: readonly PatchHunk[]
  readonly hunksB: readonly PatchHunk[]
  readonly budget?: number
  readonly context?: number
}): { base: FileContent; a: FileContent; b: FileContent } {
  const budget = input.budget ?? MAX_RETAINED_BYTES
  const baseLines = countLines(input.base.content)
  const aLines = countLines(input.a.content)
  const bLines = countLines(input.b.content)

  // A file added in this turn has no base line numbers to plan over, so there is no shared
  // axis to window on. Each side keeps its head instead, which for a new file is the part
  // worth reading anyway.
  if (input.base.missing) {
    return {
      base: input.base,
      a: headWindow(input.a, budget),
      b: headWindow(input.b, budget),
    }
  }

  // A side that does not have the file reports one hunk covering all of it. That says
  // nothing about where to look, and taking it as a seed would plan a window over the whole
  // file and squeeze out the side that did make a located change.
  const planned = planWindows({
    hunksA: input.a.missing ? [] : input.hunksA,
    hunksB: input.b.missing ? [] : input.hunksB,
    baseLines,
    aLines,
    bLines,
    ...(input.context === undefined ? {} : { context: input.context }),
  })

  const cut = (ranges: readonly LineRange[]) => ({
    base: retainWindows(input.base.content, ranges),
    a: retainWindows(input.a.content, mapWindows(input.hunksA, ranges, aLines)),
    b: retainWindows(input.b.content, mapWindows(input.hunksB, ranges, bLines)),
  })
  const over = (cutting: { base: FileContent; a: FileContent; b: FileContent }) =>
    cutting.base.content.length > budget || cutting.a.content.length > budget || cutting.b.content.length > budget

  // No located change to plan around -- both sides deleted the file, or git reported no
  // hunks at all. The head of the file is all that can honestly be offered, and the shrink
  // below cuts it to fit on a line boundary.
  let ranges = planned.base.length > 0 ? [...planned.base] : [{ start: 1, end: baseLines }]
  let dropped = false
  while (ranges.length > 1 && over(cut(ranges))) {
    ranges = ranges.slice(0, -1)
    dropped = true
  }
  // A single window over budget is a file that was rewritten wholesale. Shrink it from the
  // end in base line numbers and carry the shrink through the mapping, so the three sides
  // still stop at the same point in the file rather than at their own byte counts -- three
  // independent cuts land mid-line in three different places and render as a change no
  // agent made.
  if (over(cut(ranges))) {
    const only = ranges[0]!
    let low = only.start - 1
    let high = only.end
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (over(cut([{ start: only.start, end: middle }]))) high = middle - 1
      else low = middle
    }
    ranges = low >= only.start ? [{ start: only.start, end: low }] : []
    dropped = true
  }

  // The windows ended up covering everything anyway, and nothing was dropped: hand back the
  // file itself rather than an identical copy carrying regions that say "all of it".
  if (!dropped && ranges.length === 1 && ranges[0]!.start === 1 && ranges[0]!.end >= baseLines) {
    return { base: input.base, a: input.a, b: input.b }
  }

  const retained = cut(ranges)
  const mark = (side: FileContent, windowed: FileContent, lines: number): FileContent =>
    side.missing ? side : { ...windowed, truncated: side.truncated || dropped, missing: false, lines }
  return {
    base: mark(input.base, retained.base, baseLines),
    a: mark(input.a, retained.a, aLines),
    b: mark(input.b, retained.b, bLines),
  }
}

const readBlob = Effect.fn("ArenaGit.readBlob")(function* (
  git: Git.Interface,
  cwd: string,
  tree: string,
  file: string,
  maxOutputBytes: number,
) {
  const result = yield* git.run(["show", `${tree}:${file}`], { cwd, maxOutputBytes })
  // A non-zero exit here means the path does not exist in this tree (added or
  // deleted relative to it), not a real git failure -- that is expected for most
  // files in a three-way comparison and must not surface as an error.
  if (result.exitCode !== 0) return { content: "", truncated: false, missing: true } satisfies FileContent
  return { content: result.text(), truncated: result.truncated, missing: false } satisfies FileContent
})

type FileStatsEntry = {
  additionsA: number
  deletionsA: number
  binaryA: boolean
  additionsB: number
  deletionsB: number
  binaryB: boolean
}

function mergeFileStats(statsA: readonly DiffStat[], statsB: readonly DiffStat[]) {
  const merged = new Map<string, FileStatsEntry>()
  for (const stat of statsA) {
    merged.set(stat.file, {
      additionsA: stat.additions,
      deletionsA: stat.deletions,
      binaryA: stat.binary,
      additionsB: 0,
      deletionsB: 0,
      binaryB: false,
    })
  }
  for (const stat of statsB) {
    const existing = merged.get(stat.file)
    if (existing) {
      existing.additionsB = stat.additions
      existing.deletionsB = stat.deletions
      existing.binaryB = stat.binary
    } else {
      merged.set(stat.file, {
        additionsA: 0,
        deletionsA: 0,
        binaryA: false,
        additionsB: stat.additions,
        deletionsB: stat.deletions,
        binaryB: stat.binary,
      })
    }
  }
  return merged
}

export function divergenceStatus(input: {
  readonly binary: boolean
  readonly inA: boolean
  readonly inB: boolean
  readonly differs: boolean
  readonly conflicted: boolean
}): DivergenceStatus {
  if (input.binary) return "binary"
  if (input.conflicted) return "diverging"
  if (input.inA && !input.inB) return "only_a"
  if (input.inB && !input.inA) return "only_b"
  if (!input.differs) return "identical"
  return "compatible"
}

// merge-tree exits 0 for a clean merge and 1 for a conflicted one, both with a tree on
// the first line; anything else is a failure the comparison survives without a merge.
function parseMergeTree(result: Git.Result): { tree: string; conflicted: boolean; conflicts: Set<string> } | null {
  if (result.exitCode !== 0 && result.exitCode !== 1) return null
  const [tree, ...rest] = output(result).split(/\r?\n/)
  if (!tree) return null
  return {
    tree,
    conflicted: result.exitCode === 1,
    conflicts: new Set(result.exitCode === 0 ? [] : conflictedPaths(rest)),
  }
}

export const compare = Effect.fn("ArenaGit.compare")(
  function* (input: {
    readonly canonical: string
    readonly baseCommit: string
    readonly aCommit: string
    readonly bCommit: string
    readonly maxOutputBytes?: number
  }) {
    const git = yield* Git.Service
    const root = yield* read(git, input.canonical, "find_canonical_root", ["rev-parse", "--show-toplevel"])
    const readDiffMetadata = Effect.fnUntraced(function* (operation: string, args: string[]) {
      const result = yield* run(git, root, operation, args, { maxOutputBytes: 16 * 1024 * 1024 })
      if (result.truncated) {
        return yield* Effect.fail(new OperationError(operation, "Comparison metadata exceeds the 16 MiB output limit"))
      }
      return output(result)
    })
    const [baseTree, aTree, bTree, stats, baseToAStats, baseToBStats, baseToA, baseToB, aToB, mergeResult] =
      yield* Effect.all([
        read(git, root, "read_base_tree", ["rev-parse", `${input.baseCommit}^{tree}`]),
        read(git, root, "read_a_tree", ["rev-parse", `${input.aCommit}^{tree}`]),
        read(git, root, "read_b_tree", ["rev-parse", `${input.bCommit}^{tree}`]),
        readDiffMetadata("read_comparison_stats", [
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--numstat",
          input.aCommit,
          input.bCommit,
          "--",
          ".",
        ]),
        readDiffMetadata("read_base_to_a_stats", [
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--numstat",
          input.baseCommit,
          input.aCommit,
          "--",
          ".",
        ]),
        readDiffMetadata("read_base_to_b_stats", [
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--numstat",
          input.baseCommit,
          input.bCommit,
          "--",
          ".",
        ]),
        run(
          git,
          root,
          "read_base_to_a_patch",
          ["diff", "--no-ext-diff", "--no-renames", "--binary", input.baseCommit, input.aCommit, "--", "."],
          { maxOutputBytes: input.maxOutputBytes ?? 10 * 1024 * 1024 },
        ),
        run(
          git,
          root,
          "read_base_to_b_patch",
          ["diff", "--no-ext-diff", "--no-renames", "--binary", input.baseCommit, input.bCommit, "--", "."],
          { maxOutputBytes: input.maxOutputBytes ?? 10 * 1024 * 1024 },
        ),
        run(
          git,
          root,
          "read_comparison_patch",
          ["diff", "--no-ext-diff", "--no-renames", "--binary", input.aCommit, input.bCommit, "--", "."],
          { maxOutputBytes: input.maxOutputBytes ?? 10 * 1024 * 1024 },
        ),
        // git's own verdict on where the two sides disagree. zdiff3 keeps the conflict blocks
        // as small as diff3 can make them and carries the base in the middle. Exit 1 is a
        // conflicted merge, not a failure; both leave the tree on the first line.
        git.run(
          [
            "-c",
            "merge.conflictStyle=zdiff3",
            "merge-tree",
            "--write-tree",
            `--merge-base=${input.baseCommit}`,
            input.aCommit,
            input.bCommit,
          ],
          { cwd: root, maxOutputBytes: 16 * 1024 * 1024 },
        ),
      ])

    if (mergeResult.truncated) {
      return yield* Effect.fail(
        new OperationError("merge_candidates", "Comparison merge metadata exceeds the output limit"),
      )
    }
    const statsA = parseStats(baseToAStats)
    const statsB = parseStats(baseToBStats)
    const merged = mergeFileStats(statsA, statsB)
    const allFiles = Array.from(merged.entries())
    const filesToFetch = allFiles.slice(0, MAX_THREE_WAY_FILES)
    const filesTruncated = allFiles.length > filesToFetch.length

    // Equal trees need no merge: the merge is either side. Anything past exit 1 is a
    // failure like any other git failure here.
    const mergeTree =
      aTree === bTree ? { tree: aTree, conflicted: false, conflicts: new Set<string>() } : parseMergeTree(mergeResult)
    if (!mergeTree) {
      const detail = mergeResult.stderr.toString("utf8").trim() || output(mergeResult) || "git merge-tree failed"
      return yield* Effect.fail(new OperationError("merge_candidates", detail))
    }
    const inA = new Set(statsA.map((stat) => stat.file))
    const inB = new Set(statsB.map((stat) => stat.file))
    const differs = new Set(parseStats(stats).map((stat) => stat.file))
    const statusOf = (file: string, binary: boolean) =>
      divergenceStatus({
        binary,
        inA: inA.has(file),
        inB: inB.has(file),
        differs: differs.has(file),
        conflicted: mergeTree.conflicts.has(file),
      })

    const pairs = yield* Effect.forEach(
      filesToFetch,
      ([file, entry]) =>
        Effect.gen(function* () {
          const binary = entry.binaryA || entry.binaryB
          if (binary) {
            return {
              file: { file, binary: true, ...entry } satisfies ThreeWayFile,
              divergence: { file, status: "binary" } satisfies DivergenceFile,
            }
          }
          const [base, a, b] = yield* Effect.all([
            readBlob(git, root, baseTree, file, MAX_BLOB_READ_BYTES),
            readBlob(git, root, aTree, file, MAX_BLOB_READ_BYTES),
            readBlob(git, root, bTree, file, MAX_BLOB_READ_BYTES),
          ])
          const status = statusOf(file, false)
          if (
            base.content.length <= MAX_WHOLE_FILE_BYTES &&
            a.content.length <= MAX_WHOLE_FILE_BYTES &&
            b.content.length <= MAX_WHOLE_FILE_BYTES
          ) {
            // The merged text is only worth sending where the two sides both touched the
            // file: elsewhere it equals one side's content, which the viewer already has.
            const wantsMerged = status === "compatible" || status === "diverging"
            const mergedBlob = wantsMerged
              ? yield* readBlob(git, root, mergeTree.tree, file, MAX_MERGED_FILE_BYTES + 1)
              : null
            const mergedFits =
              mergedBlob &&
              !mergedBlob.missing &&
              !mergedBlob.truncated &&
              mergedBlob.content.length <= MAX_MERGED_FILE_BYTES
            return {
              file: { file, binary: false, ...entry, base, a, b } satisfies ThreeWayFile,
              divergence: {
                file,
                status,
                ...(mergedFits ? { merged: mergedBlob } : {}),
              } satisfies DivergenceFile,
            }
          }
          const [patchA, patchB] = yield* Effect.all([
            readDiffMetadata("read_file_hunks_a", [
              "diff",
              "--no-ext-diff",
              "--no-renames",
              "--unified=0",
              input.baseCommit,
              input.aCommit,
              "--",
              file,
            ]),
            readDiffMetadata("read_file_hunks_b", [
              "diff",
              "--no-ext-diff",
              "--no-renames",
              "--unified=0",
              input.baseCommit,
              input.bCommit,
              "--",
              file,
            ]),
          ])
          const windowed = windowFile({
            base,
            a,
            b,
            hunksA: parseHunks(patchA),
            hunksB: parseHunks(patchB),
          })
          return {
            file: { file, binary: false, ...entry, ...windowed } satisfies ThreeWayFile,
            divergence: { file, status } satisfies DivergenceFile,
          }
        }),
      { concurrency: 6 },
    )
    const files = pairs.map((pair) => pair.file)
    const divergence: Divergence = {
      mergeTree: mergeTree.tree,
      conflicted: mergeTree.conflicted,
      files: pairs.map((pair) => pair.divergence),
    }

    return {
      baseTree,
      aTree,
      bTree,
      baseToA: baseToA.text(),
      baseToATruncated: baseToA.truncated,
      baseToB: baseToB.text(),
      baseToBTruncated: baseToB.truncated,
      patch: aToB.text(),
      truncated: aToB.truncated,
      stats: parseStats(stats),
      fileFacts: allFiles.map(([file, entry]) => ({
        file,
        ...entry,
        changedA: inA.has(file),
        changedB: inB.has(file),
        sameResult: !differs.has(file),
      })),
      files,
      filesTruncated,
      divergence,
    } satisfies ComparisonEvidence
  },
  comparisonSlot.withPermits(1),
  Effect.timeoutOrElse({
    duration: "15 seconds",
    orElse: () => Effect.fail(new OperationError("compare", "Battle comparison exceeded the 15 second time limit")),
  }),
)

export * as ArenaGit from "./git"
