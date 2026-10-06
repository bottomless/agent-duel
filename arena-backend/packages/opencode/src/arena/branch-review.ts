/**
 * What Arena does with each ref the winner changed, before anything is written.
 *
 * A winner can leave any branch, tag, or remote-tracking ref somewhere new, and the developer can
 * move the same ref while the battle runs. For every combination Arena has one proposal. It takes
 * the proposal itself only when nothing of the developer's leaves the ref: a fast-forward, the
 * agent's commits replayed onto theirs, or keeping theirs. A ref the agent only moved back, to a
 * commit the developer's ref already holds, is kept as the developer has it: the agent added
 * nothing there to bring over. Anything that would take commits off
 * a branch, delete one, move a tag, or take a branch from another worktree waits for the
 * developer, backup or not. The rules are the product decision recorded in docs/arena.md; this
 * module holds them and nothing else, so the git layer observes and the service asks.
 */

/** What the agent did to a ref between the battle start and its finalize. */
export type AgentMove = "created" | "added" | "rewrote" | "deleted"

/** What the developer's repository did to the same ref in that window. */
export type YourMove = "untouched" | "created" | "added" | "rewrote" | "deleted"

export type RefNamespace = "branch" | "tag" | "remote"

/**
 * One write Arena can make to a ref. `yours` leaves it as the developer has it; `agent_on_yours`
 * replays the agent's new commits onto the developer's tip; `yours_on_agent` replays the
 * developer's new commits onto the agent's tip. `combine` keeps the developer's tip on the
 * checked-out branch and writes the agent's changes into the files, with conflict markers where
 * the two clash. A branch that is not checked out has no files to hold markers, so it never offers
 * `combine`.
 */
export type BranchAction = "agent" | "yours" | "agent_on_yours" | "yours_on_agent" | "combine"

/** A proposal is a write Arena can make, or a request that an agent combine the two by hand. */
export type BranchProposal = BranchAction | "ask_agent"

export interface RefObservation {
  readonly namespace: RefNamespace
  readonly agentMove: AgentMove
  readonly yourMove: YourMove
  /** The developer already has everything the agent's ref holds: equal, or the agent's tip is an ancestor. */
  readonly settled: boolean
  /** Moving the developer's ref to the agent's loses nothing. */
  readonly fastForward: boolean
  /** The trunk ends on this branch, so it cannot be left deleted. */
  readonly checkout: boolean
  /** Another worktree of the developer's repository has this branch checked out. */
  readonly checkedOutElsewhere: boolean
  /** Paths each combine would conflict on. A missing entry means that combine does not apply. */
  readonly clash: Partial<Record<"agent_on_yours" | "yours_on_agent", readonly string[]>>
  /** The agent moved the ref back to a commit the developer's ref already has. */
  readonly rewound?: boolean
}

export type RefDecision =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly action: BranchAction }
  /** A remote-tracking ref Arena will not rewind; reported, never asked. */
  | { readonly kind: "skip" }
  | { readonly kind: "ask"; readonly proposal: BranchProposal; readonly choices: readonly BranchAction[] }

function ask(proposal: BranchProposal, choices: readonly BranchAction[]): RefDecision {
  return { kind: "ask", proposal, choices }
}

/**
 * A replay is proposed only when it is clean. On a clash the checked-out branch can still take the
 * agent's commits with conflict markers, which the conflicts callout then offers an agent to
 * resolve; any other branch has no files to hold markers, so it needs an agent to combine the two.
 * The choices of an `ask` are what the developer may pick instead when Arena cannot take it.
 */
function combine(
  action: "agent_on_yours" | "yours_on_agent",
  clash: readonly string[] | undefined,
  checkout: boolean,
): RefDecision {
  if (clash !== undefined && clash.length === 0) return ask(action, [action, "agent", "yours"])
  if (action === "agent_on_yours" && clash !== undefined && checkout) return ask("combine", ["combine", "agent", "yours"])
  return ask("ask_agent", ["agent", "yours"])
}

function branchDecision(observed: RefObservation): RefDecision {
  const { agentMove, yourMove } = observed
  if (agentMove !== "deleted" && observed.fastForward) return { kind: "apply", action: "agent" }
  if (agentMove === "deleted") {
    return yourMove === "untouched" ? ask("agent", ["agent", "yours"]) : ask("yours", ["yours", "agent"])
  }
  if (yourMove === "deleted") {
    return observed.checkout ? ask("agent", ["agent"]) : ask("yours", ["yours", "agent"])
  }
  if (agentMove === "rewrote") {
    if (yourMove === "untouched") return ask("agent", ["agent", "yours"])
    if (yourMove === "added") return combine("yours_on_agent", observed.clash.yours_on_agent, observed.checkout)
    return ask("ask_agent", ["agent", "yours"])
  }
  return combine("agent_on_yours", observed.clash.agent_on_yours, observed.checkout)
}

function writes(decision: RefDecision) {
  if (decision.kind === "apply") return decision.action !== "yours"
  if (decision.kind === "ask") return decision.choices.some((choice) => choice !== "yours")
  return false
}

