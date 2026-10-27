import type { Database } from "bun:sqlite"
import { z } from "zod"
import { encode, decode } from "./local-value"
import {
  projectResearchRecords,
  researchWireRecords,
  type ResearchMutation,
} from "@agent-duel/arena-service/research-protocol"

const mutationSchema = z.object({
  collection: z.string(),
  id: z.string(),
  revision: z.number(),
  document: z.record(z.string(), z.unknown()).nullable(),
})

export interface QueuedResearchRecord {
  sequence: number
  json: string
  bytes: number
}
export interface ResearchRetryState {
  failures: number
  nextAttempt: number
}
export interface RejectedResearchRecord {
  sequence: number
  id: string
  json: string
  reason: string
}
interface PendingMutation {
  sequence: number
  json: string
}

export class ResearchQueue {
  constructor(
    private readonly database: Database,
    private readonly partition: string,
  ) {
    database.run(`CREATE TABLE IF NOT EXISTS arena_research_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, partition TEXT NOT NULL,
      collection TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
      json TEXT NOT NULL, bytes INTEGER NOT NULL,
      UNIQUE(partition, collection, record_id, revision))`)
    database.run("CREATE INDEX IF NOT EXISTS arena_research_pending ON arena_research_queue(partition, sequence)")
    database.run(`CREATE TABLE IF NOT EXISTS arena_research_retry (
      partition TEXT PRIMARY KEY, failures INTEGER NOT NULL, next_attempt INTEGER NOT NULL)`)
    database.run(`CREATE TABLE IF NOT EXISTS arena_research_recovery (
      partition TEXT PRIMARY KEY, next_attempt INTEGER NOT NULL)`)
    database.run(`CREATE TABLE IF NOT EXISTS arena_research_rejected (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, partition TEXT NOT NULL,
      collection TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
      json TEXT NOT NULL, bytes INTEGER NOT NULL, reason TEXT NOT NULL)`)
    database.run(
      "CREATE INDEX IF NOT EXISTS arena_research_rejected_record ON arena_research_rejected(partition, collection, record_id, revision)",
    )
    database.run(`CREATE TABLE IF NOT EXISTS arena_research_mutations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, partition TEXT NOT NULL,
      json TEXT NOT NULL)`)
    database.run(
      "CREATE INDEX IF NOT EXISTS arena_research_mutations_pending ON arena_research_mutations(partition, sequence)",
    )
  }

  enqueue(mutation: ResearchMutation) {
    // The local transaction records the mutation without invoking research validation or
    // chunk conversion. Those may fail independently of a valid canonical write.
    this.database
      .query("INSERT INTO arena_research_mutations (partition, json) VALUES (?, ?)")
      .run(this.partition, JSON.stringify(encode(mutation)))
  }

  private prepare(limit: number) {
    const pending = this.database
      .query<PendingMutation, [string, number]>(
        "SELECT sequence, json FROM arena_research_mutations WHERE partition = ? ORDER BY sequence LIMIT ?",
      )
      .all(this.partition, limit)
    for (const item of pending) {
      const mutation = mutationSchema.parse(decode(JSON.parse(item.json)))
      let records
      try {
        records = projectResearchRecords(mutation).flatMap(researchWireRecords)
      } catch {
        this.database.transaction(() => {
          this.database
            .query(`INSERT INTO arena_research_rejected
            (partition, collection, record_id, revision, json, bytes, reason) VALUES (?, ?, ?, ?, ?, ?, 'projection_failed')`)
            .run(
              this.partition,
              mutation.collection,
              mutation.id,
              mutation.revision,
              item.json,
              Buffer.byteLength(item.json),
            )
          this.database
            .query("DELETE FROM arena_research_mutations WHERE partition = ? AND sequence = ?")
            .run(this.partition, item.sequence)
        })()
        continue
      }
      this.database.transaction(() => {
        for (const record of records) {
          const json = JSON.stringify(record)
          this.database
            .query(`INSERT OR IGNORE INTO arena_research_queue
          (partition, collection, record_id, revision, json, bytes)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (
            SELECT 1 FROM arena_research_rejected
            WHERE partition = ?1 AND collection = ?2 AND record_id = ?3 AND revision = ?4)`)
            .run(this.partition, record.collection, record.id, record.revision, json, Buffer.byteLength(json))
        }
        if (records.some((record) => record.document && "$researchChunks" in record.document))
          this.quarantineDependentManifests()
        this.database
          .query("DELETE FROM arena_research_mutations WHERE partition = ? AND sequence = ?")
          .run(this.partition, item.sequence)
      })()
    }
  }

  peek(limit: number, maxBytes = Number.MAX_SAFE_INTEGER): QueuedResearchRecord[] {
    this.prepare(limit)
    const records: QueuedResearchRecord[] = []
    let sequence = 0
    let bytes = 0
    const next = this.database.query<QueuedResearchRecord, [string, number]>(
      "SELECT sequence, json, bytes FROM arena_research_queue WHERE partition = ? AND sequence > ? ORDER BY sequence LIMIT 1",
    )
    while (records.length < limit) {
      const record = next.get(this.partition, sequence)
      if (!record || bytes + record.bytes + 1 > maxBytes) break
      records.push(record)
      bytes += record.bytes + 1
      sequence = record.sequence
    }
    return records
  }

