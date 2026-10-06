import { describe, expect, test } from "bun:test"
import {
  computeBattleMetrics,
  finalAssistantText,
  mentionedAlias,
  reviewEffort,
  textMessageCount,
  wordCount,
} from "@/arena/metrics"
import type { ChatDocument, ReviewEventDocument, RunDocument, TurnDocument } from "@/arena/records"

function event(offsetMs: number, rest: Partial<ReviewEventDocument>): ReviewEventDocument {
  return {
    _id: `event|${rest.mountId ?? "m1"}|${offsetMs}`,
    turnID: "turn",
    chatID: "chat",
    mountId: "m1",
    offsetMs,
    clientAt: new Date(offsetMs),
    receivedAt: new Date(offsetMs),
    ...rest,
  } as ReviewEventDocument
}

/** A second viewing of the same battle: offsets restart, arrival keeps going. */
function remount(offsetMs: number, receivedAt: number, rest: Partial<ReviewEventDocument>) {
  return event(offsetMs, { ...rest, mountId: "m2", receivedAt: new Date(receivedAt) })
}

describe("ArenaMetrics review effort", () => {
  test("credits a pane with the time spent after it opened, not before", () => {
    // The gap after a tab.viewed belongs to the tab that just opened. Crediting
    // it to the previous pane silently moves every tab's reading time one tab
    // back and leaves the first one at zero.
    const effort = reviewEffort(
      [
        event(0, { type: "battle.opened" }),
        event(1000, { type: "tab.viewed", tab: "verdict" }),
        event(4000, { type: "tab.viewed", tab: "changes" }),
        event(9000, { type: "file.selected", file: "x.ts", index: 0 }),
      ],
    )
    expect(effort?.dwellMsByPane).toEqual({ verdict: 3000, changes: 5000 })
    expect(effort?.panesOpened).toEqual(["verdict", "changes"])
    // The second before the first tab opened is not reading time; 3000 + 5000.
    expect(effort?.activeMs).toBe(8000)
  })

  test("does not count time with the window blurred", () => {
    const effort = reviewEffort(
      [
        event(0, { type: "battle.opened" }),
        event(1000, { type: "tab.viewed", tab: "verdict" }),
        event(2000, { type: "window.blur" }),
        event(5000, { type: "window.focus" }),
        event(6000, { type: "verdict.expanded" }),
      ],
    )
    expect(effort?.activeMs).toBe(2000)
    expect(effort?.dwellMsByPane.verdict).toBe(2000)
  })

  test("drops an idle gap rather than counting a lunch break as reading", () => {
    const effort = reviewEffort(
      [
        event(0, { type: "battle.opened" }),
        event(1000, { type: "tab.viewed", tab: "changes" }),
        event(200_000, { type: "file.selected", file: "a.ts", index: 0 }),
      ],
    )
    // The idle gap is dropped and the second before the tab opened never counted,
    // so a battle the voter opened and walked away from scores nothing.
    expect(effort?.activeMs).toBe(0)
    expect(effort?.dwellMsByPane.changes).toBeUndefined()
  })

  test("closes a review that ends while blurred", () => {
    const effort = reviewEffort(
      [
        event(0, { type: "battle.opened" }),
        event(1000, { type: "tab.viewed", tab: "changes" }),
        event(2000, { type: "window.blur" }),
        event(9000, { type: "file.selected", file: "a.ts", index: 0 }),
      ],
    )
    expect(effort?.activeMs).toBe(1000)
  })

  test("orders by offset and counts a file once however often it is opened", () => {
    const effort = reviewEffort(
      [
        event(3000, { type: "file.selected", file: "a.ts", index: 0 }),
        event(0, { type: "battle.opened" }),
        event(1000, { type: "tab.viewed", tab: "changes" }),
        event(2000, { type: "file.selected", file: "a.ts", index: 0 }),
      ],
    )
    expect(effort?.filesViewed).toBe(1)
    expect(effort?.activeMs).toBe(2000)
  })

  test("measures the first interaction from the voter, not from the window", () => {
    const effort = reviewEffort(
      [
        event(0, { type: "battle.opened" }),
        event(500, { type: "window.focus" }),
        event(1000, { type: "tab.viewed", tab: "changes" }),
      ],
    )
    expect(effort?.msToFirstInteraction).toBe(1000)
  })

  test("keeps each mounting of the card on its own timeline", () => {
    // A card mounted twice restarts `offsetMs` at zero, so the second mount's
    // events sort in among the first's. Sorting them together invents gaps
    // between events that were minutes apart, and pairs a blur from one
    // viewing with a focus from the other.
    const effort = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "tab.viewed", tab: "changes" }),
      event(4000, { type: "file.selected", file: "a.ts", index: 0 }),
      remount(0, 600_000, { type: "battle.opened" }),
      remount(1000, 601_000, { type: "tab.viewed", tab: "verdict" }),
      remount(3000, 603_000, { type: "verdict.expanded" }),
    ])
    // Per mount, only the time with a tab on screen: 3000 + 2000. The second
    // before each mount's tab opens is not reading, so `activeMs` is exactly the
    // dwell total. Interleaved, both would be nonsense.
    expect(effort?.activeMs).toBe(5000)
    expect(effort?.dwellMsByPane).toEqual({ changes: 3000, verdict: 2000 })
    expect(effort?.panesOpened).toEqual(["changes", "verdict"])
    // Measured from the first viewing, not the fastest one.
    expect(effort?.msToFirstInteraction).toBe(1000)
  })

  test("separates what the voter did from what the window reported", () => {
    const effort = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "window.blur" }),
      event(2000, { type: "window.focus" }),
      event(3000, { type: "tab.viewed", tab: "changes" }),
      event(4000, { type: "file.selected", file: "a.ts", index: 0 }),
    ])
    expect(effort?.eventCount).toBe(5)
    expect(effort?.interactionCount).toBe(2)
  })

  test("counts each contestant's preview once, however often it is opened", () => {
    const effort = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "preview.opened", side: "a" }),
      event(2000, { type: "preview.opened", side: "b" }),
      event(3000, { type: "preview.opened", side: "a" }),
    ])
    expect(effort?.previewsOpened).toBe(2)
    expect(reviewEffort([event(0, { type: "battle.opened" })])?.previewsOpened).toBe(0)
  })

  test("separates leaving the verdict folded from having nothing to unfold", () => {
    // A short report shows whole and offers no button, so an unexpanded verdict
    // and an unfoldable one must not both read as `false`.
    const unfoldable = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "tab.viewed", tab: "verdict" }),
    ])
    expect(unfoldable?.verdictExpanded).toBeUndefined()

    const leftFolded = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "verdict.folded" }),
    ])
    expect(leftFolded?.verdictExpanded).toBe(false)

    const opened = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "verdict.folded" }),
      event(2000, { type: "verdict.expanded" }),
    ])
    expect(opened?.verdictExpanded).toBe(true)
  })

  test("scores a vote cast without a glance at nothing", () => {
    // Taken from a recorded battle: the only two events are the card opening and
    // the card switching to the verdict when the comparison landed, 116s later.
    // Counting that gap read as two minutes of study for a vote cast blind, and
    // ranked it above battles that were actually reviewed.
    const blind = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(116_382, { type: "tab.viewed", tab: "verdict" }),
    ])
    expect(blind?.activeMs).toBe(0)
    expect(blind?.dwellMsByPane).toEqual({})
  })

  test("does not count the fold the card offers as something the voter did", () => {
    // `verdict.folded` is the card reporting that the report was long enough to
    // fold. Only `verdict.expanded` is a click.
    const effort = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "verdict.folded" }),
      event(2000, { type: "tab.viewed", tab: "verdict" }),
    ])
    expect(effort?.interactionCount).toBe(1)
    expect(effort?.msToFirstInteraction).toBe(2000)
    // Still recorded, so an unexpanded verdict stays distinguishable from no fold.
    expect(effort?.verdictExpanded).toBe(false)
  })

  test("counts each contestant's vote hover once, and never invents one", () => {
    // The event a card cannot fake: only a pointer produces it. This is what tells a
    // reader who looked and voted from a voter who clicked without looking, and the
    // run that motivated it could not tell those apart at all.
    const swept = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "vote.hovered", side: "a" }),
      event(2000, { type: "vote.hovered", side: "b" }),
      event(3000, { type: "vote.hovered", side: "a" }),
    ])
    expect(swept?.votesHovered).toBe(2)
    // A hover is the pointer, not a click: it must not inflate the count of things
    // the voter chose to open.
    expect(swept?.interactionCount).toBe(0)

    const blind = reviewEffort([event(0, { type: "battle.opened" })])
    expect(blind?.votesHovered).toBe(0)
  })

  test("keeps the deepest point reached in a diff, and stays absent when nothing scrolled", () => {
    const read = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "tab.viewed", tab: "changes" }),
      event(2000, { type: "diff.scrolled", file: "a.ts", depth: 0.4 }),
      event(3000, { type: "diff.scrolled", file: "a.ts", depth: 0.9 }),
      // A second, shorter file must not drag the high-water mark back down.
      event(4000, { type: "diff.scrolled", file: "b.ts", depth: 0.2 }),
    ])
    expect(read?.deepestDiffDepth).toBeCloseTo(0.9)
    // Repeats as the reader descends, so it is not a click either.
    expect(read?.interactionCount).toBe(1)

    // A diff shorter than its viewport cannot be scrolled; absent beats a 0 that
    // would read as "never bothered".
    const unscrollable = reviewEffort([
      event(0, { type: "battle.opened" }),
      event(1000, { type: "tab.viewed", tab: "changes" }),
    ])
    expect(unscrollable?.deepestDiffDepth).toBeUndefined()
  })

  test("has nothing to say about a review that never happened", () => {
    expect(reviewEffort([])).toBeUndefined()
    const opened = reviewEffort([event(0, { type: "battle.opened" })])
    expect(opened?.activeMs).toBe(0)
    expect(opened?.msToFirstInteraction).toBeUndefined()
  })
})

