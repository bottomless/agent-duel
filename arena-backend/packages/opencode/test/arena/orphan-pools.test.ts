import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedRoot } from "@/worktree"
import { poolDirectory, sweepOrphanPools } from "@/arena/orphan-pools"

const DAY = 24 * 60 * 60_000
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-orphan-pools-"))
  roots.push(root)
  return root
}

async function exists(file: string) {
  return lstat(file).then(
    () => true,
    () => false,
  )
}

/** Set a directory and its entries back `age` milliseconds, as a pool nobody renamed into for that long. */
async function age(directory: string, ms: number) {
  const at = new Date(Date.now() - ms)
  for (const name of await readdir(directory)) await utimes(path.join(directory, name), at, at)
  await utimes(directory, at, at)
}

/** A pool as a home leaves it: a slot with a file and the slot's host. */
async function pool(directory: string, options: { owner?: { home: string; chatID: string }; age?: number } = {}) {
  await mkdir(path.join(directory, "generation-1-a"), { recursive: true })
  await mkdir(path.join(directory, "generation-1-a.git"), { recursive: true })
  await writeFile(path.join(directory, "generation-1-a", "file.txt"), "left\n")
  if (options.owner) {
    const owners = path.join(path.dirname(directory), ".owners")
    await mkdir(owners, { recursive: true })
    await writeFile(path.join(owners, path.basename(directory)), JSON.stringify(options.owner))
  }
  await age(directory, options.age ?? 0)
  return directory
}

/** An Arena home; `live` gives it the store that says it is still in use. */
async function home(root: string, name: string, live: boolean) {
  const directory = path.join(root, name, "arena")
  await mkdir(directory, { recursive: true })
  if (live) await writeFile(path.join(directory, "arena.sqlite"), "")
  return directory
}

const nobodyWorking = async () => []

