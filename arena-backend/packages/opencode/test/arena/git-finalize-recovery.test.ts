import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import {
  finalize,
  importResultRef,
  mirrorCanonicalRefs,
  OperationError,
  readResultRefs,
  snapshotBase,
} from "@/arena/git"
import { Git } from "@/git"

const gitLayer = LayerNode.compile(LayerNode.group([Git.node]))

const run = <A, E>(effect: Effect.Effect<A, E, Git.Service>) => Effect.runPromise(effect.pipe(Effect.provide(gitLayer)))

async function makeGitRepo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arena-git-finalize-")))
  await $`git init -q -b main`.cwd(dir).quiet()
  await $`git config user.email test@example.com`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  await fs.writeFile(path.join(dir, "base.txt"), "base\n", "utf8")
  await $`git add base.txt && git commit -qm base`.cwd(dir).quiet()
  return dir
}

async function makeTempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arena-git-host-")))
}

async function makeIsolatedHost(canonical: string, branch: string, requiredRefs?: readonly string[]) {
  const hostDir = await makeTempDir()
  const host = path.join(hostDir, "host.git")
  const worktree = path.join(hostDir, "worktree")
  await $`cp -R ${path.join(canonical, ".git")} ${host}`.quiet()
  await $`git config core.bare true`.cwd(host).quiet()
  await run(
    mirrorCanonicalRefs({
      canonical,
      host,
      ...(requiredRefs ? { requiredRefs } : {}),
    }),
  )
  await $`git worktree add ${worktree} ${branch}`.cwd(host).quiet()
  return { hostDir, host, worktree }
}

