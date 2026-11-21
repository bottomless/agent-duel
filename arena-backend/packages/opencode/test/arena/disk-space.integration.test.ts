// Battles that meet a full disk, through the real routes and a stubbed OpenRouter. It builds its
// own checkout instead of using the shared fixtures.
import { $ } from "bun"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setStoreForTest } from "@/arena/runtime"
import type { Store } from "@/arena/mongo"
import { arenaRequest, installOpenRouterStub, json, memoryStore, type PublicSnapshot, waitForTurn } from "./harness"

const headers = (directory: string) => ({ "content-type": "application/json", "x-opencode-directory": directory })
const ENV = [
  "OPENCODE_ARENA",
  "OPENROUTER_API_KEY",
  "OPENCODE_ARENA_PROJECT_SPARES",
  "OPENCODE_ARENA_DISK_RETRY_MS",
  "OPENCODE_ARENA_DISK_HEADROOM_BYTES",
]
const roots: string[] = []

afterEach(async () => {
  setStoreForTest(undefined)
  for (const name of ENV) delete process.env[name]
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const diskFull = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-disk-e2e-"))
  roots.push(root)
  await $`git init -q && git config core.fsmonitor false && git config commit.gpgsign false && git config user.email t@t.test && git config user.name T && git commit -q --allow-empty -m root`
    .cwd(root)
    .quiet()
  await writeFile(
    path.join(root, "opencode.json"),
    JSON.stringify({ formatter: false, lsp: false, watcher: { ignore: [".git"] } }),
  )
  await writeFile(path.join(root, "README.md"), "readme\n")
  await $`git add opencode.json README.md && git commit -q -m base`.cwd(root).quiet()
  await writeFile(path.join(root, ".git/info/exclude"), "\ndeps/\n", { flag: "a" })
  await mkdir(path.join(root, "deps/pkg"), { recursive: true })
  await writeFile(path.join(root, "deps/pkg/index.js"), "module.exports = 1\n")
  const memory = memoryStore()
  process.env.OPENCODE_ARENA = "1"
  process.env.OPENROUTER_API_KEY = "test-openrouter-key"
  process.env.OPENCODE_ARENA_PROJECT_SPARES = "0"
  process.env.OPENCODE_ARENA_DISK_RETRY_MS = "50"
  setStoreForTest(memory.store)
  const router = installOpenRouterStub({
    promptCommands: (text) => (text.includes("task") ? `printf 'work\\n' > "work-$(basename "$PWD").txt"` : undefined),
  })
  const created = await arenaRequest("/api/session", {
    method: "POST",
    headers: headers(root),
    body: JSON.stringify({ location: { directory: root }, model: { providerID: "arena", id: "medium" } }),
  })
  const source = (await json<{ data: { id: string } }>(created)).data
  const attached = await json<PublicSnapshot>(
    await arenaRequest(`/arena/sessions/${source.id}`, { headers: headers(root) }),
  )
  return { root, store: memory.store, router, chatID: attached.chat.id, sessionID: source.id }
}

async function start(store: Store, root: string, chatID: string) {
  const admitted = await json<PublicSnapshot>(
    await arenaRequest(`/arena/chats/${chatID}/turns`, {
      method: "POST",
      headers: headers(root),
      body: JSON.stringify({ prompt: "task" }),
    }),
  )
  return admitted.turn!.id
}

/** Fail a store write with a full disk for `count` calls once `armed` is set, then let it through. */
function failWrites<T extends object, K extends keyof T>(
  target: T,
  method: K,
  count: number,
  matches: (...args: unknown[]) => boolean = () => true,
) {
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target)
  const state = { armed: false, failed: 0 }
  ;(target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    if (state.armed && state.failed < count && matches(...args)) {
      state.failed++
      throw diskFull()
    }
    return original(...args)
  }
  return state
}

test("a side whose save meets a full disk waits, says so, and is saved once there is room", async () => {
  const { root, store, router, chatID, sessionID } = await setup()
  try {
    // What saving a side writes: its transcript archive and its patch.
    const artifacts = failWrites(store, "storeArtifact", 6, (input) =>
      ["transcript", "patch"].includes((input as { kind?: string }).kind ?? ""),
    )
    const seen: Array<Date | null | undefined> = []
    const updateTurn = store.updateTurn.bind(store)
    store.updateTurn = async (id, patch) => {
      if ("waitingForDiskSince" in patch) seen.push(patch.waitingForDiskSince)
      return updateTurn(id, patch)
    }
    const turnID = await start(store, root, chatID)
    artifacts.armed = true
    await waitForTurn(store, turnID, "awaiting_vote")
    expect(artifacts.failed).toBe(6)
    expect(seen[0]).toBeInstanceOf(Date)
    expect(seen.at(-1)).toBeNull()
    const runs = await store.runsForTurn(turnID)
    expect(runs.map((run) => [run.runState, run.selectable, run.error ?? null])).toEqual([
      ["complete", true, null],
      ["complete", true, null],
    ])
    expect((await store.turn(turnID))?.waitingForDiskSince).toBeNull()
    await arenaRequest(`/arena/sessions/${sessionID}/archive`, { method: "POST", headers: headers(root) }).catch(
      () => undefined,
    )
  } finally {
    router.restore()
  }
}, 180_000)

test("event writes a full disk refused leave a gap, and the battle still reaches its vote", async () => {
  const { root, store, router, chatID, sessionID } = await setup()
  try {
    const events = failWrites(store, "saveEvent", 25)
    const turnID = await start(store, root, chatID)
    events.armed = true
    await waitForTurn(store, turnID, "awaiting_vote")
    expect(events.failed).toBe(25)
    const gaps = await store.events.find({ turnID, type: "arena.persistence.gap" }).toArray()
    expect(gaps.length).toBeGreaterThan(0)
    expect((await store.runsForTurn(turnID)).every((run) => run.selectable)).toBe(true)
    await arenaRequest(`/arena/sessions/${sessionID}/archive`, { method: "POST", headers: headers(root) }).catch(
      () => undefined,
    )
  } finally {
    router.restore()
  }
}, 180_000)

test("a battle the disk is short for starts anyway and says how much it needs", async () => {
  const { root, store, router, chatID, sessionID } = await setup()
  try {
    // More headroom than any disk has: the check releases what it can, then warns.
    process.env.OPENCODE_ARENA_DISK_HEADROOM_BYTES = String(1e18)
    const turnID = await start(store, root, chatID)
    await waitForTurn(store, turnID, "awaiting_vote")
    const warning = (await store.turn(turnID))?.lowDiskSpace
    expect(warning?.neededBytes).toBeGreaterThan(1e18 - 1)
    expect(warning?.freeBytes).toBeGreaterThan(0)
    const snapshot = await json<PublicSnapshot>(
      await arenaRequest(`/arena/chats/${chatID}`, { headers: headers(root) }),
    )
    expect((snapshot.turn as { lowDiskSpace?: unknown }).lowDiskSpace).toEqual(warning)
    await arenaRequest(`/arena/sessions/${sessionID}/archive`, { method: "POST", headers: headers(root) }).catch(
      () => undefined,
    )
  } finally {
    router.restore()
  }
}, 180_000)
