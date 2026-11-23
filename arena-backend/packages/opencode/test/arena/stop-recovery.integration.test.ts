import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { RunDocument } from "@/arena/records"
import { registry, setStoreForTest } from "@/arena/runtime"
import { ArenaService } from "@/arena/service"
import {
  MoveSessionService,
  Permission,
  Question,
  Session,
  SessionPrompt,
  SessionStatus,
} from "@/arena/session-runtime"
import type { SessionV1 } from "@/arena/session-shape"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { installOpenRouterStub, waitForTurn } from "./harness"

afterEach(() => {
  delete process.env.OPENCODE_ARENA
  delete process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS
  delete process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS
  setStoreForTest(undefined)
  registry.assignments.clear()
})

let nextSessionSeq = 0
const nextSessionID = () => SessionID.make(`ses_stop_recovery_${++nextSessionSeq}`)

interface SessionRecord {
  info: SessionV1.SessionInfo
  messages: SessionV1.WithParts[]
}

function makeSessionInfo(id: SessionID, directory: string, title = "Fixture"): SessionV1.SessionInfo {
  const now = Date.now()
  return {
    id,
    slug: id,
    projectID: "fixture",
    directory,
    title,
    version: "2.3.2",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    time: { created: now, updated: now },
  }
}

function completedMessages(sessionID: SessionID, directory: string, promptText: string): SessionV1.WithParts[] {
  const now = Date.now()
  const model = { providerID: Provider.ID.make("arena"), modelID: Model.ID.make("contestant") }
  const userID = MessageID.ascending()
  const assistantID = MessageID.ascending()
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        agent: "build",
        model,
        time: { created: now - 50 },
      },
      parts: [
        {
          id: `prt_${userID}`,
          sessionID,
          messageID: userID,
          type: "text",
          text: promptText,
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        parentID: userID,
        role: "assistant",
        agent: "build",
        mode: "build",
        path: { cwd: directory, root: directory },
        ...model,
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        time: { created: now - 40, completed: now - 10 },
      },
      parts: [
        {
          id: `prt_${assistantID}`,
          sessionID,
          messageID: assistantID,
          type: "text",
          text: "Done.",
        },
      ],
    },
  ]
}

function inProgressMessages(sessionID: SessionID, directory: string, promptText: string): SessionV1.WithParts[] {
  const now = Date.now()
  const model = { providerID: Provider.ID.make("arena"), modelID: Model.ID.make("contestant") }
  const userID = MessageID.ascending()
  const assistantID = MessageID.ascending()
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        agent: "build",
        model,
        time: { created: now - 50 },
      },
      parts: [
        {
          id: `prt_${userID}`,
          sessionID,
          messageID: userID,
          type: "text",
          text: promptText,
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        parentID: userID,
        role: "assistant",
        agent: "build",
        mode: "build",
        path: { cwd: directory, root: directory },
        ...model,
        cost: 0,
        tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now - 40 },
      },
      parts: [
        {
          id: `prt_${assistantID}`,
          sessionID,
          messageID: assistantID,
          type: "text",
          text: "Still working...",
        },
      ],
    },
  ]
}

type SecondSideBehavior = "cancelable" | "stuck"

