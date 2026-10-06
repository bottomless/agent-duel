import { afterEach, describe, expect } from "bun:test"
import { execFileSync, spawnSync } from "child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node, Project.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)
const posix = process.platform !== "win32" ? it.instance : it.instance.skip

// No `-c` identity: the tests read the hosts' config, and the fixture's checkout sets one.
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function gitCode(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status
}

function worktreePaths(host: string) {
  return git(host, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
}

function refs(cwd: string) {
  return git(cwd, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)
}

/** Wait for something a background fiber does, since the caller is not told when it ends. */
const until = Effect.fn("AdoptTest.until")(function* (done: () => boolean) {
  for (const _ of Array.from({ length: 50 })) {
    if (done()) return
    yield* Effect.sleep("100 millis")
  }
})

const lstatOrUndefined = (target: string) => {
  try {
    return lstatSync(target)
  } catch {
    return undefined
  }
}

/** The checkout: two tracked files, and Arena's private refs, loose and packed. */
function prepareCheckout(root: string) {
  writeFileSync(path.join(root, "a.txt"), "a\n")
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "b.txt"), "b\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "files")
  const head = git(root, "rev-parse", "HEAD")
  git(root, "update-ref", "refs/battles/chat/turn-0/a", head)
  git(root, "pack-refs", "--all")
  git(root, "update-ref", "refs/battles/chat/turn-1/a", head)
  git(root, "update-ref", "refs/heads/agent-duel/chat-agent-a", head)
  return { head, branch: git(root, "symbolic-ref", "--short", "HEAD") }
}

const slotPath = (checkout: string, name: string) => path.join(Worktree.isolatedRoot(checkout), "chat", name)

/** A contestant worktree as a turn creates one: its own host, checked out at the base. */
const createSlot = Effect.fn("AdoptTest.createSlot")(function* (name: string, branch?: string) {
  const test = yield* TestInstance
  const svc = yield* Worktree.Service
  const head = git(test.directory, "rev-parse", "HEAD")
  const info = yield* svc.reclaimWorktreeInfo({ name: `chat/${name}`, branch, isolated: true })
  yield* svc.attachAt(info, head, { reset: true })
  git(info.directory, "reset", "--hard")
  return { directory: info.directory, host: info.host! }
})