  get count() {
    return this.database
      .query<{ count: number }, [string]>(`SELECT
        (SELECT COUNT(*) FROM arena_research_queue WHERE partition = ?1) +
        (SELECT COUNT(*) FROM arena_research_mutations WHERE partition = ?1) AS count`)
      .get(this.partition)!.count
  }

  get bytes() {
    return this.database
      .query<{ bytes: number }, [string]>(
        `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM arena_research_queue WHERE partition = ?1) +
        (SELECT COALESCE(SUM(LENGTH(CAST(json AS BLOB))), 0) FROM arena_research_mutations WHERE partition = ?1) AS bytes`,
      )
      .get(this.partition)!.bytes
  }

  retry(): ResearchRetryState {
    return (
      this.database
        .query<ResearchRetryState, [string]>(
          "SELECT failures, next_attempt AS nextAttempt FROM arena_research_retry WHERE partition = ?",
        )
        .get(this.partition) ?? { failures: 0, nextAttempt: 0 }
    )
  }

  defer(state: ResearchRetryState) {
    this.database
      .query("INSERT OR REPLACE INTO arena_research_retry (partition, failures, next_attempt) VALUES (?, ?, ?)")
      .run(this.partition, state.failures, state.nextAttempt)
  }

  pending(records: readonly QueuedResearchRecord[]) {
    const query = this.database.query("SELECT 1 FROM arena_research_queue WHERE partition = ? AND sequence = ?")
    return records.filter((record) => query.get(this.partition, record.sequence))
  }

  reject(records: readonly QueuedResearchRecord[], reason: string) {
    this.database.transaction(() => {
      for (const record of records) {
        this.database
          .query(`INSERT INTO arena_research_rejected
          (partition, collection, record_id, revision, json, bytes, reason)
          SELECT partition, collection, record_id, revision, json, bytes, ?
          FROM arena_research_queue WHERE partition = ? AND sequence = ?`)
          .run(reason, this.partition, record.sequence)
      }
      this.acknowledge(records)
      this.quarantineDependentManifests()
    })()
  }

  private quarantineDependentManifests() {
    // Check both on rejection and when preparing later mutations: new archives can
    // share chunks that are already parked. They must wait for the same recovery pass.
    this.database
      .query(`INSERT INTO arena_research_rejected
        (partition, collection, record_id, revision, json, bytes, reason)
        SELECT q.partition, q.collection, q.record_id, q.revision, q.json, q.bytes, 'rejected_chunk'
        FROM arena_research_queue q WHERE q.partition = ? AND EXISTS (
          SELECT 1 FROM json_each(q.json, '$.document.$researchChunks.ids') ids
          JOIN arena_research_rejected r ON r.record_id = ids.value
          WHERE r.partition = q.partition AND r.collection = 'chunks')`)
      .run(this.partition)
    this.database
      .query(`DELETE FROM arena_research_queue WHERE partition = ? AND EXISTS (
        SELECT 1 FROM arena_research_rejected r WHERE r.partition = arena_research_queue.partition
        AND r.collection = arena_research_queue.collection AND r.record_id = arena_research_queue.record_id
        AND r.revision = arena_research_queue.revision)`)
      .run(this.partition)
  }

  rejected(): RejectedResearchRecord[] {
    return this.database
      .query<RejectedResearchRecord, [string]>(
        "SELECT sequence, record_id AS id, json, reason FROM arena_research_rejected WHERE partition = ? ORDER BY sequence",
      )
      .all(this.partition)
  }

  recoveryAt(now: number, interval: number): number | undefined {
    if (!this.database.query("SELECT 1 FROM arena_research_rejected WHERE partition = ? LIMIT 1").get(this.partition))
      return undefined
    // Persist the deadline so restarts and new rejected writes cannot reset the cooldown.
    this.database
      .query("INSERT OR IGNORE INTO arena_research_recovery (partition, next_attempt) VALUES (?, ?)")
      .run(this.partition, now + interval)
    return this.database
      .query<{ nextAttempt: number }, [string]>(
        "SELECT next_attempt AS nextAttempt FROM arena_research_recovery WHERE partition = ?",
      )
      .get(this.partition)!.nextAttempt
  }

  retryRejected() {
    this.database.transaction(() => {
      this.database
        .query(`INSERT OR IGNORE INTO arena_research_queue
        (partition, collection, record_id, revision, json, bytes)
        SELECT partition, collection, record_id, revision, json, bytes FROM arena_research_rejected
        WHERE partition = ? AND reason != 'projection_failed'
        ORDER BY CASE collection WHEN 'chunks' THEN 0 ELSE 1 END, sequence`)
        .run(this.partition)
      this.database
        .query(`INSERT INTO arena_research_mutations (partition, json)
        SELECT partition, json FROM arena_research_rejected WHERE partition = ? AND reason = 'projection_failed'
        ORDER BY sequence`)
        .run(this.partition)
      this.database.query("DELETE FROM arena_research_rejected WHERE partition = ?").run(this.partition)
      this.database.query("DELETE FROM arena_research_recovery WHERE partition = ?").run(this.partition)
    })()
  }

  acknowledge(records: readonly QueuedResearchRecord[]) {
    this.database.transaction(() => {
      for (const record of records)
        this.database
          .query("DELETE FROM arena_research_queue WHERE partition = ? AND sequence = ?")
          .run(this.partition, record.sequence)
      this.database.query("DELETE FROM arena_research_retry WHERE partition = ?").run(this.partition)
    })()
  }
}
