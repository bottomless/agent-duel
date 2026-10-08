import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { identicalNumberedCopies, syncConflictOriginal } from "@/arena/sync-conflict-copy"

describe("syncConflictOriginal", () => {
  test("names the original a numbered copy was made from", () => {
    expect(syncConflictOriginal(".env 2")).toBe(".env")
    expect(syncConflictOriginal(".env 2.save")).toBe(".env.save")
    expect(syncConflictOriginal("config 12.json")).toBe("config.json")
    expect(syncConflictOriginal("app/.env.local 3")).toBe("app/.env.local")
    expect(syncConflictOriginal("dir with space/report 2.pdf")).toBe("dir with space/report.pdf")
    expect(syncConflictOriginal("a 1 2")).toBe("a 1")
  })

  test("leaves every other name alone", () => {
    expect(syncConflictOriginal(".env")).toBeUndefined()
    expect(syncConflictOriginal("report2.pdf")).toBeUndefined()
    expect(syncConflictOriginal("report 2a.pdf")).toBeUndefined()
    expect(syncConflictOriginal("report  .pdf")).toBeUndefined()
    expect(syncConflictOriginal(" 2")).toBeUndefined()
    expect(syncConflictOriginal("notes 2.")).toBeUndefined()
    expect(syncConflictOriginal("archive 2.tar.gz")).toBeUndefined()
    expect(syncConflictOriginal("generation 2/file")).toBeUndefined()
    expect(syncConflictOriginal("copy (2).txt")).toBeUndefined()
  })
})

describe("identicalNumberedCopies", () => {
  test("keeps only numbered copies with the same bytes as a regular file beside them", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-sync-copy-test-"))
    try {
      await mkdir(join(root, "app"))
      await writeFile(join(root, ".env"), "SECRET=1\n")
      await writeFile(join(root, ".env 2"), "SECRET=1\n")
      await writeFile(join(root, ".env 3"), "SECRET=2\n")
      await writeFile(join(root, "app", "config.json"), "{}\n")
      await writeFile(join(root, "app", "config 2.json"), "{}\n")
      await writeFile(join(root, "orphan 2.txt"), "orphan\n")
      await mkdir(join(root, "folder"))
      await writeFile(join(root, "folder 2"), "")
      await symlink(".env", join(root, "link"))
      await writeFile(join(root, "link 2"), ".env")
      await writeFile(join(root, "plain.txt"), "plain\n")

      const found = await identicalNumberedCopies(root, [
        ".env 2",
        ".env 3",
        "app/config 2.json",
        "orphan 2.txt",
        "folder 2",
        "link 2",
        "plain.txt",
      ])
      expect(found).toEqual([
        { copy: ".env 2", original: ".env" },
        { copy: "app/config 2.json", original: "app/config.json" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
