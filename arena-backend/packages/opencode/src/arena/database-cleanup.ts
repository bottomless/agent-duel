import { Database as SQLite } from "bun:sqlite"
import { existsSync, chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync } from "node:fs"
import { statfs } from "node:fs/promises"
import { dirname } from "node:path"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { databaseLease, databaseHasHolders } from "./database-lease"
import { migrations } from "@opencode/core/database/migration.gen"

const KEY = "arena.v1-cleanup"
const FENCE = "_arena_v1_session"
const RETRY_MS = 24 * 60 * 60 * 1000

type Audit = {
  phase: "audit"
  cursor?: string
  sessions: number
  messages: number
  parts: number
  skipped: number
  skippedTotal?: number
  expectedMessages: number
  importedMessages: number
  targetFingerprint: string
}
type State = Audit | { phase: "vacuum"; retryAfter?: number; copyMs?: number } | { phase: "done" }

export type CleanupInput = { engineDatabase: string; arenaDirectory: string; deadline?: number }
// The live 25 GB copy took 149s. Budget four to six minutes, using previous attempts as a guide.
const MIN_COPY_MS = 4 * 60_000
const HEADROOM = 64 * 1024 * 1024
type Ports = {
  availableBytes?: (required: number) => Promise<number>
  vacuum?: (database: SQLite, temporary: string) => void | Promise<void>
  beforeRename?: () => void
  afterRename?: () => void
  afterAuditSession?: () => void
  beforeDropCommit?: () => void
  afterDrop?: () => void
  now?: () => number
}

