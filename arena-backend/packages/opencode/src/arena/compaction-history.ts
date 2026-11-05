import { createHash, randomUUID } from "node:crypto"
import { desc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Bus } from "@opencode/core/bus"
import type { Database } from "@opencode/core/database/database"
import type { Session as CoreSession } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import {
  createCompactions,
  shouldCompact,
  type CompactionSnapshot,
  type CompactionEntry,
} from "./opportunistic-compaction"
import type { EngagementUsageSnapshot } from "./engagement-usage"

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

export function historyVersion(messages: readonly SessionMessage.Info[]) {
  return createHash("sha256")
    .update(JSON.stringify(messages.map((message) => encodeMessage(message))))
    .digest("hex")
}

export interface Candidate {
  readonly id: string
  readonly checkpoint: SessionMessage.CompactionCompleted
}

export interface HistoryCompactionInput {
  readonly sessionID: Session.ID
  readonly runID: string
  readonly admission?: number
  readonly usage: EngagementUsageSnapshot | undefined
}

export interface HistoryCompactionTransfer {
  readonly sourceSessionID: Session.ID
  readonly targetSessionID: Session.ID
  readonly transform: (
    checkpoint: SessionMessage.CompactionCompleted,
  ) => Effect.Effect<SessionMessage.CompactionCompleted, Error>
}

export interface HistoryCompaction {
  readonly admission: (sessionID: Session.ID) => number
  readonly start: (input: HistoryCompactionInput) => Effect.Effect<void, Error>
  readonly accept: (sessionID: Session.ID, receivedAt?: number) => Effect.Effect<boolean, Error>
  readonly transfer: (input: HistoryCompactionTransfer) => Effect.Effect<void, Error>
  readonly invalidate: (sessionID: Session.ID) => void
  readonly dispose: () => void
}

export interface HistoryCompactionPorts {
  readonly sessions: CoreSession.Interface
  readonly database: Database.Interface
  readonly generate: (input: {
    readonly sessionID: Session.ID
    readonly id: string
  }) => Effect.Effect<SessionMessage.CompactionCompleted, Error>
  readonly observe: (id: string, snapshot: CompactionSnapshot<Candidate>) => void
}

