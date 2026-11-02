import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Project } from "@opencode/core/project"
import { Session as CoreSession } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { InstructionEntryTable, SessionInboxTable, SessionMessageTable } from "@opencode/core/session/sql"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Model } from "@opencode/schema/model"
import * as Prompt from "@opencode/schema/prompt"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import {
  Session as ArenaSession,
  SessionPrompt as ArenaPrompt,
  SessionStatus as ArenaStatus,
  locationServiceMapNode,
  promptNode,
  sessionNode,
  statusNode,
} from "../../src/arena/session-runtime"
import { project } from "../../src/arena/session-runtime/projection"
import { ArenaEngineIdle } from "../../src/arena/engine-runtime/idle"
import { globalProjectNode } from "../../../core/test/lib/project"
import { promptLocationNode } from "../../../core/test/fixture/prompt-location"
import { offlineModels } from "../../../core/test/fixture/models"

const arenaLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    InstructionEntry.node,
    CoreSession.node,
    sessionNode,
    promptNode,
  ]),
  [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    locationServiceMapNode.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    offlineModels,
  ],
)

const it = {
  effect: <A, E, R>(name: string, body: () => Effect.Effect<A, E, R>) =>
    test(name, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(arenaLayer)
          return yield* body().pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      ),
    ),
}

const at = DateTime.makeUnsafe(1_700_000_000_000)
const sessionID = Session.ID.make("ses_arena_projection")
const userID = SessionMessage.ID.make("msg_user")
const assistantID = SessionMessage.ID.make("msg_assistant")

describe("Arena V2 session projection", () => {
  test("projects canonical messages and keeps content identifiers stable", () => {
    const messages: SessionMessage.Info[] = [
      {
        id: userID,
        type: "user",
        text: "inspect this",
        files: [
          Prompt.FileAttachment.make({
            data: "aGVsbG8=",
            mime: "text/plain",
            source: { type: "inline" },
            name: "note.txt",
          }),
        ],
        metadata: { arenaSystem: "contestant context" },
        time: { created: at },
      },
      {
        id: assistantID,
        type: "assistant",
        agent: "build" as never,
        model: { providerID: "arena" as never, id: Model.ID.make("opaque") },
        content: [
          { type: "text", text: "done" },
          { type: "reasoning", text: "because", time: { created: at } },
        ],
        time: { created: at, completed: at },
      },
    ]

    const result = project(messages, sessionID, { providerID: Provider.ID.make("arena"), id: Model.ID.make("opaque") })

    expect(result).toHaveLength(2)
    expect(result[0]?.parts.map((part) => part.type)).toEqual(["text", "file"])
    expect(result[0]?.info).toMatchObject({
      model: { providerID: "arena", modelID: "opaque" },
      system: "contestant context",
    })
    expect(result[1]?.info).toMatchObject({ role: "assistant", parentID: userID })
    expect(result[1]?.parts.map((part) => part.id)).toEqual(["prt_assistant_0", "prt_assistant_1"])
  })

  test("keeps every native tool state nested and gives attachments distinct child IDs", () => {
    const toolMessage: SessionMessage.Assistant = {
      id: SessionMessage.ID.make("msg_tool_states"),
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("opaque") },
      content: [
        {
          type: "tool",
          id: "call_pending",
          name: "read",
          state: { status: "streaming", input: '{"path":"a"}' },
          time: { created: at },
        },
        {
          type: "tool",
          id: "call_running",
          name: "edit",
          state: { status: "running", input: { path: "a" }, metadata: {} },
          time: { created: at, ran: at },
        },
        {
          type: "tool",
          id: "call_completed",
          name: "read",
          state: {
            status: "completed",
            input: { path: "a" },
            content: [
              { type: "text", text: "contents" },
              { type: "file", uri: "file:///tmp/a", mime: "text/plain", name: "a.txt" },
            ],
            metadata: { title: "a" },
          },
          time: { created: at, ran: at, completed: at },
        },
        {
          type: "tool",
          id: "call_error",
          name: "edit",
          state: {
            status: "error",
            input: { path: "a" },
            error: { type: "tool.execution", message: "denied" },
            metadata: {},
          },
          time: { created: at, ran: at, completed: at },
        },
      ],
      time: { created: at, completed: at },
    }

    const parts = project([toolMessage], sessionID)[0]?.parts
    expect(parts?.map((part) => part.type)).toEqual(["tool", "tool", "tool", "tool"])
    expect(parts?.map((part) => part.type === "tool" && part.state.status)).toEqual([
      "pending",
      "running",
      "completed",
      "error",
    ])
    const completed = parts?.[2]
    if (!completed || completed.type !== "tool" || completed.state.status !== "completed")
      throw new Error("completed tool projection missing")
    expect(completed.state.attachments?.[0]).toMatchObject({
      type: "file",
      messageID: "msg_tool_states",
      sessionID: "ses_arena_projection",
    })
    expect(new Set(parts?.map((part) => part.id)).size).toBe(parts?.length)
    expect(completed.state.attachments?.[0]?.id).not.toBe(completed.id)
  })

  test("uses the native model switch at the message position", () => {
    const switched: SessionMessage.ModelSelected = {
      id: SessionMessage.ID.make("msg_model_switch"),
      type: "model-switched",
      model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant-b") },
      time: { created: at },
    }
    const user: SessionMessage.User = {
      id: SessionMessage.ID.make("msg_model_user"),
      type: "user",
      text: "after switch",
      time: { created: at },
    }
    const result = project([switched, user], sessionID, {
      providerID: Provider.ID.make("arena"),
      id: Model.ID.make("contestant-a"),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.info).toMatchObject({ model: { providerID: "arena", modelID: "contestant-b" } })
  })
})

