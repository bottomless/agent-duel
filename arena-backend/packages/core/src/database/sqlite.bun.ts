import { Database } from "bun:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

// Agent Duel vendor patch. When several processes open a new database at once on Windows, the switch
// to WAL can fail with SQLITE_IOERR_TRUNCATE while another process has the -shm file open, and the
// client retries only SQLITE_BUSY and SQLITE_LOCKED. WAL mode is stored in the file, so switch it here
// first with a retry; the client's own switch then finds it done.
const walRetryCodes = new Set(["SQLITE_BUSY", "SQLITE_IOERR_TRUNCATE"])

function prepareWindowsWal(config: SqliteClient.SqliteClientConfig) {
  if (process.platform !== "win32") return
  if (config.disableWAL === true || config.readonly === true || config.filename === ":memory:") return
  const native = new Database(config.filename, { readwrite: true, create: config.create ?? true })
  try {
    native.run("PRAGMA busy_timeout = 5000;")
    for (let attempt = 1; ; attempt++) {
      try {
        native.run("PRAGMA journal_mode = WAL;")
        return
      } catch (error) {
        if (attempt === 50 || !walRetryCodes.has((error as { code?: string }).code ?? "")) throw error
        Bun.sleepSync(20)
      }
    }
  } finally {
    native.close()
  }
}

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(
    Layer.unwrap(
      Effect.sync(() => {
        prepareWindowsWal(config)
        return SqliteClient.layer(config)
      }),
    ),
  )
