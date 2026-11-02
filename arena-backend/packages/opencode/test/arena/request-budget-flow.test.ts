import { expect, test } from "bun:test"
import { requestNeedsCompaction } from "@/arena/engine-runtime"
import { ArenaRequestBudget } from "@/arena/request-budget"

test("current V2 requests compact above the Arena savings threshold", () => {
  expect(requestNeedsCompaction({ messages: [{ role: "user", content: "hello" }] })).toBe(false)
  expect(
    requestNeedsCompaction({ messages: [{ role: "user", content: "x".repeat(ArenaRequestBudget.LIMIT * 4 + 1000) }] }),
  ).toBe(true)
})