/** What a contestant can leave behind in its worktree and host without changing a file. */
function useSlot(directory: string, host: string) {
  git(directory, "branch", "junk")
  writeFileSync(path.join(directory, "a.txt"), "stashed\n")
  git(directory, "stash")
  git(directory, "commit", "--allow-empty", "-m", "contestant")
  const commit = git(directory, "rev-parse", "HEAD")
  git(directory, "config", "user.name", "Intruder")
  writeFileSync(path.join(host, "hooks", "post-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  git(directory, "worktree", "add", "--detach", path.join(path.dirname(directory), "extra"))
  git(directory, "update-ref", "refs/battles/leak/turn-0/b", commit)
  writeFileSync(path.join(host, "packed-refs.lock"), "")
  writeFileSync(path.join(host, "config.lock"), "")
  git(directory, "update-index", "--skip-worktree", "src/b.txt")
  return commit
}

describe("Worktree.adopt", () => {
  afterEach(() => disposeAllInstances())

  posix(
    "turns a used worktree into a fresh one at a new path, keeping its files and index",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const leftover = useSlot(from.directory, from.host)
        const inode = statSync(path.join(from.directory, "a.txt")).ino
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted).toEqual({
          name: "chat/generation-2-a",
          branch,
          directory: to,
          host: Worktree.hostRepoPath(to),
          indexKept: true,
        })
        expect(existsSync(from.directory)).toBe(false)
        expect(existsSync(from.host)).toBe(false)
        // The files moved, they were not copied, so the kept index still matches them by stat.
        expect(statSync(path.join(to, "a.txt")).ino).toBe(inode)
        expect(gitCode(to, "diff-files", "--quiet")).toBe(0)

        // The host is the checkout's again: config, hooks, refs, objects, one worktree.
        const host = adopted.host!
        expect(git(to, "config", "--get", "user.name")).toBe(git(test.directory, "config", "--get", "user.name"))
        expect(existsSync(path.join(host, "hooks", "post-commit"))).toBe(false)
        expect(existsSync(path.join(host, "packed-refs.lock"))).toBe(false)
        expect(existsSync(path.join(host, "config.lock"))).toBe(false)
        const hostRefs = refs(to)
        expect(hostRefs).not.toContain("refs/heads/junk")
        expect(hostRefs).not.toContain("refs/stash")
        expect(hostRefs.filter((ref) => /^refs\/(battles|agent-duel|heads\/agent-duel)\//.test(ref))).toEqual([])
        expect(gitCode(to, "cat-file", "-e", `${leftover}^{commit}`)).not.toBe(0)
        expect(worktreePaths(host)).toHaveLength(2)
        expect(git(to, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`)
        expect(git(to, "rev-parse", "HEAD")).toBe(head)
        expect(gitCode(to, "reflog", "exists", "HEAD")).not.toBe(0)

        // What the caller does next works on what adopt leaves.
        git(to, "update-index", "--no-skip-worktree", "src/b.txt")
        git(to, "reset", "--hard", head)
        expect(git(to, "status", "--porcelain")).toBe("")
        git(to, "commit", "--allow-empty", "-m", "next contestant")
        expect(git(test.directory, "rev-parse", "HEAD")).toBe(head)
        expect(worktreePaths(test.directory)).toHaveLength(1)
        expect(refs(test.directory)).toContain("refs/battles/chat/turn-1/a")
      }),
    { git: true },
  )

  posix(
    "detaches at head without a branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-b", branch)
        git(from.directory, "commit", "--allow-empty", "-m", "contestant")
        const to = slotPath(test.directory, "generation-2-b")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-b",
          head,
        })

        expect(adopted.branch).toBeUndefined()
        expect(gitCode(to, "symbolic-ref", "-q", "HEAD")).not.toBe(0)
        expect(git(to, "rev-parse", "HEAD")).toBe(head)
      }),
    { git: true },
  )

  posix(
    "creates a branch the checkout does not have at head",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const to = slotPath(test.directory, "generation-2-a")

        yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch: "contestant/new",
          head,
        })

        expect(git(to, "symbolic-ref", "HEAD")).toBe("refs/heads/contestant/new")
        expect(git(to, "rev-parse", "HEAD")).toBe(head)
        expect(gitCode(test.directory, "rev-parse", "--verify", "-q", "refs/heads/contestant/new")).not.toBe(0)
      }),
    { git: true },
  )

  // The refresh at send: the worktree stays where it is and gets a new host under it.
  posix(
    "refreshes a worktree in place",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const slot = yield* createSlot("generation-1-a", branch)
        useSlot(slot.directory, slot.host)
        const inode = statSync(path.join(slot.directory, "a.txt")).ino

        const adopted = yield* svc.adopt({
          from: slot.directory,
          to: slot.directory,
          name: "chat/generation-1-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(true)
        expect(adopted.host).toBe(slot.host)
        expect(statSync(path.join(slot.directory, "a.txt")).ino).toBe(inode)
        expect(gitCode(slot.directory, "diff-files", "--quiet")).toBe(0)
        expect(existsSync(path.join(slot.host, "hooks", "post-commit"))).toBe(false)
        expect(refs(slot.directory)).not.toContain("refs/heads/junk")
        expect(worktreePaths(slot.host)).toHaveLength(2)
        expect(git(slot.directory, "rev-parse", "HEAD")).toBe(head)
      }),
    { git: true },
  )

  // Most of a split index lives in a `sharedindex.*` file that does not move with it.
  posix(
    "rebuilds a split index from head",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        git(from.directory, "update-index", "--split-index")
        const admin = git(from.directory, "rev-parse", "--absolute-git-dir")
        expect(readdirSync(admin).some((name) => name.startsWith("sharedindex."))).toBe(true)
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(false)
        // A rebuilt index has no stat information, which is what a kept one saves the caller.
        expect(gitCode(to, "diff-files", "--quiet")).not.toBe(0)
        expect(git(to, "status", "--porcelain")).toBe("")
        expect(git(to, "ls-files")).toBe(git(test.directory, "ls-files"))
      }),
    { git: true },
  )

  posix(
    "rebuilds an index that does not read",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const admin = git(from.directory, "rev-parse", "--absolute-git-dir")
        writeFileSync(path.join(admin, "index"), "DIRC garbage")
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(false)
        expect(git(to, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  // The link is the previous contestant's file. Pointed at another worktree's admin entry, it
  // must not hand that worktree's index over.
  posix(
    "does not follow a link into another worktree's host",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const other = yield* createSlot("generation-1-b", branch)
        const otherAdmin = git(other.directory, "rev-parse", "--absolute-git-dir")
        writeFileSync(path.join(from.directory, ".git"), `gitdir: ${otherAdmin}\n`)
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(false)
        expect(git(to, "status", "--porcelain")).toBe("")
        expect(existsSync(path.join(otherAdmin, "index"))).toBe(true)
        expect(git(other.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  posix(
    "discards whatever occupies the target path first",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const to = slotPath(test.directory, "generation-2-a")
        mkdirSync(to, { recursive: true })
        writeFileSync(path.join(to, "stale.txt"), "stale\n")
        mkdirSync(Worktree.hostRepoPath(to), { recursive: true })
        writeFileSync(path.join(Worktree.hostRepoPath(to), "stale"), "stale\n")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(true)
        expect(existsSync(path.join(to, "stale.txt"))).toBe(false)
        expect(existsSync(path.join(adopted.host!, "stale"))).toBe(false)
        expect(readFileSync(path.join(to, "a.txt"), "utf8")).toBe("a\n")
        expect(git(to, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  posix(
    "refuses a path outside the isolated root and moves nothing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)

        const exit = yield* Effect.exit(
          svc.adopt({ from: from.directory, to: test.directory, name: "checkout", branch, head }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.CreateFailedError)
        expect(git(test.directory, "status", "--porcelain")).toBe("")
        expect(git(from.directory, "status", "--porcelain")).toBe("")
        expect(existsSync(from.host)).toBe(true)
      }),
    { git: true },
  )

  // APFS folds case: a target spelled differently can be the source itself, and clearing it
  // first would clear the worktree being adopted.
  posix(
    "refuses a target that is the source under another spelling",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const to = slotPath(test.directory, "GENERATION-1-A")
        if (!existsSync(to)) return

        const exit = yield* Effect.exit(
          svc.adopt({ from: from.directory, to, name: "chat/GENERATION-1-A", branch, head }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(readFileSync(path.join(from.directory, "a.txt"), "utf8")).toBe("a\n")
        expect(git(from.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  // A head the new host cannot resolve fails after the old host moved aside and before the
  // tree moved, so the old host goes back and the worktree is as the caller had it.
  posix(
    "puts the old host back when it fails before the tree moves",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        git(from.directory, "branch", "junk")
        const to = slotPath(test.directory, "generation-2-a")

        const exit = yield* Effect.exit(
          svc.adopt({
            from: from.directory,
            to,
            name: "chat/generation-2-a",
            branch,
            head: "f".repeat(40),
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(existsSync(to)).toBe(false)
        expect(existsSync(Worktree.hostRepoPath(to))).toBe(false)
        expect(refs(from.directory)).toContain("refs/heads/junk")
        expect(git(from.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  // Reftable keeps a worktree's HEAD in the admin entry's own tables and ignores a HEAD file
  // written there, so a HEAD written as for the files backend leaves one git cannot resolve.
  posix(
    "sets HEAD through git in a reftable checkout",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        if (gitCode(test.directory, "refs", "migrate", "--ref-format=reftable") !== 0) return
        const from = yield* createSlot("generation-1-a", branch)
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(true)
        expect(git(to, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`)
        expect(git(to, "rev-parse", "HEAD")).toBe(head)
        expect(gitCode(to, "reflog", "exists", "HEAD")).not.toBe(0)
        git(to, "reset", "--hard", head)
        expect(git(to, "status", "--porcelain")).toBe("")

        yield* svc.adopt({ from: to, to, name: "chat/generation-2-a", head })

        expect(gitCode(to, "symbolic-ref", "-q", "HEAD")).not.toBe(0)
        expect(git(to, "rev-parse", "HEAD")).toBe(head)
        git(to, "commit", "--allow-empty", "-m", "next contestant")
        expect(worktreePaths(adopted.host!)).toHaveLength(2)
      }),
    { git: true },
  )

  // The cache records the directory it was built in. At a new path git stops using it and
  // warns on every status, which only the side that inherited the worktree would see.
  posix(
    "drops the previous occupant's untracked cache from a kept index",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        git(from.directory, "update-index", "--untracked-cache")
        git(from.directory, "status", "--porcelain")
        const admin = git(from.directory, "rev-parse", "--absolute-git-dir")
        expect(readFileSync(path.join(admin, "index")).includes("UNTR")).toBe(true)
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(true)
        const index = path.join(git(to, "rev-parse", "--absolute-git-dir"), "index")
        expect(readFileSync(index).includes("UNTR")).toBe(false)
        expect(gitCode(to, "diff-files", "--quiet")).toBe(0)
        git(to, "reset", "--hard", head)
        const status = spawnSync("git", ["status", "--porcelain"], { cwd: to, encoding: "utf8" })
        expect(status.stdout).toBe("")
        expect(status.stderr).toBe("")
      }),
    { git: true },
  )

  // The previous contestant can write to its host. The index is moved by its path under the
  // host, so a symlink anywhere on that path would hand over another worktree's index.
  posix(
    "does not take another worktree's index through a symlinked worktrees directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const other = yield* createSlot("generation-1-b", branch)
        const otherAdmin = git(other.directory, "rev-parse", "--absolute-git-dir")
        renameSync(path.join(from.host, "worktrees"), path.join(from.host, "worktrees-moved"))
        symlinkSync(path.join(other.host, "worktrees"), path.join(from.host, "worktrees"))
        writeFileSync(
          path.join(from.directory, ".git"),
          `gitdir: ${path.join(from.host, "worktrees", path.basename(otherAdmin))}\n`,
        )
        const to = slotPath(test.directory, "generation-2-a")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })

        expect(adopted.indexKept).toBe(false)
        expect(git(to, "status", "--porcelain")).toBe("")
        expect(existsSync(path.join(otherAdmin, "index"))).toBe(true)
        expect(git(other.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  posix(
    "does not take or delete another worktree's host through a symlinked host",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const other = yield* createSlot("generation-1-b", branch)
        const otherAdmin = git(other.directory, "rev-parse", "--absolute-git-dir")
        rmSync(from.host, { recursive: true, force: true })
        symlinkSync(other.host, from.host)
        writeFileSync(
          path.join(from.directory, ".git"),
          `gitdir: ${path.join(from.host, "worktrees", path.basename(otherAdmin))}\n`,
        )
        const to = slotPath(test.directory, "generation-2-a")
        const trash = path.join(path.dirname(from.directory), ".trash")

        const adopted = yield* svc.adopt({
          from: from.directory,
          to,
          name: "chat/generation-2-a",
          branch,
          head,
        })
        yield* until(() => !readdirSync(trash).some((name) => name.startsWith("generation-1-a.git-")))

        expect(adopted.indexKept).toBe(false)
        expect(git(to, "status", "--porcelain")).toBe("")
        expect(lstatOrUndefined(from.host)).toBeUndefined()
        expect(existsSync(path.join(otherAdmin, "index"))).toBe(true)
        expect(git(other.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  // A sweep of the chat's trash can start at any time, and the old host waits in that trash
  // until its index has moved.
  posix(
    "keeps the index while the trash it waits in is swept",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { head, branch } = prepareCheckout(test.directory)
        const from = yield* createSlot("generation-1-a", branch)
        const to = slotPath(test.directory, "generation-2-a")
        const chat = path.dirname(from.directory)
        let adopting = true

        const [adopted] = yield* Effect.all(
          [
            svc
              .adopt({ from: from.directory, to, name: "chat/generation-2-a", branch, head })
              .pipe(Effect.ensuring(Effect.sync(() => (adopting = false)))),
            Effect.gen(function* () {
              while (adopting) {
                yield* svc.sweepTrash(chat)
                yield* Effect.sleep("2 millis")
              }
            }),
          ],
          { concurrency: 2 },
        )

        expect(adopted.indexKept).toBe(true)
        expect(gitCode(to, "diff-files", "--quiet")).toBe(0)
      }),
    { git: true },
  )
})

describe("Worktree.retire", () => {
  afterEach(() => disposeAllInstances())

  posix(
    "removes a worktree whose link is broken, and its host",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { branch } = prepareCheckout(test.directory)
        const slot = yield* createSlot("generation-1-a", branch)
        writeFileSync(path.join(slot.directory, ".git"), "gitdir: /nonexistent/worktrees/generation-1-a\n")

        yield* svc.retire(slot.directory)

        expect(existsSync(slot.directory)).toBe(false)
        expect(existsSync(slot.host)).toBe(false)
        expect(git(test.directory, "status", "--porcelain")).toBe("")
      }),
    { git: true },
  )

  posix(
    "removes a host whose worktree is gone",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { branch } = prepareCheckout(test.directory)
        const slot = yield* createSlot("generation-1-a", branch)
        rmSync(slot.directory, { recursive: true, force: true })

        yield* svc.retire(slot.directory)

        expect(existsSync(slot.host)).toBe(false)
      }),
    { git: true },
  )

  posix(
    "refuses the checkout",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service

        const exit = yield* Effect.exit(svc.retire(test.directory))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(existsSync(path.join(test.directory, ".git"))).toBe(true)
      }),
    { git: true },
  )
})

