import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { InstanceStore } from "@/project/instance-store"

const it = test

describe("Arena V2 instance context", () => {
  it("keeps a linked checkout as the active worktree while retaining the primary project", async () => {
    const layer = LayerNode.compile(InstanceStore.node, {
      replacements: [InstanceStore.locationServiceMapNode.replace(buildLocationServiceMap())],
    })
    await Effect.gen(function* () {
      const primary = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "arena-v2-instance-")).then(realpath)),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      yield* Effect.promise(() => $`git init -q`.cwd(primary).quiet())
      yield* Effect.promise(() => $`git config user.email arena@example.test`.cwd(primary).quiet())
      yield* Effect.promise(() => $`git config user.name Arena`.cwd(primary).quiet())
      yield* Effect.promise(() => writeFile(path.join(primary, "README.md"), "arena"))
      yield* Effect.promise(() => $`git add README.md`.cwd(primary).quiet())
      yield* Effect.promise(() => $`git commit -qm initial`.cwd(primary).quiet())
      const linked = path.join(path.dirname(primary), `${path.basename(primary)}-linked`)
      yield* Effect.promise(() => $`git worktree add ${linked} -b arena-linked-${Date.now()}`.cwd(primary).quiet())
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${linked}`.cwd(primary).quiet().nothrow()).pipe(
          Effect.asVoid,
        ),
      )

      const store = yield* InstanceStore.Service
      const primaryContext = yield* store.load({ directory: primary })
      const linkedContext = yield* store.load({ directory: linked })

      expect(linkedContext.directory).toBe(linked)
      expect(linkedContext.worktree).toBe(linked)
      expect(linkedContext.project.id).toBe(primaryContext.project.id)
      expect(linkedContext.project.worktree).toBe(primary)
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  })
})
