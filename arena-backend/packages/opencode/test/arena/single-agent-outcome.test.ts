import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import * as AssignmentClient from "@/arena/assignment-client"
import { connectLocalStore } from "@/arena/local-store"
import { project } from "@/arena/public"
import type { ChatDocument } from "@/arena/records"
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

const sessionID = SessionID.make("ses_rating_outcome")
const messageID = MessageID.make("msg_rating_prompt")
const model = { providerID: Provider.ID.make("arena"), modelID: Model.ID.make("contestant") }
const at = new Date("2026-11-02T00:00:00.000Z")

function transcript(outcome: "incomplete" | "failed" | "finished" | "stopped" | "tools"): SessionV1.WithParts[] {
  return [
    { info: { id: messageID, sessionID, role: "user", agent: "build", model, time: { created: 1 } }, parts: [] },
    {
      info: {
        id: MessageID.make("msg_rating_response"),
        sessionID,
        parentID: messageID,
        role: "assistant",
        agent: "build",
        mode: "build",
        path: { cwd: "/fixture", root: "/fixture" },
        ...model,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2, ...(outcome === "incomplete" ? {} : { completed: 3 }) },
        ...(outcome === "incomplete"
          ? {}
          : { finish: outcome === "failed" ? "error" : outcome === "tools" ? "tool-calls" : "stop" }),
        ...(outcome === "failed"
          ? {
              error: {
                name: "APIError",
                data: { message: "Invalid model request", statusCode: 400, isRetryable: false },
              },
            }
          : {}),
        ...(outcome === "stopped" ? { error: { name: "MessageAbortedError", data: { message: "Stopped" } } } : {}),
      },
      parts: [],
    },
  ]
}

function chat(root: string, head: string): ChatDocument {
  return {
    _id: "rating-chat",
    repository: { projectID: "fixture", root },
    initialCanonicalSHA: head,
    currentCanonicalSHA: head,
    canonicalSessionID: sessionID,
    canonicalTranscriptHash: "before",
    canonicalTranscriptVersion: 0,
    turnCount: 0,
    status: "ready",
    agentDuelCommit: "fixture",
    agentDuelBuildNumber: 0,
    opencodeVersion: "2.0.32",
    agentDuelVersion: "fixture",
    configuration: {
      modelPool: "fixture",
      agent: "fixture",
      plugins: "fixture",
      mcp: "fixture",
      skills: "fixture",
      tools: "fixture",
      system: "fixture",
    },
    utilityPromptVersion: "fixture",
    createdAt: at,
    updatedAt: at,
  }
}

function serviceLayer(messages: readonly SessionV1.WithParts[]) {
  return ArenaService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Config.Service, {}),
        Layer.mock(InstanceStore.Service, {}),
        LayerNode.compile(Git.node),
        Layer.mock(Session, { messages: () => Effect.succeed(messages) }),
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

afterEach(() => {
  delete process.env.OPENCODE_ARENA
  setStoreForTest(undefined)
  registry.assignments.clear()
})

