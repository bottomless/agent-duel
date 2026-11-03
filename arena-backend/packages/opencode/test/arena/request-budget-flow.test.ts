import { expect, test } from "bun:test"
import { requestNeedsCompaction, REQUEST_TOKEN_LIMIT } from "@/arena/engine-runtime"

test("current V2 requests compact above the Arena savings threshold", () => {
  expect(requestNeedsCompaction({ messages: [{ role: "user", content: "hello" }] })).toBe(false)
  expect(
    requestNeedsCompaction({ messages: [{ role: "user", content: "x".repeat(REQUEST_TOKEN_LIMIT * 4 + 1000) }] }),
  ).toBe(true)
})
