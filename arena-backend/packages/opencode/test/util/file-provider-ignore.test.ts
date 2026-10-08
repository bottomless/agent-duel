import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createIgnoredContentSnapshot } from "@/arena/copy-snapshot"
import { hasFileProviderIgnore, ignoreForFileProviderSync } from "@/util/file-provider-ignore"

const darwin = process.platform === "darwin"

describe("ignoreForFileProviderSync", () => {
  test.skipIf(!darwin)("sets the attribute once and reports it present after", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arena-file-provider-test-"))
    try {
      expect(await hasFileProviderIgnore(directory)).toBe(false)
      expect(await ignoreForFileProviderSync(directory)).toEqual({ state: "set" })
      expect(await ignoreForFileProviderSync(directory)).toEqual({ state: "present" })
      expect(await hasFileProviderIgnore(directory)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(!darwin)("reports a failure instead of throwing", async () => {
    const outcome = await ignoreForFileProviderSync(join(tmpdir(), `arena-missing-${Date.now()}`, "nothing"))
    expect(outcome.state).toBe("failed")
  })

  test.skipIf(darwin)("does nothing off macOS", async () => {
    expect(await ignoreForFileProviderSync(tmpdir())).toEqual({ state: "unsupported" })
  })

  test.skipIf(!darwin)("marks the pool root an ignored-content snapshot creates", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-file-provider-pool-test-"))
    try {
      await $`git init -q ${root}`
      await $`git -C ${root} config user.email arena@example.test`
      await $`git -C ${root} config user.name Arena`
      await writeFile(join(root, ".gitignore"), "ignored/\n")
      await $`git -C ${root} add .gitignore`
      await $`git -C ${root} commit -qm initial`
      await mkdir(join(root, "ignored"))
      await writeFile(join(root, "ignored", "file.txt"), "ignored\n")

      await createIgnoredContentSnapshot({ canonical: root })
      expect(await hasFileProviderIgnore(join(root, ".agent-duel"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
