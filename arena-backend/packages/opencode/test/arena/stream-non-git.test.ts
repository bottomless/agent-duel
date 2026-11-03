import { afterEach, expect, test } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { connectLocalStore } from "@/arena/local-store"
import { setStoreForTest } from "@/arena/runtime"
import { ArenaService } from "@/arena/service"
import {
  MoveSessionService,
  Permission,
  Question,
  Session,
  SessionPrompt,
  SessionStatus,
} from "@/arena/session-runtime"
import { SessionV1 } from "@/arena/session-shape"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"

const original = process.env.OPENCODE_ARENA
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "arena-stream-non-git-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

afterEach(() => {
  setStoreForTest(undefined)
  if (original === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = original
})

function layer(directory: string) {
  const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)({
    id: "ses_non_git",
    slug: "non-git",
    projectID: "global",
    directory,
    version: "2.0.32",
    time: { created: 1, updated: 1 },
  })
  return ArenaService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        LayerNode.compile(Git.node),
        Layer.mock(Session, { get: () => Effect.succeed(info) }),
        Layer.mock(Config.Service, {}),
        Layer.mock(InstanceStore.Service, {}),
        Layer.mock(SessionPrompt, {}),
        Layer.mock(Image.Service, {}),
        Layer.mock(SessionStatus, {}),
        Layer.mock(Permission, {}),
        Layer.mock(Question, {}),
        Layer.mock(Worktree.Service, {}),
        Layer.mock(MoveSessionService, {}),
      ),
    ),
  )
}

test("ends a non-Git chat watch without creating a battle, including on reopen", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory
    const store = yield* Effect.acquireRelease(
      Effect.promise(() => connectLocalStore({ directory: join(directory, "state") })),
      (store) => Effect.promise(() => store.close()),
    )
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    for (let open = 0; open < 2; open++) {
      const frames = yield* Effect.gen(function* () {
        const arena = yield* ArenaService.Service
        return yield* (yield* arena.stream("ses_non_git")).pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer(directory)))
      expect(frames).toEqual([{ kind: "reset", code: "not_battle_repository", reason: "No battle repository" }])
      expect(yield* Effect.promise(() => store.chatForSession("ses_non_git"))).toBeUndefined()
    }
  }).pipe(Effect.scoped, Effect.runPromise))

test("does not treat an unavailable directory as a non-Git chat", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory
    const store = yield* Effect.acquireRelease(
      Effect.promise(() => connectLocalStore({ directory: join(directory, "state") })),
      (store) => Effect.promise(() => store.close()),
    )
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const result = yield* Effect.gen(function* () {
      const arena = yield* ArenaService.Service
      return yield* arena.stream("ses_non_git")
    }).pipe(Effect.provide(layer(join(directory, "missing"))), Effect.result)
    expect(result._tag).toBe("Failure")
  }).pipe(Effect.scoped, Effect.runPromise))
