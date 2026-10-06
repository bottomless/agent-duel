import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { readdir } from "fs/promises"
import os from "os"
import path from "path"
import { discardTree, sweepTrash, TRASH_DIRNAME, trashFor } from "@/util/discard-tree"

const roots: string[] = []

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "discard-tree-"))
  roots.push(root)
  return root
}

/** A directory with something in it, so a rename cannot be mistaken for removing an empty one. */
function tree(root: string, name: string) {
  const directory = path.join(root, name)
  mkdirSync(path.join(directory, "nested"), { recursive: true })
  writeFileSync(path.join(directory, "nested", "file.txt"), "contents")
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("discardTree", () => {
  test("frees the path and keeps the contents under the trash", async () => {
    const root = workspace()
    const directory = tree(root, "worktree")

    const grave = await discardTree(directory)

    expect(grave).toBeDefined()
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(path.join(grave!, "nested", "file.txt"))).toBe(true)
    expect(path.dirname(grave!)).toBe(trashFor(directory))
  })

  test("takes the same path twice without the second colliding with the first", async () => {
    const root = workspace()

    const first = await discardTree(tree(root, "worktree"))
    const second = await discardTree(tree(root, "worktree"))

    expect(first).not.toBe(second)
    expect(existsSync(first!)).toBe(true)
    expect(existsSync(second!)).toBe(true)
    expect(await readdir(path.join(root, TRASH_DIRNAME))).toHaveLength(2)
  })

  // Callers fall back to deleting in place on this, so it has to be reported rather than thrown.
  test("reports failure instead of raising when there is nothing to move", async () => {
    const root = workspace()
    expect(await discardTree(path.join(root, "absent"))).toBeUndefined()
  })
})

describe("sweepTrash", () => {
  test("clears what an earlier process left behind", async () => {
    const root = workspace()
    await discardTree(tree(root, "one"))
    await discardTree(tree(root, "two"))
    const trash = path.join(root, TRASH_DIRNAME)

    expect(await sweepTrash(trash)).toBe(2)
    expect(await readdir(trash)).toHaveLength(0)
  })

  test("says nothing was cleared when the trash has never been used", async () => {
    expect(await sweepTrash(path.join(workspace(), TRASH_DIRNAME))).toBe(0)
  })
})
