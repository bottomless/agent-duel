import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { spawn as spawnProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { Store } from "@/arena/mongo"
import type { TurnDocument } from "@/arena/records"
import * as CopySnapshot from "@/arena/copy-snapshot"
import { ArenaContestant } from "@/arena/contestant"
import { hostRepoPath, isolatedRoot } from "@/worktree"
import { registry, setStoreForTest } from "@/arena/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { arenaRequest, installOpenRouterStub, json, memoryStore, type PublicSnapshot, waitForTurn } from "./harness"

/**
 * Contestant worktrees are kept between turns and re-synchronized, so these tests drive several
 * turns in one chat and check that every turn's contestants start exactly where the checkout is —
 * whatever the previous occupant of the directory did to it.
 */

const headers = (directory: string) => ({
  "content-type": "application/json",
  "x-opencode-directory": directory,
})

async function waitForWarmPair(store: Store, turnID: string, generation: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const turn = await store.turn(turnID)
    const warm = turn?.warmPreparation
    if (warm?.generation === generation && warm.state === "failed") {
      throw new Error(`Arena warm preparation failed: ${warm.error ?? "no error recorded"}`)
    }
    if (warm?.generation === generation && warm.state === "ready") return turn as TurnDocument
    await Bun.sleep(25)
  }
  throw new Error(`Arena warm pair for generation ${generation} did not become ready`)
}

/** The pair a chat prepares for its first turn when it is opened, once it is ready. */
async function waitForInitialWarmPair(store: Store, chatID: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const warm = (await store.chat(chatID))?.initialWarmPreparation
    if (warm?.state === "failed") {
      throw new Error(`Arena initial warm preparation failed: ${warm.error ?? "no error recorded"}`)
    }
    if (warm?.state === "ready") return warm
    await Bun.sleep(25)
  }
  throw new Error("Arena initial warm pair did not become ready")
}

/** The contestant worktrees in a chat's worktree directory, without their hosts and the trash. */
async function poolWorktrees(pool: string) {
  const entries = await readdir(pool).catch(() => [] as string[])
  return entries.filter((name) => name !== ".trash" && !name.endsWith(".git") && !name.endsWith(".git.partial")).sort()
}

/** OpenCode's snapshot repositories for a worktree path, under whichever project it was keyed to. */
async function snapshotRepositories(worktree: string) {
  const root = path.join(Global.Path.data, "snapshot")
  const name = createHash("sha1").update(worktree).digest("hex")
  const projects = await readdir(root).catch(() => [] as string[])
  const found = await Promise.all(projects.map((project) => exists(path.join(root, project, name))))
  return projects.filter((_, index) => found[index])
}

/** Kill a process group a test started, if anything in it is still running. */
function killQuietly(pid: number) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL")
    } catch {
      // Already gone, which is what the test wanted.
    }
  }
}

async function inode(directory: string) {
  return (await stat(directory)).ino
}

async function git(directory: string, args: readonly string[]) {
  return (await $`git ${args}`.cwd(directory).quiet().nothrow().text()).trim()
}

/** What a contestant sees of its repository, for comparison with the checkout. */
async function repositoryView(directory: string) {
  const refs = (await git(directory, ["for-each-ref", "--format=%(refname) %(objectname)"]))
    .split("\n")
    .filter((line) => line && !line.startsWith("refs/battles/") && !line.startsWith("refs/agent-duel/"))
    .filter((line) => !line.startsWith("refs/heads/agent-duel/"))
    .sort()
  return {
    head: await git(directory, ["rev-parse", "HEAD"]),
    branch: await git(directory, ["symbolic-ref", "-q", "HEAD"]),
    status: (await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])).split("\n").sort(),
    flags: (await git(directory, ["ls-files", "-v"])).split("\n").filter((line) => line && !line.startsWith("H ")),
    refs,
  }
}

async function exists(file: string) {
  return lstat(file).then(
    () => true,
    () => false,
  )
}

function holdIgnoredResync() {
  let signalEntered!: () => void
  let signalRelease!: () => void
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve
  })
  const apply = CopySnapshot.applyIgnoredResync
  const spy = spyOn(CopySnapshot, "applyIgnoredResync").mockImplementation(async (input) => {
    signalEntered()
    await released
    return apply(input)
  })
  return { spy, entered, release: signalRelease }
}

