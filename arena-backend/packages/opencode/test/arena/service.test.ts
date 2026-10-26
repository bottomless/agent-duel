import { Model as ModelV2 } from "@opencode/schema/model"
import { Provider as ProviderV2 } from "@opencode/schema/provider"
import * as SessionV1Schema from "@opencode/schema/v1/session"
import { SessionV1 } from "@/arena/session-shape"
import { afterEach, describe, expect, test } from "bun:test"
import { OperationError, TRUNK_CONFLICT_OPERATION } from "@/arena/git"
import { clearForTest, hostname, register } from "@/arena/preview"
import {
  contestantSystemInstruction,
  isGitLockContention,
  lastTurnStart,
  normalTurnReservations,
  trunkConflictList,
  trunkConflictPaths,
  trunkConflictReason,
  unappliedWinnerNote,
} from "@/arena/service"
import { MessageID, PartID, SessionID } from "@/session/schema"

test("keeps Battle blocked until every admitted normal prompt settles", () => {
  const reservations = normalTurnReservations()
  reservations.reserve("canonical")
  reservations.reserve("canonical")

  expect(reservations.active("canonical")).toBe(true)
  reservations.release("canonical")
  expect(reservations.active("canonical")).toBe(true)
  reservations.release("canonical")
  expect(reservations.active("canonical")).toBe(false)
})

