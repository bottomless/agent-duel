import type { Database } from "bun:sqlite"
import {
  projectResearchRecords,
  researchWireRecords,
  type ResearchMutation,
} from "@agent-duel/arena-service/research-protocol"

export interface QueuedResearchRecord {
  sequence: number
  json: string
  bytes: number
}
export interface ResearchRetryState {
  failures: number
  nextAttempt: number
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
  }

  enqueue(mutation: ResearchMutation) {
    const records = projectResearchRecords(mutation).flatMap(researchWireRecords)
    this.database.transaction(() => {
      for (const record of records) {
        const json = JSON.stringify(record)
        this.database
          .query(`INSERT OR IGNORE INTO arena_research_queue
          (partition, collection, record_id, revision, json, bytes) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(this.partition, record.collection, record.id, record.revision, json, Buffer.byteLength(json))
      }
    })()
  }

  peek(limit: number, maxBytes = Number.MAX_SAFE_INTEGER): QueuedResearchRecord[] {
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
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM arena_research_queue WHERE partition = ?")
      .get(this.partition)!.count
  }

  get bytes() {
    return this.database
      .query<{ bytes: number }, [string]>(
        "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM arena_research_queue WHERE partition = ?",
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
