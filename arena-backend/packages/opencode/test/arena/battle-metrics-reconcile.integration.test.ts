import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { Store } from "@/arena/mongo"

interface SeedDocument {
  _id: string
  [key: string]: unknown
}

const client = new MongoClient(process.env.OPENCODE_ARENA_MONGODB_URI || "mongodb://127.0.0.1:27017")
const db = client.db(`arena_reconcile_test_${randomUUID().replaceAll("-", "")}`)
const store = new Store(client, db)

beforeAll(async () => {
  await client.connect()
  await db.collection<SeedDocument>("turns").insertMany([
    // resolved, no row at all: the case a restart between the vote and the
    // forked write leaves behind, which nothing else ever notices.
    { _id: "missing", chatID: "chat", resolution: { kind: "vote" }, updatedAt: new Date(3) },
    // resolved, row written against an older definition
    { _id: "stale", chatID: "chat", resolution: { kind: "vote" }, updatedAt: new Date(2) },
    // resolved and current: must be left alone
    { _id: "current", chatID: "chat", resolution: { kind: "vote" }, updatedAt: new Date(1) },
    // never resolved: nothing to compute yet
    { _id: "unresolved", chatID: "chat", updatedAt: new Date(4) },
  ])
  await db.collection<SeedDocument>("battleMetrics").insertMany([
    { _id: "stale", schemaVersion: 2, turnID: "stale" },
    { _id: "current", schemaVersion: 3, turnID: "current" },
  ])
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

describe("Arena battle metrics reconciliation", () => {
  test("finds rows that are missing or behind, and leaves current ones alone", async () => {
    const stale = await store.staleBattleMetrics(3, 100)
    expect(stale.map((turn) => turn._id).sort()).toEqual(["missing", "stale"])
  })

  test("treats a row ahead of the asked-for version as current", async () => {
    // A daemon rolled back mid-deploy must not rewrite newer rows with older definitions.
    expect((await store.staleBattleMetrics(2, 100)).map((turn) => turn._id).sort()).toEqual(["missing"])
  })

  test("bounds the batch so catch-up cannot monopolise startup", async () => {
    expect(await store.staleBattleMetrics(3, 1)).toHaveLength(1)
  })
})