describe("Arena V2 native session storage", () => {
  it.effect("copies a canonical message with provider replay state through the real database", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-runtime-test") })
      const source = yield* sessions.create({ location })
      const target = yield* sessions.create({ location })
      const sourceMessageID = SessionMessage.ID.make("msg_native_source")
      const targetMessageID = SessionMessage.ID.make("msg_native_target")
      const created = DateTime.makeUnsafe(1_700_000_000_001)
      const assistant: SessionMessage.Assistant = {
        id: sourceMessageID,
        type: "assistant",
        agent: Agent.ID.make("build"),
        model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("opaque") },
        content: [
          {
            type: "tool",
            id: "call_native",
            name: "read",
            providerState: { provider: "tool-state" },
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              content: [{ type: "text", text: "native output" }],
              metadata: { title: "README" },
            },
            time: { created, ran: created, completed: created },
          },
        ],
        snapshot: { start: undefined, end: undefined, files: ["README.md"] },
        providerState: { responseID: "response-native" },
        time: { created, streamed: created, completed: created },
      }
      const encoded = Schema.encodeSync(SessionMessage.Info)(assistant)
      const { id, type, ...data } = encoded
      const database = yield* Database.Service
      yield* database.db
        .insert(SessionMessageTable)
        .values({
          id,
          session_id: source.id,
          type,
          seq: 0,
          time_created: DateTime.toEpochMillis(created),
          time_updated: DateTime.toEpochMillis(created),
          data,
        })
        .run()

      const arena = yield* ArenaSession
      const copied = yield* arena.copyMessage({
        sourceSessionID: source.id,
        sourceMessageID,
        targetSessionID: target.id,
        targetMessageID,
        transform: (message) => Effect.succeed({ ...message, metadata: { grafted: true } }),
      })
      expect(copied.id).toBe(targetMessageID)
      expect(copied.type).toBe("assistant")
      if (copied.type !== "assistant") return
      expect(copied.providerState).toEqual({ responseID: "response-native" })
      expect(copied.snapshot?.files).toEqual(["README.md"])
      expect(copied.content[0]).toMatchObject({
        type: "tool",
        providerState: { provider: "tool-state" },
        state: { status: "completed", content: [{ type: "text", text: "native output" }] },
      })
      const stored = yield* arena.canonicalMessages(target.id)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toEqual(copied)

      const projected = project([copied], target.id)[0]
      const projectedTool = projected?.parts[0]
      if (!projectedTool || projectedTool.type !== "tool" || projectedTool.state.status !== "completed")
        throw new Error("completed tool projection missing")
      yield* arena.updatePart({
        ...projectedTool,
        state: { ...projectedTool.state, time: { ...projectedTool.state.time, compacted: 1_700_000_000_002 } },
      })
      const compacted = yield* arena.canonicalMessages(target.id)
      const compactedTool = compacted[0]
      if (!compactedTool || compactedTool.type !== "assistant") throw new Error("assistant copy missing")
      const nativeTool = compactedTool.content[0]
      if (nativeTool.type !== "tool" || nativeTool.state.status !== "completed")
        throw new Error("native tool copy missing")
      expect(nativeTool.providerState).toEqual({ provider: "tool-state" })
      expect(nativeTool.state.content).toEqual([{ type: "text", text: "[Old tool result content cleared]" }])
    }),
  )

  it.effect("admits a noReply prompt with system text and file parts into the native inbox", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-prompt-test") })
      const session = yield* sessions.create({ location })
      const prompt = yield* ArenaPrompt
      const arena = yield* ArenaSession

      const result = yield* prompt.prompt({
        sessionID: session.id,
        system: "Use the attached note.",
        text: "Summarize it.",
        parts: [{ type: "file", url: "data:text/plain;base64,aGVsbG8=", filename: "note.txt" }],
        noReply: true,
      })
      expect(result).toBeUndefined()
      const database = yield* Database.Service
      const pending = yield* database.db
        .select()
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.session_id, session.id))
        .get()
      expect(pending?.type).toBe("user")
      expect(pending?.payload).toMatchObject({
        text: "Summarize it.",
        metadata: { arenaSystem: "Use the attached note." },
        files: [{ name: "note.txt" }],
      })
      const instruction = yield* database.db
        .select()
        .from(InstructionEntryTable)
        .where(eq(InstructionEntryTable.session_id, session.id))
        .get()
      expect(instruction).toMatchObject({ key: "arena", value: "Use the attached note.", removed: false })
      if (!pending) throw new Error("native inbox admission missing")
      const inbox = yield* sessions.inbox(session.id)
      expect(inbox.some((item) => item.id === pending.id)).toBe(true)
      yield* arena.removeMessage({ sessionID: session.id, messageID: pending.id })
      const cancelled = yield* sessions.inbox(session.id)
      expect(cancelled.some((item) => item.id === pending.id)).toBe(false)
    }),
  )
})

