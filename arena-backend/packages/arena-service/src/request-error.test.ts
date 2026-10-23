import { expect, test } from "bun:test"
import {
  paymentError,
  contextOverflowError,
  isContextOverflow,
  readContextOverflow,
  classifyPaymentError,
  networkUnavailableError,
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

test("recognizes context overflow while keeping provider identities and token limits private", () => {
  for (const error of [
    { code: "context_length_exceeded", message: "secret-model" },
    { type: "model_context_window_exceeded" },
    { code: 400, message: "This model's maximum context length is 65536 tokens. secret-provider" },
    { code: 400, metadata: { raw: '{"error":{"message":"prompt is too long for secret-model"}}' } },
  ])
    expect(isContextOverflow({ error })).toBe(true)
  expect(isContextOverflow({ error: { code: 429, message: "too many requests" } })).toBe(false)
  expect(readContextOverflow({ error: { message: "prompt is too long" } })).toBe(false)
  expect(readContextOverflow(contextOverflowError())).toBe(true)
  expect(JSON.stringify(contextOverflowError())).not.toMatch(/secret|65536/)
})