describe("ArenaMetrics blinding leak", () => {
  test("names the vendor the contestant actually is", () => {
    expect(mentionedAlias("I'm Claude, and I added the endpoint.", "anthropic/claude-opus-4")).toBe("Claude")
    expect(mentionedAlias("As Grok, I refactored the parser.", "x-ai/grok-4.6")).toBe("Grok")
    expect(mentionedAlias("Added a Z.ai integration.", "z-ai/glm-5.2")).toBe("Z.ai")
  })

  test("ignores a vendor the contestant is not", () => {
    expect(mentionedAlias("I'm Claude, and I added the endpoint.", "x-ai/grok-4.6")).toBeUndefined()
  })

  test("does not match a vendor buried inside another word", () => {
    // "encrypt" contains gpt, "grokking" contains grok, "metagame" contains meta.
    expect(mentionedAlias("The encryption helper was updated.", "openai/gpt-5")).toBeUndefined()
    expect(mentionedAlias("Updated grokking docs.", "x-ai/grok-4.6")).toBeUndefined()
    expect(mentionedAlias("Refactored the metagame module.", "meta/llama-4")).toBeUndefined()
  })
})

describe("ArenaMetrics summary", () => {
  test("counts words in the reply the voter reads", () => {
    expect(wordCount("one two three")).toBe(3)
    expect(wordCount("  ")).toBe(0)
    expect(wordCount("a\n\nb  c")).toBe(3)
  })

  test("reads the terminal assistant message out of an archived transcript", () => {
    const transcript = [
      {
        messages: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
          {
            info: { id: "m2", role: "assistant" },
            parts: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "Added the endpoint." },
            ],
          },
        ],
      },
    ]
    expect(finalAssistantText(transcript, "m2")).toBe("Added the endpoint.")
    // Falls back to the last assistant message when the recorded id is gone.
    expect(finalAssistantText(transcript, "missing")).toBe("Added the endpoint.")
    expect(finalAssistantText([], "m2")).toBeUndefined()
    expect(finalAssistantText("not a transcript")).toBeUndefined()
  })

  test("counts the blocks of prose the contestant addressed to the voter", () => {
    const transcript = [
      {
        messages: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
          {
            info: { id: "m2", role: "assistant" },
            parts: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "Reading the file." },
              { type: "tool", tool: "read" },
              // A second block in the same message: the card draws two, so this counts two.
              { type: "text", text: "Now the edit." },
              { type: "text", text: "   " },
            ],
          },
          { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "Done." }] },
        ],
      },
    ]
    expect(textMessageCount(transcript)).toBe(3)
    expect(textMessageCount([])).toBe(0)
    expect(textMessageCount("not a transcript")).toBe(0)
  })
})

