import { afterEach, describe, expect, test } from "bun:test"
import { OperationError, TRUNK_CONFLICT_OPERATION } from "@/arena/git"
import { clearForTest, hostname, register } from "@/arena/preview"
import type { RunDocument, TurnDocument } from "@/arena/records"
import {
  contestantSystemInstruction,
  isGitLockContention,
  normalTurnReservations,
  portHistory,
  retiredPortMap,
  retiredPorts,
  trunkConflictList,
  trunkConflictPaths,
  trunkConflictReason,
  unappliedWinnerNote,
} from "@/arena/service"

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

  test("lists earlier turns' ports against the contestant's own and keeps old URLs out of use", () => {
    register("/worktrees/turn-2-b", {
      hostname: hostname("chat-a", 2, "b"),
      port: 20_113,
      portAliases: { PASEO_PORT: 20_113, PASEO_PORT2: 20_114, PASEO_PORT3: 20_115 },
    })
    const history = [
      {
        turnIndex: 0,
        runID: "run-1",
        portAliases: { PASEO_PORT: 20_000, PASEO_PORT2: 20_001, PASEO_PORT3: 20_002 },
        previewUrls: { PASEO_PORT: "http://turn1-a--6b6e7f77.localhost:6771" },
        retired: true,
      },
      {
        turnIndex: 1,
        runID: "run-2",
        portAliases: { PASEO_PORT: 20_009, PASEO_PORT2: 20_010, PASEO_PORT3: 20_011 },
        previewUrls: {},
        retired: false,
      },
    ]
    const instruction = contestantSystemInstruction(
      "/worktrees/turn-2-b",
      false,
      { PASEO_LISTEN: "127.0.0.1:6771" },
      history,
    )

    expect(instruction).toContain(
      "Turn 1: PASEO_PORT 20000 -> your PASEO_PORT 20113; PASEO_PORT2 20001 -> your PASEO_PORT2 20114; PASEO_PORT3 20002 -> your PASEO_PORT3 20115 (preview http://turn1-a--6b6e7f77.localhost:6771)",
    )
    expect(instruction).toContain("Turn 2: PASEO_PORT 20009 -> your PASEO_PORT 20113;")
    expect(instruction).toContain("reaches your own current port with the same alias")
    expect(instruction).toContain("never to an earlier-turn port")
    // A contestant that replayed `--port <old>` saw EADDRINUSE and spent turns working out why.
    expect(instruction).toContain('a bind to one fails with "address already in use"')
    expect(instruction).not.toContain("Literal ports, preview URLs")
  })

  test("leaves the port section out when the history is the contestant's own", () => {
    register("/worktrees/turn-1-a", {
      hostname: hostname("chat-a", 0, "a"),
      port: 20_000,
      portAliases: { PASEO_PORT: 20_000, PASEO_PORT2: 20_001, PASEO_PORT3: 20_002 },
    })
    const instruction = contestantSystemInstruction("/worktrees/turn-1-a", false, {}, [
      {
        turnIndex: 0,
        runID: "run-1",
        portAliases: { PASEO_PORT: 20_000, PASEO_PORT2: 20_001, PASEO_PORT3: 20_002 },
        previewUrls: {},
        retired: false,
      },
    ])
    expect(instruction).not.toContain("Ports from earlier turns")
  })

  test("lists no preview URLs for a worktree without a live route", () => {
    const instruction = contestantSystemInstruction("/worktrees/turn-0-b", false, {
      PASEO_LISTEN: "127.0.0.1:6771",
    })

    expect(instruction).not.toContain("Current public preview URLs")
    expect(instruction).not.toContain("http://")
  })
})

describe("port history", () => {
  const turn = (turnIndex: number, appliedSide?: "a" | "b") =>
    ({
      _id: `turn-${turnIndex}`,
      turnIndex,
      appliedSide,
      runIDs: { a: `run-${turnIndex}-a`, b: `run-${turnIndex}-b` },
    }) as unknown as TurnDocument
  const run = (id: string, first: number, released: boolean, url?: string) =>
    ({
      _id: id,
      portAliases: { PASEO_PORT: first, PASEO_PORT2: first + 1, PASEO_PORT3: first + 2 },
      ...(released ? { worktreeRemovedAt: new Date() } : {}),
      services: url
        ? [
            {
              kind: "environment",
              proxyRoutes: [{ hostname: new URL(url).hostname, url, alias: "PASEO_PORT", active: false }],
            },
          ]
        : [],
    }) as unknown as RunDocument

  test("takes each applied winner's bank, oldest first, and forwards only released ones", () => {
    const history = portHistory(
      [turn(2), turn(1, "b"), turn(0, "a")],
      [
        run("run-0-a", 20_000, true, "http://turn1-a--chat.localhost:6767"),
        run("run-0-b", 20_003, true),
        run("run-1-a", 20_006, true),
        run("run-1-b", 20_009, false),
        run("run-2-a", 20_012, false),
      ],
    )

    expect(history.map((entry) => [entry.turnIndex, entry.runID, entry.retired])).toEqual([
      [0, "run-0-a", true],
      [1, "run-1-b", false],
    ])
    expect(retiredPorts(history)).toEqual([
      { port: 20_000, alias: "PASEO_PORT", turnIndex: 0 },
      { port: 20_001, alias: "PASEO_PORT2", turnIndex: 0 },
      { port: 20_002, alias: "PASEO_PORT3", turnIndex: 0 },
    ])
    expect(
      retiredPortMap(
        history,
        { PASEO_PORT: 20_012, PASEO_PORT2: 20_013, PASEO_PORT3: 20_014 },
        "turn3-a--chat.localhost",
      ),
    ).toEqual({
      ports: { 20_000: 20_012, 20_001: 20_013, 20_002: 20_014, 20_009: 20_012, 20_010: 20_013, 20_011: 20_014 },
      hosts: { "turn1-a--chat.localhost": "turn3-a--chat.localhost" },
    })
  })
})
