import { describe, expect, test } from "bun:test"
import { battleWriteEstimate, isDiskFull, objectBytesFromCount, trackedBytesFromListing } from "@/arena/disk-space"

describe("isDiskFull", () => {
  test("recognises a full disk from Node, git, SQLite and Windows, however deep the cause", () => {
    expect(isDiskFull(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe(true)
    expect(isDiskFull(new Error("fatal: unable to write loose object file: No space left on device"))).toBe(true)
    expect(isDiskFull(Object.assign(new Error("SQLITE_FULL: database or disk is full"), { code: "SQLITE_FULL" }))).toBe(
      true,
    )
    expect(isDiskFull("There is not enough space on the disk.")).toBe(true)
    expect(
      isDiskFull(
        new Error("Arena result finalization failed", { cause: new Error("ENOSPC: no space left on device, write") }),
      ),
    ).toBe(true)
    expect(
      isDiskFull(new AggregateError([new Error("timeout"), Object.assign(new Error("x"), { code: "ENOSPC" })])),
    ).toBe(true)
    expect(isDiskFull({ stderr: "error: disk quota exceeded" })).toBe(true)
  })

  test("leaves every other failure alone", () => {
    expect(isDiskFull(new Error("ECONNRESET"))).toBe(false)
    expect(isDiskFull(new Error("fatal: not a git repository"))).toBe(false)
    expect(isDiskFull(undefined)).toBe(false)
    const loop: { cause?: unknown; message: string } = { message: "loop" }
    loop.cause = loop
    expect(isDiskFull(loop)).toBe(false)
  })
})

describe("battle size", () => {
  test("adds up the tracked files git lists, skipping submodules", () => {
    const listing = [
      "100644 blob 1111111111111111111111111111111111111111     120\tREADME.md",
      "100755 blob 2222222222222222222222222222222222222222    4096\tbin/run",
      "160000 commit 3333333333333333333333333333333333333333       -\tvendor/sub",
      "",
    ].join("\0")
    expect(trackedBytesFromListing(listing)).toBe(4216)
    expect(trackedBytesFromListing("")).toBe(0)
  })

  test("reads loose, packed and garbage objects from count-objects", () => {
    const text =
      "count: 12\nsize: 48\nin-pack: 900\npacks: 1\nsize-pack: 2000\nprune-packable: 0\ngarbage: 1\nsize-garbage: 2\n"
    expect(objectBytesFromCount(text)).toBe((48 + 2000 + 2) * 1024)
  })

  test("counts tracked files in every new worktree, and the object store and ignored copy only without clones", () => {
    const sizes = { trackedBytes: 100, objectBytes: 1_000, copiedIgnoredBytes: 10_000 }
    expect(battleWriteEstimate({ worktrees: 2, cloned: true, ...sizes })).toBe(200)
    expect(battleWriteEstimate({ worktrees: 3, cloned: false, ...sizes })).toBe(3 * 11_100)
    expect(battleWriteEstimate({ worktrees: 0, cloned: false, ...sizes })).toBe(0)
  })
})
