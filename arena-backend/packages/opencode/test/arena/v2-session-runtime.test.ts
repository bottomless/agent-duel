import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AIError, HttpContext, InvalidProviderOutputError, ProviderInternalError } from "@opencode/ai"
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
import { SessionEvent } from "@opencode/schema/session-event"
import {
  Session as ArenaSession,
  SessionPrompt as ArenaPrompt,
  SessionStatus as ArenaStatus,
  locationServiceMapNode,
  promptNode,
  sessionNode,
  statusNode,
} from "../../src/arena/session-runtime"
import {
  ARENA_SENT_AT,
  CONTINUE_AFTER_INCOMPLETE_STREAM,
  abandonedAttempts,
  messagesToGraft,
  project,
} from "../../src/arena/session-runtime/projection"
import { ArenaEngineIdle } from "../../src/arena/engine-runtime/idle"
import { copyKeepingReferences, resolveKeptReference } from "../../src/arena/compaction-reference"
import { SessionHistory } from "@opencode/core/session/history"
import { battleResumeInput } from "../../src/arena/resume-note"
import { expireCopiedReasoning } from "../../src/arena/reasoning"
import { SessionRetry } from "../../src/session/retry"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { StepFailedError } from "@opencode/core/session/error"
import { globalProjectNode } from "../../../core/test/lib/project"
import { promptLocationNode } from "../../../core/test/fixture/prompt-location"
import { offlineModels } from "../../../core/test/fixture/models"

/** What the next `resume` does; a test that fails a run sets it and the hook below resets it. */
let resume: (sessionID: Session.ID) => Effect.Effect<void, AIError | StepFailedError> = () => Effect.void
afterEach(() => {
  resume = () => Effect.void
})

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
    SessionExecution.node.replace(
      Layer.effect(
        SessionExecution.Service,
        Effect.gen(function* () {
          const noop = yield* SessionExecution.Service
          return SessionExecution.Service.of({ ...noop, resume: (sessionID) => resume(sessionID) })
        }),
      ).pipe(Layer.provide(SessionExecution.noopLayer)),
    ),
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

function seedGraftMessage(input: { sessionID: Session.ID; message: SessionMessage.Info; seq: number }) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(input.message)
    const created = DateTime.toEpochMillis(input.message.time.created)
    yield* database.db
      .insert(SessionMessageTable)
      .values({
        id,
        session_id: input.sessionID,
        type,
        seq: input.seq,
        time_created: created,
        time_updated: created,
        data,
      })
      .run()
  })
}

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

describe("compaction tail across the vote graft", () => {
  test("resolves a kept-tail reference to the copy, the forked row at the same seq, or the next copied row", () => {
    const context = {
      copied: new Map([
        ["msg_b_prompt", "msg_new_prompt"],
        ["msg_b_tool", "msg_new_tool"],
      ]),
      sourceOrder: ["msg_a_forked", "msg_b_prompt", "msg_b_resume", "msg_b_tool"],
      boundary: "msg_b_prompt",
      sourceSeq: new Map([["msg_a_forked", 4]]),
      targetBySeq: new Map([[4, "msg_canonical_earlier"]]),
    }
    expect(resolveKeptReference("msg_b_prompt", context)).toBe("msg_new_prompt")
    expect(resolveKeptReference("msg_a_forked", context)).toBe("msg_canonical_earlier")
    expect(resolveKeptReference("msg_b_resume", context)).toBe("msg_new_tool")
    expect(resolveKeptReference("msg_b_unknown", context)).toBeUndefined()
  })

  it.effect("keeps the summary's verbatim tail in the chat and in the next turn's fork", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const arena = yield* ArenaSession
      const database = yield* Database.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-compaction-tail-test") })
      const canonical = yield* sessions.create({ location })
      const plain = yield* sessions.create({ location })
      yield* seedGraftMessage({
        sessionID: canonical.id,
        seq: 0,
        message: {
          id: SessionMessage.ID.make("msg_tail_0_earlier"),
          type: "user",
          text: "An earlier turn",
          time: { created: at },
        },
      })
      const winner = yield* arena.fork({ sessionID: canonical.id })
      // Turn 1 in the winner: the prompt, a tool step, then a mid-turn compaction that keeps the whole turn
      // as its tail (Core starts the tail at a user message) by naming the prompt in `keepID`.
      const promptID = SessionMessage.ID.make("msg_tail_1_prompt")
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 1,
        message: { id: promptID, type: "user", text: "Run the numbered logs.", time: { created: at } },
      })
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 2,
        message: {
          id: SessionMessage.ID.make("msg_tail_2_step"),
          type: "assistant",
          agent: Agent.ID.make("build"),
          model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") },
          content: [
            {
              type: "tool",
              id: "call_tail",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "printf TAILMARK-1" },
                content: [{ type: "text", text: "TAILMARK-1 output" }],
              },
              time: { created: at, ran: at, completed: at },
            },
          ],
          time: { created: at, completed: at },
        },
      })
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 3,
        message: {
          id: SessionMessage.ID.make("msg_tail_3_compaction"),
          type: "compaction",
          status: "completed",
          reason: "auto",
          summary: "## Objective\nRun the numbered logs.",
          metadata: { keepID: promptID },
          time: { created: at },
        },
      })
      const source = yield* arena.canonicalMessages(winner.id)
      // History fills `metadata.recent` from the `keepID` reference; an unresolved reference leaves it unset.
      const recentText = (message: SessionMessage.Info | undefined) =>
        message?.type === "compaction" && typeof message.metadata?.recent === "string" ? message.metadata.recent : ""
      const recentOf = (sessionID: Session.ID) =>
        SessionHistory.load(database.db, sessionID, "latest").pipe(Effect.map((history) => recentText(history[0])))
      // The winner itself still finds its tail.
      expect(yield* recentOf(winner.id)).toContain("TAILMARK-1 output")

      // A copy under new IDs that leaves `keepID` alone loses the tail (OpenCode 2.1+ stores a reference).
      for (const message of messagesToGraft(source, promptID))
        yield* arena.copyMessage({
          sourceSessionID: winner.id,
          sourceMessageID: message.id,
          targetSessionID: plain.id,
          targetMessageID: SessionMessage.ID.make(`${message.id}_plain`.replace("msg_tail", "msg_zz_plain")),
        })
      expect(yield* recentOf(plain.id)).toBe("")

      yield* copyKeepingReferences({
        sessions: arena,
        sourceSessionID: winner.id,
        targetSessionID: canonical.id,
        source,
        messages: messagesToGraft(source, promptID),
        boundary: promptID,
      })
      const chatTail = yield* recentOf(canonical.id)
      expect(chatTail).toContain("Run the numbered logs.")
      expect(chatTail).toContain("TAILMARK-1 output")

      // Turn 2's contestants start from a Core fork of the chat, which remaps the reference again.
      const next = yield* arena.fork({ sessionID: canonical.id })
      const nextHistory = yield* SessionHistory.load(database.db, next.id, "latest")
      const checkpoint = nextHistory[0]
      expect(checkpoint?.type).toBe("compaction")
      if (checkpoint?.type !== "compaction") return
      expect(checkpoint.summary).toContain("Run the numbered logs.")
      expect(recentText(checkpoint)).toContain("Run the numbered logs.")
      expect(recentText(checkpoint)).toContain("TAILMARK-1 output")
    }),
  )
})

