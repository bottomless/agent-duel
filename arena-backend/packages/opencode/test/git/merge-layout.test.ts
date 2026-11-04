import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Git } from "../../src/git"

test("2.0 Git invalidates cached layout after the worktree link changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arena-merge-layout-"))
  const run = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" }).toString().trim()
  try {
    run("init", "-q")
    run("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "init")
    const a = path.join(directory, "a")
    const b = path.join(directory, "b")
    run("worktree", "add", "-q", "--detach", a)
    run("worktree", "add", "-q", "--detach", b)
    await Effect.gen(function* () {
      const git = yield* Git.Service
      const discover = (cwd: string) => git.run(["rev-parse", "--absolute-git-dir"], { cwd }).pipe(Effect.map((result) => result.text().trim()))
      const before = yield* discover(a)
      expect(yield* discover(a)).toBe(before)
      yield* Effect.promise(async () => fs.writeFile(path.join(a, ".git"), await fs.readFile(path.join(b, ".git"))))
      expect(yield* discover(a)).toBe(yield* discover(b))
      expect(yield* discover(a)).not.toBe(before)
    }).pipe(Effect.provide(LayerNode.compile(Git.node)), Effect.scoped, Effect.runPromise)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