test("caps the conflict list in the refusal without hiding how many there are", () => {
  expect(trunkConflictList([])).toBe("")
  expect(trunkConflictList(["a"])).toBe("a")
  expect(trunkConflictList(["a", "b", "c", "d", "e"])).toBe("a, b, c, d, e")
  expect(trunkConflictList(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d, e, and 1 more")

  const many = Array.from({ length: 300 }, (_, index) => `src/file-${index}.ts`)
  const listed = trunkConflictList(many)
  expect(listed).toBe("src/file-0.ts, src/file-1.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts, and 295 more")
  expect(trunkConflictReason(many)).toBe(
    `Unresolved merge conflicts: ${listed}. Resolve them, or turn Battle off and ask one agent to resolve them.`,
  )
  expect(trunkConflictReason(many).length).toBeLessThan(300)
})

test("treats only the trunk-conflict refusal as a reason to keep the chat ready", () => {
  const conflicted = new OperationError(TRUNK_CONFLICT_OPERATION, "Unresolved merge conflicts: f", ["f", "g"])
  expect(trunkConflictPaths(conflicted)).toEqual(["f", "g"])

  // Every other snapshotBase failure still blocks the chat.
  expect(trunkConflictPaths(new OperationError("read_canonical_index", "fatal: not a git repository"))).toBeUndefined()
  expect(trunkConflictPaths(new Error("Unresolved merge conflicts: f"))).toBeUndefined()
  expect(trunkConflictPaths(undefined)).toBeUndefined()

  // An OperationError of the right step with no paths still refuses rather than blocks.
  expect(trunkConflictPaths(new OperationError(TRUNK_CONFLICT_OPERATION, "Unresolved merge conflicts"))).toEqual([])
})

describe("isGitLockContention", () => {
  test("reads git's lock message as busy rather than missing", () => {
    const detail =
      "ArenaGitOperationError: fatal: Unable to create '/repo/.git/index.lock': File exists.\n\n" +
      "Another git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'."
    expect(isGitLockContention(detail)).toBe(true)
  })

  test("still blocks on a checkout that is genuinely gone", () => {
    expect(isGitLockContention("Canonical checkout root changed outside Arena")).toBe(false)
    expect(isGitLockContention("fatal: not a git repository")).toBe(false)
    expect(isGitLockContention("")).toBe(false)
  })
})

describe("unappliedWinnerNote", () => {
  test("tells a single-agent turn that the winner it read about is not in the workspace yet", () => {
    const note = unappliedWinnerNote({ gitApplication: { state: "review", resultCommit: "abc123" } })
    expect(note).toContain("has not been applied to this workspace yet")
    expect(note).toContain("waits for the user to answer")
    expect(note).toContain("do not redo the winner's changes unless the user asks")
  })

  test("says nothing once the winner is applied or while it is still applying", () => {
    expect(unappliedWinnerNote({ gitApplication: { state: "applied" } })).toBeUndefined()
    expect(unappliedWinnerNote({ gitApplication: { state: "conflicted" } })).toBeUndefined()
    expect(unappliedWinnerNote({})).toBeUndefined()
  })
})

describe("contestantSystemInstruction", () => {
  afterEach(clearForTest)

  test("hands over the expanded preview URL but asks for it only from a listening service", () => {
    register("/worktrees/turn-0-a", {
      hostname: hostname("chat-a", 0, "a"),
      port: 43121,
      portAliases: { PASEO_PORT: 43121, PASEO_PORT2: 43122, PASEO_PORT3: 43123 },
    })
    const instruction = contestantSystemInstruction("/worktrees/turn-0-a", false, {
      PASEO_LISTEN: "127.0.0.1:6771",
    })

    expect(instruction).toContain("ARENA_PREVIEW_URL=http://turn1-a--6b6e7f77.localhost:6771")
    expect(instruction).toContain(
      "If you started a service and verified it is listening, give its expanded http(s) URL in your final response",
    )
    expect(instruction).toContain("Otherwise do not write about preview URLs at all, not even to say there is none.")
    expect(instruction).not.toContain("In your final response, report the expanded")
  })

  test("lists no preview URLs for a worktree without a live route", () => {
    const instruction = contestantSystemInstruction("/worktrees/turn-0-b", false, {
      PASEO_LISTEN: "127.0.0.1:6771",
    })

    expect(instruction).not.toContain("Current public preview URLs")
    expect(instruction).not.toContain("http://")
  })
})

describe("lastTurnStart", () => {
  const sessionID = SessionID.make("ses_canonical")
  const model = { providerID: ProviderV2.ID.make("arena"), modelID: ModelV2.ID.make("contestant") }
  const prompt = (created: number, synthetic = false): SessionV1.WithParts => {
    const id = MessageID.ascending()
    return {
      info: { id, sessionID, role: "user", time: { created }, agent: "build", model },
      parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: "go", synthetic }],
    }
  }
  const reply = (
    time: { created: number; completed?: number },
    finish: string | undefined,
    aborted = false,
  ): SessionV1.WithParts => ({
    info: {
      id: MessageID.ascending(),
      sessionID,
      parentID: MessageID.ascending(),
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...model,
      time,
      ...(finish ? { finish } : {}),
      ...(aborted
        ? {
            error: SessionV1Schema.AbortedError.Schema.make({
              name: "MessageAbortedError",
              data: { message: "Aborted" },
            }),
          }
        : {}),
    },
    parts: [],
  })
  // The last battle's grafted prompt and reply, both written before the graft is recorded.
  const grafted = [prompt(1), reply({ created: 2, completed: 3 }, "stop")]
  const battle = { canonicalGraftedAt: new Date(10), canonicalUserMessageID: grafted[0]!.info.id }

  test("starts a battle turn at its grafted prompt", () => {
    expect(lastTurnStart([battle], grafted)).toBe(grafted[0]!.info.id)
  })

  test("starts a single-agent turn at a prompt sent after its last reply finished", () => {
    const first = prompt(20)
    const queued = prompt(40)
    expect(
      lastTurnStart(
        [battle],
        [...grafted, first, reply({ created: 21, completed: 30 }, "stop"), queued, reply({ created: 41 }, undefined)],
      ),
    ).toBe(queued.info.id)
    const afterAbort = prompt(40)
    expect(
      lastTurnStart(
        [battle],
        [...grafted, first, reply({ created: 21, completed: 30 }, "tool-calls", true), afterAbort],
      ),
    ).toBe(afterAbort.info.id)
  })

  test("keeps a steer in the turn it steered", () => {
    const start = prompt(20)
    // Between steps: the reply stopped to call tools.
    const betweenSteps = [...grafted, start, reply({ created: 21, completed: 30 }, "tool-calls"), prompt(31)]
    expect(lastTurnStart([battle], betweenSteps)).toBe(start.info.id)
    // While the last reply was still being written.
    const whileWriting = [...grafted, start, reply({ created: 21, completed: 30 }, "stop"), prompt(25)]
    expect(lastTurnStart([battle], whileWriting)).toBe(start.info.id)
    // While a cut-off reply was being recovered.
    const recovering = [...grafted, start, reply({ created: 21, completed: 30 }, "length"), prompt(31)]
    expect(lastTurnStart([battle], recovering)).toBe(start.info.id)
    // Steering the grafted battle leaves its prompt as the start.
    const steeredGraft = [prompt(1), reply({ created: 2, completed: 3 }, "tool-calls"), prompt(20)]
    expect(lastTurnStart([{ ...battle, canonicalUserMessageID: steeredGraft[0]!.info.id }], steeredGraft)).toBe(
      steeredGraft[0]!.info.id,
    )
  })

  test("ignores messages the engine wrote for the user", () => {
    const start = prompt(20)
    const transcript = [...grafted, start, reply({ created: 21, completed: 30 }, "stop"), prompt(40, true)]
    expect(lastTurnStart([battle], transcript)).toBe(start.info.id)
  })

  test("finds no start in a chat without a finished turn", () => {
    expect(lastTurnStart([], [])).toBeUndefined()
  })
})
