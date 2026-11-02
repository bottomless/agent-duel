import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { identicalNumberedCopies, syncConflictOriginals } from "@/arena/sync-conflict-copy"

describe("syncConflictOriginals", () => {
  test("names both possible originals when the copy has a suffix", () => {
    expect(syncConflictOriginals(".env 2")).toEqual([".env"])
    expect(syncConflictOriginals(".env 2.save")).toEqual([".env.save", ".env"])
    expect(syncConflictOriginals("config 12.json")).toEqual(["config.json", "config"])
    expect(syncConflictOriginals("name 2.ext")).toEqual(["name.ext", "name"])
    expect(syncConflictOriginals("name 2.save")).toEqual(["name.save", "name"])
    expect(syncConflictOriginals("app/.env.local 3")).toEqual(["app/.env.local"])
    expect(syncConflictOriginals("app/.env 2.save")).toEqual(["app/.env.save", "app/.env"])
    expect(syncConflictOriginals("dir with space/report 2.pdf")).toEqual([
      "dir with space/report.pdf",
      "dir with space/report",
    ])
    expect(syncConflictOriginals("a 1 2")).toEqual(["a 1"])
  })

  test("leaves every other name alone", () => {
    expect(syncConflictOriginals(".env")).toEqual([])
    expect(syncConflictOriginals("report2.pdf")).toEqual([])
    expect(syncConflictOriginals("report 2a.pdf")).toEqual([])
    expect(syncConflictOriginals("report  .pdf")).toEqual([])
    expect(syncConflictOriginals(" 2")).toEqual([])
    expect(syncConflictOriginals("notes 2.")).toEqual([])
    expect(syncConflictOriginals("archive 2.tar.gz")).toEqual([])
    expect(syncConflictOriginals("generation 2/file")).toEqual([])
    expect(syncConflictOriginals("copy (2).txt")).toEqual([])
  })
})

describe("identicalNumberedCopies", () => {
  test("keeps only numbered copies with the same bytes as a regular file beside them", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-sync-copy-test-"))
    try {
      await mkdir(join(root, "app"))
      await writeFile(join(root, ".env"), "SECRET=1\n")
      await writeFile(join(root, ".env 2"), "SECRET=1\n")
      await writeFile(join(root, ".env 2.save"), "SECRET=1\n")
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
        ".env 2.save",
        ".env 3",
        "app/config 2.json",
        "orphan 2.txt",
        "folder 2",
        "link 2",
        "plain.txt",
      ])
      expect(found).toEqual([
        { copy: ".env 2", original: ".env" },
        { copy: ".env 2.save", original: ".env" },
        { copy: "app/config 2.json", original: "app/config.json" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
