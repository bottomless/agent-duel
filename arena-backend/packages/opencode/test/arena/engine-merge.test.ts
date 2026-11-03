import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Project } from "@opencode/schema/project"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionV1 } from "@/arena/session-shape"
import { Session, MoveSessionService, MessageID, SessionID } from "@/arena/session-runtime"
import { forkSessionInto } from "@/arena/fork"
import { listIgnoredRoots } from "@/arena/copy-snapshot"
import { KeepAlive } from "@/arena/keep-alive"
import { stopIdleKeepAlive } from "@/arena/runtime"
import { ArenaPrivacy } from "@/arena/privacy"
import { requestTooLargeMessage } from "@agent-duel/arena-service/request-error"
import { InstanceStore } from "@/project/instance-store"

describe("engine merge ports", () => {
  test("keeps the neutral request-size refusal without exposing upstream details", () => {
    const enabled = process.env.OPENCODE_ARENA
    process.env.OPENCODE_ARENA = "1"
    try {
      expect(
        ArenaPrivacy.event({
          type: "session.error",
          properties: {
            error: {
              name: "APIError",
              data: {
                message: requestTooLargeMessage,
                statusCode: 413,
                isRetryable: false,
                responseBody: "private model limits",
              },
            },
          },
        }),
      ).toEqual({
        type: "session.error",
        properties: {
          error: {
            name: "APIError",
            data: { message: requestTooLargeMessage, statusCode: 413, isRetryable: false },
          },
        },
      })
    } finally {
      if (enabled === undefined) delete process.env.OPENCODE_ARENA
      else process.env.OPENCODE_ARENA = enabled
    }
  })

  test("preserves empty-folder containers without folding a sync-filtered public sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arena-merge-ignored-"))
    await using root = { path: directory, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) }
    await $`git init -q ${root.path}`
    await writeFile(join(root.path, ".gitignore"), ".env\n.DS_Store\nlogs/\n")
    await mkdir(join(root.path, "conf"))
    await mkdir(join(root.path, "docs", "empty"), { recursive: true })
    await mkdir(join(root.path, "logs"))
    await writeFile(join(root.path, "conf", ".env"), "fixture value")
    const sibling = join(root.path, "conf", ".env 2")
    await writeFile(sibling, "fixture value")
    await writeFile(join(root.path, "docs", ".DS_Store"), "finder")
    expect((await listIgnoredRoots(root.path)).sort()).toEqual(["conf/.env", "docs", "logs"])
    await Bun.file(sibling).delete()
    expect((await listIgnoredRoots(root.path)).sort()).toEqual(["conf/.env", "docs", "logs"])
  })

  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.deleted",
  ]) {
    test(`stops cache pings when V2 emits ${type}`, () => {
      const scheduled = new Set<() => void>()
      const waits = new KeepAlive({
        now: () => 0,
        schedule: (run) => {
          scheduled.add(run)
          return () => void scheduled.delete(run)
        },
      })
      waits.begin("contestant")(() => Promise.resolve("kept"))
      expect(scheduled.size).toBe(1)
      stopIdleKeepAlive({ type, properties: { sessionID: "other" } }, waits)
      expect(scheduled.size).toBe(1)
      stopIdleKeepAlive({ type, properties: { sessionID: "contestant" } }, waits)
      expect(scheduled.size).toBe(0)
    })
  }

  test("keeps pings armed while a V2 session executes tools", () => {
    const scheduled = new Set<() => void>()
    const waits = new KeepAlive({
      now: () => 0,
      schedule: (run) => {
        scheduled.add(run)
        return () => void scheduled.delete(run)
      },
    })
    waits.begin("contestant")(() => Promise.resolve("kept"))
    stopIdleKeepAlive({ type: "session.step.ended", properties: { sessionID: "contestant" } }, waits)
    expect(scheduled.size).toBe(1)
    stopIdleKeepAlive(
      { type: "session.status", properties: { sessionID: "contestant", status: { type: "idle" } } },
      waits,
    )
    expect(scheduled.size).toBe(0)
  })

  test("passes each copied V2 message's source ID to the history retargeter", async () => {
    const sourceID = SessionID.make("ses_source")
    const copiedID = SessionID.make("ses_copied")
    const from = MessageID.ascending()
    const to = MessageID.ascending()
    const source: SessionV1.SessionInfo = {
      id: sourceID,
      projectID: Project.ID.make("project"),
      slug: "source",
      directory: "/source",
      version: "test",
      time: { created: 0, updated: 0 },
    }
    const part: SessionV1.TextPart = {
      id: SessionV1.PartID.ascending(),
      sessionID: copiedID,
      messageID: to,
      type: "text",
      text: "port 20001",
    }
    const written: SessionV1.Part[] = []
    const seen: (string | undefined)[] = []
    await Effect.runPromise(
      forkSessionInto({
        sessionID: sourceID,
        destination: "/copy",
        roots: { canonical: "/source", worktree: "/copy" },
        part(value, _info, sourceMessageID) {
          seen.push(sourceMessageID)
          return value.type === "text" ? { ...value, text: value.text.replace("20001", "20002") } : value
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Session, {
              get: () => Effect.succeed(source),
              fork: (input) => {
                input.onMessageMapping?.(new Map([[from, to]]))
                return Effect.succeed({ ...source, id: copiedID })
              },
              canonicalMessages: () => Effect.succeed([]),
              messages: () =>
                Effect.succeed([
                  {
                    info: {
                      id: to,
                      sessionID: copiedID,
                      role: "user",
                      agent: "build",
                      model: { providerID: Provider.ID.make("arena"), modelID: Model.ID.make("contestant") },
                      time: { created: 0 },
                    },
                    parts: [part],
                  },
                ]),
              updatePart: (value) =>
                Effect.sync(() => {
                  written.push(value)
                  return value
                }),
            }),
            Layer.mock(MoveSessionService, { moveSession: () => Effect.void }),
            // The fork's operations already hold their session adapter; no location services run here.
            Layer.mock(InstanceStore.Service, { provide: (_input, effect) => effect as never }),
          ),
        ),
      ),
    )
    expect(seen).toEqual([from])
    expect(written).toEqual([{ ...part, text: "port 20002" }])
  })
})
