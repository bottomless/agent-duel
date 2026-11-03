import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Project } from "@opencode/schema/project"
import { SessionV1 } from "@/arena/session-shape"
import { Session, MoveSessionService, MessageID, PartID, SessionID } from "@/arena/session-runtime"
import { forkSessionInto, type Input } from "@/arena/fork"
import { InstanceStore } from "@/project/instance-store"

const sourceID = SessionID.make("ses_source")
const targetID = SessionID.make("ses_target")
const sourceMessageID = MessageID.make("msg_01")
const targetMessageID = MessageID.make("msg_11")
const boundary = MessageID.make("msg_12")
const source: SessionV1.SessionInfo = {
  id: sourceID,
  projectID: Project.ID.make("project"),
  slug: "source",
  directory: "/repo/src",
  version: "test",
  title: "Source",
  agent: "build",
  model: { providerID: "arena", id: "medium", variant: "high" },
  permission: [{ permission: "external_directory_write", pattern: "/repo/**", action: "deny" }],
  time: { created: 0, updated: 0 },
}
const info: SessionV1.User = {
  id: targetMessageID,
  sessionID: targetID,
  role: "user",
  agent: "build",
  model: { providerID: "arena", modelID: "medium" },
  time: { created: 0 },
}
function text(value: string): SessionV1.TextPart {
  return {
    id: PartID.make(targetMessageID as never, 0),
    messageID: targetMessageID,
    sessionID: targetID,
    type: "text",
    text: value,
  }
}
function tool(
  name: string,
  input: Record<string, unknown>,
  status: "completed" | "error" = "completed",
): SessionV1.ToolPart {
  return {
    id: PartID.make(targetMessageID as never, 1),
    messageID: targetMessageID,
    sessionID: targetID,
    type: "tool",
    tool: name,
    callID: name,
    state:
      status === "completed"
        ? { status, input, output: "saved output", title: name, metadata: {}, time: { start: 0, end: 1 } }
        : { status, input, error: "interrupted", metadata: { output: "partial output" }, time: { start: 0, end: 1 } },
  }
}
async function fork(options: Partial<Input> = {}, parts: SessionV1.Part[] = [], empty = false) {
  const written: SessionV1.Part[] = []
  const moved: unknown[] = []
  const created: unknown[] = []
  const canonical: unknown[] = []
  const user = {
    type: "user",
    id: targetMessageID,
    text: "Keep /repo/src/index.ts exactly",
    files: [{ source: { uri: "file:///repo/src/index.ts" } }],
  }
  const result = await Effect.runPromise(
    forkSessionInto({
      sessionID: sourceID,
      destination: "/copy",
      roots: { canonical: "/repo", worktree: "/copy" },
      ...options,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Session, {
            get: () => Effect.succeed(source),
            fork: (input) => {
              input.onMessageMapping?.(
                new Map([
                  [sourceMessageID, targetMessageID],
                  [MessageID.make("msg_02"), boundary],
                ]),
              )
              return empty
                ? Effect.fail(new Error("Cannot fork empty session"))
                : Effect.succeed({ ...source, id: targetID })
            },
            create: (input) =>
              Effect.sync(() => {
                created.push(input)
                return { ...source, id: targetID }
              }),
            canonicalMessages: () => Effect.succeed([user] as never),
            updateCanonicalMessage: (input) =>
              Effect.sync(() => {
                canonical.push(input.message)
              }),
            messages: () => Effect.succeed([{ info, parts }]),
            updatePart: (part) =>
              Effect.sync(() => {
                written.push(part)
                return part
              }),
          }),
          Layer.mock(MoveSessionService, {
            moveSession: (input) =>
              Effect.sync(() => {
                moved.push(input)
              }),
          }),
          Layer.mock(InstanceStore.Service, { provide: (_input, effect) => effect as never }),
        ),
      ),
    ),
  )
  return { result, written, moved, created, canonical }
}

describe("Arena fork on native sessions", () => {
  test("moves the copy and maps a subdirectory's paths from the repository root", async () => {
    const result = await fork({}, [tool("read", { filePath: "/repo/src/index.ts" })])
    expect(result.moved).toEqual([{ sessionID: targetID, directory: "/copy", moveChanges: false }])
    expect(result.written[0]).toMatchObject({ state: { input: { filePath: "/copy/src/index.ts" } } })
    expect(result.canonical).toMatchObject([
      { text: "Keep /repo/src/index.ts exactly", files: [{ source: { uri: "file:///copy/src/index.ts" } }] },
    ])
  })
  test("keeps battle prompts and output while retargeting executable paths", async () => {
    const result = await fork({ pathMode: "transcript" }, [
      text("Keep /repo/src/index.ts exactly"),
      tool("read", { filePath: "/repo/src/index.ts" }),
    ])
    expect(result.written[0]).toMatchObject({ text: "Keep /repo/src/index.ts exactly" })
    expect(result.written[1]).toMatchObject({
      state: { input: { filePath: "/copy/src/index.ts" }, output: "saved output" },
    })
  })
  test("passes source message IDs to the retargeter", async () => {
    const seen: unknown[] = []
    await fork(
      {
        part: (part, _info, id) => {
          seen.push(id)
          return part
        },
      },
      [text("port 20000")],
    )
    expect(seen).toEqual([sourceMessageID])
  })
  test("prunes reproducible old output but keeps uploads, outside reads, questions and reports", async () => {
    const parts = [
      text("Uploaded file: log\nPath: /uploads/one/log\nMIME: text/plain\nSize: 1 bytes"),
      tool("read", { filePath: "/repo/src/index.ts" }),
      tool("read", { filePath: "/uploads/one/log" }),
      tool("read", { filePath: "/outside/log" }),
      tool("question", {}),
      tool("task", {}),
      tool("skill", {}),
      tool("github_get_issue", {}),
      tool("bash", { command: "false" }, "error"),
    ]
    const result = await fork({ pruneToolOutputBefore: MessageID.make("msg_02"), pathMode: "transcript" }, parts)
    expect(result.written[1]).toMatchObject({
      state: { output: "saved output", time: { compacted: expect.any(Number) } },
    })
    for (const part of result.written.slice(2, -1))
      expect(part).toMatchObject({ state: { output: "saved output", time: { start: 0, end: 1 } } })
    expect(result.written.at(-1)).toMatchObject({
      state: { metadata: { output: "[Old tool result content cleared]" } },
    })
    expect(parts[1]).toMatchObject({ state: { time: { start: 0, end: 1 } } })
  })
  test("leaves a same-directory fork at its source and can defer moving a staged copy", async () => {
    expect((await fork({ roots: { canonical: "/repo", worktree: "/repo" } })).moved).toEqual([])
    expect((await fork({ moveSession: false })).moved).toEqual([])
  })
  test("an empty source creates a native root with its model and permissions", async () => {
    const result = await fork({}, [], true)
    expect(result.created).toEqual([
      {
        title: "Source",
        agent: "build",
        model: { providerID: "arena", modelID: "medium", variant: "high" },
        metadata: undefined,
        permissions: [{ action: "edit", resource: "/repo/**", effect: "deny" }],
        location: { directory: "/repo/src" },
      },
    ])
    expect(result.result.id).toBe(targetID)
  })
})