describe("ArenaGit finalize recovery", () => {
  test("refetches pruned base objects from canonical and repairs a contestant-rewritten result ref", async () => {
    const canonical = await makeGitRepo()
    let hostDir: string | undefined
    try {
      // Dirty working tree so baseCommit is a synthetic snapshot commit on top of canonicalHead.
      await fs.writeFile(path.join(canonical, "dirty.txt"), "untracked\n", "utf8")
      const baseRef = "refs/battles/pruned-base/turn-0/base"
      const base = await run(snapshotBase({ canonical, permanentRef: baseRef }))
      expect(base.clean).toBe(false)
      expect(base.baseCommit).not.toBe(base.frozenHead)

      const branch = base.branch ?? "main"
      const isolated = await makeIsolatedHost(canonical, branch, [baseRef])
      hostDir = isolated.hostDir
      const { host, worktree } = isolated
      await fs.writeFile(path.join(worktree, "dirty.txt"), "untracked\n", "utf8")

      // First finalize succeeds and imports the result refs to canonical.
      const permanentRef = "refs/battles/pruned-base/turn-0/b"
      await fs.writeFile(path.join(worktree, "first.txt"), "first\n", "utf8")
      const first = await run(
        finalize({
          worktree,
          baseSHA: base.baseCommit,
          frozenHead: base.frozenHead,
          canonical,
          baseRef,
          permanentRef,
        }),
      )
      await run(
        importResultRef({
          canonical,
          sourceRepository: host,
          sourceRef: first.permanentRef,
          destinationRef: first.permanentRef,
          expectedCommit: first.finalCommit,
        }),
      )
      await run(
        importResultRef({
          canonical,
          sourceRepository: host,
          sourceRef: first.finalIndexRef,
          destinationRef: first.finalIndexRef,
          expectedCommit: first.finalIndexTree,
          objectType: "tree",
        }),
      )

      // Simulate `git filter-repo` + `git gc --prune=now`:
      // rewrite HEAD onto an unrelated orphan commit, rewrite the private result ref in the host,
      // delete the index ref, and prune every unreachable object (including baseCommit and frozenHead).
      await $`git checkout --orphan rewritten`.cwd(worktree).quiet()
      await $`git rm -rf --cached .`.cwd(worktree).quiet()
      await fs.writeFile(path.join(worktree, "rewritten.txt"), "clean history\n", "utf8")
      await $`git add -A && git commit -qm rewritten`.cwd(worktree).quiet()
      const rewrittenHead = (await $`git rev-parse HEAD`.cwd(worktree).quiet().text()).trim()
      await $`git branch -f ${branch} ${rewrittenHead}`.cwd(worktree).quiet()
      await $`git switch ${branch}`.cwd(worktree).quiet()
      await $`git branch -D rewritten`.cwd(worktree).quiet()
      await $`git update-ref ${permanentRef} ${rewrittenHead}`.cwd(worktree).quiet()
      await $`git update-ref -d ${first.finalIndexRef}`.cwd(worktree).quiet()
      await $`git reflog expire --expire=now --all`.cwd(worktree).quiet()
      await $`git gc --prune=now`.cwd(worktree).quiet()

      // Confirm both baseCommit and frozenHead are gone from the isolated host.
      expect((await $`git cat-file -e ${base.baseCommit}`.cwd(worktree).quiet().nothrow()).exitCode).not.toBe(0)
      expect((await $`git cat-file -e ${base.frozenHead}`.cwd(worktree).quiet().nothrow()).exitCode).not.toBe(0)

      // Canonical still holds the authoritative prior refs.
      const canonicalRefs = await run(readResultRefs(canonical, permanentRef))
      expect(canonicalRefs).toEqual({ commit: first.finalCommit, indexTree: first.finalIndexTree })

      // Second finalize refetches base objects from canonical and repairs the rewritten/deleted host refs.
      const second = await run(
        finalize({
          worktree,
          baseSHA: base.baseCommit,
          frozenHead: base.frozenHead,
          canonical,
          baseRef,
          permanentRef,
          expectedPermanentCommit: first.finalCommit,
          expectedFinalIndexTree: first.finalIndexTree,
        }),
      )
      expect(second.rawHead).toBe(rewrittenHead)
      expect(second.baseIsAncestor).toBe(false)
      expect(second.wrapperCreated).toBe(true)
      expect(second.diff.some((item) => item.file === "rewritten.txt")).toBe(true)

      // Importing the repaired result into canonical still succeeds with strict CAS.
      const importedCommit = await run(
        importResultRef({
          canonical,
          sourceRepository: host,
          sourceRef: second.permanentRef,
          destinationRef: second.permanentRef,
          expectedCommit: second.finalCommit,
          expectedDestinationCommit: first.finalCommit,
        }),
      )
      expect(importedCommit).toBe(second.finalCommit)
      const importedIndex = await run(
        importResultRef({
          canonical,
          sourceRepository: host,
          sourceRef: second.finalIndexRef,
          destinationRef: second.finalIndexRef,
          expectedCommit: second.finalIndexTree,
          objectType: "tree",
          expectedDestinationCommit: first.finalIndexTree,
        }),
      )
      expect(importedIndex).toBe(second.finalIndexTree)

      // A genuinely stale caller (passing first.finalCommit after canonical advanced to second.finalCommit)
      // is still refused even in an isolated host.
      await fs.writeFile(path.join(worktree, "third.txt"), "third\n", "utf8")
      const stale = await run(
        Effect.exit(
          finalize({
            worktree,
            baseSHA: base.baseCommit,
            frozenHead: base.frozenHead,
            canonical,
            baseRef,
            permanentRef,
            expectedPermanentCommit: first.finalCommit,
            expectedFinalIndexTree: first.finalIndexTree,
          }),
        ),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale)) expect(Cause.squash(stale.cause)).toBeInstanceOf(OperationError)
    } finally {
      await fs.rm(canonical, { recursive: true, force: true })
      if (hostDir) await fs.rm(hostDir, { recursive: true, force: true })
    }
  })

  test("refetches pruned base objects without baseRef and replaces an unimported host result ref", async () => {
    const canonical = await makeGitRepo()
    let hostDir: string | undefined
    try {
      const base = await run(snapshotBase({ canonical }))
      const branch = base.branch ?? "main"
      const isolated = await makeIsolatedHost(canonical, branch)
      hostDir = isolated.hostDir
      const { worktree } = isolated

      // Contestant rewrites history, pre-creates the battle ref in the host, and prunes the base commit.
      const permanentRef = "refs/battles/stray-ref/turn-0/a"
      await $`git checkout --orphan fresh`.cwd(worktree).quiet()
      await fs.writeFile(path.join(worktree, "fresh.txt"), "fresh\n", "utf8")
      await $`git add -A && git commit -qm fresh`.cwd(worktree).quiet()
      const freshHead = (await $`git rev-parse HEAD`.cwd(worktree).quiet().text()).trim()
      await $`git branch -f ${branch} ${freshHead}`.cwd(worktree).quiet()
      await $`git switch ${branch}`.cwd(worktree).quiet()
      await $`git branch -D fresh`.cwd(worktree).quiet()
      await $`git update-ref ${permanentRef} ${freshHead}`.cwd(worktree).quiet()
      await $`git reflog expire --expire=now --all`.cwd(worktree).quiet()
      await $`git gc --prune=now`.cwd(worktree).quiet()

      expect((await $`git cat-file -e ${base.baseCommit}`.cwd(worktree).quiet().nothrow()).exitCode).not.toBe(0)

      // No baseRef and no expectedPermanentCommit: canonical has no ref yet, so host ref is replaced
      // and baseCommit is refetched directly by SHA.
      const result = await run(
        finalize({
          worktree,
          baseSHA: base.baseCommit,
          canonical,
          permanentRef,
        }),
      )
      expect(result.rawHead).toBe(freshHead)
      expect(result.wrapperCreated).toBe(true)
      expect((await $`git rev-parse ${permanentRef}`.cwd(worktree).quiet().text()).trim()).toBe(result.finalCommit)

      // Once imported into canonical, calling finalize without expectedPermanentCommit refuses to overwrite.
      await run(
        importResultRef({
          canonical,
          sourceRepository: isolated.host,
          sourceRef: result.permanentRef,
          destinationRef: result.permanentRef,
          expectedCommit: result.finalCommit,
        }),
      )
      await fs.writeFile(path.join(worktree, "another.txt"), "another\n", "utf8")
      const overwrite = await run(
        Effect.exit(
          finalize({
            worktree,
            baseSHA: base.baseCommit,
            canonical,
            permanentRef,
          }),
        ),
      )
      expect(Exit.isFailure(overwrite)).toBe(true)
      if (Exit.isFailure(overwrite)) expect(Cause.squash(overwrite.cause)).toBeInstanceOf(OperationError)
    } finally {
      await fs.rm(canonical, { recursive: true, force: true })
      if (hostDir) await fs.rm(hostDir, { recursive: true, force: true })
    }
  })

  test("preserves strict compare-and-swap when worktree shares canonical repository", async () => {
    const canonical = await makeGitRepo()
    const linked = await makeTempDir()
    try {
      const base = (await $`git rev-parse HEAD`.cwd(canonical).quiet().text()).trim()
      const permanentRef = "refs/battles/shared-cas/turn-0/a"
      await $`git worktree add --detach ${linked} ${base}`.cwd(canonical).quiet()

      await fs.writeFile(path.join(linked, "file.txt"), "first\n", "utf8")
      const first = await run(finalize({ worktree: linked, baseSHA: base, canonical, permanentRef }))

      await fs.writeFile(path.join(linked, "file.txt"), "second\n", "utf8")
      const second = await run(
        finalize({
          worktree: linked,
          baseSHA: base,
          canonical,
          permanentRef,
          expectedPermanentCommit: first.finalCommit,
          expectedFinalIndexTree: first.finalIndexTree,
        }),
      )
      expect(second.finalCommit).not.toBe(first.finalCommit)

      // Stale caller passing first.finalCommit must fail.
      await fs.writeFile(path.join(linked, "file.txt"), "third\n", "utf8")
      const stale = await run(
        Effect.exit(
          finalize({
            worktree: linked,
            baseSHA: base,
            canonical,
            permanentRef,
            expectedPermanentCommit: first.finalCommit,
            expectedFinalIndexTree: first.finalIndexTree,
          }),
        ),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale)) expect(Cause.squash(stale.cause)).toBeInstanceOf(OperationError)
    } finally {
      await $`git worktree remove --force ${linked}`.cwd(canonical).quiet().nothrow()
      await fs.rm(canonical, { recursive: true, force: true })
      await fs.rm(linked, { recursive: true, force: true })
    }
  })

  test("replaces live or dangling symrefs on isolated host result refs without moving their targets", async () => {
    const canonical = await makeGitRepo()
    let hostDir: string | undefined
    try {
      const base = await run(snapshotBase({ canonical }))
      const branch = base.branch ?? "main"
      const isolated = await makeIsolatedHost(canonical, branch)
      hostDir = isolated.hostDir
      const { worktree } = isolated

      const permanentRef = "refs/battles/symref-test/turn-0/b"
      const indexRef = `${permanentRef}-index`
      const mainBefore = (await $`git rev-parse refs/heads/${branch}`.cwd(worktree).quiet().text()).trim()

      // Contestant replaces permanentRef with a live symref to main and indexRef with a dangling symref.
      await $`git symbolic-ref ${permanentRef} refs/heads/${branch}`.cwd(worktree).quiet()
      await $`git symbolic-ref ${indexRef} refs/heads/nonexistent-branch`.cwd(worktree).quiet()
      await fs.writeFile(path.join(worktree, "edit.txt"), "edited\n", "utf8")

      const result = await run(
        finalize({
          worktree,
          baseSHA: base.baseCommit,
          canonical,
          permanentRef,
        }),
      )

      // Both refs are now direct refs pointing to the finalized commit/tree.
      expect((await $`git symbolic-ref --quiet ${permanentRef}`.cwd(worktree).quiet().nothrow()).exitCode).not.toBe(0)
      expect((await $`git symbolic-ref --quiet ${indexRef}`.cwd(worktree).quiet().nothrow()).exitCode).not.toBe(0)
      expect((await $`git rev-parse --verify ${permanentRef}`.cwd(worktree).quiet().text()).trim()).toBe(
        result.finalCommit,
      )
      expect((await $`git rev-parse --verify ${indexRef}`.cwd(worktree).quiet().text()).trim()).toBe(
        result.finalIndexTree,
      )
      // Neither target branch was moved or created.
      expect((await $`git rev-parse refs/heads/${branch}`.cwd(worktree).quiet().text()).trim()).toBe(mainBefore)
      expect(
        (await $`git show-ref --verify --quiet refs/heads/nonexistent-branch`.cwd(worktree).quiet().nothrow()).exitCode,
      ).not.toBe(0)
    } finally {
      await fs.rm(canonical, { recursive: true, force: true })
      if (hostDir) await fs.rm(hostDir, { recursive: true, force: true })
    }
  })
})
