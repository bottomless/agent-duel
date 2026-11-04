import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "../src/fs-util.js"

test("Git's symlink setting matches the filesystem probe", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arena-symlink-"))
  try {
    const supported = await fs.symlink("missing-target", path.join(directory, "link")).then(() => true, () => false)
    expect(FSUtil.canSymlink()).toBe(supported)
    expect(FSUtil.canSymlink()).toBe(supported)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
