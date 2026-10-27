import { expect, test } from "bun:test"
import {
  compactionRequiredError,
  paymentError,
  classifyPaymentError,
  isContextOverflow,
  networkUnavailableError,
  readCompactionRequired,
  readNetworkUnavailable,
  readPaymentError,
} from "./request-error"

test("classifies only documented payment limit sources and discards upstream identity", () => {
  for (const [source, code] of [
    ["openrouter_in_flight_budget", "arena_temporary_budget"],
    ["openrouter_key_limit", "arena_credit_limit"],
    ["openrouter_credits", "arena_credit_limit"],
    ["unknown-provider-rule", "arena_payment_required"],
  ] as const) {
    const result = classifyPaymentError({
      error: {
        message: "secret-model at secret-provider",
        metadata: { limit_source: source, remedy_hint: "secret-provider", extra: "private" },
      },
    })
    expect(result).toEqual(paymentError(code))
    expect(result.error.message).not.toMatch(/credit|spending|payment|budget|openrouter/i)
    expect(JSON.stringify(result)).not.toMatch(/secret|private|openrouter/)
  }
})

test("unknown and malformed payment bodies stay non-transient", () => {
  for (const body of [null, {}, "html", { error: { metadata: { limit_source: 42 } } }]) {
    expect(classifyPaymentError(body).error.code).toBe("arena_payment_required")
  }
})

test("reads only the closed set of sanitized payment codes", () => {
  expect(readPaymentError(JSON.stringify(paymentError("arena_temporary_budget")))).toBe("arena_temporary_budget")
  expect(readPaymentError('{"error":{"code":"secret-provider"}}')).toBeUndefined()
  expect(readPaymentError("not JSON")).toBeUndefined()
})

test("recognizes only the offline body", () => {
  expect(readNetworkUnavailable(JSON.stringify(networkUnavailableError()))).toBe(true)
  for (const body of [
    undefined,
    "",
    "not json",
    JSON.stringify({ error: { message: "Arena contestant request failed", type: "arena_upstream_error" } }),
    JSON.stringify({ error: "Arena control plane is unavailable" }),
  ]) {
    expect(readNetworkUnavailable(body)).toBe(false)
  }
})

test("uses an exact neutral compaction contract", () => {
  expect(compactionRequiredError()).toEqual({
    error: { message: "Arena request needs compaction", type: "arena_compaction_required" },
  })
  expect(readCompactionRequired(JSON.stringify(compactionRequiredError()))).toBe(true)
  expect(readCompactionRequired(JSON.stringify({ error: { message: "Arena request needs compaction" } }))).toBe(false)
  expect(readCompactionRequired(JSON.stringify({ error: { type: "arena_compaction_required_extra" } }))).toBe(false)
})

test("recognizes provider context overflow without trusting its details", () => {
  expect(isContextOverflow(400, '{"error":{"code":"context_length_exceeded","message":"secret model 123"}}')).toBe(true)
  expect(isContextOverflow(413, '{"error":{"message":"prompt is too long"}}')).toBe(true)
  expect(isContextOverflow(400, '{"error":{"message":"invalid tool choice"}}')).toBe(false)
  expect(isContextOverflow(500, '{"error":{"message":"context length exceeded"}}')).toBe(false)
  // Quota and output-cap errors mention tokens too; they must not start a summary.
  expect(isContextOverflow(400, '{"error":{"message":"Rate limit reached: token limit per minute"}}')).toBe(false)
  expect(isContextOverflow(400, '{"error":{"message":"too many tokens requested for max_tokens"}}')).toBe(false)
})