/** Only called before the engine opens its databases. Runs in a bounded, disposable process. */
export async function removeImportedLegacyTables(input: CleanupInput, ports: Ports = {}) {
  if (input.engineDatabase === ":memory:" || !existsSync(input.engineDatabase)) return
  using lease = databaseLease(input.engineDatabase, true)
  const temporary = `${input.engineDatabase}.vacuum-into.tmp`
  if (lease) rmSync(temporary, { force: true })
  if (!lease || (await databaseHasHolders(input.engineDatabase))) {
    console.warn("[arena-upgrade] Cleanup deferred: another database holder or exclusion unavailable")
    return
  }
  using database = new SQLite(input.engineDatabase, { readwrite: true })
  database.run("PRAGMA busy_timeout = 1000")
  const has = (name: string) => database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  if (!has("kv")) return
  const get = <T>(key: string): T | undefined => {
    const row = database.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key=?").get(key)
    return row ? JSON.parse(row.value) : undefined
  }
  const now = ports.now ?? Date.now
  const expired = (reserve = 0) => now() + reserve >= (input.deadline ?? Infinity)
  const save = (state: State) =>
    database
      .query(
        `
    INSERT INTO kv (key,value,time_created,time_updated) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated
  `,
      )
      .run(KEY, JSON.stringify(state), now(), now())
  const count = (query: string) => database.query<{ n: number }, []>(query).get()!.n
  const state = get<State>(KEY)
  if (state?.phase === "done") return
  if (state?.phase !== "vacuum" && (!has(FENCE) || get<{ phase: string }>("migration.v1-v2")?.phase !== "completed"))
    return
  if (state?.phase === "vacuum" && (state.retryAfter ?? 0) > now()) return
  console.log("[arena-upgrade] Removing imported OpenCode 1.x tables")
  const checkpoint = database.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
  if (checkpoint?.busy) return
  database.run("PRAGMA journal_mode=DELETE")
  database.run("PRAGMA locking_mode=EXCLUSIVE")
  database.run("BEGIN EXCLUSIVE; COMMIT")
  if (state?.phase !== "vacuum") {
    // Never remove source tables ahead of a schema migration that might still read them.
    const applied = new Set(
      database
        .query<{ id: string }, []>("SELECT id FROM migration")
        .all()
        .map((row) => row.id),
    )
    if (migrations.some((migration) => !applied.has(migration.id))) return
    if (!has("message") || !has("part") || !has("session_v2")) return
    // An audit may span starts. If V2 changed while the app was running between them, audit again:
    // an earlier match must not authorize dropping a message or session that has since disappeared.
    const fingerprint = new Bun.CryptoHasher("sha256")
    for (const row of database
      .query<{ id: string; time_updated: number }, []>("SELECT id,time_updated FROM session_v2 ORDER BY id")
      .iterate()) {
      if (expired()) return
      fingerprint.update(JSON.stringify(row))
    }
    for (const row of database
      .query<
        { id: string; session_id: string; time_updated: number },
        []
      >("SELECT id,session_id,time_updated FROM session_message ORDER BY id")
      .iterate()) {
      if (expired()) return
      fingerprint.update(JSON.stringify(row))
    }
    const targetFingerprint = fingerprint.digest("hex")
    const audit: Audit =
      state?.phase === "audit" && state.targetFingerprint === targetFingerprint
        ? state
        : {
            phase: "audit",
            sessions: 0,
            messages: 0,
            parts: 0,
            skipped: 0,
            expectedMessages: 0,
            importedMessages: 0,
            targetFingerprint,
          }
    // The fence makes the sources immutable to the active engine. Commit each audited session so
    // a slow earlier-build audit can continue at another start without keeping any transcript data.
    while (true) {
      if (expired(5_000)) return
      const session = database
        .query<{ id: string }, [string]>(`SELECT id FROM ${FENCE} WHERE id > ? ORDER BY id LIMIT 1`)
        .get(audit.cursor ?? "")
      if (!session) break
      const messages = database
        .query<V1Migration.SourceMessage, [string]>("SELECT * FROM message WHERE session_id=?")
        .all(session.id)
      const parts = database
        .query<V1Migration.SourcePart, [string]>("SELECT * FROM part WHERE session_id=?")
        .all(session.id)
      type Target = Omit<V1Migration.TransformInput["session"], "model"> & { model: string | null }
      const target = database.query<Target, [string]>("SELECT * FROM session_v2 WHERE id=?").get(session.id)
      const deleted =
        !target &&
        database
          .query(
            `SELECT 1 FROM ${FENCE} source
        WHERE source.id=? AND ${V1Migration.DELETION_EVIDENCE_SQL}`,
          )
          .get(session.id)
      if (deleted) {
        console.log(`[arena-upgrade] Audit accepted durable session deletion: ${session.id}`)
        audit.skipped += V1Migration.countSkippedRows({ session, messages, parts })
      } else if (target) {
        const transformed = V1Migration.transformSession({
          session: { ...target, model: target.model ? JSON.parse(target.model) : null },
          messages,
          parts,
        })
        audit.skipped += transformed.warnings.length
        const imported = database.query("SELECT 1 FROM session_message WHERE id=? AND session_id=?")
        audit.expectedMessages += transformed.messages.length
        audit.importedMessages += transformed.messages.filter((row) => imported.get(row.id, session.id)).length
      } else {
        // Decode even a missing session's rows; completion must never hide a skipped-row count.
        audit.skipped += V1Migration.countSkippedRows({ session, messages, parts })
      }
      audit.sessions++
      audit.messages += messages.length
      audit.parts += parts.length
      audit.cursor = session.id
      save(audit)
      ports.afterAuditSession?.()
    }
    const sessions = count(`SELECT count(*) n FROM ${FENCE}`)
    const imported = count(`SELECT count(*) n FROM ${FENCE} source WHERE
      EXISTS (SELECT 1 FROM session_v2 WHERE id=source.id) OR ${V1Migration.DELETION_EVIDENCE_SQL}`)
    const messages = count("SELECT count(*) n FROM message")
    const parts = count("SELECT count(*) n FROM part")
    const importSkipped = get<number>("migration.v1-v2.skipped") ?? 0
    // Includes orphan rows that no session's import could visit. Counts are of source rows, since
    // compactions, synthetic messages and tool parts deliberately do not map one-to-one to V2 rows.
    const skipped =
      Math.max(audit.skipped, importSkipped) + Math.max(0, messages - audit.messages) + Math.max(0, parts - audit.parts)
    save({ ...audit, skippedTotal: skipped })
    if (
      skipped ||
      sessions !== imported ||
      sessions !== audit.sessions ||
      messages !== audit.messages ||
      parts !== audit.parts ||
      audit.expectedMessages !== audit.importedMessages
    ) {
      console.warn(
        `[arena-upgrade] Keeping old tables: ${JSON.stringify({
          sessions,
          imported,
          messages,
          parts,
          skipped,
          auditedSessions: audit.sessions,
          auditedMessages: audit.messages,
          auditedParts: audit.parts,
          expectedMessages: audit.expectedMessages,
          importedMessages: audit.importedMessages,
        })}`,
      )
      return
    }
    // todo and session_share are not imported. Preserve their rows and indexes, rebinding their
    // parent to V2; DROP TABLE with foreign_keys enabled would silently cascade those rows away.
    const tables = database
      .query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all()
    const droppedTables = [FENCE, "message", "part"]
    const retained = tables
      .filter((table) => !droppedTables.includes(table.name))
      .map((table) => ({
        ...table,
        parents: database
          .query<{ parent: string }, [string]>('SELECT "table" AS parent FROM pragma_foreign_key_list(?)')
          .all(table.name)
          .map((row) => row.parent)
          .filter((parent) => droppedTables.includes(parent)),
      }))
      .filter((table) => table.parents.length > 0)
    if (
      retained.some(
        (table) => !["todo", "session_share"].includes(table.name) || table.parents.some((parent) => parent !== FENCE),
      )
    ) {
      console.warn("[arena-upgrade] Keeping old tables: unknown legacy foreign key")
      return
    }
    if (expired(5_000)) return
    database.run("PRAGMA foreign_keys=OFF")
    database
      .transaction(() => {
        for (const table of retained) {
          const dependents = database
            .query<
              { sql: string },
              [string]
            >("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name=? AND sql IS NOT NULL")
            .all(table.name)
          const temporary = `_arena_keep_${table.name}`
          const ddl = table.sql
            .replace(/^CREATE TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `CREATE TABLE "${temporary}"`)
            .replaceAll(FENCE, "session_v2")
          database.run(ddl)
          // A proven session deletion also removes its old tasks/share records. Rebinding those
          // orphaned rows to V2 would otherwise keep cleanup blocked forever after an intentional delete.
          database.run(`INSERT INTO "${temporary}" SELECT * FROM "${table.name}" child
            WHERE NOT EXISTS (SELECT 1 FROM ${FENCE} source WHERE source.id=child.session_id
              AND NOT EXISTS (SELECT 1 FROM session_v2 WHERE id=source.id)
              AND ${V1Migration.DELETION_EVIDENCE_SQL})`)
          database.run(`DROP TABLE "${table.name}"`)
          database.run(`ALTER TABLE "${temporary}" RENAME TO "${table.name}"`)
          for (const dependent of dependents) database.run(dependent.sql)
          if (database.query(`PRAGMA foreign_key_check("${table.name}")`).get()) {
            throw new Error("Retained legacy rows have no V2 parent")
          }
        }
        database.run(`DROP TABLE part; DROP TABLE message; DROP TABLE ${FENCE}`)
        save({ phase: "vacuum" })
        ports.beforeDropCommit?.()
      })
      .immediate()
    database.run("PRAGMA foreign_keys=ON")
    ports.afterDrop?.()
  }
  const copyMs = state?.phase === "vacuum" ? state.copyMs : undefined
  const copyReserve = Math.min(6 * 60_000, Math.max(MIN_COPY_MS, (copyMs ?? 0) * 2)) + 10_000
  if (expired(copyReserve)) {
    console.log("[arena-upgrade] VACUUM INTO deferred: insufficient startup time remains")
    return
  }
  // Checkpoint before estimating and copying. The exclusive rollback lock prevents writers during
  // the copy; the process lease and holder checks also cover idle connections and the close/rename gap.
  const pageSize = count("SELECT page_size n FROM pragma_page_size")
  const pages = count("SELECT page_count n FROM pragma_page_count")
  const needed = (pages - count("SELECT freelist_count n FROM pragma_freelist_count")) * pageSize
  const required = needed + HEADROOM
  const available = await (ports.availableBytes?.(required) ??
    statfs(dirname(input.engineDatabase)).then((s) => s.bavail * s.bsize))
  if (available < required) {
    console.warn(
      `[arena-upgrade] VACUUM INTO deferred: available=${available} required=${required} (one compacted copy plus headroom)`,
    )
    return
  }
  const sessions = count("SELECT count(*) n FROM session_v2")
  const messages = count("SELECT count(*) n FROM session_message")
  if (expired(copyReserve)) return
  let closed = false
  const started = now()
  // Save before the copy so a kill also limits retries. A timed-out attempt records the whole
  // remaining allocation, making its next estimate conservative.
  const allocation = input.deadline === undefined ? MIN_COPY_MS : Math.max(0, input.deadline - started)
  save({ phase: "vacuum", retryAfter: now() + RETRY_MS, copyMs: allocation })
  try {
    if (ports.vacuum) await ports.vacuum(database, temporary)
    else database.query("VACUUM INTO ?").run(temporary)
    chmodSync(temporary, 0o600)
    {
      using copy = new SQLite(temporary, { readwrite: true })
      const n = (sql: string) => copy.query<{ n: number }, []>(sql).get()!.n
      const copiedPages = n("SELECT page_count n FROM pragma_page_count")
      if (
        n("SELECT count(*) n FROM session_v2") !== sessions ||
        n("SELECT count(*) n FROM session_message") !== messages ||
        copiedPages <= 0 ||
        copiedPages > pages ||
        n("SELECT page_size n FROM pragma_page_size") !== pageSize ||
        Bun.file(temporary).size !== copiedPages * pageSize
      )
        throw new Error("Copy validation failed")
      // Publish completion in the copy: a kill after rename cannot trigger another copy.
      copy.query("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ phase: "done" }), KEY)
    }
    // Windows flushes only a writable handle.
    const sync = (file: string) => {
      const fd = openSync(file, process.platform === "win32" ? "r+" : "r")
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    // Windows cannot open a directory to flush it; NTFS journals the rename itself.
    const syncDirectory = (directory: string) => process.platform !== "win32" && sync(directory)
    sync(temporary)
    syncDirectory(dirname(temporary))
    database.close()
    closed = true
    if (expired(5_000) || (await databaseHasHolders(input.engineDatabase))) {
      console.warn("[arena-upgrade] VACUUM INTO swap deferred: time exhausted or another database holder")
      return
    }
    // Remove sidecars BEFORE rename. A kill after rename must never replay the old WAL on the copy.
    rmSync(`${input.engineDatabase}-wal`, { force: true })
    rmSync(`${input.engineDatabase}-shm`, { force: true })
    syncDirectory(dirname(temporary))
    ports.beforeRename?.()
    renameSync(temporary, input.engineDatabase)
    ports.afterRename?.()
    syncDirectory(dirname(input.engineDatabase))
    console.log("[arena-upgrade] Removed imported 1.x tables and reclaimed database space")
  } catch (error) {
    if (!closed) save({ phase: "vacuum", retryAfter: now() + RETRY_MS, copyMs: now() - started })
    console.warn(`[arena-upgrade] VACUUM INTO failed; startup continues and a later start will retry: ${error}`)
  } finally {
    rmSync(temporary, { force: true })
  }
}