export function decideRef(observed: RefObservation): RefDecision {
  if (observed.settled) return { kind: "none" }
  if (observed.namespace === "remote") {
    // A remote-tracking ref mirrors the server, and the next fetch sets it again. Following the
    // agent forward is harmless; anything else is left for that fetch.
    const forward = observed.agentMove !== "deleted" && observed.fastForward
    return forward ? { kind: "apply", action: "agent" } : { kind: "skip" }
  }
  // Moving a ref back adds nothing, so keeping the developer's loses nothing of the winner's. The
  // branch the winner ended on is the exception: there the rewind is likely the task ("drop the
  // last commit"), so it stays a question.
  if (observed.rewound && !observed.checkout) return { kind: "apply", action: "yours" }
  const decision = take(observed.namespace === "tag" ? tagDecision(observed) : branchDecision(observed))
  // Taking a branch detaches the worktree that has it. Its files stay, but the developer working
  // there loses the branch, so even a lossless move becomes a question. The branch the trunk ends
  // on is asked about once, as the switch, not again as a ref.
  if (observed.checkedOutElsewhere && !observed.checkout && decision.kind === "apply" && writes(decision)) {
    return ask(decision.action, [decision.action, "yours"])
  }
  return decision
}

/**
 * A proposal that removes nothing of the developer's is carried out; the rest stay questions.
 * A single choice is not a question either: the checkout's own branch must exist.
 */
function take(decision: RefDecision): RefDecision {
  if (decision.kind !== "ask" || decision.proposal === "ask_agent") return decision
  const lossless = decision.proposal === "agent_on_yours" || decision.proposal === "yours" || decision.choices.length === 1
  return lossless ? { kind: "apply", action: decision.proposal } : decision
}

function tagDecision(observed: RefObservation): RefDecision {
  // A tag names one fixed commit, so a moved tag is always a rewrite and never combines.
  if (observed.agentMove === "created" && observed.yourMove === "untouched") return { kind: "apply", action: "agent" }
  return observed.yourMove === "untouched" ? ask("agent", ["agent", "yours"]) : ask("yours", ["yours", "agent"])
}

/**
 * The action to take for a decision, given the developer's answer. Undefined means the ref still
 * needs an answer: an `ask` needs one of its choices, and `ask_agent` is never taken on its own.
 */
export function resolveRef(decision: RefDecision, answer: BranchAction | undefined): BranchAction | undefined {
  if (decision.kind === "apply") return decision.action
  if (decision.kind !== "ask") return "yours"
  if (answer !== undefined && decision.choices.includes(answer)) return answer
  return undefined
}

/** The winner against the developer's own files: conflict markers, the winner's copy, or theirs. */
export type EditsChoice = "combine" | "agent" | "yours"

/** The trunk switches to a branch another worktree has checked out: take it, or stay where it is. */
export type OccupiedChoice = "take" | "stay"

/**
 * One question the review puts to the developer. `key` names what it is about -- the full ref
 * name, or `@edits`, `@occupied`, `@busy` -- and `fingerprint` changes whenever
 * the situation behind it does, so an answer given to an older situation is not reused.
 */
export type ReviewItem =
  | {
      readonly kind: "ref"
      readonly key: string
      readonly fingerprint: string
      readonly namespace: RefNamespace
      readonly agentMove: AgentMove
      readonly yourMove: YourMove
      readonly proposal: BranchProposal
      readonly choices: readonly BranchAction[]
      /** The trunk ends on this branch. */
      readonly checkout: boolean
      readonly checkedOutAt?: string
      /** Paths the offered replay would conflict on. */
      readonly clash?: readonly string[]
      /** Where the agent's version is kept, for an agent asked to combine the two. */
      readonly agentRef?: string
      /** Commits on the developer's ref that the agent's no longer has. */
      readonly lost?: number
      /** Subjects of the newest of those commits, up to three, newest first. */
      readonly lostSubjects?: readonly string[]
      /** The agent moved the ref back to a commit the developer's already has. */
      readonly rewound?: boolean
      /** The subject of the commit the agent left the ref on. */
      readonly agentSubject?: string
    }
  | {
      /** Files where the winner meets the developer's uncommitted edits or new commits. */
      readonly kind: "edits"
      readonly key: "@edits"
      readonly fingerprint: string
      readonly paths: readonly string[]
      /** Of `paths`, those that cannot hold conflict markers; `combine` keeps the developer's copy. */
      readonly unmergeable: readonly string[]
      readonly choices: readonly EditsChoice[]
    }
  | {
      readonly kind: "occupied"
      readonly key: "@occupied"
      readonly fingerprint: string
      readonly branch: string
      readonly path: string
      readonly proposal: OccupiedChoice
      readonly choices: readonly OccupiedChoice[]
    }
  | {
      readonly kind: "busy"
      readonly key: "@busy"
      readonly fingerprint: string
      readonly operation: string
    }

/** The developer's answer to one item. */
export type ReviewAnswer = {
  readonly key: string
  readonly fingerprint: string
  readonly choice: BranchAction | OccupiedChoice
}

/** A ref Arena writes without asking, listed with the questions so the developer sees all of it. */
export type PlannedRef = { readonly ref: string; readonly action: BranchAction }

/** The answer for an item, only when it was given for the situation the item describes now. */
export function answerFor(answers: readonly ReviewAnswer[] | undefined, item: { key: string; fingerprint: string }) {
  return answers?.find((answer) => answer.key === item.key && answer.fingerprint === item.fingerprint)
}

/** Later answers replace earlier ones for the same item. */
export function mergeAnswers(previous: readonly ReviewAnswer[] | undefined, next: readonly ReviewAnswer[]) {
  const keys = new Set(next.map((answer) => answer.key))
  return [...(previous ?? []).filter((answer) => !keys.has(answer.key)), ...next]
}
