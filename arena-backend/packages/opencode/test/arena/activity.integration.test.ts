import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { Store } from "@/arena/mongo"
import { ArenaActivity } from "@/arena/activity"

interface SeedDocument { _id: string; [key: string]: unknown }

const client = new MongoClient(process.env.OPENCODE_ARENA_MONGODB_URI || "mongodb://127.0.0.1:27017")
const db = client.db(`arena_activity_test_${randomUUID().replaceAll("-", "")}`)
const store = new Store(client, db)
const start = new Date("2026-09-08T10:00:00Z")

beforeAll(async () => {
  await client.connect()
  await db.collection<SeedDocument>("chats").insertMany([
    { _id: "chat", canonicalSessionID: "canonical-now", activeTurnID: "turn", status: "battle_active" },
    { _id: "foreign", canonicalSessionID: "foreign-session", activeTurnID: "foreign-turn", status: "battle_active" },
    { _id: "archived", canonicalSessionID: "archived-session", status: "archived" },
  ])
  await db.collection<SeedDocument>("turns").insertMany([
    { _id: "turn", chatID: "chat", turnIndex: 1, sourceCanonicalSessionID: "canonical-old", state: "running", placement: { a: "hidden/model" }, userPrompt: "private prompt" },
    { _id: "unadmitted", chatID: "chat", turnIndex: 2, sourceCanonicalSessionID: "canonical-now", state: "creating" },
    { _id: "foreign-turn", chatID: "foreign", turnIndex: 1, state: "running" },
  ])
  await db.collection<SeedDocument>("runs").insertMany(["a", "b"].map((side) => ({
    _id: side, turnID: "turn", side, rootSessionID: `root-${side}`, descendantSessionIDs: [`child-${side}`],
    worktree: `/private/${side}`, runState: "pending", startedAt: start,
    assignment: { slug: "hidden/model" }, transcript: "large private transcript", services: [{ env: { SECRET: "private" } }],
  })))
})
afterAll(async () => { await db.dropDatabase(); await client.close() })

describe("read-only batched Arena activity", () => {
  test("reads only requested owners and follows the active turn, not an unadmitted newer turn", async () => {
    const records = await store.activity(["canonical-now", "missing", "archived-session"])
    expect(records.map((record) => [record.sessionID, record.chat._id, record.turn?._id])).toEqual([["canonical-now", "chat", "turn"]])
    expect(records[0].runs.map((run) => run.side).sort()).toEqual(["a", "b"])
    expect(await db.collection<SeedDocument>("chats").countDocuments()).toBe(3)
    expect(await store.activity([])).toEqual([])
  })
  test("resolves retained native handles through source and contestant ownership", async () => {
    const records = await store.activity(["canonical-old", "root-a", "child-b"])
    expect(records.map((record) => [record.sessionID, record.chat._id])).toEqual([
      ["canonical-old", "chat"], ["root-a", "chat"], ["child-b", "chat"],
    ])
  })
  test("exposes only blinded status, and never reads transcript or model metadata into the projection", async () => {
    const [record] = await store.activity(["canonical-now"])
    const projected = ArenaActivity.project(record, new Set(["a"]))
    expect(projected).toEqual({
      sessionID: "canonical-now", chatID: "chat", turnID: "turn", state: "running", resolved: false, requiresDecision: false, comparisonState: undefined, summary: undefined,
      runs: ["a", "b"].map((side) => ({ id: side, side, runState: "pending", startedAt: start.toISOString(), completedAt: undefined, needsInput: side === "a", diff: undefined })),
    })
    expect(JSON.stringify(record)).not.toContain("hidden/model")
    expect(JSON.stringify(record)).not.toContain("large private transcript")
    expect(JSON.stringify(projected)).not.toContain("/private/")
    expect(JSON.stringify(projected).length).toBeLessThan(600)
    const wire = Schema.encodeSync(Schema.toCodecJson(ArenaActivity.Session))(projected)
    expect(JSON.stringify(wire)).not.toContain('"diff":null')
    expect(JSON.stringify(wire)).not.toContain('"summary":null')
    expect(JSON.stringify(wire)).not.toContain('"comparisonState":null')
  })
  test("keeps readiness independent of comparison and clears it at durable resolution", async () => {
    await db.collection<SeedDocument>("runs").updateMany({ turnID: "turn" }, { $set: { runState: "complete", completedAt: start } })
    await db.collection<SeedDocument>("turns").updateOne({ _id: "turn" }, { $set: { state: "awaiting_vote", comparisonState: "running" } })
    let [record] = await store.activity(["canonical-now"])
    expect(ArenaActivity.project(record, new Set()).requiresDecision).toBe(true)
    await db.collection<SeedDocument>("turns").updateOne({ _id: "turn" }, { $set: { state: "applying", resolution: { kind: "vote", vote: "a", appliedSide: "a" } } })
    ;[record] = await store.activity(["canonical-now"])
    expect(ArenaActivity.project(record, new Set())).toMatchObject({ requiresDecision: false, resolved: true })
  })
})