async function waitForCondition(condition: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

async function battle(input: {
  readonly store: Store
  readonly directory: string
  readonly chatID: string
  readonly prompt: string
  readonly beforeVote?: (turnID: string) => Promise<void>
}) {
  const admitted = await json<PublicSnapshot>(
    await arenaRequest(`/arena/chats/${input.chatID}/turns`, {
      method: "POST",
      headers: headers(input.directory),
      body: JSON.stringify({ prompt: input.prompt }),
    }),
  )
  const turnID = admitted.turn?.id
  if (!turnID) throw new Error("Arena did not return the admitted turn")
  // A turn that stops short says why: the engine log goes with the test's data directory.
  await waitForTurn(input.store, turnID, "awaiting_vote").catch(async (cause) => {
    const turn = await input.store.turn(turnID)
    const log = await readFile(`${Global.Path.log}/opencode.log`, "utf8").catch(() => "")
    const arena = log
      .split("\n")
      .filter((line) => line.includes("level=ERROR") || line.includes("level=WARN") || line.includes("failed"))
    const runs = await input.store.runsForTurn(turnID)
    throw new Error(
      `${cause}\nturn ${turn?.state} ${turn?.failureReason ?? ""} ${turn?.comparisonState}\nruns ${JSON.stringify(runs.map((run) => ({ side: run.side, state: run.runState, error: run.error, applicability: run.applicability })))}\n${arena.slice(-40).join("\n")}`,
    )
  })
  if (input.beforeVote) await input.beforeVote(turnID)
  await json<PublicSnapshot>(
    await arenaRequest(`/arena/turns/${turnID}/vote`, {
      method: "POST",
      headers: headers(input.directory),
      body: JSON.stringify({ vote: "a" }),
    }),
  )
  await waitForTurn(input.store, turnID, "complete")
  return turnID
}

// Each side writes leftovers named after its own directory, so the loser's are told apart from the
// winner's, which the vote legitimately applies to the checkout.
const LEFTOVERS = [
  'S=$(basename "$PWD")',
  'printf "%s\\n" "$S" > "leftover-$S.txt"',
  "mkdir -p dist && printf 'built\\n' > dist/out.js",
  'git branch "extra-$S"',
  "printf 'touched\\n' > deps/pkg/touched.js",
  "printf 'stash me\\n' > stash.txt && git add stash.txt && git stash -q",
  "git update-index --skip-worktree README.md && rm README.md",
  "mv notes.md Notes.md",
  // With a commit: finalize leaves a nested repository out of the result, but cannot add an empty one.
  "mkdir -p nested && git -C nested init -q && git -C nested -c user.name=t -c user.email=t@t commit -q --allow-empty -m nested",
  "mkdir -p .agent-duel && printf 'x\\n' > .agent-duel/stray",
].join(" && ")

const COMMIT = "printf 'turn two\\n' > committed.txt && git add committed.txt && git commit -qm 'turn two'"

// Captures the state the contestant starts from before it changes anything.
const CAPTURE = [
  "H=$(git rev-parse HEAD)",
  "B=$(git symbolic-ref -q HEAD)",
  "ST=$(git status --porcelain=v1 --untracked-files=all | tr '\\n' '|')",
  "FL=$(git ls-files -v | grep -v '^H ' | tr '\\n' '|')",
  "REFS=$(git for-each-ref --format='%(refname)' | grep -v '^refs/agent-duel/' | tr '\\n' '|')",
  'CASE=$(ls | tr "\\n" "|")',
  "IGN=$(ls deps/pkg | tr '\\n' '|')",
  "CACHE=$(cat cache.txt)",
  'printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n" "$H" "$B" "$ST" "$FL" "$REFS" "$CASE" "$IGN" "$CACHE" > state.txt',
].join("; ")

/** A checkout with a tracked file and ignored content of both kinds: a directory and a file. */
async function fixture(options?: { readonly reftable?: boolean }) {
  const directory = await tmpdir({
    git: true,
    config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
  })
  const root = directory.path
  await writeFile(path.join(root, "README.md"), "readme\n")
  await $`git add opencode.json README.md`.cwd(root).quiet()
  await $`git commit -m "test: slot fixture"`.cwd(root).quiet()
  if (options?.reftable) await $`git refs migrate --ref-format=reftable`.cwd(root).quiet()
  await writeFile(path.join(root, ".git/info/exclude"), "\ndeps/\ncache.txt\n", { flag: "a" })
  await mkdir(path.join(root, "deps/pkg"), { recursive: true })
  await writeFile(path.join(root, "deps/pkg/index.js"), "module.exports = 1\n")
  await writeFile(path.join(root, "cache.txt"), "cache v1\n")
  return directory
}

/**
 * A checkout whose ignored directory sits below a tracked one. The journal follows each top-level
 * directory holding an ignored root with a stream of its own, and FSEvents reports a directory made
 * seconds before it is cloned as made again; for a top-level root that ends the stream, and a warm
 * pair made from a checkout that young would be refreshed rather than reused.
 */
async function nestedFixture() {
  const directory = await tmpdir({
    git: true,
    config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
  })
  const root = directory.path
  await mkdir(path.join(root, "pkg/node_modules/dep"), { recursive: true })
  await writeFile(path.join(root, "README.md"), "readme\n")
  await writeFile(path.join(root, "pkg/package.json"), "{}\n")
  await $`git add opencode.json README.md pkg/package.json`.cwd(root).quiet()
  await $`git commit -m "test: first pair fixture"`.cwd(root).quiet()
  await writeFile(path.join(root, ".git/info/exclude"), "\npkg/node_modules/\ncache.txt\n", { flag: "a" })
  await writeFile(path.join(root, "pkg/node_modules/dep/index.js"), "module.exports = 1\n")
  await writeFile(path.join(root, "cache.txt"), "cache v1\n")
  return directory
}

async function openChat(root: string) {
  const source = await json<{ id: string }>(
    await arenaRequest("/session", {
      method: "POST",
      headers: headers(root),
      body: JSON.stringify({ title: "Persistent slots" }),
    }),
  )
  const attached = await json<PublicSnapshot>(
    await arenaRequest(`/arena/sessions/${source.id}`, { headers: headers(root) }),
  )
  return {
    chatID: attached.chat.id,
    sessionID: source.id,
    /** Archived before the checkout is deleted, so no watch outlives the test's directories. */
    archive: () =>
      arenaRequest(`/arena/sessions/${source.id}/archive`, { method: "POST", headers: headers(root) }).catch(
        () => undefined,
      ),
  }
}

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  delete process.env.OPENCODE_ARENA_INITIAL_WARM
  delete process.env.OPENROUTER_API_KEY
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

describe("persistent contestant worktrees", () => {
  test("reuses contestant directories across three turns and starts each turn in exact sync", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    const root = directory.path
    await writeFile(path.join(root, "README.md"), "readme\n")
    await writeFile(path.join(root, "notes.md"), "notes\n")
    await $`git add opencode.json README.md notes.md`.cwd(root).quiet()
    await $`git commit -m "test: configure slot fixture"`.cwd(root).quiet()
    await writeFile(path.join(root, ".git/info/exclude"), "\ndeps/\ncache.txt\ndist/\n", { flag: "a" })
    await mkdir(path.join(root, "deps/pkg"), { recursive: true })
    await writeFile(path.join(root, "deps/pkg/index.js"), "module.exports = 1\n")
    await writeFile(path.join(root, "cache.txt"), "cache v1\n")

    const memory = memoryStore()
    const router = installOpenRouterStub({
      promptCommands: (text) =>
        text.includes("slot turn one")
          ? LEFTOVERS
          : text.includes("slot turn two")
            ? COMMIT
            : text.includes("slot turn three")
              ? CAPTURE
              : undefined,
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    try {
      const source = await json<{ id: string }>(
        await arenaRequest("/session", {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ title: "Persistent slots" }),
        }),
      )
      const attached = await json<PublicSnapshot>(
        await arenaRequest(`/arena/sessions/${source.id}`, { headers: headers(root) }),
      )
      const chatID = attached.chat.id

      // Turn 1: both contestants leave every kind of leftover behind.
      const inodesOfTurn: Record<string, number>[] = []
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "slot turn one",
        beforeVote: async (turnID) => {
          const runs = await memory.store.runsForTurn(turnID)
          inodesOfTurn.push(
            Object.fromEntries(await Promise.all(runs.map(async (run) => [run.side, await inode(run.worktree)]))),
          )
        },
      })
      const turn1Runs = await memory.store.runsForTurn(turn1)
      const loser1 = turn1Runs.find((run) => run.side === "b")!
      const warm1 = await waitForWarmPair(memory.store, turn1, 1)
      const warmDirs1 = [warm1.warmPreparation!.worktrees.a!.directory, warm1.warmPreparation!.worktrees.b!.directory]
      const warmInodes1 = await Promise.all(warmDirs1.map(inode))
      // The loser's directory is the one the next turn reuses, renamed to the next generation.
      expect(warmInodes1).toContain(inodesOfTurn[0]!.b!)
      expect(await exists(loser1.worktree)).toBe(false)
      const canonical1 = await repositoryView(root)
      for (const dir of warmDirs1) {
        expect(await repositoryView(dir)).toEqual(canonical1)
        expect(await exists(path.join(dir, "leftover-generation-1-b.txt"))).toBe(false)
        expect(await exists(path.join(dir, "dist"))).toBe(false)
        expect(await exists(path.join(dir, "deps/pkg/touched.js"))).toBe(false)
        expect(await exists(path.join(dir, "nested"))).toBe(false)
        expect(await exists(path.join(dir, ".agent-duel"))).toBe(false)
        expect(await readFile(path.join(dir, "README.md"), "utf8")).toBe("readme\n")
        expect((await readdir(dir)).includes("notes.md")).toBe(true)
        expect(await readFile(path.join(dir, "cache.txt"), "utf8")).toBe("cache v1\n")
      }

      // Turn 2: the winner commits; the next pair must carry the commit.
      const turn2 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "slot turn two",
        beforeVote: async (turnID) => {
          const runs = await memory.store.runsForTurn(turnID)
          inodesOfTurn.push(
            Object.fromEntries(await Promise.all(runs.map(async (run) => [run.side, await inode(run.worktree)]))),
          )
        },
      })
      expect(Object.values(inodesOfTurn[1]!).toSorted((left, right) => left - right)).toEqual(
        warmInodes1.toSorted((left, right) => left - right),
      )
      const warm2 = await waitForWarmPair(memory.store, turn2, 2)
      const warmDirs2 = [warm2.warmPreparation!.worktrees.a!.directory, warm2.warmPreparation!.worktrees.b!.directory]
      const canonical2 = await repositoryView(root)
      expect(await exists(path.join(root, "committed.txt"))).toBe(true)
      for (const dir of warmDirs2) {
        expect(await repositoryView(dir)).toEqual(canonical2)
        expect(await readFile(path.join(dir, "committed.txt"), "utf8")).toBe("turn two\n")
      }

      // Turn 3: the contestants report what they start from.
      const turn3 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "slot turn three",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            const state = (await readFile(path.join(run.worktree, "state.txt"), "utf8")).split("\n")
            const expectedStatus = canonical2.status.filter(Boolean)
            expect(state[0]).toBe(canonical2.head)
            expect(state[1]).toBe(canonical2.branch)
            expect(state[2]).toBe(expectedStatus.length ? `${expectedStatus.join("|")}|` : "")
            expect(state[3]).toBe("")
            expect(state[4]!.split("|").filter(Boolean).sort()).toEqual(
              canonical2.refs.map((line) => line.split(" ")[0]!).sort(),
            )
            expect(state[4]).not.toContain("extra-generation-1-b")
            expect(state[4]).not.toContain("refs/stash")
            expect(state[5]).toContain("notes.md|")
            expect(state[6]).toBe("index.js|")
            expect(state[7]).toBe("cache v1")
          }
        },
      })
      expect(turn3).toBeTruthy()
      expect(router.calls.size).toBeGreaterThan(0)

      // Archiving takes every worktree the chat kept, free ones and hosts included.
      const archived = await json<PublicSnapshot | null>(
        await arenaRequest(`/arena/sessions/${source.id}/archive`, { method: "POST", headers: headers(root) }),
      )
      expect(archived?.chat.status).toBe("archived")
      const pool = path.dirname(warmDirs2[0]!)
      expect((await readdir(pool).catch(() => [] as string[])).filter((name) => name !== ".trash")).toEqual([])
    } finally {
      router.restore()
    }
  }, 240_000)

  test("writes again a file the previous occupant left clean under its own checkout rules", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    // Git records the CRLF file's stat against the LF blob, so the kept index calls it clean.
    const CRLF = [
      "git config core.autocrlf true",
      "rm README.md",
      "git checkout -- README.md",
      "sleep 1.2",
      "git status --porcelain > /dev/null",
      "git config --unset core.autocrlf",
    ].join(" && ")
    const router = installOpenRouterStub({
      promptCommands: (text) => (text.includes("crlf turn one") ? CRLF : undefined),
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "crlf turn one",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            expect(await readFile(path.join(run.worktree, "README.md"), "utf8")).toBe("readme\r\n")
            expect(await git(run.worktree, ["status", "--porcelain", "--", "README.md"])).toBe("")
          }
        },
      })
      // The first pair adopts the loser; the second, the first turn's winner once it is released.
      const warm1 = await waitForWarmPair(memory.store, turn1, 1)
      const sides1 = [warm1.warmPreparation!.worktrees.a!, warm1.warmPreparation!.worktrees.b!]
      for (const slot of sides1) {
        expect(await readFile(path.join(slot.directory, "README.md"), "utf8")).toBe("readme\n")
        expect(slot.sync?.rewroteAll).toBe(false)
      }
      expect(Math.max(...sides1.map((slot) => slot.sync?.distrusted ?? 0))).toBeGreaterThan(0)

      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "crlf turn two" })
      const warm2 = await waitForWarmPair(memory.store, turn2, 2)
      for (const slot of [warm2.warmPreparation!.worktrees.a!, warm2.warmPreparation!.worktrees.b!]) {
        expect(await readFile(path.join(slot.directory, "README.md"), "utf8")).toBe("readme\n")
      }
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("does not give the next pair a worktree a terminal shell still stands in", async () => {
    await using directory = await fixture()
    await using scratch = await tmpdir()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const fifo = path.join(scratch.path, "typed")
    let shell: ReturnType<typeof Bun.spawn> | undefined
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      let loserInode = 0
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "shell turn one",
        beforeVote: async (turnID) => {
          const loser = (await memory.store.runsForTurn(turnID)).find((run) => run.side === "b")!
          loserInode = await inode(loser.worktree)
          await $`mkfifo ${fifo}`.quiet()
          // What the terminal panel keeps open: a shell with a terminal of its own, which release
          // leaves running. Only builtins, so nothing it starts is a service release would stop.
          shell = Bun.spawn(
            [
              "script",
              "-q",
              "/dev/null",
              "sh",
              "-c",
              `cd '${loser.worktree}' && read line < '${fifo}' && printf 'user typed this\\n' >> README.md && : > typed-by-user.txt`,
            ],
            { cwd: scratch.path, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          )
          await Bun.sleep(500)
        },
      })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const dirs = [warm.warmPreparation!.worktrees.a!.directory, warm.warmPreparation!.worktrees.b!.directory]
      expect(await Promise.all(dirs.map(inode))).not.toContain(loserInode)
      // The user types into the loser's terminal after the vote.
      await Promise.race([writeFile(fifo, "go\n"), Bun.sleep(5_000)])
      await Promise.race([shell!.exited, Bun.sleep(5_000)])
      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "shell turn two" })
      for (const run of await memory.store.runsForTurn(turn2)) {
        expect(await exists(path.join(run.worktree, "typed-by-user.txt"))).toBe(false)
        expect(await readFile(path.join(run.worktree, "README.md"), "utf8")).toBe("readme\n")
      }
    } finally {
      await archive?.()
      shell?.kill()
      router.restore()
    }
  }, 120_000)

  test("refreshes a warm pair something wrote into while it was idle", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "idle turn one" })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const a = warm.warmPreparation!.worktrees.a!.directory
      const b = warm.warmPreparation!.worktrees.b!.directory
      // Past the watch's delivery latency, as an idle window would be.
      await Bun.sleep(1_000)
      await writeFile(path.join(a, "deps/pkg/evil.js"), "evil\n")
      await writeFile(path.join(b, "cache.txt"), "tampered\n")
      await Bun.sleep(1_000)
      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "idle turn two" })
      const timings = (await memory.store.turn(turn2))?.setupTimings
      expect(timings?.warmPath).toBe("refreshed")
      expect(timings?.sides?.a?.syncPath).toBe("refreshed")
      for (const run of await memory.store.runsForTurn(turn2)) {
        expect(await exists(path.join(run.worktree, "deps/pkg/evil.js"))).toBe(false)
        expect(await readFile(path.join(run.worktree, "deps/pkg/index.js"), "utf8")).toBe("module.exports = 1\n")
        expect(await readFile(path.join(run.worktree, "cache.txt"), "utf8")).toBe("cache v1\n")
      }
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("clears what a contestant made beside its worktree, and never takes it for a worktree", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const strays = new Set<number>()
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "stray turn one",
        // What an agent running `git worktree add ../x` leaves: a checkout with a `.git` link,
        // into the contestant's own host, beside its worktree.
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            await $`git worktree add ../stray-${run.side} -b stray-${run.side}`.cwd(run.worktree).quiet()
            const stray = path.join(path.dirname(run.worktree), `stray-${run.side}`)
            await writeFile(path.join(stray, "secret.txt"), `from ${run.side}\n`)
            strays.add(await inode(stray))
          }
        },
      })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      const listing = async () => (await readdir(pool)).filter((name) => name !== ".trash").toSorted()
      expect((await listing()).filter((name) => name.startsWith("stray-"))).toEqual([])
      for (const side of ["a", "b"] as const) {
        expect(strays.has(await inode(warm.warmPreparation!.worktrees[side]!.directory))).toBe(false)
      }

      // After the pair was prepared: the retained winner's agent answering a follow-up, say.
      const [winner] = (await memory.store.runsForTurn(turn1)).filter((run) => run.side === "a")
      await $`git worktree add ../late -b late`.cwd(winner!.worktree).quiet()
      await writeFile(path.join(pool, "note.txt"), "note\n")
      const turn2 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "stray turn two",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            const beside = (await readdir(path.dirname(run.worktree))).filter((name) => name !== ".trash")
            expect(beside.filter((name) => ["late", "note.txt", "stray-a", "stray-b"].includes(name))).toEqual([])
            for (const name of beside) expect(name).toMatch(/^(generation-\d+-[ab]|spare-[0-9a-f]+)(\.git)?$/)
          }
        },
      })
      expect((await memory.store.turn(turn2))?.setupTimings?.warmPath).toBe("reused")
    } finally {
      await archive?.()
      router.restore()
    }
  }, 180_000)

  test("patches the paths either side wrote under a root", async () => {
    // Nested, so the journal's stream sits above the root and covers it from the first pair on.
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "patch turn one" })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const slots = { a: warm.warmPreparation!.worktrees.a!.directory, b: warm.warmPreparation!.worktrees.b!.directory }
      const roots = {
        a: await inode(path.join(slots.a, "pkg/node_modules")),
        b: await inode(path.join(slots.b, "pkg/node_modules")),
      }
      // Past the watches' delivery latency, as an idle window would be.
      await Bun.sleep(1_000)
      await writeFile(path.join(root, "pkg/node_modules/dep/index.js"), "module.exports = 2\n")
      await mkdir(path.join(root, "pkg/node_modules/added"), { recursive: true })
      await writeFile(path.join(root, "pkg/node_modules/added/index.js"), "added\n")
      await writeFile(path.join(slots.a, "pkg/node_modules/dep/evil.js"), "evil\n")
      // A new child of the root itself moves the root's own identity; its watch names the child.
      await mkdir(path.join(slots.b, "pkg/node_modules/.cache"), { recursive: true })
      await writeFile(path.join(slots.b, "pkg/node_modules/.cache/build.bin"), "cache\n")
      await rm(path.join(slots.b, "pkg/node_modules/dep/index.js"))
      await Bun.sleep(1_000)

      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "patch turn two" })
      const timings = (await memory.store.turn(turn2))?.setupTimings
      expect(timings?.warmPath).toBe("refreshed")
      // Each contestant's own writes under the root are undone along with what the checkout wrote.
      expect(timings?.sides?.a).toMatchObject({ syncPath: "refreshed", patched: 1, recloned: 0 })
      expect(timings?.sides?.b).toMatchObject({ syncPath: "refreshed", patched: 1, recloned: 0 })
      for (const run of await memory.store.runsForTurn(turn2)) {
        expect(run.worktree).toBe(slots[run.side])
        expect(await inode(path.join(run.worktree, "pkg/node_modules"))).toBe(roots[run.side])
        expect(await readFile(path.join(run.worktree, "pkg/node_modules/dep/index.js"), "utf8")).toBe(
          "module.exports = 2\n",
        )
        expect(await readFile(path.join(run.worktree, "pkg/node_modules/added/index.js"), "utf8")).toBe("added\n")
        expect(await exists(path.join(run.worktree, "pkg/node_modules/dep/evil.js"))).toBe(false)
        expect(await exists(path.join(run.worktree, "pkg/node_modules/.cache"))).toBe(false)
      }
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("refreshes changed ignored content before gated tools run and discards stale roots", async () => {
    await using directory = await fixture()
    const root = directory.path
    await writeFile(path.join(root, ".git/info/exclude"), "stale/\n", { flag: "a" })
    const memory = memoryStore()
    const coldCapture = "cat deps/pkg/index.js > cold-deps.txt && cat cache.txt > cold-cache.txt"
    const warmCapture = [
      "cat deps/pkg/index.js > warm-deps.txt",
      "cat cache.txt > warm-cache.txt",
      "if [ -e stale ]; then printf 'present\\n' > warm-stale.txt; else printf 'absent\\n' > warm-stale.txt; fi",
    ].join(" && ")
    const router = installOpenRouterStub({
      promptCommands: (text) =>
        text.includes("combined cold") ? coldCapture : text.includes("combined refreshed") ? warmCapture : undefined,
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "combined cold",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            expect(await readFile(path.join(run.worktree, "cold-deps.txt"), "utf8")).toBe("module.exports = 1\n")
            expect(await readFile(path.join(run.worktree, "cold-cache.txt"), "utf8")).toBe("cache v1\n")
          }
        },
      })

      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const warmSlots = {
        a: warm.warmPreparation!.worktrees.a!,
        b: warm.warmPreparation!.worktrees.b!,
      }
      const warmInodes = {
        a: await inode(warmSlots.a.directory),
        b: await inode(warmSlots.b.directory),
      }
      await writeFile(path.join(root, "deps/pkg/index.js"), "module.exports = 2\n")
      await writeFile(path.join(root, "cache.txt"), "cache v2\n")
      await mkdir(path.join(warmSlots.a.directory, "stale"), { recursive: true })
      await writeFile(path.join(warmSlots.a.directory, "stale/old.txt"), "stale\n")

      const turn2 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "combined refreshed",
        beforeVote: async (turnID) => {
          expect((await memory.store.turn(turn1))?.warmPreparation?.state).toBe("ready")
          for (const run of await memory.store.runsForTurn(turnID)) {
            const side = run.side
            expect(run.worktree).toBe(warmSlots[side].directory)
            expect(await inode(run.worktree)).toBe(warmInodes[side])
            expect(await readFile(path.join(run.worktree, "warm-deps.txt"), "utf8")).toBe("module.exports = 2\n")
            expect(await readFile(path.join(run.worktree, "warm-cache.txt"), "utf8")).toBe("cache v2\n")
            expect(await readFile(path.join(run.worktree, "warm-stale.txt"), "utf8")).toBe("absent\n")
            expect(await exists(path.join(run.worktree, "stale"))).toBe(false)
          }
        },
      })
      const timings = (await memory.store.turn(turn2))?.setupTimings
      expect(timings?.warmPath).toBe("refreshed")
      expect([timings?.sides?.a?.syncPath, timings?.sides?.b?.syncPath]).toEqual(["refreshed", "refreshed"])
      expect([timings?.sides?.a?.forkedAtWarmup, timings?.sides?.b?.forkedAtWarmup]).toEqual([true, true])
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("starts the cold model before ignored sync and gates its first tool", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub({
      promptCommands: (text) => (text.includes("gated cold") ? "printf 'ran\\n' > gated-executed.txt" : undefined),
    })
    const held = holdIgnoredResync()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chat.chatID}/turns`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ prompt: "gated cold" }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return the admitted turn")
      await held.entered
      await waitForCondition(
        async () => router.contestantRequests.length > 0,
        "contestant model request did not start while ignored sync was held",
      )
      const runs = await memory.store.runsForTurn(turnID)
      expect(runs).toHaveLength(2)
      for (const run of runs) expect(await exists(path.join(run.worktree, "gated-executed.txt"))).toBe(false)

      held.release()
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      for (const run of await memory.store.runsForTurn(turnID)) {
        expect(await readFile(path.join(run.worktree, "gated-executed.txt"), "utf8")).toBe("ran\n")
      }
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
    } finally {
      held.release()
      await archive?.()
      held.spy.mockRestore()
      router.restore()
    }
  }, 120_000)

  test("finishes a tool-free model before ignored sync but waits to finalize", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub({ emptyOrdinals: [1, 2] })
    const held = holdIgnoredResync()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chat.chatID}/turns`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ prompt: "tool-free cold" }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not return the admitted turn")
      await held.entered
      await waitForCondition(async () => {
        const runs = await memory.store.runsForTurn(turnID)
        return runs.length === 2 && runs.every((run) => run.completedAt !== undefined)
      }, "tool-free contestants did not complete while ignored sync was held")
      const runs = await memory.store.runsForTurn(turnID)
      expect(runs.every((run) => run.completedAt !== undefined)).toBe(true)
      expect(runs.every((run) => run.finalizedAt === undefined)).toBe(true)

      held.release()
      await waitForTurn(memory.store, turnID, "awaiting_vote")
      const finalizedRuns = await memory.store.runsForTurn(turnID)
      expect(finalizedRuns.every((run) => run.finalizedAt !== undefined)).toBe(true)
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(memory.store, turnID, "complete")
    } finally {
      held.release()
      await archive?.()
      held.spy.mockRestore()
      router.restore()
    }
  }, 120_000)

  test("refreshes a warm pair whose hosts miss a hook the checkout gained", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "hook turn one" })
      await waitForWarmPair(memory.store, turn1, 1)
      const hook = path.join(root, ".git/hooks/pre-commit")
      await writeFile(hook, "#!/bin/sh\nexit 0\n")
      await chmod(hook, 0o755)
      const turn2 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "hook turn two",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            expect(await exists(path.join(hostRepoPath(run.worktree), "hooks/pre-commit"))).toBe(true)
          }
        },
      })
      expect((await memory.store.turn(turn2))?.setupTimings?.warmPath).toBe("refreshed")
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("leaves a dependency folder a contestant installs out of the vote, and keeps one the base holds", async () => {
    await using directory = await fixture()
    const root = directory.path
    // Ignored only at the root, as in the project whose battle counted qa/node_modules.
    await writeFile(path.join(root, ".gitignore"), "/node_modules\n")
    await $`git add .gitignore`.cwd(root).quiet()
    await $`git commit -qm "test: ignore the root node_modules"`.cwd(root).quiet()
    // Untracked and not ignored, so the frozen base carries it and each contestant must too.
    await mkdir(path.join(root, "src/__pycache__"), { recursive: true })
    await writeFile(path.join(root, "src/__pycache__/app.pyc"), "bytecode\n")
    const memory = memoryStore()
    const INSTALL = [
      "mkdir -p qa/node_modules/tool",
      "printf 'tool\\n' > qa/node_modules/tool/index.js",
      "printf 'answer\\n' > answer.txt",
    ].join(" && ")
    const router = installOpenRouterStub({
      promptCommands: (text) => (text.includes("install a tool") ? INSTALL : undefined),
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const turn = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "install a tool" })
      expect(await readFile(path.join(root, "answer.txt"), "utf8")).toBe("answer\n")
      expect(await exists(path.join(root, "qa"))).toBe(false)
      expect(await readFile(path.join(root, "src/__pycache__/app.pyc"), "utf8")).toBe("bytecode\n")
      // The loser's slot still holds the tool, now ignored, so `clean -fd` keeps it: the ignored
      // resync has to clear it for the next pair.
      const warm = await waitForWarmPair(memory.store, turn, 1)
      for (const side of [warm.warmPreparation!.worktrees.a!, warm.warmPreparation!.worktrees.b!]) {
        expect(await exists(path.join(side.directory, "qa"))).toBe(false)
        expect(await readFile(path.join(side.directory, "src/__pycache__/app.pyc"), "utf8")).toBe("bytecode\n")
      }
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("refreshes a warm pair when the checkout's stash changed", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "stash turn one" })
      await waitForWarmPair(memory.store, turn1, 1)
      // The stash leaves HEAD, the index and the files as they were, so only the stash differs.
      const tracked = (await $`git ls-files`.cwd(root).quiet().text()).split("\n")[0]!
      await writeFile(path.join(root, tracked), "stashed edit\n")
      await $`git -c user.name=Test -c user.email=test@example.com stash`.cwd(root).quiet()
      const turn2 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "stash turn two",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            expect((await $`git stash list`.cwd(run.worktree).quiet().text()).trim()).not.toBe("")
          }
        },
      })
      expect((await memory.store.turn(turn2))?.setupTimings?.warmPath).toBe("refreshed")
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("evicting a checkout retires every worktree its chats kept", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "evict turn one" })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      const updatedAt = (await memory.store.chat(chatID))!.updatedAt
      const prepared = await arenaRequest("/arena/checkout/prepare", {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ root }),
      })
      expect(prepared.status).toBe(204)
      expect((await readdir(pool).catch(() => [] as string[])).filter((name) => name !== ".trash")).toEqual([])
      const evicted = await memory.store.chat(chatID)
      expect(evicted?.checkoutEvicted).toBe(true)
      // Eviction is no work in the chat: a restart re-warms the chat updated last.
      expect(evicted?.updatedAt).toEqual(updatedAt)

      const released = await arenaRequest("/arena/checkout/release", {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ root }),
      })
      expect(released.status).toBe(204)
      const restored = await memory.store.chat(chatID)
      expect(restored?.checkoutEvicted).toBeUndefined()
      expect(restored?.updatedAt).toEqual(updatedAt)
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("gives both contestants the prompt's image and attachments, and lists them on the turn", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    await using uploads = await tmpdir()
    const uploadDirectory = path.join(uploads.path, "upload_1")
    const router = installOpenRouterStub({
      // Each contestant opens the upload with its own tools, as a single agent would.
      promptCommands: (text) =>
        text.includes("Match the screenshot") ? `cat ${path.join(uploadDirectory, "notes.txt")}` : undefined,
    })
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
      await mkdir(uploadDirectory, { recursive: true })
      await writeFile(path.join(uploadDirectory, "notes.txt"), "beans\n")
      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chat.chatID}/turns`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({
            prompt: "Match the screenshot",
            attachments: [
              { type: "image", mimeType: "image/png", data: pixel },
              { type: "text", label: "Review comment", text: "Browser element: <div class='hero'>" },
              {
                type: "file",
                path: path.join(uploadDirectory, "notes.txt"),
                name: "notes.txt",
                mimeType: "text/plain",
                size: 6,
              },
            ],
          }),
        }),
      )
      const turnID = admitted.turn!.id
      await waitForTurn(memory.store, turnID, "awaiting_vote")

      const snapshot = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chat.chatID}`, { headers: headers(root) }),
      )
      expect((snapshot.turn as { attachments?: unknown } | undefined)?.attachments).toEqual([
        { kind: "image", label: "Image 1" },
        { kind: "text", label: "Review comment" },
        { kind: "file", label: "notes.txt" },
      ])
      const first = router.contestantRequests.filter((request) =>
        JSON.stringify(request.messages).includes("Match the screenshot"),
      )
      const models = new Set(first.map((request) => request.model))
      expect(models.size).toBe(2)
      for (const model of models) {
        const request = JSON.stringify(first.find((candidate) => candidate.model === model))
        expect(request).toContain(`data:image/png;base64,${pixel}`)
        expect(request).toContain("Browser element: <div class='hero'>")
        expect(request).toContain(`Uploaded file: notes.txt\\nPath: ${path.join(uploadDirectory, "notes.txt")}`)
      }
      for (const model of models) {
        const read = router.contestantRequests.filter(
          (request) => request.model === model && JSON.stringify(request.messages).includes("beans"),
        )
        expect(read.length).toBeGreaterThan(0)
      }
      for (const run of await memory.store.runsForTurn(turnID)) {
        const session = await json<{ permission?: unknown[] }>(
          await arenaRequest(`/session/${run.rootSessionID}`, { headers: headers(root) }),
        )
        expect(session.permission?.at(-1)).toEqual({
          permission: "external_directory",
          pattern: `${uploadDirectory}/*`,
          action: "allow",
        })
      }

      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/reply`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({
            prompt: "Now the footer",
            target: "both",
            attachments: [{ type: "image", mimeType: "image/png", data: pixel }],
          }),
        }),
      )
      await waitForTurn(memory.store, turnID, "awaiting_vote", () =>
        router.contestantRequests.some((request) => JSON.stringify(request.messages).includes("Now the footer")),
      )
      const replies = router.contestantRequests.filter((request) =>
        JSON.stringify(request.messages).includes("Now the footer"),
      )
      expect(new Set(replies.map((request) => request.model))).toEqual(models)
      for (const request of replies) {
        expect(JSON.stringify(request.messages).split(`data:image/png;base64,${pixel}`).length - 1).toBe(2)
      }
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("removes the snapshot repository of a worktree that moved to the next turn's path", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      let worktrees: { a: string; b: string } | undefined
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID: chat.chatID,
        prompt: "snapshot turn one",
        beforeVote: async (turnID) => {
          const runs = await memory.store.runsForTurn(turnID)
          const side = (name: "a" | "b") => runs.find((run) => run.side === name)!.worktree
          worktrees = { a: side("a"), b: side("b") }
          for (const worktree of Object.values(worktrees)) {
            expect(await snapshotRepositories(worktree)).toHaveLength(1)
          }
        },
      })
      await waitForWarmPair(memory.store, turn1, 1)
      // The loser's worktree became one of the next pair; the retained winner keeps its path.
      await waitForCondition(
        async () => (await snapshotRepositories(worktrees!.b)).length === 0,
        "the released side's snapshot repository was not removed",
      )
      expect(await exists(worktrees!.b)).toBe(false)
      expect(await snapshotRepositories(worktrees!.a)).toHaveLength(1)
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("releases the worktrees of chats past the limit, and such a chat's next send builds a pair", async () => {
    await using older = await fixture()
    await using newer = await fixture()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    const archives: Array<() => Promise<unknown>> = []
    try {
      const pools: string[] = []
      const chats: string[] = []
      for (const directory of [older, newer]) {
        const chat = await openChat(directory.path)
        archives.push(chat.archive)
        chats.push(chat.chatID)
        const turn = await battle({
          store: memory.store,
          directory: directory.path,
          chatID: chat.chatID,
          prompt: "trim",
        })
        const warm = await waitForWarmPair(memory.store, turn, 1)
        pools.push(path.dirname(warm.warmPreparation!.worktrees.a!.directory))
      }

      // A full disk elsewhere is not freed by releasing these: `/dev` is its own volume.
      const elsewhere = await json<{ chats: number; released: number; kept: number }>(
        await arenaRequest("/arena/environments/trim", {
          method: "POST",
          headers: headers(newer.path),
          body: JSON.stringify({ keep: 0, volumeOf: "/dev" }),
        }),
      )
      expect(elsewhere).toEqual({ chats: 0, released: 0, kept: 0 })
      expect((await poolWorktrees(pools[0]!)).length).toBeGreaterThanOrEqual(3)
      const updatedAt = (await memory.store.chat(chats[0]!))!.updatedAt
      // What the retained winner's shell left in its temp directory goes with its worktree.
      const winner = await memory.store.run((await memory.store.chat(chats[0]!))!.retainedWinner!.runID)
      const tmp = ArenaContestant.tmpDirectory(winner!.rootSessionID)
      await mkdir(tmp, { recursive: true })
      await writeFile(path.join(tmp, "scratch.txt"), "left by the winner\n")

      const trimmed = await json<{ chats: number; released: number; kept: number }>(
        await arenaRequest("/arena/environments/trim", {
          method: "POST",
          headers: headers(newer.path),
          body: JSON.stringify({ keep: 1, volumeOf: older.path }),
        }),
      )

      expect(trimmed).toEqual({ chats: 2, released: 1, kept: 0 })
      expect(await exists(pools[0]!)).toBe(false)
      expect((await poolWorktrees(pools[1]!)).length).toBeGreaterThanOrEqual(3)
      const released = await memory.store.chat(chats[0]!)
      expect(released?.status).toBe("ready")
      expect(released?.retainedWinner).toBeUndefined()
      expect(released?.warmGeneration).toBeUndefined()
      // A release is no work in the chat: a restart re-warms the chat updated last.
      expect(released?.updatedAt).toEqual(updatedAt)
      expect(await exists(tmp)).toBe(false)
      expect((await memory.store.turnsForChat(chats[0]!)).some((turn) => turn.warmPreparation)).toBe(false)
      expect((await memory.store.runsForChat(chats[0]!)).every((run) => run.worktreeRemovedAt)).toBe(true)

      await battle({ store: memory.store, directory: older.path, chatID: chats[0]!, prompt: "after release" })
      expect(await poolWorktrees(pools[0]!)).toEqual(expect.arrayContaining(["generation-2-a", "generation-2-b"]))
    } finally {
      for (const archive of archives) await archive()
      router.restore()
    }
  }, 180_000)

  test("keeps a chat whole while a terminal is open in one of its worktrees, servers included", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    const spawned: number[] = []
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const turn = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "protected" })
      await waitForWarmPair(memory.store, turn, 1)
      const retained = await memory.store.run((await memory.store.chat(chat.chatID))!.retainedWinner!.runID)
      const worktree = retained!.worktree
      // `script` gives its child a terminal of its own: the shape of a shell someone opened there.
      const session = spawnProcess("script", ["-q", "/dev/null", "sleep", "60"], {
        cwd: worktree,
        detached: true,
        stdio: "ignore",
      })
      const server = spawnProcess("sleep", ["61"], { cwd: worktree, detached: true, stdio: "ignore" })
      spawned.push(session.pid!, server.pid!)
      let shell = ""
      await waitForCondition(async () => {
        shell = (await $`pgrep -P ${String(session.pid)}`.quiet().nothrow().text()).trim()
        return shell !== ""
      }, "the terminal session did not start")
      spawned.push(Number(shell))

      const trimmed = await json<{ chats: number; released: number; kept: number }>(
        await arenaRequest("/arena/environments/trim", {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ keep: 0 }),
        }),
      )

      expect(trimmed).toEqual({ chats: 1, released: 0, kept: 1 })
      expect(await exists(worktree)).toBe(true)
      // Checked before anything was stopped: the server beside the terminal still runs.
      expect(() => process.kill(server.pid!, 0)).not.toThrow()
      expect((await memory.store.chat(chat.chatID))?.retainedWinner).toBeDefined()
    } finally {
      for (const pid of spawned) killQuietly(pid)
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("keeps the worktrees of the chat the app shows, and releases them once it stops", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const turn = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "watched" })
      const warm = await waitForWarmPair(memory.store, turn, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      const trim = () =>
        arenaRequest("/arena/environments/trim", {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ keep: 0 }),
        }).then((response) => json<{ chats: number; released: number; kept: number }>(response))
      // The app streams the chat it shows; the first frame means the stream has started.
      const stream = await arenaRequest(`/arena/sessions/${chat.sessionID}/stream`, { headers: headers(root) })
      reader = stream.body!.getReader()
      await reader.read()

      expect(await trim()).toEqual({ chats: 1, released: 0, kept: 1 })
      expect((await poolWorktrees(pool)).length).toBeGreaterThanOrEqual(3)
      expect((await memory.store.chat(chat.chatID))?.retainedWinner).toBeDefined()

      await reader.cancel()
      reader = undefined
      await waitForCondition(
        async () => (await trim()).released === 1,
        "the chat kept its worktrees after the app stopped showing it",
      )
      expect(await exists(pool)).toBe(false)
    } finally {
      await reader?.cancel()
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("lets a send start while a released chat's worktrees are still being deleted", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    let stuck: string | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const turn = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "slow delete" })
      const warm = await waitForWarmPair(memory.store, turn, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      // A tree in the trash that cannot be deleted keeps the release waiting for the trash to empty.
      stuck = path.join(pool, ".trash", "stuck", "locked")
      await mkdir(stuck, { recursive: true })
      await writeFile(path.join(stuck, "file"), "locked\n")
      await chmod(stuck, 0o555)

      let trimDone = false
      const trimming = arenaRequest("/arena/environments/trim", {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ keep: 0 }),
      })
        .then((response) => json<{ chats: number; released: number; kept: number }>(response))
        .finally(() => {
          trimDone = true
        })
      await waitForCondition(
        async () => (await memory.store.chat(chat.chatID))?.retainedWinner === undefined,
        "the chat's worktrees were not released",
      )

      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chat.chatID}/turns`, {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ prompt: "during the delete" }),
        }),
      )

      expect(admitted.turn?.id).toBeDefined()
      expect(trimDone).toBe(false)
      expect(await trimming).toEqual({ chats: 1, released: 1, kept: 0 })
      await waitForTurn(memory.store, admitted.turn!.id, "awaiting_vote")
    } finally {
      if (stuck) await chmod(stuck, 0o755).catch(() => undefined)
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("stops a server the retained winner left running and releases the chat", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    let server: ReturnType<typeof spawnProcess> | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const turn = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "preview" })
      await waitForWarmPair(memory.store, turn, 1)
      const retained = await memory.store.run((await memory.store.chat(chat.chatID))!.retainedWinner!.runID)
      // A preview the winner started in the background, in a process group of its own.
      server = spawnProcess("sleep", ["60"], { cwd: retained!.worktree, detached: true, stdio: "ignore" })

      const trimmed = await json<{ chats: number; released: number; kept: number }>(
        await arenaRequest("/arena/environments/trim", {
          method: "POST",
          headers: headers(root),
          body: JSON.stringify({ keep: 0 }),
        }),
      )

      expect(trimmed).toEqual({ chats: 1, released: 1, kept: 0 })
      expect(await exists(retained!.worktree)).toBe(false)
      await waitForCondition(async () => {
        try {
          process.kill(server!.pid!, 0)
          return false
        } catch {
          return true
        }
      }, "the winner's server is still running")
    } finally {
      if (server?.pid) killQuietly(server.pid)
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("archiving a chat deletes its worktrees before it responds", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    try {
      const chat = await openChat(root)
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID: chat.chatID,
        prompt: "archive turn one",
      })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      // Enough files that a delete left running in the background is still going when we look.
      const bulk = path.join(warm.warmPreparation!.worktrees.a!.directory, "bulk")
      await mkdir(bulk, { recursive: true })
      await Promise.all(Array.from({ length: 3000 }, (_, index) => writeFile(path.join(bulk, `${index}`), "x")))

      await chat.archive()

      expect(await exists(pool)).toBe(false)
    } finally {
      router.restore()
    }
  }, 120_000)

  test("clears at startup what an archive a stopped process did not finish left in the pool", async () => {
    await using directory = await fixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENROUTER_API_KEY = "test-openrouter-key"
    setStoreForTest(memory.store)
    try {
      const chat = await openChat(root)
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID: chat.chatID,
        prompt: "archive turn one",
      })
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      const pool = path.dirname(warm.warmPreparation!.worktrees.a!.directory)
      await chat.archive()
      // What a process stopped halfway through the archive leaves: a worktree, its host, and trash.
      const left = path.join(pool, "generation-7-a")
      await mkdir(left, { recursive: true })
      await writeFile(path.join(left, ".git"), `gitdir: ${hostRepoPath(left)}\n`)
      await mkdir(hostRepoPath(left), { recursive: true })
      await mkdir(path.join(pool, ".trash", "half-deleted"), { recursive: true })
      await writeFile(path.join(pool, ".trash", "half-deleted", "file"), "left\n")
      setStoreForTest(memory.restart())
      await arenaRequest(`/arena/chats/${chat.chatID}`, { headers: headers(root) })
      const deadline = Date.now() + 20_000
      let remaining = await readdir(pool).catch(() => [] as string[])
      let trash = await readdir(path.join(pool, ".trash")).catch(() => [] as string[])
      while ((remaining.some((name) => name !== ".trash") || trash.length > 0) && Date.now() < deadline) {
        await Bun.sleep(200)
        remaining = await readdir(pool).catch(() => [] as string[])
        trash = await readdir(path.join(pool, ".trash")).catch(() => [] as string[])
      }
      expect(remaining.filter((name) => name !== ".trash")).toEqual([])
      expect(trash).toEqual([])
    } finally {
      router.restore()
    }
  }, 120_000)

  test("keeps worktrees on a reftable checkout, whose hosts carry Arena's refs", async () => {
    await using directory = await fixture({ reftable: true })
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const turn1 = await battle({ store: memory.store, directory: root, chatID, prompt: "reftable turn one" })
      expect(await git(root, ["for-each-ref", "--format=%(refname)", "refs/battles/"])).not.toBe("")
      const warm = await waitForWarmPair(memory.store, turn1, 1)
      for (const slot of [warm.warmPreparation!.worktrees.a!, warm.warmPreparation!.worktrees.b!]) {
        expect(await git(slot.directory, ["for-each-ref", "--format=%(refname)", "refs/battles/"])).toBe("")
      }
      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "reftable turn two" })
      expect((await memory.store.turn(turn2))?.setupTimings?.warmPath).not.toBe("cold")
      await waitForWarmPair(memory.store, turn2, 2)
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("prepares the first pair when a chat is opened, and the first send takes it as it stands", async () => {
    process.env.OPENCODE_ARENA_INITIAL_WARM = "1"
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub({
      promptCommands: (text) =>
        text.includes("first pair turn one")
          ? "printf 'one\\n' > leftover-one.txt && printf 'touched\\n' > pkg/node_modules/dep/touched.js"
          : text.includes("first pair turn two")
            ? COMMIT
            : text.includes("first pair turn three")
              ? CAPTURE
              : undefined,
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const warm0 = await waitForInitialWarmPair(memory.store, chatID)
      expect(warm0.generation).toBe(0)
      const dirs0 = [warm0.worktrees.a!.directory, warm0.worktrees.b!.directory]
      const canonical0 = await repositoryView(root)
      for (const dir of dirs0) {
        expect(await repositoryView(dir)).toEqual(canonical0)
        expect(await readFile(path.join(dir, "pkg/node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1\n")
        expect(await readFile(path.join(dir, "cache.txt"), "utf8")).toBe("cache v1\n")
      }
      // Until a turn holds it, the app reads the pair from the chat.
      const opened = await json<{ readonly environment?: { readonly warmPair?: Record<string, unknown> } }>(
        await arenaRequest(`/arena/chats/${chatID}`, { headers: headers(root) }),
      )
      expect(opened.environment?.warmPair).toMatchObject({ generation: 0, state: "ready" })
      // The user takes a moment over the prompt.
      await Bun.sleep(1_000)

      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "first pair turn one",
        beforeVote: async (turnID) => {
          const runs = await memory.store.runsForTurn(turnID)
          const byPath = (left: string, right: string) => left.localeCompare(right)
          expect(runs.map((run) => run.worktree).toSorted(byPath)).toEqual(dirs0.toSorted(byPath))
        },
      })
      const timings1 = (await memory.store.turn(turn1))?.setupTimings
      expect(timings1?.warmPath).toBe("reused")
      expect([timings1?.sides?.a?.syncPath, timings1?.sides?.b?.syncPath]).toEqual(["reused", "reused"])
      // The sessions forked at warm-up are the contestants' own.
      expect([timings1?.sides?.a?.forkedAtWarmup, timings1?.sides?.b?.forkedAtWarmup]).toEqual([true, true])
      // The turn owns the pair now; the chat keeps none of its own.
      expect((await memory.store.chat(chatID))?.initialWarmPreparation).toBeUndefined()

      // The first vote's spare still brings the pool to three: the next pair adopts the loser and
      // the spare, while the winner keeps its worktree until the next send.
      const warm1 = await waitForWarmPair(memory.store, turn1, 1)
      const sides1 = [warm1.warmPreparation!.worktrees.a!, warm1.warmPreparation!.worktrees.b!]
      expect(sides1.map((slot) => slot.sync?.syncPath)).toEqual(["adopted", "adopted"])
      expect(await poolWorktrees(path.dirname(dirs0[0]))).toHaveLength(3)
      const canonical1 = await repositoryView(root)
      for (const slot of sides1) {
        expect(await repositoryView(slot.directory)).toEqual(canonical1)
        expect(await exists(path.join(slot.directory, "pkg/node_modules/dep/touched.js"))).toBe(false)
      }

      const turn2 = await battle({ store: memory.store, directory: root, chatID, prompt: "first pair turn two" })
      expect((await memory.store.turn(turn2))?.setupTimings?.warmPath).not.toBe("cold")
      expect(await readFile(path.join(root, "committed.txt"), "utf8")).toBe("turn two\n")
      await waitForWarmPair(memory.store, turn2, 2)
      const canonical2 = await repositoryView(root)
      const turn3 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "first pair turn three",
        beforeVote: async (turnID) => {
          for (const run of await memory.store.runsForTurn(turnID)) {
            const state = (await readFile(path.join(run.worktree, "state.txt"), "utf8")).split("\n")
            const expectedStatus = canonical2.status.filter(Boolean)
            expect(state[0]).toBe(canonical2.head)
            expect(state[1]).toBe(canonical2.branch)
            expect(state[2]).toBe(expectedStatus.length ? `${expectedStatus.join("|")}|` : "")
            expect(state[3]).toBe("")
            expect(state[7]).toBe("cache v1")
          }
        },
      })
      expect((await memory.store.turn(turn3))?.setupTimings?.warmPath).not.toBe("cold")
    } finally {
      await archive?.()
      router.restore()
    }
  }, 240_000)

  test("builds the first pair at the send unless preparing it on open is switched on", async () => {
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      // Past the pause after which the pair would be prepared.
      await Bun.sleep(2_500)
      expect((await memory.store.chat(chat.chatID))?.initialWarmPreparation).toBeUndefined()
      expect(await readdir(isolatedRoot(root)).catch(() => [] as string[])).toEqual([])
      const turn1 = await battle({ store: memory.store, directory: root, chatID: chat.chatID, prompt: "off turn one" })
      const timings = (await memory.store.turn(turn1))?.setupTimings
      expect(timings?.warmPath).toBe("cold")
      expect([timings?.sides?.a?.syncPath, timings?.sides?.b?.syncPath]).toEqual(["created", "created"])
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("archiving a chat just opened removes its first pair, whatever stage the pair reached", async () => {
    process.env.OPENCODE_ARENA_INITIAL_WARM = "1"
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const archive = async (sessionID: string) =>
      json<PublicSnapshot | null>(
        await arenaRequest(`/arena/sessions/${sessionID}/archive`, { method: "POST", headers: headers(root) }),
      )
    /** Worktrees and hosts in every chat's directory, so a chat's pool is covered without its path. */
    const leftInPools = async () => {
      const pools = await readdir(isolatedRoot(root)).catch(() => [] as string[])
      const entries = await Promise.all(
        pools
          .filter((name) => name !== ".trash")
          .map(async (name) =>
            (await readdir(path.join(isolatedRoot(root), name)).catch(() => [] as string[]))
              .filter((entry) => entry !== ".trash")
              .map((entry) => `${name}/${entry}`),
          ),
      )
      return entries.flat()
    }
    try {
      // Ready: archive takes both worktrees, their hosts and the chat's record.
      const ready = await openChat(root)
      const warm = await waitForInitialWarmPair(memory.store, ready.chatID)
      expect(await poolWorktrees(path.dirname(warm.worktrees.a!.directory))).toHaveLength(2)
      expect((await archive(ready.sessionID))?.chat.status).toBe("archived")
      expect(await leftInPools()).toEqual([])
      expect((await memory.store.chat(ready.chatID))?.initialWarmPreparation).toBeUndefined()

      // Still being prepared: archive waits for the pair, then takes it.
      const preparing = await openChat(root)
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if ((await memory.store.chat(preparing.chatID))?.initialWarmPreparation) break
        await Bun.sleep(10)
      }
      expect((await memory.store.chat(preparing.chatID))?.initialWarmPreparation?.state).toBe("pending")
      expect((await archive(preparing.sessionID))?.chat.status).toBe("archived")
      expect(await leftInPools()).toEqual([])
      expect((await memory.store.chat(preparing.chatID))?.initialWarmPreparation).toBeUndefined()

      // Not yet begun: the pair is never made for a chat that is gone.
      const early = await openChat(root)
      expect((await archive(early.sessionID))?.chat.status).toBe("archived")
      await Bun.sleep(2_500)
      expect(await leftInPools()).toEqual([])
      expect((await memory.store.chat(early.chatID))?.initialWarmPreparation).toBeUndefined()
    } finally {
      router.restore()
    }
  }, 120_000)

  test("refreshes the first pair in place when the checkout moved on after it was prepared", async () => {
    process.env.OPENCODE_ARENA_INITIAL_WARM = "1"
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub({
      promptCommands: (text) => (text.includes("moved first pair") ? CAPTURE : undefined),
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      const chatID = chat.chatID
      const warm0 = await waitForInitialWarmPair(memory.store, chatID)
      const dirs0 = [warm0.worktrees.a!.directory, warm0.worktrees.b!.directory]
      // A commit and an ignored file, both after the pair was synced.
      await writeFile(path.join(root, "moved.txt"), "moved\n")
      await $`git add moved.txt`.cwd(root).quiet()
      await $`git commit -qm "test: move the checkout on"`.cwd(root).quiet()
      await writeFile(path.join(root, "cache.txt"), "cache v2\n")
      const canonical = await repositoryView(root)
      const turn1 = await battle({
        store: memory.store,
        directory: root,
        chatID,
        prompt: "moved first pair",
        beforeVote: async (turnID) => {
          const runs = await memory.store.runsForTurn(turnID)
          const byPath = (left: string, right: string) => left.localeCompare(right)
          expect(runs.map((run) => run.worktree).toSorted(byPath)).toEqual(dirs0.toSorted(byPath))
          for (const run of runs) {
            const state = (await readFile(path.join(run.worktree, "state.txt"), "utf8")).split("\n")
            const expectedStatus = canonical.status.filter(Boolean)
            expect(state[0]).toBe(canonical.head)
            expect(state[1]).toBe(canonical.branch)
            expect(state[2]).toBe(expectedStatus.length ? `${expectedStatus.join("|")}|` : "")
            expect(state[7]).toBe("cache v2")
          }
        },
      })
      const timings = (await memory.store.turn(turn1))?.setupTimings
      expect(timings?.warmPath).toBe("refreshed")
      expect([timings?.sides?.a?.syncPath, timings?.sides?.b?.syncPath]).toEqual(["refreshed", "refreshed"])
      // The refresh wrote its progress to the chat's record; the send still leaves none behind.
      expect((await memory.store.chat(chatID))?.initialWarmPreparation).toBeUndefined()
    } finally {
      await archive?.()
      router.restore()
    }
  }, 120_000)

  test("does not prepare the first pair while the chat's agent is working", async () => {
    process.env.OPENCODE_ARENA_INITIAL_WARM = "1"
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    // The agent's model answers slowly, so its prompt outlasts the pause before a pair is prepared.
    const router = installOpenRouterStub({ delayedOrdinal: 1, delayMs: 2_000 })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const source = await json<{ id: string }>(
      await arenaRequest("/session", {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({
          title: "First pair and a working agent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      }),
    )
    const open = () => arenaRequest(`/arena/sessions/${source.id}`, { headers: headers(root) })
    try {
      const opened = await json<PublicSnapshot>(await open())
      const chatID = opened.chat.id
      const normal = arenaRequest(`/session/${source.id}/message`, {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" },
          parts: [{ type: "text", text: "Handle this transcript-only normal turn without changing files." }],
        }),
      })
      // Past the pause after which the pair would have been prepared.
      await Bun.sleep(2_500)
      expect((await memory.store.chat(chatID))?.initialWarmPreparation).toBeUndefined()
      expect(await readdir(isolatedRoot(root)).catch(() => [] as string[])).toEqual([])
      expect((await normal).status).toBe(200)

      // Opened again once the agent is done, the chat gets its pair.
      const deadline = Date.now() + 30_000
      while (!(await memory.store.chat(chatID))?.initialWarmPreparation && Date.now() < deadline) {
        await open()
        await Bun.sleep(1_500)
      }
      expect((await waitForInitialWarmPair(memory.store, chatID)).generation).toBe(0)
    } finally {
      await arenaRequest(`/arena/sessions/${source.id}/archive`, { method: "POST", headers: headers(root) }).catch(
        () => undefined,
      )
      router.restore()
    }
  }, 120_000)

  test("clears a first pair left pending by a stopped process when the checkout is missing at startup", async () => {
    await using directory = await nestedFixture()
    const root = directory.path
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const gitDirectory = path.join(root, ".git")
    const hidden = path.join(root, ".git-hidden")
    let archive: (() => Promise<unknown>) | undefined
    try {
      const chat = await openChat(root)
      archive = chat.archive
      await memory.store.updateChat(
        { _id: chat.chatID },
        { $set: { initialWarmPreparation: { generation: 0, state: "pending", worktrees: {} } } },
      )
      await rename(gitDirectory, hidden)
      setStoreForTest(memory.restart())
      await arenaRequest(`/arena/chats/${chat.chatID}`, { headers: headers(root) })
      const recovered = await memory.store.chat(chat.chatID)
      expect(recovered?.status).toBe("blocked")
      // Nothing is preparing it, so it must not stop the first pair or an eviction once the checkout is back.
      expect(recovered?.initialWarmPreparation).toBeUndefined()
    } finally {
      await rename(hidden, gitDirectory).catch(() => undefined)
      await archive?.()
      router.restore()
    }
  }, 60_000)

  test("prepares the latest chat's pair again after a restart and leaves the others to their next send", async () => {
    await using olderDirectory = await nestedFixture()
    await using latestDirectory = await nestedFixture()
    const memory = memoryStore()
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(memory.store)
    const archives: (() => Promise<unknown>)[] = []
    try {
      const older = await openChat(olderDirectory.path)
      archives.push(older.archive)
      const olderTurn = await battle({
        store: memory.store,
        directory: olderDirectory.path,
        chatID: older.chatID,
        prompt: "restart older turn one",
      })
      const olderPair = (await waitForWarmPair(memory.store, olderTurn, 1)).warmPreparation!
      const latest = await openChat(latestDirectory.path)
      archives.push(latest.archive)
      const latestTurn = await battle({
        store: memory.store,
        directory: latestDirectory.path,
        chatID: latest.chatID,
        prompt: "restart latest turn one",
      })
      const latestPair = (await waitForWarmPair(memory.store, latestTurn, 1)).warmPreparation!
      const latestForks = [latestPair.worktrees.a!.forkedSessionID!, latestPair.worktrees.b!.forkedSessionID!]
      const session = (id: string) => arenaRequest(`/session/${id}`, { headers: headers(latestDirectory.path) })
      expect((await session(latestForks[0]!)).status).toBe(200)
      // Written while the engine is down, so the pair prepared again has to bring it over.
      await writeFile(path.join(latestDirectory.path, "cache.txt"), "cache v2\n")

      // Trust is kept per store, so a new store over the same records is a restart to it, while
      // what this process knows of each worktree's content stays.
      setStoreForTest(memory.restart())
      // A read of the other chat: the first request only runs recovery, it does not pick the chat.
      await arenaRequest(`/arena/chats/${older.chatID}`, { headers: headers(olderDirectory.path) })
      await waitForCondition(async () => {
        const pair = (await memory.store.turn(latestTurn))?.warmPreparation
        if (pair?.state === "failed") throw new Error(`Arena re-warm failed: ${pair.error ?? "no error recorded"}`)
        return pair?.state === "ready" && pair.worktrees.a?.forkedSessionID !== latestForks[0]
      }, "the latest chat's pair was not prepared again after the restart")
      const rewarmed = (await memory.store.turn(latestTurn))!.warmPreparation!
      const sides = [rewarmed.worktrees.a!, rewarmed.worktrees.b!]
      // The same two worktrees, adopted in place, and the forks the replaced record held are gone.
      expect(sides.map((slot) => slot.directory)).toEqual([
        latestPair.worktrees.a!.directory,
        latestPair.worktrees.b!.directory,
      ])
      expect(sides.map((slot) => slot.sync?.syncPath)).toEqual(["adopted", "adopted"])
      for (const slot of sides) {
        expect(await readFile(path.join(slot.directory, "cache.txt"), "utf8")).toBe("cache v2\n")
      }
      for (const id of latestForks) expect((await session(id)).status).toBe(404)
      const olderRecord = (await memory.store.turn(olderTurn))?.warmPreparation
      expect(olderRecord?.worktrees.a?.forkedSessionID).toBe(olderPair.worktrees.a!.forkedSessionID)
      // The user takes a moment over the prompt.
      await Bun.sleep(1_000)

      const latestNext = await battle({
        store: memory.store,
        directory: latestDirectory.path,
        chatID: latest.chatID,
        prompt: "restart latest turn two",
      })
      expect((await memory.store.turn(latestNext))?.setupTimings?.warmPath).toBe("reused")
      const olderNext = await battle({
        store: memory.store,
        directory: olderDirectory.path,
        chatID: older.chatID,
        prompt: "restart older turn two",
      })
      expect((await memory.store.turn(olderNext))?.setupTimings?.warmPath).toBe("refreshed")
    } finally {
      for (const archive of archives) await archive()
      router.restore()
    }
  }, 180_000)
})
