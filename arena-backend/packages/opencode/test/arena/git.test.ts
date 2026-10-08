import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  applyFastForward,
  acceptWinnerConflicts,
  hasCherryPickInProgress,
  applyPromotionState,
  applySnapshot,
  attachSideBranch,
  battleRefs,
  compare,
  containsCommit,
  diffHostRefs,
  finalize,
  OperationError,
  preparePromotion,
  prepareSideBranch,
  recoverFailedPromotion,
  refLabel,
  refreshAttachedSide,
  repositoryKey,
  resetSideBranch,
  restorePublicChanges,
  selectResult,
  sideBranchName,
  snapshotBase,
  snapshotHostRefs,
  resultPatch,
  syncContestantState,
  type SyncedContestantState,
  type VerifyContestantStateInput,
  verifyContestantState,
  finishPublicRestore,
  finishWinnerPromotion,
  importResultRef,
  importWinnerRef,
  inspectCanonical,
  mirrorCanonicalRefs,
  inspectBranchTarget,
  observeWinnerRefs,
  reportCheckoutMove,
  type CheckoutMove,
  repositoryOperation,
  writeWinnerRefs,
  holdWinnerRefs,
  editsFingerprint,
  prepareContestantState,
  promoteWinnerState,
  publicEditsAtRiskMessage,
  TRUNK_CONFLICT_OPERATION,
  unrecoverablePublicEdits,
  unresolvedConflictPaths,
} from "../../src/arena/git"
import { decideRef, type BranchAction } from "../../src/arena/branch-review"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