function createFixtureLayer(root: string, canonicalID: SessionID, secondSideBehavior: SecondSideBehavior) {
  let hungGitDirectory: string | undefined
  const gitLayer = Layer.effect(
    Git.Service,
    Effect.map(Git.Service, (git) => ({
      ...git,
      run: (args, options) => (options.cwd === hungGitDirectory ? Effect.never : git.run(args, options)),
    })),
  ).pipe(Layer.provide(LayerNode.compile(Git.node)))
  const sessions = new Map<string, SessionRecord>()
  sessions.set(canonicalID, { info: makeSessionInfo(canonicalID, root, "Canonical"), messages: [] })

  const activeSignals = new Map<string, Deferred.Deferred<void>>()
  let promptOrdinal = 0
  let currentDirectory = root

  const layer = ArenaService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({}),
        }),
        Layer.mock(InstanceStore.Service, {
          provide: ({ directory }, effect) =>
            Effect.suspend(() => {
              const previous = currentDirectory
              currentDirectory = directory
              return effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    currentDirectory = previous
                  }),
                ),
              )
            }),
          disposeDirectory: () => Effect.void,
        }),
        gitLayer,
        Layer.mock(Session, {
          get: (id) =>
            Effect.sync(() => {
              const found = sessions.get(id)
              if (!found) throw new Error(`Session not found: ${id}`)
              return found.info
            }),
          create: (input) =>
            Effect.sync(() => {
              const id = nextSessionID()
              const info = makeSessionInfo(id, currentDirectory, input?.title ?? "Contestant")
              sessions.set(id, { info, messages: [] })
              return info
            }),
          children: () => Effect.succeed([]),
          messages: ({ sessionID }) => Effect.succeed(sessions.get(sessionID)?.messages ?? []),
          canonicalMessages: () => Effect.succeed([]),
          pending: () => Effect.succeed([]),
          deliverPending: () => Effect.succeed(0),
          fork: ({ sessionID }) =>
            Effect.sync(() => {
              const source = sessions.get(sessionID)
              const id = nextSessionID()
              const info = makeSessionInfo(id, source?.info.directory ?? currentDirectory, "Forked")
              sessions.set(id, { info, messages: source ? [...source.messages] : [] })
              return info
            }),
          updateMessage: (message) =>
            Effect.sync(() => {
              const rec = sessions.get(message.sessionID)
              if (rec) {
                rec.messages = rec.messages.map((item) =>
                  item.info.id === message.id ? { ...item, info: message } : item,
                )
              }
              return message
            }),
          updatePart: (part) =>
            Effect.sync(() => {
              const rec = sessions.get(part.sessionID)
              if (rec) {
                rec.messages = rec.messages.map((item) =>
                  item.info.id === part.messageID
                    ? { ...item, parts: item.parts.map((p) => (p.id === part.id ? part : p)) }
                    : item,
                )
              }
              return part
            }),
          setAgentModel: () => Effect.void,
          messageSeqs: () => Effect.succeed(new Map()),
          setPermission: ({ sessionID, permission }) =>
            Effect.sync(() => {
              const rec = sessions.get(sessionID)
              if (rec) rec.info = { ...rec.info, permission }
            }),
          remove: (sessionID) =>
            Effect.sync(() => {
              sessions.delete(sessionID)
            }),
        }),
        Layer.mock(SessionPrompt, {
          prepare: () => Effect.void,
          working: () => Effect.succeed(false),
          pendingShells: () => Effect.succeed([]),
          holdChildResults: () => Effect.void,
          join: ({ sessionID }) => Effect.succeed(sessions.get(sessionID)?.messages.at(-1)),
          loop: ({ sessionID }) => Effect.succeed(sessions.get(sessionID)?.messages.at(-1)),
          prompt: (input) =>
            Effect.gen(function* () {
              const ordinal = ++promptOrdinal
              const rec = sessions.get(input.sessionID)
              const dir = rec?.info.directory ?? currentDirectory
              if (ordinal === 1) {
                // Side 1 finishes cleanly right away (tool execution is gated until environment verification finishes).
                const msgs = completedMessages(input.sessionID, dir, "prompt")
                if (rec) rec.messages = msgs
                return msgs.at(-1)
              }
              // Side 2 stays in progress until cancelled (or hangs forever if testing stuck stopping).
              const msgs = inProgressMessages(input.sessionID, dir, "prompt")
              if (rec) rec.messages = msgs
              if (secondSideBehavior === "stuck") {
                return yield* Effect.never
              }
              const gate = yield* Deferred.make<void>()
              activeSignals.set(input.sessionID, gate)
              yield* Deferred.await(gate)
              const aborted: SessionV1.WithParts[] = msgs.map((item) =>
                item.info.role === "assistant"
                  ? {
                      ...item,
                      info: {
                        ...item.info,
                        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
                        time: { ...item.info.time, completed: Date.now() },
                      },
                    }
                  : item,
              )
              if (rec) rec.messages = aborted
              return aborted.at(-1)
            }),
          cancel: (sessionID) =>
            Effect.gen(function* () {
              if (secondSideBehavior === "stuck") return
              const gate = activeSignals.get(sessionID)
              if (gate) {
                activeSignals.delete(sessionID)
                yield* Deferred.succeed(gate, undefined)
              }
            }),
        }),
        Layer.mock(Image.Service, {}),
        Layer.mock(SessionStatus, {
          get: () => Effect.succeed({ type: "idle" as const }),
        }),
        Layer.mock(Permission, {
          list: () => Effect.succeed([]),
          setAutoAccept: () => Effect.void,
        }),
        Layer.mock(Question, {
          list: () => Effect.succeed([]),
        }),
        Layer.mock(Worktree.Service, {
          reclaimWorktreeInfo: (input) =>
            Effect.promise(async () => {
              const name = input.name ?? `slot-${Date.now()}`
              const worktreeDir = path.join(root, ".agent-duel", "worktrees", name)
              const hostDir = path.join(root, ".agent-duel", "hosts", `${name}.git`)
              await mkdir(path.dirname(worktreeDir), { recursive: true })
              await mkdir(path.dirname(hostDir), { recursive: true })
              await rm(hostDir, { recursive: true, force: true }).catch(() => undefined)
              await $`git init --bare -q ${hostDir}`.quiet()
              return {
                name,
                branch: input.branch ?? `arena/${name}`,
                directory: worktreeDir,
                host: hostDir,
              }
            }),
          attachAt: (info, ref) =>
            Effect.promise(async () => {
              const host = info.host ?? root
              await rm(info.directory, { recursive: true, force: true }).catch(() => undefined)
              if (info.host) {
                await $`git --git-dir=${host} fetch -q ${root} ${ref}`.quiet()
                await $`git --git-dir=${host} worktree add --force --detach ${info.directory} FETCH_HEAD`.quiet()
              } else {
                await $`git worktree add --force --detach ${info.directory} ${ref}`.cwd(root).quiet()
              }
            }),
          remove: ({ directory }) =>
            Effect.promise(async () => {
              await rm(directory, { recursive: true, force: true }).catch(() => undefined)
            }),
          retire: (directory) =>
            Effect.promise(async () => {
              await rm(directory, { recursive: true, force: true }).catch(() => undefined)
            }),
          sweepTrash: () => Effect.void,
          drainTrash: () => Effect.void,
        }),
        Layer.mock(MoveSessionService, {
          moveSession: ({ sessionID, directory }) =>
            Effect.sync(() => {
              const rec = sessions.get(sessionID)
              if (rec) rec.info = { ...rec.info, directory }
            }),
        }),
      ),
    ),
  )

  return {
    layer,
    sessions,
    hangGitIn: (directory: string) => {
      hungGitDirectory = directory
    },
  }
}

