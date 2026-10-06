import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { ChatDocument, RunDocument, TurnDocument } from "@/arena/records"
import { project } from "@/arena/public"

const now = new Date("2026-09-30T00:00:00Z")
const assignment = { assignmentID: "assignment", model: "Contestant", requestedReasoning: {}, enforcedReasoning: {} }
function chat(id: string): ChatDocument {
  return {
    _id: id,
    repository: { projectID: "project", root: `/repo/${id}`, branch: "main" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: `session-${id}`,
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "ready",
    opencodeCommit: "commit",
    opencodeVersion: "version",
    arenaVersion: "arena",
    configuration: {
      modelPool: "hash",
      agent: "hash",
      plugins: "hash",
      mcp: "hash",
      skills: "hash",
      tools: "hash",
      system: "hash",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
}
function turn(chatID: string, index = 0): TurnDocument {
  const id = `${chatID}-${index}`
  return {
    _id: id,
    chatID,
    turnIndex: index,
    userPrompt: "prompt",
    frozenBaseSHA: "base",
    sourceCanonicalSessionID: `session-${chatID}`,
    canonicalTranscriptHash: "hash",
    pair: ["hidden/a", "hidden/b"],
    placement: { a: assignment, b: { ...assignment, assignmentID: "assignment-b" } },
    runIDs: { a: `${id}-a`, b: `${id}-b` },
    state: "running",
    transitionTimestamps: { running: now },
    comparisonState: "pending",
    createdAt: now,
    updatedAt: now,
  }
}
function run(turnID: string): RunDocument {
  return {
    _id: `${turnID}-a`,
    turnID,
    side: "a",
    rootSessionID: `${turnID}-session`,
    descendantSessionIDs: [],
    sourceCanonicalSessionID: "source",
    forkOperationID: `fork-${turnID}`,
    moveOperationID: `move-${turnID}`,
    proxyAssignmentID: `assignment-${turnID}`,
    assignment,
    worktree: `/repo/${turnID}/a`,
    worktreeCreatedAt: now,
    durationMs: null,
    runState: "pending",
    retries: [],
    permissionOutcomes: [],
    questionOutcomes: [],
    toolCount: 0,
    testCommands: [],
    createdAt: now,
    updatedAt: now,
  }
}
async function fixture(callback: (store: Store, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-observation-"))
  const store = await connectLocalStore({ directory })
  try {
    await callback(store, directory)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
function historyReads(store: Store) {
  const find = store.turns.find.bind(store.turns)
  let count = 0
  store.turns.find = (...args) => {
    if (typeof args[0]?.chatID === "string") count++
    return find(...args)
  }
  return () => count
}

describe("Arena store observation", () => {
  test("activity keeps the active turn, latest idle turn and latest applied contribution distinct", async () =>
    fixture(async (store) => {
      await store.createChat({ ...chat("active"), activeTurnID: "active-1", canonicalSessionID: "winner-session" })
      await store.createChat(chat("idle"))
      await store.createChat({ ...chat("archived"), status: "archived" })
      for (const id of ["active", "idle"]) {
        for (let index = 0; index < 4; index++) {
          const item = turn(id, index)
          await store.createTurn({
            ...item,
            ...(index < 2 ? { appliedSide: "a", gitApplication: { state: "applied" } } : {}),
          })
          await store.runs.insertOne({
            ...run(item._id),
            descendantSessionIDs: [`${item._id}-child`],
            finalTree: `tree-${item._id}`,
          })
        }
      }
      const ids = ["winner-session", "session-active", "active-1-child", "session-idle", "session-archived", "unknown"]
      const values = await store.activity(ids)
      expect(values.map((value) => [value.sessionID, value.turn?._id])).toEqual([
        ["winner-session", "active-1"],
        ["session-active", "active-1"],
        ["active-1-child", "active-1"],
        ["session-idle", "idle-3"],
      ])
      for (const value of values) {
        expect(value.runs.map((run) => run.turnID)).toEqual([value.turn!._id])
        expect(value.contribution).toEqual({ base: "base", result: `tree-${value.chat._id}-1` })
      }
      await store.turns.updateOne(
        { _id: "idle-3" },
        { $set: { appliedSide: "a", gitApplication: { state: "applied" } } },
      )
      expect((await store.activity(["session-idle"]))[0]?.contribution).toEqual({ base: "base", result: "tree-idle-3" })
      await store.turns.deleteMany({ _id: "idle-3" })
      const afterDelete = (await store.activity(["session-idle"]))[0]!
      expect(afterDelete.turn?._id).toBe("idle-2")
      expect(afterDelete.contribution?.result).toBe("tree-idle-1")
    }))

  test("shares narrow history only while this chat has active subscribers", async () =>
    fixture(async (store) => {
      await store.createChat(chat("chat"))
      await store.createTurn(turn("chat"))
      const reads = historyReads(store)
      const off = store.onChange(() => {}, "chat")
      const offSecond = store.onChange(() => {}, "chat")
      const [first, second] = await Promise.all([store.snapshot("chat"), store.snapshotTurn("chat-0")])
      expect(reads()).toBe(1)
      expect(project(first).history).toEqual(project(second).history)
      expect(first.history?.[0]).not.toHaveProperty("userPrompt")
      off()
      off()
      await store.snapshot("chat")
      expect(reads()).toBe(1)
      offSecond()
      await store.snapshot("chat")
      await store.snapshot("chat")
      expect(reads()).toBe(3)
      const reconnect = store.onChange(() => {}, "chat")
      await store.snapshot("chat")
      expect(reads()).toBe(4)
      reconnect()
    }))

  test("invalidates insert, update, replace, delete and writes from another connection", async () =>
    fixture(async (store, directory) => {
      await store.createChat(chat("chat"))
      const off = store.onChange(() => {}, "chat")
      expect((await store.snapshot("chat")).history).toEqual([])
      await store.createTurn(turn("chat"))
      expect((await store.snapshot("chat")).history).toHaveLength(1)
      await store.turns.updateOne({ _id: "chat-0" }, { $set: { state: "complete" } })
      expect((await store.snapshot("chat")).history?.[0].state).toBe("complete")
      await store.turns.replaceOne({ _id: "chat-0" }, { ...turn("chat"), state: "discarded" })
      expect((await store.snapshot("chat")).history?.[0].state).toBe("discarded")
      const other = await connectLocalStore({ directory })
      try {
        await other.turns.updateOne({ _id: "chat-0" }, { $set: { state: "awaiting_vote" } })
        expect((await store.snapshot("chat")).history?.[0].state).toBe("awaiting_vote")
      } finally {
        await other.close()
      }
      await store.turns.deleteMany({ chatID: "chat" })
      expect((await store.snapshot("chat")).history).toEqual([])
      off()
    }))

  test("a mutation during a read cannot populate a stale cache", async () =>
    fixture(async (store) => {
      await store.createChat(chat("chat"))
      await store.createTurn(turn("chat"))
      const off = store.onChange(() => {}, "chat")
      const find = store.turns.find.bind(store.turns)
      let mutate = true
      store.turns.find = (...args) => {
        const cursor = find(...args)
        const read = cursor.toArray.bind(cursor)
        cursor.toArray = async () => {
          const result = await read()
          if (mutate) {
            mutate = false
            await store.turns.updateOne({ _id: "chat-0" }, { $set: { state: "complete" } })
          }
          return result
        }
        return cursor
      }
      await store.snapshot("chat")
      expect((await store.snapshot("chat")).history?.[0].state).toBe("complete")
      off()
    }))

  test("run and chat changes wake the owning chat; unknown ownership falls back to all observers", async () =>
    fixture(async (store) => {
      const counts = { left: 0, right: 0, global: 0 }
      const offs: Array<() => void> = []
      for (const id of ["left", "right"] as const) {
        await store.createChat(chat(id))
        await store.createTurn(turn(id))
        await store.saveRun(run(`${id}-0`))
        offs.push(store.onChange(() => counts[id]++, id))
      }
      offs.push(store.onChange(() => counts.global++))
      await store.snapshot("left")
      await store.snapshot("right")
      counts.left = 0
      counts.right = 0
      counts.global = 0
      for (let i = 1; i <= 6; i++) await store.updateRun("left-0-a", { toolCount: i })
      expect(counts).toEqual({ left: 6, right: 0, global: 6 })
      await store.updateChat({ _id: "right" }, { $set: { updatedAt: new Date(now.getTime() + 1) } })
      expect(counts).toEqual({ left: 6, right: 1, global: 7 })
      await store.updateTurn("left-0", { state: "complete" })
      expect(counts).toEqual({ left: 7, right: 1, global: 8 })
      store.changed()
      expect(counts).toEqual({ left: 8, right: 2, global: 9 })
      offs.forEach((off) => off())
    }))
})
