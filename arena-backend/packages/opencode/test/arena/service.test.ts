import { afterEach, describe, expect, test } from "bun:test"
import { OperationError, TRUNK_CONFLICT_OPERATION } from "@/arena/git"
import { clearForTest, hostname, register } from "@/arena/preview"
import {
  contestantSystemInstruction,
  isGitLockContention,
  normalTurnReservations,
  runEnvironment,
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

describe("runEnvironment", () => {
  test("reads the winner's port bank and each alias's preview URL from its record", () => {
    const at = new Date()
    const route = (alias: "PASEO_PORT" | "PASEO_PORT2" | "PASEO_PORT3", port: number, url?: string) => ({
      hostname: "h.localhost",
      port,
      alias,
      active: true,
      ...(url ? { url } : {}),
    })
    expect(
      runEnvironment({
        portAliases: { PASEO_PORT: 21400, PASEO_PORT2: 21401, PASEO_PORT3: 21402 },
        services: [
          {
            kind: "environment",
            command: "Arena preview environment",
            args: [],
            env: {},
            relativeCwd: ".",
            listeners: [],
            proxyRoutes: [
              route("PASEO_PORT", 21400, "http://turn1-a--abc.localhost:6768"),
              route("PASEO_PORT2", 21401, "http://port2--turn1-a--abc.localhost:6768"),
              route("PASEO_PORT3", 21402),
            ],
            capturedAt: at,
            verifiedAt: at,
          },
        ],
      }),
    ).toEqual({
      portAliases: { PASEO_PORT: 21400, PASEO_PORT2: 21401, PASEO_PORT3: 21402 },
      previewUrls: {
        PASEO_PORT: "http://turn1-a--abc.localhost:6768",
        PASEO_PORT2: "http://port2--turn1-a--abc.localhost:6768",
      },
    })
  })

  test("has nothing to replace for a run without a bank", () => {
    expect(runEnvironment({})).toEqual({ previewUrls: {} })
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

  test("says what the port variables in earlier messages mean and that literal ports are closed", () => {
    const instruction = contestantSystemInstruction()

    expect(instruction).toContain(
      "Where earlier messages say $PASEO_PORT, $PASEO_PORT2, $PASEO_PORT3, $ARENA_PREVIEW_URL, $ARENA_PREVIEW_URL2, or $ARENA_PREVIEW_URL3, they mean this environment's current values.",
    )
    expect(instruction).toContain(
      "Literal ports, preview URLs, log paths, and process IDs in earlier commands or tool output belong to earlier environments that are now closed",
    )
  })

  test("lists no preview URLs for a worktree without a live route", () => {
    const instruction = contestantSystemInstruction("/worktrees/turn-0-b", false, {
      PASEO_LISTEN: "127.0.0.1:6771",
    })

    expect(instruction).not.toContain("Current public preview URLs")
    expect(instruction).not.toContain("http://")
  })
})