/** All inference runs outside the session runner. Only selection writes a completed checkpoint. */
export function createHistoryCompaction(ports: HistoryCompactionPorts): HistoryCompaction {
  const { sessions, database } = ports
  const admissions = new Map<string, number>()
  const admission = (sessionID: Session.ID) => admissions.get(sessionID) ?? 0
  const ids = new Map<number, string>()
  const transforms = new Map<string, HistoryCompactionTransfer["transform"]>()
  // The observer runs synchronously at start, before start returns its handle.
  let startingID: string | undefined
  const candidates = createCompactions<Candidate>((snapshot) => {
    const id = ids.get(snapshot.id) ?? startingID
    if (!id) return
    ids.set(snapshot.id, id)
    ports.observe(id, snapshot)
    if (["used", "failed", "discarded"].includes(snapshot.status) && snapshot.finishedAt !== undefined)
      ids.delete(snapshot.id)
  })

  const start = Effect.fn("ArenaCompaction.start")(function* (input: HistoryCompactionInput) {
    const expectedAdmission = input.admission ?? admission(input.sessionID)
    if (expectedAdmission !== admission(input.sessionID)) return
    const usage = input.usage?.usage
    // Pre-version usage rows encoded missing provider fields as zero and cannot authorize a skip.
    const measured = usage?.provenance === "provider" && usage.version === 2 ? usage : undefined
    if (
      !shouldCompact({
        reasoningTokens: measured?.reasoningTokens ?? null,
        generatedTokens: measured?.completionTokens ?? null,
        contextTokens: input.usage?.contextTokens ?? 0,
      })
    )
      return
    const source = yield* sessions.messages({ sessionID: input.sessionID, order: "asc" })
    if (expectedAdmission !== admission(input.sessionID)) return
    const sourceVersion = historyVersion(source)
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const id = randomUUID()
    const generate = ports
      .generate({ sessionID: input.sessionID, id })
      .pipe(Effect.map((checkpoint) => ({ id, checkpoint })))
    let entry: CompactionEntry<Candidate>
    startingID = id
    try {
      entry = candidates.start({
        runID: input.runID,
        sessionID: input.sessionID,
        sourceVersion,
        generate: (signal) => run(generate, { signal }),
        publish: (_candidate, publish) =>
          run(
            database.db
              .transaction(() =>
                Effect.gen(function* () {
                  const owner = Session.ID.make(entry.sessionID)
                  const current = yield* sessions.messages({ sessionID: owner, order: "asc" })
                  if (historyVersion(current) !== entry.targetVersion) return false
                  if ((yield* sessions.inbox(owner)).length || (yield* sessions.active).has(owner)) return false
                  return publish()
                }),
              )
              .pipe(Effect.orDie),
          ),
      })
    } finally {
      startingID = undefined
    }
  })

  const accept = Effect.fn("ArenaCompaction.accept")(function* (sessionID: Session.ID, receivedAt = Date.now()) {
    const acceptedAdmission = admission(sessionID) + 1
    admissions.set(sessionID, acceptedAdmission)
    const pending = candidates.inspect(sessionID)
    if (pending?.readyAt !== undefined && pending.readyAt > receivedAt) candidates.invalidate(sessionID)
    // Close publication BEFORE reading storage or doing any other asynchronous work.
    const selected = candidates.take(sessionID)
    const transform = transforms.get(sessionID)
    transforms.delete(sessionID)
    if (!selected) return false
    const candidate = selected.candidate.checkpoint
    const checkpoint = transform
      ? yield* transform(candidate).pipe(Effect.onError(() => Effect.sync(() => candidates.discard(selected))))
      : candidate
    const applied = yield* SessionInbox.serialized(
      sessionID,
      database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* sessions.messages({ sessionID, order: "asc" })
            if (historyVersion(current) !== selected.version) return false
            if ((yield* sessions.inbox(sessionID)).length || (yield* sessions.active).has(sessionID)) return false
            if (admission(sessionID) !== acceptedAdmission || selected.entry.status !== "ready") return false
            const message: SessionMessage.CompactionCompleted = {
              ...checkpoint,
              id: SessionMessage.ID.create(),
              time: { created: DateTime.makeUnsafe(Date.now()) },
              metadata: {
                ...checkpoint.metadata,
                arenaOpportunisticCompaction: {
                  id: selected.candidate.id,
                  runID: selected.runID,
                  sourceVersion: selected.sourceVersion,
                },
              },
            }
            const { id: _id, type, ...data } = encodeMessage(message)
            const latest = yield* database.db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, sessionID))
              .orderBy(desc(SessionMessageTable.seq))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            const seq = (latest?.seq ?? -1) + 1
            yield* database.db
              .insert(SessionMessageTable)
              .values({
                id: message.id,
                type,
                data,
                seq,
                session_id: sessionID,
                time_created: DateTime.toEpochMillis(message.time.created),
                time_updated: Date.now(),
              })
              .run()
              .pipe(Effect.orDie)
            yield* Bus.reserveSequence(database.db, sessionID, seq)
            if (admission(sessionID) !== acceptedAdmission || selected.entry.status !== "ready") {
              return yield* Effect.fail(new Error("Compaction selection was superseded during publication"))
            }
            return true
          }),
        )
        .pipe(Effect.orDie),
    ).pipe(Effect.onError(() => Effect.sync(() => candidates.discard(selected))))
    if (applied) candidates.commitUsed(selected)
    else candidates.discard(selected)
    return applied
  })

  const transfer = Effect.fn("ArenaCompaction.transfer")(function* (input: HistoryCompactionTransfer) {
    const targetAdmission = admission(input.targetSessionID)
    const source = candidates.inspect(input.sourceSessionID)
    if (!source) return
    const before = yield* sessions.messages({ sessionID: input.sourceSessionID, order: "asc" })
    if (historyVersion(before) !== source.targetVersion) {
      candidates.invalidate(input.sourceSessionID)
      return
    }
    const target = yield* sessions.messages({ sessionID: input.targetSessionID, order: "asc" })
    if (admission(input.targetSessionID) !== targetAdmission) {
      candidates.invalidate(input.sourceSessionID)
      return
    }
    const entry = candidates.transfer(input.sourceSessionID, input.targetSessionID, {
      sourceVersion: source.targetVersion,
      targetVersion: historyVersion(target),
    })
    if (entry) transforms.set(input.targetSessionID, input.transform)
  })

  return {
    admission,
    start: (input) =>
      start(input).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))),
    accept: (sessionID, receivedAt) =>
      accept(sessionID, receivedAt).pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      ),
    transfer: (input) =>
      transfer(input).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))),
    dispose: () => {
      candidates.dispose()
      transforms.clear()
      admissions.clear()
      ids.clear()
    },
    invalidate: (sessionID) => {
      admissions.set(sessionID, admission(sessionID) + 1)
      candidates.invalidate(sessionID)
      transforms.delete(sessionID)
    },
  }
}