describe("Arena V2 native session storage", () => {
  it.effect("keeps losing and earlier-turn children outside the winning fork's family", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const arena = yield* ArenaSession
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-graft-family-test") })
      const canonical = yield* sessions.create({ location })
      const earlier = yield* sessions.create({ parentID: canonical.id, title: "Earlier winner's child" })
      yield* seedGraftMessage({
        sessionID: canonical.id,
        seq: 0,
        message: {
          id: SessionMessage.ID.make("msg_graft_family_history"),
          type: "user",
          text: `Earlier child: ${earlier.id}`,
          time: { created: at },
        },
      })
      const winner = yield* arena.fork({ sessionID: canonical.id })
      const loser = yield* arena.fork({ sessionID: canonical.id })
      const winningChild = yield* sessions.create({ parentID: winner.id, title: "Winning child" })
      const winningGrandchild = yield* sessions.create({ parentID: winningChild.id, title: "Nested winning child" })
      const losingChild = yield* sessions.create({ parentID: loser.id, title: "Losing child" })
      const internalFork = yield* arena.fork({ sessionID: winner.id })
      const internalChild = yield* sessions.create({ parentID: internalFork.id, title: "Internal fork's child" })
      const promptID = SessionMessage.ID.make("msg_graft_family_prompt")
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 1,
        message: { id: promptID, type: "user", text: "Current turn", time: { created: at } },
      })

      // Core forks copy messages, not the parent's child family. Graft starts its walk at winner.id.
      expect(winner.parentID).toBeUndefined()
      expect(loser.parentID).toBeUndefined()
      expect(internalFork.parentID).toBeUndefined()
      expect((yield* arena.children(canonical.id)).map((child) => child.id)).toEqual([earlier.id])
      expect((yield* arena.children(winner.id)).map((child) => child.id)).toEqual([winningChild.id])
      expect((yield* arena.children(winningChild.id)).map((child) => child.id)).toEqual([winningGrandchild.id])
      expect((yield* arena.children(loser.id)).map((child) => child.id)).toEqual([losingChild.id])
      expect((yield* arena.children(internalFork.id)).map((child) => child.id)).toEqual([internalChild.id])
      expect(JSON.stringify(yield* arena.canonicalMessages(winner.id))).toContain(earlier.id)
      // Command-created children need no parent tool call; both child levels are still discoverable.
      const retained = messagesToGraft(yield* arena.canonicalMessages(winner.id), promptID)
      expect(retained.map((message) => message.id)).toEqual([promptID])
      expect(JSON.stringify(retained)).not.toContain(winningChild.id)
    }),
  )

  it.effect("keeps a child discoverable after its delegation is rewound, without a surviving tool reference", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const arena = yield* ArenaSession
      const bus = yield* Bus.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-graft-rewind-test") })
      const winner = yield* sessions.create({ location })
      const child = yield* sessions.create({
        parentID: winner.id,
        title: "Delegated work",
        agent: Agent.ID.make("general"),
      })
      const promptID = SessionMessage.ID.make("msg_graft_rewind_prompt")
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 0,
        message: { id: promptID, type: "user", text: "Delegate work", time: { created: at } },
      })
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 1,
        message: {
          id: SessionMessage.ID.make("msg_graft_rewind_delegation"),
          type: "assistant",
          agent: Agent.ID.make("build"),
          model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") },
          content: [
            {
              type: "tool",
              id: "call_graft_child",
              name: "subagent",
              state: {
                status: "completed",
                input: { agent: "general", description: "Delegated work", prompt: "Inspect files" },
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ sessionID: child.id, status: "completed", output: "Report" }),
                  },
                ],
              },
              time: { created: at, ran: at, completed: at },
            },
          ],
          time: { created: at, completed: at },
          finish: "tool-calls",
        },
      })
      yield* seedGraftMessage({
        sessionID: child.id,
        seq: 0,
        message: {
          id: SessionMessage.ID.make("msg_graft_rewind_child_report"),
          type: "user",
          text: "Child's retained transcript",
          time: { created: at },
        },
      })
      expect(JSON.stringify(yield* arena.canonicalMessages(winner.id))).toContain(child.id)

      // Stage the durable boundary directly: file snapshots are outside this storage test.
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: winner.id,
        revert: { messageID: promptID, files: [] },
      })
      yield* sessions.revert.commit(winner.id)
      const nextPromptID = SessionMessage.ID.make("msg_graft_rewind_replacement")
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 0,
        message: { id: nextPromptID, type: "user", text: "Replacement prompt", time: { created: at } },
      })
      const retained = messagesToGraft(yield* arena.canonicalMessages(winner.id), nextPromptID)
      expect(retained.map((message) => message.id)).toEqual([nextPromptID])
      expect(JSON.stringify(retained)).not.toContain(child.id)
      expect((yield* arena.children(winner.id)).map((entry) => entry.id)).toEqual([child.id])
      expect((yield* arena.canonicalMessages(child.id)).map((message) => message.type)).toEqual(["user"])
    }),
  )

  it.effect("grafts canonical cut-stream shape while expiring sealed reasoning through the real database", () =>
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
            native: {
              provider: "tool-state",
              reasoning_details: [{ type: "reasoning.encrypted", data: "arena_reasoning_v1.fixture" }],
            },
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              content: [{ type: "text", text: "native output" }],
              metadata: { title: "README" },
            },
            time: { created, ran: created, completed: created },
          },
          {
            type: "reasoning",
            text: "[Thinking redacted]",
            native: { reasoning_details: [{ type: "reasoning.encrypted", data: "arena_reasoning_v1.fixture" }] },
          },
          { type: "text", text: "Half an answer" },
          { type: "text", text: "[The response was interrupted]" },
          { type: "text", text: "Continuation" },
        ],
        snapshot: { start: undefined, end: undefined, files: ["README.md"] },
        native: { responseID: "response-native" },
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
        transform: (message) => Effect.succeed({ ...expireCopiedReasoning(message), metadata: { grafted: true } }),
      })
      expect(JSON.stringify(copied)).not.toContain("arena_reasoning_v1.")
      expect(JSON.stringify(yield* arena.canonicalMessages(source.id))).toContain("arena_reasoning_v1.")
      expect(copied.id).toBe(targetMessageID)
      expect(copied.type).toBe("assistant")
      if (copied.type !== "assistant") return
      expect(copied.content.map((part) => (part.type === "tool" ? part.type : part.text))).toEqual([
        "tool",
        "[Thinking redacted]",
        "Half an answer",
        "[The response was interrupted]",
        "Continuation",
      ])
      expect(copied.native).toEqual({ responseID: "response-native" })
      expect(copied.snapshot?.files).toEqual(["README.md"])
      expect(copied.content[0]).toMatchObject({
        type: "tool",
        native: { provider: "tool-state" },
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
      expect(nativeTool.native).toEqual({ provider: "tool-state" })
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

  it.effect("shows queued steers from the native inbox, withdraws one, and keeps a cut-off one as a message", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-steer-queue-test") })
      const session = yield* sessions.create({ location })
      const prompt = yield* ArenaPrompt
      const arena = yield* ArenaSession

      // The execution layer is a no-op here, so nothing promotes the steers: they stay queued the
      // way they do while a contestant's tool call runs.
      yield* prompt.steer({ sessionID: session.id, text: "STEER-ONE" })
      yield* prompt.steer({
        sessionID: session.id,
        text: "STEER-TWO",
        parts: [{ type: "file", url: "data:text/plain;base64,aGVsbG8=", filename: "note.txt" }],
        metadata: { [ARENA_SENT_AT]: 1_700_000_000_123 },
      })
      expect(yield* arena.messages({ sessionID: session.id })).toEqual([])
      const queued = yield* arena.pending({ sessionID: session.id })
      expect(queued.map((entry) => entry.info.role)).toEqual(["user", "user"])
      expect(queued.map((entry) => entry.parts[0])).toMatchObject([
        { type: "text", text: "STEER-ONE" },
        { type: "text", text: "STEER-TWO" },
      ])
      expect(queued[1]?.parts.some((part) => part.type === "file" && part.filename === "note.txt")).toBe(true)
      const [one, two] = queued.map((entry) => entry.info.id)
      if (!one || !two) throw new Error("queued steers missing")

      yield* arena.cancelPending({ sessionID: session.id, messageIDs: [one] })
      expect((yield* arena.pending({ sessionID: session.id })).map((entry) => entry.info.id)).toEqual([two])

      expect(yield* arena.deliverPending(session.id)).toBe(1)
      expect(yield* arena.pending({ sessionID: session.id })).toEqual([])
      const delivered = yield* arena.messages({ sessionID: session.id })
      expect(delivered.map((entry) => entry.info.id)).toEqual([two])
      expect(delivered[0]?.parts[0]).toMatchObject({ type: "text", text: "STEER-TWO" })
      // Core stamps the delivery time on the row; the thread shows when the user sent it.
      expect(delivered[0]?.info.time.created).toBe(1_700_000_000_123)

      // A delivered steer is no longer the user's to withdraw: the model may already have read it.
      const late = yield* Effect.flip(arena.cancelPending({ sessionID: session.id, messageIDs: [two] }))
      expect(late.message).toBe("Arena pending steer was already consumed")
      expect(yield* arena.deliverPending(session.id)).toBe(0)
    }),
  )

  it.effect("withdraws several queued steers all or none", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-steer-atomic-test") })
      const session = yield* sessions.create({ location })
      const prompt = yield* ArenaPrompt
      const arena = yield* ArenaSession

      yield* prompt.steer({ sessionID: session.id, text: "STEER-READ" })
      yield* arena.deliverPending(session.id)
      const [read] = (yield* arena.messages({ sessionID: session.id })).map((entry) => entry.info.id)
      yield* prompt.steer({ sessionID: session.id, text: "STEER-WAIT" })
      yield* prompt.steer({ sessionID: session.id, text: "STEER-ALSO" })
      const [wait, also] = (yield* arena.pending({ sessionID: session.id })).map((entry) => entry.info.id)
      if (!read || !wait || !also) throw new Error("steers missing")

      // One of them was already delivered, so none is withdrawn.
      const refused = yield* Effect.flip(arena.cancelPending({ sessionID: session.id, messageIDs: [wait, read] }))
      expect(refused.message).toBe("Arena pending steer was already consumed")
      expect((yield* arena.pending({ sessionID: session.id })).map((entry) => entry.info.id)).toEqual([wait, also])

      yield* arena.cancelPending({ sessionID: session.id, messageIDs: [wait, also] })
      expect(yield* arena.pending({ sessionID: session.id })).toEqual([])
      expect((yield* arena.messages({ sessionID: session.id })).map((entry) => entry.info.id)).toEqual([read])
    }),
  )
})

