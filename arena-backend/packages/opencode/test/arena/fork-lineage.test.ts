import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { inheritTurns } from "@/arena/fork-lineage"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { BattleHistoryTurn, ChatDocument, RunDocument, TurnDocument } from "@/arena/records"
import { project } from "@/arena/public"

const now = new Date("2026-09-30T00:00:00Z")
const assignment = { assignmentID: "assignment", model: "Contestant", requestedReasoning: {}, enforcedReasoning: {} }
function chat(id: string): ChatDocument {
  return {
    _id: id,
    repository: { projectID: "project", root: `/repo/${id}`, branch: "main" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: `session-${id}`,
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "ready",
    agentDuelCommit: "commit",
    agentDuelBuildNumber: 0,
    opencodeVersion: "version",
    agentDuelVersion: "0.4.0-beta.3",
    configuration: {
      modelPool: "hash",
      agent: "hash",
      plugins: "hash",
      mcp: "hash",
      skills: "hash",
      tools: "hash",
      system: "hash",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
}
function turn(chatID: string, index = 0): TurnDocument {
  const id = `${chatID}-${index}`
  return {
    _id: id,
    chatID,
    turnIndex: index,
    userPrompt: "prompt",
    frozenBaseSHA: "base",
    sourceCanonicalSessionID: `session-${chatID}`,
    canonicalTranscriptHash: "hash",
    pair: ["hidden/a", "hidden/b"],
    placement: { a: assignment, b: { ...assignment, assignmentID: "assignment-b" } },
    runIDs: { a: `${id}-a`, b: `${id}-b` },
    state: "running",
    transitionTimestamps: { running: now },
    comparisonState: "pending",
    createdAt: now,
    updatedAt: now,
  }
}
function run(turnID: string): RunDocument {
  return {
    _id: `${turnID}-a`,
    turnID,
    side: "a",
    rootSessionID: `${turnID}-session`,
    descendantSessionIDs: [],
    sourceCanonicalSessionID: "source",
    forkOperationID: `fork-${turnID}`,
    moveOperationID: `move-${turnID}`,
    proxyAssignmentID: `assignment-${turnID}`,
    assignment,
    worktree: `/repo/${turnID}/a`,
    worktreeCreatedAt: now,
    durationMs: null,
    runState: "pending",
    retries: [],
    permissionOutcomes: [],
    questionOutcomes: [],
    toolCount: 0,
    testCommands: [],
    createdAt: now,
    updatedAt: now,
  }
}
async function fixture(callback: (store: Store, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-fork-lineage-"))
  const store = await connectLocalStore({ directory })
  try {
    await callback(store, directory)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void ({} as RunDocument)

function kept(id: string, first: string, last: string): BattleHistoryTurn {
  return {
    ...turn("source"),
    _id: id,
    state: "complete",
    appliedSide: "b",
    vote: "b",
    resolution: { kind: "vote", vote: "b", appliedSide: "b" },
    canonicalUserMessageID: first,
    canonicalLastMessageID: last,
  }
}

function discarded(id: string, createdAt: Date): BattleHistoryTurn {
  return {
    ...turn("source"),
    _id: id,
    state: "discarded",
    resolution: { kind: "stopped", resolution: "discard" },
    createdAt,
  } as BattleHistoryTurn
}

describe("inheritTurns", () => {
  const lineage = {
    messages: { msg_01: "msg_a1", msg_02: "msg_a2", msg_03: "msg_a3", msg_04: "msg_a4" },
    throughTime: now.getTime() + 10_000,
  }

  test("moves a copied battle onto the fork's message IDs", () => {
    const [inherited] = inheritTurns([kept("t1", "msg_01", "msg_02")], lineage)
    expect(inherited?.canonicalUserMessageID).toBe("msg_a1")
    expect(inherited?.canonicalLastMessageID).toBe("msg_a2")
    expect(inherited?._id).toBe("t1")
  })

  test("leaves out a battle whose prompt the fork did not copy", () => {
    expect(inheritTurns([kept("t9", "msg_09", "msg_10")], lineage)).toEqual([])
  })

  test("ends a battle the fork cut short at the end of the copy", () => {
    const [inherited] = inheritTurns([kept("t2", "msg_03", "msg_07")], lineage)
    expect(inherited?.canonicalLastMessageID).toBe("msg_a4")
  })

  test("keeps a battle with no answer only when it came before the last copied message", () => {
    const before = discarded("t3", new Date(now.getTime() + 5_000))
    const after = discarded("t4", new Date(now.getTime() + 20_000))
    expect(inheritTurns([before, after], lineage).map((turn) => turn._id)).toEqual(["t3"])
  })

  test("leaves out a battle that was still running", () => {
    expect(inheritTurns([{ ...turn("source"), createdAt: now }], lineage)).toEqual([])
  })
})

describe("a forked chat's history", () => {
  test("names the battles it copied, through a fork of a fork", async () =>
    fixture(async (store) => {
      await store.createChat(chat("source"))
      await store.createTurn({ ...turn("source"), ...kept("source-0", "msg_01", "msg_02") } as TurnDocument)
      const second = turn("source", 1)
      await store.createTurn({ ...second, ...kept(second._id, "msg_05", "msg_06"), turnIndex: 1 } as TurnDocument)

      // The fork copied the first battle only.
      await store.recordForkLineage({
        _id: "session-fork",
        sourceSessionID: "session-source",
        messages: { msg_01: "msg_f1", msg_02: "msg_f2", msg_03: "msg_f3" },
        throughTime: now.getTime(),
        createdAt: now,
      })
      await store.createChat({ ...chat("fork"), canonicalSessionID: "session-fork" })
      const fork = project(await store.snapshot("fork"))
      expect(fork.history.map((item) => [item.id, item.canonicalUserMessageID, item.identities?.b])).toEqual([
        ["source-0", "msg_f1", expect.anything()],
      ])

      // A fork of the fork reaches the same battle through both copies.
      await store.recordForkLineage({
        _id: "session-fork2",
        sourceSessionID: "session-fork",
        messages: { msg_f1: "msg_g1", msg_f2: "msg_g2" },
        throughTime: now.getTime(),
        createdAt: now,
      })
      await store.createChat({ ...chat("fork2"), canonicalSessionID: "session-fork2" })
      const fork2 = project(await store.snapshot("fork2"))
      expect(fork2.history.map((item) => [item.id, item.canonicalUserMessageID, item.canonicalLastMessageID])).toEqual([
        ["source-0", "msg_g1", "msg_g2"],
      ])

      // The source chat itself is unchanged.
      expect(project(await store.snapshot("source")).history.map((item) => item.id)).toEqual(["source-0", "source-1"])
    }))
})
