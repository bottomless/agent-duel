import { describe, expect, test } from "bun:test"
import { MongoServerError } from "mongodb"
import { earlyResolution, stoppedResolution, voteResolution } from "@/arena/domain"
import { Store } from "@/arena/mongo"
import type {
  ArenaEventDocument,
  ChatDocument,
  RawEventDocument,
  SingleAgentRatingDocument,
  TurnDocument,
} from "@/arena/records"

const now = new Date("2026-08-05T12:00:00.000Z")
const assignment = {
  assignmentID: "assignment",
  model: "Contestant",
  requestedReasoning: { effort: "high" },
  enforcedReasoning: { effort: "high" },
}

function chat(): ChatDocument {
  return {
    _id: "chat",
    repository: { projectID: "project", root: "/repo", branch: "dev" },
    arenaBranch: "dev",
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: "canonical",
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "hash",
    turnCount: 0,
    status: "ready",
    opencodeCommit: "commit",
    opencodeVersion: "version",
    arenaVersion: "prototype",
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

function turn(state: TurnDocument["state"] = "creating"): TurnDocument {
  return {
    _id: "turn",
    chatID: "chat",
    turnIndex: 0,
    userPrompt: "prompt",
    frozenBaseSHA: "base",
    sourceCanonicalSessionID: "canonical",
    canonicalTranscriptHash: "hash",
    pair: ["hidden/a", "hidden/b"],
    placement: { a: assignment, b: { ...assignment, assignmentID: "assignment-b" } },
    runIDs: { a: "run-a", b: "run-b" },
    state,
    transitionTimestamps: { [state]: now },
    comparisonState: "pending",
    createdAt: now,
    updatedAt: now,
  }
}

function store(value: object): Store {
  return Object.assign(Object.create(Store.prototype), value)
}

function snapshotCollection<T extends { readonly _id: string }>() {
  let document: T | undefined
  return {
    collection: {
      insertOne: async (value: T) => {
        if (document) throw new MongoServerError({ message: "duplicate", code: 11000 })
        document = structuredClone(value)
        return { acknowledged: true, insertedId: value._id }
      },
      findOne: async () => document,
      findOneAndUpdate: async (_filter: unknown, update: { $set: Partial<T>; $inc: Record<string, number> }) => {
        if (!document) return null
        const next = { ...document, ...structuredClone(update.$set) } as T & Record<string, unknown>
        for (const [key, increment] of Object.entries(update.$inc)) {
          next[key] = (typeof next[key] === "number" ? next[key] : 0) + increment
        }
        document = next
        return structuredClone(document)
      },
    },
    document: () => document,
  }
}

describe("ArenaMongo claims", () => {
  test("publishes successful control writes only to active store observers", async () => {
    let modifiedCount = 0
    const arena = store({ chats: { updateOne: async () => ({ modifiedCount }) } })
    let changes = 0
    const unsubscribe = arena.onChange(() => changes++)
    await arena.updateChat({ _id: "chat" }, { $set: { status: "ready" } })
    expect(changes).toBe(0)
    modifiedCount = 1
    await arena.updateChat({ _id: "chat" }, { $set: { status: "ready" } })
    expect(changes).toBe(1)
    unsubscribe()
    await arena.updateChat({ _id: "chat" }, { $set: { status: "ready" } })
    expect(changes).toBe(1)
  })

  test("records an immutable thumbs vote outside battle turns", async () => {
    let rating: SingleAgentRatingDocument = {
      _id: "single-agent|session",
      sessionID: "session",
      messageID: "message",
      assignment,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const arena = store({
      latestSingleAgentRating: async () => rating,
      singleAgentRatings: {
        findOneAndUpdate: async () => {
          if (rating.vote) return null
          rating = { ...rating, vote: "up", voteAt: now, revealAt: now, updatedAt: now }
          return rating
        },
        findOne: async () => rating,
      },
    })

    const input = { sessionID: "session", ratingID: rating._id, model: "Contestant", at: now } as const
    expect(await arena.recordSingleAgentVote({ ...input, vote: "up" })).toMatchObject({
      vote: "up",
      revealAt: now,
    })
    expect(await arena.recordSingleAgentVote({ ...input, vote: "up" })).toMatchObject({ vote: "up" })
    await expect(arena.recordSingleAgentVote({ ...input, vote: "down" })).rejects.toThrow("already been recorded")
  })

  test("rolls back a vote when a newer single-agent pass wins the race", async () => {
    let rating: SingleAgentRatingDocument = {
      _id: "single-agent|session|first",
      sessionID: "session",
      messageID: "first",
      assignment,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    const newer: SingleAgentRatingDocument = {
      ...rating,
      _id: "single-agent|session|second",
      messageID: "second",
      createdAt: new Date(now.getTime() + 1),
      updatedAt: new Date(now.getTime() + 1),
    }
    let latest = rating
    let rolledBack = false
    const arena = store({
      latestSingleAgentRating: async () => latest,
      singleAgentRatings: {
        findOneAndUpdate: async () => {
          rating = { ...rating, vote: "up", voteAt: now, revealAt: now, updatedAt: now }
          latest = newer
          return rating
        },
        updateOne: async () => {
          rolledBack = true
          rating = { ...rating, vote: undefined, voteAt: undefined, revealAt: undefined }
          return { matchedCount: 1, modifiedCount: 1 }
        },
        findOne: async () => rating,
      },
    })

    await expect(
      arena.recordSingleAgentVote({
        sessionID: "session",
        ratingID: rating._id,
        vote: "up",
        model: "Contestant",
        at: now,
      }),
    ).rejects.toThrow("no longer current")
    expect(rolledBack).toBe(true)
    expect(rating.vote).toBeUndefined()
  })

  test("upserts part snapshots while preserving first observation and duplicate counts", async () => {
    const events = snapshotCollection<ArenaEventDocument>()
    const rawEvents = snapshotCollection<RawEventDocument>()
    const arena = store({ events: events.collection, rawEvents: rawEvents.collection })
    const receivedAt = new Date("2026-08-14T10:00:00.000Z")
    const event = (sequence: number, contentHash: string): ArenaEventDocument => ({
      _id: "event-snapshot",
      turnID: "turn",
      runID: "run",
      sessionID: "session",
      sequence,
      receivedAt: new Date(receivedAt.getTime() + sequence),
      type: "message.part.updated",
      payload: { text: contentHash },
      redactionVersion: "privacy",
      normalizationVersion: "events",
      coalesced: true,
      gap: false,
      snapshotKey: "part",
      contentHash,
    })
    const raw = (receiveSequence: number, contentHash: string): RawEventDocument => ({
      _id: "raw-event-snapshot",
      turnID: "turn",
      runID: "run",
      rootSessionID: "session",
      sessionID: "session",
      receiveSequence,
      receivedAt: new Date(receivedAt.getTime() + receiveSequence),
      type: "message.part.updated",
      classification: "live",
      normalizedEventID: "event-snapshot",
      originalSize: 100,
      storedSize: 0,
      contentHash,
      truncated: true,
      snapshotKey: "part",
    })

    for (const [sequence, hash] of [
      [1, "one"],
      [4, "two"],
      [7, "two"],
    ] as const) {
      await arena.saveEvent(event(sequence, hash))
      await arena.saveRawEvent(raw(sequence, hash))
    }

    expect(events.document()).toMatchObject({
      sequence: 7,
      firstSequence: 1,
      updateCount: 3,
      duplicateCount: 1,
      contentHash: "two",
      payload: { text: "two" },
    })
    expect(rawEvents.document()).toMatchObject({
      receiveSequence: 7,
      firstReceiveSequence: 1,
      updateCount: 3,
      duplicateCount: 1,
      contentHash: "two",
    })
  })

  test("allows only one concurrent caller to activate a deterministic turn ID", async () => {
    let current = chat()
    const candidate = turn()
    const arena = store({
      claimTurn: async () => ({ value: candidate, inserted: false as const }),
      chats: {
        findOneAndUpdate: async () => {
          await Promise.resolve()
          if (current.status !== "ready") return null
          current = {
            ...current,
            status: "battle_active",
            activeTurnID: candidate._id,
            turnCount: current.turnCount + 1,
          }
          return current
        },
        findOne: async () => current,
      },
    })

    const results = await Promise.all([
      arena.activateTurn(current._id, candidate, canonical(current)),
      arena.activateTurn(current._id, candidate, canonical(current)),
    ])

    expect(results.filter((result) => result.activated)).toHaveLength(1)
    expect(results.filter((result) => !result.activated)).toHaveLength(1)
    expect(current.turnCount).toBe(1)
  })

  test("adopts an idle canonical checkout while claiming the battle", async () => {
    let current = chat()
    const candidate = turn()
    const calls: unknown[][] = []
    const arena = store({
      claimTurn: async () => ({ value: candidate, inserted: false as const }),
      chats: {
        findOneAndUpdate: async (...input: unknown[]) => {
          calls.push(input)
          current = {
            ...current,
            status: "battle_active",
            activeTurnID: candidate._id,
            arenaBranch: "feature",
            repository: { ...current.repository, branch: "feature" },
            currentCanonicalSHA: "next",
            canonicalTranscriptHash: "next-hash",
          }
          return current
        },
      },
    })

    await arena.activateTurn(current._id, candidate, {
      ...canonical(current),
      branch: "feature",
      head: "next",
      transcriptHash: "next-hash",
      transcriptChanged: true,
    })

    expect(calls[0]?.[0]).toMatchObject({
      status: "ready",
      arenaBranch: "dev",
      currentCanonicalSHA: "base",
      canonicalSessionID: "canonical",
      canonicalTranscriptHash: "hash",
      canonicalTranscriptVersion: 1,
    })
    expect(calls[0]?.[1]).toMatchObject({
      $set: {
        status: "battle_active",
        arenaBranch: "feature",
        "repository.branch": "feature",
        currentCanonicalSHA: "next",
        canonicalSessionID: "canonical",
        canonicalTranscriptHash: "next-hash",
      },
      $inc: { turnCount: 1, canonicalTranscriptVersion: 1 },
    })

    current = { ...current, status: "ready", activeTurnID: undefined }
    await arena.activateTurn(current._id, candidate, {
      ...canonical(current),
      branch: "dev",
      head: "after-normal",
      transcriptHash: "after-normal-hash",
      transcriptChanged: true,
    })

    expect(calls[1]?.[0]).toMatchObject({
      status: "ready",
      arenaBranch: "feature",
      currentCanonicalSHA: "next",
      canonicalTranscriptHash: "next-hash",
    })
    expect(calls[1]?.[1]).toMatchObject({
      $set: {
        arenaBranch: "dev",
        "repository.branch": "dev",
        currentCanonicalSHA: "after-normal",
        canonicalTranscriptHash: "after-normal-hash",
      },
    })
  })

  test("refuses a stale checkout binding claim", async () => {
    const current = chat()
    const candidate = turn()
    const arena = store({
      claimTurn: async () => ({ value: candidate, inserted: false as const }),
      chats: {
        findOneAndUpdate: async () => null,
        findOne: async () => ({ ...current, canonicalTranscriptVersion: current.canonicalTranscriptVersion + 1 }),
      },
    })

    await expect(arena.activateTurn(current._id, candidate, canonical(current))).rejects.toThrow(
      "Arena chat is not ready for turn turn",
    )
  })

  test("removes the legacy repository-wide active-battle lease", async () => {
    const indexes: unknown[][] = []
    const dropped: string[] = []
    const collection = {
      createIndex: async (...input: unknown[]) => {
        indexes.push(input)
        return "index"
      },
      dropIndex: async (name: string) => {
        dropped.push(name)
        return { ok: 1 }
      },
      updateMany: async () => ({}),
    }
    const arena = store({
      chats: collection,
      turns: collection,
      runs: collection,
      generations: collection,
      events: collection,
      rawEvents: collection,
      sessionArchives: collection,
      artifacts: collection,
      comparisons: collection,
      singleAgentRatings: collection,
      battleMetrics: collection,
      checkoutEvictions: collection,
      reviewEvents: collection,
    })

    await arena.initialize()

    expect(dropped).toEqual(["repository.root_1", "sessionID_1", "turnID_1_side_1", "canonicalSlug_1_computedAt_-1"])
    expect(indexes.some(([key]) => JSON.stringify(key) === JSON.stringify({ "repository.root": 1 }))).toBe(false)
  })

  test("initializes a fresh database without the legacy chats collection", async () => {
    const collection = {
      createIndex: async () => "index",
      dropIndex: async () => {
        throw new MongoServerError({ message: "namespace not found", code: 26 })
      },
      updateMany: async () => ({}),
    }
    const arena = store({
      chats: collection,
      turns: collection,
      runs: collection,
      generations: collection,
      events: collection,
      rawEvents: collection,
      sessionArchives: collection,
      artifacts: collection,
      comparisons: collection,
      singleAgentRatings: collection,
      battleMetrics: collection,
      checkoutEvictions: collection,
      reviewEvents: collection,
    })

    await expect(arena.initialize()).resolves.toBeUndefined()
  })

  test("normalizes legacy resolution selection fields during initialization", async () => {
    const updates: unknown[][] = []
    const collection = {
      createIndex: async () => "index",
      dropIndex: async () => ({ ok: 1 }),
      updateMany: async (...input: unknown[]) => {
        updates.push(input)
        return {}
      },
    }
    const arena = store({
      chats: collection,
      turns: collection,
      runs: collection,
      generations: collection,
      events: collection,
      rawEvents: collection,
      sessionArchives: collection,
      artifacts: collection,
      comparisons: collection,
      singleAgentRatings: collection,
      battleMetrics: collection,
      checkoutEvictions: collection,
      reviewEvents: collection,
    })

    await arena.initialize()

    expect(updates).toHaveLength(6)
    expect(updates).toContainEqual([
      { resolution: { $exists: true } },
      { $unset: { endedEarly: "", benchmarkEligible: "" } },
    ])
    expect(updates).toContainEqual([{ "resolution.kind": "early" }, { $set: { selectedEarly: true } }])
    expect(updates).toContainEqual([{ "resolution.kind": "vote" }, { $set: { selectedEarly: false } }])
    expect(updates).toContainEqual([
      { "resolution.kind": { $in: ["stopped", "aborted"] } },
      { $unset: { selectedEarly: "" } },
    ])
  })

  test("allows only one concurrent vote to claim an unresolved turn", async () => {
    let current = turn("awaiting_vote")
    const arena = store({
      turns: {
        findOneAndUpdate: async () => {
          await Promise.resolve()
          if (current.state !== "awaiting_vote" || current.resolution) return null
          current = {
            ...current,
            state: "applying",
            resolution: voteResolution("a"),
            vote: "a",
            selectedEarly: false,
            appliedSide: "a",
          }
          return current
        },
        findOne: async () => current,
      },
    })

    const results = await Promise.all([
      arena.recordResolution({
        turnID: current._id,
        resolution: voteResolution("a"),
        vote: "a",
        appliedSide: "a",
        expectedState: "awaiting_vote",
        models: { a: "Model A", b: "Model B" },
        at: now,
      }),
      arena.recordResolution({
        turnID: current._id,
        resolution: voteResolution("b"),
        vote: "b",
        appliedSide: "b",
        expectedState: "awaiting_vote",
        models: { a: "Model A", b: "Model B" },
        at: now,
      }),
    ])

    expect(results.filter((result) => result.recorded)).toHaveLength(1)
    expect(results.filter((result) => !result.recorded)).toHaveLength(1)
    expect(current.resolution).toEqual(voteResolution("a"))
    expect(current.state).toBe("applying")
  })

  test("allows only one concurrent caller to claim a failed resolution retry", async () => {
    let current = turn("application_failed")
    const arena = store({
      turns: {
        findOneAndUpdate: async () => {
          await Promise.resolve()
          if (current.state !== "application_failed") return null
          current = { ...current, state: "applying" }
          return current
        },
        findOne: async () => current,
      },
    })

    const results = await Promise.all([
      arena.claimTransition(current._id, "application_failed", "applying"),
      arena.claimTransition(current._id, "application_failed", "applying"),
    ])

    expect(results.filter((result) => result.claimed)).toHaveLength(1)
    expect(results.filter((result) => !result.claimed)).toHaveLength(1)
  })

  test("records normal-vote latency from the awaiting-vote transition", async () => {
    const current = {
      ...turn("awaiting_vote"),
      transitionTimestamps: { awaiting_vote: new Date("2026-08-05T11:59:58.500Z") },
    }
    let fields: Record<string, unknown> = {}
    const arena = store({
      turns: {
        findOne: async () => current,
        findOneAndUpdate: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
          fields = update.$set
          return current
        },
      },
    })

    await arena.recordResolution({
      turnID: current._id,
      resolution: voteResolution("a"),
      vote: "a",
      appliedSide: "a",
      expectedState: "awaiting_vote",
      models: { a: "Model A", b: "Model B" },
      at: now,
    })

    expect(fields.timeToVoteMs).toBe(1_500)
    expect(fields.selectedEarly).toBe(false)
    expect(fields.state).toBe("applying")
    expect(fields["transitionTimestamps.applying"]).toEqual(now)
    expect(fields).not.toHaveProperty("endedEarly")
  })

  test("does not mark stopped or aborted resolutions as early selections", async () => {
    const stopped = turn("awaiting_stop_resolution")
    const aborted = { ...turn("creation_failed"), _id: "aborted" }
    const updates: Record<string, unknown>[] = []
    const arena = store({
      turns: {
        findOne: async (filter: { _id: string }) => (filter._id === stopped._id ? stopped : aborted),
        findOneAndUpdate: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push(update.$set)
          return updates.length === 1 ? stopped : aborted
        },
      },
    })

    await arena.recordResolution({
      turnID: stopped._id,
      resolution: stoppedResolution("discard"),
      expectedState: "awaiting_stop_resolution",
      models: { a: "Model A", b: "Model B" },
      at: now,
    })
    await arena.recordAbort({
      turnID: aborted._id,
      expectedState: "creation_failed",
      reason: "failed",
      models: { a: "Model A", b: "Model B" },
      at: now,
    })

    expect(updates).toHaveLength(2)
    expect(updates.every((fields) => fields.selectedEarly === undefined)).toBe(true)
    expect(updates.every((fields) => fields.endedEarly === undefined)).toBe(true)
    expect(updates.every((fields) => fields.comparisonState === "skipped")).toBe(true)
  })

  test("claims an early selection only while the other side is still unfinalized", async () => {
    let current: TurnDocument = {
      ...turn("running"),
      finalizedSides: ["a" as const],
      selectableSides: ["a" as const],
    }
    let filter: Record<string, unknown> = {}
    const arena = store({
      turns: {
        findOneAndUpdate: async (input: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
          filter = input
          if (current.state !== "running" || current.resolution) return null
          current = { ...current, ...update.$set, state: "early_selected" } as TurnDocument
          return current
        },
        findOne: async () => current,
      },
    })

    const claimed = await arena.claimEarlyResolution({
      turnID: current._id,
      side: "a",
      models: { a: "Model A", b: "Model B" },
      at: now,
    })

    expect(claimed.claimed).toBe(true)
    expect(current.resolution).toEqual(earlyResolution("a"))
    expect(current.selectedEarly).toBe(true)
    expect(current.comparisonState).toBe("skipped")
    expect(filter).toMatchObject({
      state: "running",
      finalizedSides: { $all: ["a"], $nin: ["b"] },
      selectableSides: { $all: ["a"] },
    })
  })

  test("does not replace an already-recorded early selection", async () => {
    const current = {
      ...turn("early_selected"),
      resolution: earlyResolution("a"),
      vote: "a" as const,
      appliedSide: "a" as const,
      selectedEarly: true,
    }
    const arena = store({
      turns: {
        findOneAndUpdate: async () => null,
        findOne: async () => current,
      },
    })

    const claimed = await arena.claimEarlyResolution({
      turnID: current._id,
      side: "b",
      models: { a: "Model A", b: "Model B" },
      at: now,
    })

    expect(claimed.claimed).toBe(false)
    expect(claimed.turn.resolution).toEqual(earlyResolution("a"))
  })

  test("serializes per-run artifact accounting and insertion", async () => {
    const budgetReadStarted = Promise.withResolvers<void>()
    const releaseBudgetRead = Promise.withResolvers<void>()
    const documents = new Map<string, { _id: string; storedSize: number }>()
    let reads = 0
    let activeReads = 0
    let maximumActiveReads = 0
    let storedSize = 0
    const arena = store({
      artifactQueues: new Map<string, Promise<void>>(),
      artifacts: {
        findOne: async (filter: { _id: string }) => documents.get(filter._id),
        find: (_filter: unknown, options: unknown) => ({
          toArray: async () => {
            expect(options).toEqual({ projection: { storedSize: 1 } })
            reads += 1
            activeReads += 1
            maximumActiveReads = Math.max(maximumActiveReads, activeReads)
            if (reads === 1) {
              budgetReadStarted.resolve()
              await releaseBudgetRead.promise
            }
            activeReads -= 1
            return [{ storedSize }]
          },
        }),
        insertOne: async (document: { _id: string; storedSize: number }) => {
          documents.set(document._id, document)
          storedSize += document.storedSize
          return { acknowledged: true, insertedId: document._id }
        },
      },
    })
    const artifact = (id: string) => ({
      _id: id,
      runID: "run",
      turnID: "turn",
      kind: "other" as const,
      mimeType: "application/octet-stream",
      encoding: "binary" as const,
      compression: "none" as const,
      data: new Uint8Array([1, 2, 3]),
      createdAt: now,
    })

    const writes = Promise.all([arena.storeArtifact(artifact("a")), arena.storeArtifact(artifact("b"))])
    await budgetReadStarted.promise
    expect(reads).toBe(1)
    releaseBudgetRead.resolve()
    await writes

    expect(maximumActiveReads).toBe(1)
    expect(reads).toBe(2)
    expect(storedSize).toBe(6)
  })

  test("aggregates retry and provider evidence without replacing prior run history", async () => {
    const updates: Array<Record<string, unknown>> = []
    const arena = store({
      runs: {
        findOneAndUpdate: async (_filter: unknown, update: Record<string, unknown>) => {
          updates.push(update)
          return { _id: "run" }
        },
      },
    })
    const retry = {
      requestID: "00000000-0000-4000-8000-000000000001",
      generationID: "generation-2",
      retryParentID: "generation-1",
      attemptIndex: 1,
      observedAt: now,
    }

    await arena.recordGenerationRetry("run", retry)
    await arena.addResolvedProvider("run", "Groq")

    expect(updates[0]).toMatchObject({ $addToSet: { retries: retry } })
    expect(updates[1]).toMatchObject({ $addToSet: { resolvedProviders: "Groq" } })
  })
})

function canonical(value: ChatDocument) {
  return {
    previous: {
      branch: value.arenaBranch,
      head: value.currentCanonicalSHA,
      sessionID: value.canonicalSessionID,
      transcriptHash: value.canonicalTranscriptHash,
      transcriptVersion: value.canonicalTranscriptVersion,
    },
    branch: value.arenaBranch,
    head: value.currentCanonicalSHA,
    sessionID: value.canonicalSessionID,
    transcriptHash: value.canonicalTranscriptHash,
    transcriptChanged: false,
  }
}

describe("ArenaMongo chat worktrees", () => {
  test("collects every worktree the chat has used, deduplicated", async () => {
    let runFilter: unknown
    const arena = store({
      turns: { find: () => ({ toArray: async () => [{ _id: "turn_0" }, { _id: "turn_1" }] }) },
      runs: {
        find: (filter: unknown) => {
          runFilter = filter
          return {
            toArray: async () => [
              { _id: "run-0-a", worktree: "/w/turn-0-a" },
              { _id: "run-0-b", worktree: "/w/turn-0-b" },
              { _id: "run-1-a", worktree: "/w/turn-1-a" },
              { _id: "run-0-a-retry", worktree: "/w/turn-0-a" },
            ],
          }
        },
      },
    })

    expect(await arena.worktreesForChat("chat")).toEqual(["/w/turn-0-a", "/w/turn-0-b", "/w/turn-1-a"])
    expect((await arena.runsForChat("chat")).map((run) => run._id)).toEqual([
      "run-0-a",
      "run-0-b",
      "run-1-a",
      "run-0-a-retry",
    ])
    expect(runFilter).toEqual({ turnID: { $in: ["turn_0", "turn_1"] } })
  })

  test("returns nothing when the chat has no turns", async () => {
    const arena = store({
      turns: { find: () => ({ toArray: async () => [] }) },
      runs: {
        find: () => {
          throw new Error("runs should not be queried without turns")
        },
      },
    })

    expect(await arena.worktreesForChat("chat")).toEqual([])
    expect(await arena.runsForChat("chat")).toEqual([])
  })
})