test("projects counts and only the current comparison, bounded inside Mongo", async () => {
  await db.collection<SeedDocument>("runs").updateOne({ _id: "a" }, { $set: { diff: { files: 2, additions: 10, deletions: 3 } } });
  await db.collection<SeedDocument>("comparisons").insertOne({ _id: "summary", turnID: "turn", state: "complete", output: "🟢".repeat(5000), input: "private transcript", model: "hidden/model" });
  await db.collection<SeedDocument>("turns").updateOne({ _id: "turn" }, { $set: { comparisonID: "summary", comparisonState: "complete" } });
  let [record] = await store.activity(["canonical-now"])
  expect([...record.summary!].length).toBe(4096)
  const projected = ArenaActivity.project(record, new Set())
  expect(projected.runs[0].diff).toEqual({ files: 2, additions: 10, deletions: 3 })
  expect(projected.runs[1].diff).toBeUndefined()
  expect(JSON.stringify(record)).not.toContain("private transcript")
  expect(JSON.stringify(record)).not.toContain("hidden/model")
  await db.collection<SeedDocument>("turns").updateOne({ _id: "turn" }, { $set: { comparisonState: "pending" }, $unset: { comparisonID: "" } });
  ;[record] = await store.activity(["canonical-now"])
  expect(record.summary).toBeUndefined()
  expect(ArenaActivity.project(record, new Set()).comparisonState).toBe("pending")
})

describe("a chat's own work", () => {
  test("anchors to the first frozen base and the last applied winner", async () => {
    await db.collection<SeedDocument>("chats").insertOne({
      _id: "spanned", canonicalSessionID: "spanned-session", status: "ready", repository: { projectID: "project", root: "/repo" },
    })
    await db.collection<SeedDocument>("turns").insertMany([
      { _id: "spanned-0", chatID: "spanned", turnIndex: 0, frozenBaseSHA: "commit-0", baseSnapshot: { tree: "tree-base" }, state: "complete", appliedSide: "a", runIDs: { a: "spanned-0a", b: "spanned-0b" }, gitApplication: { state: "applied" } },
      { _id: "spanned-1", chatID: "spanned", turnIndex: 1, frozenBaseSHA: "commit-1", state: "complete", appliedSide: "b", runIDs: { a: "spanned-1a", b: "spanned-1b" }, gitApplication: { state: "applied" } },
      { _id: "spanned-2", chatID: "spanned", turnIndex: 2, frozenBaseSHA: "commit-2", state: "complete", runIDs: { a: "spanned-2a", b: "spanned-2b" }, gitApplication: { state: "blocked" } },
    ])
    await db.collection<SeedDocument>("runs").insertMany([
      { _id: "spanned-0a", turnID: "spanned-0", side: "a", runState: "complete", finalTree: "tree-first" },
      { _id: "spanned-1b", turnID: "spanned-1", side: "b", runState: "complete", finalTree: "tree-latest" },
    ])

    const [record] = await store.activity(["spanned-session"])

    expect(record.contribution).toEqual({ base: "tree-base", result: "tree-latest" })
  })

  test("moves the result anchor to a later normal turn", async () => {
    await db.collection<SeedDocument>("chats").insertOne({
      _id: "mixed", canonicalSessionID: "mixed-session", status: "ready", repository: { projectID: "project", root: "/repo" },
    })
    await db.collection<SeedDocument>("turns").insertOne({
      _id: "mixed-0", chatID: "mixed", turnIndex: 0, frozenBaseSHA: "commit-0", baseSnapshot: { tree: "tree-base" }, state: "complete", appliedSide: "a", runIDs: { a: "mixed-0a", b: "mixed-0b" }, gitApplication: { state: "applied" },
    })
    await db.collection<SeedDocument>("runs").insertOne({
      _id: "mixed-0a", turnID: "mixed-0", side: "a", runState: "complete", finalTree: "tree-battle",
    })
    await db.collection<SeedDocument>("singleAgentRatings").insertOne({
      _id: "mixed-normal", sessionID: "mixed-session", messageID: "message", createdAt: new Date("2026-09-08T10:01:00Z"), completedAt: new Date("2026-09-08T10:02:00Z"), precedingTurnCount: 1, resultTree: "tree-normal",
    })

    const [record] = await store.activity(["mixed-session"])

    expect(record.contribution).toEqual({ base: "tree-base", result: "tree-normal" })

    await db.collection<SeedDocument>("turns").insertOne({
      _id: "mixed-1", chatID: "mixed", turnIndex: 1, frozenBaseSHA: "commit-1", state: "complete", appliedSide: "b", runIDs: { a: "mixed-1a", b: "mixed-1b" }, gitApplication: { state: "applied" },
    })
    await db.collection<SeedDocument>("runs").insertOne({
      _id: "mixed-1b", turnID: "mixed-1", side: "b", runState: "complete", finalTree: "tree-later-battle",
    })

    const [afterBattle] = await store.activity(["mixed-session"])

    expect(afterBattle.contribution).toEqual({ base: "tree-base", result: "tree-later-battle" })
  })

  test("leaves a chat with nothing applied to its checkout's number", async () => {
    await db.collection<SeedDocument>("chats").insertOne({
      _id: "unapplied", canonicalSessionID: "unapplied-session", status: "ready", repository: { projectID: "project", root: "/repo" },
    })
    await db.collection<SeedDocument>("turns").insertOne({
      _id: "unapplied-0", chatID: "unapplied", turnIndex: 0, frozenBaseSHA: "commit-0", baseSnapshot: { tree: "tree-base" }, state: "running",
    })

    const [record] = await store.activity(["unapplied-session"])

    expect(record.contribution).toBeUndefined()
  })
})
