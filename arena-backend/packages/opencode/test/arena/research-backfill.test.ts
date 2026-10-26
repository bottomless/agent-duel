import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { rename } from "node:fs/promises"
import path from "node:path"
import { connectLocalStore } from "../../src/arena/local-store"
import { ArenaTranscriptArtifact } from "../../src/arena/transcript-artifact"
import { resolveResearchDocument, type ResearchRecord } from "@agent-duel/arena-service/research-protocol"
import { tmpdir } from "../fixture/fixture"

type LocalStore = Awaited<ReturnType<typeof connectLocalStore>>
async function seed(local: LocalStore, owner: string, suffix = owner) {
  await local.db.collection("chats").insertOne({ _id: `chat-${suffix}`, userId: owner })
  await local.db.collection("turns").insertOne({ _id: `turn-${suffix}`, chatID: `chat-${suffix}` })
  await local.db.collection("runs").insertOne({ _id: `run-${suffix}`, turnID: `turn-${suffix}` })
  const archived = {
    text: `Recovered ${suffix}`,
    url: `data:image/png;base64,${Buffer.from(`image-${suffix}`).toString("base64")}`,
  }
  await ArenaTranscriptArtifact.write(local, { runID: `run-${suffix}`, turnID: `turn-${suffix}`, archived })
  await local.db
    .collection("sessionArchives")
    .insertOne({ _id: `run-${suffix}|archive`, runID: `run-${suffix}`, turnID: `turn-${suffix}`, truncated: false })
  return archived
}
function records(local: LocalStore) {
  return local.researchQueue!.peek(100).map((row) => JSON.parse(row.json) as ResearchRecord)
}

describe("historical research backfill", () => {
  test("recovers only the signed-in account's complete archives, including images, once per partition", async () => {
    await using dir = await tmpdir()
    const legacy = await connectLocalStore({ directory: dir.path })
    const original = await seed(legacy, "owner-a")
    await seed(legacy, "owner-b")
    await seed(legacy, "")
    await legacy.db.collection("artifacts").insertOne({
      _id: "truncated",
      runID: "run-owner-a",
      kind: "transcript",
      truncated: true,
      data: Buffer.from("partial"),
    })
    await legacy.close()
    const local = await connectLocalStore({ directory: dir.path, researchPartition: "owner-a" })
    try {
      expect(local.researchQueue!.count).toBe(0)
      expect(await local.backfillResearch("owner-a", new AbortController().signal)).toBe(true)
      const uploaded = records(local)
      expect(uploaded.map((record) => record.collection).sort()).toEqual([
        "artifacts",
        "chats",
        "images",
        "runs",
        "sessionArchives",
        "turns",
      ])
      expect(uploaded.some((record) => record.id.includes("owner-b") || record.id === "truncated")).toBe(false)
      const transcript = uploaded.find((record) => record.collection === "artifacts")!
      const document = await resolveResearchDocument(transcript.document, async () => null)
      const decoded = ArenaTranscriptArtifact.decode({
        ...document,
        data: Buffer.from(document!.data as string, "base64"),
      } as Parameters<typeof ArenaTranscriptArtifact.decode>[0])
      expect(decoded.text).toBe(original.text)
      expect(uploaded.find((record) => record.collection === "images")!.document!.data).toBe(original.url.split(",")[1])
      local.researchQueue!.acknowledge(local.researchQueue!.peek(100))
      expect(await local.backfillResearch("owner-a", new AbortController().signal)).toBe(true)
      expect(local.researchQueue!.count).toBe(0)
    } finally {
      await local.close()
    }
    const other = await connectLocalStore({ directory: dir.path, researchPartition: "owner-b" })
    try {
      expect(await other.backfillResearch("owner-b", new AbortController().signal)).toBe(true)
      expect(
        records(other)
          .filter((record) => record.collection === "chats")
          .map((record) => record.id),
      ).toEqual(["chat-owner-b"])
    } finally {
      await other.close()
    }
  })

  test("resumes an interrupted backfill after reopening and never replaces a newer local revision with an old snapshot", async () => {
    await using dir = await tmpdir()
    const legacy = await connectLocalStore({ directory: dir.path })
    await seed(legacy, "owner-a")
    await legacy.close()
    const controller = new AbortController()
    const interrupted = await connectLocalStore({
      directory: dir.path,
      researchPartition: "owner-a",
      onMutation: () => controller.abort(),
    })
    expect(await interrupted.backfillResearch("owner-a", controller.signal)).toBe(false)
    expect(interrupted.researchQueue!.count).toBe(1)
    const firstRevision = records(interrupted)[0].revision
    await interrupted.close()
    const resumed = await connectLocalStore({ directory: dir.path, researchPartition: "owner-a" })
    try {
      await resumed.db.collection("runs").updateOne({ _id: "run-owner-a" }, { $set: { state: "latest" } })
      expect(await resumed.backfillResearch("owner-a", new AbortController().signal)).toBe(true)
      const uploaded = records(resumed)
      expect(uploaded.filter((record) => record.collection === "chats")).toHaveLength(1)
      expect(
        uploaded
          .filter((record) => record.collection === "runs")
          .every((record) => record.document?.state === "latest" && record.revision > firstRevision),
      ).toBe(true)
      expect(uploaded.filter((record) => record.collection === "artifacts")).toHaveLength(1)
      expect(uploaded.filter((record) => record.collection === "images")).toHaveLength(1)
    } finally {
      await resumed.close()
    }
  })

  test("an unreadable archive remains pending while other history progresses, and recovers when its file returns", async () => {
    await using dir = await tmpdir()
    const legacy = await connectLocalStore({ directory: dir.path })
    await seed(legacy, "owner-a", "first")
    await seed(legacy, "owner-a", "second")
    await legacy.close()
    const sqlite = new Database(path.join(dir.path, "arena.sqlite"))
    const row = sqlite
      .query<{ document: string }, []>(
        "SELECT document FROM arena_documents WHERE collection = 'artifacts' AND id = 'run-first|transcript'",
      )
      .get()!
    const file = JSON.parse(row.document).artifactPath as string
    await rename(file, `${file}.offline`)
    const local = await connectLocalStore({ directory: dir.path, researchPartition: "owner-a" })
    try {
      expect(await local.backfillResearch("owner-a", new AbortController().signal)).toBe(false)
      expect(records(local).some((record) => record.id === "run-second|transcript")).toBe(true)
      expect(records(local).some((record) => record.id === "run-first|transcript")).toBe(false)
      expect(sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM arena_research_backfill").get()!.n).toBe(1)
      await rename(`${file}.offline`, file)
      expect(await local.backfillResearch("owner-a", new AbortController().signal)).toBe(true)
      expect(records(local).filter((record) => record.id === "run-first|transcript")).toHaveLength(1)
      expect(sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM arena_research_backfill").get()!.n).toBe(0)
    } finally {
      await local.close()
      sqlite.close()
    }
  })
})
