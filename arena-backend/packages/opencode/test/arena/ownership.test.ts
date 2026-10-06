import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { MongoClient } from "mongodb"
import { connect, type Store } from "@/arena/mongo"
import type { ChatDocument, SingleAgentRatingDocument } from "@/arena/records"

// Ownership is a MongoDB property: the partial index that only covers owned
// documents, and the update that claims unowned ratings without touching
// anyone else's. Run against the real database the dev stack starts.
const uri = process.env.OPENCODE_ARENA_MONGODB_URI
const database = `agent_arena_ownership_test_${crypto.randomUUID().replaceAll("-", "")}`

const now = new Date("2026-09-09T12:00:00.000Z")
const assignment = {
  assignmentID: "assignment",
  model: "Contestant",
  requestedReasoning: { effort: "high" },
  enforcedReasoning: { effort: "high" },
}

let store: Store
let client: MongoClient

function chat(overrides: Partial<ChatDocument> = {}): ChatDocument {
  return {
    _id: "chat",
    repository: { projectID: "project", root: "/repo", branch: "dev" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: "canonical",
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "ready",
    opencodeCommit: "commit",
    opencodeVersion: "version",
    arenaVersion: "prototype",
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
    ...overrides,
  }
}

function rating(overrides: Partial<SingleAgentRatingDocument> & { _id: string }): SingleAgentRatingDocument {
  return {
    sessionID: "canonical",
    messageID: "message",
    assignment,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

beforeAll(async () => {
  if (!uri) throw new Error("OPENCODE_ARENA_MONGODB_URI must be set to run the ownership tests")
  client = new MongoClient(uri)
  await client.connect()
  store = await connect({ uri, database })
})

afterAll(async () => {
  if (!uri) return
  await store.client.close()
  await client.db(database).dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await Promise.all([store.chats.deleteMany({}), store.singleAgentRatings.deleteMany({})])
})

describe("ownership", () => {
  test("indexes only the documents that name an owner", async () => {
    await store.createChat(chat({ _id: "unowned" }))
    await store.createChat(chat({ _id: "owned", userId: "user-1" }))

    const owned = await store.chats.find({ userId: "user-1" }).toArray()
    expect(owned.map((document) => document._id)).toEqual(["owned"])

    const indexes = await client.db(database).collection("chats").listIndexes().toArray()
    const ownership = indexes.find((index) => index.name === "userId_1_updatedAt_-1")
    expect(ownership?.partialFilterExpression).toEqual({ userId: { $type: "string" } })
  })

  test("adopts a session's unowned ratings and leaves owned ones alone", async () => {
    await store.claimSingleAgentRating(rating({ _id: "unowned", messageID: "first" }))
    await store.claimSingleAgentRating(rating({ _id: "owned", messageID: "second", userId: "user-2" }))
    await store.claimSingleAgentRating(rating({ _id: "other-session", sessionID: "elsewhere" }))

    await store.adoptSessionRatings("canonical", "user-1")

    const owners = new Map(
      (await store.singleAgentRatings.find({}).toArray()).map((document) => [document._id, document.userId]),
    )
    expect(owners.get("unowned")).toBe("user-1")
    expect(owners.get("owned")).toBe("user-2")
    expect(owners.get("other-session")).toBeUndefined()
  })
})
