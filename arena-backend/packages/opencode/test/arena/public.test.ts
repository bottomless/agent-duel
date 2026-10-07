import { describe, expect, test } from "bun:test"
import { jsonValue, project } from "../../src/arena/public"
import type { BattleSnapshot } from "../../src/arena/records"

function snapshot(revealed: boolean): BattleSnapshot {
  const now = new Date("2026-08-05T12:00:00.000Z")
  const assignment = {
    assignmentID: "private-assignment",
    model: "GLM 5.2",
    requestedReasoning: { effort: "high" },
    enforcedReasoning: { effort: "high" },
  }
  return {
    chat: {
      _id: "chat",
      repository: { projectID: "project", root: "/repo", branch: "main" },
      arenaBranch: "main",
      initialCanonicalSHA: "base",
      currentCanonicalSHA: "base",
      canonicalSessionID: "canonical",
      canonicalTranscriptVersion: 1,
      canonicalTranscriptHash: "hash",
      turnCount: 1,
      activeTurnID: "turn",
      status: "battle_active",
      opencodeCommit: "commit",
      opencodeVersion: "version",
      arenaVersion: "v1",
      configuration: {
        modelPool: "private",
        agent: "private",
        plugins: "private",
        mcp: "private",
        skills: "private",
        tools: "private",
        system: "private",
      },
      utilityPromptVersion: "utility-v1",
      createdAt: now,
      updatedAt: now,
    },
    turn: {
      _id: "turn",
      chatID: "chat",
      participantID: "cid_private-participant",
      turnIndex: 1,
      userPrompt: "prompt",
      frozenBaseSHA: "base",
      sourceCanonicalSessionID: "canonical",
      canonicalTranscriptHash: "hash",
      pair: ["private-assignment", "private-assignment-b"],
      placement: {
        a: assignment,
        b: {
          ...assignment,
          assignmentID: "private-assignment-b",
          model: "Qwen 3.8 Max",
        },
      },
      runIDs: { a: "run-a", b: "run-b" },
      state: revealed ? "applying" : "awaiting_vote",
      transitionTimestamps: {},
      comparisonState: "complete",
      ...(revealed
        ? {
            resolution: {
              kind: "vote" as const,
              vote: "a" as const,
              appliedSide: "a" as const,
            },
            selectedEarly: false,
            canonicalUserMessageID: "message-a",
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    },
    runs: [
      {
        _id: "run-a",
        turnID: "turn",
        side: "a",
        rootSessionID: "session-a",
        descendantSessionIDs: [],
        sourceCanonicalSessionID: "canonical",
        forkOperationID: "fork-a",
        moveOperationID: "move-a",
        proxyAssignmentID: "private-assignment",
        assignment: {
          assignmentID: assignment.assignmentID,
          requestedReasoning: assignment.requestedReasoning,
          enforcedReasoning: assignment.enforcedReasoning,
        },
        worktree: "/worktree-a",
        worktreeCreatedAt: now,
        runState: "complete",
        durationMs: null,
        retries: [],
        permissionOutcomes: [],
        questionOutcomes: [],
        toolCount: 0,
        testCommands: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    events: [],
  }
}

function now(): Date {
  return new Date("2026-08-05T12:00:00.000Z")
}

function containsUndefined(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUndefined)
  if (typeof value !== "object" || value === null) return value === undefined
  return Object.values(value).some(containsUndefined)
}

describe("ArenaPublic", () => {
  test("projects active transition operations only for current active turns", () => {
    const input = snapshot(true)
    input.turn!.activeOperations = ["preparing_workspaces", "applying_changes"]
    input.turn!.operationProgress = [
      { operation: "preparing_workspaces", startedAt: 10, state: "running" },
      { operation: "applying_changes", startedAt: 20, finishedAt: 30, state: "completed" },
    ]
    const activeStates = [
      "creating",
      "worktrees_ready",
      "running",
      "early_selected",
      "applying",
      "canonicalizing",
      "cleanup_pending",
    ] as const
    for (const state of activeStates) {
      input.turn!.state = state
      expect(project(input).turn?.activeOperations).toEqual(["preparing_workspaces", "applying_changes"])
      expect(project(input).turn?.operationProgress).toEqual(input.turn!.operationProgress)
    }

    for (const state of ["awaiting_vote", "complete", "creation_failed", "application_failed"] as const) {
      input.turn!.state = state
      expect(project(input).turn?.activeOperations).toBeUndefined()
      expect(project(input).turn?.operationProgress).toEqual([
        { operation: "applying_changes", startedAt: 20, finishedAt: 30, state: "completed" },
      ])
    }

    input.turn!.state = "complete"
    expect(project({ ...input, history: [input.turn!] }).history[0]?.activeOperations).toBeUndefined()
  })

  test.each([false, true])("hides billing details in payment errors, revealed=%s", (revealed) => {
    const input = snapshot(revealed)
    input.runs[0]!.runState = "error"
    input.runs[0]!.error = `Contestant assistant error: ${JSON.stringify({
      name: "APIError",
      data: {
        statusCode: 402,
        responseBody: JSON.stringify({ error: { code: "arena_credit_limit", model: "private-model" } }),
      },
    })}`
    const output = project(input)
    expect(output.runs[0]?.error).toBe("The agent could not complete this run.")
    expect(output.runs[0]?.error).not.toMatch(/credit|spending|payment|budget/i)
    expect(JSON.stringify(output)).not.toContain("private-model")
  })
  test("keeps the battle end boundary stable after background updates", () => {
    const input = snapshot(true)
    const endedAt = new Date("2026-08-05T12:05:00.000Z")
    const turn = {
      ...input.turn!,
      state: "complete" as const,
      transitionTimestamps: { complete: endedAt },
      updatedAt: new Date("2026-08-05T12:10:00.000Z"),
    }
    const value = project({ ...input, turn, history: [turn] })
    expect(value.history[0]?.endedAt).toBe(endedAt.toISOString())
    expect(value.turn?.endedAt).toBe(endedAt.toISOString())
    const discarded = { ...turn, state: "discarded" as const, transitionTimestamps: { discarded: endedAt } }
    expect(project({ ...input, turn: discarded, history: [discarded] }).history[0]?.endedAt).toBe(endedAt.toISOString())
    expect(project(snapshot(false)).turn?.endedAt).toBeUndefined()
  })

  test("reveals a single-agent identity only after its separate thumbs vote", () => {
    const input = snapshot(false)
    input.singleAgentRating = {
      _id: "single-agent|canonical",
      sessionID: "canonical",
      messageID: "message",
      assignment: input.turn!.placement.a,
      createdAt: input.chat.createdAt,
      updatedAt: input.chat.updatedAt,
    }

    expect(project(input).singleAgent).toBeUndefined()

    input.singleAgentRating.completedAt = input.chat.updatedAt
    const hidden = project(input)
    expect(hidden.singleAgent).toEqual({
      id: "single-agent|canonical",
      revealed: false,
    })
    expect(JSON.stringify(hidden.singleAgent)).not.toContain("GLM 5.2")

    input.singleAgentRating.vote = "up"
    input.singleAgentRating.voteAt = input.chat.updatedAt
    input.singleAgentRating.revealAt = input.chat.updatedAt
    const revealed = project(input)
    expect(revealed.singleAgent).toEqual({
      id: "single-agent|canonical",
      revealed: true,
      vote: "up",
      identity: { name: "GLM 5.2" },
    })
  })

  test("does not expose identity, usage, cost, or private configuration before a decision", () => {
    const value = project(snapshot(false))
    const json = JSON.stringify(value)
    expect(value.runs[0]?.identity).toBeUndefined()
    expect(json).not.toContain("anthropic/")
    expect(json).not.toContain("private-assignment")
    expect(json).not.toContain("cid_private-participant")
    expect(json).not.toContain("modelPool")
    expect(value.runs[0]?.selectable).toBe(false)
    expect(value.turn?.selectedEarly).toBeUndefined()
  })

  test("exposes only a boolean selectability signal before a decision", () => {
    const input = snapshot(false)
    input.runs[0]!.selectable = true
    input.runs[0]!.diff = { files: 1, additions: 1, deletions: 0 }
    input.runs[0]!.durationMs = 125
    const value = project(input)
    expect(value.runs[0]?.selectable).toBe(true)
    expect(value.runs[0]?.durationMs).toBe(125)
    expect(JSON.stringify(value)).not.toContain("private-assignment")
  })

  test("keeps a finalized empty result selectable", () => {
    const input = snapshot(false)
    input.runs[0]!.selectable = true
    input.runs[0]!.diff = { files: 0, additions: 0, deletions: 0 }

    expect(project(input).runs[0]?.selectable).toBe(true)
  })

  test("projects a missing trunk as a durable blocked state", () => {
    const input = snapshot(false)
    input.chat.status = "blocked"
    input.chat.blockedReason = "The trunk worktree is unavailable."

    expect(project(input).chat).toMatchObject({
      status: "blocked",
      blockedReason: "The trunk worktree is unavailable.",
    })
  })

  test("projects workspace lifecycle metadata without copy identities and preserves inactive routes", () => {
    const input = snapshot(true)
    const omissions = [
      {
        relativePath: "cache.bin",
        fileType: "file" as const,
        logicalBytes: 42,
        sourceIdentity: "/repo/cache.bin:identity",
        omissionReason: "ignored_file_too_large" as const,
      },
    ]
    input.runs[0]!.worktreeName = "generation-1-a"
    input.runs[0]!.branchAtRun = "main"
    input.runs[0]!.retention = "retained_until_next_send"
    input.chat.retainedWinner = {
      runID: "run-a",
      worktree: "/worktree-a",
      resultRef: "refs/battles/chat/1/selected",
      state: "live",
    }
    input.turn!.warmPreparation = {
      generation: 2,
      state: "ready",
      worktrees: {
        a: {
          side: "a",
          name: "generation-2-a",
          directory: "/worktree-2-a",
          branch: "main",
          sourceCommit: "base",
          copyManifestID: "manifest",
          ready: true,
        },
        b: {
          side: "b",
          name: "generation-2-b",
          directory: "/worktree-2-b",
          branch: "main",
          sourceCommit: "base",
          copyManifestID: "manifest",
          ready: true,
        },
      },
    }
    input.runs[0]!.copyOmissions = omissions
    input.runs[0]!.services = [
      {
        kind: "environment",
        command: "Arena preview environment",
        args: [],
        env: { PASEO_PORT: "43121" },
        relativeCwd: ".",
        listeners: [{ port: 43121, alias: "PASEO_PORT", verifiedAt: now() }],
        proxyRoutes: [{ hostname: "reserved.localhost", active: true }],
        capturedAt: now(),
        verifiedAt: now(),
      },
      {
        kind: "owned_process",
        command: "npm run dev",
        args: [],
        env: {},
        relativeCwd: ".",
        listeners: [{ port: 43121, alias: "PASEO_PORT", verifiedAt: now() }],
        proxyRoutes: [
          { hostname: "active.localhost", url: "http://active.localhost", active: true },
          { hostname: "inactive.localhost", active: false },
        ],
        capturedAt: now(),
        verifiedAt: now(),
      },
    ]
    input.turn!.transitionEvent = {
      id: "transition-1",
      previousWinningRunID: "run-old",
      stoppedCommands: [
        {
          command: "npm run dev",
          relativeCwd: ".",
          status: "stopped",
          verified: true,
          listeners: [{ alias: "PASEO_PORT" }, { alias: "PASEO_PORT2" }, { alias: "PASEO_PORT3" }],
        },
      ],
      copyOmissions: omissions,
      summary: {
        commandsStopped: 1,
        commandsAlreadyAbsent: 0,
        stopFailures: 0,
        listenersReleased: 3,
        pathsOmitted: 1,
      },
      createdAt: now(),
    }

    const value = project(input)
    expect(value.environment).toEqual({
      retainedWinner: {
        runID: "run-a",
        side: "a",
        worktreeName: "generation-1-a",
        branch: "main",
        state: "live",
      },
      warmPair: {
        generation: 2,
        state: "ready",
        sides: [
          { side: "a", worktreeName: "generation-2-a", branch: "main", ready: true },
          { side: "b", worktreeName: "generation-2-b", branch: "main", ready: true },
        ],
      },
    })
    expect(value.runs[0]?.copyOmissions).toEqual([
      { relativePath: "cache.bin", omissionReason: "ignored_file_too_large" },
    ])
    expect(value.runs[0]?.services?.[0]?.proxyRoutes).toEqual([
      { hostname: "active.localhost", url: "http://active.localhost", active: true },
      { hostname: "inactive.localhost", active: false },
    ])
    expect(value.runs[0]?.services).toHaveLength(1)
    expect(value.runs[0]?.services?.[0]?.kind).toBe("owned_process")
    expect(value.turn?.transition?.copyOmissions).toEqual([
      { relativePath: "cache.bin", omissionReason: "ignored_file_too_large" },
    ])
    expect(value.turn?.transition?.stoppedCommands[0]?.listeners).toEqual([
      { alias: "PASEO_PORT" },
      { alias: "PASEO_PORT2" },
      { alias: "PASEO_PORT3" },
    ])
    expect(value.turn?.transition?.summary.listenersReleased).toBe(3)
    expect(JSON.stringify(value)).not.toContain("sourceIdentity")
    expect(JSON.stringify(value)).toContain("inactive.localhost")
  })

  test("normalizes Mongo's null stopped-resolution side", () => {
    const input = snapshot(true)
    input.turn!.state = "discarded"
    input.turn!.resolution = {
      kind: "stopped",
      resolution: "discard",
      appliedSide: null,
    } as unknown as NonNullable<BattleSnapshot["turn"]>["resolution"]

    expect(project(input).turn?.resolution).toEqual({ kind: "stopped", resolution: "discard" })
  })

  test("reveals only the human identity after a decision", () => {
    const input = snapshot(true)
    const value = project({ ...input, history: input.turn ? [input.turn] : [] })
    const json = JSON.stringify(value)
    expect(input.runs[0]?.assignment.model).toBeUndefined()
    expect(value.runs[0]?.identity).toEqual({ name: "GLM 5.2" })
    expect(value.turn?.identities).toEqual({ a: { name: "GLM 5.2" }, b: { name: "Qwen 3.8 Max" } })
    expect(value.history[0]?.identities).toEqual({
      a: { name: "GLM 5.2" },
      b: { name: "Qwen 3.8 Max" },
    })
    expect(value.turn?.canonicalUserMessageID).toBe("message-a")
    expect(value.turn?.selectedEarly).toBe(false)
    expect(value.history[0]?.canonicalUserMessageID).toBe("message-a")
    expect(value.history[0]?.selectedEarly).toBe(false)
    expect(json).not.toContain("anthropic/")
    expect(json).not.toContain("private-assignment")
  })

  test("keeps an unfinished early-selected run duration null", () => {
    const input = snapshot(true)
    const early = {
      ...input,
      turn: {
        ...input.turn!,
        resolution: { kind: "early" as const, vote: "a" as const, appliedSide: "a" as const },
        selectedEarly: true,
      },
      runs: [
        ...input.runs,
        {
          ...input.runs[0]!,
          _id: "run-b",
          side: "b" as const,
          runState: "stopped" as const,
          completedAt: undefined,
          durationMs: null,
        },
      ],
    } satisfies BattleSnapshot

    const value = project(early)

    expect(value.turn?.selectedEarly).toBe(true)
    expect(value.runs.find((run) => run.side === "b")?.durationMs).toBeNull()
  })

  test("omits early-selection state for stopped and aborted turns", () => {
    const input = snapshot(false)
    const results = [
      project({
        ...input,
        turn: {
          ...input.turn!,
          state: "awaiting_stop_resolution",
          resolution: { kind: "stopped", resolution: "discard" },
        },
      } satisfies BattleSnapshot),
      project({
        ...input,
        turn: {
          ...input.turn!,
          state: "discarded",
          resolution: { kind: "aborted", reason: "Arena startup failed" },
        },
      } satisfies BattleSnapshot),
    ]

    results.forEach((value) => {
      expect(value.turn).not.toHaveProperty("selectedEarly")
      expect(value.turn).not.toHaveProperty("endedEarly")
    })
  })

  test("offers a retry and a discard for a result that stopped before writing", () => {
    const input = snapshot(true)
    input.turn!.state = "application_failed"
    input.turn!.appliedSide = "a"
    input.turn!.gitApplication = { state: "manual", reason: "The trunk switched branches" }
    input.runs[0]!.finalCommit = "result"
    expect(project(input).turn?.canRetryResolution).toBe(true)
    expect(project(input).turn?.canDiscardWinner).toBe(true)

    // Without a finalized result there is nothing to retry, and discarding is the way out.
    input.turn!.gitApplication = { state: "blocked", reason: "setup failed" }
    input.runs[0]!.finalCommit = undefined
    expect(project(input).turn?.canRetryResolution).toBe(false)
    expect(project(input).turn?.canDiscardWinner).toBe(true)

    // Markers already in the checkout are the winner's; discarding it is no longer offered.
    input.turn!.gitApplication = { state: "conflicted", conflicts: ["a.txt"] }
    expect(project(input).turn?.canDiscardWinner).toBe(false)
  })

  test("offers the retry that finishes a promotion parked on conflicts", () => {
    // The vote already asked for the winner; the markers only interrupted it. This flag is what
    // the parked callout hangs on, so a conflicted promotion that could not be retried would
    // leave the user looking at files with no way to finish.
    const input = snapshot(true)
    input.turn!.state = "application_failed"
    input.turn!.appliedSide = "a"
    input.turn!.gitApplication = { state: "conflicted", conflicts: ["src/app.ts"] }
    input.runs[0]!.finalCommit = "result"

    expect(project(input).turn?.canRetryResolution).toBe(true)
  })

  test("produces a JSON-encodable projection without explicit undefined fields", () => {
    const input = snapshot(false)
    delete input.chat.activeTurnID
    input.chat.status = "ready"
    const value = project(input)
    expect(containsUndefined(value)).toBe(false)
    expect(() => JSON.stringify(value)).not.toThrow()
    expect(JSON.parse(JSON.stringify(value))).toMatchObject({
      chat: { status: "ready" },
      turn: { id: "turn" },
    })
  })

  test("normalizes malformed nested values without discarding healthy siblings", () => {
    const cycle: Record<string, unknown> = { retained: "cycle-value" }
    cycle.self = cycle
    const array: unknown[] = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 42n, () => undefined, Symbol("x")]
    array.push(array)
    const throwing = { retained: "getter-value" }
    Object.defineProperty(throwing, "broken", {
      enumerable: true,
      get() {
        throw new Error("broken getter")
      },
    })

    const value = jsonValue({
      nested: {
        retained: true,
        missing: undefined,
        nonFinite: Number.NEGATIVE_INFINITY,
        bigint: 9_007_199_254_740_993n,
        callback: () => undefined,
        marker: Symbol("marker"),
      },
      array,
      cycle,
      throwing,
      date: new Date("2026-08-05T12:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
    })

    expect(value).toEqual({
      nested: {
        retained: true,
        nonFinite: null,
        bigint: "9007199254740993",
      },
      array: [null, null, null, "42", null, null, null],
      cycle: { retained: "cycle-value" },
      throwing: { retained: "getter-value" },
      date: "2026-08-05T12:00:00.000Z",
      invalidDate: null,
    })
    expect(containsUndefined(value)).toBe(false)
    expect(() => JSON.stringify(value)).not.toThrow()
  })
})
