import { describe, expect, test } from "bun:test"
import {
  abortedResolution,
  canDiscardBattle,
  canReopenInterruptedBattle,
  canResumeBattle,
  canRetryRun,
  canTie,
  canTransition,
  canVote,
  chatSlug,
  earlyResolution,
  generationName,
  identitiesRevealed,
  isFinalState,
  isVoteReady,
  operationID,
  requireTransition,
  stoppedResolution,
  turnID,
  isParkedPromotion,
  isStopAbort,
  MAX_MANUAL_RUN_RETRIES,
  SLOT_PATH_PATTERN,
  spareName,
  voteDiscardedReason,
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

  test("reveals every decision except a battle that never started", () => {
    expect(identitiesRevealed(undefined)).toBe(false)
    expect(identitiesRevealed(voteResolution("a"))).toBe(true)
    expect(identitiesRevealed(stoppedResolution("discard"))).toBe(true)
    expect(identitiesRevealed(abortedResolution("failed after running"))).toBe(true)
    expect(identitiesRevealed(stoppedResolution("discard", { revealed: false }))).toBe(false)
    const unstarted = abortedResolution("failed while creating", { revealed: false })
    expect(unstarted).toEqual({ kind: "aborted", reason: "failed while creating", revealed: false })
    expect(identitiesRevealed(unstarted)).toBe(false)
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

describe("canRetryRun", () => {
  const failed = { runState: "error", errorRetryable: true, finalizedAt: new Date() }

  test("offers a retry for a committed, retryable failure while the battle is undecided", () => {
    expect(canRetryRun({ state: "running" }, failed)).toBe(true)
    expect(canRetryRun({ state: "awaiting_vote" }, failed)).toBe(true)
  })

  test("refuses a failure the engine would not retry on its own", () => {
    expect(canRetryRun({ state: "running" }, { ...failed, errorRetryable: undefined })).toBe(false)
  })

  test("refuses a run that did not fail or has not committed its failure", () => {
    expect(canRetryRun({ state: "running" }, { ...failed, runState: "complete" })).toBe(false)
    expect(canRetryRun({ state: "running" }, { ...failed, finalizedAt: undefined })).toBe(false)
  })

  test("refuses once the battle is decided or stopping", () => {
    expect(canRetryRun({ state: "awaiting_vote", resolution: voteResolution("b") }, failed)).toBe(false)
    expect(canRetryRun({ state: "stopping" }, failed)).toBe(false)
    expect(canRetryRun({ state: "applying" }, failed)).toBe(false)
  })

  test("refuses a run without its worktree or out of retries", () => {
    expect(canRetryRun({ state: "running" }, { ...failed, worktreeRemovedAt: new Date() })).toBe(false)
    expect(canRetryRun({ state: "running" }, { ...failed, manualRetries: MAX_MANUAL_RUN_RETRIES - 1 })).toBe(true)
    expect(canRetryRun({ state: "running" }, { ...failed, manualRetries: MAX_MANUAL_RUN_RETRIES })).toBe(false)
  })

  test("leaves an interrupted run to the battle's resume", () => {
    expect(canRetryRun({ state: "awaiting_vote" }, { runState: "interrupted", finalizedAt: new Date() })).toBe(false)
  })
})

describe("canResumeBattle", () => {
  const interrupted = { runState: "interrupted", finalizedAt: new Date() }
  const complete = { runState: "complete", finalizedAt: new Date() }

  test("resumes an undecided battle with committed interrupted sides", () => {
    expect(canResumeBattle({ state: "awaiting_vote" }, [interrupted, interrupted])).toBe(true)
    expect(canResumeBattle({ state: "awaiting_vote" }, [complete, interrupted])).toBe(true)
  })

  test("refuses a battle with nothing interrupted, or one that is decided or running", () => {
    expect(canResumeBattle({ state: "awaiting_vote" }, [complete, complete])).toBe(false)
    expect(canResumeBattle({ state: "awaiting_vote", resolution: voteResolution("a") }, [interrupted])).toBe(false)
    expect(canResumeBattle({ state: "running" }, [interrupted, interrupted])).toBe(false)
    expect(canResumeBattle({ state: "awaiting_stop_resolution" }, [interrupted, interrupted])).toBe(false)
  })

  test("leaves Discard as the only other choice while the battle can resume", () => {
    const finished = { side: "a" as const, selectable: true, ...complete }
    const cutOff = { side: "b" as const, selectable: false, ...interrupted }
    expect(canDiscardBattle({ state: "awaiting_vote" }, [finished, cutOff])).toBe(true)
    expect(canTie({ state: "awaiting_vote" }, [finished, cutOff])).toBe(false)
  })

  test("refuses unless every interrupted side can resume, so none goes on alone", () => {
    expect(canResumeBattle({ state: "awaiting_vote" }, [interrupted, { ...interrupted, finalizedAt: undefined }])).toBe(
      false,
    )
    expect(
      canResumeBattle({ state: "awaiting_vote" }, [interrupted, { ...interrupted, worktreeRemovedAt: new Date() }]),
    ).toBe(false)
  })
})

describe("canReopenInterruptedBattle", () => {
  const settled = { finalizedAt: new Date() }
  const working = { environmentReadyAt: new Date() }

  test("reopens a running or finalizing battle whose sides settled or had their environment", () => {
    expect(canReopenInterruptedBattle({ state: "running" }, [settled, working])).toBe(true)
    expect(canReopenInterruptedBattle({ state: "running" }, [working, working])).toBe(true)
    expect(canReopenInterruptedBattle({ state: "finalizing" }, [settled, settled])).toBe(true)
    expect(canReopenInterruptedBattle({ state: "interrupted_recovery" }, [settled, working])).toBe(true)
  })

  test("leaves a battle the voter stopped, or one still in setup, to the stopped recovery", () => {
    expect(
      canReopenInterruptedBattle(
        { state: "interrupted_recovery", transitionTimestamps: { stopping: new Date() } },
        [settled, working],
      ),
    ).toBe(false)
    expect(canReopenInterruptedBattle({ state: "stopping" }, [settled, working])).toBe(false)
    expect(canReopenInterruptedBattle({ state: "creating" }, [working, working])).toBe(false)
    expect(canReopenInterruptedBattle({ state: "running" }, [settled, {}])).toBe(false)
    expect(canReopenInterruptedBattle({ state: "running" }, [settled, { ...working, worktreeRemovedAt: new Date() }])).toBe(
      false,
    )
    expect(canReopenInterruptedBattle({ state: "running" }, [working])).toBe(false)
  })
})

describe("canTie and canDiscardBattle", () => {
  const chosen = (side: "a" | "b") => ({ side, selectable: true })
  const failed = (side: "a" | "b") => ({ side, selectable: false })
  const both = [chosen("a"), chosen("b")]
  const neither = [failed("a"), failed("b")]
  const one = [failed("a"), chosen("b")]

  test("ties only two results that can be chosen", () => {
    expect(canTie({ state: "awaiting_vote" }, both)).toBe(true)
    expect(canTie({ state: "awaiting_vote" }, one)).toBe(false)
    expect(canTie({ state: "awaiting_vote" }, neither)).toBe(false)
    expect(canTie({ state: "awaiting_vote" }, [chosen("a")])).toBe(false)
  })

  test("discards a finished battle only when neither result can be chosen", () => {
    expect(canDiscardBattle({ state: "awaiting_vote" }, neither)).toBe(true)
    expect(canDiscardBattle({ state: "awaiting_vote" }, one)).toBe(false)
    expect(canDiscardBattle({ state: "awaiting_vote" }, both)).toBe(false)
  })

  test("votes only for a result that can be chosen", () => {
    const awaiting = { state: "awaiting_vote" as const }
    expect(canVote(awaiting, neither, "a")).toBe(false)
    expect(canVote(awaiting, neither, "b")).toBe(false)
    expect(canVote(awaiting, neither, "tie")).toBe(false)
    expect(canVote(awaiting, one, "a")).toBe(false)
    expect(canVote(awaiting, one, "b")).toBe(true)
    expect(canVote(awaiting, both, "tie")).toBe(true)
    expect(canVote({ state: "awaiting_vote", resolution: voteResolution("a") }, both, "a")).toBe(false)
    expect(canVote({ state: "running" }, both, "a")).toBe(false)
  })

  test("a vote against a failed side is recorded as discarded", () => {
    const settled = (side: "a" | "b", selectable: boolean, runState = selectable ? "complete" : "error") => ({
      side,
      selectable,
      runState,
      finalizedAt: new Date(0),
    })
    expect(voteDiscardedReason(voteResolution("b"), [settled("a", false), settled("b", true)])).toBe(
      "contestant_failed",
    )
    expect(voteDiscardedReason(voteResolution("b"), [settled("a", true), settled("b", true)])).toBeUndefined()
    expect(voteDiscardedReason(voteResolution("tie"), [settled("a", true), settled("b", true)])).toBeUndefined()
    // An early pick needs the other side still working.
    expect(
      voteDiscardedReason(earlyResolution("a"), [settled("a", true), settled("b", false, "stopped")]),
    ).toBeUndefined()
    // A side kept after Stop counts only when the other side was cut off by the stop, not failed.
    expect(
      voteDiscardedReason(stoppedResolution("apply_a"), [settled("a", false, "stopped"), settled("b", false)]),
    ).toBe("contestant_failed")
    expect(
      voteDiscardedReason(stoppedResolution("apply_a"), [
        settled("a", false, "stopped"),
        settled("b", false, "stopped"),
      ]),
    ).toBeUndefined()
    expect(voteDiscardedReason(stoppedResolution("discard"), [settled("a", true), settled("b", false)])).toBeUndefined()
    expect(voteDiscardedReason(undefined, [settled("a", false), settled("b", true)])).toBeUndefined()
  })

  test("discards a stopped battle whatever its results", () => {
    expect(canDiscardBattle({ state: "awaiting_stop_resolution" }, both)).toBe(true)
    expect(canDiscardBattle({ state: "awaiting_stop_resolution" }, neither)).toBe(true)
  })

  test("refuses both once the battle is decided or not waiting on the voter", () => {
    const decided = { state: "awaiting_vote" as const, resolution: voteResolution("a") }
    expect(canTie(decided, both)).toBe(false)
    expect(canDiscardBattle(decided, neither)).toBe(false)
    expect(canTie({ state: "running" }, both)).toBe(false)
    expect(canDiscardBattle({ state: "running" }, neither)).toBe(false)
  })
})

describe("Arena slot names", () => {
  const slotPath = new RegExp(`^${SLOT_PATH_PATTERN}$`)

  test("the slot path pattern matches every name a slot is given", () => {
    const chat = chatSlug("chat_01HZX")
    for (const name of [
      generationName(0, "a"),
      generationName(0, "b"),
      generationName(41, "a"),
      spareName("0a1b2c3d"),
    ]) {
      expect(`${chat}/${name}`).toMatch(slotPath)
    }
  })

  test("the slot path pattern matches nothing else", () => {
    const chat = chatSlug("chat_01HZX")
    for (const path of [
      `${chat}/generation-0-a`,
      `${chat}/generation-1-c`,
      `${chat}/generation-1-a.`,
      `${chat}/spare-0a1b2c3`,
      `${chat}/my-worktree`,
      `chat/generation-1-a`,
    ]) {
      expect(path).not.toMatch(slotPath)
    }
  })
})