for (const scenario of [
  {
    name: "executable script",
    mode: 0o755,
    gitMode: "100755",
    staged: "developer",
    working: "developer",
    index: "#!/bin/sh\necho developer\n",
    command: "./run [qa].sh",
  },
  {
    name: "non-executable script",
    mode: 0o644,
    gitMode: "100644",
    staged: "developer",
    working: "developer",
    index: "#!/bin/sh\necho developer\n",
    command: "sh",
  },
  {
    name: "additional developer edit",
    mode: 0o755,
    gitMode: "100755",
    staged: "developer",
    working: "working",
    index: "#!/bin/sh\necho developer\n",
    command: "./run [qa].sh",
  },
  {
    name: "distinct staged and working copies",
    mode: 0o755,
    gitMode: "100755",
    staged: "staged",
    working: "working",
    index: "#!/bin/sh\n<<<<<<< ours\necho staged\n=======\necho winner\n>>>>>>> theirs\n",
    command: "./run [qa].sh",
  },
]) {
  it.live(`ArenaGit preserves file mode for a conflict with ${scenario.name}`, () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const script = "run [qa].sh"
      const filename = `${canonical.path}/${script}`
      yield* Effect.promise(() => fs.writeFile(filename, "#!/bin/sh\necho base\n", { mode: scenario.mode }))
      yield* Effect.promise(() => $`git add . && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
      )
      const cleanup = Effect.promise(() =>
        $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
      ).pipe(Effect.ignore)
      yield* Effect.addFinalizer(() => cleanup)
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/${script}`, "#!/bin/sh\necho winner\n"))
      yield* Effect.promise(() => $`git commit -am winner`.cwd(candidate.path).quiet())
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/mode/a",
      })
      yield* Effect.promise(() => fs.writeFile(filename, "#!/bin/sh\necho developer\n"))
      yield* Effect.promise(() => $`git commit -am developer`.cwd(canonical.path).quiet())
      const currentHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(filename, `#!/bin/sh\necho ${scenario.staged}\n`))
      yield* Effect.promise(() => $`git --literal-pathspecs add -- ${script}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(filename, `#!/bin/sh\necho ${scenario.working}\n`))
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "combine", start: frozenHead, agent: result.rawHead },
        safetyRef: "refs/battles/mode/safety",
      })
      expect(promoted.conflicts).toEqual([script])
      expect(yield* Effect.promise(() => fs.readFile(filename, "utf8"))).toBe(
        `#!/bin/sh\n<<<<<<< ours\necho ${scenario.working}\n=======\necho winner\n>>>>>>> theirs\n`,
      )
      expect((yield* Effect.promise(() => fs.stat(filename))).mode & 0o777).toBe(scenario.mode)
      const index = (yield* Effect.promise(() =>
        $`git --literal-pathspecs ls-files --stage -- ${script}`.cwd(canonical.path).quiet().text(),
      )).trim()
      expect(index.split(" ")[0]).toBe(scenario.gitMode)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(
        currentHead,
      )
      expect(yield* Effect.promise(() => $`git show ${`:${script}`}`.cwd(canonical.path).quiet().text())).toBe(
        scenario.index,
      )
      yield* Effect.promise(() => fs.writeFile(filename, "#!/bin/sh\necho resolved\n"))
      expect(
        (yield* Effect.promise(() => $`${scenario.command} ${script}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe("resolved")
    }),
  )
}

describe("ArenaGit", () => {
  it.live("prepares staged, unstaged, deleted, and untracked contestant state without changing identity", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/keep.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/delete.txt`, "remove\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add -b contestant ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/keep.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add keep.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/keep.txt`, "staged and unstaged\n", "utf8"))
      yield* Effect.promise(() => $`git rm delete.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/untracked.txt`, "untracked\n", "utf8"))
      const indexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git add -A`.cwd(candidate.path).quiet())
      const workingTree = (yield* Effect.promise(() => $`git write-tree`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git read-tree ${indexTree}`.cwd(candidate.path).quiet())

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/keep.txt`, "wrong\n", "utf8"))
      yield* Effect.promise(() => fs.rm(`${candidate.path}/staged.txt`))
      const prepared = yield* prepareContestantState({ worktree: candidate.path, frozenHead, indexTree, workingTree })
      expect(prepared.branch).toBe("contestant")
      expect(prepared.head).toBe(frozenHead)
      expect(prepared.indexTree).toBe(indexTree)
      expect(prepared.workingTree).toBe(workingTree)
      expect((yield* Effect.promise(() => $`git status --short`.cwd(candidate.path).quiet().text())).trim()).toBe(
        "D  delete.txt\nMM keep.txt\nA  staged.txt\n?? untracked.txt",
      )

      yield* Effect.promise(() => $`git checkout --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/keep.txt`, "detached wrong\n", "utf8"))
      const detached = yield* prepareContestantState({ worktree: candidate.path, frozenHead, indexTree, workingTree })
      expect(detached.branch).toBeUndefined()
      expect(detached.head).toBe(frozenHead)
      expect((yield* Effect.promise(() => $`git status --short`.cwd(candidate.path).quiet().text())).trim()).toBe(
        "D  delete.txt\nMM keep.txt\nA  staged.txt\n?? untracked.txt",
      )
    }),
  )

  it.live("promotes a zero-commit winner over a dirty frozen baseline without changing HEAD", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "baseline\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/baseline.txt`, "baseline\n", "utf8"))
      const baseIndexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git add -A`.cwd(canonical.path).quiet())
      const baseWorkingTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git read-tree ${baseIndexTree}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* prepareContestantState({ worktree: candidate.path, frozenHead, indexTree: baseIndexTree, workingTree: baseWorkingTree })
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/shared.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/concurrent.txt`, "public\n", "utf8"))
      const result = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/high-level/zero" })
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree,
        baseIndexTree,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        safetyRef: "refs/battles/high-level/zero-safety",
      })
      expect(promoted.conflicts).toEqual([])
      expect(promoted.resultingHead).toBe(frozenHead)
      expect((yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "MM shared.txt\n?? baseline.txt\n?? concurrent.txt",
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))).toBe("winner\n")
    }),
  )

  it.live("promotes committed baseline state without reapplying the frozen baseline", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "staged baseline\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/baseline-untracked.txt`, "baseline\n", "utf8"))
      const baseIndexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git add -A`.cwd(canonical.path).quiet())
      const baseWorkingTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git read-tree ${baseIndexTree}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* prepareContestantState({ worktree: candidate.path, frozenHead, indexTree: baseIndexTree, workingTree: baseWorkingTree })
      yield* Effect.promise(() => $`git add shared.txt && git commit -m "winner baseline"`.cwd(candidate.path).quiet())
      const agentCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/residual-staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add residual-staged.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/residual-unstaged.txt`, "unstaged\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/residual-untracked.txt`, "untracked\n", "utf8"))
      const result = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/high-level/committed" })
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree,
        baseIndexTree,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent", start: frozenHead, agent: result.rawHead },
        safetyRef: "refs/battles/high-level/committed-safety",
        retainSafetyRef: true,
      })
      expect(promoted.conflicts).toEqual([])
      expect(promoted.resultingHead).toBe(agentCommit)
      expect((yield* Effect.promise(() => $`git log -1 --format=%s`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "winner baseline",
      )
      expect((yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())).trim()).toContain(
        "A  residual-staged.txt",
      )
      expect((yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())).trim()).toContain(
        "?? residual-untracked.txt",
      )
      expect(
        (yield* Effect.promise(() => $`git rev-parse --verify refs/battles/high-level/committed-safety`.cwd(canonical.path).quiet().text())).trim(),
      ).toBeTruthy()
      yield* finishWinnerPromotion({ canonical: canonical.path, safetyRef: "refs/battles/high-level/committed-safety" })
    }),
  )

  it.live("merges disjoint public edits and leaves overlapping edits conflicted", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const baseIndexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      const baseWorkingTree = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      const winner = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/high-level/merge" })
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public.txt`, "public\n", "utf8"))
      const publicIndexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      const publicWorkingTree = (yield* Effect.promise(() => $`git add -A && git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git read-tree ${publicIndexTree}`.cwd(canonical.path).quiet())
      const merged = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree,
        baseIndexTree,
        resultCommit: winner.finalCommit,
        finalIndexTree: winner.finalIndexTree,
        safetyRef: "refs/battles/high-level/merge-safety",
      })
      expect(merged.conflicts).toEqual([])
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/winner.txt`, "utf8"))).toBe("winner\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/public.txt`, "utf8"))).toBe("public\n")

      const conflictCanonical = yield* scopedTmpdir({ git: true })
      const conflictCandidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${conflictCanonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt && git commit -m base`.cwd(conflictCanonical.path).quiet())
      const conflictHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(conflictCanonical.path).quiet().text())).trim()
      const conflictTree = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(conflictCanonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${conflictCandidate.path} ${conflictHead}`.cwd(conflictCanonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${conflictCandidate.path}`.cwd(conflictCanonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${conflictCandidate.path}/shared.txt`, "winner\n", "utf8"))
      const conflictWinner = yield* finalize({ worktree: conflictCandidate.path, baseSHA: conflictHead, permanentRef: "refs/battles/high-level/conflict" })
      yield* Effect.promise(() => fs.writeFile(`${conflictCanonical.path}/shared.txt`, "public\n", "utf8"))
      const conflictIndex = (yield* Effect.promise(() => $`git write-tree`.cwd(conflictCanonical.path).quiet().text())).trim()
      const conflictWorking = (yield* Effect.promise(() => $`git add -A && git write-tree`.cwd(conflictCanonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git read-tree ${conflictIndex}`.cwd(conflictCanonical.path).quiet())
      const conflicted = yield* promoteWinnerState({
        canonical: conflictCanonical.path,
        frozenHead: conflictHead,
        baseWorkingTree: conflictTree,
        baseIndexTree: conflictTree,
        resultCommit: conflictWinner.finalCommit,
        finalIndexTree: conflictWinner.finalIndexTree,
        safetyRef: "refs/battles/high-level/conflict-safety",
      })
      expect(conflicted.conflicts).toEqual(["shared.txt"])
      expect(yield* Effect.promise(() => fs.readFile(`${conflictCanonical.path}/shared.txt`, "utf8"))).toContain("<<<<<<<")
      const accepted = yield* acceptWinnerConflicts({ canonical: conflictCanonical.path, reported: conflicted.conflicts })
      expect(accepted.conflicts).toEqual(["shared.txt"])
      expect(yield* Effect.promise(() => fs.readFile(`${conflictCanonical.path}/shared.txt`, "utf8"))).toContain("<<<<<<<")
      expect((yield* Effect.promise(() => $`git status --short`.cwd(conflictCanonical.path).quiet().text())).trim()).toBe(
        "M shared.txt",
      )
      const continued = yield* snapshotBase({ canonical: conflictCanonical.path })
      expect(continued.clean).toBe(false)
      expect(conflictWorking).not.toBe("")
    }),
  )

  it.live("measures a promotion in a dry run without touching the checkout", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/other.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const baseTree = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/shared.txt`, "winner\n", "utf8"))
      const winner = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/high-level/preview",
      })
      const input = {
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree: baseTree,
        baseIndexTree: baseTree,
        resultCommit: winner.finalCommit,
        finalIndexTree: winner.finalIndexTree,
        safetyRef: "refs/battles/high-level/preview-safety",
        dryRun: true,
      }

      const untouched = yield* promoteWinnerState(input)
      expect(untouched.conflicts).toEqual([])
      expect(untouched.publicConflicts).toEqual([])

      // A file the winner never touched merges without a collision.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/other.txt`, "public\n", "utf8"))
      const disjoint = yield* promoteWinnerState(input)
      expect(disjoint.publicConflicts).toEqual([])

      // An uncommitted edit to the winner's file is the collision the review asks about.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "public dirty\n", "utf8"))
      const collision = yield* promoteWinnerState(input)
      expect(collision.publicConflicts).toEqual(["shared.txt"])
      // An answer for the file settles it either way.
      for (const action of ["agent", "yours"] as const) {
        const answered = yield* promoteWinnerState({ ...input, publicChoice: { action, paths: ["shared.txt"] } })
        expect(answered.publicConflicts).toEqual([])
        expect(answered.conflicts).toEqual([])
      }
      // A dry run writes nothing: no files, no HEAD, no safety refs.
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))).toBe("public dirty\n")
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(frozenHead)
      const safety = yield* Effect.promise(() =>
        $`git show-ref --verify --quiet refs/battles/high-level/preview-safety`.cwd(canonical.path).quiet().nothrow(),
      )
      expect(safety.exitCode).toBe(1)
    }),
  )

  it.live("reads a parked promotion's progress from the markers, not the index", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() =>
        fs.writeFile(`${canonical.path}/conflicted.txt`, "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n", "utf8"),
      )
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/resolved.txt`, "settled\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m conflicted`.cwd(canonical.path).quiet())

      const paths = ["conflicted.txt", "resolved.txt", "deleted.txt"]
      // Nothing is unmerged here: these are ordinary committed files, which is exactly the state
      // a promotion leaves behind. Only the markers separate done from not done.
      expect((yield* Effect.promise(() => $`git ls-files -u`.cwd(canonical.path).quiet().text())).trim()).toBe("")
      expect(yield* unresolvedConflictPaths({ canonical: canonical.path, paths })).toEqual([
        "conflicted.txt",
      ])

      // Editing the markers out is what clears it -- staging is never consulted.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/conflicted.txt`, "mine and theirs\n", "utf8"))
      expect(yield* unresolvedConflictPaths({ canonical: canonical.path, paths })).toEqual([])
      expect(yield* unresolvedConflictPaths({ canonical: canonical.path, paths: [] })).toEqual([])
    }),
  )

  it.live("gives the chosen files the winner's copy, keeping the developer's on the safety refs", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const baseTree = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/shared.txt`, "winner\n", "utf8"))
      const winner = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/high-level/discard",
      })

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "public committed\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m public`.cwd(canonical.path).quiet())
      const publicHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/dirty.txt`, "public dirty\n", "utf8"))

      const safetyRef = "refs/battles/high-level/discard-safety"
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree: baseTree,
        baseIndexTree: baseTree,
        resultCommit: winner.finalCommit,
        finalIndexTree: winner.finalIndexTree,
        checkoutAction: { action: "agent", start: frozenHead, agent: frozenHead },
        safetyRef,
        retainSafetyRef: true,
        publicChoice: { action: "agent", paths: ["dirty.txt", "shared.txt"] },
      })

      expect(promoted.conflicts).toEqual([])
      // The winner lands on the frozen base, not on top of the public commit.
      expect(promoted.resultingHead).toBe(frozenHead)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))).toBe("winner\n")
      expect(
        yield* Effect.promise(() => fs.access(`${canonical.path}/dirty.txt`).then(() => true, () => false)),
      ).toBe(false)

      yield* finishWinnerPromotion({ canonical: canonical.path, safetyRef, retainSafetyRef: true })
      // Discarded, not destroyed: the snapshot still carries the commit and the dirty file.
      expect(
        (yield* Effect.promise(() => $`git rev-parse ${safetyRef}^`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(publicHead)
      expect(
        yield* Effect.promise(() => $`git show ${safetyRef}:shared.txt`.cwd(canonical.path).quiet().text()),
      ).toBe("public committed\n")
      expect(
        yield* Effect.promise(() => $`git show ${safetyRef}:dirty.txt`.cwd(canonical.path).quiet().text()),
      ).toBe("public dirty\n")
    }),
  )

  it.live("keeps the developer's copy of the chosen files and merges the rest", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/other.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add . && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const baseTree = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/shared.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/other.txt`, "winner other\n", "utf8"))
      const winner = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/high-level/keep",
      })
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "mine\n", "utf8"))

      const safetyRef = "refs/battles/high-level/keep-safety"
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree: baseTree,
        baseIndexTree: baseTree,
        resultCommit: winner.finalCommit,
        finalIndexTree: winner.finalIndexTree,
        safetyRef,
        publicChoice: { action: "yours", paths: ["shared.txt"] },
      })

      expect(promoted.conflicts).toEqual([])
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))).toBe("mine\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/other.txt`, "utf8"))).toBe("winner other\n")
    }),
  )

  it.live("preserves real commit OIDs and keeps residual state separate", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/committed.txt`, "committed\n", "utf8"))
      yield* Effect.promise(() => $`git add committed.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git commit -m committed`.cwd(candidate.path).quiet())
      const first = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git commit --allow-empty -m empty`.cwd(candidate.path).quiet())
      const second = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/unstaged.txt`, "unstaged\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/untracked.txt`, "untracked\n", "utf8"))

      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/exact/a",
      })
      expect(result.agentCommits).toEqual([first, second])
      expect(result.commitChain).toEqual([first, second])
      expect(result.agentCommit).toBe(second)
      expect(result.fullyCommitted).toBe(false)
      expect(result.wrapperCreated).toBe(true)

      const prepared = yield* preparePromotion({
        canonical: canonical.path,
        expectedBranch: branch,
        baseCommit: base,
        resultCommit: result.finalCommit,
        safetyRef: "refs/battles/exact/safety",
      })
      expect(prepared.conflicts).toEqual([])
      const promoted = yield* applyPromotionState({
        canonical: canonical.path,
        expectedHead: prepared.previousHead,
        baseCommit: base,
        agentCommits: result.agentCommits,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        fullyCommitted: result.fullyCommitted,
      })
      expect(promoted).toEqual({ resultingHead: second, conflicts: [] })
      expect((yield* Effect.promise(() => $`git log --format=%H -2`.cwd(canonical.path).quiet().text())).trim()).toBe(
        `${second}\n${first}`,
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/staged.txt`, "utf8"))).toBe("staged\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/unstaged.txt`, "utf8"))).toBe("unstaged\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/untracked.txt`, "utf8"))).toBe("untracked\n")
      expect(yield* restorePublicChanges({ canonical: canonical.path, safetyRef: prepared.safetyRef })).toEqual([])
      yield* finishPublicRestore({ canonical: canonical.path, safetyRef: prepared.safetyRef })
    }),
  )

  it.live("replays the ordered real commit chain when the canonical branch advances", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git commit -m winner`.cwd(candidate.path).quiet())
      const winnerCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      const result = yield* finalize({ worktree: candidate.path, baseSHA: base, permanentRef: "refs/battles/replay/a" })

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public.txt`, "public\n", "utf8"))
      yield* Effect.promise(() => $`git add public.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m public`.cwd(canonical.path).quiet())
      const publicHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()

      const prepared = yield* preparePromotion({
        canonical: canonical.path,
        expectedBranch: branch,
        baseCommit: base,
        resultCommit: result.finalCommit,
        safetyRef: "refs/battles/replay/safety",
      })
      const promoted = yield* applyPromotionState({
        canonical: canonical.path,
        expectedHead: prepared.previousHead,
        baseCommit: base,
        frozenHead: base,
        agentCommits: result.agentCommits,
        fullyCommitted: result.fullyCommitted,
      })
      expect(promoted).toEqual({ resultingHead: expect.any(String), conflicts: [] })
      expect(promoted.resultingHead).not.toBe(publicHead)
      expect((yield* Effect.promise(() => $`git log --format=%s -2`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "winner\npublic",
      )
      expect((yield* Effect.promise(() => $`git rev-parse HEAD~1`.cwd(canonical.path).quiet().text())).trim()).not.toBe(
        winnerCommit,
      )
      yield* restorePublicChanges({ canonical: canonical.path, safetyRef: prepared.safetyRef })
      yield* finishPublicRestore({ canonical: canonical.path, safetyRef: prepared.safetyRef })
    }),
  )

  it.live("keeps a public commit's content when the winner's residual is replayed over it", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/notes.txt`, "notes\n", "utf8"))
      yield* Effect.promise(() => $`git add notes.txt && git commit -m notes`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      // The winner commits one file and leaves staged and unstaged work on top of that commit.
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt && git commit -m winner`.cwd(candidate.path).quiet())
      const winnerCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner edited\n", "utf8"))
      const result = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/public-replay/a" })
      expect(result.agentCommits).toEqual([winnerCommit])
      expect(result.fullyCommitted).toBe(false)

      // Meanwhile the developer commits to a file the winner never touched.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/notes.txt`, "notes\npublic line\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am public`.cwd(canonical.path).quiet())

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: branch,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent_on_yours", start: frozenHead, agent: result.rawHead },
        safetyRef: "refs/battles/public-replay/safety",
      })
      expect(promoted.conflicts).toEqual([])
      expect((yield* Effect.promise(() => $`git log --format=%s -2`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "winner\npublic",
      )
      // The public commit's content survives in HEAD, the index, and the working tree.
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/notes.txt`, "utf8"))).toBe("notes\npublic line\n")
      const status = (yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text()))
        .split("\n")
        .filter(Boolean)
        .sort()
      expect(status).toEqual([" M winner.txt", "A  staged.txt"])
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/winner.txt`, "utf8"))).toBe("winner edited\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/staged.txt`, "utf8"))).toBe("staged\n")
    }),
  )

  it.live("restores unrelated public edits and untracked files after a conflicted replay", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/README.md`, "Title: original\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/notes.txt`, "notes\n", "utf8"))
      yield* Effect.promise(() => $`git add README.md notes.txt && git commit -m c1`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      // The winner commits a retitle.
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/README.md`, "Title: agents\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am retitle`.cwd(candidate.path).quiet())
      const result = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/public-conflict/a" })

      // Meanwhile the developer commits a different retitle, then keeps working on other files.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/README.md`, "Title: developer\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am c2`.cwd(canonical.path).quiet())
      const publicHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/notes.txt`, "notes\nuncommitted edit\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/scratch.txt`, "scratch\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(canonical.path).quiet())

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: branch,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "combine", start: frozenHead, agent: result.rawHead },
        safetyRef: "refs/battles/public-conflict/safety",
        retainSafetyRef: true,
      })
      expect(promoted.conflicts).toEqual(["README.md"])
      expect(promoted.resultingHead).toBe(publicHead)

      const accepted = yield* acceptWinnerConflicts({ canonical: canonical.path, reported: promoted.conflicts })
      expect(accepted.conflicts).toEqual(["README.md"])
      expect(yield* hasCherryPickInProgress(canonical.path)).toBe(false)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(publicHead)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/README.md`, "utf8"))).toContain("<<<<<<<")
      // The developer's unrelated work is back exactly as it was before the vote.
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/notes.txt`, "utf8"))).toBe("notes\nuncommitted edit\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/scratch.txt`, "utf8"))).toBe("scratch\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/staged.txt`, "utf8"))).toBe("staged\n")
      const status = (yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text()))
        .split("\n")
        .filter(Boolean)
        .sort()
      expect(status).toEqual([" M README.md", " M notes.txt", "?? scratch.txt", "A  staged.txt"])
    }),
  )

  it.live("finalizes all contestant changes under a permanent ref and fast-forwards the canonical branch", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/candidate.txt`, "candidate\n", "utf8"))
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/turn-1/a",
      })

      const repeated = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/turn-1/a",
      })
      expect(repeated.finalCommit).toBe(result.finalCommit)

      expect(result.rawHead).toBe(base)
      expect(result.wrapperCreated).toBe(true)
      expect(result.baseIsAncestor).toBe(true)
      expect(result.statusAfter).toBe(result.statusBefore)
      expect(result.diff).toEqual([{ file: "candidate.txt", additions: 1, deletions: 0, binary: false }])
      const preserved = (yield* Effect.promise(() =>
        $`git rev-parse refs/battles/turn-1/a`.cwd(canonical.path).quiet().text(),
      )).trim()
      expect(preserved).toBe(result.finalCommit)

      const applied = yield* applyFastForward({
        canonical: canonical.path,
        expectedBaseSHA: base,
        expectedBranch: branch,
        resultCommit: result.finalCommit,
      })
      expect(applied.previousHead).toBe(base)
      expect(applied.resultingHead).toBe(result.finalCommit)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/candidate.txt`, "utf8"))).toBe("candidate\n")
    }),
  )

  it.live("refuses to overwrite an archived result or apply over canonical changes", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/first.txt`, "first\n", "utf8"))
      const first = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/turn-2/b",
      })
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/second.txt`, "second\n", "utf8"))
      const overwrite = yield* Effect.exit(
        finalize({
          worktree: candidate.path,
          baseSHA: base,
          permanentRef: "refs/battles/turn-2/b",
        }),
      )
      expect(Exit.isFailure(overwrite)).toBe(true)
      if (Exit.isFailure(overwrite)) expect(Cause.squash(overwrite.cause)).toBeInstanceOf(OperationError)

      yield* Effect.promise(() => $`git switch -c arena-wrong-branch ${base}`.cwd(canonical.path).quiet())
      const wrongBranch = yield* Effect.exit(
        applyFastForward({
          canonical: canonical.path,
          expectedBaseSHA: base,
          expectedBranch: branch,
          resultCommit: first.finalCommit,
        }),
      )
      expect(Exit.isFailure(wrongBranch)).toBe(true)
      if (Exit.isFailure(wrongBranch)) expect(Cause.squash(wrongBranch.cause)).toBeInstanceOf(OperationError)
      yield* Effect.promise(() => $`git switch ${branch}`.cwd(canonical.path).quiet())

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/external.txt`, "external\n", "utf8"))
      const apply = yield* Effect.exit(
        applyFastForward({
          canonical: canonical.path,
          expectedBaseSHA: base,
          expectedBranch: branch,
          resultCommit: first.finalCommit,
        }),
      )
      expect(Exit.isFailure(apply)).toBe(true)
      if (Exit.isFailure(apply)) expect(Cause.squash(apply.cause)).toBeInstanceOf(OperationError)
    }),
  )

  it.live("advances a continued pre-vote result with compare-and-swap semantics", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const permanentRef = "refs/battles/turn-2-continuation/a"
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/continued.txt`, "first\n", "utf8"))
      const first = yield* finalize({ worktree: candidate.path, baseSHA: base, permanentRef })
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/continued.txt`, "second\n", "utf8"))
      const second = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef,
        expectedPermanentCommit: first.finalCommit,
      })
      expect(second.finalCommit).not.toBe(first.finalCommit)
      expect(
        (yield* Effect.promise(() => $`git rev-parse ${permanentRef}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(second.finalCommit)

      const replayed = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef,
        expectedPermanentCommit: first.finalCommit,
      })
      expect(replayed.finalCommit).toBe(second.finalCommit)

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/continued.txt`, "third\n", "utf8"))
      const stale = yield* Effect.exit(
        finalize({
          worktree: candidate.path,
          baseSHA: base,
          permanentRef,
          expectedPermanentCommit: first.finalCommit,
        }),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      expect(
        (yield* Effect.promise(() => $`git rev-parse ${permanentRef}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(second.finalCommit)
    }),
  )

  it.live("reanchors final content when a contestant switches to unrelated history", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      const baseTree = (yield* Effect.promise(() =>
        $`git rev-parse ${base}^{tree}`.cwd(canonical.path).quiet().text(),
      )).trim()
      const unrelated = (yield* Effect.promise(() =>
        $`git commit-tree ${baseTree} -m unrelated`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${unrelated}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/reanchored.txt`, "contestant result\n", "utf8"))

      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/turn-5/a",
      })
      expect(result.rawHead).toBe(unrelated)
      expect(result.wrapperCreated).toBe(true)
      expect(result.baseIsAncestor).toBe(false)

      const applied = yield* applyFastForward({
        canonical: canonical.path,
        expectedBaseSHA: base,
        expectedBranch: branch,
        resultCommit: result.finalCommit,
      })
      expect(applied.resultingHead).toBe(result.finalCommit)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/reanchored.txt`, "utf8"))).toBe(
        "contestant result\n",
      )
    }),
  )

  it.live("captures both base-relative patches and the direct A-to-B patch", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidateA = yield* scopedTmpdir()
      const candidateB = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.all(
        [candidateA, candidateB].map((candidate) =>
          Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet()),
        ),
        { concurrency: 1 },
      )
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [candidateA, candidateB].map((candidate) =>
            Effect.promise(() =>
              $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
            ).pipe(Effect.ignore),
          ),
          { concurrency: 2, discard: true },
        ),
      )

      yield* Effect.all(
        [
          Effect.promise(() => fs.writeFile(`${candidateA.path}/result.txt`, "result A\n", "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateB.path}/result.txt`, "result B\n", "utf8")),
        ],
        { concurrency: 2, discard: true },
      )
      const [a, b] = yield* Effect.all(
        [
          finalize({
            worktree: candidateA.path,
            baseSHA: base,
            permanentRef: "refs/battles/turn-3/a",
          }),
          finalize({
            worktree: candidateB.path,
            baseSHA: base,
            permanentRef: "refs/battles/turn-3/b",
          }),
        ],
        { concurrency: 2 },
      )

      const evidence = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: a.finalCommit,
        bCommit: b.finalCommit,
      })
      expect(evidence.baseToA).toContain("+result A")
      expect(evidence.baseToB).toContain("+result B")
      expect(evidence.patch).toContain("-result A")
      expect(evidence.patch).toContain("+result B")
      expect(evidence.baseToATruncated).toBe(false)
      expect(evidence.baseToBTruncated).toBe(false)
      expect(evidence.truncated).toBe(false)
    }),
  )

  it.live("classifies each file's divergence from git's own merge and ships the merged text", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidateA = yield* scopedTmpdir()
      const candidateB = yield* scopedTmpdir()
      const shared = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, shared, "utf8"))
      yield* Effect.promise(() => $`git add shared.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m "shared"`.cwd(canonical.path).quiet())
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.all(
        [candidateA, candidateB].map((candidate) =>
          Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet()),
        ),
        { concurrency: 1 },
      )
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [candidateA, candidateB].map((candidate) =>
            Effect.promise(() =>
              $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
            ).pipe(Effect.ignore),
          ),
          { concurrency: 2, discard: true },
        ),
      )

      // A edits line 2 and adds a file of its own; B edits line 9 and adds another; both
      // write the same new file. Nothing overlaps, so git merges every file cleanly.
      const lines = shared.split("\n")
      const aLines = [...lines]
      aLines[1] = "line 2 by A"
      const bLines = [...lines]
      bLines[8] = "line 9 by B"
      yield* Effect.all(
        [
          Effect.promise(() => fs.writeFile(`${candidateA.path}/shared.txt`, aLines.join("\n"), "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateA.path}/only-a.txt`, "only A\n", "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateA.path}/same.txt`, "same on both\n", "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateB.path}/shared.txt`, bLines.join("\n"), "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateB.path}/only-b.txt`, "only B\n", "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateB.path}/same.txt`, "same on both\n", "utf8")),
        ],
        { concurrency: 6, discard: true },
      )
      const [a, b] = yield* Effect.all(
        [
          finalize({ worktree: candidateA.path, baseSHA: base, permanentRef: "refs/battles/turn-4/a" }),
          finalize({ worktree: candidateB.path, baseSHA: base, permanentRef: "refs/battles/turn-4/b" }),
        ],
        { concurrency: 2 },
      )

      const evidence = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: a.finalCommit,
        bCommit: b.finalCommit,
      })
      const divergence = evidence.divergence
      expect(divergence).toBeDefined()
      expect(divergence!.conflicted).toBe(false)
      expect(divergence!.files.map((entry) => entry.file)).toEqual(evidence.files.map((entry) => entry.file))
      const byFile = new Map(divergence!.files.map((entry) => [entry.file, entry]))
      expect(byFile.get("shared.txt")?.status).toBe("compatible")
      expect(byFile.get("shared.txt")?.merged?.content).toContain("line 2 by A")
      expect(byFile.get("shared.txt")?.merged?.content).toContain("line 9 by B")
      expect(byFile.get("shared.txt")?.merged?.content).not.toContain("<<<<<<<")
      expect(byFile.get("only-a.txt")?.status).toBe("only_a")
      expect(byFile.get("only-a.txt")?.merged).toBeUndefined()
      expect(byFile.get("only-b.txt")?.status).toBe("only_b")
      expect(byFile.get("same.txt")?.status).toBe("identical")
      expect(byFile.get("same.txt")?.merged).toBeUndefined()
    }),
  )

  it.live("marks a file both sides rewrote differently as diverging, with zdiff3 conflict blocks", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidateA = yield* scopedTmpdir()
      const candidateB = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/greet.py`, "def greet():\n    pass\n", "utf8"))
      yield* Effect.promise(() => $`git add greet.py`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m "greet"`.cwd(canonical.path).quiet())
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.all(
        [candidateA, candidateB].map((candidate) =>
          Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet()),
        ),
        { concurrency: 1 },
      )
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [candidateA, candidateB].map((candidate) =>
            Effect.promise(() =>
              $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
            ).pipe(Effect.ignore),
          ),
          { concurrency: 2, discard: true },
        ),
      )
      yield* Effect.all(
        [
          Effect.promise(() =>
            fs.writeFile(`${candidateA.path}/greet.py`, 'def greet():\n    return "hello from A"\n', "utf8"),
          ),
          Effect.promise(() =>
            fs.writeFile(`${candidateB.path}/greet.py`, 'def greet():\n    print("hello from B")\n', "utf8"),
          ),
        ],
        { concurrency: 2, discard: true },
      )
      const [a, b] = yield* Effect.all(
        [
          finalize({ worktree: candidateA.path, baseSHA: base, permanentRef: "refs/battles/turn-5/a" }),
          finalize({ worktree: candidateB.path, baseSHA: base, permanentRef: "refs/battles/turn-5/b" }),
        ],
        { concurrency: 2 },
      )

      const evidence = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: a.finalCommit,
        bCommit: b.finalCommit,
      })
      expect(evidence.divergence?.conflicted).toBe(true)
      const entry = evidence.divergence?.files.find((file) => file.file === "greet.py")
      expect(entry?.status).toBe("diverging")
      const merged = entry?.merged?.content ?? ""
      expect(merged).toContain("<<<<<<<")
      // The base section proves the zdiff3 style reached merge-ort; plain "merge" has none.
      expect(merged).toContain("|||||||")
      expect(merged).toContain("=======")
      expect(merged).toContain(">>>>>>>")
      expect(merged).toContain('return "hello from A"')
      expect(merged).toContain('print("hello from B")')

      // A stopped side is represented by the base itself: nothing is A's, so nothing conflicts.
      const stopped = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: base,
        bCommit: b.finalCommit,
      })
      expect(stopped.divergence?.conflicted).toBe(false)
      expect(stopped.divergence?.files.map((file) => file.status)).toEqual(["only_b"])
    }),
  )

  it.live("keeps a change buried deep in a large file, where a byte prefix of it would not reach", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidateA = yield* scopedTmpdir()
      const candidateB = yield* scopedTmpdir()
      // A lockfile-shaped file: far past any prefix the wire budget would allow, with each
      // agent editing a different depth. A edits near the end, B near the start.
      const lines = Array.from({ length: 30_000 }, (_, index) => `  "entry-${index}": "1.0.0",`)
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/lock.json`, `${lines.join("\n")}\n`, "utf8"))
      yield* Effect.promise(() => $`git add lock.json`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m lockfile`.cwd(canonical.path).quiet())
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.all(
        [candidateA, candidateB].map((candidate) =>
          Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet()),
        ),
        { concurrency: 1 },
      )
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [candidateA, candidateB].map((candidate) =>
            Effect.promise(() =>
              $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
            ).pipe(Effect.ignore),
          ),
          { concurrency: 2, discard: true },
        ),
      )

      const deep = [...lines]
      deep[26_480] = `  "entry-26480": "9.9.9",`
      const shallow = [...lines]
      shallow[17] = `  "entry-17": "2.5.1",`
      yield* Effect.all(
        [
          Effect.promise(() => fs.writeFile(`${candidateA.path}/lock.json`, `${deep.join("\n")}\n`, "utf8")),
          Effect.promise(() => fs.writeFile(`${candidateB.path}/lock.json`, `${shallow.join("\n")}\n`, "utf8")),
        ],
        { concurrency: 2, discard: true },
      )
      const [a, b] = yield* Effect.all(
        [
          finalize({ worktree: candidateA.path, baseSHA: base, permanentRef: "refs/battles/turn-deep/a" }),
          finalize({ worktree: candidateB.path, baseSHA: base, permanentRef: "refs/battles/turn-deep/b" }),
        ],
        { concurrency: 2 },
      )

      const evidence = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: a.finalCommit,
        bCommit: b.finalCommit,
      })
      const lock = evidence.files.find((entry) => entry.file === "lock.json")
      expect(lock).toBeDefined()
      // Both agents' edits reach the viewer, from opposite ends of a file far too big to send.
      expect(lock?.a?.content).toContain('"entry-26480": "9.9.9"')
      expect(lock?.b?.content).toContain('"entry-17": "2.5.1"')
      expect(lock?.base?.content).toContain('"entry-26480": "1.0.0"')
      expect(lock?.base?.content).toContain('"entry-17": "1.0.0"')
      // Only windows around those two places, not the 30,000 lines between them.
      expect(lock?.base?.regions).toHaveLength(2)
      expect(lock?.a?.regions).toHaveLength(2)
      expect(lock?.b?.regions).toHaveLength(2)
      expect(lock?.base?.content.length).toBeLessThan(8_000)
      // Every side reports the same windows, in base line numbers where they agree.
      expect(lock?.base?.regions?.[0]?.start).toBe(lock?.b?.regions?.[0]?.start)
      expect(lock?.a?.regions?.[1]?.start).toBe(lock?.base?.regions?.[1]?.start)
    }),
  )

  it.live("snapshots a dirty checkout and applies only the selected result delta", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/staged.txt`, "user staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/untracked.txt`, "user untracked\n", "utf8"))
      const indexBefore = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()

      const base = yield* snapshotBase({
        canonical: canonical.path,
        permanentRef: "refs/battles/turn-4/base",
      })
      expect(base.clean).toBe(false)
      expect(base.canonicalHead).toBe(head)
      expect(base.baseCommit).not.toBe(head)
      expect(base.indexTree).toBe(indexBefore)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(head)

      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${base.baseCommit}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/staged.txt`, "user staged\nwinner edit\n", "utf8"))
      yield* Effect.promise(() =>
        fs.writeFile(`${candidate.path}/untracked.txt`, "user untracked\nwinner edit\n", "utf8"),
      )
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: base.baseCommit,
        permanentRef: "refs/battles/turn-4/a",
      })

      const applied = yield* applySnapshot({
        canonical: canonical.path,
        expectedCanonicalHead: head,
        expectedBranch: branch,
        expectedBaseCommit: base.baseCommit,
        expectedBaseTree: base.baseTree,
        expectedIndexTree: base.indexTree,
        resultCommit: result.finalCommit,
      })
      expect(applied.previousHead).toBe(head)
      expect(applied.resultingHead).toBe(head)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(head)
      expect((yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()).toBe(
        indexBefore,
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/staged.txt`, "utf8"))).toBe(
        "user staged\nwinner edit\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/untracked.txt`, "utf8"))).toBe(
        "user untracked\nwinner edit\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/winner.txt`, "utf8"))).toBe("winner\n")

      const repeated = yield* applySnapshot({
        canonical: canonical.path,
        expectedCanonicalHead: head,
        expectedBranch: branch,
        expectedBaseCommit: base.baseCommit,
        expectedBaseTree: base.baseTree,
        expectedIndexTree: base.indexTree,
        resultCommit: result.finalCommit,
      })
      expect(repeated.resultingHead).toBe(head)

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/external.txt`, "external\n", "utf8"))
      const changed = yield* applySnapshot({
        canonical: canonical.path,
        expectedCanonicalHead: head,
        expectedBranch: branch,
        expectedBaseCommit: base.baseCommit,
        expectedBaseTree: base.baseTree,
        expectedIndexTree: base.indexTree,
        resultCommit: result.finalCommit,
      })
      expect(changed.resultingHead).toBe(head)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/external.txt`, "utf8"))).toBe("external\n")
    }),
  )

  it.live("snapshots a dirty checkout that has no index to copy", () =>
    Effect.gen(function* () {
      // The snapshot index is seeded from the checkout's own so `add -A` keeps its stat
      // cache instead of re-hashing every file. A checkout with no index yet has to fall
      // back to `read-tree HEAD` and reach the same tree.
      const canonical = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/tracked.txt`, "tracked\n", "utf8"))
      yield* Effect.promise(() => $`git add tracked.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m tracked`.cwd(canonical.path).quiet())
      const seeded = yield* snapshotBase({
        canonical: canonical.path,
        permanentRef: "refs/battles/turn-9/base",
      })

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/tracked.txt`, "edited\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/untracked.txt`, "untracked\n", "utf8"))
      const withIndex = yield* snapshotBase({
        canonical: canonical.path,
        permanentRef: "refs/battles/turn-9/with-index",
      })
      expect(withIndex.clean).toBe(false)

      const gitDir = (yield* Effect.promise(() =>
        $`git rev-parse --absolute-git-dir`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => fs.rm(`${gitDir}/index`))
      const withoutIndex = yield* snapshotBase({
        canonical: canonical.path,
        permanentRef: "refs/battles/turn-9/without-index",
      })
      expect(withoutIndex.baseTree).toBe(withIndex.baseTree)
      expect(withoutIndex.canonicalHead).toBe(seeded.canonicalHead)
    }),
  )

  it.live("leaves sync conflict copies of ignored files out of snapshots", () =>
    Effect.gen(function* () {
      // A synced folder answers Arena's rewrite of an ignored `.env` with a `.env 2` that no
      // ignore rule matches. Only a numbered copy of an ignored file with the same bytes goes.
      const canonical = yield* scopedTmpdir({ git: true })
      const write = (name: string, text: string) =>
        Effect.promise(() => fs.writeFile(path.join(canonical.path, name), text, "utf8"))
      yield* write(".gitignore", ".env\n*.save\n")
      yield* write("report.pdf", "report\n")
      yield* Effect.promise(() => $`git add .gitignore report.pdf`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m tracked`.cwd(canonical.path).quiet())
      yield* write(".env", "SECRET=1\n")
      yield* write(".env 2", "SECRET=1\n")
      yield* write(".env.save", "SECRET=0\n")
      yield* write(".env 2.save", "SECRET=0\n")
      yield* write(".env 3", "SECRET=other\n")
      yield* write("report 2.pdf", "report\n")
      yield* write("notes 2.txt", "notes\n")

      const base = yield* snapshotBase({ canonical: canonical.path })
      const listed = yield* Effect.promise(() =>
        $`git ls-tree -r -z --name-only ${base.baseTree}`.cwd(canonical.path).quiet().text(),
      )
      expect(listed.split("\0").filter(Boolean).sort()).toEqual(
        [".env 3", ".gitignore", "notes 2.txt", "report 2.pdf", "report.pdf"].sort(),
      )
    }),
  )

  it.live("excludes untracked embedded repositories from dirty snapshots", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const nested = `${canonical.path}/nested`
      yield* Effect.promise(() => fs.mkdir(nested))
      yield* Effect.promise(() => $`git init`.cwd(nested).quiet())
      yield* Effect.promise(() => fs.writeFile(`${nested}/nested.txt`, "nested\n", "utf8"))
      yield* Effect.promise(() => $`git add nested.txt`.cwd(nested).quiet())
      yield* Effect.promise(() => $`git commit -m nested`.cwd(nested).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/normal.txt`, "normal\n", "utf8"))

      const base = yield* snapshotBase({
        canonical: canonical.path,
        permanentRef: "refs/battles/turn-6/base",
      })
      const nestedEntry = yield* Effect.promise(() =>
        $`git cat-file -e ${base.baseCommit}:nested`.cwd(canonical.path).quiet().nothrow(),
      )
      const normalEntry = yield* Effect.promise(() =>
        $`git cat-file -e ${base.baseCommit}:normal.txt`.cwd(canonical.path).quiet().nothrow(),
      )
      expect(nestedEntry.exitCode).not.toBe(0)
      expect(normalEntry.exitCode).toBe(0)
      expect(yield* Effect.promise(() => fs.readFile(`${nested}/nested.txt`, "utf8"))).toBe("nested\n")
    }),
  )

  it.live("inspectCanonical reports unmerged paths instead of failing on write-tree", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const trunk = (
        yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())
      ).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/f`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add f && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git checkout -b side`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/f`, "side\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am side`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git checkout ${trunk}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/f`, "trunk\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am trunk`.cwd(canonical.path).quiet())
      const merged = yield* Effect.promise(() => $`git merge side`.cwd(canonical.path).quiet().nothrow())
      expect(merged.exitCode).not.toBe(0)
      const unmerged = (yield* Effect.promise(() => $`git ls-files -u`.cwd(canonical.path).quiet().text()))
        .trim()
        .split("\n")
      expect(unmerged).toHaveLength(3)

      const conflicted = yield* inspectCanonical(canonical.path)
      expect(conflicted.conflicts).toEqual(["f"])
      expect(conflicted.indexTree).toBeUndefined()
      expect(conflicted.clean).toBe(false)

      const refused = yield* Effect.exit(snapshotBase({ canonical: canonical.path }))
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        const failure = Cause.squash(refused.cause)
        expect(failure).toBeInstanceOf(OperationError)
        expect((failure as OperationError).message).toContain("Unresolved merge conflicts: f")
        // startTurnUnlocked branches on both of these to refuse one battle instead of blocking
        // the chat, so they are a contract, not an implementation detail.
        expect((failure as OperationError).operation).toBe(TRUNK_CONFLICT_OPERATION)
        expect((failure as OperationError).paths).toEqual(["f"])
      }

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/f`, "resolved\n", "utf8"))
      yield* Effect.promise(() => $`git add f`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git commit -m merged`.cwd(canonical.path).quiet())
      const resolved = yield* inspectCanonical(canonical.path)
      expect(resolved.conflicts).toEqual([])
      expect(resolved.indexTree).toBeDefined()
    }),
  )

  it.live("inspectCanonical reads the staged tree without taking index.lock", () =>
    Effect.gen(function* () {
      // Another chat's vote holds the lock while it writes the shared checkout. The stream poll
      // inspects every chat's checkout, and taking the lock here is what made that vote fail.
      const canonical = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(canonical.path).quiet())
      const expected = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      const lock = `${canonical.path}/.git/index.lock`
      yield* Effect.promise(() => fs.writeFile(lock, "", "utf8"))

      const state = yield* inspectCanonical(canonical.path)
      expect(state.indexTree).toBe(expected)
      // The lock is still the holder's: nothing was written over or beside it.
      expect(yield* Effect.promise(() => fs.readFile(lock, "utf8"))).toBe("")
      yield* Effect.promise(() => fs.rm(lock))
      const status = yield* Effect.promise(() => $`git status --porcelain`.cwd(canonical.path).quiet().text())
      expect(status.trim()).toBe("A  staged.txt")
    }),
  )

  it.live("reports the common Git directory and deterministic battle refs", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const state = yield* repositoryKey(canonical.path)
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      expect(state).toBe(`${canonical.path}/.git`)
      expect(yield* containsCommit({ repository: canonical.path, commit: head })).toBe(true)
      expect(yield* containsCommit({ repository: canonical.path, commit: "0".repeat(40) })).toBe(false)
      expect(sideBranchName("chat-123", "a")).toBe("agent-duel/chat-123-agent-a")
      expect(battleRefs("chat-123", 4)).toEqual({
        base: "refs/battles/chat-123/turn-4/base",
        a: "refs/battles/chat-123/turn-4/a",
        b: "refs/battles/chat-123/turn-4/b",
        selected: "refs/battles/chat-123/turn-4/selected",
      })
    }),
  )

  it.live("resets and attaches one persistent side branch without bypassing worktree safety", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      const branch = sideBranchName("chat-branch", "a")
      const reset = yield* resetSideBranch({ repository: canonical.path, branch, baseCommit: base })
      expect(reset).toEqual({ branch, baseCommit: base })
      const prepared = yield* prepareSideBranch({ repository: canonical.path, branch, baseCommit: base })
      expect(prepared.baseCommit).toBe(base)
      const attached = yield* attachSideBranch({ repository: canonical.path, branch, baseCommit: base, worktree: candidate.path })
      expect(attached).toEqual({ branch, baseCommit: base, worktree: candidate.path })
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/stale-generated.cache`, "stale\n"))
      yield* refreshAttachedSide({
        repository: canonical.path,
        branch,
        baseCommit: base,
        worktree: candidate.path,
      })
      expect(yield* Effect.promise(() => fs.lstat(`${candidate.path}/stale-generated.cache`).catch(() => undefined))).toBeUndefined()
      const repeated = yield* Effect.exit(
        resetSideBranch({ repository: canonical.path, branch, baseCommit: base }),
      )
      expect(Exit.isFailure(repeated)).toBe(true)
    }),
  )

  it.live("pins the selected result separately from the canonical tree", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/selected.txt`, "selected\n", "utf8"))
      const result = yield* finalize({ worktree: candidate.path, baseSHA: base, permanentRef: "refs/battles/turn-7/a" })
      expect(yield* selectResult({ canonical: canonical.path, selectedRef: "refs/battles/turn-7/selected", resultCommit: result.finalCommit })).toBe(
        result.finalCommit,
      )
      expect((yield* Effect.promise(() => $`git rev-parse refs/battles/turn-7/selected`.cwd(canonical.path).quiet().text())).trim()).toBe(
        result.finalCommit,
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/selected.txt`, "replacement\n", "utf8"))
      const replacement = yield* finalize({
        worktree: candidate.path,
        baseSHA: base,
        permanentRef: "refs/battles/turn-7/a",
        expectedPermanentCommit: result.finalCommit,
      })
      const overwrite = yield* Effect.exit(
        selectResult({
          canonical: canonical.path,
          selectedRef: "refs/battles/turn-7/selected",
          resultCommit: replacement.finalCommit,
        }),
      )
      expect(Exit.isFailure(overwrite)).toBe(true)
      expect(
        (
          yield* Effect.promise(() =>
            $`git rev-parse refs/battles/turn-7/selected`.cwd(canonical.path).quiet().text(),
          )
        ).trim(),
      ).toBe(result.finalCommit)
    }),
  )

  it.live("applies overlapping edits as a normal three-way conflict and preserves HEAD and index", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/conflict.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add conflict.txt && git commit -m seed`.cwd(canonical.path).quiet())
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      const base = yield* snapshotBase({ canonical: canonical.path, permanentRef: "refs/battles/turn-8/base" })
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base.baseCommit}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/conflict.txt`, "winner\n", "utf8"))
      const result = yield* finalize({ worktree: candidate.path, baseSHA: base.baseCommit, permanentRef: "refs/battles/turn-8/a" })
      const indexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/conflict.txt`, "canonical\n", "utf8"))
      const applied = yield* applySnapshot({
        canonical: canonical.path,
        expectedCanonicalHead: head,
        expectedBranch: branch,
        expectedBaseCommit: base.baseCommit,
        expectedBaseTree: base.baseTree,
        expectedIndexTree: indexTree,
        resultCommit: result.finalCommit,
      })
      expect(applied.previousHead).toBe(head)
      expect(applied.resultingHead).toBe(head)
      expect(applied.conflicts).toEqual(["conflict.txt"])
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(head)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(branch)
      expect((yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()).toBe(indexTree)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/conflict.txt`, "utf8"))).toContain("<<<<<<<")
    }),
  )

  it.live("imports result and index-tree refs from an isolated repository without moving the canonical branch", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const source = yield* scopedTmpdir({ git: true })
      const canonicalHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${source.path}/result.txt`, "result\n", "utf8"))
      yield* Effect.promise(() => $`git add result.txt`.cwd(source.path).quiet())
      yield* Effect.promise(() => $`git commit -m result`.cwd(source.path).quiet())
      const expectedCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(source.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git update-ref refs/private/result ${expectedCommit}`.cwd(source.path).quiet())
      yield* Effect.promise(() => $`git fetch --no-tags ${source.path} HEAD`.cwd(canonical.path).quiet())
      const fetchHeadBefore = yield* Effect.promise(() => fs.readFile(`${canonical.path}/.git/FETCH_HEAD`, "utf8"))
      const imported = yield* importResultRef({
        canonical: canonical.path,
        sourceRepository: source.path,
        sourceRef: "refs/private/result",
        destinationRef: "refs/battles/imported/a",
        expectedCommit,
      })
      expect(imported).toBe(expectedCommit)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(
        canonicalHead,
      )
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(branch)
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/.git/FETCH_HEAD`, "utf8"))).toBe(fetchHeadBefore)
      expect((yield* Effect.promise(() => $`git rev-parse refs/battles/imported/a`.cwd(canonical.path).quiet().text())).trim()).toBe(
        expectedCommit,
      )

      const expectedTree = (yield* Effect.promise(() => $`git write-tree`.cwd(source.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git update-ref refs/private/result-index ${expectedTree}`.cwd(source.path).quiet())
      expect(
        yield* importResultRef({
          canonical: canonical.path,
          sourceRepository: source.path,
          sourceRef: "refs/private/result-index",
          destinationRef: "refs/battles/imported/a-index",
          expectedCommit: expectedTree,
          objectType: "tree",
        }),
      ).toBe(expectedTree)

      yield* Effect.promise(() => fs.writeFile(`${source.path}/staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(source.path).quiet())
      const nextTree = (yield* Effect.promise(() => $`git write-tree`.cwd(source.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git update-ref refs/private/result-index ${nextTree} ${expectedTree}`.cwd(source.path).quiet())
      expect(
        yield* importResultRef({
          canonical: canonical.path,
          sourceRepository: source.path,
          sourceRef: "refs/private/result-index",
          destinationRef: "refs/battles/imported/a-index",
          expectedCommit: nextTree,
          expectedDestinationCommit: expectedTree,
          objectType: "tree",
        }),
      ).toBe(nextTree)
      expect(
        (yield* Effect.promise(() => $`git rev-parse refs/battles/imported/a-index^{tree}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(nextTree)
    }),
  )

  it.live("creates and checks out a winner branch while preserving exact commits and residual state", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      const winnerBranch = "arena-winner-feature"
      yield* Effect.promise(() => $`git switch -c ${winnerBranch}`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner commit\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt && git commit -m winner`.cwd(candidate.path).quiet())
      const winnerCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()

      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/base.txt`, "winner residual\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/staged.txt`, "staged residual\n", "utf8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/untracked.txt`, "untracked residual\n", "utf8"))
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/branch-switch/a",
      })
      expect(result.branch).toBe(winnerBranch)
      expect(result.agentCommits).toEqual([winnerCommit])
      expect(result.fullyCommitted).toBe(false)
      // Production contestants use isolated repositories, so their branch ref is not already
      // present in the canonical repository when the result objects are imported.
      yield* Effect.promise(() => $`git switch --detach ${winnerCommit}`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --delete --force ${winnerBranch}`.cwd(canonical.path).quiet())

      const promotionInput = {
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent" as const, agent: result.rawHead },
        safetyRef: "refs/battles/branch-switch/a-safety",
        targetBranch: winnerBranch,
      }
      const promoted = yield* promoteWinnerState(promotionInput)
      expect(promoted.conflicts).toEqual([])
      expect(promoted.resultingHead).toBe(winnerCommit)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(
        winnerBranch,
      )
      expect((yield* Effect.promise(() => $`git rev-parse ${winnerBranch}`.cwd(canonical.path).quiet().text())).trim()).toBe(
        winnerCommit,
      )
      expect((yield* Effect.promise(() => $`git rev-parse ${winnerCommit}^`.cwd(canonical.path).quiet().text())).trim()).toBe(
        frozenHead,
      )
      const status = yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())
      expect(status).toContain(" M base.txt\n")
      expect(status).toContain("A  staged.txt\n")
      expect(status).toContain("?? untracked.txt\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/base.txt`, "utf8"))).toBe("winner residual\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/staged.txt`, "utf8"))).toBe("staged residual\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/untracked.txt`, "utf8"))).toBe("untracked residual\n")
      const finalIndex = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      expect(finalIndex).toBe(result.finalIndexTree)
    }),
  )

  it.live("restores the original branch and public state after an interrupted branch promotion", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )

      const winnerBranch = "arena-interrupted-feature"
      yield* Effect.promise(() => $`git switch -c ${winnerBranch}`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt && git commit -m winner`.cwd(candidate.path).quiet())
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/branch-recovery/a",
      })
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --delete --force ${winnerBranch}`.cwd(canonical.path).quiet())

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public-staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add public-staged.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public-untracked.txt`, "untracked\n", "utf8"))
      const safetyRef = "refs/battles/branch-recovery/public-safety"
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: winnerBranch,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent", start: frozenHead, agent: result.rawHead },
        safetyRef,
        retainSafetyRef: true,
      })
      expect(promoted.conflicts).toEqual([])
      expect((yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()).toBe(winnerBranch)

      expect(
        yield* recoverFailedPromotion({
          canonical: canonical.path,
          safetyRef,
          expectedBranch: canonicalBranch,
          targetBranch: winnerBranch,
        }),
      ).toBe(true)
      expect((yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()).toBe(canonicalBranch)
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(
        frozenHead,
      )
      expect((yield* Effect.promise(() =>
        $`git show-ref --verify --quiet refs/heads/${winnerBranch}`.cwd(canonical.path).quiet().nothrow(),
      )).exitCode).toBe(1)
      const status = yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())
      expect(status).toContain("A  public-staged.txt\n")
      expect(status).toContain("?? public-untracked.txt\n")
    }),
  )

  it.live("moves an existing winner branch with unrelated history only as the review decided", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      const winnerBranch = "arena-existing-feature"
      yield* Effect.promise(() => $`git switch -c ${winnerBranch}`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt && git commit -m winner`.cwd(candidate.path).quiet())
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/branch-switch/b",
      })
      const winnerCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())

      // The branch name now points at an unrelated root. Promotion must leave it intact.
      const baseTree = (yield* Effect.promise(() => $`git rev-parse ${frozenHead}^{tree}`.cwd(canonical.path).quiet().text())).trim()
      const incompatibleCommit = (yield* Effect.promise(() => $`git commit-tree ${baseTree} -m incompatible`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git branch --force ${winnerBranch} ${incompatibleCommit}`.cwd(canonical.path).quiet())
      const beforeHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()

      const promotionInput = {
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        safetyRef: "refs/battles/branch-switch/b-safety",
        targetBranch: winnerBranch,
        retainSafetyRef: true,
      }
      // Keeping the developer's branch switches to it and leaves its unrelated history alone.
      const kept = yield* promoteWinnerState({
        ...promotionInput,
        dryRun: true,
        checkoutAction: { action: "yours", start: frozenHead, agent: winnerCommit },
      })
      expect(kept.resultingHead).toBe(incompatibleCommit)
      expect(
        (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(beforeHead)

      // Taking the agent's branch replaces it, and the safety refs keep what it replaced.
      const taken = yield* promoteWinnerState({
        ...promotionInput,
        checkoutAction: { action: "agent", start: frozenHead, agent: winnerCommit },
      })
      expect(taken.resultingHead).toBe(winnerCommit)
      expect(
        (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(winnerBranch)
      expect(
        (yield* Effect.promise(() =>
          $`git rev-parse refs/battles/branch-switch/b-safety-target-existing`.cwd(canonical.path).quiet().text(),
        )).trim(),
      ).toBe(incompatibleCommit)
      expect(winnerCommit).not.toBe(incompatibleCommit)
    }),
  )

  it.live("mirrors canonical branches, remote refs, tags, and origin into a contestant host", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      const side = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const feature = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git tag v1`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git update-ref refs/battles/chat/turn-1/base HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch agent-duel/other-agent-b HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git remote add origin https://example.invalid/repo.git`.cwd(canonical.path).quiet())

      // A minimal host fixture, enough to exercise the mirror on its own: a bare repository that
      // borrows objects, and a side worktree checked out on the developer's exact branch name.
      // Production copies the git directory instead; the neighbouring test models that.
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`git init --bare --quiet ${host}`.quiet())
      // A separate repository has none of the fixture's identity config; commits below need it.
      yield* Effect.promise(() => $`git config user.name arena-test`.cwd(host).quiet())
      yield* Effect.promise(() => $`git config user.email arena-test@localhost`.cwd(host).quiet())
      yield* Effect.promise(() => fs.writeFile(`${host}/objects/info/alternates`, `${canonical.path}/.git/objects\n`, "utf8"))
      yield* Effect.promise(() => $`git worktree add -b ${feature} ${side.path}/tree ${frozenHead}`.cwd(host).quiet())
      yield* Effect.promise(() => fs.writeFile(`${side.path}/tree/side.txt`, "side\n", "utf8"))
      yield* Effect.promise(() => $`git add side.txt && git commit -m side`.cwd(`${side.path}/tree`).quiet())
      const sideTip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(`${side.path}/tree`).quiet().text())).trim()

      const first = yield* mirrorCanonicalRefs({ canonical: canonical.path, host })
      expect(first.origin).toBe(true)
      expect(first.deleted).toBe(0)
      const refs = (yield* Effect.promise(() => $`git for-each-ref --format="%(refname)"`.cwd(host).quiet().text())).trim().split("\n")
      expect(refs).toContain("refs/heads/arena-main")
      expect(refs).toContain("refs/remotes/origin/arena-main")
      expect(refs).toContain("refs/tags/v1")
      expect(refs).not.toContain("refs/battles/chat/turn-1/base")
      expect(refs).not.toContain("refs/heads/agent-duel/other-agent-b")
      // The side's checked-out branch keeps the side's own commit.
      expect((yield* Effect.promise(() => $`git rev-parse ${feature}`.cwd(host).quiet().text())).trim()).toBe(sideTip)
      expect((yield* Effect.promise(() => $`git config --get remote.origin.url`.cwd(host).quiet().text())).trim()).toBe(
        "https://example.invalid/repo.git",
      )
      expect((yield* Effect.promise(() => $`git config --get-all remote.origin.fetch`.cwd(host).quiet().text())).trim()).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      )

      // A contestant can now merge a canonical branch by name.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/main.txt`, "main\n", "utf8"))
      yield* Effect.promise(() => $`git add main.txt && git commit -m main-only`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git reset --hard ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch --delete --force agent-duel/other-agent-b`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git tag --delete v1`.cwd(canonical.path).quiet())
      // A host-only branch that no worktree has checked out does not survive the next mirror.
      yield* Effect.promise(() => $`git branch contestant-backup HEAD`.cwd(`${side.path}/tree`).quiet())
      const second = yield* mirrorCanonicalRefs({ canonical: canonical.path, host })
      expect(second.deleted).toBe(2)
      const merged = yield* Effect.promise(() =>
        $`git merge --no-edit arena-main`.cwd(`${side.path}/tree`).quiet().nothrow(),
      )
      expect(merged.exitCode).toBe(0)
      expect(yield* Effect.promise(() => fs.readFile(`${side.path}/tree/main.txt`, "utf8"))).toBe("main\n")
      const after = (yield* Effect.promise(() => $`git for-each-ref --format="%(refname)"`.cwd(host).quiet().text())).trim().split("\n")
      expect(after).not.toContain("refs/tags/v1")
      expect(after).not.toContain("refs/heads/contestant-backup")

      // A branch replaced by a nested name under it needs the delete before the update: git refuses
      // to delete `refs/heads/foo` and create `refs/heads/foo/bar` in one transaction.
      yield* Effect.promise(() => $`git branch --delete --force arena-main`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main/nested HEAD`.cwd(canonical.path).quiet())
      const third = yield* mirrorCanonicalRefs({ canonical: canonical.path, host })
      expect(third.origin).toBe(true)
      expect(third.deleted).toBe(1)
      expect(third.updated).toBe(1)
      const nested = (yield* Effect.promise(() => $`git for-each-ref --format="%(refname)"`.cwd(host).quiet().text())).trim().split("\n")
      expect(nested).toContain("refs/heads/arena-main/nested")
      expect(nested).not.toContain("refs/heads/arena-main")
    }),
  )

  // A warm host is mirrored in full at warm-up, so the send fetches only what moved since. The
  // host owns its objects, as a copied git directory does, so a missed fetch shows as a missing
  // object rather than being covered by alternates.
  it.live("fetches the objects of moved and required refs into a host mirrored before", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`git clone --bare --no-local --quiet ${canonical.path} ${host}`.quiet())
      yield* mirrorCanonicalRefs({ canonical: canonical.path, host })

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/next.txt`, "next\n", "utf8"))
      yield* Effect.promise(() => $`git add next.txt && git commit -m next`.cwd(canonical.path).quiet())
      const moved = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git branch --force arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch fresh HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base-only.txt`, "frozen\n", "utf8"))
      const frozen = (yield* Effect.promise(() =>
        $`git add base-only.txt && git commit -m frozen && git rev-parse HEAD && git reset --quiet --hard HEAD~1`
          .cwd(canonical.path)
          .quiet()
          .text(),
      ))
        .trim()
        .split("\n")
        .at(-1)!
      yield* Effect.promise(() => $`git update-ref refs/battles/chat/turn-2/base ${frozen}`.cwd(canonical.path).quiet())

      const result = yield* mirrorCanonicalRefs({
        canonical: canonical.path,
        host,
        requiredRefs: ["refs/battles/chat/turn-2/base"],
        fetchChangedOnly: true,
      })

      expect(result.updated).toBeGreaterThanOrEqual(2)
      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(host).quiet().text())).trim()).toBe(moved)
      expect((yield* Effect.promise(() => $`git rev-parse fresh`.cwd(host).quiet().text())).trim()).toBe(moved)
      for (const commit of [moved, frozen]) {
        const present = yield* Effect.promise(() => $`git cat-file -e ${commit}^{commit}`.cwd(host).quiet().nothrow())
        expect(present.exitCode).toBe(0)
      }
      const refs = (yield* Effect.promise(() => $`git for-each-ref --format="%(refname)"`.cwd(host).quiet().text())).trim()
      expect(refs).not.toContain("refs/battles/")
    }),
  )

  it.live("removes copied battle and side refs from a host on the next mirror", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`git init --bare --quiet ${host}`.quiet())
      yield* Effect.promise(() =>
        fs.writeFile(`${host}/objects/info/alternates`, `${canonical.path}/.git/objects\n`, "utf8"),
      )
      // What a copied git directory brings along.
      yield* Effect.promise(() => $`git update-ref refs/battles/chat/turn-1/base HEAD`.cwd(canonical.path).quiet())
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git update-ref refs/battles/chat/turn-1/a ${head}`.cwd(host).quiet())
      yield* Effect.promise(() => $`git update-ref refs/heads/agent-duel/chat-agent-b ${head}`.cwd(host).quiet())

      const result = yield* mirrorCanonicalRefs({ canonical: canonical.path, host })

      expect(result.deleted).toBe(2)
      const refs = (yield* Effect.promise(() => $`git for-each-ref --format="%(refname)"`.cwd(host).quiet().text()))
        .trim()
        .split("\n")
      expect(refs.filter((ref) => ref.startsWith("refs/battles/"))).toEqual([])
      expect(refs.filter((ref) => ref.startsWith("refs/heads/agent-duel/"))).toEqual([])
    }),
  )

  it.live("brings objects a stale host is missing before it moves the refs", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      // The warm host: a copy of the canonical git directory taken now, with its own objects and
      // no alternates. This is what `copyGitState` produces at the end of the previous turn.
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`cp -R ${canonical.path}/.git ${host}`.quiet())
      yield* Effect.promise(() => $`git config core.bare true`.cwd(host).quiet())

      // The developer commits and tags after the warm host was prepared.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/later.txt`, "later\n", "utf8"))
      yield* Effect.promise(() => $`git add later.txt && git commit -m later`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git tag -a v3 -m v3`.cwd(canonical.path).quiet())
      const later = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const tagObject = (
        yield* Effect.promise(() => $`git rev-parse refs/tags/v3`.cwd(canonical.path).quiet().text())
      ).trim()
      const absent = yield* Effect.promise(() => $`git cat-file -e ${later}`.cwd(host).quiet().nothrow())
      expect(absent.exitCode).not.toBe(0)

      yield* mirrorCanonicalRefs({ canonical: canonical.path, host })

      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(host).quiet().text())).trim()).toBe(later)
      expect((yield* Effect.promise(() => $`git rev-parse refs/tags/v3`.cwd(host).quiet().text())).trim()).toBe(tagObject)
      expect((yield* Effect.promise(() => $`git cat-file -t refs/tags/v3`.cwd(host).quiet().text())).trim()).toBe("tag")
    }),
  )

  it.live("brings a required private snapshot into a stale host without exposing its ref", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`cp -R ${canonical.path}/.git ${host}`.quiet())
      yield* Effect.promise(() => $`git config core.bare true`.cwd(host).quiet())

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/snapshot.txt`, "snapshot\n", "utf8"))
      yield* Effect.promise(() => $`git add snapshot.txt && git commit -m snapshot`.cwd(canonical.path).quiet())
      const snapshot = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const snapshotRef = "refs/battles/chat/turn-2/base"
      yield* Effect.promise(() => $`git update-ref ${snapshotRef} ${snapshot}`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git reset --hard ${head}`.cwd(canonical.path).quiet())
      expect((yield* Effect.promise(() => $`git cat-file -e ${snapshot}`.cwd(host).quiet().nothrow())).exitCode).not.toBe(0)

      yield* mirrorCanonicalRefs({ canonical: canonical.path, host, requiredRefs: [snapshotRef] })

      expect((yield* Effect.promise(() => $`git cat-file -e ${snapshot}`.cwd(host).quiet().nothrow())).exitCode).toBe(0)
      expect((yield* Effect.promise(() => $`git show-ref --verify ${snapshotRef}`.cwd(host).quiet().nothrow())).exitCode).not.toBe(0)
    }),
  )

  it.live("mirrors around a symbolic remote ref without moving or deleting its target", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      // What a clone leaves behind: a remote-tracking branch and a symbolic ref for it.
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() =>
        $`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.cwd(canonical.path).quiet(),
      )
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`cp -R ${canonical.path}/.git ${host}`.quiet())
      yield* Effect.promise(() => $`git config core.bare true`.cwd(host).quiet())

      // The developer fetches: `origin/main` moves, and `origin/HEAD` reports the same new object.
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/later.txt`, "later\n", "utf8"))
      yield* Effect.promise(() => $`git add later.txt && git commit -m later`.cwd(canonical.path).quiet())
      const later = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/main ${later}`.cwd(canonical.path).quiet())

      yield* mirrorCanonicalRefs({ canonical: canonical.path, host })

      expect(
        (yield* Effect.promise(() => $`git rev-parse refs/remotes/origin/main`.cwd(host).quiet().text())).trim(),
      ).toBe(later)
      expect(
        (yield* Effect.promise(() => $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(host).quiet().text())).trim(),
      ).toBe("refs/remotes/origin/main")

      // The developer drops the symbolic ref. Deleting it in the host would delete its target.
      yield* Effect.promise(() => $`git symbolic-ref --delete refs/remotes/origin/HEAD`.cwd(canonical.path).quiet())

      yield* mirrorCanonicalRefs({ canonical: canonical.path, host })

      expect(
        (yield* Effect.promise(() => $`git rev-parse refs/remotes/origin/main`.cwd(host).quiet().text())).trim(),
      ).toBe(later)
    }),
  )

  it.live("mirror refetches the objects of a torn host copy even when no ref moved", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const tip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`cp -R ${canonical.path}/.git ${host}`.quiet())
      yield* Effect.promise(() => $`git config core.bare true`.cwd(host).quiet())

      // What a copy of a live repository leaves behind when the developer commits between the
      // read of `objects/` and the read of `refs/`: a ref naming an object the host does not have.
      yield* Effect.promise(() => fs.rm(`${host}/objects/${tip.slice(0, 2)}/${tip.slice(2)}`))
      const absent = yield* Effect.promise(() => $`git cat-file -e ${tip}`.cwd(host).quiet().nothrow())
      expect(absent.exitCode).not.toBe(0)

      // The canonical is unchanged, so no ref value differs and nothing is updated or deleted.
      const result = yield* mirrorCanonicalRefs({ canonical: canonical.path, host })
      expect(result.updated).toBe(0)

      const present = yield* Effect.promise(() => $`git cat-file -e ${tip}`.cwd(host).quiet().nothrow())
      expect(present.exitCode).toBe(0)
      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(host).quiet().text())).trim()).toBe(tip)
    }),
  )

  it.live("snapshots host refs at setup and reports the moved, created, and deleted ones", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      const side = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const feature = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch doomed HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch untouched HEAD`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/arena-main HEAD`.cwd(canonical.path).quiet())
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`git init --bare --quiet ${host}`.quiet())
      yield* Effect.promise(() => $`git config user.name arena-test`.cwd(host).quiet())
      yield* Effect.promise(() => $`git config user.email arena-test@localhost`.cwd(host).quiet())
      yield* Effect.promise(() =>
        fs.writeFile(`${host}/objects/info/alternates`, `${canonical.path}/.git/objects\n`, "utf8"),
      )
      yield* Effect.promise(() => $`git worktree add -B ${feature} ${side.path}/tree ${frozenHead}`.cwd(host).quiet())
      yield* mirrorCanonicalRefs({ canonical: canonical.path, host })
      yield* Effect.promise(() => $`git update-ref refs/heads/agent-duel/chat-agent-a ${frozenHead}`.cwd(host).quiet())

      const snapshot = yield* snapshotHostRefs({ host })
      // feature, arena-main, doomed, untouched, origin/arena-main; the side branch is not recorded.
      expect(snapshot.count).toBe(5)
      const recorded = (
        yield* Effect.promise(() =>
          $`git for-each-ref --format="%(refname)" refs/agent-duel/start/`.cwd(host).quiet().text(),
        )
      )
        .trim()
        .split("\n")
      expect(recorded).toContain("refs/agent-duel/start/heads/arena-main")
      expect(recorded).toContain("refs/agent-duel/start/remotes/origin/arena-main")
      expect(recorded).not.toContain("refs/agent-duel/start/heads/agent-duel/chat-agent-a")

      // The contestant commits on the chat branch, moves arena-main, tags it, moves the
      // remote-tracking ref, creates one branch, deletes one.
      const tree = `${side.path}/tree`
      yield* Effect.promise(() => fs.writeFile(`${tree}/side.txt`, "side\n", "utf8"))
      yield* Effect.promise(() => $`git add side.txt && git commit -m side`.cwd(tree).quiet())
      yield* Effect.promise(() => $`git checkout -q arena-main`.cwd(tree).quiet())
      yield* Effect.promise(() => fs.writeFile(`${tree}/main.txt`, "main\n", "utf8"))
      yield* Effect.promise(() => $`git add main.txt && git commit -m on-main`.cwd(tree).quiet())
      const mainTip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tree).quiet().text())).trim()
      yield* Effect.promise(() => $`git tag -a v2 -m v2`.cwd(tree).quiet())
      const tagObject = (yield* Effect.promise(() => $`git rev-parse refs/tags/v2`.cwd(tree).quiet().text())).trim()
      expect(tagObject).not.toBe(mainTip)
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/arena-main ${mainTip}`.cwd(tree).quiet())
      yield* Effect.promise(() => $`git checkout -q ${feature}`.cwd(tree).quiet())
      yield* Effect.promise(() => $`git branch created HEAD`.cwd(tree).quiet())
      yield* Effect.promise(() => $`git branch -D doomed`.cwd(tree).quiet())
      const featureTip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tree).quiet().text())).trim()

      const changes = yield* diffHostRefs({ host, exclude: [`refs/heads/${feature}`] })

      expect(changes).toEqual([
        { ref: "refs/heads/arena-main", before: frozenHead, after: mainTip },
        { ref: "refs/heads/created", after: featureTip },
        { ref: "refs/heads/doomed", before: frozenHead },
        { ref: "refs/remotes/origin/arena-main", before: frozenHead, after: mainTip },
        { ref: "refs/tags/v2", after: tagObject },
      ])
      expect(refLabel("refs/heads/arena-main")).toBe("arena-main")
      expect(refLabel("refs/tags/v2")).toBe("tag v2")
      expect(refLabel("refs/remotes/origin/arena-main")).toBe("origin/arena-main")

      // The annotated tag is imported as its tag object, not the commit it points at.
      const destination = "refs/battles/chat/turn-1/a-refs/tags/v2"
      yield* importWinnerRef({
        canonical: canonical.path,
        sourceRepository: host,
        sourceRef: "refs/tags/v2",
        destinationRef: destination,
        expected: tagObject,
      })
      expect(
        (yield* Effect.promise(() => $`git rev-parse ${destination}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe(tagObject)
      expect(
        (yield* Effect.promise(() => $`git cat-file -t ${destination}`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe("tag")
      // A second import with the same expectation is a no-op: it never reads the source, proven
      // by pointing it at a repository that does not exist. A wrong expectation is an error.
      yield* importWinnerRef({
        canonical: canonical.path,
        sourceRepository: "/nonexistent-source-repository",
        sourceRef: "refs/tags/v2",
        destinationRef: destination,
        expected: tagObject,
      })
      const wrong = yield* importWinnerRef({
        canonical: canonical.path,
        sourceRepository: host,
        sourceRef: "refs/tags/v2",
        destinationRef: destination,
        expected: mainTip,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(wrong)).toBe(true)

      // A second snapshot replaces the first, so the next turn starts clean.
      const again = yield* snapshotHostRefs({ host })
      expect(again.count).toBe(6)
      expect(yield* diffHostRefs({ host, exclude: [`refs/heads/${feature}`] })).toEqual([])
    }),
  )

  it.live("never records or reports a symbolic ref, only the ref it points at", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const hostDir = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const host = `${hostDir.path}/host.git`
      yield* Effect.promise(() => $`git init --bare --quiet ${host}`.quiet())
      yield* Effect.promise(() =>
        fs.writeFile(`${host}/objects/info/alternates`, `${canonical.path}/.git/objects\n`, "utf8"),
      )
      // What `git clone` leaves behind: origin/HEAD is a symbolic ref for origin/main.
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/main ${base}`.cwd(host).quiet())
      yield* Effect.promise(() =>
        $`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.cwd(host).quiet(),
      )
      // for-each-ref gives a symbolic ref its target's object id, so the two are indistinguishable
      // without %(symref). This is why the filter cannot be written against the object ids.
      const listed = (
        yield* Effect.promise(() =>
          $`git for-each-ref --format="%(objectname) %(refname)" refs/remotes/`.cwd(host).quiet().text(),
        )
      ).trim()
      expect(listed).toBe(`${base} refs/remotes/origin/HEAD\n${base} refs/remotes/origin/main`)

      // Only origin/main is recorded; origin/HEAD is not.
      const snapshot = yield* snapshotHostRefs({ host })
      expect(snapshot.count).toBe(1)
      const recorded = (
        yield* Effect.promise(() =>
          $`git for-each-ref --format="%(refname)" refs/agent-duel/start/`.cwd(host).quiet().text(),
        )
      ).trim()
      expect(recorded).toBe("refs/agent-duel/start/remotes/origin/main")

      // The contestant moves origin/main. origin/HEAD follows it and must not be reported.
      const tip = yield* Effect.promise(async () => {
        await fs.writeFile(`${canonical.path}/tip.txt`, "tip\n", "utf8")
        await $`git add tip.txt && git commit -q -m tip`.cwd(canonical.path).quiet()
        return (await $`git rev-parse HEAD`.cwd(canonical.path).quiet().text()).trim()
      })
      yield* Effect.promise(() => $`git update-ref refs/remotes/origin/main ${tip}`.cwd(host).quiet())

      expect(yield* diffHostRefs({ host, exclude: [] })).toEqual([
        { ref: "refs/remotes/origin/main", before: base, after: tip },
      ])
      // It really is still symbolic, so the absence above is the filter and not a broken fixture.
      expect(
        (
          yield* Effect.promise(() => $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(host).quiet().text())
        ).trim(),
      ).toBe("refs/remotes/origin/main")
    }),
  )

  /**
   * A repository with one base commit on the checked-out branch, and a detached commit helper
   * that builds contestant tips without moving any canonical branch.
   */
  const refFixture = Effect.gen(function* () {
    const canonical = yield* scopedTmpdir({ git: true })
    yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
    yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
    const feature = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
    const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
    const commit = (name: string, parent: string, content = `${name}\n`, file = `${name}.txt`) =>
      Effect.promise(async () => {
        await $`git checkout -q --detach ${parent}`.cwd(canonical.path).quiet()
        await fs.writeFile(`${canonical.path}/${file}`, content, "utf8")
        await $`git add ${file} && git commit -q -m ${name}`.cwd(canonical.path).quiet()
        const head = (await $`git rev-parse HEAD`.cwd(canonical.path).quiet().text()).trim()
        await $`git checkout -q ${feature}`.cwd(canonical.path).quiet()
        return head
      })
    const prefix = "refs/battles/chat/turn-1/a-refs"
    const imported = (ref: string, oid: string) =>
      Effect.promise(() => $`git update-ref ${prefix}/${ref.slice("refs/".length)} ${oid}`.cwd(canonical.path).quiet())
    const at = (ref: string) =>
      Effect.promise(async () =>
        (await $`git rev-parse --verify --quiet ${ref}`.cwd(canonical.path).quiet().nothrow().text()).trim(),
      )
    const git = (args: string[]) => Effect.promise(() => $`git ${args}`.cwd(canonical.path).quiet())
    return { canonical, feature, base, commit, prefix, imported, at, git }
  })

  it.live("measures each ref the winner changed and decides it by the review rules", () =>
    Effect.gen(function* () {
      const { canonical, feature, base, commit, prefix, imported, at, git } = yield* refFixture
      const other = yield* scopedTmpdir()
      for (const name of ["ff", "both", "busy", "already", "doomed", "doomed-moved", "rewound", "edit"]) {
        yield* git(["branch", name, base])
      }
      yield* git(["update-ref", "refs/remotes/origin/ff", base])
      yield* git(["tag", "moved-tag", base])
      const ffTip = yield* commit("ff", base)
      const agentBoth = yield* commit("agent-both", base)
      const yoursBoth = yield* commit("yours-both", base)
      const busyTip = yield* commit("busy", base)
      const createdTip = yield* commit("created", base)
      const ahead = yield* commit("ahead", base)
      const beyond = yield* commit("beyond", ahead)
      const editTip = yield* commit("edit", base, "edited\n", "base.txt")
      yield* git(["update-ref", "refs/remotes/origin/back", ffTip])
      // The developer's moves during the battle.
      yield* git(["branch", "-f", "both", yoursBoth])
      yield* git(["branch", "-f", "already", beyond])
      yield* git(["branch", "-f", "doomed-moved", yoursBoth])
      yield* git(["branch", "-f", "rewound", base])
      yield* git(["worktree", "add", `${other.path}/busy`, "busy"])
      const changes = [
        { ref: "refs/heads/ff", before: base, after: ffTip },
        { ref: "refs/heads/both", before: base, after: agentBoth },
        { ref: "refs/heads/busy", before: base, after: busyTip },
        { ref: "refs/heads/created", after: createdTip },
        { ref: "refs/heads/already", before: base, after: ahead },
        { ref: "refs/heads/doomed", before: base },
        { ref: "refs/heads/doomed-moved", before: base },
        // The developer rewound this one from `ahead` to `base`; following the agent to `beyond`
        // would undo that, so it is a question and not a fast-forward.
        { ref: "refs/heads/rewound", before: ahead, after: beyond },
        { ref: "refs/heads/edit", before: base, after: editTip },
        { ref: `refs/heads/${feature}`, before: base, after: ffTip },
        { ref: "refs/remotes/origin/ff", before: base, after: ffTip },
        { ref: "refs/remotes/origin/back", before: ffTip, after: base },
        { ref: "refs/tags/new-tag", after: createdTip },
        { ref: "refs/tags/moved-tag", before: base, after: ffTip },
        { ref: "refs/notes/commits", after: ffTip },
      ]
      for (const change of changes) if (change.after) yield* imported(change.ref, change.after)
      yield* git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/ff"])
      yield* imported("refs/remotes/origin/HEAD", ffTip)

      const observed = yield* observeWinnerRefs({
        canonical: canonical.path,
        changes: [...changes, { ref: "refs/remotes/origin/HEAD", before: base, after: ffTip }],
        sourceRefPrefix: prefix,
        checkoutBranch: feature,
      })

      expect(observed.skipped).toEqual([
        { ref: "refs/notes/commits", action: "skipped", reason: "refs/notes/commits is outside the refs a battle carries over." },
        { ref: "refs/remotes/origin/HEAD", action: "skipped", reason: "origin/HEAD is a symbolic ref for origin/ff." },
      ])
      const decisions = Object.fromEntries(observed.refs.map((item) => [item.ref, decideRef(item)]))
      expect(decisions).toEqual({
        "refs/heads/ff": { kind: "apply", action: "agent" },
        "refs/heads/both": { kind: "apply", action: "agent_on_yours" },
        "refs/heads/busy": { kind: "ask", proposal: "agent", choices: ["agent", "yours"] },
        "refs/heads/created": { kind: "apply", action: "agent" },
        "refs/heads/already": { kind: "none" },
        "refs/heads/doomed": { kind: "ask", proposal: "agent", choices: ["agent", "yours"] },
        "refs/heads/doomed-moved": { kind: "apply", action: "yours" },
        "refs/heads/rewound": { kind: "apply", action: "agent_on_yours" },
        "refs/heads/edit": { kind: "apply", action: "agent" },
        [`refs/heads/${feature}`]: { kind: "apply", action: "agent" },
        "refs/remotes/origin/ff": { kind: "apply", action: "agent" },
        "refs/remotes/origin/back": { kind: "skip" },
        "refs/tags/new-tag": { kind: "apply", action: "agent" },
        "refs/tags/moved-tag": { kind: "ask", proposal: "agent", choices: ["agent", "yours"] },
      })
      const byRef = new Map(observed.refs.map((item) => [item.ref, item]))
      expect(byRef.get(`refs/heads/${feature}`)?.checkout).toBe(true)
      // git reports the worktree's real path, which may differ from the tmpdir string on macOS.
      expect(byRef.get("refs/heads/busy")?.checkedOutAt).toMatch(/\/busy$/)
      expect(byRef.get("refs/heads/rewound")).toMatchObject({ agentMove: "added", yourMove: "rewrote", fastForward: false })
      expect(byRef.get("refs/heads/edit")).toMatchObject({ agentMove: "added", yourMove: "untouched" })
      expect(byRef.get("refs/heads/both")?.fingerprint).toBe(`${base}:${agentBoth}:${yoursBoth}:-`)

      // Nothing was written.
      expect(yield* at("refs/heads/ff")).toBe(base)
      expect(yield* at("refs/heads/created")).toBe("")

      // A missing imported object is an error, not a skip.
      const missing = yield* observeWinnerRefs({
        canonical: canonical.path,
        changes: [{ ref: "refs/heads/ghost", after: ffTip }],
        sourceRefPrefix: prefix,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) {
        expect((Cause.squash(missing.cause) as OperationError).operation).toBe("winner_ref_missing")
      }
    }),
  )

  it.live("reports the files a combine would clash on", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, prefix, imported, git } = yield* refFixture
      yield* git(["branch", "shared", base])
      const agentTip = yield* commit("agent", base, "agent line\n", "shared.txt")
      const yoursTip = yield* commit("yours", base, "your line\n", "shared.txt")
      yield* git(["branch", "-f", "shared", yoursTip])
      yield* imported("refs/heads/shared", agentTip)

      const observed = yield* observeWinnerRefs({
        canonical: canonical.path,
        changes: [{ ref: "refs/heads/shared", before: base, after: agentTip }],
        sourceRefPrefix: prefix,
      })

      expect(observed.refs[0]?.clash).toEqual({ agent_on_yours: ["shared.txt"] })
      expect(decideRef(observed.refs[0]!)).toEqual({ kind: "ask", proposal: "ask_agent", choices: ["agent", "yours"] })
    }),
  )

  it.live("settles a rewrite the developer merged, but not a rewind the developer still holds", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, prefix, imported } = yield* refFixture
      const run = (args: string[]) =>
        Effect.promise(async () => (await $`git ${args}`.cwd(canonical.path).quiet().text()).trim())
      const start = yield* commit("start", base)
      const mine = yield* commit("mine", start)
      // The agent amended `start`; the developer added `mine` and then merged the amended line in.
      const amended = yield* commit("amended", base)
      const merged = yield* run(["commit-tree", `${mine}^{tree}`, "-p", mine, "-p", amended, "-m", "merge"])
      yield* run(["branch", "combined", merged])
      // The agent rewound `start` away; the developer's branch still holds it.
      yield* run(["branch", "rewound", start])
      const changes = [
        { ref: "refs/heads/combined", before: start, after: amended },
        { ref: "refs/heads/rewound", before: start, after: base },
      ]
      for (const change of changes) yield* imported(change.ref, change.after)

      const observed = yield* observeWinnerRefs({ canonical: canonical.path, changes, sourceRefPrefix: prefix })

      const decisions = Object.fromEntries(observed.refs.map((item) => [item.ref, decideRef(item)]))
      expect(decisions).toEqual({
        "refs/heads/combined": { kind: "none" },
        // Not settled, but the agent added nothing there, so the developer's branch is kept.
        "refs/heads/rewound": { kind: "apply", action: "yours" },
      })
      // The branch the winner ended on is the exception: there the rewind is likely the task.
      const rewound = observed.refs.find((item) => item.ref === "refs/heads/rewound")!
      expect(decideRef({ ...rewound, checkout: true })).toEqual({ kind: "ask", proposal: "agent", choices: ["agent", "yours"] })
      // The callout names what leaves the branch and where it lands.
      expect(observed.refs.find((item) => item.ref === "refs/heads/rewound")).toMatchObject({
        rewound: true,
        lost: 1,
        lostSubjects: [expect.any(String)],
        agentSubject: expect.any(String),
      })
    }),
  )

  it.live("reports the checkout's own branch only when the vote combined, created, or rewound it", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, at } = yield* refFixture
      const ahead = yield* commit("ahead", base)
      const other = yield* commit("other", base)
      const report = (move: CheckoutMove, after: string) =>
        reportCheckoutMove({ canonical: canonical.path, move, after, backupPrefix: "refs/battles/c/turn-0/replaced" })

      // A plain fast-forward is the ordinary battle.
      expect(yield* report({ ref: "refs/heads/main", before: base }, ahead)).toBeUndefined()
      expect(yield* report({ ref: "refs/heads/new" }, ahead)).toEqual({ ref: "refs/heads/new", action: "created" })
      expect(yield* report({ ref: "refs/heads/main", before: base, how: "agent_on_yours" }, ahead)).toEqual({
        ref: "refs/heads/main",
        action: "updated",
        how: "agent_on_yours",
      })
      // A tip the branch no longer reaches is kept, like a ref write keeps it.
      expect(yield* report({ ref: "refs/heads/main", before: other }, ahead)).toEqual({
        ref: "refs/heads/main",
        action: "updated",
        removed: 1,
        backupRef: "refs/battles/c/turn-0/replaced/heads/main",
      })
      expect(yield* at("refs/battles/c/turn-0/replaced/heads/main")).toBe(other)
    }),
  )

  it.live("writes every accepted ref in one transaction and keeps what each write replaced", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, prefix, imported, at, git } = yield* refFixture
      for (const name of ["ff", "both", "doomed", "rewrite"]) yield* git(["branch", name, base])
      yield* git(["tag", "moved-tag", base])
      const ffTip = yield* commit("ff", base)
      const agentBoth = yield* commit("agent-both", base)
      const yoursBoth = yield* commit("yours-both", base)
      const kept = yield* commit("kept", base)
      const rewriteTip = yield* commit("rewrite", base, "rewritten\n", "base.txt")
      yield* git(["branch", "-f", "both", yoursBoth])
      yield* git(["branch", "-f", "rewrite", kept])
      for (const [ref, oid] of [
        ["refs/heads/ff", ffTip],
        ["refs/heads/both", agentBoth],
        ["refs/heads/rewrite", rewriteTip],
        ["refs/heads/created", ffTip],
        ["refs/tags/moved-tag", ffTip],
      ] as const) {
        yield* imported(ref, oid)
      }
      const backupPrefix = "refs/battles/chat/turn-1/backup"

      const outcomes = yield* writeWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [
          { ref: "refs/heads/ff", action: "agent", start: base, agent: ffTip, yours: base },
          { ref: "refs/heads/both", action: "agent_on_yours", start: base, agent: agentBoth, yours: yoursBoth },
          { ref: "refs/heads/doomed", action: "agent", start: base, yours: base },
          { ref: "refs/heads/rewrite", action: "agent", start: base, agent: rewriteTip, yours: kept },
          { ref: "refs/heads/created", action: "agent", agent: ffTip },
          { ref: "refs/tags/moved-tag", action: "agent", start: base, agent: ffTip, yours: base },
        ],
      })

      expect(outcomes).toEqual([
        { ref: "refs/heads/ff", action: "updated" },
        { ref: "refs/heads/both", action: "updated", how: "agent_on_yours" },
        { ref: "refs/heads/doomed", action: "deleted", backupRef: `${backupPrefix}/heads/doomed` },
        { ref: "refs/heads/rewrite", action: "updated", removed: 1, backupRef: `${backupPrefix}/heads/rewrite` },
        { ref: "refs/heads/created", action: "created" },
        { ref: "refs/tags/moved-tag", action: "updated" },
      ])
      expect(yield* at("refs/heads/ff")).toBe(ffTip)
      expect(yield* at("refs/heads/doomed")).toBe("")
      expect(yield* at("refs/heads/rewrite")).toBe(rewriteTip)
      expect(yield* at("refs/heads/created")).toBe(ffTip)
      expect(yield* at("refs/tags/moved-tag")).toBe(ffTip)
      // The agent's commit replayed on top of the developer's, with both files present.
      const combined = yield* at("refs/heads/both")
      expect(yield* at("refs/heads/both^")).toBe(yoursBoth)
      const files = (yield* Effect.promise(() => $`git ls-tree --name-only ${combined}`.cwd(canonical.path).quiet().text()))
        .trim()
        .split("\n")
      expect(files).toEqual(["agent-both.txt", "base.txt", "yours-both.txt"])
      // Every replaced value is kept, including the one the developer would otherwise lose.
      expect(yield* at(`${backupPrefix}/heads/rewrite`)).toBe(kept)
      expect(yield* at(`${backupPrefix}/heads/both`)).toBe(yoursBoth)
      expect(yield* at(`${backupPrefix}/heads/doomed`)).toBe(base)
    }),
  )

  it.live("writes nothing when one ref moved after the decision or cannot be written", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, prefix, imported, at, git } = yield* refFixture
      for (const name of ["ff", "guarded", "stack"]) yield* git(["branch", name, base])
      const tip = yield* commit("tip", base)
      const later = yield* commit("later", base)
      for (const ref of ["refs/heads/ff", "refs/heads/guarded", "refs/heads/stack/x"]) yield* imported(ref, tip)
      // The developer moves `guarded` after the decision was made on `base`.
      yield* git(["branch", "-f", "guarded", later])
      const backupPrefix = "refs/battles/chat/turn-1/backup"

      const stale = yield* writeWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [
          { ref: "refs/heads/ff", action: "agent", start: base, agent: tip, yours: base },
          { ref: "refs/heads/guarded", action: "agent", start: base, agent: tip, yours: base },
        ],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale)) {
        expect((Cause.squash(stale.cause) as OperationError).operation).toBe("write_winner_refs")
      }
      // `stack` blocks the name `stack/x`: git cannot hold a ref and a directory of the same name.
      const blocked = yield* writeWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [
          { ref: "refs/heads/ff", action: "agent", start: base, agent: tip, yours: base },
          { ref: "refs/heads/stack/x", action: "agent", agent: tip },
        ],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)

      expect(yield* at("refs/heads/ff")).toBe(base)
      expect(yield* at("refs/heads/guarded")).toBe(later)
      expect(yield* at("refs/heads/stack/x")).toBe("")
      expect(yield* at(`${backupPrefix}/heads/ff`)).toBe("")
    }),
  )

  it.live("holds the refs locked and checked until the caller commits or aborts", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, imported, at, git } = yield* refFixture
      yield* git(["branch", "ff", base])
      yield* git(["branch", "guarded", base])
      const tip = yield* commit("tip", base)
      const later = yield* commit("later", base)
      for (const ref of ["refs/heads/ff", "refs/heads/guarded"]) yield* imported(ref, tip)
      const backupPrefix = "refs/battles/chat/turn-1/backup"
      const writes = [{ ref: "refs/heads/ff", action: "agent" as const, start: base, agent: tip, yours: base }]
      const tryMove = (ref: string, to: string) =>
        Effect.promise(() => $`git update-ref ${ref} ${to}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.map((result) => result.exitCode),
        )

      // Held: locked against every other writer, and nothing written yet.
      const held = yield* holdWinnerRefs({ canonical: canonical.path, backupPrefix, writes })
      expect(yield* tryMove("refs/heads/ff", later)).not.toBe(0)
      expect(yield* at("refs/heads/ff")).toBe(base)
      yield* held.abort
      expect(yield* at("refs/heads/ff")).toBe(base)
      expect(yield* at(`${backupPrefix}/heads/ff`)).toBe("")

      // Released by the abort, and written by a commit.
      const again = yield* holdWinnerRefs({ canonical: canonical.path, backupPrefix, writes })
      expect(yield* again.commit).toEqual([{ ref: "refs/heads/ff", action: "updated" }])
      yield* again.abort
      expect(yield* at("refs/heads/ff")).toBe(tip)
      expect(yield* at(`${backupPrefix}/heads/ff`)).toBe(base)

      // A ref that moved, or one another Git process has locked, fails at the hold.
      yield* git(["branch", "-f", "guarded", later])
      const stale = yield* holdWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [{ ref: "refs/heads/guarded", action: "agent", start: base, agent: tip, yours: base }],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/.git/refs/heads/guarded.lock`, ""))
      const locked = yield* holdWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [{ ref: "refs/heads/guarded", action: "agent", start: base, agent: tip, yours: later }],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(locked)).toBe(true)
      if (Exit.isFailure(locked)) {
        expect((Cause.squash(locked.cause) as OperationError).operation).toBe("write_winner_refs")
        expect((Cause.squash(locked.cause) as OperationError).message).toStartWith("cannot lock ref 'refs/heads/guarded'")
      }
      expect(yield* at("refs/heads/guarded")).toBe(later)
    }),
  )

  it.live("puts back a target branch the promotion rewrote when a later ref write fails", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmpdir({ git: true })
      const other = yield* scopedTmpdir()
      const sh = (cmd: string, cwd = repo.path) =>
        Effect.promise(async () => (await $`sh -c ${cmd}`.cwd(cwd).quiet().nothrow().text()).trim())
      yield* sh("echo base > base.txt && git add . && git commit -qm base")
      const main = yield* sh("git branch --show-current")
      const base = yield* sh("git rev-parse HEAD")
      yield* sh("git branch feat && git checkout -q feat && echo mine > mine.txt && git add . && git commit -qm mine")
      const yours = yield* sh("git rev-parse HEAD")
      // The agent rewrote `feat`: its tip is not above the developer's.
      yield* sh(`git checkout -q --detach ${base} && echo agent > agent.txt && git add . && git commit -qm agent`)
      const agent = yield* sh("git rev-parse HEAD")
      yield* sh(`git checkout -q ${main} && git branch side ${base}`)
      yield* sh(`git worktree add -q ${other.path}/side side`)
      const sideGitDir = yield* sh("git rev-parse --absolute-git-dir", `${other.path}/side`)
      const safetyRef = "refs/battles/c/turn-1/public-safety"
      const promote = promoteWinnerState({
        canonical: repo.path,
        expectedBranch: main,
        targetBranch: "feat",
        frozenHead: base,
        baseWorkingTree: base,
        baseIndexTree: base,
        resultCommit: agent,
        finalIndexTree: agent,
        checkoutAction: { action: "agent", start: yours, agent },
        safetyRef,
        retainSafetyRef: true,
      })
      const recover = recoverFailedPromotion({ canonical: repo.path, safetyRef, expectedBranch: main, targetBranch: "feat" })

      // The checkout lands on the rewritten `feat`, then `side` cannot be taken: its worktree is locked.
      const held = yield* holdWinnerRefs({
        canonical: repo.path,
        backupPrefix: "refs/battles/c/turn-1/replaced",
        writes: [{ ref: "refs/heads/side", action: "agent", start: base, agent, yours: base, checkedOutAt: `${other.path}/side` }],
      })
      const written = yield* promote
      yield* Effect.promise(() => fs.writeFile(`${sideGitDir}/HEAD.lock`, ""))
      expect(Exit.isFailure(yield* held.commit.pipe(Effect.exit))).toBe(true)
      yield* held.abort

      // Arena's own rewrite is not "someone moved it": the undo puts everything back.
      expect(yield* recover).toBe(true)
      expect(yield* sh("git branch --show-current")).toBe(main)
      expect(yield* sh("git rev-parse feat")).toBe(yours)
      expect(yield* sh("git rev-parse side")).toBe(base)
      expect(yield* sh("git for-each-ref refs/battles")).toBe("")

      // A commit of the developer's on top of what Arena wrote is theirs: the undo leaves it alone.
      yield* Effect.promise(() => fs.rm(`${sideGitDir}/HEAD.lock`))
      yield* promote
      expect(yield* sh("git rev-parse feat")).toBe(written.resultingHead)
      yield* sh("echo later > later.txt && git add . && git commit -qm later")
      const later = yield* sh("git rev-parse HEAD")
      expect(Exit.isFailure(yield* recover.pipe(Effect.exit))).toBe(true)
      expect(yield* sh("git rev-parse feat")).toBe(later)
    }),
  )

  it.live("fingerprints the developer's edits by content, not only by name", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmpdir({ git: true })
      const write = (text: string) => Effect.promise(() => fs.writeFile(`${repo.path}/NOTES.md`, text, "utf8"))
      yield* write("base\n")
      yield* Effect.promise(() => $`git add NOTES.md && git commit -qm base`.cwd(repo.path).quiet())
      yield* write("mine\n")
      const first = yield* editsFingerprint(repo.path, ["NOTES.md", "gone.md"])
      expect(yield* editsFingerprint(repo.path, ["NOTES.md", "gone.md"])).toBe(first)
      // Edited again: the earlier answer no longer matches.
      yield* write("mine, edited again\n")
      const edited = yield* editsFingerprint(repo.path, ["NOTES.md", "gone.md"])
      expect(edited).not.toBe(first)
      // Staged without changing the file: the index is the developer's work too.
      yield* Effect.promise(() => $`git add NOTES.md`.cwd(repo.path).quiet())
      expect(yield* editsFingerprint(repo.path, ["NOTES.md", "gone.md"])).not.toBe(edited)
    }),
  )

  it.live("names the Git operation a checkout is part way through", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(`${repo.path}/a.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add a.txt && git commit -qm base`.cwd(repo.path).quiet())
      const main = (yield* Effect.promise(() => $`git branch --show-current`.cwd(repo.path).quiet().text())).trim()
      expect(yield* repositoryOperation(repo.path)).toBeUndefined()
      yield* Effect.promise(() => $`git switch -qc side`.cwd(repo.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${repo.path}/a.txt`, "side\n", "utf8"))
      yield* Effect.promise(() => $`git commit -qam side`.cwd(repo.path).quiet())
      yield* Effect.promise(() => $`git switch -q ${main}`.cwd(repo.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${repo.path}/a.txt`, "main\n", "utf8"))
      yield* Effect.promise(() => $`git commit -qam main`.cwd(repo.path).quiet())
      yield* Effect.promise(() => $`git merge side`.cwd(repo.path).quiet().nothrow())
      expect(yield* repositoryOperation(repo.path)).toBe("merge")
      yield* Effect.promise(() => $`git merge --abort`.cwd(repo.path).quiet())
      expect(yield* repositoryOperation(repo.path)).toBeUndefined()
    }),
  )

  it.live("reports where a branch the trunk may switch to stands", () =>
    Effect.gen(function* () {
      const repo = yield* scopedTmpdir({ git: true })
      const other = yield* scopedTmpdir()
      yield* Effect.promise(() => $`git commit -q --allow-empty -m base`.cwd(repo.path).quiet())
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(repo.path).quiet().text())).trim()
      const main = (yield* Effect.promise(() => $`git branch --show-current`.cwd(repo.path).quiet().text())).trim()
      expect(yield* inspectBranchTarget({ canonical: repo.path, branch: "missing" })).toEqual({ valid: true })
      expect(yield* inspectBranchTarget({ canonical: repo.path, branch: "bad..name" })).toEqual({ valid: false })
      // The trunk's own branch is not "checked out elsewhere".
      expect(yield* inspectBranchTarget({ canonical: repo.path, branch: main })).toEqual({ valid: true, tip: head })
      yield* Effect.promise(() => $`git worktree add -q -b busy ${other.path}/wt`.cwd(repo.path).quiet())
      const busy = yield* inspectBranchTarget({ canonical: repo.path, branch: "busy" })
      expect(busy.valid && busy.tip).toBe(head)
      expect(busy.valid && busy.checkedOutAt).toEndWith("/wt")
    }),
  )

  it.live("takes a branch another worktree has checked out by detaching that worktree", () =>
    Effect.gen(function* () {
      const { canonical, base, commit, prefix, imported, at, git } = yield* refFixture
      const other = yield* scopedTmpdir()
      yield* git(["branch", "busy", base])
      yield* git(["branch", "stuck", base])
      yield* git(["worktree", "add", `${other.path}/busy`, "busy"])
      yield* git(["worktree", "add", `${other.path}/stuck`, "stuck"])
      yield* Effect.promise(() => fs.writeFile(`${other.path}/busy/draft.txt`, "draft\n", "utf8"))
      const tip = yield* commit("tip", base)
      const later = yield* commit("later", base)
      yield* imported("refs/heads/busy", tip)
      yield* imported("refs/heads/stuck", tip)
      const branchOf = (path: string) =>
        Effect.promise(async () =>
          (await $`git symbolic-ref --quiet --short HEAD`.cwd(path).quiet().nothrow().text()).trim(),
        )
      const backupPrefix = "refs/battles/chat/turn-1/backup"

      const taken = yield* writeWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [{ ref: "refs/heads/busy", action: "agent", start: base, agent: tip, yours: base, checkedOutAt: `${other.path}/busy` }],
      })
      expect(taken).toEqual([{ ref: "refs/heads/busy", action: "updated" }])
      expect(yield* at("refs/heads/busy")).toBe(tip)
      expect(yield* branchOf(`${other.path}/busy`)).toBe("")
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(`${other.path}/busy`).quiet().text())).trim()).toBe(base)
      expect(yield* Effect.promise(() => fs.readFile(`${other.path}/busy/draft.txt`, "utf8"))).toBe("draft\n")

      // A failed transaction puts the worktree back on its branch.
      yield* git(["update-ref", "refs/heads/stuck", later])
      const failed = yield* writeWinnerRefs({
        canonical: canonical.path,
        backupPrefix,
        writes: [{ ref: "refs/heads/stuck", action: "agent", start: base, agent: tip, yours: base, checkedOutAt: `${other.path}/stuck` }],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* branchOf(`${other.path}/stuck`)).toBe("stuck")
      expect(yield* at("refs/heads/stuck")).toBe(later)
    }),
  )

  it.live("fast-forwards an existing branch to a winner that merged into it and switches the checkout", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const mainTip = (yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/feature.txt`, "feature\n", "utf8"))
      yield* Effect.promise(() => $`git add feature.txt && git commit -m feature`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      // The contestant checks out main and merges the chat branch into it.
      yield* Effect.promise(() => $`git switch arena-main`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git merge --no-ff --no-edit ${frozenHead}`.cwd(candidate.path).quiet())
      const mergeCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/base.txt`, "residual\n", "utf8"))
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/existing-ff/a",
      })
      expect(result.branch).toBe("arena-main")
      expect(result.rawHead).toBe(mergeCommit)
      expect(result.baseIsAncestor).toBe(true)
      // A production contestant lives in its own host, so its move of `arena-main` never
      // reaches the canonical repository. Put the canonical branch back where it was.
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main ${mainTip}`.cwd(canonical.path).quiet())

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: "arena-main",
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent", start: mainTip, agent: result.rawHead },
        safetyRef: "refs/battles/existing-ff/a-safety",
      })
      expect(promoted.conflicts).toEqual([])
      expect(promoted.resultingHead).toBe(mergeCommit)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "arena-main",
      )
      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()).toBe(
        mergeCommit,
      )
      expect((yield* Effect.promise(() => $`git rev-parse ${canonicalBranch}`.cwd(canonical.path).quiet().text())).trim()).toBe(
        frozenHead,
      )
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/base.txt`, "utf8"))).toBe("residual\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/feature.txt`, "utf8"))).toBe("feature\n")
      const safety = yield* Effect.promise(() =>
        $`git show-ref --verify --quiet refs/battles/existing-ff/a-safety-target-tip`.cwd(canonical.path).quiet().nothrow(),
      )
      expect(safety.exitCode).toBe(1)
    }),
  )

  it.live("takes a branch checked out in another worktree only when the developer agreed", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const mainTip = (yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()
      const frozenHead = mainTip
      const canonicalBranch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => $`git switch arena-main`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => $`git add winner.txt && git commit -m winner`.cwd(candidate.path).quiet())
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/existing-busy/a",
      })
      // The candidate stays on `arena-main`, which is exactly the situation to refuse.
      const beforeHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const promotion = yield* Effect.exit(
        promoteWinnerState({
          canonical: canonical.path,
          expectedBranch: canonicalBranch,
          targetBranch: "arena-main",
          frozenHead,
          baseWorkingTree: frozenHead,
          baseIndexTree: frozenHead,
          resultCommit: result.finalCommit,
          finalIndexTree: result.finalIndexTree,
          checkoutAction: { action: "agent", start: mainTip, agent: result.rawHead },
          safetyRef: "refs/battles/existing-busy/a-safety",
        }),
      )
      expect(Exit.isFailure(promotion)).toBe(true)
      if (Exit.isFailure(promotion)) {
        const failure = Cause.squash(promotion.cause)
        expect(failure).toBeInstanceOf(OperationError)
        expect((failure as OperationError).operation).toBe("target_branch_checked_out")
        expect((failure as OperationError).message).toContain(candidate.path)
      }
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(beforeHead)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(
        canonicalBranch,
      )
      const safety = yield* Effect.promise(() =>
        $`git show-ref --verify --quiet refs/battles/existing-busy/a-safety`.cwd(canonical.path).quiet().nothrow(),
      )
      expect(safety.exitCode).toBe(1)

      // Once the developer agrees to take the branch, that worktree is detached where it stood.
      const candidateHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      const taken = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: "arena-main",
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent", start: frozenHead, agent: result.rawHead },
        takeTargetFrom: [candidate.path],
        safetyRef: "refs/battles/existing-busy/a-safety",
      })
      expect(taken.resultingHead).toBe(result.rawHead)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(
        "arena-main",
      )
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(candidate.path).quiet().text())).trim()).toBe("")
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()).toBe(
        candidateHead,
      )
    }),
  )

  it.live("replays a winner's first-parent chain when the existing branch advanced during the battle", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const mainTip = (yield* Effect.promise(() =>
        $`git rev-parse arena-main`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/feature.txt`, "feature\n", "utf8"))
      yield* Effect.promise(() => $`git add feature.txt && git commit -m feature`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git switch arena-main`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git merge --no-ff --no-edit ${frozenHead}`.cwd(candidate.path).quiet())
      const mergeCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/existing-replay/a",
      })
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main ${mainTip}`.cwd(canonical.path).quiet())

      // `arena-main` advances in the canonical repository while the battle runs.
      yield* Effect.promise(() => $`git switch arena-main`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/other.txt`, "other\n", "utf8"))
      yield* Effect.promise(() => $`git add other.txt && git commit -m other`.cwd(canonical.path).quiet())
      const advancedTip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git switch ${canonicalBranch}`.cwd(canonical.path).quiet())

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: "arena-main",
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent_on_yours", start: mainTip, agent: result.rawHead },
        safetyRef: "refs/battles/existing-replay/a-safety",
      })
      expect(promoted.conflicts).toEqual([])
      expect(promoted.resultingHead).not.toBe(mergeCommit)
      expect(
        (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe("arena-main")
      expect((yield* Effect.promise(() => $`git rev-parse HEAD^`.cwd(canonical.path).quiet().text())).trim()).toBe(
        advancedTip,
      )
      expect(
        (yield* Effect.promise(() =>
          $`git rev-list --count ${advancedTip}..HEAD`.cwd(canonical.path).quiet().text(),
        )).trim(),
      ).toBe("1")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/feature.txt`, "utf8"))).toBe("feature\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/other.txt`, "utf8"))).toBe("other\n")
      expect((yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())).trim()).toBe("")
      // The three-way residual apply must not leave anything staged behind.
      expect(
        (yield* Effect.promise(() => $`git diff --cached --name-only`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe("")
    }),
  )

  it.live("leaves a conflicting existing-branch replay in git conflict state", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const mainTip = (yield* Effect.promise(() =>
        $`git rev-parse arena-main`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "feature\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am feature`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git switch arena-main`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git merge --no-ff --no-edit ${frozenHead}`.cwd(candidate.path).quiet())
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/existing-conflict/a",
      })
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main ${mainTip}`.cwd(canonical.path).quiet())

      yield* Effect.promise(() => $`git switch arena-main`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "main edit\n", "utf8"))
      yield* Effect.promise(() => $`git commit -am main-edit`.cwd(canonical.path).quiet())
      const advancedTip = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git switch ${canonicalBranch}`.cwd(canonical.path).quiet())

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: "arena-main",
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "combine", start: mainTip, agent: result.rawHead },
        safetyRef: "refs/battles/existing-conflict/a-safety",
        retainSafetyRef: true,
      })
      expect(promoted.conflicts).toEqual(["shared.txt"])
      expect(promoted.resultingHead).toBe(advancedTip)
      expect(
        (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim(),
      ).toBe("arena-main")
      const status = yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())
      expect(status).toContain(" M shared.txt")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))).toContain("<<<<<<<")
    }),
  )

  it.live("restores an existing target branch and the original checkout after an interrupted promotion", () =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/base.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add base.txt && git commit -m base`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(canonical.path).quiet())
      const mainTip = (yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/feature.txt`, "feature\n", "utf8"))
      yield* Effect.promise(() => $`git add feature.txt && git commit -m feature`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const canonicalBranch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => $`git switch arena-main`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git merge --no-ff --no-edit ${frozenHead}`.cwd(candidate.path).quiet())
      const mergeCommit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(candidate.path).quiet().text())).trim()
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/existing-recovery/a",
      })
      yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* Effect.promise(() => $`git branch --force arena-main ${mainTip}`.cwd(canonical.path).quiet())

      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public-staged.txt`, "staged\n", "utf8"))
      yield* Effect.promise(() => $`git add public-staged.txt`.cwd(canonical.path).quiet())
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public-untracked.txt`, "untracked\n", "utf8"))
      const safetyRef = "refs/battles/existing-recovery/public-safety"
      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        expectedBranch: canonicalBranch,
        targetBranch: "arena-main",
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        checkoutAction: { action: "agent", start: mainTip, agent: result.rawHead },
        safetyRef,
        retainSafetyRef: true,
      })
      expect(promoted.conflicts).toEqual([])
      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()).toBe(
        mergeCommit,
      )

      expect(
        yield* recoverFailedPromotion({
          canonical: canonical.path,
          safetyRef,
          expectedBranch: canonicalBranch,
          targetBranch: "arena-main",
        }),
      ).toBe(true)
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()).toBe(
        canonicalBranch,
      )
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(frozenHead)
      expect((yield* Effect.promise(() => $`git rev-parse arena-main`.cwd(canonical.path).quiet().text())).trim()).toBe(
        mainTip,
      )
      const status = yield* Effect.promise(() => $`git status --short`.cwd(canonical.path).quiet().text())
      expect(status).toContain("A  public-staged.txt\n")
      expect(status).toContain("?? public-untracked.txt\n")
      for (const suffix of ["", "-index", "-target-tip", "-target-existing"]) {
        const left = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet ${safetyRef}${suffix}`.cwd(canonical.path).quiet().nothrow(),
        )
        expect(left.exitCode).toBe(1)
      }
    }),
  )
})

