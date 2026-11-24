import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { emptyWorktree, resultsRecorded, unvotedReleaseMs, waitingSince } from "@/arena/unvoted-release"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const at = (iso: string) => new Date(iso)

const recorded = {
  finalizedAt: at("2026-11-01T10:00:00Z"),
  rawHead: "a".repeat(40),
  finalCommit: "b".repeat(40),
  finalTree: "c".repeat(40),
  finalIndexTree: "d".repeat(40),
  permanentRef: "refs/battles/0123456789abcdef/turn-0/a",
}

describe("waitingSince", () => {
  test("counts from the state a battle waits in, or from when its chat was last closed", () => {
    const turn = {
      state: "awaiting_vote" as const,
      transitionTimestamps: { running: at("2026-11-01T09:00:00Z"), awaiting_vote: at("2026-11-01T10:00:00Z") },
    }
    expect(waitingSince(turn)).toBe(at("2026-11-01T10:00:00Z").getTime())
    // Looking at the results without voting moves the wait on.
    expect(waitingSince(turn, at("2026-11-03T08:00:00Z").getTime())).toBe(at("2026-11-03T08:00:00Z").getTime())
    expect(waitingSince(turn, at("2026-10-30T08:00:00Z").getTime())).toBe(at("2026-11-01T10:00:00Z").getTime())
    expect(
      waitingSince({
        state: "awaiting_stop_resolution",
        transitionTimestamps: { awaiting_stop_resolution: at("2026-11-02T00:00:00Z") },
      }),
    ).toBe(at("2026-11-02T00:00:00Z").getTime())
  })

  test("is undefined for a battle that runs, is decided, or is being applied", () => {
    for (const state of ["running", "finalizing", "applying", "complete", "discarded"] as const) {
      expect(waitingSince({ state, transitionTimestamps: { [state]: at("2026-11-01T10:00:00Z") } })).toBeUndefined()
    }
    expect(
      waitingSince({
        state: "awaiting_vote",
        resolution: { kind: "vote" },
        transitionTimestamps: { awaiting_vote: at("2026-11-01T10:00:00Z") },
      }),
    ).toBeUndefined()
    expect(waitingSince({ state: "awaiting_vote", transitionTimestamps: {} })).toBeUndefined()
  })

  test("defaults to 72 hours, which tests can shorten", () => {
    const previous = process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS
    try {
      delete process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS
      expect(unvotedReleaseMs()).toBe(72 * 60 * 60_000)
      process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS = "500"
      expect(unvotedReleaseMs()).toBe(500)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS
      else process.env.OPENCODE_ARENA_UNVOTED_RELEASE_MS = previous
    }
  })
})

describe("resultsRecorded", () => {
  test("holds only when every side finalized with its whole result recorded", () => {
    expect(resultsRecorded([recorded, { ...recorded, permanentRef: "refs/battles/0123456789abcdef/turn-0/b" }])).toBe(
      true,
    )
    expect(resultsRecorded([])).toBe(false)
    for (const missing of [
      "finalizedAt",
      "rawHead",
      "finalCommit",
      "finalTree",
      "finalIndexTree",
      "permanentRef",
    ] as const) {
      expect(resultsRecorded([recorded, { ...recorded, [missing]: undefined }])).toBe(false)
    }
    // A side whose worktree is gone already has nothing to release.
    expect(resultsRecorded([recorded, { ...recorded, worktreeRemovedAt: at("2026-11-02T00:00:00Z") }])).toBe(false)
  })
})

describe("emptyWorktree", () => {
  test("deletes everything but the `.git` link, through the pool's trash", async () => {
    const pool = await mkdtemp(path.join(os.tmpdir(), "arena-unvoted-release-"))
    roots.push(pool)
    const worktree = path.join(pool, "generation-1-a")
    await mkdir(path.join(worktree, "node_modules", "dep"), { recursive: true })
    await mkdir(path.join(worktree, ".next", "dev"), { recursive: true })
    await writeFile(path.join(worktree, ".git"), "gitdir: ../generation-1-a.git/worktrees/generation-1-a\n")
    await writeFile(path.join(worktree, "README.md"), "readme\n")
    await writeFile(path.join(worktree, "node_modules", "dep", "index.js"), "module.exports = 1\n")
    await writeFile(path.join(worktree, ".env"), "SECRET=1\n")
    const host = path.join(pool, "generation-1-a.git")
    await mkdir(host)

    expect(await emptyWorktree(worktree, path.join(pool, ".trash"))).toBe(4)

    expect(await readdir(worktree)).toEqual([".git"])
    expect(await readdir(host)).toEqual([])
    expect(await readdir(path.join(pool, ".trash"))).toEqual([])
    expect((await readdir(pool)).sort()).toEqual([".trash", "generation-1-a", "generation-1-a.git"])
  })
})
