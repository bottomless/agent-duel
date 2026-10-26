import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { settleAutoAccept } from "../../src/arena/service"

// `reads` are what the run holds at each read after the first; `sets` are what reached the worktree.
const settle = (initial: boolean, reads: boolean[]) => {
  const sets: boolean[] = []
  const remaining = [...reads]
  return Effect.runPromise(
    settleAutoAccept(
      initial,
      Effect.sync(() => remaining.shift() ?? !initial),
      (enabled) => Effect.sync(() => void sets.push(enabled)),
    ),
  ).then(() => ({ sets, unread: remaining.length }))
}

describe("Arena Auto Accept settling", () => {
  test("sets the value it read once when nothing toggles it", async () => {
    expect(await settle(true, [true])).toEqual({ sets: [true], unread: 0 })
  })

  test("ends on a toggle that landed between the read and the set", async () => {
    // The run said off, then the voter turned Auto Accept on before the first set reached the worktree.
    expect(await settle(false, [true, true])).toEqual({ sets: [false, true], unread: 0 })
  })

  test("follows the voter through more than one toggle", async () => {
    expect(await settle(false, [true, false, false])).toEqual({ sets: [false, true, false], unread: 0 })
  })
})
