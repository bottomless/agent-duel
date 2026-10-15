import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { SingleAgentRatingDocument } from "@/arena/records"
import { connectLocalStore } from "@/arena/local-store"

const sessionID = "session-single-agent"
const assignment = {
  assignmentID: "assignment",
  model: "Contestant",
  requestedReasoning: { effort: "high" as const },
  enforcedReasoning: { effort: "high" as const },
}

function rating(input: {
  id: string
  modelSize?: "medium" | "frontier"
  createdAt: Date
  completedAt?: Date
}): SingleAgentRatingDocument {
  return {
    _id: input.id,
    sessionID,
    messageID: `message-${input.id}`,
    ...(input.modelSize ? { modelSize: input.modelSize } : {}),
    assignment: { ...assignment, assignmentID: `assignment-${input.id}` },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  }
}

describe("single-agent ratings in the local SQLite store", () => {
  test("gates, snapshots, validates, and clears frontier ratings durably", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "single-agent-rating-"))
    const store = await connectLocalStore({ directory })
    const at = new Date("2026-01-01T00:00:00.000Z")
    try {
      const active = rating({ id: "rating-active", modelSize: "frontier", createdAt: at })
      const older = rating({
        id: "rating-older",
        modelSize: "frontier",
        createdAt: new Date(at.getTime() + 1),
        completedAt: new Date(at.getTime() + 2),
      })
      const medium = rating({
        id: "rating-medium",
        modelSize: "medium",
        createdAt: new Date(at.getTime() + 3),
        completedAt: new Date(at.getTime() + 4),
      })
      const legacy = rating({
        id: "rating-legacy",
        createdAt: new Date(at.getTime() + 5),
        completedAt: new Date(at.getTime() + 6),
      })
      await store.singleAgentRatings.insertOne(active)
      await store.singleAgentRatings.insertOne(older)
      await store.singleAgentRatings.insertOne(medium)

      expect((await store.pendingSingleAgentRating(sessionID))?._id).toBe(active._id)
      expect((await store.snapshotSingleAgentRating(sessionID))?._id).toBe(active._id)
      await expect(
        store.recordSingleAgentVote({
          sessionID,
          ratingID: active._id,
          vote: "up",
          model: "Contestant",
        }),
      ).rejects.toThrow("not complete")
      await expect(
        store.recordSingleAgentVote({
          sessionID: "other-session",
          ratingID: active._id,
          vote: "up",
          model: "Contestant",
        }),
      ).rejects.toThrow("not found")

      await store.completeSingleAgentRating({ sessionID, messageID: active.messageID, at: at })
      expect((await store.snapshotSingleAgentRating(sessionID))?._id).toBe(active._id)
      await store.recordSingleAgentVote({ sessionID, ratingID: active._id, vote: "up", model: "Contestant" })
      expect((await store.pendingSingleAgentRating(sessionID))?._id).toBe(older._id)
      expect((await store.snapshotSingleAgentRating(sessionID))?._id).toBe(older._id)

      await store.recordSingleAgentVote({ sessionID, ratingID: older._id, vote: "down", model: "Contestant" })
      await store.recordSingleAgentVote({ sessionID, ratingID: older._id, vote: "down", model: "Contestant" })
      expect(await store.pendingSingleAgentRating(sessionID)).toBeNull()

      await store.singleAgentRatings.insertOne(legacy)
      expect(await store.pendingSingleAgentRating(sessionID)).toBeNull()
    } finally {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