describe("Frontier rating outcomes", () => {
  for (const outcome of ["incomplete", "failed", "finished", "stopped"] as const) {
    test(`normal completion: ${outcome}`, async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "arena-rating-outcome-")))
      const store = await connectLocalStore({ directory: join(directory, "arena") })
      const assignment = spyOn(AssignmentClient, "createSingleAssignment").mockResolvedValue({
        assignmentID: "fixture-assignment",
      })
      process.env.OPENCODE_ARENA = "1"
      setStoreForTest(store)
      const messages = transcript(outcome)
      try {
        await Bun.write(join(directory, ".gitignore"), "arena/\n")
        await $`git init -q ${directory}`.quiet()
        await $`git -c user.name=Fixture -c user.email=fixture@localhost -c commit.gpgsign=false commit --allow-empty -qm fixture`
          .cwd(directory)
          .quiet()
        const head = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const arena = yield* ArenaService.Service
              yield* arena.beginNormalTurn({ sessionID, messageID, model })
              // Attach only after admission so startup recovery has no unrelated chat to inspect.
              yield* Effect.promise(() => store.chats.insertOne(chat(directory, head)))
              yield* Effect.promise(() => Bun.write(join(directory, "partial.txt"), "keep partial work\n"))
              yield* arena.recordNormalTurn({ sessionID, messageID })
            }),
          ).pipe(Effect.provide(serviceLayer(messages))),
        )

        const rating = await store.singleAgentRating(sessionID, messageID)
        const pending = await store.pendingSingleAgentRating(sessionID)
        const snapshot = project(await store.snapshot("rating-chat"))
        if (outcome === "failed" || outcome === "incomplete") {
          expect(rating).toBeNull()
          expect(pending).toBeNull()
          expect(snapshot.singleAgent).toBeUndefined()
        } else {
          expect(rating?.completedAt).toBeInstanceOf(Date)
          expect(snapshot.singleAgent?.ratingRequired).toBe(outcome === "finished")
          expect(Boolean(pending)).toBe(outcome === "finished")
          expect(Boolean(rating?.stoppedAt)).toBe(outcome === "stopped")
          expect(rating?.resultTree).toBeString()
        }
        expect(await readFile(join(directory, "partial.txt"), "utf8")).toBe("keep partial work\n")
        expect((await store.chat("rating-chat"))?.canonicalTranscriptVersion).toBe(1)
      } finally {
        assignment.mockRestore()
        await store.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  for (const outcome of ["incomplete", "failed", "finished", "stopped", "tools"] as const) {
    for (const completed of [false, true]) {
      if (outcome === "stopped" && completed) continue
      test(`restart recovery: ${outcome}, saved rating completed=${completed}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "arena-rating-restart-"))
        let store = await connectLocalStore({ directory })
        const assignment = spyOn(AssignmentClient, "createSingleAssignment").mockResolvedValue({
          assignmentID: "followup-assignment",
        })
        process.env.OPENCODE_ARENA = "1"
        try {
          await store.claimSingleAgentRating({
            _id: "interrupted-rating",
            sessionID,
            messageID,
            modelSize: "frontier",
            assignment: {
              assignmentID: "interrupted-assignment",
              requestedReasoning: { effort: "high" },
              enforcedReasoning: { effort: "high" },
            },
            createdAt: at,
            updatedAt: at,
            ...(completed ? { completedAt: at } : {}),
          })
          // Reopen the on-disk state with a fresh service and no process-local reservation,
          // as after an engine kill. No process or inference is started by this test.
          await store.close()
          store = await connectLocalStore({ directory })
          setStoreForTest(store)
          const followupID = MessageID.make("msg_rating_followup")
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const arena = yield* ArenaService.Service
                const result = yield* arena
                  .beginNormalTurn({ sessionID, messageID: followupID, model })
                  .pipe(Effect.result)
                if (outcome === "finished") {
                  expect(result._tag).toBe("Failure")
                  if (result._tag === "Failure") expect(result.failure.message).toContain("must be rated")
                  expect(assignment).not.toHaveBeenCalled()
                } else {
                  expect(result._tag).toBe("Success")
                  expect(assignment).toHaveBeenCalledTimes(1)
                  // Finish the admitted follow-up without a response; it should leave no rating.
                  yield* arena.recordNormalTurn({ sessionID, messageID: followupID })
                }
              }),
            ).pipe(Effect.provide(serviceLayer(transcript(outcome)))),
          )
          const rating = await store.singleAgentRating(sessionID, messageID)
          if (outcome === "finished") {
            expect((await store.pendingSingleAgentRating(sessionID))?._id).toBe("interrupted-rating")
            expect(rating?.completedAt).toBeInstanceOf(Date)
          } else {
            expect(await store.pendingSingleAgentRating(sessionID)).toBeNull()
            if (outcome === "stopped") expect(rating?.stoppedAt).toBeInstanceOf(Date)
            else expect(rating).toBeNull()
          }
        } finally {
          assignment.mockRestore()
          await store.close()
          await rm(directory, { recursive: true, force: true })
        }
      })
    }
  }
})