describe("Arena V2 failed contestant run", () => {
  const providerFailure = new AIError({
    reason: new ProviderInternalError({
      message: "Internal Server Error",
      body: '{"error":{"message":"Internal Server Error"}}',
      http: new HttpContext({ url: "https://arena.invalid/chat/completions", status: 500, headers: {} }),
    }),
  })

  const insert = (database: Database.Interface, sessionID: Session.ID, message: SessionMessage.Info, seq: number) =>
    Effect.gen(function* () {
      const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
      yield* database.db
        .insert(SessionMessageTable)
        .values({
          id,
          session_id: sessionID,
          type,
          seq,
          time_created: DateTime.toEpochMillis(message.time.created),
          time_updated: DateTime.toEpochMillis(message.time.created),
          data,
        })
        .run()
    })

  const user = (id: string, created: DateTime.Utc): SessionMessage.User => ({
    id: SessionMessage.ID.make(id),
    type: "user",
    text: "write the file",
    time: { created },
  })

  const failedAssistant = (
    id: string,
    created: DateTime.Utc,
    error: NonNullable<SessionMessage.Assistant["error"]>,
  ): SessionMessage.Assistant => ({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") },
    content: [],
    error,
    finish: "error",
    time: { created, completed: created },
  })

  const session = (name: string) =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      return yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(`/arena-${name}`) }) })
    })

  it.effect("settles on the assistant the failed step recorded, so the run can be retried", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { id } = yield* session("failed-step")
      yield* insert(database, id, user("msg_failed_step_user", at), 0)
      resume = (sessionID) =>
        insert(
          database,
          sessionID,
          failedAssistant("msg_failed_step_answer", DateTime.makeUnsafe(Date.now()), toSessionError(providerFailure)),
          1,
        ).pipe(Effect.orDie, Effect.andThen(Effect.fail(providerFailure)))

      const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })

      expect(answer?.info).toMatchObject({
        id: "msg_failed_step_answer",
        role: "assistant",
        error: { name: "APIError", data: { statusCode: 500 } },
      })
      if (answer?.info.role !== "assistant" || !answer.info.error) throw new Error("errored assistant missing")
      expect(SessionRetry.retryable(answer.info.error, "arena")).toBeDefined()
    }),
  )

  it.effect("builds an unsaved assistant from the error when no step recorded it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { id } = yield* session("no-step")
      yield* insert(database, id, user("msg_no_step_user", at), 0)
      // An earlier answer that the voter stopped carries an error too; it is not this run's.
      yield* insert(
        database,
        id,
        failedAssistant("msg_no_step_stopped", at, { type: "aborted", message: "Step interrupted" }),
        1,
      )
      resume = () => Effect.fail(providerFailure)

      const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })

      expect(answer?.parts).toEqual([])
      expect(answer?.info).toMatchObject({
        role: "assistant",
        parentID: "msg_no_step_user",
        providerID: "arena",
        error: {
          name: "APIError",
          data: { statusCode: 500, responseBody: '{"error":{"message":"Internal Server Error"}}' },
        },
      })
      expect(answer?.info.id).not.toBe("msg_no_step_stopped")
      if (answer?.info.role !== "assistant" || !answer.info.error) throw new Error("built assistant missing")
      expect(answer.info.time.completed).toBeDefined()
      expect(SessionRetry.retryable(answer.info.error, "arena")).toBeDefined()
      const stored = yield* (yield* ArenaSession).canonicalMessages(id)
      expect(stored.some((message) => message.id === answer.info.id)).toBe(false)
    }),
  )

  it.effect("does not settle on a continued step's error that is not the run's failure", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { id } = yield* session("continued-step")
      yield* insert(database, id, user("msg_continued_user", at), 0)
      resume = (sessionID) =>
        insert(
          database,
          sessionID,
          failedAssistant("msg_continued_answer", DateTime.makeUnsafe(Date.now()), {
            type: "provider.transport",
            message: "socket closed",
          }),
          1,
        ).pipe(Effect.orDie, Effect.andThen(Effect.fail(providerFailure)))

      const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })

      expect(answer?.info.id).not.toBe("msg_continued_answer")
      expect(answer?.info).toMatchObject({ error: { name: "APIError", data: { statusCode: 500 } } })
    }),
  )

  test("projects the failures 1.x retried as retryable, and engine defects as not", () => {
    const projectedError = (error: NonNullable<SessionMessage.Assistant["error"]>) => {
      const entry = project(
        [user("msg_class_user", at), failedAssistant("msg_class_answer", at, error)],
        Session.ID.make("ses_error_class"),
      ).at(-1)
      if (entry?.info.role !== "assistant" || !entry.info.error) throw new Error("errored assistant missing")
      return entry.info.error
    }
    const retryable = (error: NonNullable<SessionMessage.Assistant["error"]>) =>
      SessionRetry.retryable(projectedError(error), "arena") !== undefined

    // The engine proxy ends a cut stream with a server_error event; Core records it with no status.
    expect(
      retryable({
        type: "provider.internal",
        message: "Provider request failed",
        response: {
          body: '{"message":"Arena contestant stream failed","type":"error","error":{"code":"server_error"}}',
        },
      }),
    ).toBe(true)
    expect(retryable({ type: "provider.rate-limit", message: "Too many requests", status: 429 })).toBe(true)
    expect(retryable({ type: "provider.internal", message: "Bad gateway", status: 502 })).toBe(true)
    expect(retryable({ type: "provider.transport", message: "Connection reset by server" })).toBe(true)
    expect(retryable({ type: "provider.timeout", message: "Request timed out" })).toBe(true)

    expect(retryable({ type: "unknown", message: "Tool input delta after end: call_1" })).toBe(false)
    expect(retryable({ type: "provider.invalid-request", message: "Bad request", status: 400 })).toBe(false)
    expect(retryable({ type: "provider.auth", message: "Unauthorized", status: 401 })).toBe(false)
    expect(retryable({ type: "provider.quota", message: "Quota exceeded" })).toBe(false)
    expect(retryable({ type: "aborted", message: "Step interrupted" })).toBe(false)
  })

  it.effect("keeps history when an empty compaction fails before an assistant step", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { id } = yield* session("empty-compaction")
      yield* insert(
        database,
        id,
        {
          id: SessionMessage.ID.make("msg_empty_summary_user"),
          type: "user",
          text: "write the file",
          time: { created: at },
          files: [{ source: { type: "inline" }, mime: "image/png", data: "aGVsbG8=", name: "task.png" }],
        },
        0,
      )
      const arena = yield* ArenaSession
      const history = yield* arena.canonicalMessages(id)
      resume = () =>
        Effect.fail(
          new StepFailedError({
            error: { type: "compaction.empty-summary", message: "Private provider details" },
          }),
        )
      const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })
      expect(answer?.info).toMatchObject({
        role: "assistant",
        error: {
          name: "APIError",
          data: {
            isRetryable: true,
            message: "The agent could not summarize its context. Retry to continue.",
          },
        },
      })
      if (!answer) throw new Error("failed compaction answer missing")
      // Retry removes this synthetic answer; it must not remove the real prompt or its image.
      yield* arena.removeMessage({ sessionID: id, messageID: answer.info.id })
      expect(yield* arena.canonicalMessages(id)).toEqual(history)
    }),
  )

  test("classifies an empty summary by its type rather than the error text", () => {
    const error = (type: string, message: string) => {
      const entry = project([failedAssistant("msg_empty_summary_class", at, { type, message })], sessionID)[0]
      if (entry.info.role !== "assistant" || !entry.info.error) throw new Error("projected error missing")
      return SessionRetry.retryable(entry.info.error, "arena") !== undefined
    }
    expect(error("compaction.empty-summary", "Different diagnostic")).toBe(true)
    expect(error("unknown", "Compaction produced no summary")).toBe(false)
    expect(error("compaction.failed", "Compaction summary did not match the required template")).toBe(false)
    expect(error("compaction.failed", "Compaction summary reached the output token limit")).toBe(false)
  })

  it.effect("offers Retry for a stream that ended unfinished, as 1.x did, but not for malformed output", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const settle = (name: string, failure: AIError | StepFailedError) =>
        Effect.gen(function* () {
          const { id } = yield* session(name)
          yield* insert(database, id, user(`msg_${name}_user`, at), 0)
          resume = (sessionID) =>
            insert(
              database,
              sessionID,
              failedAssistant(
                `msg_${name}_answer`,
                DateTime.makeUnsafe(Date.now()),
                failure instanceof StepFailedError ? failure.error : toSessionError(failure),
              ),
              1,
            ).pipe(Effect.orDie, Effect.andThen(Effect.fail(failure)))
          const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })
          if (answer?.info.role !== "assistant" || !answer.info.error) throw new Error("errored assistant missing")
          // The recorded step is the answer, so Retry removes it before the run starts again.
          expect(answer.info.id).toBe(`msg_${name}_answer`)
          return SessionRetry.retryable(answer.info.error, "arena") !== undefined
        })

      const unfinished = new AIError({
        reason: new InvalidProviderOutputError({
          message: "OpenAI Chat stream ended without finish_reason",
          classification: "incomplete-stream",
        }),
      })
      const malformed = new AIError({
        reason: new InvalidProviderOutputError({ message: "Provider sent a tool call without an id" }),
      })
      expect(toSessionError(unfinished).type).toBe("provider.invalid-output")
      expect(toSessionError(malformed).type).toBe("provider.invalid-output")
      // A stream that succeeds without a finish fails the step, not the stream (`runner/step.ts`).
      const unknownFinish = new StepFailedError({
        error: toSessionError(
          new AIError({
            reason: new InvalidProviderOutputError({
              message: "The provider response ended with an unknown finish reason.",
              classification: "incomplete-stream",
            }),
          }),
        ),
      })
      expect(yield* settle("unfinished", unfinished)).toBe(true)
      expect(yield* settle("unknown-finish", unknownFinish)).toBe(true)
      expect(yield* settle("malformed", malformed)).toBe(false)
    }),
  )

  it.effect("returns the last assistant when the run succeeds", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { id } = yield* session("succeeded")
      yield* insert(database, id, user("msg_succeeded_user", at), 0)
      const answer = yield* (yield* ArenaPrompt).loop({ sessionID: id })
      expect(answer).toBeUndefined()
    }),
  )
})