/**
 * The developer keeps working in the public checkout while a battle runs. Whatever the vote does
 * to the winner's changes, the developer's own uncommitted work must come back, and a file both
 * sides touched must end as one ordinary conflicted file.
 */
describe("ArenaGit public edits around a vote", () => {
  const read = (path: string) => Effect.promise(() => fs.readFile(path, "utf8"))
  const write = (path: string, content: string) => Effect.promise(() => fs.writeFile(path, content, "utf8"))
  const status = (cwd: string) =>
    Effect.promise(() => $`git status --short`.cwd(cwd).quiet().text()).pipe(
      Effect.map((text) => text.split("\n").filter(Boolean).sort()),
    )
  const head = (cwd: string) => Effect.promise(() => $`git rev-parse HEAD`.cwd(cwd).quiet().text()).pipe(Effect.map((t) => t.trim()))
  const markers = (text: string) => text.split("<<<<<<<").length - 1

  /** Seed C1, run the winner in a detached worktree, run the developer in the public checkout, then vote. */
  type BattleInput = {
    readonly winner: (worktree: string) => Effect.Effect<void>
    readonly developer: (canonical: string) => Effect.Effect<void>
    readonly targetBranch?: string
    readonly rawHead?: boolean
  }
  // Seed the canonical repo, let the winner work in a detached worktree, finalize it, then let
  // the developer edit the canonical checkout. Returns everything a promotion call needs.
  const arrange = (input: BattleInput) =>
    Effect.gen(function* () {
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* write(`${canonical.path}/README.md`, "Title: original\n")
      yield* write(`${canonical.path}/notes.txt`, "notes\n")
      yield* write(`${canonical.path}/lib.js`, "export const x = 1;\n")
      yield* write(`${canonical.path}/shared.txt`, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n")
      yield* Effect.promise(() => fs.mkdir(`${canonical.path}/src`, { recursive: true }))
      yield* write(`${canonical.path}/src/deep.js`, "deep\n")
      yield* Effect.promise(() => $`git add -A && git commit -m c1`.cwd(canonical.path).quiet())
      const frozenHead = yield* head(canonical.path)
      const branch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )
      yield* input.winner(candidate.path)
      const result = yield* finalize({ worktree: candidate.path, baseSHA: frozenHead, permanentRef: "refs/battles/public-edits/a" })
      if (input.rawHead) yield* Effect.promise(() => $`git switch --detach`.cwd(candidate.path).quiet())
      yield* input.developer(canonical.path)
      const promotion = {
        canonical: canonical.path,
        expectedBranch: branch,
        ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
        frozenHead,
        baseWorkingTree: frozenHead,
        baseIndexTree: frozenHead,
        resultCommit: result.finalCommit,
        finalIndexTree: result.finalIndexTree,
        safetyRef: "refs/battles/public-edits/safety",
        retainSafetyRef: true,
      }
      // The review's proposal for the checkout branch: the agent's commits when the developer
      // left the branch alone, replayed onto the developer's when that is clean, and combined
      // with markers when it is not.
      if (result.rawHead === frozenHead) return { canonical: canonical.path, frozenHead, promotion }
      const branchTip = input.targetBranch
        ? (yield* Effect.promise(() => $`git rev-parse ${input.targetBranch}`.cwd(canonical.path).quiet().text())).trim()
        : yield* head(canonical.path)
      const checkoutAction = (action: BranchAction) => ({ action, start: frozenHead, agent: result.rawHead })
      if (branchTip === frozenHead) {
        return { canonical: canonical.path, frozenHead, promotion: { ...promotion, checkoutAction: checkoutAction("agent") } }
      }
      const replay = yield* promoteWinnerState({ ...promotion, checkoutAction: checkoutAction("agent_on_yours"), dryRun: true }).pipe(
        Effect.exit,
      )
      const action = Exit.isSuccess(replay) ? "agent_on_yours" : "combine"
      return { canonical: canonical.path, frozenHead, promotion: { ...promotion, checkoutAction: checkoutAction(action) } }
    })
  const battle = (input: BattleInput) =>
    Effect.gen(function* () {
      const { canonical, frozenHead, promotion } = yield* arrange(input)
      const promoted = yield* promoteWinnerState(promotion)
      const accepted =
        promoted.conflicts.length > 0
          ? yield* acceptWinnerConflicts({ canonical, reported: promoted.conflicts })
          : { conflicts: [] as readonly string[] }
      yield* finishWinnerPromotion({ canonical, safetyRef: "refs/battles/public-edits/safety" })
      expect(yield* hasCherryPickInProgress(canonical)).toBe(false)
      return { canonical, frozenHead, promoted, accepted }
    })

  const unrelatedWork = (canonical: string) =>
    Effect.gen(function* () {
      yield* write(`${canonical}/notes.txt`, "notes\nuncommitted edit\n")
      yield* write(`${canonical}/scratch.txt`, "scratch\n")
      yield* write(`${canonical}/staged.txt`, "staged\n")
      yield* Effect.promise(() => $`git add staged.txt`.cwd(canonical).quiet())
    })
  const expectUnrelatedWork = (canonical: string) =>
    Effect.gen(function* () {
      expect(yield* read(`${canonical}/notes.txt`)).toBe("notes\nuncommitted edit\n")
      expect(yield* read(`${canonical}/scratch.txt`)).toBe("scratch\n")
      expect(yield* read(`${canonical}/staged.txt`)).toBe("staged\n")
      const lines = yield* status(canonical)
      expect(lines).toContain(" M notes.txt")
      expect(lines).toContain("?? scratch.txt")
      expect(lines).toContain("A  staged.txt")
    })

  it.live("A: an uncommitted public edit that overlaps the winner's commit conflicts once, and other work survives", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("Title: developer")
      yield* expectUnrelatedWork(b.canonical)
      expect(yield* status(b.canonical)).toContain(" M README.md")
    }),
  )

  it.live("B: a staged public edit that overlaps the winner's commit conflicts once, and other work survives", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git add README.md`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("Title: developer")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("C: a zero-commit winner that conflicts with a public commit keeps the developer's other work", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) => write(`${w}/README.md`, "Title: agents\n"),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git commit -qam c2`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      expect(yield* head(b.canonical)).not.toBe(b.frozenHead)
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("Title: developer")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("D: public deletions, staged and unstaged, survive a conflicted replay", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git commit -qam c2`.cwd(c).quiet())
            yield* Effect.promise(() => $`git rm -q lib.js`.cwd(c).quiet())
            yield* Effect.promise(() => fs.rm(`${c}/notes.txt`))
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      expect(yield* status(b.canonical)).toEqual([" D notes.txt", " M README.md", "D  lib.js"])
    }),
  )

  it.live("E: an untracked public file the winner also committed becomes one conflicted file", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/new.txt`, "winner\n")
            yield* Effect.promise(() => $`git add new.txt && git commit -qm add`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/new.txt`, "public\n")
            yield* unrelatedWork(c)
          }),
      })
      const newFile = yield* read(`${b.canonical}/new.txt`)
      expect(newFile).toContain("public")
      expect(newFile).toContain("winner")
      expect(b.accepted.conflicts).toEqual(["new.txt"])
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("F: an uncommitted public edit to the file that already conflicts does not nest markers", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git commit -qam c2`.cwd(c).quiet())
            yield* write(`${c}/README.md`, "Title: developer\nuncommitted line\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("uncommitted line")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("G: a clean replay over a public commit keeps the developer's other work", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/lib.js`, "export const x = 2;\n")
            yield* Effect.promise(() => $`git commit -qam c2`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.promoted.conflicts).toEqual([])
      expect((yield* Effect.promise(() => $`git log --format=%s -3`.cwd(b.canonical).quiet().text())).trim()).toBe("retitle\nc2\nc1")
      expect(yield* read(`${b.canonical}/README.md`)).toBe("Title: agents\n")
      expect(yield* read(`${b.canonical}/lib.js`)).toBe("export const x = 2;\n")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("H: a public edit in another hunk of a file the winner committed merges without conflict", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/shared.txt`, "winner\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n")
            yield* Effect.promise(() => $`git commit -qam top`.cwd(w).quiet())
          }),
        developer: (c) => write(`${c}/shared.txt`, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\npublic\n"),
      })
      expect(b.promoted.conflicts).toEqual([])
      expect(yield* read(`${b.canonical}/shared.txt`)).toBe("winner\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\npublic\n")
      expect(yield* status(b.canonical)).toEqual([" M shared.txt"])
    }),
  )

  it.live("J: an uncommitted public edit to a file the winner deleted keeps the developer's copy", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) => Effect.promise(() => $`git rm -q lib.js && git commit -qm drop`.cwd(w).quiet()),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/lib.js`, "export const x = 1;\nexport const y = 2;\n")
            yield* unrelatedWork(c)
          }),
      })
      expect((yield* Effect.promise(() => $`git log --format=%s -1`.cwd(b.canonical).quiet().text())).trim()).toBe("drop")
      expect(yield* read(`${b.canonical}/lib.js`)).toBe("export const x = 1;\nexport const y = 2;\n")
      expect(b.accepted.conflicts).toEqual(["lib.js"])
      expect(yield* status(b.canonical)).toContain("?? lib.js")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("K: an uncommitted public edit to a file the winner renamed follows the rename", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) => Effect.promise(() => $`git mv lib.js util.js && git commit -qm rename`.cwd(w).quiet()),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/lib.js`, "export const x = 1;\nexport const y = 2;\n")
            yield* unrelatedWork(c)
          }),
      })
      expect((yield* Effect.promise(() => $`git log --format=%s -1`.cwd(b.canonical).quiet().text())).trim()).toBe("rename")
      // Rename detection carries the developer's edit into the renamed file.
      expect(yield* read(`${b.canonical}/util.js`)).toBe("export const x = 1;\nexport const y = 2;\n")
      expect(yield* Effect.promise(() => fs.access(`${b.canonical}/lib.js`).then(() => true, () => false))).toBe(false)
      expect(b.accepted.conflicts).toEqual([])
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("L: a zero-commit winner and an uncommitted public edit to the same file conflict once", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) => write(`${w}/README.md`, "Title: agents\n"),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("Title: developer")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("M: an uncommitted public edit to a file whose directory the winner removed comes back", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) => Effect.promise(() => $`git rm -q src/deep.js && git commit -qm drop-dir`.cwd(w).quiet()),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/src/deep.js`, "deep\nedited\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(yield* read(`${b.canonical}/src/deep.js`)).toBe("deep\nedited\n")
      expect(b.accepted.conflicts).toEqual(["src/deep.js"])
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("N: a public deletion of a file the winner committed to keeps the winner's copy and reports it", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/lib.js`, "export const x = 2;\n")
            yield* Effect.promise(() => $`git commit -qam bump`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.rm(`${c}/lib.js`))
            yield* unrelatedWork(c)
          }),
      })
      expect((yield* Effect.promise(() => $`git log --format=%s -1`.cwd(b.canonical).quiet().text())).trim()).toBe("bump")
      expect(b.accepted.conflicts).toEqual(["lib.js"])
      expect(yield* read(`${b.canonical}/lib.js`)).toBe("export const x = 2;\n")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("O: a public rename of a file the winner committed to carries the edit into the new name", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/lib.js`, "export const x = 2;\n")
            yield* Effect.promise(() => $`git commit -qam bump`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => $`git mv lib.js util.js`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual([])
      // Rename detection carries the winner's edit into the renamed file.
      expect(yield* read(`${b.canonical}/util.js`)).toBe("export const x = 2;\n")
      expect(yield* Effect.promise(() => fs.access(`${b.canonical}/lib.js`).then(() => true, () => false))).toBe(false)
      expect(yield* status(b.canonical)).toContain("R  lib.js -> util.js")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("P: a public commit that deleted a file the winner committed to ends as one reported conflict", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/lib.js`, "export const x = 2;\n")
            yield* Effect.promise(() => $`git commit -qam bump`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => $`git rm -q lib.js && git commit -qm drop`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["lib.js"])
      expect(yield* read(`${b.canonical}/lib.js`)).toBe("export const x = 2;\n")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("Q: a staged copy that differs from the working copy keeps both copies, each with markers", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: staged\n")
            yield* Effect.promise(() => $`git add README.md`.cwd(c).quiet())
            yield* write(`${c}/README.md`, "Title: worktree\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      expect(readme).toContain("Title: agents")
      expect(readme).toContain("Title: worktree")
      const staged = yield* Effect.promise(() => $`git show :README.md`.cwd(b.canonical).quiet().text())
      expect(markers(staged)).toBe(1)
      expect(staged).toContain("Title: agents")
      expect(staged).toContain("Title: staged")
      expect(yield* status(b.canonical)).toContain("MM README.md")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("the safety net reports a staged copy that neither the index nor the working tree would keep", () =>
    Effect.gen(function* () {
      // Trees as the old index reset produced them for case Q: the working tree carries markers
      // with the developer's working copy, but the index went back to HEAD, so the staged copy
      // "Title: staged" is nowhere in the state about to be written.
      const repo = yield* scopedTmpdir({ git: true })
      yield* write(`${repo.path}/README.md`, "Title: original\n")
      yield* write(`${repo.path}/notes.txt`, "notes\n")
      yield* Effect.promise(() => $`git add -A && git commit -qm c1`.cwd(repo.path).quiet())
      const treeWith = (files: Record<string, string>) =>
        Effect.gen(function* () {
          const index = `${repo.path}/.git/scratch-index`
          const env = { ...process.env, GIT_INDEX_FILE: index }
          yield* Effect.promise(() => $`git read-tree HEAD`.cwd(repo.path).env(env).quiet())
          for (const [path, content] of Object.entries(files)) {
            const blob = (yield* Effect.promise(() => $`git hash-object -w --stdin < ${new Response(content)}`.cwd(repo.path).quiet().text())).trim()
            yield* Effect.promise(() => $`git update-index --add --cacheinfo 100644,${blob},${path}`.cwd(repo.path).env(env).quiet())
          }
          return (yield* Effect.promise(() => $`git write-tree`.cwd(repo.path).env(env).quiet().text())).trim()
        })
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD^{tree}`.cwd(repo.path).quiet().text())).trim()
      const staged = yield* treeWith({ "README.md": "Title: staged\n" })
      const working = yield* treeWith({ "README.md": "Title: worktree\n", "notes.txt": "notes\nedit\n" })
      const winner = yield* treeWith({ "README.md": "Title: agents\n" })
      const merged = yield* treeWith({
        "README.md": "<<<<<<< ours\nTitle: worktree\n=======\nTitle: agents\n>>>>>>> theirs\n",
        "notes.txt": "notes\nedit\n",
      })
      const check = (input: { readonly indexTree: string; readonly stagedCopiesKept: ReadonlySet<string> }) =>
        Effect.gen(function* () {
          const git = yield* Git.Service
          return yield* unrecoverablePublicEdits(git, repo.path, {
            publicBase: head,
            publicWorkingTree: working,
            publicIndexBase: head,
            publicIndexTree: staged,
            winnerWorktree: winner,
            winnerIndex: winner,
            worktreeTree: merged,
            conflicts: ["README.md"],
            ...input,
          })
        })
      // Index reset to HEAD: the staged copy is lost, and the message names it.
      const lost = yield* check({ indexTree: head, stagedCopiesKept: new Set() })
      expect(lost).toEqual([{ path: "README.md", layers: ["staged"] }])
      expect(publicEditsAtRiskMessage(lost)).toContain("README.md (staged copy)")
      // The same trees with the index entry rebuilt around the staged copy: nothing is at risk.
      const stagedMarkers = yield* treeWith({
        "README.md": "<<<<<<< ours\nTitle: staged\n=======\nTitle: agents\n>>>>>>> theirs\n",
      })
      expect(yield* check({ indexTree: stagedMarkers, stagedCopiesKept: new Set(["README.md"]) })).toEqual([])
      // A working copy that the written tree drops in favour of the winner's side is reported too.
      const dropped = yield* Effect.gen(function* () {
        const git = yield* Git.Service
        return yield* unrecoverablePublicEdits(git, repo.path, {
          publicBase: head,
          publicWorkingTree: working,
          publicIndexBase: head,
          publicIndexTree: head,
          winnerWorktree: winner,
          winnerIndex: winner,
          worktreeTree: winner,
          indexTree: winner,
          conflicts: [],
          stagedCopiesKept: new Set(),
        })
      })
      expect(dropped.map((item) => item.path)).toEqual(["README.md", "notes.txt"])
    }),
  )

  it.live("R: the winner's own uncommitted edits survive a conflicted replay", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
            yield* write(`${w}/lib.js`, "export const x = 1;\n// winner note\n")
            yield* write(`${w}/winner-new.txt`, "winner new\n")
            yield* Effect.promise(() => $`git add winner-new.txt`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git commit -qam c2`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      expect(yield* read(`${b.canonical}/lib.js`)).toBe("export const x = 1;\n// winner note\n")
      expect(yield* read(`${b.canonical}/winner-new.txt`)).toBe("winner new\n")
      expect(yield* status(b.canonical)).toContain("A  winner-new.txt")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("S: an untracked public file identical to one the winner added is not a conflict", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        winner: (w) =>
          Effect.gen(function* () {
            yield* write(`${w}/new.txt`, "same\n")
            yield* Effect.promise(() => $`git add new.txt && git commit -qm add`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            yield* write(`${c}/new.txt`, "same\n")
            yield* unrelatedWork(c)
          }),
      })
      expect(b.promoted.conflicts).toEqual([])
      expect(yield* read(`${b.canonical}/new.txt`)).toBe("same\n")
      yield* expectUnrelatedWork(b.canonical)
    }),
  )

  it.live("I: a conflicted existing-branch replay still restores the developer's other work", () =>
    Effect.gen(function* () {
      const b = yield* battle({
        targetBranch: "arena-main",
        rawHead: true,
        winner: (w) =>
          Effect.gen(function* () {
            // arena-main exists at C1 in the host; the winner switches to it and commits there.
            yield* Effect.promise(() => $`git branch arena-main HEAD`.cwd(w).quiet())
            yield* Effect.promise(() => $`git switch arena-main`.cwd(w).quiet())
            yield* write(`${w}/README.md`, "Title: agents\n")
            yield* Effect.promise(() => $`git commit -qam retitle`.cwd(w).quiet())
          }),
        developer: (c) =>
          Effect.gen(function* () {
            // The canonical arena-main moves to a conflicting commit while the developer keeps
            // editing on the chat branch.
            // Worktrees share refs, so the winner's branch already exists here; put it back at C1.
            yield* Effect.promise(() => $`git branch -f arena-main HEAD`.cwd(c).quiet())
            const chatBranch = (yield* Effect.promise(() => $`git branch --show-current`.cwd(c).quiet().text())).trim()
            yield* Effect.promise(() => $`git switch -q arena-main`.cwd(c).quiet())
            yield* write(`${c}/README.md`, "Title: developer\n")
            yield* Effect.promise(() => $`git commit -qam main-retitle`.cwd(c).quiet())
            yield* Effect.promise(() => $`git switch -q ${chatBranch}`.cwd(c).quiet())
            yield* unrelatedWork(c)
          }),
      })
      expect(b.accepted.conflicts).toEqual(["README.md"])
      expect((yield* Effect.promise(() => $`git branch --show-current`.cwd(b.canonical).quiet().text())).trim()).toBe("arena-main")
      const readme = yield* read(`${b.canonical}/README.md`)
      expect(markers(readme)).toBe(1)
      yield* expectUnrelatedWork(b.canonical)
    }),
  )
})

/**
 * A contestant worktree is kept between turns and synced back to the frozen base. Each case leaves
 * the worktree the way a contestant could, checks that verification notices, then syncs and expects
 * the worktree to match the canonical checkout the base was frozen from, as a new one would.
 */
describe("ArenaGit contestant worktree sync", () => {
  type Target = "branch" | "detached"
  type Arrange = {
    readonly dirty?: boolean
    readonly target?: Target
    readonly gitlink?: boolean
    /** Canonical edits after the base commit and before the freeze. */
    readonly developer?: (canonical: string) => Effect.Effect<void>
    /** Where the worktree and its host go; a fresh temporary directory by default. */
    readonly parent?: (canonical: string) => Effect.Effect<string>
  }
  type Fixture = {
    readonly canonical: string
    readonly host: string
    readonly slot: string
    readonly branch?: string
    readonly state: VerifyContestantStateInput
    /** `git status` of the canonical checkout at the freeze. */
    readonly expected: string
  }

  const git = (cwd: string, ...args: string[]) =>
    Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((text) => text.trim()))
  const write = (file: string, content: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content)
    })
  const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
  const exists = (file: string) => Effect.promise(async () => Boolean(await fs.lstat(file).catch(() => undefined)))
  const names = (directory: string) => Effect.promise(() => fs.readdir(directory))
  const status = (cwd: string) => git(cwd, "status", "--porcelain=v1", "--untracked-files=all")
  // One name, composed as git writes it on macOS and decomposed as another tool may.
  const composed = `caf${String.fromCodePoint(0xe9)}`
  const decomposed = `cafe${String.fromCodePoint(0x301)}`
  const failure = <A>(effect: Effect.Effect<A, OperationError, Git.Service>) =>
    Effect.flip(effect).pipe(
      Effect.map((error) => {
        expect(error).toBeInstanceOf(OperationError)
        return error.operation
      }),
    )

  const arrange = (options: Arrange = {}) =>
    Effect.gen(function* () {
      const canonical = (yield* scopedTmpdir({ git: true })).path
      yield* write(`${canonical}/README.md`, "readme\n")
      yield* write(`${canonical}/.gitignore`, "*.log\n")
      yield* write(`${canonical}/src/a.txt`, "a\n")
      yield* write(`${canonical}/src/b.txt`, "b\n")
      yield* write(`${canonical}/src/lib/c.txt`, "c\n")
      yield* write(`${canonical}/docs/guide.md`, "guide\n")
      if (options.gitlink) {
        const root = yield* git(canonical, "rev-parse", "HEAD")
        yield* git(canonical, "update-index", "--add", "--cacheinfo", `160000,${root},vendor/lib`)
        yield* Effect.promise(() => fs.mkdir(`${canonical}/vendor/lib`, { recursive: true }))
      }
      yield* git(canonical, "add", "-A")
      yield* git(canonical, "commit", "-qm", "base")
      if (options.dirty) {
        yield* write(`${canonical}/src/a.txt`, "a staged\n")
        yield* git(canonical, "add", "src/a.txt")
        yield* write(`${canonical}/src/a.txt`, "a staged and unstaged\n")
        yield* write(`${canonical}/src/b.txt`, "b unstaged\n")
        yield* write(`${canonical}/staged.txt`, "staged\n")
        yield* git(canonical, "add", "staged.txt")
        yield* write(`${canonical}/src/new/untracked.txt`, "untracked\n")
        yield* Effect.promise(() => fs.rm(`${canonical}/docs/guide.md`))
      }
      if (options.developer) yield* options.developer(canonical)
      const base = yield* snapshotBase({ canonical })
      const parent = options.parent ? yield* options.parent(canonical) : (yield* scopedTmpdir()).path
      const slot = `${parent}/slot`
      const host = `${slot}.git`
      // What the worktree module builds: a copy of the canonical git directory, bare, without the
      // canonical index, with a worktree added for the frozen HEAD.
      yield* Effect.promise(() => $`cp -R ${canonical}/.git ${host}`.quiet())
      yield* git(host, "config", "--file", `${host}/config`, "core.bare", "true")
      yield* Effect.promise(() => fs.rm(`${host}/index`, { force: true }))
      yield* write(`${host}/info/exclude`, "/.agent-duel/\n")
      const branch = options.target === "detached" ? undefined : base.branch
      yield* git(
        parent,
        "--git-dir",
        host,
        "worktree",
        "add",
        "-q",
        ...(branch ? ["-B", branch] : ["--detach"]),
        slot,
        base.frozenHead,
      )
      const state = {
        worktree: slot,
        frozenHead: base.frozenHead,
        indexTree: base.indexTree,
        workingTree: base.baseTree,
        ...(branch ? { branch } : {}),
      } satisfies VerifyContestantStateInput
      // A new worktree goes through the same sync as a kept one.
      yield* syncContestantState(state)
      yield* verifyContestantState(state)
      const expected = yield* status(canonical)
      expect(yield* status(slot)).toBe(expected)
      return { canonical, host, slot, ...(branch ? { branch } : {}), state, expected } satisfies Fixture
    })

  const leftovers = (fixture: Fixture) =>
    Effect.gen(function* () {
      const slot = fixture.slot
      yield* write(`${slot}/src/a.txt`, "agent staged\n")
      yield* write(`${slot}/agent-untracked.txt`, "agent\n")
      yield* git(slot, "add", "-A")
      yield* write(`${slot}/debug.log`, "staged although ignored\n")
      yield* git(slot, "add", "-f", "debug.log")
      yield* write(`${slot}/src/b.txt`, "agent unstaged\n")
      yield* write(`${slot}/src/lib/scratch.txt`, "agent untracked\n")
      yield* Effect.promise(() => fs.rm(`${slot}/src/lib/c.txt`))
      yield* write(`${slot}/empty-parent/deep/file.txt`, "agent\n")
    })

  type Scenario = {
    readonly name: string
    readonly arrange?: Arrange
    /** Skip unless the worktree's filesystem folds case, as APFS does by default. */
    readonly foldsCase?: boolean
    /** The operation verification fails with before the sync. */
    readonly caught: string
    readonly leave: (fixture: Fixture) => Effect.Effect<void>
    readonly check?: (fixture: Fixture, synced: SyncedContestantState) => Effect.Effect<void>
  }

  const scenarios: Scenario[] = [
    ...(
      [
        { dirty: false, target: "branch" },
        { dirty: true, target: "branch" },
        { dirty: false, target: "detached" },
        { dirty: true, target: "detached" },
      ] satisfies { dirty: boolean; target: Target }[]
    ).map(
      (base): Scenario => ({
        name: `staged, unstaged and untracked leftovers on a ${base.dirty ? "dirty" : "clean"} base, ${base.target} HEAD`,
        arrange: base,
        caught: "verify_contestant_index",
        leave: leftovers,
        check: (fixture) =>
          Effect.gen(function* () {
            expect(yield* exists(`${fixture.slot}/debug.log`)).toBe(false)
            expect(yield* exists(`${fixture.slot}/empty-parent`)).toBe(false)
            expect(yield* read(`${fixture.slot}/src/lib/c.txt`)).toBe("c\n")
          }),
      }),
    ),
    {
      name: "commits on the branch",
      caught: "verify_contestant_head",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* write(`${slot}/src/a.txt`, "agent\n")
          yield* git(slot, "commit", "-qam", "agent one")
          yield* write(`${slot}/agent.txt`, "agent\n")
          yield* git(slot, "add", "agent.txt")
          yield* git(slot, "commit", "-qm", "agent two")
        }),
      check: ({ slot, branch, state }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`)
          expect(yield* git(slot, "rev-parse", `refs/heads/${branch}`)).toBe(state.frozenHead)
        }),
    },
    {
      name: "a switch to a new branch",
      caught: "verify_contestant_branch",
      leave: ({ slot }) => git(slot, "switch", "-q", "-c", "feature").pipe(Effect.asVoid),
      check: ({ slot, branch }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`)
        }),
    },
    {
      name: "a detached HEAD",
      caught: "verify_contestant_branch",
      leave: ({ slot }) => git(slot, "switch", "-q", "--detach").pipe(Effect.asVoid),
      check: ({ slot, branch }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`)
        }),
    },
    {
      name: "a branch checked out where the base was detached",
      arrange: { target: "detached", dirty: true },
      caught: "verify_contestant_head",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* git(slot, "switch", "-q", "-c", "scratch")
          yield* git(slot, "commit", "-qam", "scratch")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "rev-parse", "--symbolic-full-name", "HEAD")).toBe("HEAD")
        }),
    },
    {
      name: "a deleted branch ref",
      caught: "verify_contestant_head",
      leave: ({ slot, branch }) => git(slot, "update-ref", "-d", `refs/heads/${branch}`).pipe(Effect.asVoid),
      check: ({ slot, branch, state }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "rev-parse", `refs/heads/${branch}`)).toBe(state.frozenHead)
        }),
    },
    {
      name: "a branch turned into a symbolic ref",
      caught: "verify_contestant_branch",
      leave: ({ slot, branch }) =>
        Effect.gen(function* () {
          yield* git(slot, "branch", "other")
          yield* git(slot, "symbolic-ref", `refs/heads/${branch}`, "refs/heads/other")
        }),
      check: ({ slot, branch }) =>
        Effect.gen(function* () {
          const symbolic = yield* Effect.promise(() =>
            $`git symbolic-ref -q ${`refs/heads/${branch}`}`.cwd(slot).quiet().nothrow(),
          )
          expect(symbolic.exitCode).toBe(1)
        }),
    },
    {
      name: "HEAD attached through a symbolic ref to the branch",
      caught: "verify_contestant_branch",
      leave: ({ slot, branch }) =>
        Effect.gen(function* () {
          yield* git(slot, "symbolic-ref", "refs/heads/alias", `refs/heads/${branch}`)
          yield* git(slot, "symbolic-ref", "HEAD", "refs/heads/alias")
        }),
      check: ({ slot, branch }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "symbolic-ref", "--no-recurse", "HEAD")).toBe(`refs/heads/${branch}`)
        }),
    },
    {
      name: "an intent-to-add entry for a file the base has untracked",
      arrange: { dirty: true },
      caught: "verify_contestant_index",
      leave: ({ slot }) => git(slot, "add", "-N", "src/new/untracked.txt").pipe(Effect.asVoid),
    },
    {
      name: "an untracked nested repository",
      caught: "verify_contestant_nested_repos",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* write(`${slot}/nested/n.txt`, "nested\n")
          yield* git(`${slot}/nested`, "init", "-q")
          yield* git(`${slot}/nested`, "add", "-A")
          yield* git(`${slot}/nested`, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "nested")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* exists(`${slot}/nested`)).toBe(false)
        }),
    },
    {
      name: "a .git inside tracked directories",
      caught: "verify_contestant_nested_git",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* git(`${slot}/src`, "init", "-q")
          yield* write(`${slot}/src/lib/.git`, "gitdir: /nowhere\n")
        }),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.nestedGitRemoved).toBe(2)
          expect(yield* exists(`${slot}/src/.git`)).toBe(false)
          expect(yield* exists(`${slot}/src/lib/.git`)).toBe(false)
          expect(yield* git(`${slot}/src`, "rev-parse", "--show-toplevel")).toBe(slot)
        }),
    },
    {
      name: "skip-worktree and assume-unchanged flags",
      caught: "verify_contestant_index_flags",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* git(slot, "update-index", "--skip-worktree", "src/b.txt")
          yield* Effect.promise(() => fs.rm(`${slot}/src/b.txt`))
          yield* git(slot, "update-index", "--assume-unchanged", "src/a.txt")
          yield* write(`${slot}/src/a.txt`, "hidden edit\n")
        }),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.indexRebuilt).toBe(true)
          expect(yield* read(`${slot}/src/a.txt`)).toBe("a\n")
          expect(yield* read(`${slot}/src/b.txt`)).toBe("b\n")
          const tags = (yield* git(slot, "ls-files", "-v")).split("\n").map((line) => line.slice(0, 2))
          expect(new Set(tags)).toEqual(new Set(["H "]))
        }),
    },
    {
      name: "case-only renames of directories and a file",
      foldsCase: true,
      caught: "verify_contestant_name_case",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.rename(`${slot}/src`, `${slot}/Src`))
          yield* Effect.promise(() => fs.rename(`${slot}/Src/lib`, `${slot}/Src/LIB`))
          yield* Effect.promise(() => fs.rename(`${slot}/Src/a.txt`, `${slot}/Src/A.txt`))
        }),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          // Git compares no stat data for a directory, so only the walk renames one back. The file
          // is rewritten under its exact name by the reset when the rename moved its ctime into a
          // later second than the index recorded, and renamed back by the walk otherwise.
          expect(synced.caseFixes).toBeGreaterThanOrEqual(2)
          expect(yield* names(slot)).toContain("src")
          expect(yield* names(slot)).not.toContain("Src")
          expect((yield* names(`${slot}/src`)).sort()).toEqual(["a.txt", "b.txt", "lib"])
        }),
    },
    {
      name: "a Unicode normalization-only rename",
      foldsCase: true,
      arrange: {
        developer: (canonical) =>
          Effect.gen(function* () {
            yield* write(`${canonical}/${composed}/menu.txt`, "coffee\n")
            yield* git(canonical, "add", "-A")
            yield* git(canonical, "commit", "-qm", "coffee")
          }),
      },
      caught: "verify_contestant_name_case",
      // APFS stores the decomposed name it is given and matches it to the composed one git wrote.
      leave: ({ slot }) => Effect.promise(() => fs.rename(`${slot}/${composed}`, `${slot}/${decomposed}`)),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.caseFixes).toBe(1)
          expect(yield* names(slot)).toContain(composed)
          expect(yield* names(slot)).not.toContain(decomposed)
        }),
    },
    {
      name: "a stale untracked .gitignore hiding a file",
      caught: "verify_contestant_worktree",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* write(`${slot}/src/.gitignore`, "gen.txt\n")
          yield* write(`${slot}/src/gen.txt`, "generated\n")
        }),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.cleanPasses).toBe(2)
          expect(yield* exists(`${slot}/src/gen.txt`)).toBe(false)
        }),
    },
    {
      name: "a leftover the frozen .gitignore no longer ignores",
      arrange: { developer: (canonical) => write(`${canonical}/.gitignore`, "") },
      caught: "verify_contestant_worktree",
      leave: ({ slot }) => write(`${slot}/debug.log`, "leftover\n"),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          // One pass: the clean already reads the frozen .gitignore.
          expect(synced.cleanPasses).toBe(1)
          expect(yield* exists(`${slot}/debug.log`)).toBe(false)
        }),
    },
    {
      name: "a populated gitlink directory",
      arrange: { gitlink: true },
      caught: "verify_contestant_gitlinks",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* write(`${slot}/vendor/lib/file.txt`, "checked out\n")
          yield* write(`${slot}/vendor/lib/deeper/file.txt`, "checked out\n")
        }),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.gitlinksEmptied).toBe(1)
          expect(yield* names(`${slot}/vendor/lib`)).toEqual([])
        }),
    },
    {
      name: "a FIFO in a tracked directory",
      caught: "verify_contestant_special_files",
      leave: ({ slot }) => Effect.promise(() => $`mkfifo ${`${slot}/src/pipe`}`.quiet()).pipe(Effect.asVoid),
      check: ({ slot }, synced) =>
        Effect.gen(function* () {
          expect(synced.specialFilesRemoved).toBe(1)
          expect(yield* exists(`${slot}/src/pipe`)).toBe(false)
        }),
    },
    {
      name: "a symlink in place of a tracked directory",
      caught: "verify_contestant_worktree",
      leave: ({ slot }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.rename(`${slot}/src`, `${slot}-outside`))
          yield* Effect.promise(() => fs.symlink(`${slot}-outside`, `${slot}/src`))
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect((yield* Effect.promise(() => fs.lstat(`${slot}/src`))).isDirectory()).toBe(true)
          expect(yield* read(`${slot}/src/b.txt`)).toBe("b\n")
          expect((yield* names(`${slot}-outside`)).sort()).toEqual(["a.txt", "b.txt", "lib"])
        }),
    },
  ]

  for (const scenario of scenarios) {
    it.live(`syncs a kept worktree after ${scenario.name}`, () =>
      Effect.gen(function* () {
        const fixture = yield* arrange(scenario.arrange)
        if (scenario.foldsCase) {
          const folds = yield* Effect.promise(() =>
            $`git config --bool core.ignoreCase`.cwd(fixture.slot).quiet().nothrow().text(),
          )
          if (folds.trim() !== "true") return
        }
        yield* scenario.leave(fixture)
        expect(yield* failure(verifyContestantState(fixture.state))).toBe(scenario.caught)
        const synced = yield* syncContestantState(fixture.state)
        yield* verifyContestantState(fixture.state)
        expect(yield* status(fixture.slot)).toBe(fixture.expected)
        expect(synced.head).toBe(fixture.state.frozenHead)
        if (scenario.check) yield* scenario.check(fixture, synced)
      }),
    )
  }

  it.live("a second sync of a synced worktree changes nothing", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange({ dirty: true })
      const before = yield* Effect.promise(() => fs.lstat(`${fixture.slot}/README.md`))
      const synced = yield* syncContestantState(fixture.state)
      expect(synced).toEqual({
        worktree: fixture.slot,
        branch: fixture.branch,
        head: fixture.state.frozenHead,
        indexRebuilt: false,
        cleanPasses: 1,
        caseFixes: 0,
        nestedGitRemoved: 0,
        gitlinksEmptied: 0,
        specialFilesRemoved: 0,
      })
      expect((yield* Effect.promise(() => fs.lstat(`${fixture.slot}/README.md`))).ino).toBe(before.ino)
      yield* verifyContestantState(fixture.state)
    }),
  )

  it.live("forceCheckout rewrites every tracked file", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange()
      const before = yield* Effect.promise(() => fs.lstat(`${fixture.slot}/README.md`))
      const synced = yield* syncContestantState({ ...fixture.state, forceCheckout: true })
      expect(synced.indexRebuilt).toBe(true)
      expect((yield* Effect.promise(() => fs.lstat(`${fixture.slot}/README.md`))).ino).not.toBe(before.ino)
      yield* verifyContestantState(fixture.state)
      expect(yield* status(fixture.slot)).toBe(fixture.expected)
    }),
  )

  it.live("syncs a worktree whose repository sets core.ignoreStat", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange()
      // Under it git flags every entry it writes assume-unchanged, and the host carries the checkout's config.
      yield* Effect.promise(() => $`git config core.ignoreStat true`.cwd(fixture.slot).quiet())
      yield* write(`${fixture.slot}/README.md`, "edited\n")
      yield* syncContestantState(fixture.state)
      yield* verifyContestantState(fixture.state)
      expect(yield* status(fixture.slot)).toBe(fixture.expected)
      const flags = yield* Effect.promise(() => $`git ls-files -v`.cwd(fixture.slot).quiet().text())
      expect(flags.split("\n").filter((line) => line && !line.startsWith("H "))).toEqual([])
    }),
  )

  it.live("verification names a skip-worktree flag even when the file is intact", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange()
      yield* git(fixture.slot, "update-index", "--skip-worktree", "src/b.txt")
      const error = yield* Effect.flip(verifyContestantState(fixture.state))
      expect(error.operation).toBe("verify_contestant_index_flags")
      expect(error.paths).toEqual(["src/b.txt"])
    }),
  )

  it.live("verification checks the host and the Arena directory, which sync leaves to other layers", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange()
      yield* write(`${fixture.slot}/.agent-duel/notes.md`, "left by a contestant\n")
      yield* syncContestantState(fixture.state)
      expect(yield* failure(verifyContestantState(fixture.state))).toBe("verify_contestant_private_dir")
      yield* Effect.promise(() => fs.rm(`${fixture.slot}/.agent-duel`, { recursive: true }))

      yield* git(fixture.slot, "worktree", "add", "-q", "--detach", `${fixture.slot}-extra`)
      expect(yield* failure(verifyContestantState(fixture.state))).toBe("verify_contestant_host_worktrees")
      yield* git(fixture.slot, "worktree", "remove", "--force", `${fixture.slot}-extra`)

      yield* git(fixture.slot, "update-ref", "refs/battles/chat/turn-1/base", fixture.state.frozenHead)
      expect(yield* failure(verifyContestantState(fixture.state))).toBe("verify_contestant_host_refs")
      yield* git(fixture.slot, "update-ref", "-d", "refs/battles/chat/turn-1/base")

      yield* verifyContestantState(fixture.state)
    }),
  )

  it.live("refuses a worktree whose git directory is not its own and leaves the canonical checkout alone", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange({
        dirty: true,
        // Arena keeps worktrees under the canonical checkout, so a worktree without its own `.git`
        // resolves to the developer's repository.
        parent: (canonical) =>
          Effect.gen(function* () {
            yield* write(`${canonical}/.git/info/exclude`, "/.agent-duel/\n")
            const parent = `${canonical}/.agent-duel/worktrees/chat`
            yield* Effect.promise(() => fs.mkdir(parent, { recursive: true }))
            return parent
          }),
      })
      const head = yield* git(fixture.canonical, "rev-parse", "HEAD")
      const canonicalIndex = yield* git(fixture.canonical, "write-tree")
      const link = `${fixture.slot}/.git`
      const original = yield* read(link)
      yield* write(`${fixture.slot}/src/a.txt`, "agent\n")
      const expectRefused = Effect.gen(function* () {
        expect(yield* failure(syncContestantState(fixture.state))).toBe("verify_contestant_location")
        expect(yield* failure(verifyContestantState(fixture.state))).toBe("verify_contestant_location")
        expect(yield* git(fixture.canonical, "rev-parse", "HEAD")).toBe(head)
        expect(yield* git(fixture.canonical, "write-tree")).toBe(canonicalIndex)
        expect(yield* status(fixture.canonical)).toBe(fixture.expected)
        expect(yield* read(`${fixture.slot}/src/a.txt`)).toBe("agent\n")
      })

      yield* Effect.promise(() => fs.rm(link))
      yield* expectRefused
      yield* write(link, `gitdir: ${fixture.canonical}/.git\n`)
      yield* expectRefused
      const other = `${fixture.canonical}/.agent-duel/worktrees/other`
      yield* git(fixture.canonical, "worktree", "add", "-q", "--detach", other)
      const otherGitDir = yield* git(other, "rev-parse", "--absolute-git-dir")
      yield* write(link, `gitdir: ${otherGitDir}\n`)
      yield* expectRefused
      yield* git(fixture.canonical, "worktree", "remove", "--force", other)

      yield* write(link, original)
      yield* syncContestantState(fixture.state)
      yield* verifyContestantState(fixture.state)
      expect(yield* status(fixture.slot)).toBe(fixture.expected)
    }),
  )

  it.live("fails before writing anything when a frozen object is missing", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange()
      yield* write(`${fixture.slot}/src/a.txt`, "agent\n")
      const missing = { ...fixture.state, workingTree: "0123456789abcdef0123456789abcdef01234567" }
      expect(yield* failure(syncContestantState(missing))).toBe("verify_contestant_objects")
      expect(yield* read(`${fixture.slot}/src/a.txt`)).toBe("agent\n")
    }),
  )

  /**
   * A kept worktree is synced from the base its last turn froze to the next turn's, after the
   * contestant left it dirty and the canonical checkout moved on. Each case syncs twice: a worktree
   * that already holds the new base must sync to it again.
   */
  type Transition = {
    readonly name: string
    readonly arrange?: Arrange
    /** What the contestant leaves besides the common leftovers. */
    readonly leave?: (fixture: Fixture) => Effect.Effect<void>
    /** The canonical checkout's move to the next turn's base. */
    readonly next: (canonical: string) => Effect.Effect<void>
    readonly check?: (fixture: Fixture) => Effect.Effect<void>
  }

  const commitAll = (canonical: string, message: string) =>
    Effect.gen(function* () {
      yield* git(canonical, "add", "-A")
      yield* git(canonical, "commit", "-qm", message)
    })

  const transitions: Transition[] = [
    {
      name: "a winner's commit",
      next: (canonical) =>
        Effect.gen(function* () {
          yield* write(`${canonical}/src/a.txt`, "winner\n")
          yield* write(`${canonical}/src/winner.txt`, "winner\n")
          yield* Effect.promise(() => fs.rm(`${canonical}/docs/guide.md`))
          yield* commitAll(canonical, "winner")
        }),
    },
    {
      name: "one dirty base to another",
      arrange: { dirty: true },
      next: (canonical) =>
        Effect.gen(function* () {
          yield* git(canonical, "checkout", "--", "docs/guide.md")
          yield* Effect.promise(() => fs.rm(`${canonical}/src/new`, { recursive: true }))
          yield* write(`${canonical}/src/b.txt`, "b staged\n")
          yield* git(canonical, "add", "src/b.txt")
          yield* write(`${canonical}/src/lib/c.txt`, "c unstaged\n")
          yield* write(`${canonical}/other/untracked.txt`, "other\n")
        }),
    },
    {
      name: "a switch to another branch",
      next: (canonical) =>
        Effect.gen(function* () {
          yield* git(canonical, "switch", "-q", "-c", "feature")
          yield* write(`${canonical}/src/a.txt`, "feature\n")
          yield* commitAll(canonical, "feature")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "symbolic-ref", "HEAD")).toBe("refs/heads/feature")
        }),
    },
    {
      name: "a detached HEAD",
      next: (canonical) =>
        Effect.gen(function* () {
          yield* git(canonical, "switch", "-q", "--detach")
          yield* write(`${canonical}/src/a.txt`, "detached\n")
          yield* commitAll(canonical, "detached")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* git(slot, "rev-parse", "--symbolic-full-name", "HEAD")).toBe("HEAD")
        }),
    },
    {
      name: "a tracked file becoming ignored",
      next: (canonical) =>
        Effect.gen(function* () {
          yield* git(canonical, "rm", "-q", "--cached", "src/b.txt")
          yield* write(`${canonical}/.gitignore`, "*.log\nsrc/b.txt\n")
          yield* commitAll(canonical, "ignore b")
        }),
    },
    {
      name: "an uncommitted .gitignore that un-ignores a file the worktree holds",
      leave: ({ slot }) => write(`${slot}/debug.log`, "stale ignored copy\n"),
      next: (canonical) =>
        Effect.gen(function* () {
          yield* write(`${canonical}/.gitignore`, "")
          yield* write(`${canonical}/debug.log`, "canonical\n")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* read(`${slot}/debug.log`)).toBe("canonical\n")
        }),
    },
    {
      name: "an uncommitted ignore rule over content the worktree holds",
      leave: ({ slot }) => write(`${slot}/.cache/data`, "copied\n"),
      next: (canonical) =>
        Effect.gen(function* () {
          yield* write(`${canonical}/.gitignore`, "*.log\n.cache/\n")
          yield* write(`${canonical}/.cache/data`, "copied\n")
        }),
      // HEAD's rules do not ignore it, the frozen ones do: it stays for the copy layer to judge.
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* read(`${slot}/.cache/data`)).toBe("copied\n")
        }),
    },
    {
      name: "a directory replaced by a file",
      leave: ({ slot }) => write(`${slot}/src/lib/build.log`, "ignored\n"),
      next: (canonical) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.rm(`${canonical}/src/lib`, { recursive: true }))
          yield* write(`${canonical}/src/lib`, "now a file\n")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          expect(yield* read(`${slot}/src/lib`)).toBe("now a file\n")
        }),
    },
    {
      name: "a committed case-only rename",
      next: (canonical) =>
        Effect.gen(function* () {
          yield* git(canonical, "mv", "src/a.txt", "src/A.txt")
          yield* git(canonical, "commit", "-qm", "rename")
        }),
      check: ({ slot }) =>
        Effect.gen(function* () {
          const listed = yield* names(`${slot}/src`)
          expect(listed).toContain("A.txt")
          expect(listed).not.toContain("a.txt")
        }),
    },
  ]

  for (const transition of transitions) {
    it.live(`syncs a kept worktree to the next turn's base after ${transition.name}`, () =>
      Effect.gen(function* () {
        const fixture = yield* arrange(transition.arrange)
        yield* leftovers(fixture)
        if (transition.leave) yield* transition.leave(fixture)
        yield* transition.next(fixture.canonical)
        const base = yield* snapshotBase({ canonical: fixture.canonical })
        // The next turn's host is a new copy of the canonical git directory; borrowing the canonical
        // objects stands in for it.
        yield* write(`${fixture.host}/objects/info/alternates`, `${fixture.canonical}/.git/objects\n`)
        const state = {
          worktree: fixture.slot,
          frozenHead: base.frozenHead,
          indexTree: base.indexTree,
          workingTree: base.baseTree,
          ...(base.branch ? { branch: base.branch } : {}),
        } satisfies VerifyContestantStateInput
        const expected = yield* status(fixture.canonical)
        for (const _ of [1, 2]) {
          yield* syncContestantState(state)
          yield* verifyContestantState(state)
          expect(yield* status(fixture.slot)).toBe(expected)
        }
        if (transition.check) yield* transition.check(fixture)
      }),
    )
  }

  // Git reads GIT_CONFIG_COUNT/KEY/VALUE as command-line config, above every config file.
  const withGitConfig = (config: Record<string, string>) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const values: Record<string, string> = { GIT_CONFIG_COUNT: String(Object.keys(config).length) }
        Object.entries(config).forEach(([key, value], index) => {
          values[`GIT_CONFIG_KEY_${index}`] = key
          values[`GIT_CONFIG_VALUE_${index}`] = value
        })
        const saved = Object.keys(values).map((name) => [name, process.env[name]] as const)
        Object.assign(process.env, values)
        return saved
      }),
      (saved) =>
        Effect.sync(() => {
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
          }
        }),
    )

  it.live("sync, verification and patches ignore the developer's diff config", () =>
    Effect.gen(function* () {
      const fixture = yield* arrange({ dirty: true })
      yield* leftovers(fixture)
      const delta = {
        canonical: fixture.canonical,
        baseCommit: fixture.state.frozenHead,
        resultCommit: fixture.state.workingTree,
      }
      const plain = yield* resultPatch(delta)
      const patch = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* withGitConfig({
            "diff.noprefix": "true",
            "diff.mnemonicPrefix": "true",
            "diff.relative": "true",
            "diff.submodule": "log",
            "diff.external": "false",
            "color.ui": "always",
          })
          // The config reaches git: porcelain `git diff` now prints no prefixes.
          const porcelain = yield* (yield* Git.Service).run(
            ["diff", "--no-ext-diff", fixture.state.frozenHead, fixture.state.workingTree],
            { cwd: fixture.canonical },
          )
          expect(porcelain.text()).not.toContain("diff --git a/")
          yield* syncContestantState(fixture.state)
          yield* verifyContestantState(fixture.state)
          return yield* resultPatch(delta)
        }),
      )
      expect(yield* status(fixture.slot)).toBe(fixture.expected)
      expect(patch).toBe(plain)
      expect(patch.startsWith("diff --git a/")).toBe(true)
      // The worktree holds the result, so the patch applies to it in reverse.
      const check = yield* Effect.promise(() =>
        $`git apply --check -R < ${new Response(patch)}`.cwd(fixture.slot).quiet().nothrow(),
      )
      expect(check.stderr.toString()).toBe("")
      expect(check.exitCode).toBe(0)
    }),
  )
})
