import { $ } from "bun"
import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { changedBetweenBases, snapshotBase } from "../../src/arena/git"
import { Git } from "../../src/git"

test("lists what a chat changed between two turns' bases, committed or not", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "arena-earlier-files-")))
  try {
    await $`git init -q`.cwd(root).quiet()
    await $`git config user.name test && git config user.email test@localhost && git config commit.gpgsign false`
      .cwd(root)
      .quiet()
    await fs.writeFile(path.join(root, "kept.txt"), "kept\n")
    await fs.writeFile(path.join(root, "gone.txt"), "gone\n")
    await $`git add . && git commit -q -m first`.cwd(root).quiet()

    const changed = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* snapshotBase({ canonical: root })
        // An accepted winner's commit, then the user's own uncommitted edits before the next send.
        yield* Effect.promise(() => fs.mkdir(path.join(root, "prompts")))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "prompts/system.md"), "rule\n"))
        yield* Effect.promise(() => $`git add . && git commit -q -m winner`.cwd(root).quiet())
        yield* Effect.promise(() => fs.rm(path.join(root, "gone.txt")))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "notes.txt"), "uncommitted\n"))
        const later = yield* snapshotBase({ canonical: root })
        const between = { canonical: root, from: first.baseCommit, to: later.baseCommit }
        return {
          between: yield* changedBetweenBases(between),
          same: yield* changedBetweenBases({ ...between, from: later.baseCommit }),
        }
      }).pipe(Effect.provide(LayerNode.compile(LayerNode.group([Git.node]))), Effect.scoped),
    )
    expect(changed.between).toEqual(["gone.txt", "notes.txt", "prompts/system.md"])
    expect(changed.same).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
