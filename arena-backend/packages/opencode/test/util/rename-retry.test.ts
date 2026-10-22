import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { renameRetrying } from "../../src/util/rename-retry"

function failing(code: string, times: number) {
  const calls: Array<[string, string]> = []
  const rename = async (from: string, to: string) => {
    calls.push([from, to])
    if (calls.length <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
  }
  return { calls, rename }
}

describe("renameRetrying", () => {
  test("waits out a file Windows reports held, then renames", async () => {
    const held = failing("EPERM", 3)
    await renameRetrying("host.git.partial", "host.git", { platform: "win32", delayMs: 1, rename: held.rename })
    expect(held.calls).toHaveLength(4)
    expect(held.calls.at(-1)).toEqual(["host.git.partial", "host.git"])
  })

  test("retries EBUSY and EACCES as well", async () => {
    for (const code of ["EBUSY", "EACCES"]) {
      const held = failing(code, 1)
      await renameRetrying("a", "b", { platform: "win32", delayMs: 1, rename: held.rename })
      expect(held.calls).toHaveLength(2)
    }
  })

  test("gives up with the last error once the attempts run out", async () => {
    const held = failing("EPERM", 10)
    await expect(
      renameRetrying("a", "b", { platform: "win32", attempts: 3, delayMs: 1, rename: held.rename }),
    ).rejects.toMatchObject({ code: "EPERM" })
    expect(held.calls).toHaveLength(3)
  })

  test("fails at once on an error a held file does not explain", async () => {
    const missing = failing("ENOENT", 1)
    await expect(
      renameRetrying("a", "b", { platform: "win32", delayMs: 1, rename: missing.rename }),
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(missing.calls).toHaveLength(1)
  })

  test("fails at once outside Windows, where EPERM is a real permission error", async () => {
    const denied = failing("EPERM", 1)
    await expect(
      renameRetrying("a", "b", { platform: "darwin", delayMs: 1, rename: denied.rename }),
    ).rejects.toMatchObject({ code: "EPERM" })
    expect(denied.calls).toHaveLength(1)
  })

  test("renames a real directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rename-retry-"))
    try {
      await writeFile(path.join(root, "HEAD"), "ref: refs/heads/main\n")
      const target = `${root}.git`
      await renameRetrying(root, target)
      expect(await readFile(path.join(target, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
      expect(await stat(root).catch(() => undefined)).toBeUndefined()
      await rm(target, { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
