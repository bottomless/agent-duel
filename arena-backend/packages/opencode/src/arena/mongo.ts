import { MongoClient, MongoServerError, type Db } from "mongodb"
import {
  isDuplicateKeyError,
  type ArenaClient,
  type ArenaCollection,
  type ArenaDb,
  type ArenaFilter,
  type ArenaRecord,
  type ArenaUpdate,
} from "@agent-duel/arena-service/collection"
import { MongoDb, type Configuration } from "@agent-duel/arena-service/mongo"
import {
  abortedResolution,
  earlyResolution,
  requireTransition,
  type BattleState,
  type Resolution,
  type Side,
  type Vote,
} from "./domain"
import { ArenaActivity } from "./activity"
import { bound, boundPrepared } from "./artifact"
import type {
  ArenaEventDocument,
  ArtifactDocument,
  BattleSnapshot,
  BattleHistoryTurn,
  ChatDocument,
  CheckoutEvictionDocument,
  ComparisonDocument,
  GenerationDocument,
  GenerationRetry,
  RawEventDocument,
  BattleMetricsDocument,
  ReviewEventDocument,
  RunDocument,
  SessionArchiveDocument,
  SingleAgentRatingDocument,
  SingleAgentVote,
  TurnDocument,
  ApplyBaseChoice,
} from "./records"

export type ArtifactInput = Omit<
  ArtifactDocument,
  "data" | "originalSize" | "storedSize" | "contentHash" | "truncated" | "truncationReason"
> & {
  readonly data: Uint8Array
}

export type PreparedArtifactInput = Omit<ArtifactDocument, "data" | "storedSize" | "truncated" | "truncationReason"> & {
  readonly data: Uint8Array
}

async function insertIdempotent<T extends ArenaRecord>(collection: ArenaCollection<T>, value: T) {
  return (await insertClaimed(collection, value)).value
}

async function insertClaimed<T extends ArenaRecord>(collection: ArenaCollection<T>, value: T) {
  try {
    await collection.insertOne(value)
    return { value, inserted: true as const }
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error
    const existing = await collection.findOne({ _id: value._id } as ArenaFilter<T>)
    if (!existing) throw error
    return { value: existing, inserted: false as const }
  }
}

const historyProjection = {
  _id: 1,
  turnIndex: 1,
  state: 1,
  resolution: 1,
  vote: 1,
  selectedEarly: 1,
  appliedSide: 1,
  canonicalUserMessageID: 1,
  gitApplication: 1,
  transitionEvent: 1,
  transitionTimestamps: 1,
  placement: 1,
  createdAt: 1,
  updatedAt: 1,
} satisfies Record<keyof BattleHistoryTurn, 1>

type ObservedHistory = {
  subscribers: number
  version?: string
  rows?: readonly BattleHistoryTurn[]
  pending?: Promise<readonly BattleHistoryTurn[]>
}

export class Store {
  private mutationListeners?: Set<{ listener: () => void; chatID?: string }>
  private observedHistories?: Map<string, ObservedHistory>
  onChange(listener: () => void, chatID?: string) {
    const listeners = (this.mutationListeners ??= new Set())
    const observer = { listener, chatID }
    listeners.add(observer)
    if (chatID) {
      const histories = (this.observedHistories ??= new Map())
      const history = histories.get(chatID) ?? { subscribers: 0 }
      history.subscribers++
      histories.set(chatID, history)
    }
    return () => {
      if (!listeners.delete(observer) || !chatID) return
      const history = this.observedHistories?.get(chatID)
      if (history && --history.subscribers === 0) this.observedHistories?.delete(chatID)
    }
  }
  changed(scope?: { chatID?: string; turnID?: string }) {
    if (!this.mutationListeners?.size) return
    const version = scope?.turnID ? this.db?.cacheVersion?.("turns") : undefined
    const chatID =
      scope?.chatID ??
      (version === undefined
        ? undefined
        : [...(this.observedHistories ?? [])].find(
            ([, history]) => history.version === version && history.rows?.some((turn) => turn._id === scope?.turnID),
          )?.[0])
    // Unknown ownership (including a not-yet-read new turn) still wakes every observer.
    for (const observer of this.mutationListeners ?? []) {
      if (!chatID || !observer.chatID || observer.chatID === chatID) observer.listener()
    }
  }

  private async history(chatID: string): Promise<readonly BattleHistoryTurn[]> {
    const observed = this.observedHistories?.get(chatID)
    const version = observed ? this.db?.cacheVersion?.("turns") : undefined
    if (observed && version !== undefined && observed.version === version) {
      if (observed.rows) return observed.rows
      if (observed.pending) return observed.pending
    }
    const pending = this.turns.find({ chatID }, { projection: historyProjection }).sort({ turnIndex: 1 }).toArray()
    if (!observed || version === undefined) return pending
    observed.version = version
    observed.rows = undefined
    observed.pending = pending
    try {
      const rows = await pending
      if (
        this.observedHistories?.get(chatID) === observed &&
        observed.pending === pending &&
        this.db?.cacheVersion?.("turns") === version
      )
        observed.rows = rows
      return rows
    } finally {
      if (observed.pending === pending) observed.pending = undefined
    }
  }

  async updateChat(filter: ArenaFilter<ChatDocument>, update: ArenaUpdate<ChatDocument>) {
    const result = await this.chats.updateOne(filter, update)
    if (result.modifiedCount) this.changed({ chatID: typeof filter._id === "string" ? filter._id : undefined })
    return result
  }
  async updateChatReturning(filter: ArenaFilter<ChatDocument>, update: ArenaUpdate<ChatDocument>) {
    const updated = await this.chats.findOneAndUpdate(filter, update, { returnDocument: "after" })
    if (updated) this.changed({ chatID: updated._id })
    return updated
  }
  async writeRun(filter: ArenaFilter<RunDocument>, update: ArenaUpdate<RunDocument>) {
    const result = await this.runs.updateOne(filter, update)
    if (result.modifiedCount) this.changed({ turnID: typeof filter.turnID === "string" ? filter.turnID : undefined })
    return result
  }

  readonly client: ArenaClient
  readonly db: ArenaDb
  readonly chats: ArenaCollection<ChatDocument>
  readonly checkoutEvictions: ArenaCollection<CheckoutEvictionDocument>
  readonly turns: ArenaCollection<TurnDocument>
  readonly runs: ArenaCollection<RunDocument>
  readonly generations: ArenaCollection<GenerationDocument>
  readonly events: ArenaCollection<ArenaEventDocument>
  readonly rawEvents: ArenaCollection<RawEventDocument>
  readonly sessionArchives: ArenaCollection<SessionArchiveDocument>
  readonly artifacts: ArenaCollection<ArtifactDocument>
  readonly comparisons: ArenaCollection<ComparisonDocument>
  readonly reviewEvents: ArenaCollection<ReviewEventDocument>
  readonly battleMetrics: ArenaCollection<BattleMetricsDocument>
  readonly singleAgentRatings: ArenaCollection<SingleAgentRatingDocument>
  readonly artifactQueues = new Map<string, Promise<void>>()

