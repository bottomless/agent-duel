import { describe, expect, test } from "bun:test"
import {
  abortedResolution,
  canTransition,
  earlyResolution,
  isFinalState,
  isVoteReady,
  operationID,
  requireTransition,
  stoppedResolution,
  turnID,
  isParkedPromotion,
  isStopAbort,
  voteResolution,
} from "../../src/arena/domain"

describe("Arena domain", () => {
  test("permits the normal battle lifecycle and idempotent retries", () => {
    const states = [
      "creating",
      "worktrees_ready",
      "running",
      "finalizing",
      "awaiting_vote",
      "applying",
      "canonicalizing",
      "complete",
    ] as const

    states.slice(1).forEach((state, index) => requireTransition(states[index], state))
    expect(canTransition("running", "running")).toBe(true)
    expect(isVoteReady("awaiting_vote")).toBe(true)
    expect(isFinalState("complete")).toBe(true)
  })

  test("rejects transitions that skip finalization or apply a discarded battle", () => {
    expect(canTransition("running", "awaiting_vote")).toBe(false)
    expect(() => requireTransition("discarded", "applying")).toThrow(
      "Arena battle cannot transition from discarded to applying",
    )
  })

  test("supports recoverable failures and stopped-battle resolution", () => {
    expect(canTransition("application_failed", "applying")).toBe(true)
    expect(canTransition("awaiting_vote", "running")).toBe(true)
    expect(canTransition("awaiting_vote", "discarding")).toBe(true)
    expect(canTransition("interrupted_recovery", "awaiting_stop_resolution")).toBe(true)
    expect(canTransition("finalization_failed", "awaiting_stop_resolution")).toBe(true)
    expect(canTransition("awaiting_stop_resolution", "discarding")).toBe(true)
    expect(canTransition("creation_failed", "discarding")).toBe(true)
    expect(canTransition("finalization_failed", "discarding")).toBe(true)
    expect(canTransition("interrupted_recovery", "discarding")).toBe(true)
    expect(stoppedResolution("discard")).toEqual({
      kind: "stopped",
      resolution: "discard",
    })
    expect(stoppedResolution("apply_b")).toMatchObject({ appliedSide: "b" })
    expect(abortedResolution("failed before resolution")).toEqual({
      kind: "aborted",
      reason: "failed before resolution",
    })
  })

  test("keeps ties as completed votes while deterministically applying A", () => {
    expect(voteResolution("tie")).toEqual({
      kind: "vote",
      vote: "tie",
      appliedSide: "a",
    })
  })

  test("records an early side selection", () => {
    expect(canTransition("running", "early_selected")).toBe(true)
    expect(canTransition("early_selected", "applying")).toBe(true)
    expect(earlyResolution("b")).toEqual({
      kind: "early",
      vote: "b",
      appliedSide: "b",
    })
  })

  test("makes collision-safe turn and operation identifiers stable across retries", () => {
    expect(turnID("chat|a", 2)).toBe("turn|6:chat|a|1:2")
    expect(operationID({ turnID: turnID("chat|a", 2), operation: "session-fork", side: "a" })).toBe(
      "operation|17:turn|6:chat|a|1:2|12:session-fork|1:a|1:0",
    )
    expect(operationID({ turnID: "turn", operation: "stop" })).toBe(operationID({ turnID: "turn", operation: "stop" }))
    expect(() => turnID("chat", -1)).toThrow("Arena turn index")
    expect(() => operationID({ turnID: "turn", operation: "stop", attempt: -1 })).toThrow("Arena operation attempt")
  })
})

describe("isParkedPromotion", () => {
  test("covers the states a promotion waits on the user in", () => {
    for (const application of ["conflicted", "review", "manual", "blocked"]) {
      expect(isParkedPromotion({ state: "application_failed", gitApplication: { state: application } })).toBe(true)
    }
  })

  test("excludes every other failure, which still owns the checkout", () => {
    for (const application of ["failed", "pending", "applied"]) {
      expect(isParkedPromotion({ state: "application_failed", gitApplication: { state: application } })).toBe(false)
    }
    expect(isParkedPromotion({ state: "application_failed" })).toBe(false)
    expect(isParkedPromotion({ state: "running", gitApplication: { state: "conflicted" } })).toBe(false)
    expect(isParkedPromotion({ state: "canonicalization_failed", gitApplication: { state: "conflicted" } })).toBe(false)
  })
})

describe("isStopAbort", () => {
  test("treats the abort that ends a stopped run as the stop, not a fault", () => {
    expect(isStopAbort({ stopped: true, error: { name: "MessageAbortedError" } })).toBe(true)
  })

  test("keeps every other error on a stopped run", () => {
    expect(isStopAbort({ stopped: true, error: { name: "ProviderAuthError" } })).toBe(false)
    expect(isStopAbort({ stopped: true, error: undefined })).toBe(false)
  })

  test("keeps an abort on a run nobody stopped", () => {
    expect(isStopAbort({ stopped: false, error: { name: "MessageAbortedError" } })).toBe(false)
  })
})
