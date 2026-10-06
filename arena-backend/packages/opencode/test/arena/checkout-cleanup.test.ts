import { describe, expect, test } from "bun:test"
import { latestArenaChatActivity } from "../../src/arena/service"
import type { RunDocument, TurnDocument } from "../../src/arena/records"

const date = (value: string) => new Date(value)

describe("Arena checkout cleanup activity", () => {
  test("uses durable turn and run activity, excluding environment timestamps", () => {
    const turn = {
      createdAt: date("2026-01-01T00:00:00.000Z"),
      transitionTimestamps: { complete: date("2026-01-01T00:02:00.000Z") },
      updatedAt: date("2026-01-01T00:03:00.000Z"),
    } as unknown as TurnDocument
    const run = {
      startedAt: date("2026-01-01T00:01:00.000Z"),
      completedAt: date("2026-01-01T00:04:00.000Z"),
      worktreeCreatedAt: date("2026-01-02T00:00:00.000Z"),
      archivedAt: date("2026-01-03T00:00:00.000Z"),
    } as unknown as RunDocument

    expect(latestArenaChatActivity([turn], [run])).toEqual(date("2026-01-01T00:04:00.000Z"))
  })

  test("returns no activity when the chat has no turns", () => {
    expect(latestArenaChatActivity([], [])).toBeUndefined()
  })
})
