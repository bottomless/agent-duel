import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { excludeFromBackup } from "@/arena/backup-exclusion"

describe.skipIf(process.platform !== "darwin")("excludeFromBackup", () => {
  test("Time Machine reports the pool and what it later holds as excluded, wherever it moves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-backup-exclusion-"))
    try {
      const pool = path.join(root, "pool")
      await mkdir(pool)
      expect(await excludeFromBackup(pool)).toBe(true)
      await mkdir(path.join(pool, "generation-1-a"))
      const moved = path.join(root, "moved")
      await rename(pool, moved)
      for (const directory of [moved, path.join(moved, "generation-1-a")]) {
        expect(await $`tmutil isexcluded ${directory}`.text()).toStartWith("[Excluded]")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("excludes a pool again once it was deleted and made anew at the same path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-backup-exclusion-"))
    try {
      const pool = path.join(root, "pool")
      await mkdir(pool)
      expect(await excludeFromBackup(pool)).toBe(true)
      await rm(pool, { recursive: true })
      await mkdir(pool)
      expect(await excludeFromBackup(pool)).toBe(true)
      const attribute = await $`xattr -p com.apple.metadata:com_apple_backup_excludeItem ${pool}`.quiet().nothrow()
      expect(attribute.exitCode).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
