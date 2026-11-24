import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
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
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { installOpenRouterStub, waitForTurn } from "./harness"

afterEach(() => {
  delete process.env.OPENCODE_ARENA
  delete process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS
  delete process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS
  delete process.env.OPENCODE_ARENA_DISCARD_REQUEST_TIMEOUT_MS
  delete process.env.OPENCODE_ARENA_CLEANUP_RETRY_MS
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

type SecondSideBehavior = "cancelable" | "stuck" | "slow-settlement"

function createFixtureLayer(root: string, canonicalID: SessionID, secondSideBehavior: SecondSideBehavior) {
  let hungGitDirectory: string | undefined
  let hangNextGit = false
  let interruptedGit: readonly string[] | undefined
  let failNextWorktreeRemove = false
  let hungFolder: string | undefined
  let heldGit: ((cwd: string, args: readonly string[]) => boolean) | undefined
  let wedgedGitDirectory: string | undefined
  const gitGate = Deferred.makeUnsafe<void>()
  const wedgedGitDone = Deferred.makeUnsafe<void>()
  const removalGate = Deferred.makeUnsafe<void>()
  let holdRemovals = false
  const gitLayer = Layer.effect(
    Git.Service,
    Effect.map(Git.Service, (git) => ({
      ...git,
      run: (args, options) => {
        if (hangNextGit) {
          hangNextGit = false
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interruptedGit = args
              }),
            ),
          )
        }
        if (options.cwd === wedgedGitDirectory) {
          wedgedGitDirectory = undefined
          // A step no interrupt reaches, which then finishes: the fiber outlives its interrupt.
          return Deferred.await(gitGate).pipe(
            Effect.andThen(git.run(args, options)),
            Effect.ensuring(Deferred.succeed(wedgedGitDone, undefined)),
            Effect.uninterruptible,
          )
        }
        if (heldGit?.(options.cwd, args)) return Deferred.await(gitGate).pipe(Effect.andThen(git.run(args, options)))
        return options.cwd === hungGitDirectory ? Effect.never : git.run(args, options)
      },
    })),
  ).pipe(Layer.provide(LayerNode.compile(Git.node)))
  const sessions = new Map<string, SessionRecord>()
  sessions.set(canonicalID, { info: makeSessionInfo(canonicalID, root, "Canonical"), messages: [] })

  const activeSignals = new Map<string, Deferred.Deferred<void>>()
  const settlePrompt = Deferred.makeUnsafe<void>()
  const cancelEntered = Deferred.makeUnsafe<void>()
  const acknowledgeCancel = Deferred.makeUnsafe<void>()
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
          load: ({ directory }) =>
            directory === hungFolder ? Effect.never : Effect.succeed({ directory } as InstanceContext),
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
              if (secondSideBehavior === "slow-settlement") yield* Deferred.await(settlePrompt)
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
              if (secondSideBehavior === "slow-settlement") {
                yield* Deferred.succeed(cancelEntered, undefined)
                yield* Deferred.await(acknowledgeCancel)
              }
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
            Effect.suspend(() => {
              if (failNextWorktreeRemove) {
                failNextWorktreeRemove = false
                return Effect.fail(new Error("Simulated worktree removal failure"))
              }
              return (holdRemovals ? Deferred.await(removalGate) : Effect.void).pipe(
                Effect.andThen(
                  Effect.promise(async () => {
                    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
                  }),
                ),
              )
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
    cancelEntered: Deferred.await(cancelEntered),
    acknowledgeCancel: Deferred.succeed(acknowledgeCancel, undefined),
    settlePrompt: Deferred.succeed(settlePrompt, undefined),
    hangFirstRecoveryGit: () => {
      hangNextGit = true
    },
    interruptedGit: () => interruptedGit,
    hangGitIn: (directory: string) => {
      hungGitDirectory = directory
    },
    failNextWorktreeRemove: () => {
      failNextWorktreeRemove = true
    },
    /** Git in matching folders waits for `releaseGit`, then runs: slow, not broken. */
    holdGit: (matches: (cwd: string, args: readonly string[]) => boolean) => {
      heldGit = matches
    },
    /** The next Git step in this folder ignores interrupts until `releaseGit`, then runs. */
    wedgeNextGitIn: (directory: string) => {
      wedgedGitDirectory = directory
    },
    releaseGit: Effect.suspend(() => {
      heldGit = undefined
      hungGitDirectory = undefined
      return Deferred.succeed(gitGate, undefined)
    }),
    wedgedGitDone: Deferred.await(wedgedGitDone),
    holdWorktreeRemovals: () => {
      holdRemovals = true
    },
    releaseWorktreeRemovals: Effect.suspend(() => {
      holdRemovals = false
      return Deferred.succeed(removalGate, undefined)
    }),
    /** Opening this folder never answers, as when the Git read of its layout hangs. */
    hangFolder: (directory: string | undefined) => {
      hungFolder = directory
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

          // A first send that failed before its chat existed leaves a session with no chat. That
          // is an empty draft too, unless the session already holds something the user sent.
          const unresolved = nextSessionID()
          fixture.sessions.set(unresolved, { info: makeSessionInfo(unresolved, repo, "Draft"), messages: [] })
          expect(yield* arena.archiveSession(unresolved, { onlyIfEmpty: true })).toBeNull()
          fixture.sessions.set(unresolved, {
            info: makeSessionInfo(unresolved, repo, "Draft"),
            messages: completedMessages(unresolved, repo, "Already sent."),
          })
          const refused = yield* Effect.flip(arena.archiveSession(unresolved, { onlyIfEmpty: true }))
          expect(refused.message).toBe("Arena draft already has a turn")
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
      process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "1000"
      fixture2.hangFirstRecoveryGit()
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
            expect(fixture2.interruptedGit()).toEqual(["rev-parse", "--path-format=absolute", "--git-common-dir"])
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
                expect(recoveredSide?.error).toBe(
                  "Arena result finalization failed\nGit timed out while reading result refs",
                )
                const decision = yield* arena.session(canonicalID)
                expect(decision.runs.find((run) => run.id === recoveredSide?._id)?.error).toBe(
                  "Git timed out before this side’s changes could be saved.",
                )
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

  test("times cancellation until the prompt settles, even after Core acknowledges both cancel calls", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "slow-settlement")
    const waitingForPrompt = Deferred.makeUnsafe<void>()
    const trace: { field: string; ms: number }[] = []
    const logger = Logger.make(({ message }) => {
      const [event, fields] = Array.isArray(message) ? message : []
      if (fields?.operation !== "stopping_agents") return
      if (event === "Arena side cancellation step ended") trace.push({ field: fields.timing, ms: fields.durationMs })
      if (event === "Arena side cancellation step started" && fields.timing === "cancelWaitMs") {
        Deferred.doneUnsafe(waitingForPrompt, Exit.void)
      }
    })

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const arena = yield* ArenaService.Service
          const { chat } = yield* arena.session(canonicalID)
          const started = yield* arena.startTurn(chat.id, "Cancel while a prompt is unwinding.")
          const id = started.turn!.id
          const finished = yield* Effect.promise(() =>
            waitForRun(store, id, (run) => !!run.finalizedAt, "first result"),
          )
          yield* arena.stop(id)
          yield* fixture.cancelEntered.pipe(Effect.timeout("5 seconds"))
          const beforeAck = (yield* arena.stop(id)).turn
          expect(beforeAck?.activeOperations).toEqual(["stopping_agents"])
          const firstStart = beforeAck?.operationProgress?.find((row) => row.operation === "stopping_agents")?.startedAt
          yield* fixture.acknowledgeCancel
          yield* Deferred.await(waitingForPrompt).pipe(Effect.timeout("5 seconds"))
          expect(trace.map((step) => step.field)).toEqual(["cancelMs", "cancelMs"])
          const waiting = yield* arena.stop(id)
          expect(waiting.turn).toMatchObject({
            state: "stopping",
            activeOperations: ["stopping_agents"],
            operationProgress: expect.arrayContaining([
              { operation: "stopping_agents", state: "running", startedAt: firstStart },
            ]),
          })
          const release = Date.now()
          yield* fixture.settlePrompt
          const decided = yield* Effect.promise(() => waitForTurn(store, id, "awaiting_stop_resolution"))
          const cancel = decided.operationProgress?.find((entry) => entry.operation === "stopping_agents")
          expect(cancel?.state === "completed" && cancel.finishedAt).toBeGreaterThanOrEqual(release)
          const runs = yield* Effect.promise(() => store.runsForTurn(id))
          expect(trace.map((step) => step.field)).toEqual(["cancelMs", "cancelMs", "cancelWaitMs"])
          expect(runs.find((run) => run._id !== finished._id)?.finalizationTimings).toMatchObject({
            cancelMs: trace[0]!.ms + trace[1]!.ms,
            cancelWaitMs: trace[2]!.ms,
            gitFinalizeMs: expect.any(Number),
          })
          expect(runs.find((run) => run._id === finished._id)?.finalizationTimings?.cancelMs).toBeUndefined()
        }).pipe(Effect.provide(fixture.layer), Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

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

  test("restart recovery skips a hung canonical inspection, and a request then waits for Git", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    let store = await connectLocalStore({ directory: dataDir })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture1 = createFixtureLayer(repo, canonicalID, "cancelable")
    let chatID = ""

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            expect(resolved.chat.status).toBe("ready")
            chatID = resolved.chat.id
          }),
        ).pipe(Effect.provide(fixture1.layer)),
      )

      // Reopen with Git slow in the canonical checkout.
      await store.close()
      store = await connectLocalStore({ directory: dataDir })
      setStoreForTest(store)
      const fixture2 = createFixtureLayer(repo, canonicalID, "cancelable")
      process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "300"
      fixture2.holdGit((cwd) => cwd === repo)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            // Recovery gates every call. It gives up on the inspection and leaves the chat ready.
            const started = Date.now()
            yield* Effect.exit(arena.stop("no-such-turn"))
            expect(Date.now() - started).toBeLessThan(10_000)
            expect((yield* Effect.promise(() => store.chat(chatID)))?.status).toBe("ready")

            // Opening the chat is not recovery: it waits for Git well past the limit, as main does,
            // and reads the checkout once Git answers.
            const opening = yield* arena.session(canonicalID).pipe(Effect.forkScoped)
            yield* Effect.sleep("1200 millis")
            expect(opening.pollUnsafe()).toBeUndefined()
            yield* fixture2.releaseGit
            const opened = yield* Fiber.join(opening)
            expect(opened.chat.status).toBe("ready")
          }),
        ).pipe(Effect.provide(fixture2.layer)),
      )
    } finally {
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("a running battle waits for slow Git instead of failing the side", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    // The Stop limit, far shorter than the Git below takes. It must not apply here.
    process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "300"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            // The first step of saving a side's changes, which no preparation step runs.
            fixture.holdGit((cwd, args) => cwd !== repo && args[0] === "status" && args.includes("--no-renames"))
            const started = yield* arena.startTurn(resolved.chat.id, "Slow Git is not a failed side.")
            const turnID = started.turn!.id

            // The side's answer is in and its changes are being saved, which is where Git is slow.
            yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete", "first side answered"),
            )
            yield* Effect.sleep("1200 millis")
            const waiting = yield* Effect.promise(() => store.runsForTurn(turnID))
            expect(waiting.some((run) => run.runState === "error" || run.error !== undefined)).toBe(false)
            expect(waiting.some((run) => run.finalizedAt !== undefined)).toBe(false)

            yield* fixture.releaseGit
            const saved = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side saved"),
            )
            expect(saved.selectable).toBe(true)
            expect(saved.error).toBeUndefined()
            expect(saved.finalCommit).toBeDefined()
            expect(saved.finalizationTimings?.failedStep).toBeUndefined()

            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
          }),
        ).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("a fiber the watchdog gave up on cannot write over recovery", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS = "150"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Stuck side outlives its interrupt.")
            const turnID = started.turn!.id
            const finished = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side"),
            )
            const stuck = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run._id !== finished._id, "second side"),
            )

            // The stopped side's save reaches a Git step that ignores the watchdog's interrupt.
            fixture.wedgeNextGitIn(stuck.worktree)
            yield* arena.stop(turnID)

            // Recovery goes ahead without that fiber and settles the side itself.
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
            const recovered = yield* Effect.promise(() => store.run(stuck._id))
            expect(recovered?.runState).toBe("stopped")
            expect(recovered?.finalizedAt).toBeDefined()
            expect(recovered?.finalCommit).toBeDefined()
            expect(recovered?.error).toBeUndefined()

            // The wedged step finishes and the old fiber unwinds. It writes nothing.
            yield* fixture.releaseGit
            yield* fixture.wedgedGitDone
            yield* Effect.sleep("500 millis")
            expect(yield* Effect.promise(() => store.run(stuck._id))).toEqual(recovered)
            expect((yield* Effect.promise(() => store.turn(turnID)))?.state).toBe("awaiting_stop_resolution")
          }),
        ).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("a Discard that cannot start in time is refused and never runs later", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    let store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture1 = createFixtureLayer(repo, canonicalID, "cancelable")
    let turnID = ""

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Discard during recovery.")
            turnID = started.turn!.id
            yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side"),
            )
            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
          }),
        ).pipe(Effect.provide(fixture1.layer)),
      )

      // Restart with Git slow in the checkout, so recovery outlasts the Discard's wait.
      await store.close()
      store = await connectLocalStore({ directory: dataDir })
      setStoreForTest(store)
      const fixture2 = createFixtureLayer(repo, canonicalID, "cancelable")
      for (const run of await store.runsForTurn(turnID)) {
        const sid = SessionID.make(run.rootSessionID)
        fixture2.sessions.set(sid, {
          info: makeSessionInfo(sid, run.worktree, `Side ${run.side}`),
          messages: completedMessages(sid, run.worktree, "Discard during recovery."),
        })
      }
      process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "20000"
      process.env.OPENCODE_ARENA_DISCARD_REQUEST_TIMEOUT_MS = "300"
      fixture2.holdGit((cwd) => cwd === repo)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const refused = yield* Effect.flip(arena.resolveStop(turnID, "discard"))
            expect(refused.message).toBe("Discard did not start in time, so the battle was not discarded. Try again.")

            // Recovery finishes. The Discard the engine refused does not run behind it.
            yield* fixture2.releaseGit
            yield* Effect.exit(arena.stop("no-such-turn"))
            yield* Effect.sleep("500 millis")
            const kept = yield* Effect.promise(() => store.turn(turnID))
            expect(kept?.state).toBe("awaiting_stop_resolution")
            expect(kept?.resolution).toBeUndefined()

            // Pressed again, it discards. Its cleanup outlasts the wait this time: the discard is
            // recorded, so the request answers with it rather than reporting a failure.
            fixture2.holdWorktreeRemovals()
            const answered = yield* arena.resolveStop(turnID, "discard")
            expect(answered.turn?.id ?? turnID).toBe(turnID)
            const recorded = yield* Effect.promise(() => store.turn(turnID))
            expect(recorded?.resolution).toEqual({ kind: "stopped", resolution: "discard" })
            expect(recorded?.state).toBe("discarding")

            yield* fixture2.releaseWorktreeRemovals
            yield* Effect.promise(() => waitForTurn(store, turnID, "discarded"))
            expect((yield* Effect.promise(() => store.chat(kept!.chatID)))?.status).toBe("ready")
          }),
        ).pipe(Effect.provide(fixture2.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("restart recovery gives up on a folder that will not open", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    let store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture1 = createFixtureLayer(repo, canonicalID, "stuck")
    let turnID = ""
    let finishedRunID = ""

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Folder will not open.")
            turnID = started.turn!.id
            const finished = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side"),
            )
            finishedRunID = finished._id
            yield* Effect.promise(() => store.transitionTurn(turnID, "stopping"))
          }),
        ).pipe(Effect.provide(fixture1.layer)),
      )

      await store.close()
      store = await connectLocalStore({ directory: dataDir })
      setStoreForTest(store)
      const fixture2 = createFixtureLayer(repo, canonicalID, "cancelable")
      process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "500"
      for (const run of await store.runsForTurn(turnID)) {
        const sid = SessionID.make(run.rootSessionID)
        fixture2.sessions.set(sid, {
          info: makeSessionInfo(sid, run.worktree, `Side ${run.side}`),
          messages: inProgressMessages(sid, run.worktree, "Folder will not open."),
        })
        if (run._id !== finishedRunID) fixture2.hangFolder(run.worktree)
      }

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const recovered = yield* arena.session(canonicalID)
            expect(recovered.turn?.state).toBe("awaiting_stop_resolution")
            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            const preserved = runs.find((run) => run._id === finishedRunID)
            const unopened = runs.find((run) => run._id !== finishedRunID)
            expect(preserved?.runState).toBe("complete")
            expect(preserved?.selectable).toBe(true)
            expect(unopened?.runState).toBe("stopped")
            expect(unopened?.selectable).toBe(false)
            expect(unopened?.error).toContain("Git timed out while opening the folder")
          }),
        ).pipe(Effect.provide(fixture2.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("retries a worktree cleanup a failed removal left behind", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    let store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture1 = createFixtureLayer(repo, canonicalID, "cancelable")

    let turnID = ""
    let strandedRunID = ""
    let strandedWorktree = ""

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Cleanup fails once.")
            turnID = started.turn!.id
            yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side"),
            )
            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))

            // One worktree removal fails (as a Git timeout would). Discard still completes, but the
            // run is marked so a later pass removes the worktree it left on disk.
            fixture1.failNextWorktreeRemove()
            const discarded = yield* arena.resolveStop(turnID, "discard")
            expect(discarded.chat.status).toBe("ready")

            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            const stranded = runs.find((run) => run.retention === "cleanup_failed" && !run.worktreeRemovedAt)
            expect(stranded).toBeDefined()
            strandedRunID = stranded!._id
            strandedWorktree = stranded!.worktree
            expect((yield* Effect.promise(() => store.turn(turnID)))?.cleanup?.state).toBe("failed")
            expect(existsSync(strandedWorktree)).toBe(true)
          }),
        ).pipe(Effect.provide(fixture1.layer)),
      )

      // Restart: recovery retries the failed cleanup in the background and removes the worktree.
      await store.close()
      store = await connectLocalStore({ directory: dataDir })
      setStoreForTest(store)
      const fixture2 = createFixtureLayer(repo, canonicalID, "cancelable")
      for (const run of await store.runsForTurn(turnID)) {
        const sid = SessionID.make(run.rootSessionID)
        fixture2.sessions.set(sid, {
          info: makeSessionInfo(sid, run.worktree, `Side ${run.side}`),
          messages: completedMessages(sid, run.worktree, "Cleanup fails once."),
        })
      }

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            yield* arena.session(canonicalID)
            const removed = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run._id === strandedRunID && !!run.worktreeRemovedAt, "retry removal"),
            )
            expect(removed.retention).toBe("none")
            expect((yield* Effect.promise(() => store.turn(turnID)))?.cleanup?.state).toBe("complete")
            expect(existsSync(strandedWorktree)).toBe(false)
          }),
        ).pipe(Effect.provide(fixture2.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("pressing Stop bounds an already-finished side whose Git save is still running", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    // Watchdog is far longer than the Git limit so the test proves the Git limit ended the save,
    // not the watchdog.
    process.env.OPENCODE_ARENA_STOP_WATCHDOG_MS = "60000"
    // Long enough for the stopped side's real save, each step of which takes up to about 1s under test load.
    process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "3000"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Stop while first side is saving.")
            const turnID = started.turn!.id
            // Hold only the first side's finalize step, leaving the second side free to save when
            // Stop cancels it.
            const firstRun = yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.side === "a", "side a created"),
            )
            fixture.holdGit(
              (cwd, args) => cwd === firstRun.worktree && args[0] === "status" && args.includes("--no-renames"),
            )

            // Side A answers and enters Git save while the battle is still running (unbounded).
            yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run._id === firstRun._id && run.runState === "complete", "side a answered"),
            )
            // Past the limit: a running battle does not bound the save.
            yield* Effect.sleep("4000 millis")
            const stillSaving = yield* Effect.promise(() => store.run(firstRun._id))
            expect(stillSaving?.finalizedAt).toBeUndefined()
            expect(stillSaving?.error).toBeUndefined()

            // Press Stop while Side A is already stuck inside Git save. Its in-flight save picks up
            // the 3000ms Git limit instead of waiting for the 60s watchdog.
            const stoppedAt = Date.now()
            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))
            expect(Date.now() - stoppedAt).toBeLessThan(10_000)

            const runs = yield* Effect.promise(() => store.runsForTurn(turnID))
            const timedOut = runs.find((run) => run._id === firstRun._id)
            const other = runs.find((run) => run._id !== firstRun._id)
            expect(timedOut?.finalizedAt).toBeDefined()
            expect(timedOut?.selectable).toBe(false)
            expect(timedOut?.error).toContain("Git timed out while saving worktree changes")
            expect(timedOut?.finalizationTimings?.failedStep).toBe("snapshotting_changes")
            expect(other?.runState).toBe("stopped")
            expect(other?.finalizedAt).toBeDefined()
            expect(other?.error).toBeUndefined()
          }),
        ).pipe(Effect.provide(fixture.layer)),
      )
    } finally {
      router.restore()
      await store.close()
      await cleanup()
    }
  }, 30_000)

  test("retries a worktree removal that timed out in Git once Git works again, without restarting", async () => {
    const { repo, dataDir, cleanup } = await createRepo()
    const store = await connectLocalStore({ directory: dataDir })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    process.env.OPENCODE_ARENA_FINALIZATION_GIT_TIMEOUT_MS = "250"
    process.env.OPENCODE_ARENA_CLEANUP_RETRY_MS = "100"
    setStoreForTest(store)
    const canonicalID = nextSessionID()
    const fixture = createFixtureLayer(repo, canonicalID, "cancelable")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const arena = yield* ArenaService.Service
            const resolved = yield* arena.session(canonicalID)
            const started = yield* arena.startTurn(resolved.chat.id, "Retry hung worktree removal.")
            const turnID = started.turn!.id
            yield* Effect.promise(() =>
              waitForRun(store, turnID, (run) => run.runState === "complete" && !!run.finalizedAt, "first side"),
            )
            yield* arena.stop(turnID)
            yield* Effect.promise(() => waitForTurn(store, turnID, "awaiting_stop_resolution"))

            // Worktree removal hangs as if Git wedged, so Discard hits its Git limit and leaves
            // the folders on disk marked `cleanup_failed`.
            fixture.holdWorktreeRemovals()
            const discarded = yield* arena.resolveStop(turnID, "discard")
            expect(discarded.chat.status).toBe("ready")

            const strandedRuns = (yield* Effect.promise(() => store.runsForTurn(turnID))).filter(
              (run) => run.retention === "cleanup_failed" && !run.worktreeRemovedAt,
            )
            expect(strandedRuns.length).toBeGreaterThan(0)
            for (const run of strandedRuns) expect(existsSync(run.worktree)).toBe(true)
            expect((yield* Effect.promise(() => store.turn(turnID)))?.cleanup?.state).toBe("failed")

            // Let a background retry hit the same hang and time out cleanly, then unblock Git.
            yield* Effect.sleep("450 millis")
            for (const run of strandedRuns) expect(existsSync(run.worktree)).toBe(true)
            yield* fixture.releaseWorktreeRemovals

            // Without restarting or starting another battle, the background retry removes every
            // stranded worktree and marks cleanup complete.
            for (const run of strandedRuns) {
              const removed = yield* Effect.promise(() =>
                waitForRun(store, turnID, (candidate) => candidate._id === run._id && !!candidate.worktreeRemovedAt, "background retry"),
              )
              expect(removed.retention).toBe("none")
              expect(existsSync(run.worktree)).toBe(false)
            }
            expect((yield* Effect.promise(() => store.turn(turnID)))?.cleanup?.state).toBe("complete")
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