async function createRepo() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "arena-stop-recovery-")))
  const repo = path.join(dir, "repo")
  const dataDir = path.join(dir, "arena-store")
  await mkdir(repo, { recursive: true })
  await $`git init -q`.cwd(repo).quiet()
  await $`git config user.email test@example.com`.cwd(repo).quiet()
  await $`git config user.name Test`.cwd(repo).quiet()
  await writeFile(path.join(repo, ".gitignore"), ".agent-duel/\n")
  await writeFile(path.join(repo, "README.md"), "initial\n")
  await $`git add .gitignore README.md`.cwd(repo).quiet()
  await $`git commit -q -m "initial"`.cwd(repo).quiet()
  return {
    dir,
    repo,
    dataDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

async function waitForRun(store: Store, turnID: string, predicate: (run: RunDocument) => boolean, label: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const runs = await store.runsForTurn(turnID)
    const found = runs.find(predicate)
    if (found) return found
    await Bun.sleep(15)
  }
  throw new Error(`Timed out waiting for run: ${label}`)
}

describe("Arena stop recovery, watchdog, and finalization timings", () => {
  test("archives an empty draft without admitting a turn", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const arena = yield* ArenaService.Service
          const empty = yield* arena.session(canonicalID)
          expect(empty.chat.status).toBe("ready")
          const archived = yield* arena.archiveSession(canonicalID, { onlyIfEmpty: true })
          expect(archived?.chat.status).toBe("archived")
          expect(archived?.history).toEqual([])
        }).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("preserves a completed side on live Stop and records finalization timings", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Side 1 completes before stop.")
            const turnID = started.turn!.id
            // A snapshot taken before admission was empty. The cleanup must recheck at the engine.
            const cleanupAttempt = yield* arena.archiveSession(canonicalID, { onlyIfEmpty: true }).pipe(Effect.flip)
            expect(cleanupAttempt.message).toBe("Arena draft already has a turn")
            expect((yield* Effect.promise(() => store.chat(resolved.chat.id)))?.activeTurnID).toBe(turnID)

            const finished = yield* Effect.promise(() =>
              waitForRun(
                store,
                turnID,
                (run) => run.runState === "complete" && run.finalizedAt !== undefined,
                "first side to finalize cleanly",
              ),
            )
            expect(finished.finalizationTimings).toMatchObject({
              pauseMs: expect.any(Number),
              gitFinalizeMs: expect.any(Number),
              resumeMs: expect.any(Number),
              importRefsMs: expect.any(Number),
              archiveMs: expect.any(Number),
              totalMs: expect.any(Number),
            })

            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
            expect((yield* arena.stop(turnID)).turn?.state).toBe("awaiting_stop_resolution")

            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            const preserved = runs.find((run) => run._id === finished._id)
            const stopped = runs.find((run) => run._id !== finished._id)
            expect(preserved?.runState).toBe("complete")
            expect(preserved?.selectable).toBe(true)
            expect(preserved?.error).toBeUndefined()
            expect(preserved?.durationMs).toBeGreaterThanOrEqual(0)
            expect(stopped?.runState).toBe("stopped")
            expect(stopped?.finalizedAt).toBeDefined()
          }),
        ).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("preserves a completed side when restarting while a stopped battle is still stopping", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    let store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    const canonicalID = nextSessionID()
    const fixture1 = createFixtureLayer(repo, canonicalID, "stuck")

    let turnID = ""
    let finishedRunID = ""
    let originalDuration: number | null | undefined
    let originalCommit: string | undefined

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Restart while stopping.")
            turnID = started.turn!.id

            const finished = yield* Effect.promise(() =>
              waitForRun(
                store,
                turnID,
                (run) => run.runState === "complete" && run.finalizedAt !== undefined,
                "first side finished before simulated crash in stopping",
              ),
            )
            finishedRunID = finished._id
            originalDuration = finished.durationMs
            originalCommit = finished.finalCommit

            // Simulate user clicking Stop and engine crashing before Side 2 settles.
            yield* Effect.promise(() => store.transitionTurn(turnID, "stopping"))
          }),
        ).pipe(Effect.provide(fixture1.layer)),
      )

      // Reopen store and start a brand-new ArenaService (engine restart recovery).
      await store.close()
      store = await connectLocalStore({ directory: dataDir })
      setStoreForTest(store)
      const fixture2 = createFixtureLayer(repo, canonicalID, "cancelable")
      // Seed the restarted session store with the two runs' root sessions so recovery can archive Side 2.
      for (const run of await store.runsForTurn(turnID)) {
        const sid = SessionID.make(run.rootSessionID)
        fixture2.sessions.set(sid, {
          info: makeSessionInfo(sid, run.worktree, `Side ${run.side}`),
          messages: inProgressMessages(sid, run.worktree, "Restart while stopping."),
        })
      }

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const recovered = yield* arena.session(canonicalID)
            expect(recovered.turn?.state).toBe("awaiting_stop_resolution")
            expect(recovered.turn?.comparisonState).toBe("skipped")

            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            const preserved = runs.find((run) => run._id === finishedRunID)
            const stoppedSide = runs.find((run) => run._id !== finishedRunID)
            expect(preserved?.runState).toBe("complete")
            expect(preserved?.durationMs).toBe(originalDuration)
            expect(preserved?.finalCommit).toBe(originalCommit)
            expect(preserved?.selectable).toBe(true)
            expect(preserved?.error).toBeUndefined()
            expect(stoppedSide?.runState).toBe("stopped")
            expect(stoppedSide?.finalizedAt).toBeDefined()
            expect(stoppedSide?.applicability).toBe("applicable")
          }),
        ).pipe(Effect.provide(fixture2.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test.each(["recover", "timeout", "discard"] as const)(
    "watchdog recovery: %s",
    async (scenario) => {
      const { repo, dataDir, cleanup } = await createRepo()
      const store = await connectLocalStore({ directory: dataDir })
      const router = installOpenRouterStub()
      process.env.OPENCODE_ARENA = "1"
      process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS = "150"
      if (scenario === "timeout") process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "1000"
      setStoreForTest(store)

      const canonicalID = nextSessionID()
      const fixture = createFixtureLayer(repo, canonicalID, "stuck")

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const arena = yield* ArenaService.Service
              const resolved = yield* arena.session(canonicalID)
              const started = yield* arena.startTurn(resolved.chat.id, "Watchdog recovers stuck stopping side.")
              const turnID = started.turn!.id

              const finished = yield* Effect.promise(() =>
                waitForRun(
                  store,
                  turnID,
                  (run) => run.runState === "complete" && run.finalizedAt !== undefined,
                  "first side finalized before stop",
                ),
              )

              if (scenario !== "recover") {
                const stuck = yield* Effect.promise(() =>
                  waitForRun(store, turnID, (run) => run._id !== finished._id, "stuck side"),
                )
                fixture.hangGitIn(stuck.worktree)
              }
              const [stopping, repeated] = yield* Effect.all([arena.stop(turnID), arena.stop(turnID)], {
                concurrency: 2,
              })
              expect(stopping.turn?.state).toBe("stopping")
              expect(repeated.turn?.stoppingAt).toBe(stopping.turn?.stoppingAt)
              expect(stopping.turn?.canDiscardBattle).toBe(true)
              expect(stopping.turn?.stoppingAt).toBeDefined()

              if (scenario !== "recover") {
                const recovering = yield* Effect.promise(() => waitForTurn(store, turnID, "interrupted_recovery"))
                expect(recovering.transitionTimestamps.stopping).toEqual(new Date(stopping.turn!.stoppingAt!))
                yield* Effect.gen(function* () {
                  while (true) {
                    const turn = yield* Effect.promise(() => store.turn(turnID))
                    if (turn?.activeOperations?.includes("snapshotting_changes")) return
                    yield* Effect.sleep("5 millis")
                  }
                }).pipe(Effect.timeout("2 seconds"))
                const stillStopping = yield* arena.stop(turnID)
                expect(stillStopping.turn).toMatchObject({
                  state: "interrupted_recovery",
                  canDiscardBattle: true,
                  stoppingAt: stopping.turn?.stoppingAt,
                  activeOperations: expect.arrayContaining(["snapshotting_changes"]),
                })
                if (scenario === "discard") {
                  // The Git test double never returns. Discard must interrupt it, not await its deadline.
                  const discarded = yield* arena.resolveStop(turnID, "discard").pipe(Effect.timeout("5 seconds"))
                  expect(discarded.chat.status).toBe("ready")
                  expect((yield* Effect.promise(() => store.turn(turnID)))?.state).toBe("discarded")
                  return
                }
              }

              // Without restarting, the watchdog fires, interrupts the hung fiber, runs
              // interrupted_recovery, and lands in awaiting_stop_resolution while preserving Side 1.
              const settled = yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
              expect(settled.transitionTimestamps.interrupted_recovery).toBeDefined()

              const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
              const preserved = runs.find((run) => run._id === finished._id)
              const recoveredSide = runs.find((run) => run._id !== finished._id)
              expect(preserved?.runState).toBe("complete")
              expect(preserved?.selectable).toBe(true)
              expect(preserved?.error).toBeUndefined()
              expect(recoveredSide?.runState).toBe("stopped")
              expect(recoveredSide?.finalizedAt).toBeDefined()
              if (scenario === "timeout") {
                expect(recoveredSide?.applicability).toBe("blocked")
                expect(recoveredSide?.error).toContain("Git timed out while reading result refs")
                expect(recoveredSide?.finalizationTimings).toMatchObject({
                  failedStep: "snapshotting_changes",
                  gitFinalizeMs: expect.any(Number),
                })
              }
            }),
          ).pipe(Effect.provide(fixture.layer)),
        )
      } finally {
        router.restore()
        await store.close()
        await cleanup()
      }
    },
    30_000,
  )

  test("allows discarding a battle directly from a stuck stopping state", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS = "60000"
    setStoreForTest(store)

    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "stuck")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Discard while stuck stopping.")
            const turnID = started.turn!.id

            yield* Effect.promise(() =>
              waitForRun(
                store,
                turnID,
                (run) => run.runState === "complete" && run.finalizedAt !== undefined,
                "first side finalized before stop",
              ),
            )

            const stopping = yield* arena.stop(turnID)
            expect(stopping.turn?.state).toBe("stopping")
            expect(stopping.turn?.canDiscardBattle).toBe(true)
            expect(stopping.turn?.stoppingAt).toBeDefined()

            const discarded = yield* arena.resolveStop(turnID, "discard")
            expect(discarded.chat.status).toBe("ready")

            const storedTurn = yield* Effect.promise(() => store.turn(turnID))
            expect(storedTurn?.state).toBe("discarded")
            expect(storedTurn?.resolution).toEqual({ kind: "stopped", resolution: "discard" })
            const storedChat = yield* Effect.promise(() => store.chat(resolved.chat.id))
            expect(storedChat?.status).toBe("ready")
            expect(storedChat?.activeTurnID).toBeUndefined()

            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            expect(runs.every((run) => run.runState !== "pending")).toBe(true)
            expect(runs.every((run) => run.worktreeRemovedAt !== undefined)).toBe(true)
          }),
        ).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)
})
