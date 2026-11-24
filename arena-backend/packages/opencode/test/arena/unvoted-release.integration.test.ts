// A battle released while it waited for its vote, then replied to and voted on, through the real
// routes and a stubbed OpenRouter. It builds its own checkout instead of using the shared fixtures.
import { $ } from "bun"
import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { setStoreForTest } from "@/arena/runtime"
import type { Store } from "@/arena/mongo"
import { arenaRequest, installOpenRouterStub, json, memoryStore, type PublicSnapshot, waitForTurn } from "./harness"

const headers = (directory: string) => ({ "content-type": "application/json", "x-opencode-directory": directory })
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

async function checkout() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-unvoted-e2e-"))
  await $`git init -q && git config core.fsmonitor false && git config commit.gpgsign false && git config user.email t@t.test && git config user.name T && git commit -q --allow-empty -m root`
    .cwd(root)
    .quiet()
  await writeFile(
    path.join(root, "opencode.json"),
    JSON.stringify({ formatter: false, lsp: false, watcher: { ignore: [".git"] } }),
  )
  await writeFile(path.join(root, "README.md"), "readme\n")
  await $`git add opencode.json README.md && git commit -q -m base`.cwd(root).quiet()
  await writeFile(path.join(root, ".git/info/exclude"), "\ndeps/\ncache.txt\n", { flag: "a" })
  await mkdir(path.join(root, "deps/pkg"), { recursive: true })
  await writeFile(path.join(root, "deps/pkg/index.js"), "module.exports = 1\n")
  await writeFile(path.join(root, "cache.txt"), "cache v1\n")
  return root
}

async function openChat(root: string) {
  const created = await arenaRequest("/api/session", {
    method: "POST",
    headers: headers(root),
    body: JSON.stringify({ location: { directory: root }, model: { providerID: "arena", id: "medium" } }),
  })
  const createdText = await created.text()
  if (!created.ok) throw new Error(`create ${created.status}: ${createdText}`)
  const source = (JSON.parse(createdText) as { data: { id: string } }).data
  const attachedResponse = await arenaRequest(`/arena/sessions/${source.id}`, { headers: headers(root) })
  const attachedText = await attachedResponse.text()
  if (!attachedResponse.ok) throw new Error(`attach ${attachedResponse.status}: ${attachedText}`)
  const attached = JSON.parse(attachedText) as PublicSnapshot
  return { chatID: attached.chat.id, sessionID: source.id }
}

async function startBattle(store: Store, root: string, chatID: string, prompt: string) {
  const admitted = await json<PublicSnapshot>(
    await arenaRequest(`/arena/chats/${chatID}/turns`, {
      method: "POST",
      headers: headers(root),
      body: JSON.stringify({ prompt }),
    }),
  )
  const turnID = admitted.turn!.id
  await waitForTurn(store, turnID, "awaiting_vote").catch(async (cause) => {
    const log = await readFile(`${Global.Path.log}/opencode.log`, "utf8").catch(() => "")
    throw new Error(
      `${cause}\n${log
        .split("\n")
        .filter((l) => l.includes("ERROR"))
        .slice(-20)
        .join("\n")}`,
    )
  })
  return turnID
}

const trim = async (root: string, keep: number) =>
  json<{ chats: number; released: number; kept: number }>(
    await arenaRequest("/arena/environments/trim", {
      method: "POST",
      headers: headers(root),
      body: JSON.stringify({ keep }),
    }),
  )