describe("Arena V2 abandoned attempts", () => {
  const model = { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") }
  const cut = { type: "provider.internal", message: "Provider request failed" }
  const time = (ms: number) => DateTime.makeUnsafe(1_700_000_000_000 + ms)
  const user = (id: string): SessionMessage.User => ({
    id: SessionMessage.ID.make(id),
    type: "user",
    text: "write it",
    time: { created: time(0) },
  })
  const assistant = (id: string, extra: Partial<SessionMessage.Assistant> = {}): SessionMessage.Assistant => ({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model,
    content: [{ type: "text", text: "[" }],
    time: { created: time(1), completed: time(2) },
    ...extra,
  })
  const continuation = (id: string): SessionMessage.Synthetic => ({
    id: SessionMessage.ID.make(id),
    type: "synthetic",
    text: CONTINUE_AFTER_INCOMPLETE_STREAM,
    time: { created: time(3) },
  })
  const otherNote = (id: string): SessionMessage.Synthetic => ({
    id: SessionMessage.ID.make(id),
    type: "synthetic",
    text: "Subagent finished.",
    time: { created: time(3) },
  })
  const idle = (id: string, failed: boolean): SessionMessage.Idle => ({
    id: SessionMessage.ID.make(id),
    type: "idle",
    outcome: failed ? "failed" : "succeeded",
    ...(failed ? { error: cut } : {}),
    time: { created: time(4) },
  })
  const text = (value: string) => ({ type: "text" as const, text: value })

  test("finds every half answer and its continuation note after the run's prompt, and nothing else", () => {
    const ranTool: SessionMessage.Assistant["content"][number] = {
      type: "tool",
      id: "call_write",
      name: "write",
      state: { status: "completed", input: { filePath: "a.md" }, content: [{ type: "text", text: "ok" }] },
      time: { created: time(1), ran: time(1), completed: time(2) },
    }
    const messages: SessionMessage.Info[] = [
      assistant("msg_a_earlier_failed", { error: cut }),
      user("msg_b_prompt"),
      assistant("msg_c_cut", { error: cut }),
      continuation("msg_d_note"),
      assistant("msg_e_cut", { error: cut }),
      continuation("msg_f_note"),
      assistant("msg_g_tools", { finish: "tool-calls", content: [ranTool] }),
      assistant("msg_h_cut_after_tool", { error: cut, content: [ranTool] }),
      continuation("msg_i_note"),
      assistant("msg_j_stopped", { error: { type: "aborted", message: "Step interrupted" } }),
      user("msg_k_steer"),
      continuation("msg_l_other_note"),
      assistant("msg_m_failed", { error: cut }),
    ]
    expect([...abandonedAttempts(messages, "msg_b_prompt")].sort()).toEqual([
      "msg_c_cut",
      "msg_d_note",
      "msg_e_cut",
      "msg_f_note",
      "msg_m_failed",
    ])
  })

  test("removes only Core's continuation note, not another note that follows a half answer", () => {
    const messages: SessionMessage.Info[] = [
      user("msg_a_prompt"),
      assistant("msg_b_cut", { error: cut }),
      otherNote("msg_c_subagent"),
    ]
    expect([...abandonedAttempts(messages, "msg_a_prompt")]).toEqual(["msg_b_cut"])
  })

  test("keeps Core's note text in step with Arena's copy", async () => {
    const source = await Bun.file(new URL("../../../core/src/session/runner/llm.ts", import.meta.url)).text()
    expect(source).toContain(JSON.stringify(CONTINUE_AFTER_INCOMPLETE_STREAM))
  })

  // A winner that recovered without Retry: the shape of the fourth and ninth live tests
  // (`r11-retry.fix.md`), where GLM began a code block again after a cut.
  const thought = {
    type: "reasoning" as const,
    text: "[Thinking redacted]",
    state: { envelope: "abc" },
    time: { created: time(1), completed: time(2) },
  }
  const ranTool: SessionMessage.AssistantTool = {
    type: "tool",
    id: "call_ran",
    name: "write",
    state: { status: "completed", input: { filePath: "a.md" }, content: [{ type: "text", text: "ok" }] },
    time: { created: time(1), ran: time(1), completed: time(2) },
  }
  const unranTool: SessionMessage.AssistantTool = {
    type: "tool",
    id: "call_cut",
    name: "write",
    state: { status: "error", input: {}, error: { type: "aborted", message: "Tool execution interrupted" } },
    time: { created: time(1), completed: time(2) },
  }
  const recovered: SessionMessage.Info[] = [
    assistant("msg_a_old_answer", { finish: "stop", content: [text("before")] }),
    user("msg_b_prompt"),
    {
      id: SessionMessage.ID.make("msg_c_system"),
      type: "system",
      text: "worktree policy",
      time: { created: time(0) },
    },
    assistant("msg_d_half", { error: cut, content: [thought, text("1. Sleep well. 2. Drink wa")] }),
    continuation("msg_e_note"),
    idle("msg_f_idle_failed", true),
    assistant("msg_g_half", { error: cut, content: [thought, text("```py\nprint("), unranTool] }),
    continuation("msg_h_note"),
    assistant("msg_i_tools", { finish: "tool-calls", content: [ranTool] }),
    assistant("msg_j_half_no_text", { error: cut, content: [] }),
    continuation("msg_k_note"),
    assistant("msg_l_answer", { finish: "stop", content: [text("ter often. 3. Walk daily.")] }),
    idle("msg_m_idle_ok", false),
  ]

  test("copies a recovered winner's half answers, notes and answer unchanged and in order", () => {
    const copied = messagesToGraft(recovered, "msg_b_prompt")
    expect(copied.map((message) => String(message.id))).toEqual([
      "msg_b_prompt",
      "msg_d_half",
      "msg_e_note",
      "msg_g_half",
      "msg_h_note",
      "msg_i_tools",
      "msg_j_half_no_text",
      "msg_k_note",
      "msg_l_answer",
      "msg_m_idle_ok",
    ])
    // The same objects: the graft edits no text, part or error.
    for (const message of copied) expect(recovered).toContain(message)
  })

  test("Retry removes every piece that a recovered winner's graft keeps", () => {
    const failed = recovered.slice(0, -2)
    expect([...abandonedAttempts(failed, "msg_b_prompt")].sort()).toEqual([
      "msg_d_half",
      "msg_e_note",
      "msg_g_half",
      "msg_h_note",
      "msg_j_half_no_text",
      "msg_k_note",
    ])
  })

  for (const [label, target] of [
    ["the winner's model", model],
    ["another model", { providerID: Provider.ID.make("arena"), id: Model.ID.make("other") }],
  ] as const) {
    test(`gives ${label} valid next-turn input from a recovered winner's history`, () => {
      const lowered = toLLMMessages(messagesToGraft(recovered, "msg_b_prompt"), target)
      const roles = lowered.map((message) => message.role)
      expect(roles).not.toContain("system")
      for (const [index, role] of roles.entries()) {
        if (role === "assistant") expect(roles[index + 1]).not.toBe("assistant")
      }
      const parts = lowered.flatMap((message) => (typeof message.content === "string" ? [] : [...message.content]))
      const calls = parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : []))
      const results = parts.flatMap((part) => (part.type === "tool-result" ? [part.id] : []))
      expect(calls.sort()).toEqual(["call_cut", "call_ran"])
      expect(results.sort()).toEqual(calls)
      // No text is lost, and the error fields of the rows do not reach the model.
      const written = JSON.stringify(lowered)
      for (const piece of ["1. Sleep well. 2. Drink wa", "print(", "ter often. 3. Walk daily."]) {
        expect(written).toContain(JSON.stringify(piece).slice(1, -1))
      }
      expect(written.split(CONTINUE_AFTER_INCOMPLETE_STREAM).length - 1).toBe(3)
      expect(written).not.toContain("Provider request failed")
    })
  }
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

describe("interrupted battle Resume notice", () => {
  it.effect("gives both interrupted sides the exact same hidden note before continuing, once per battle", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const arena = yield* ArenaSession
      const prompt = yield* ArenaPrompt
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-resume-note-test") })
      const a = yield* sessions.create({ location })
      const b = yield* sessions.create({ location })
      const note = "The engine restarted. Check the current state before you run a step again."
      resume = (sessionID) =>
        Effect.gen(function* () {
          const inbox = yield* sessions.inbox(sessionID)
          expect(inbox).toHaveLength(1)
          expect(inbox[0]).toMatchObject({ type: "synthetic", payload: { text: note } })
        })
      yield* prompt.loop({ sessionID: a.id, interruptedBattleID: "turn_interrupted" })
      yield* prompt.loop({ sessionID: b.id, interruptedBattleID: "turn_interrupted" })
      yield* prompt.loop({ sessionID: a.id, interruptedBattleID: "turn_interrupted" })
      yield* prompt.loop({ sessionID: b.id, interruptedBattleID: "turn_interrupted" })
      resume = () => Effect.void
      for (const session of [a, b]) {
        yield* arena.deliverPending(session.id)
        const history = yield* sessions.messages({ sessionID: session.id })
        expect(history.map((message) => message.type)).toEqual(["synthetic"])
        const model = { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") }
        expect(toLLMMessages(history, model).map(({ role, content }) => ({ role, content }))).toEqual([
          { role: "user", content: [{ type: "text", text: note }] },
        ])
        expect((yield* arena.messages({ sessionID: session.id }))[0].parts).toMatchObject([
          { type: "text", text: note, synthetic: true },
        ])
        yield* prompt.loop({ sessionID: session.id, interruptedBattleID: "turn_interrupted" })
        expect(yield* sessions.inbox(session.id)).toEqual([])
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(history)
      }
    }),
  )

  it.effect("drops only the Resume note from the winner's history and keeps other synthetic rows", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const arena = yield* ArenaSession
      const prompt = yield* ArenaPrompt
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-resume-graft-test") })
      const winner = yield* sessions.create({ location })
      const canonical = yield* sessions.create({ location })
      const promptID = SessionMessage.ID.make("msg_0_resume_prompt")
      yield* seedGraftMessage({
        sessionID: winner.id,
        seq: 0,
        message: { id: promptID, type: "user", text: "Do the task", time: { created: at } },
      })
      yield* prompt.loop({
        sessionID: winner.id,
        interruptedBattleID: "turn_interrupted",
        stoppedShellIDs: ["sh_root", "sh_child"],
      })
      const notes = [
        "The engine restarted. Check the current state before you run a step again.",
        "The engine restarted, and your background shell stopped. Start it again if it is still needed.",
      ]
      expect((yield* sessions.inbox(winner.id)).map((message) => message.payload)).toEqual(
        notes.map((text) => ({ text })),
      )
      yield* arena.deliverPending(winner.id)
      yield* prompt.loop({
        sessionID: winner.id,
        interruptedBattleID: "turn_interrupted",
        stoppedShellIDs: ["sh_child", "sh_root"],
      })
      expect(yield* sessions.inbox(winner.id)).toEqual([])
      const otherNotes = ["Background subagent result: task completed.", notes[0]]
      for (const [index, text] of otherNotes.entries()) {
        yield* sessions.synthetic({
          sessionID: winner.id,
          id: SessionMessage.ID.make(`msg_other_synthetic_${index}`),
          text,
          resume: false,
        })
      }
      yield* arena.deliverPending(winner.id)
      const source = yield* arena.canonicalMessages(winner.id)
      const resumeID = battleResumeInput(winner.id, "turn_interrupted").id
      expect(source.filter((message) => message.id === resumeID)).toHaveLength(1)
      const retained = messagesToGraft(source, promptID)
      expect(retained.map((message) => message.id)).toEqual([
        promptID,
        source[2].id,
        SessionMessage.ID.make("msg_other_synthetic_0"),
        SessionMessage.ID.make("msg_other_synthetic_1"),
      ])
      // Identity still excludes the Resume note if its wording changes.
      expect(
        messagesToGraft(
          source.map((message) =>
            message.type === "synthetic" && message.id === resumeID
              ? { ...message, text: "A revised Resume reminder." }
              : message,
          ),
          promptID,
        ),
      ).toEqual(retained)
      const graftedNotes = [notes[1], ...otherNotes]
      for (const [index, message] of retained.entries()) {
        yield* arena.copyMessage({
          sourceSessionID: winner.id,
          sourceMessageID: message.id,
          targetSessionID: canonical.id,
          targetMessageID: SessionMessage.ID.make(`msg_resume_graft_${index}`),
        })
      }
      const history = yield* sessions.messages({ sessionID: canonical.id, order: "asc" })
      expect(history.map((message) => message.type)).toEqual(["user", "synthetic", "synthetic", "synthetic"])
      expect(history.filter((message) => message.type === "user").map((message) => message.text)).toEqual([
        "Do the task",
      ])
      expect(history.filter((message) => message.type === "synthetic").map((message) => message.text)).toEqual(
        graftedNotes,
      )
      expect(
        (yield* arena.messages({ sessionID: canonical.id })).slice(1).map((message) => message.parts),
      ).toMatchObject(graftedNotes.map((text) => [{ type: "text", text, synthetic: true }]))
    }),
  )

  it.effect("adds no restart note to ordinary continuation, Retry, steer, or prompt admission", () =>
    Effect.gen(function* () {
      const sessions = yield* CoreSession.Service
      const prompt = yield* ArenaPrompt
      const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-without-resume-note-test") })
      const session = yield* sessions.create({ location })
      // Retry and ordinary continuations both use loop without an interrupted battle ID.
      yield* prompt.loop({ sessionID: session.id })
      yield* prompt.loop({ sessionID: session.id })
      expect(yield* sessions.inbox(session.id)).toEqual([])
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      yield* prompt.steer({ sessionID: session.id, text: "Follow this steer" })
      yield* prompt.prompt({ sessionID: session.id, text: "A normal send" })
      expect((yield* sessions.inbox(session.id)).map((message) => message.type)).toEqual(["user", "user"])
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
    }),
  )
})

