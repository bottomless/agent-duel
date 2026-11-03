import { expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { CALIBRATION_TTL_MS, needsCalibration, readCalibration, recordCalibration } from "./request-calibration"

function memoryDb() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    db: {
      collection: () => ({
        findOne: async (filter: { _id: string }) => rows.get(filter._id) ?? null,
        replaceOne: async (filter: { _id: string }, document: Record<string, unknown>) => {
          rows.set(filter._id, document)
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
        },
      }),
    } as unknown as ArenaDb,
  }
}

const key = { userId: "user", scopeID: "scope", assignmentID: "assignment" }

test("samples only calls that can reach a quarter of the compaction level", () => {
  expect(needsCalibration(10_000, 41_779)).toBe(false)
  expect(needsCalibration(10_445, 41_779)).toBe(true)
  expect(needsCalibration(67_999, 272_000)).toBe(false)
  expect(needsCalibration(68_000, 272_000)).toBe(true)
})

test("ignores a sample past its expiry until the TTL index deletes it", async () => {
  const { db, rows } = memoryDb()
  const at = new Date("2026-10-27T00:00:00Z")
  await recordCalibration(db, key, { estimate: 20_000, promptTokens: 25_000 }, at)
  const [row] = [...rows.values()]
  expect(row?.expiresAt).toEqual(new Date(at.getTime() + CALIBRATION_TTL_MS))
  expect(await readCalibration(db, key, new Date(at.getTime() + 1_000))).toEqual({
    estimate: 20_000,
    promptTokens: 25_000,
  })
  expect(await readCalibration(db, key, new Date(at.getTime() + CALIBRATION_TTL_MS))).toBeUndefined()
})