describe("sweepOrphanPools", () => {
  test("removes pools no home owns and keeps every pool something still owns", async () => {
    const root = await scratch()
    const checkout = path.join(root, "project")
    const isolated = isolatedRoot(checkout)
    const here = await home(root, "here", true)
    const other = await home(root, "other", true)
    const gone = await home(root, "gone", false)

    const own = await pool(poolDirectory(checkout, "chat|mine"), { age: 30 * DAY })
    const archived = await pool(poolDirectory(checkout, "chat|archived"), {
      owner: { home: here, chatID: "chat|archived" },
      age: 30 * DAY,
    })
    const unowned = await pool(path.join(isolated, "0000000000000001"), {
      owner: { home: here, chatID: "chat|deleted" },
      age: 2 * DAY,
    })
    const homeGone = await pool(path.join(isolated, "0000000000000002"), {
      owner: { home: gone, chatID: "chat|x" },
      age: 2 * DAY,
    })
    const otherHome = await pool(path.join(isolated, "0000000000000003"), {
      owner: { home: other, chatID: "chat|y" },
      age: 30 * DAY,
    })
    const oldUnmarked = await pool(path.join(isolated, "0000000000000004"), { age: 15 * DAY })
    const newUnmarked = await pool(path.join(isolated, "0000000000000005"), { age: 3 * DAY })
    const justMarked = await pool(path.join(isolated, "0000000000000006"), {
      owner: { home: here, chatID: "chat|deleted" },
      age: 60_000,
    })
    // A New worktree and a repository's spare pair share the directory; neither is a chat's pool.
    const newWorktree = path.join(isolated, "0a1b2c3d")
    await mkdir(newWorktree, { recursive: true })
    await age(newWorktree, 30 * DAY)

    const sweep = await sweepOrphanPools({
      home: here,
      chats: [
        { id: "chat|mine", checkout, archived: false },
        { id: "chat|archived", checkout, archived: true },
      ],
      checkouts: [checkout],
      working: nobodyWorking,
    })

    expect(
      sweep.pools.map((outcome) => [path.basename(outcome.directory), outcome.reason, outcome.result]).sort(),
    ).toEqual([
      ["0000000000000001", "unowned", "removed"],
      ["0000000000000002", "home_gone", "removed"],
      ["0000000000000004", "unmarked", "removed"],
    ])
    for (const directory of [unowned, homeGone, oldUnmarked]) expect(await exists(directory)).toBe(false)
    for (const directory of [own, archived, otherHome, newUnmarked, justMarked, newWorktree]) {
      expect(await exists(directory)).toBe(true)
    }
    // The removed pools' markers go with them; the chat's own pool is marked as this home's.
    expect(await exists(path.join(isolated, ".owners", "0000000000000001"))).toBe(false)
    expect(JSON.parse(await readFile(path.join(isolated, ".owners", path.basename(own)), "utf8"))).toEqual({
      home: here,
      chatID: "chat|mine",
    })
    // Moved out of the way into the shared trash and deleted there, leaving nothing behind.
    expect(await readdir(path.join(isolated, ".trash")).catch(() => [])).toEqual([])
  })

  test("removes the pools a moved or copied checkout carried, and keeps the chat's pool where it looks", async () => {
    const root = await scratch()
    const here = await home(root, "here", true)
    const recorded = path.join(root, "project")
    const copy = path.join(root, "project copy")
    const kept = await pool(poolDirectory(recorded, "chat|mine"))
    // The copy carries the pool and the marker that names this home.
    const carried = await pool(poolDirectory(copy, "chat|mine"), {
      owner: { home: here, chatID: "chat|mine" },
      age: 2 * DAY,
    })

    const sweep = await sweepOrphanPools({
      home: here,
      chats: [{ id: "chat|mine", checkout: recorded, archived: false }],
      checkouts: [recorded, copy],
      working: nobodyWorking,
    })

    expect(sweep.pools.map((outcome) => [outcome.directory, outcome.reason, outcome.result])).toEqual([
      [carried, "unowned", "removed"],
    ])
    expect(await exists(kept)).toBe(true)
    expect(await exists(carried)).toBe(false)
  })

  test("keeps an orphaned pool a process works in, and every pool when processes cannot be listed", async () => {
    const root = await scratch()
    const checkout = path.join(root, "project")
    const isolated = isolatedRoot(checkout)
    const here = await home(root, "here", true)
    const busy = await pool(path.join(isolated, "0000000000000001"), {
      owner: { home: here, chatID: "chat|gone" },
      age: 2 * DAY,
    })
    const idle = await pool(path.join(isolated, "0000000000000002"), {
      owner: { home: here, chatID: "chat|gone" },
      age: 2 * DAY,
    })
    // A process lists its directory resolved, `/private/var/...` on macOS for a `/var/...` path.
    const shell = path.join(await realpath(busy), "generation-1-a")

    const unlisted = await sweepOrphanPools({
      home: here,
      chats: [],
      checkouts: [checkout],
      working: async () => undefined,
    })
    expect(unlisted.unlisted).toBe(true)
    expect(await exists(busy)).toBe(true)
    expect(await exists(idle)).toBe(true)

    const sweep = await sweepOrphanPools({
      home: here,
      chats: [],
      checkouts: [checkout],
      working: async () => [{ directory: shell }],
    })
    expect(sweep.pools.map((outcome) => [outcome.directory, outcome.result]).sort()).toEqual([
      [busy, "busy"],
      [idle, "removed"],
    ])
    expect(await exists(busy)).toBe(true)
    expect(await exists(idle)).toBe(false)
  })

  test("clears markers whose pool is gone and clones left staged by a stopped engine", async () => {
    const root = await scratch()
    const checkout = path.join(root, "project")
    const isolated = isolatedRoot(checkout)
    const here = await home(root, "here", true)
    await mkdir(path.join(isolated, ".owners"), { recursive: true })
    await writeFile(
      path.join(isolated, ".owners", "00000000000000ff"),
      JSON.stringify({ home: here, chatID: "chat|z" }),
    )
    const leftover = path.join(isolated, ".staging", "node_modules-left")
    const building = path.join(isolated, ".staging", "node_modules-building")
    for (const directory of [leftover, building]) {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, "index.js"), "module.exports = 1\n")
    }
    await age(leftover, 2 * DAY)

    const sweep = await sweepOrphanPools({ home: here, chats: [], checkouts: [checkout], working: nobodyWorking })

    expect(sweep.staged).toEqual([leftover])
    expect(await exists(path.join(isolated, ".owners", "00000000000000ff"))).toBe(false)
    expect(await exists(leftover)).toBe(false)
    expect(await exists(building)).toBe(true)
  })
})
