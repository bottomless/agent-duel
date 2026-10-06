import { describe, expect, test } from "bun:test"
import { decideRef, resolveRef, type RefObservation } from "../../src/arena/branch-review"

function observed(input: Partial<RefObservation> & Pick<RefObservation, "agentMove" | "yourMove">): RefObservation {
  return {
    namespace: "branch",
    settled: false,
    fastForward: false,
    checkout: false,
    checkedOutElsewhere: false,
    clash: {},
    ...input,
  }
}

describe("decideRef for branches", () => {
  test("applies a branch the agent created or moved forward from an untouched ref", () => {
    expect(decideRef(observed({ agentMove: "created", yourMove: "untouched", fastForward: true }))).toEqual({
      kind: "apply",
      action: "agent",
    })
    expect(decideRef(observed({ agentMove: "added", yourMove: "untouched", fastForward: true }))).toEqual({
      kind: "apply",
      action: "agent",
    })
  })

  test("does nothing when the developer already has the agent's work", () => {
    expect(decideRef(observed({ agentMove: "added", yourMove: "added", settled: true }))).toEqual({ kind: "none" })
    expect(decideRef(observed({ agentMove: "deleted", yourMove: "deleted", settled: true }))).toEqual({ kind: "none" })
  })

  test("puts the agent's commits on top of yours when both added and they replay cleanly", () => {
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "added", clash: { agent_on_yours: [] } })),
    ).toEqual({ kind: "apply", action: "agent_on_yours" })
  })

  test("proposes an agent when both added and the replay clashes", () => {
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "added", clash: { agent_on_yours: ["a.txt"] } })),
    ).toEqual({ kind: "ask", proposal: "ask_agent", choices: ["agent", "yours"] })
  })

  test("asks before putting conflict markers in the checked-out branch's files", () => {
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "added", checkout: true, clash: { agent_on_yours: ["a.txt"] } })),
    ).toEqual({ kind: "ask", proposal: "combine", choices: ["combine", "agent", "yours"] })
  })

  test("puts the agent's new commits on your rewrite", () => {
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "rewrote", clash: { agent_on_yours: [] } })),
    ).toEqual({ kind: "apply", action: "agent_on_yours" })
  })

  test("asks before the agent's rewrite takes your commits off a ref", () => {
    expect(decideRef(observed({ agentMove: "rewrote", yourMove: "untouched" }))).toEqual({
      kind: "ask",
      proposal: "agent",
      choices: ["agent", "yours"],
    })
  })

  test("proposes your new commits on the agent's rewrite, and an agent when they clash", () => {
    expect(
      decideRef(observed({ agentMove: "rewrote", yourMove: "added", clash: { yours_on_agent: [] } })),
    ).toEqual({ kind: "ask", proposal: "yours_on_agent", choices: ["yours_on_agent", "agent", "yours"] })
    expect(
      decideRef(observed({ agentMove: "rewrote", yourMove: "added", clash: { yours_on_agent: ["b.txt"] } })),
    ).toEqual({ kind: "ask", proposal: "ask_agent", choices: ["agent", "yours"] })
  })

  test("proposes an agent when both rewrote", () => {
    expect(decideRef(observed({ agentMove: "rewrote", yourMove: "rewrote" }))).toEqual({
      kind: "ask",
      proposal: "ask_agent",
      choices: ["agent", "yours"],
    })
  })

  test("asks before deleting a branch you left alone, and keeps your version when you changed it", () => {
    expect(decideRef(observed({ agentMove: "deleted", yourMove: "untouched" }))).toEqual({
      kind: "ask",
      proposal: "agent",
      choices: ["agent", "yours"],
    })
    expect(decideRef(observed({ agentMove: "deleted", yourMove: "added" }))).toEqual({ kind: "apply", action: "yours" })
    expect(decideRef(observed({ agentMove: "deleted", yourMove: "rewrote" }))).toEqual({ kind: "apply", action: "yours" })
  })

  test("leaves a branch you deleted deleted, unless the trunk ends on it", () => {
    expect(decideRef(observed({ agentMove: "added", yourMove: "deleted" }))).toEqual({ kind: "apply", action: "yours" })
    expect(decideRef(observed({ agentMove: "added", yourMove: "deleted", checkout: true }))).toEqual({
      kind: "apply",
      action: "agent",
    })
  })

  test("treats two unrelated creations of one name as both changed", () => {
    expect(decideRef(observed({ agentMove: "created", yourMove: "created" }))).toEqual({
      kind: "ask",
      proposal: "ask_agent",
      choices: ["agent", "yours"],
    })
  })

  test("asks before taking a branch another worktree has checked out", () => {
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "untouched", fastForward: true, checkedOutElsewhere: true })),
    ).toEqual({ kind: "ask", proposal: "agent", choices: ["agent", "yours"] })
    // A rewrite Arena would take on its own is a question there too, and keeping yours is not.
    expect(decideRef(observed({ agentMove: "rewrote", yourMove: "untouched", checkedOutElsewhere: true }))).toEqual({
      kind: "ask",
      proposal: "agent",
      choices: ["agent", "yours"],
    })
    expect(decideRef(observed({ agentMove: "deleted", yourMove: "added", checkedOutElsewhere: true }))).toEqual({
      kind: "apply",
      action: "yours",
    })
    // The trunk's own target is asked about as the switch, so it is not a second question here.
    expect(
      decideRef(observed({ agentMove: "added", yourMove: "untouched", fastForward: true, checkout: true, checkedOutElsewhere: true })),
    ).toEqual({ kind: "apply", action: "agent" })
  })
})

describe("decideRef for tags and remote-tracking refs", () => {
  test("creates a new tag, asks before moving one you left alone, and keeps one you changed", () => {
    expect(decideRef(observed({ namespace: "tag", agentMove: "created", yourMove: "untouched", fastForward: true }))).toEqual({
      kind: "apply",
      action: "agent",
    })
    expect(decideRef(observed({ namespace: "tag", agentMove: "rewrote", yourMove: "untouched" }))).toEqual({
      kind: "ask",
      proposal: "agent",
      choices: ["agent", "yours"],
    })
    expect(decideRef(observed({ namespace: "tag", agentMove: "rewrote", yourMove: "rewrote" }))).toEqual({
      kind: "apply",
      action: "yours",
    })
  })

  test("follows a remote-tracking ref forward and skips anything else", () => {
    expect(decideRef(observed({ namespace: "remote", agentMove: "added", yourMove: "untouched", fastForward: true }))).toEqual({
      kind: "apply",
      action: "agent",
    })
    expect(decideRef(observed({ namespace: "remote", agentMove: "rewrote", yourMove: "untouched" }))).toEqual({
      kind: "skip",
    })
    expect(decideRef(observed({ namespace: "remote", agentMove: "deleted", yourMove: "untouched" }))).toEqual({
      kind: "skip",
    })
  })
})

describe("resolveRef", () => {
  const question = decideRef(observed({ agentMove: "added", yourMove: "untouched", fastForward: true, checkedOutElsewhere: true }))

  test("takes an automatic decision without an answer", () => {
    expect(resolveRef({ kind: "apply", action: "agent" }, undefined)).toBe("agent")
    expect(resolveRef({ kind: "none" }, undefined)).toBe("yours")
    expect(resolveRef({ kind: "skip" }, undefined)).toBe("yours")
  })

  test("needs an answer from the offered choices", () => {
    expect(resolveRef(question, undefined)).toBeUndefined()
    expect(resolveRef(question, "yours_on_agent")).toBeUndefined()
    expect(resolveRef(question, "agent")).toBe("agent")
  })
})