describe("Arena V2 session status", () => {
  test("shows a scheduled retry while the session runs, and busy or idle otherwise", async () => {
    const running = Session.ID.make("ses_arena_status")
    let latest: SessionMessage.Assistant = {
      id: assistantID,
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") },
      content: [],
      time: { created: at },
      retry: { attempt: 2, at, error: { type: "provider.internal", message: "Waiting for network", status: 503 } },
    }
    const requests: unknown[] = []
    const sessions = {
      active: Effect.sync(() => new Set([running])),
      messages: (input: unknown) => Effect.sync(() => (requests.push(input), [latest])),
    } as unknown as CoreSession.Interface
    const layer = AppNodeBuilder.build(LayerNode.group([statusNode]), [
      CoreSession.node.replace(Layer.succeed(CoreSession.Service, sessions)),
    ])
    const read = (sessionID: Session.ID) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          return yield* Effect.gen(function* () {
            return yield* (yield* ArenaStatus).get(sessionID)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      )

    expect(await read(running)).toEqual({
      type: "retry",
      attempt: 2,
      message: "Waiting for network",
      next: DateTime.toEpochMillis(at),
    })
    expect(requests).toEqual([{ sessionID: running, type: "assistant", order: "desc", limit: 1 }])
    // The next attempt's step clears the retry, so the session reads as busy again.
    latest = { ...latest, retry: undefined }
    expect(await read(running)).toEqual({ type: "busy" })
    // After a model timeout, the recovery attempt keeps the 1.x label until its stream ends.
    const timedOut = ArenaEngineIdle.idleBudgetFetch(() => Promise.reject(new Error("SSE read timed out")), {
      mainSession: (headers) => {
        const sessionID = headers.get("x-session")
        return sessionID ? { sessionID, rootSessionID: sessionID } : undefined
      },
      headerTimeoutMs: 1_000,
    })
    await timedOut("https://arena.test", { headers: { "x-session": running } }).catch(() => undefined)
    expect(await read(running)).toMatchObject({ type: "retry", attempt: 1, message: "Continuing after model timeout" })
    ArenaEngineIdle.resetIdleBudget(running)
    expect(await read(running)).toEqual({ type: "busy" })
    expect(await read(Session.ID.make("ses_arena_stopped"))).toEqual({ type: "idle" })
  })
})