const assignment = {
  assignmentID: "assignment",
  model: "Contestant",
  requestedReasoning: {},
  enforcedReasoning: {},
}

function turnFor(vote: "a" | "b" | "tie"): TurnDocument {
  return {
    _id: "turn",
    chatID: "chat",
    turnIndex: 0,
    userPrompt: "do it",
    frozenBaseSHA: "base",
    sourceCanonicalSessionID: "canonical",
    canonicalTranscriptHash: "hash",
    pair: ["arena-01", "arena-02"],
    placement: { a: assignment, b: assignment },
    runIDs: { a: "run-a", b: "run-b" },
    state: "complete",
    transitionTimestamps: {},
    comparisonState: "complete",
    vote,
    // A tie applies A to git; the metrics row must not read that as a win.
    appliedSide: vote === "tie" ? "a" : vote,
    resolution: { kind: "vote", vote, appliedSide: vote === "tie" ? "a" : vote },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as TurnDocument
}

function runFor(side: "a" | "b"): RunDocument {
  return {
    _id: `run-${side}`,
    turnID: "turn",
    side,
    rootSessionID: `ses-${side}`,
    descendantSessionIDs: [],
    sourceCanonicalSessionID: "canonical",
    forkOperationID: `fork-${side}`,
    moveOperationID: `move-${side}`,
    proxyAssignmentID: `proxy-${side}`,
    assignment,
    worktree: `/tmp/${side}`,
    worktreeCreatedAt: new Date(0),
    durationMs: 1000,
    runState: "complete",
    retries: [],
    permissionOutcomes: [],
    questionOutcomes: [],
    toolCount: 0,
    testCommands: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as RunDocument
}

function battleFor(vote: "a" | "b" | "tie") {
  return computeBattleMetrics({
    chat: { _id: "chat" } as ChatDocument,
    turn: turnFor(vote),
    runs: [runFor("a"), runFor("b")],
    generations: [],
    reviewEvents: [],
    transcripts: {},
    computedAt: new Date(0),
  })
}

describe("ArenaMetrics outcome", () => {
  test("nobody wins a tie, even though A is what gets applied", () => {
    const battle = battleFor("tie")
    expect(battle.sides.a?.won).toBe(false)
    expect(battle.sides.b?.won).toBe(false)
    expect(battle.vote).toBe("tie")
  })

  test("the voted side wins", () => {
    expect([battleFor("a").sides.a?.won, battleFor("a").sides.b?.won]).toEqual([true, false])
    expect([battleFor("b").sides.a?.won, battleFor("b").sides.b?.won]).toEqual([false, true])
  })

  test("counts only the services the contestant started itself", () => {
    const withServices = computeBattleMetrics({
      chat: { _id: "chat" } as ChatDocument,
      turn: turnFor("a"),
      runs: [
        {
          ...runFor("a"),
          services: [
            { kind: "owned_process", command: "npm run dev" },
            { kind: "environment", command: "postgres" },
          ],
        } as RunDocument,
        runFor("b"),
      ],
      generations: [],
      reviewEvents: [],
      transcripts: {},
      computedAt: new Date(0),
    })
    // Two were captured; the environment row is Arena's, not the contestant's.
    expect(withServices.sides.a?.serviceCount).toBe(1)
    expect(withServices.sides.b?.serviceCount).toBe(0)
  })

  test("claims a race only when both sides ran to the end", () => {
    // An early vote stops the loser, and a stopped run still carries a
    // `completedAt`. Two timestamps looked like a finish line, so every early
    // vote recorded a winner of a race that was never run.
    const base = { chat: { _id: "chat" } as ChatDocument, generations: [], reviewEvents: [], transcripts: {}, computedAt: new Date(0) }
    const raced = computeBattleMetrics({
      ...base,
      turn: turnFor("a"),
      runs: [
        { ...runFor("a"), completedAt: new Date(1000) } as RunDocument,
        { ...runFor("b"), completedAt: new Date(2000) } as RunDocument,
      ],
    })
    expect(raced.sides.a?.finishedFirst).toBe(true)
    expect(raced.sides.b?.finishedFirst).toBe(false)

    const stopped = computeBattleMetrics({
      ...base,
      turn: turnFor("a"),
      runs: [
        { ...runFor("a"), completedAt: new Date(1000) } as RunDocument,
        { ...runFor("b"), runState: "stopped", completedAt: new Date(2000) } as RunDocument,
      ],
    })
    expect(stopped.sides.a?.finishedFirst).toBeUndefined()
    expect(stopped.sides.b?.finishedFirst).toBeUndefined()
  })

  test("reads the summary and the block count from the same transcript", () => {
    const battle = computeBattleMetrics({
      chat: { _id: "chat" } as ChatDocument,
      turn: turnFor("a"),
      runs: [runFor("a"), runFor("b")],
      generations: [],
      reviewEvents: [],
      transcripts: {
        a: [
          {
            messages: [
              { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "Reading the file." }] },
              { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "Renamed the handler." }] },
            ],
          },
        ],
      },
      computedAt: new Date(0),
    })
    expect(battle.sides.a?.textMessageCount).toBe(2)
    expect(battle.sides.a?.summaryWordCount).toBe(3)
    // Absent rather than zero: B's transcript was never read, so nothing is known.
    expect(battle.sides.b?.textMessageCount).toBeUndefined()
  })

  test("is one document per battle, with the turn described once", () => {
    const battle = battleFor("a")
    expect(battle._id).toBe("turn")
    expect(Object.keys(battle.sides).sort()).toEqual(["a", "b"])
    // Everything outside `sides` belongs to the turn, so nothing that varies by
    // contestant may sit at the top level.
    expect(battle).not.toHaveProperty("side")
    expect(battle).not.toHaveProperty("model")
    expect(battle).not.toHaveProperty("won")
  })

  test("omits a side that never ran rather than inventing one", () => {
    const battle = computeBattleMetrics({
      chat: { _id: "chat" } as ChatDocument,
      turn: turnFor("a"),
      runs: [runFor("a")],
      generations: [],
      reviewEvents: [],
      transcripts: {},
      computedAt: new Date(0),
    })
    expect(battle.sides.a).toBeDefined()
    expect(battle.sides.b).toBeUndefined()
    // A race nobody finished is not a race won.
    expect(battle.sides.a?.finishedFirst).toBeUndefined()
  })
})