  constructor(client: ArenaClient, db: ArenaDb | Db) {
    this.client = client
    this.db = "databaseName" in db ? new MongoDb(db as Db) : db
    this.chats = this.db.collection<ChatDocument>("chats")
    this.checkoutEvictions = this.db.collection<CheckoutEvictionDocument>("checkoutEvictions")
    this.turns = this.db.collection<TurnDocument>("turns")
    this.runs = this.db.collection<RunDocument>("runs")
    this.generations = this.db.collection<GenerationDocument>("generations")
    this.events = this.db.collection<ArenaEventDocument>("events")
    this.rawEvents = this.db.collection<RawEventDocument>("rawEvents")
    this.sessionArchives = this.db.collection<SessionArchiveDocument>("sessionArchives")
    this.artifacts = this.db.collection<ArtifactDocument>("artifacts")
    this.comparisons = this.db.collection<ComparisonDocument>("comparisons")
    this.reviewEvents = this.db.collection<ReviewEventDocument>("reviewEvents")
    this.battleMetrics = this.db.collection<BattleMetricsDocument>("battleMetrics")
    this.singleAgentRatings = this.db.collection<SingleAgentRatingDocument>("singleAgentRatings")
  }

  async initialize() {
    const ignoreMissingIndex = (error: unknown) => {
      if (error instanceof MongoServerError && (error.code === 26 || error.code === 27)) return
      throw error
    }
    await Promise.all([
      this.chats.dropIndex("repository.root_1").catch(ignoreMissingIndex),
      this.singleAgentRatings.dropIndex("sessionID_1").catch(ignoreMissingIndex),
      // Superseded when a battle became one document instead of one per side.
      this.battleMetrics.dropIndex("turnID_1_side_1").catch(ignoreMissingIndex),
      this.battleMetrics.dropIndex("canonicalSlug_1_computedAt_-1").catch(ignoreMissingIndex),
    ])
    // `terminal` was renamed to `runState`: the old name read as the PTY terminal a
    // battle can open. The field is required, so a run left under the old key fails
    // to project and the battle it belongs to cannot be opened.
    await Promise.all([
      this.runs.updateMany({ terminal: { $exists: true } }, { $rename: { terminal: "runState" } }),
      // `$rename` cannot reach into an array, so the nested copy needs a pipeline.
      this.sessionArchives.updateMany({ "sessions.terminal": { $exists: true } }, [
        {
          $set: {
            sessions: {
              $map: { input: "$sessions", in: { $mergeObjects: ["$$this", { runState: "$$this.terminal" }] } },
            },
          },
        },
        { $unset: "sessions.terminal" },
      ]),
    ])
    await Promise.all([
      this.chats.createIndex({ status: 1, updatedAt: -1 }),
      this.checkoutEvictions.createIndex({ root: 1 }, { unique: true }),
      this.chats.createIndex({ canonicalSessionID: 1 }),
      // Ownership. Every other battle collection reaches its owner through the
      // chat, so these two are the only indexes a per-user listing needs.
      this.chats.createIndex(
        { userId: 1, updatedAt: -1 },
        { partialFilterExpression: { userId: { $type: "string" } } },
      ),
      this.turns.createIndex({ chatID: 1, turnIndex: 1 }, { unique: true }),
      this.turns.createIndex({ chatID: 1, state: 1, updatedAt: -1 }),
      this.runs.createIndex({ turnID: 1, side: 1 }, { unique: true }),
      this.runs.createIndex({ forkOperationID: 1 }, { unique: true }),
      this.runs.createIndex({ moveOperationID: 1 }, { unique: true }),
      this.runs.createIndex({ rootSessionID: 1 }),
      this.runs.createIndex({ descendantSessionIDs: 1 }),
      this.runs.createIndex({ permanentRef: 1 }, { sparse: true }),
      this.generations.createIndex({ runID: 1, callIndex: 1 }, { unique: true }),
      this.generations.createIndex({ runID: 1, requestID: 1, callIndex: 1 }),
      this.generations.createIndex(
        { runID: 1, providerGenerationID: 1 },
        { unique: true, partialFilterExpression: { providerGenerationID: { $type: "string" } } },
      ),
      this.events.createIndex({ turnID: 1, sequence: 1 }, { unique: true }),
      this.events.createIndex(
        { sessionID: 1, durableSequence: 1 },
        {
          unique: true,
          partialFilterExpression: { sessionID: { $type: "string" }, durableSequence: { $type: "number" } },
        },
      ),
      this.rawEvents.createIndex({ runID: 1, receiveSequence: 1 }, { unique: true }),
      this.rawEvents.createIndex(
        { runID: 1, durableID: 1 },
        { partialFilterExpression: { durableID: { $type: "string" } } },
      ),
      this.sessionArchives.createIndex({ runID: 1 }, { unique: true }),
      this.artifacts.createIndex({ runID: 1, createdAt: 1 }, { sparse: true }),
      this.comparisons.createIndex({ turnID: 1 }, { unique: true }),
      // The rollup reads one turn's review in the order the voter produced it.
      this.reviewEvents.createIndex({ turnID: 1, offsetMs: 1 }),
      this.reviewEvents.createIndex({ userId: 1, receivedAt: -1 }, { sparse: true }),
      this.battleMetrics.createIndex({ chatID: 1, turnIndex: 1 }),
      this.battleMetrics.createIndex({ userId: 1, computedAt: -1 }, { sparse: true }),
      this.battleMetrics.createIndex({ computedAt: -1 }),
      this.singleAgentRatings.createIndex({ sessionID: 1, messageID: 1 }, { unique: true }),
      this.singleAgentRatings.createIndex({ sessionID: 1, createdAt: -1 }),
      this.singleAgentRatings.createIndex(
        { userId: 1, createdAt: -1 },
        { partialFilterExpression: { userId: { $type: "string" } } },
      ),
    ])
    await Promise.all([
      this.turns.updateMany({ resolution: { $exists: true } }, { $unset: { endedEarly: "", benchmarkEligible: "" } }),
      this.turns.updateMany({ "resolution.kind": "early" }, { $set: { selectedEarly: true } }),
      this.turns.updateMany({ "resolution.kind": "vote" }, { $set: { selectedEarly: false } }),
      this.turns.updateMany({ "resolution.kind": { $in: ["stopped", "aborted"] } }, { $unset: { selectedEarly: "" } }),
    ])
  }

  async close() {
    this.mutationListeners?.clear()
    this.observedHistories?.clear()
    await this.client.close()
  }

  async createChat(chat: ChatDocument) {
    if (await this.checkoutEvictions.findOne({ root: chat.canonicalCheckout?.root ?? chat.repository.root })) {
      throw new Error("Arena checkout is currently being evicted")
    }
    const result = await insertIdempotent(this.chats, chat)
    this.changed({ chatID: chat._id })
    return result
  }