test("an unvoted battle's files go, a reply brings them back, and the vote still applies", async () => {
  const root = await checkout()
  const memory = memoryStore()
  process.env.OPENCODE_ARENA = "1"
  process.env.OPENROUTER_API_KEY = "test-openrouter-key"
  process.env.OPENCODE_ARENA_PROJECT_SPARES = "0"
  setStoreForTest(memory.store)
  const router = installOpenRouterStub({
    promptCommands: (text) =>
      text.includes("first task")
        ? `printf 'side work\\n' > "work-$(basename "$PWD").txt" && printf 'installed\\n' > deps/pkg/new.js`
        : text.includes("follow up")
          ? `printf 'reply\\n' >> "work-$(basename "$PWD").txt"`
          : text.includes("second task")
            ? `printf 'second\\n' > second.txt`
            : undefined,
  })
  try {
    const chat = await openChat(root)
    const turnID = await startBattle(memory.store, root, chat.chatID, "first task")
    const runs = await memory.store.runsForTurn(turnID)
    for (const run of runs) {
      expect(await exists(path.join(run.worktree, `work-${path.basename(run.worktree)}.txt`))).toBe(true)
      expect(await exists(path.join(run.worktree, "deps/pkg/new.js"))).toBe(true)
    }

    // Not long enough: nothing goes.
    expect((await trim(root, 5)).released).toBe(0)
    for (const run of runs) expect((await readdir(run.worktree)).length).toBeGreaterThan(1)

    process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS = "1"
    await Bun.sleep(20)
    const released = await trim(root, 5)
    expect(released.released).toBe(1)
    for (const run of await memory.store.runsForTurn(turnID)) {
      expect(await readdir(run.worktree)).toEqual([".git"])
      expect(await exists(`${run.worktree}.git`)).toBe(true)
      expect(run.filesReleasedAt).toBeInstanceOf(Date)
      expect(run.worktreeRemovedAt).toBeUndefined()
    }
    const snapshot = await json<PublicSnapshot>(
      await arenaRequest(`/arena/chats/${chat.chatID}`, { headers: headers(root) }),
    )
    expect(snapshot.runs.map((run: { worktreeActive: boolean }) => run.worktreeActive)).toEqual([false, false])
    // The Changes view reads the recorded results.
    const diff = await json<{ files: unknown[] }>(
      await arenaRequest(`/arena/turns/${turnID}/diff`, { headers: headers(root) }),
    )
    expect(diff.files.length).toBeGreaterThan(0)
    // A second trim finds nothing more to release.
    expect((await trim(root, 5)).released).toBe(0)

    const before = (await memory.store.turn(turnID))!.transitionTimestamps.awaiting_vote!.getTime()
    await json(
      await arenaRequest(`/arena/turns/${turnID}/reply`, {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ prompt: "follow up", target: "both" }),
      }),
    )
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const turn = await memory.store.turn(turnID)
      if (turn?.state === "awaiting_vote" && turn.transitionTimestamps.awaiting_vote!.getTime() > before) break
      if (turn?.state === "awaiting_stop_resolution")
        throw new Error(`reply failed: ${JSON.stringify(turn.failureReason)}`)
      await Bun.sleep(100)
    }
    for (const run of await memory.store.runsForTurn(turnID)) {
      const name = path.basename(run.worktree)
      expect(run.filesReleasedAt).toBeNull()
      expect(run.runState).toBe("complete")
      expect(await readFile(path.join(run.worktree, `work-${name}.txt`), "utf8")).toBe("side work\nreply\n")
      expect(await readFile(path.join(run.worktree, "README.md"), "utf8")).toBe("readme\n")
      // Ignored content comes from the checkout again; what the contestant wrote there is gone.
      expect(await readFile(path.join(run.worktree, "deps/pkg/index.js"), "utf8")).toBe("module.exports = 1\n")
      expect(await exists(path.join(run.worktree, "deps/pkg/new.js"))).toBe(false)
    }
    const shown = await json<PublicSnapshot>(
      await arenaRequest(`/arena/chats/${chat.chatID}`, { headers: headers(root) }),
    )
    expect(shown.runs.map((run: { worktreeActive: boolean }) => run.worktreeActive)).toEqual([true, true])

    await json(
      await arenaRequest(`/arena/turns/${turnID}/vote`, {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ vote: "a" }),
      }),
    )
    await waitForTurn(memory.store, turnID, "complete")
    const winner = (await memory.store.runsForTurn(turnID)).find((run) => run.side === "a")!
    expect(await readFile(path.join(root, `work-${path.basename(winner.worktree)}.txt`), "utf8")).toBe(
      "side work\nreply\n",
    )

    // Second battle: released, then voted on without a reply; the next trim still releases the chat.
    delete process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS
    const second = await startBattle(memory.store, root, chat.chatID, "second task")
    process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS = "1"
    await Bun.sleep(20)
    expect((await trim(root, 5)).released).toBe(1)
    await json(
      await arenaRequest(`/arena/turns/${second}/vote`, {
        method: "POST",
        headers: headers(root),
        body: JSON.stringify({ vote: "b" }),
      }),
    )
    await waitForTurn(memory.store, second, "complete")
    expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("second\n")
    const pool = path.dirname(winner.worktree)
    const final = await trim(root, 0)
    expect(final.released).toBe(1)
    expect(await exists(pool)).toBe(false)

    await arenaRequest(`/arena/sessions/${chat.sessionID}/archive`, { method: "POST", headers: headers(root) }).catch(
      () => undefined,
    )
  } finally {
    router.restore()
    setStoreForTest(undefined)
    for (const name of ["OPENCODE_ARENA", "OPENROUTER_API_KEY", "OPENCODE_ARENA_UNVOTED_RELEASE_MS"])
      delete process.env[name]
    await rm(root, { recursive: true, force: true })
  }
}, 240_000)