describe("shell stop notice on Resume", () => {
  it.effect(
    "admits the same neutral model note for either affected side, once, and nothing for an unaffected side",
    () =>
      Effect.gen(function* () {
        const sessions = yield* CoreSession.Service
        const prompt = yield* ArenaPrompt
        const location = Location.Ref.make({ directory: AbsolutePath.make("/arena-shell-restart-test") })
        const a = yield* sessions.create({ location })
        const b = yield* sessions.create({ location })
        const untouched = yield* sessions.create({ location })
        yield* prompt.loop({ sessionID: a.id, stoppedShellIDs: ["sh_a"] })
        yield* prompt.loop({ sessionID: b.id, stoppedShellIDs: ["sh_b", "sh_child"] })
        yield* prompt.loop({ sessionID: a.id, stoppedShellIDs: ["sh_a"] })
        yield* prompt.loop({ sessionID: untouched.id, stoppedShellIDs: [] })
        const aInbox = yield* sessions.inbox(a.id)
        const bInbox = yield* sessions.inbox(b.id)
        expect(aInbox).toHaveLength(1)
        expect(bInbox).toHaveLength(1)
        const note = "The engine restarted, and your background shell stopped. Start it again if it is still needed."
        expect(aInbox[0]).toMatchObject({ type: "synthetic", payload: { text: note } })
        expect(bInbox[0]).toMatchObject({ type: "synthetic", payload: { text: note } })
        expect(yield* sessions.inbox(untouched.id)).toEqual([])
        expect(yield* sessions.messages({ sessionID: untouched.id })).toEqual([])
        yield* (yield* ArenaSession).deliverPending(a.id)
        const history = yield* sessions.messages({ sessionID: a.id })
        const model = { providerID: Provider.ID.make("arena"), id: Model.ID.make("contestant") }
        expect(toLLMMessages(history, model).map(({ role, content }) => ({ role, content }))).toEqual([
          { role: "user", content: [{ type: "text", text: note }] },
        ])
        yield* prompt.loop({ sessionID: a.id, stoppedShellIDs: ["sh_a"] })
        expect(yield* sessions.inbox(a.id)).toEqual([])
      }),
  )
})