  async claimCheckoutEviction(root: string) {
    return insertClaimed(this.checkoutEvictions, {
      _id: `checkout|${root}`,
      root,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  async checkoutEviction(root: string) {
    return this.checkoutEvictions.findOne({ root })
  }

  async releaseCheckoutEviction(root: string) {
    await this.checkoutEvictions.deleteOne({ root })
    this.changed()
  }

  async chat(chatID: string) {
    return this.chats.findOne({ _id: chatID })
  }

  async chatForSession(sessionID: string) {
    const direct = await this.chats.findOne({ canonicalSessionID: sessionID })
    if (direct) return direct

    const source = await this.turns.findOne({ sourceCanonicalSessionID: sessionID })
    if (source) return this.chats.findOne({ _id: source.chatID })

    const run = await this.runs.findOne({
      $or: [{ rootSessionID: sessionID }, { descendantSessionIDs: sessionID }],
    })
    if (!run) return undefined
    const turn = await this.turns.findOne({ _id: run.turnID })
    if (!turn) return undefined
    return this.chats.findOne({ _id: turn.chatID })
  }

  async activity(sessionIDs: readonly string[]): Promise<ArenaActivity.Record[]> {
    if (sessionIDs.length === 0) return []
    const chatProjection = { _id: 1, canonicalSessionID: 1, activeTurnID: 1, status: 1, repository: 1 }
    const direct = await this.chats
      .find({ canonicalSessionID: { $in: [...sessionIDs] } }, { projection: chatProjection })
      .toArray()
    const bySession = new Map(direct.map((chat) => [chat.canonicalSessionID, chat]))
    const missing = sessionIDs.filter((id) => !bySession.has(id))
    // A winner can replace the canonical session. Resolve old native handles in one
    // batch, preserving the same ownership lookup as chatForSession.
    const sources = await this.turns
      .find({ sourceCanonicalSessionID: { $in: missing } }, { projection: { chatID: 1, sourceCanonicalSessionID: 1 } })
      .sort({ updatedAt: -1 })
      .toArray()
    const chatForSource = new Map<string, string>()
    for (const turn of sources) {
      if (!chatForSource.has(turn.sourceCanonicalSessionID))
        chatForSource.set(turn.sourceCanonicalSessionID, turn.chatID)
    }
    const runSessions = missing.filter((id) => !chatForSource.has(id))
    const owners = await this.runs
      .find(
        { $or: [{ rootSessionID: { $in: runSessions } }, { descendantSessionIDs: { $in: runSessions } }] },
        { projection: { turnID: 1, rootSessionID: 1, descendantSessionIDs: 1 } },
      )
      .toArray()
    const ownerTurns = await this.turns
      .find({ _id: { $in: owners.map((run) => run.turnID) } }, { projection: { _id: 1, chatID: 1 } })
      .toArray()
    const ownerChats = new Map(ownerTurns.map((turn) => [turn._id, turn.chatID]))
    for (const run of owners) {
      const chatID = ownerChats.get(run.turnID)
      if (!chatID) continue
      for (const id of [run.rootSessionID, ...run.descendantSessionIDs]) {
        if (runSessions.includes(id)) chatForSource.set(id, chatID)
      }
    }
    const indirect = await this.chats
      .find({ _id: { $in: [...chatForSource.values()] } }, { projection: chatProjection })
      .toArray()
    const chats = new Map([...direct, ...indirect].map((chat) => [chat._id, chat]))
    for (const [sessionID, chatID] of chatForSource) {
      const chat = chats.get(chatID)
      if (chat) bySession.set(sessionID, chat)
    }
    const activeTurnIDs = [...chats.values()].flatMap((chat) => (chat.activeTurnID ? [chat.activeTurnID] : []))
    const idleChatIDs = [...chats.values()].filter((chat) => !chat.activeTurnID).map((chat) => chat._id)
    const candidateTurns = (
      await Promise.all([
        this.turns.find({ _id: { $in: activeTurnIDs } }).toArray(),
        ...idleChatIDs.map((chatID) => this.turns.find({ chatID }).sort({ turnIndex: -1 }).limit(1).toArray()),
      ])
    ).flat()
    const turns = [...candidateTurns]
      .sort((a, b) => a.chatID.localeCompare(b.chatID) || b.turnIndex - a.turnIndex)
      .filter((turn, index, all) => index === 0 || turn.chatID !== all[index - 1]!.chatID)
    const byChat = new Map(turns.map((turn) => [turn.chatID, turn]))
    const runs = await this.runs
      .find(
        { turnID: { $in: turns.map((turn) => turn._id) } },
        {
          projection: {
            _id: 1,
            turnID: 1,
            side: 1,
            rootSessionID: 1,
            descendantSessionIDs: 1,
            worktree: 1,
            runState: 1,
            startedAt: 1,
            completedAt: 1,
            diff: 1,
          },
        },
      )
      .sort({ side: 1 })
      .toArray()
    const comparisons = await this.comparisons
      .find({
        _id: { $in: turns.flatMap((turn) => (turn.comparisonID ? [turn.comparisonID] : [])) },
        state: "complete",
      })
      .toArray()
      .then((items) =>
        items.map((item) => ({ _id: item._id, turnID: item.turnID, output: item.output?.slice(0, 4096) ?? "" })),
      )
    const byComparison = new Map(comparisons.map((comparison) => [comparison._id, comparison]))
    const spans = await this.contributionSpans([...chats.values()])
    return sessionIDs.flatMap((sessionID) => {
      const chat = bySession.get(sessionID)
      if (!chat || chat.status === "archived") return []
      const turn = byChat.get(chat._id) ?? null
      const comparison = turn?.comparisonID ? byComparison.get(turn.comparisonID) : undefined
      const summary =
        turn?.comparisonState === "complete" && comparison?.turnID === turn._id ? comparison.output : undefined
      const contribution = spans.get(chat._id)
      return [
        {
          sessionID,
          chat,
          turn,
          summary,
          ...(contribution ? { contribution } : {}),
          runs: runs.filter((run) => run.turnID === turn?._id),
        },
      ]
    })
  }

  /**
   * Where each chat's own work starts and ends, as two tree ids.
   *
   * A workspace's diff stat is read off its checkout, and several chats can share one checkout,
   * so every one of them reports the same number. These two anchors are what a chat changed on
   * its own: the tree its first battle froze, and the newest result from either an applied battle
   * or a later normal turn. Both are already written -- the span is a lookup, and the diff between
   * them is one git call the service memoizes per chat.
   *
   * A chat with no applied turn has no span, and the checkout's number stands in. That covers a
   * chat that has only ever run with Battle off: those turns fold straight into the canonical
   * spine without a turn record, so there is nothing here to anchor to.
   */
  private async contributionSpans(
    chats: readonly Pick<ChatDocument, "_id" | "canonicalSessionID">[],
  ) {
    const spans = new Map<string, { base: string; result: string }>()
    if (chats.length === 0) return spans
    const chatIDs = chats.map((chat) => chat._id)
    const [firsts, applied, normalResults] = await Promise.all([
      this.turns
        .find(
          { chatID: { $in: chatIDs }, turnIndex: 0 },
          { projection: { chatID: 1, frozenBaseSHA: 1, baseSnapshot: 1 } },
        )
        .toArray(),
      Promise.all(
        chatIDs.map((chatID) =>
          this.turns
            .find(
              { chatID, "gitApplication.state": "applied" },
              { projection: { chatID: 1, turnIndex: 1, appliedSide: 1, runIDs: 1 } },
            )
            .sort({ turnIndex: -1 })
            .limit(1)
            .toArray(),
        ),
      ).then((turns) => turns.flat()),
      this.singleAgentRatings
        .find(
          {
            sessionID: { $in: chats.map((chat) => chat.canonicalSessionID) },
            completedAt: { $exists: true },
            precedingTurnCount: { $exists: true },
            resultTree: { $exists: true },
          },
          { projection: { sessionID: 1, precedingTurnCount: 1, resultTree: 1 } },
        )
        .sort({ sessionID: 1, createdAt: -1, _id: -1 })
        .toArray(),
    ])
    const latestApplied = new Map<string, (typeof applied)[number]>()
    for (const turn of applied) if (!latestApplied.has(turn.chatID)) latestApplied.set(turn.chatID, turn)
    const winnerIDs = [...latestApplied.values()].flatMap((turn) =>
      turn.appliedSide ? [turn.runIDs[turn.appliedSide]] : [],
    )
    if (winnerIDs.length === 0) return spans
    const winners = await this.runs
      .find({ _id: { $in: winnerIDs } }, { projection: { _id: 1, finalTree: 1 } })
      .toArray()
    const treeByRun = new Map(winners.map((run) => [run._id, run.finalTree]))
    const baseByChat = new Map(
      firsts.map((turn) => [turn.chatID, turn.baseSnapshot?.tree ?? turn.frozenBaseSHA] as const),
    )
    const latestNormalBySession = new Map<string, (typeof normalResults)[number]>()
    for (const result of normalResults) {
      if (!latestNormalBySession.has(result.sessionID)) latestNormalBySession.set(result.sessionID, result)
    }
    const sessionByChat = new Map(chats.map((chat) => [chat._id, chat.canonicalSessionID] as const))
    for (const [chatID, turn] of latestApplied) {
      const base = baseByChat.get(chatID)
      const winnerTree = turn.appliedSide ? treeByRun.get(turn.runIDs[turn.appliedSide]) : undefined
      const normal = latestNormalBySession.get(sessionByChat.get(chatID) ?? "")
      const result =
        normal?.resultTree !== undefined &&
        normal.precedingTurnCount !== undefined &&
        normal.precedingTurnCount > turn.turnIndex
          ? normal.resultTree
          : winnerTree
      if (base && result) spans.set(chatID, { base, result })
    }
    return spans
  }

  async createTurn(turn: TurnDocument) {
    const result = await insertIdempotent(this.turns, turn)
    this.changed({ chatID: turn.chatID })
    return result
  }

  async claimSingleAgentRating(rating: SingleAgentRatingDocument) {
    const result = await insertClaimed(this.singleAgentRatings, rating)
    this.changed()
    return result
  }

  /**
   * A rating can be written before its chat exists, because a plain prompt
   * assigns a contestant without one. Claim those for the chat's owner when the
   * chat arrives; ratings that already name an owner are left alone.
   */
  async adoptSessionRatings(sessionID: string, userId: string) {
    await this.singleAgentRatings.updateMany(
      { sessionID, userId: { $exists: false } },
      { $set: { userId, updatedAt: new Date() } },
    )
  }

  singleAgentRating(sessionID: string, messageID: string) {
    return this.singleAgentRatings.findOne({ sessionID, messageID })
  }

  latestSingleAgentRating(sessionID: string) {
    return this.singleAgentRatings.find({ sessionID }).sort({ createdAt: -1, _id: -1 }).limit(1).next()
  }

  async completeSingleAgentRating(input: { sessionID: string; messageID: string; at?: Date }) {
    const at = input.at ?? new Date()
    const updated = await this.singleAgentRatings.findOneAndUpdate(
      { sessionID: input.sessionID, messageID: input.messageID, completedAt: { $exists: false } },
      { $set: { completedAt: at, updatedAt: at } },
      { returnDocument: "after" },
    )
    if (updated) this.changed()
    if (updated) return updated
    const current = await this.singleAgentRatings.findOne({
      sessionID: input.sessionID,
      messageID: input.messageID,
    })
    if (!current) throw new Error(`Arena single-agent pass not found: ${input.messageID}`)
    return current
  }

  async recordSingleAgentResult(input: {
    sessionID: string
    messageID: string
    precedingTurnCount: number
    resultTree: string
  }) {
    const updated = await this.singleAgentRatings.findOneAndUpdate(
      {
        sessionID: input.sessionID,
        messageID: input.messageID,
        completedAt: { $exists: true },
      },
      {
        $set: {
          precedingTurnCount: input.precedingTurnCount,
          resultTree: input.resultTree,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena single-agent pass not found: ${input.messageID}`)
    this.changed()
    return updated
  }

  async recordSingleAgentVote(input: {
    sessionID: string
    ratingID: SingleAgentRatingDocument["_id"]
    vote: SingleAgentVote
    model: string
    participantID?: string
    at?: Date
  }) {
    const at = input.at ?? new Date()
    const current = await this.latestSingleAgentRating(input.sessionID)
    if (!current || current._id !== input.ratingID) {
      throw new Error("Arena single-agent pass is no longer current")
    }
    if (!current.completedAt) throw new Error("Arena single-agent pass is not complete")
    const updated = await this.singleAgentRatings.findOneAndUpdate(
      {
        _id: input.ratingID,
        sessionID: input.sessionID,
        completedAt: { $exists: true },
        vote: { $exists: false },
      },
      {
        $set: {
          vote: input.vote,
          "assignment.model": input.model,
          ...(input.participantID ? { voteParticipantID: input.participantID } : {}),
          voteAt: at,
          revealAt: at,
          updatedAt: at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) {
      const latest = await this.latestSingleAgentRating(input.sessionID)
      if (latest?._id === input.ratingID) {
        this.changed()
        return updated
      }
      await this.singleAgentRatings.updateOne(
        { _id: input.ratingID, vote: input.vote, voteAt: at, revealAt: at },
        {
          $unset: { vote: "", voteParticipantID: "", voteAt: "", revealAt: "" },
          $set: { updatedAt: current.updatedAt },
        },
      )
      throw new Error("Arena single-agent pass is no longer current")
    }
    const recorded = await this.singleAgentRatings.findOne({ _id: input.ratingID })
    if (!recorded) throw new Error(`Arena single-agent rating not found: ${input.ratingID}`)
    if (recorded.vote === input.vote) return recorded
    throw new Error("Arena single-agent rating has already been recorded")
  }

  async claimTurn(turn: TurnDocument) {
    const result = await insertClaimed(this.turns, turn)
    this.changed({ chatID: turn.chatID })
    return result
  }

  async saveRun(run: RunDocument) {
    const result = await insertIdempotent(this.runs, run)
    this.changed({ turnID: run.turnID })
    return result
  }

  async run(runID: string) {
    return this.runs.findOne({ _id: runID })
  }

  async runsForTurn(turnID: string) {
    return this.runs.find({ turnID }).sort({ side: 1 }).toArray()
  }

  async runsForChat(chatID: string) {
    const turnIDs = (await this.turns.find({ chatID }, { projection: { _id: 1 } }).toArray()).map((turn) => turn._id)
    if (turnIDs.length === 0) return []
    return this.runs.find({ turnID: { $in: turnIDs } }).toArray()
  }

  // Every worktree this chat has ever used. A contestant transcript can reference an earlier turn's
  // worktree, so canonicalizing paths needs the full set rather than just the turn being promoted.
  async worktreesForChat(chatID: string) {
    const turnIDs = (await this.turns.find({ chatID }, { projection: { _id: 1 } }).toArray()).map((turn) => turn._id)
    if (turnIDs.length === 0) return []
    const runs = await this.runs.find({ turnID: { $in: turnIDs } }, { projection: { worktree: 1 } }).toArray()
    return [...new Set(runs.map((run) => run.worktree).filter((worktree) => !!worktree))]
  }

  async updateRun(runID: string, patch: Partial<Omit<RunDocument, "_id" | "turnID" | "side">>) {
    const updatedAt = patch.updatedAt ?? new Date()
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      { $set: { ...patch, updatedAt } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async claimReplyContinuation(turnID: string, sides: readonly Side[], at = new Date()) {
    requireTransition("awaiting_vote", "running")
    const current = await this.turns.findOne({ _id: turnID })
    if (!current) throw new Error(`Arena turn not found: ${turnID}`)
    if (current.state !== "awaiting_vote" || current.resolution) {
      return { turn: current, claimed: false as const, comparisonID: current.comparisonID }
    }
    const updated = await this.turns.findOneAndUpdate(
      { _id: turnID, state: "awaiting_vote", resolution: { $exists: false } },
      {
        $set: {
          state: "running",
          comparisonState: "pending",
          updatedAt: at,
          "transitionTimestamps.running": at,
        },
        $unset: { comparisonID: "" },
        $pullAll: {
          finalizedSides: [...sides],
          selectableSides: [...sides],
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, claimed: true as const, comparisonID: current.comparisonID }
    const latest = await this.turns.findOne({ _id: turnID })
    if (!latest) throw new Error(`Arena turn not found: ${turnID}`)
    return { turn: latest, claimed: false as const, comparisonID: latest.comparisonID }
  }

  async claimRunningReplyContinuation(turnID: string, sides: readonly Side[], at = new Date()) {
    const updated = await this.turns.findOneAndUpdate(
      {
        _id: turnID,
        state: "running",
        resolution: { $exists: false },
        finalizedSides: { $all: [...sides] },
      },
      {
        $set: { updatedAt: at },
        $pullAll: {
          finalizedSides: [...sides],
          selectableSides: [...sides],
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, claimed: true as const, comparisonID: undefined }
    const current = await this.turns.findOne({ _id: turnID })
    if (!current) throw new Error(`Arena turn not found: ${turnID}`)
    return { turn: current, claimed: false as const, comparisonID: undefined }
  }

  async claimTurnFinalization(turnID: string, at = new Date()) {
    requireTransition("running", "finalizing")
    const updated = await this.turns.findOneAndUpdate(
      {
        _id: turnID,
        state: "running",
        resolution: { $exists: false },
        finalizedSides: { $all: ["a", "b"] },
      },
      {
        $set: {
          state: "finalizing",
          updatedAt: at,
          "transitionTimestamps.finalizing": at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, claimed: true as const }
    const current = await this.turns.findOne({ _id: turnID })
    if (!current) throw new Error(`Arena turn not found: ${turnID}`)
    return { turn: current, claimed: false as const }
  }

  async resetRunForReply(runID: string, at = new Date()) {
    const run = await this.runs.findOne({ _id: runID })
    if (!run) throw new Error(`Arena run not found: ${runID}`)
    if (run.transcriptArchiveID) {
      const manifest = await this.sessionArchives.findOne({ _id: run.transcriptArchiveID, runID })
      if (manifest?.artifactIDs.length) await this.artifacts.deleteMany({ _id: { $in: [...manifest.artifactIDs] } })
      await this.sessionArchives.deleteOne({ _id: run.transcriptArchiveID, runID })
    }
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      {
        $set: {
          runState: "pending",
          durationMs: null,
          selectable: false,
          startedAt: at,
          updatedAt: at,
        },
        $unset: {
          error: "",
          completedAt: "",
          terminalAssistantMessageID: "",
          archivedAt: "",
          transcriptArchiveID: "",
          archiveComplete: "",
          finalizedAt: "",
          suggestedTitle: "",
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async clearComparison(turnID: string, comparisonID?: string) {
    const comparison = comparisonID
      ? await this.comparisons.findOne({ _id: comparisonID, turnID })
      : await this.comparisons.findOne({ turnID })
    const artifactIDs = [
      `${turnID}|comparison-base-to-a`,
      `${turnID}|comparison-base-to-b`,
      `${turnID}|comparison-a-to-b`,
      comparison?.requestArtifactID,
      comparison?.responseArtifactID,
    ].filter((id): id is string => !!id)
    if (artifactIDs.length) await this.artifacts.deleteMany({ _id: { $in: artifactIDs } })
    if (comparison) {
      await this.comparisons.deleteOne({ _id: comparison._id, turnID })
      this.changed({ turnID })
    }
  }

  async addDescendant(runID: string, sessionID: string) {
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      { $addToSet: { descendantSessionIDs: sessionID }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async recordGenerationRetry(runID: string, retry: GenerationRetry) {
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      { $addToSet: { retries: retry }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async addResolvedProvider(runID: string, provider: string) {
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      { $addToSet: { resolvedProviders: provider }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  saveGeneration(generation: GenerationDocument) {
    return insertIdempotent(this.generations, generation)
  }

  async updateGeneration(
    generationID: string,
    patch: Partial<Omit<GenerationDocument, "_id" | "runID" | "callIndex">>,
  ) {
    const updated = await this.generations.findOneAndUpdate(
      { _id: generationID },
      { $set: patch },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena generation not found: ${generationID}`)
    this.changed()
    return updated
  }

  async accumulateRunUsage(runID: string, usage: NonNullable<GenerationDocument["usage"]>) {
    const updated = await this.runs.findOneAndUpdate(
      { _id: runID },
      {
        $inc: {
          "usage.promptTokens": usage.promptTokens,
          "usage.completionTokens": usage.completionTokens,
          "usage.reasoningTokens": usage.reasoningTokens,
          "usage.totalTokens": usage.totalTokens,
          "usage.cacheReadTokens": usage.cacheReadTokens,
          "usage.cacheWriteTokens": usage.cacheWriteTokens,
          "usage.cost": usage.cost,
          "usage.attempts": usage.attempts,
          "usage.latencyMs": usage.latencyMs,
        },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena run not found: ${runID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  saveSessionArchive(archive: SessionArchiveDocument) {
    return insertIdempotent(this.sessionArchives, archive)
  }

  async saveComparison(comparison: ComparisonDocument) {
    const result = await insertIdempotent(this.comparisons, comparison)
    this.changed({ turnID: comparison.turnID })
    return result
  }

  async updateComparison(
    comparisonID: string,
    patch: Partial<Omit<ComparisonDocument, "_id" | "turnID" | "model" | "provider">>,
  ) {
    const updatedAt = patch.updatedAt ?? new Date()
    const updated = await this.comparisons.findOneAndUpdate(
      { _id: comparisonID },
      { $set: { ...patch, updatedAt } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena comparison not found: ${comparisonID}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async saveEvent(event: ArenaEventDocument) {
    if (!event.snapshotKey) return insertIdempotent(this.events, event)
    const claimed = await insertClaimed(this.events, {
      ...event,
      firstSequence: event.sequence,
      firstReceivedAt: event.receivedAt,
      updateCount: 1,
      duplicateCount: 0,
    })
    if (claimed.inserted) return claimed.value
    const duplicate = claimed.value.contentHash === event.contentHash
    const {
      _id,
      firstSequence: _firstSequence,
      firstReceivedAt: _firstReceivedAt,
      updateCount: _updateCount,
      duplicateCount: _duplicateCount,
      ...latest
    } = event
    const updated = await this.events.findOneAndUpdate(
      { _id },
      {
        $set: latest,
        $inc: { updateCount: 1, ...(duplicate ? { duplicateCount: 1 } : {}) },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena event snapshot upsert failed: ${_id}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async saveRawEvent(event: RawEventDocument) {
    if (!event.snapshotKey) return insertIdempotent(this.rawEvents, event)
    const claimed = await insertClaimed(this.rawEvents, {
      ...event,
      firstReceiveSequence: event.receiveSequence,
      firstReceivedAt: event.receivedAt,
      updateCount: 1,
      duplicateCount: 0,
    })
    if (claimed.inserted) return claimed.value
    const duplicate = claimed.value.contentHash === event.contentHash
    const {
      _id,
      firstReceiveSequence: _firstReceiveSequence,
      firstReceivedAt: _firstReceivedAt,
      updateCount: _updateCount,
      duplicateCount: _duplicateCount,
      ...latest
    } = event
    const updated = await this.rawEvents.findOneAndUpdate(
      { _id },
      {
        $set: latest,
        $inc: { updateCount: 1, ...(duplicate ? { duplicateCount: 1 } : {}) },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena raw event snapshot upsert failed: ${_id}`)
    this.changed({ turnID: updated.turnID })
    return updated
  }

  async transitionTurn(turnID: string, to: BattleState, at = new Date()) {
    for (const _attempt of [0, 1, 2]) {
      const current = await this.turns.findOne({ _id: turnID })
      if (!current) throw new Error(`Arena turn not found: ${turnID}`)
      if (current.state === to) return current
      requireTransition(current.state, to)
      const updated = await this.turns.findOneAndUpdate(
        { _id: turnID, state: current.state },
        {
          $set: {
            state: to,
            updatedAt: at,
            [`transitionTimestamps.${to}`]: at,
          },
        },
        { returnDocument: "after" },
      )
      if (updated) this.changed({ chatID: updated.chatID })
      if (updated) return updated
    }
    throw new Error(`Arena turn transition lost a concurrent update: ${turnID}`)
  }

  async claimTransition(turnID: string, from: BattleState, to: BattleState, at = new Date()) {
    requireTransition(from, to)
    const updated = await this.turns.findOneAndUpdate(
      { _id: turnID, state: from },
      {
        $set: {
          state: to,
          updatedAt: at,
          [`transitionTimestamps.${to}`]: at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, claimed: true as const }

    const current = await this.turns.findOne({ _id: turnID })
    if (!current) throw new Error(`Arena turn not found: ${turnID}`)
    if (current.state === to) return { turn: current, claimed: false as const }
    throw new Error(`Arena turn cannot be claimed from ${from}: ${turnID}`)
  }

  /**
   * Claim a parked promotion for discard and record the answer in the same update.
   *
   * Recovery treats an unapplied `application_failed` turn as still to apply. Keeping the choice
   * in the compare-and-set prevents a restart between the state transition and the choice write
   * from applying the winner before the discard can take effect.
   */
  async claimApplyBaseChoice(input: {
    readonly turnID: string
    readonly choice: ApplyBaseChoice
    readonly at: Date
  }) {
    const updated = await this.turns.findOneAndUpdate(
      {
        _id: input.turnID,
        state: "application_failed",
        "gitApplication.state": { $in: ["review", "manual", "blocked", "failed"] },
        applyBaseChoice: { $exists: false },
      },
      {
        $set: {
          state: "applying" as const,
          applyBaseChoice: input.choice,
          updatedAt: input.at,
          "transitionTimestamps.applying": input.at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) return { turn: updated, claimed: true as const }

    const current = await this.turns.findOne({ _id: input.turnID })
    if (!current) throw new Error(`Arena turn not found: ${input.turnID}`)
    if (current.applyBaseChoice === input.choice) return { turn: current, claimed: false as const }
    throw new Error(`Arena turn is not ready to discard its winner: ${input.turnID}`)
  }

  async turn(turnID: string) {
    return this.turns.findOne({ _id: turnID })
  }

  async turnsForChat(chatID: string) {
    return this.turns.find({ chatID }).sort({ turnIndex: 1 }).toArray()
  }

  async recordResolution(input: {
    readonly turnID: string
    readonly resolution: Resolution
    readonly vote?: Vote
    readonly participantID?: string
    readonly appliedSide?: Side
    readonly models: Readonly<Record<Side, string>>
    readonly expectedState: "awaiting_vote" | "awaiting_stop_resolution"
    readonly at: Date
  }) {
    const candidate = await this.turns.findOne({ _id: input.turnID })
    if (!candidate) throw new Error(`Arena turn not found: ${input.turnID}`)
    const awaitingVoteAt = candidate.transitionTimestamps.awaiting_vote
    const updated = await this.turns.findOneAndUpdate(
      { _id: input.turnID, state: input.expectedState, resolution: { $exists: false } },
      {
        $set: {
          resolution: input.resolution,
          ...(input.vote ? { vote: input.vote } : {}),
          ...(input.participantID ? { voteParticipantID: input.participantID } : {}),
          ...(input.resolution.kind === "vote" ? { selectedEarly: false } : {}),
          ...(input.resolution.kind === "vote"
            ? {
                state: "applying" as const,
                "transitionTimestamps.applying": input.at,
              }
            : {}),
          ...(input.resolution.kind === "stopped" ? { comparisonState: "skipped" as const } : {}),
          ...(input.appliedSide ? { appliedSide: input.appliedSide } : {}),
          "placement.a.model": input.models.a,
          "placement.b.model": input.models.b,
          ...(input.resolution.kind === "vote" && awaitingVoteAt
            ? { timeToVoteMs: Math.max(0, input.at.getTime() - awaitingVoteAt.getTime()) }
            : {}),
          voteAt: input.at,
          revealAt: input.at,
          updatedAt: input.at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, recorded: true as const }

    const current = await this.turns.findOne({ _id: input.turnID })
    if (!current) throw new Error(`Arena turn not found: ${input.turnID}`)
    if (current.resolution) return { turn: current, recorded: false as const }
    throw new Error(`Arena turn is not ready to record a resolution: ${input.turnID}`)
  }

  async markRunFinalized(input: {
    readonly turnID: string
    readonly side: Side
    readonly selectable: boolean
    readonly at: Date
  }) {
    const updated = await this.turns.findOneAndUpdate(
      { _id: input.turnID },
      {
        $addToSet: {
          finalizedSides: input.side,
          ...(input.selectable ? { selectableSides: input.side } : {}),
        },
        $set: { updatedAt: input.at },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena turn not found: ${input.turnID}`)
    this.changed({ chatID: updated.chatID })
    return updated
  }

  async claimEarlyResolution(input: {
    readonly turnID: string
    readonly side: Side
    readonly participantID?: string
    readonly models: Readonly<Record<Side, string>>
    readonly at: Date
  }) {
    const other = input.side === "a" ? "b" : "a"
    const resolution = earlyResolution(input.side)
    const updated = await this.turns.findOneAndUpdate(
      {
        _id: input.turnID,
        state: "running",
        resolution: { $exists: false },
        finalizedSides: { $all: [input.side], $nin: [other] },
        selectableSides: { $all: [input.side] },
      },
      {
        $set: {
          state: "early_selected",
          resolution,
          vote: input.side,
          ...(input.participantID ? { voteParticipantID: input.participantID } : {}),
          selectedEarly: true,
          comparisonState: "skipped",
          appliedSide: input.side,
          "placement.a.model": input.models.a,
          "placement.b.model": input.models.b,
          voteAt: input.at,
          revealAt: input.at,
          updatedAt: input.at,
          "transitionTimestamps.early_selected": input.at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, claimed: true as const }

    const current = await this.turns.findOne({ _id: input.turnID })
    if (!current) throw new Error(`Arena turn not found: ${input.turnID}`)
    return { turn: current, claimed: false as const }
  }

  async recordAbort(input: {
    readonly turnID: string
    readonly expectedState: "creation_failed" | "finalization_failed" | "interrupted_recovery"
    readonly reason: string
    readonly models: Readonly<Record<Side, string>>
    readonly at: Date
  }) {
    const resolution = abortedResolution(input.reason)
    const updated = await this.turns.findOneAndUpdate(
      { _id: input.turnID, state: input.expectedState, resolution: { $exists: false } },
      {
        $set: {
          resolution,
          "placement.a.model": input.models.a,
          "placement.b.model": input.models.b,
          comparisonState: "skipped",
          revealAt: input.at,
          updatedAt: input.at,
        },
      },
      { returnDocument: "after" },
    )
    if (updated) this.changed({ chatID: updated.chatID })
    if (updated) return { turn: updated, recorded: true as const }

    const current = await this.turns.findOne({ _id: input.turnID })
    if (!current) throw new Error(`Arena turn not found: ${input.turnID}`)
    if (current.resolution?.kind === "aborted") return { turn: current, recorded: false as const }
    throw new Error(`Arena turn is not ready to record an abort: ${input.turnID}`)
  }

  async updateTurn(turnID: string, patch: Partial<Omit<TurnDocument, "_id" | "chatID" | "turnIndex">>) {
    const updatedAt = patch.updatedAt ?? new Date()
    const updated = await this.turns.findOneAndUpdate(
      { _id: turnID },
      { $set: { ...patch, updatedAt } },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena turn not found: ${turnID}`)
    this.changed({ chatID: updated.chatID })
    return updated
  }

  async activateTurn(
    chatID: string,
    turn: TurnDocument,
    canonical: {
      readonly previous: {
        readonly branch?: string
        readonly head: string
        readonly sessionID: string
        readonly transcriptHash: string
        readonly transcriptVersion: number
      }
      readonly branch?: string
      readonly head: string
      readonly indexTree?: string
      // Symmetry with completeTurn. No caller reaches it today: a battle cannot activate on a
      // conflicted trunk, because startTurnUnlocked and snapshotBase both refuse first.
      readonly trunkConflicts?: readonly string[]
      readonly sessionID: string
      readonly transcriptHash: string
      readonly transcriptChanged: boolean
    },
  ) {
    const claimed = await this.claimTurn(turn)
    const admitted = claimed.value
    const clearedConflicts = canonical.trunkConflicts?.length === 0
    const activated = await this.chats
      .findOneAndUpdate(
        {
          _id: chatID,
          status: "ready",
          checkoutEvicted: { $ne: true },
          arenaBranch: canonical.previous.branch ?? { $exists: false },
          currentCanonicalSHA: canonical.previous.head,
          canonicalSessionID: canonical.previous.sessionID,
          canonicalTranscriptHash: canonical.previous.transcriptHash,
          canonicalTranscriptVersion: canonical.previous.transcriptVersion,
        },
        {
          $set: {
            status: "battle_active",
            activeTurnID: admitted._id,
            ...(canonical.branch
              ? {
                  arenaBranch: canonical.branch,
                  "repository.branch": canonical.branch,
                  "canonicalCheckout.branch": canonical.branch,
                }
              : {}),
            "canonicalCheckout.detached": !canonical.branch,
            "canonicalCheckout.head": canonical.head,
            ...(canonical.indexTree ? { "canonicalCheckout.indexTree": canonical.indexTree } : {}),
            ...(canonical.trunkConflicts?.length ? { trunkConflicts: canonical.trunkConflicts } : {}),
            "canonicalCheckout.transcriptHash": canonical.transcriptHash,
            currentCanonicalSHA: canonical.head,
            canonicalSessionID: canonical.sessionID,
            canonicalTranscriptHash: canonical.transcriptHash,
            updatedAt: admitted.createdAt,
          },
          ...(canonical.branch && !clearedConflicts
            ? {}
            : {
                $unset: {
                  ...(canonical.branch
                    ? {}
                    : {
                        arenaBranch: "",
                        "repository.branch": "",
                        "canonicalCheckout.branch": "",
                      }),
                  ...(clearedConflicts ? { trunkConflicts: "" } : {}),
                },
              }),
          $inc: { turnCount: 1, ...(canonical.transcriptChanged ? { canonicalTranscriptVersion: 1 } : {}) },
        },
        { returnDocument: "after" },
      )
      .catch(async (error) => {
        if (!isDuplicateKeyError(error)) throw error
        if (claimed.inserted) await this.turns.deleteOne({ _id: admitted._id, state: "creating" })
        throw new Error(`Arena turn activation conflicted with another request`)
      })
    if (activated) {
      this.changed()
      return { chat: activated, turn: admitted, activated: true as const }
    }
    const current = await this.chats.findOne({ _id: chatID })
    if (current?.activeTurnID === admitted._id) {
      return { chat: current, turn: admitted, activated: false as const }
    }
    if (claimed.inserted) await this.turns.deleteOne({ _id: admitted._id, state: "creating" })
    throw new Error(`Arena chat is not ready for turn ${admitted._id}`)
  }

  async completeTurn(input: {
    readonly chatID: string
    readonly turnID: string
    readonly canonicalSHA: string
    readonly canonicalSessionID: string
    readonly branch?: string
    readonly detached?: boolean
    readonly indexTree?: string
    readonly trunkConflicts?: readonly string[]
    readonly completedAt: Date
  }) {
    const updated = await this.chats.findOneAndUpdate(
      { _id: input.chatID, activeTurnID: input.turnID, status: "battle_active" },
      {
        $set: {
          status: "ready",
          currentCanonicalSHA: input.canonicalSHA,
          canonicalSessionID: input.canonicalSessionID,
          "canonicalCheckout.head": input.canonicalSHA,
          ...(input.detached === undefined ? {} : { "canonicalCheckout.detached": input.detached }),
          ...(input.branch
            ? {
                arenaBranch: input.branch,
                "repository.branch": input.branch,
                "canonicalCheckout.branch": input.branch,
              }
            : {}),
          ...(input.indexTree ? { "canonicalCheckout.indexTree": input.indexTree } : {}),
          ...(input.trunkConflicts?.length ? { trunkConflicts: input.trunkConflicts } : {}),
          updatedAt: input.completedAt,
        },
        $unset: {
          activeTurnID: "",
          ...(input.detached
            ? {
                arenaBranch: "",
                "repository.branch": "",
                "canonicalCheckout.branch": "",
              }
            : {}),
          ...(input.trunkConflicts?.length === 0 ? { trunkConflicts: "" } : {}),
        },
      },
      { returnDocument: "after" },
    )
    if (!updated) throw new Error(`Arena chat completion guard failed for turn ${input.turnID}`)
    this.changed({ chatID: updated._id })
    return updated
  }

  /** Idempotent on `_id`, so a replayed flush costs a duplicate-key error and nothing else. */
  async saveReviewEvents(events: readonly ReviewEventDocument[]) {
    if (events.length === 0) return 0
    let inserted = 0
    for (const event of events) {
      if ((await insertClaimed(this.reviewEvents, event)).inserted) inserted += 1
    }
    return inserted
  }

  /** A turn's review in the order the voter produced it, for the metrics rollup. */
  async reviewEventsForTurn(turnID: string) {
    return this.reviewEvents.find({ turnID }).sort({ offsetMs: 1 }).toArray()
  }

  /**
   * One document per battle, replaced rather than inserted: a recompute after a
   * definition changes has to overwrite the old row, not sit beside it.
   */
  /**
   * Resolved turns whose analytics row is missing or was computed against an older
   * definition. The row is derived, so it can always be rebuilt from the turn; what
   * cannot be rebuilt is a turn nobody noticed was absent.
   */
  async staleBattleMetrics(schemaVersion: number, limit: number) {
    const current = await this.battleMetrics
      .find({ schemaVersion: { $gte: schemaVersion } }, { projection: { _id: 1 } })
      .toArray()
    return this.turns
      .find(
        { "resolution.kind": { $exists: true }, _id: { $nin: current.map((row) => row._id) } },
        { projection: { _id: 1 } },
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray()
  }

  async saveBattleMetrics(row: BattleMetricsDocument) {
    const result = await this.battleMetrics.replaceOne({ _id: row._id }, row, { upsert: true })
    return (result.insertedId ? 1 : 0) + result.modifiedCount
  }

  async generationsForRuns(runIDs: readonly string[]) {
    if (runIDs.length === 0) return []
    return this.generations.find({ runID: { $in: [...runIDs] } }).toArray()
  }

  async sessionArchive(runID: string) {
    return this.sessionArchives.findOne({ runID })
  }

  async artifact(artifactID: string) {
    return this.artifacts.findOne({ _id: artifactID })
  }

  /** Every resolved turn, oldest first, for a backfill of the metrics table. */
  async resolvedTurns() {
    return this.turns
      .find({ resolution: { $exists: true } })
      .sort({ createdAt: 1 })
      .toArray()
  }

  async countSteer(turnID: string) {
    await this.turns.updateOne({ _id: turnID }, { $inc: { steerCount: 1 }, $set: { updatedAt: new Date() } })
  }

  async storeArtifact(input: ArtifactInput) {
    const runID = input.runID
    if (!runID) return this.storeArtifactNow(input)
    const previous = this.artifactQueues.get(runID) ?? Promise.resolve()
    const write = previous.then(() => this.storeArtifactNow(input))
    const tail = write.then(
      () => undefined,
      () => undefined,
    )
    this.artifactQueues.set(runID, tail)
    return write.finally(() => {
      if (this.artifactQueues.get(runID) === tail) this.artifactQueues.delete(runID)
    })
  }

  async storePreparedArtifact(input: PreparedArtifactInput) {
    const runID = input.runID
    if (!runID) return this.storePreparedArtifactNow(input)
    const previous = this.artifactQueues.get(runID) ?? Promise.resolve()
    const write = previous.then(() => this.storePreparedArtifactNow(input))
    const tail = write.then(
      () => undefined,
      () => undefined,
    )
    this.artifactQueues.set(runID, tail)
    return write.finally(() => {
      if (this.artifactQueues.get(runID) === tail) this.artifactQueues.delete(runID)
    })
  }

  private async storeArtifactNow(input: ArtifactInput) {
    const existing = await this.artifacts.findOne({ _id: input._id })
    if (existing) return existing
    const totals = input.runID
      ? (await this.artifacts.find({ runID: input.runID }, { projection: { storedSize: 1 } }).toArray()).reduce(
          (sum, artifact) => sum + artifact.storedSize,
          0,
        )
      : 0
    const limited = bound({ data: input.data, runStoredBytes: totals })
    return insertIdempotent(this.artifacts, {
      ...input,
      ...limited,
    })
  }

  private async storePreparedArtifactNow(input: PreparedArtifactInput) {
    const existing = await this.artifacts.findOne({ _id: input._id })
    if (existing) return existing
    const totals = input.runID
      ? (await this.artifacts.find({ runID: input.runID }, { projection: { storedSize: 1 } }).toArray()).reduce(
          (sum, artifact) => sum + artifact.storedSize,
          0,
        )
      : 0
    const limited = boundPrepared({
      data: input.data,
      originalSize: input.originalSize,
      contentHash: input.contentHash,
      runStoredBytes: totals,
    })
    return insertIdempotent(this.artifacts, {
      ...input,
      ...limited,
    })
  }

  async snapshot(chatID: string, afterSequence = -1): Promise<BattleSnapshot> {
    const chat = await this.chats.findOne({ _id: chatID })
    if (!chat) throw new Error(`Arena chat not found: ${chatID}`)
    const singleAgentRating = await this.latestSingleAgentRating(chat.canonicalSessionID)
    const history = await this.history(chatID)
    const targetTurnID = chat.activeTurnID ?? history.at(-1)?._id
    if (!targetTurnID)
      return { chat, history, runs: [], events: [], ...(singleAgentRating ? { singleAgentRating } : {}) }
    const [turn, runs, events, comparison] = await Promise.all([
      this.turns.findOne({ _id: targetTurnID }),
      this.runs.find({ turnID: targetTurnID }).sort({ side: 1 }).toArray(),
      this.events
        .find({ turnID: targetTurnID, sequence: { $gt: afterSequence } })
        .sort({ sequence: 1 })
        .toArray(),
      this.comparisons.findOne({ turnID: targetTurnID }),
    ])
    if (!turn) throw new Error(`Arena turn not found: ${targetTurnID}`)
    return {
      chat,
      turn,
      history,
      runs,
      events,
      ...(singleAgentRating ? { singleAgentRating } : {}),
      ...(comparison ? { comparison } : {}),
    }
  }

  async snapshotTurn(turnID: string, afterSequence = -1): Promise<BattleSnapshot> {
    const turn = await this.turns.findOne({ _id: turnID })
    if (!turn) throw new Error(`Arena turn not found: ${turnID}`)
    const [chat, history, runs, events, comparison] = await Promise.all([
      this.chats.findOne({ _id: turn.chatID }),
      this.history(turn.chatID),
      this.runs.find({ turnID }).sort({ side: 1 }).toArray(),
      this.events
        .find({ turnID, sequence: { $gt: afterSequence } })
        .sort({ sequence: 1 })
        .toArray(),
      this.comparisons.findOne({ turnID }),
    ])
    if (!chat) throw new Error(`Arena chat not found: ${turn.chatID}`)
    const singleAgentRating = await this.latestSingleAgentRating(chat.canonicalSessionID)
    return {
      chat,
      turn,
      history,
      runs,
      events,
      ...(comparison ? { comparison } : {}),
      ...(singleAgentRating ? { singleAgentRating } : {}),
    }
  }
}

export async function connect(input: Configuration) {
  const client = new MongoClient(input.uri)
  await client.connect()
  const store = new Store(client, client.db(input.database))
  await store.initialize()
  return store
}

export * as ArenaMongo from "./mongo"