describe("Worktree.sweepTrash", () => {
  afterEach(() => disposeAllInstances())

  posix(
    "empties a chat directory's trash",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const chat = path.join(Worktree.isolatedRoot(test.directory), "chat")
        mkdirSync(path.join(chat, ".trash", "generation-1-a-dead", "deep"), { recursive: true })
        writeFileSync(path.join(chat, ".trash", "generation-1-a-dead", "deep", "file"), "x")

        yield* svc.sweepTrash(chat)

        for (const _ of Array.from({ length: 50 })) {
          if (readdirSync(path.join(chat, ".trash")).length === 0) break
          yield* Effect.sleep("100 millis")
        }
        expect(readdirSync(path.join(chat, ".trash"))).toEqual([])
      }),
    { git: true },
  )

  // A contestant reaches its chat's trash as `../.trash`.
  posix(
    "unlinks a trash that is a symlink instead of emptying what it names",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const chat = path.join(Worktree.isolatedRoot(test.directory), "chat")
        const victim = path.join(test.directory, "victim")
        mkdirSync(victim, { recursive: true })
        writeFileSync(path.join(victim, "keep.txt"), "keep\n")
        mkdirSync(chat, { recursive: true })
        symlinkSync(victim, path.join(chat, ".trash"))

        yield* svc.sweepTrash(chat)
        yield* until(() => lstatOrUndefined(path.join(chat, ".trash")) === undefined)

        expect(lstatOrUndefined(path.join(chat, ".trash"))).toBeUndefined()
        expect(readFileSync(path.join(victim, "keep.txt"), "utf8")).toBe("keep\n")
      }),
    { git: true },
  )
})

describe("Worktree.reclaimWorktreeInfo with freshHost", () => {
  afterEach(() => disposeAllInstances())

  posix(
    "copies a new host instead of keeping the one a previous occupant used",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const { branch } = prepareCheckout(test.directory)
        const slot = yield* createSlot("generation-1-a", branch)
        git(slot.directory, "branch", "junk")

        yield* svc.reclaimWorktreeInfo({ name: "chat/generation-1-a", branch, isolated: true })
        expect(refs(slot.host)).toContain("refs/heads/junk")

        yield* svc.reclaimWorktreeInfo({
          name: "chat/generation-1-a",
          branch,
          isolated: true,
          freshHost: true,
        })
        expect(refs(slot.host)).not.toContain("refs/heads/junk")
        expect(refs(slot.host).filter((ref) => ref.startsWith("refs/battles/"))).toEqual([])
        expect(existsSync(slot.directory)).toBe(false)
      }),
    { git: true },
  )
})
