import { Database as SQLite } from "bun:sqlite"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdir, readlink, realpath, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Global } from "@opencode/util/global"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"

/** Holds the databases as 1.x left them; see the accidental-1.x guard in docs/arena.md. */
export const BACKUP_DIRECTORY = "pre-opencode-2-backup"
export const BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The name the 1.x `session` table takes once its rows are in `session_v2`. A released 1.x engine
 * has no version check, but it stops with "Database is not empty and has no session table" when
 * that table is gone. 2.0 reads the table only during the V1 import, and its bootstrap ignores
 * underscore-prefixed tables.
 */
export const FENCED_SESSION_TABLE = "_arena_v1_session"

export function arenaDirectory() {
  return join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "arena")
}

export function engineDatabaseFilename() {
  const channel = "local"
  return (
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(channel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel}.db`)
  )
}

type ImportState = "not-started" | "started" | "done"

async function canonicalPath(filename: string): Promise<string> {
  return realpath(filename).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || dirname(filename) === filename) throw error
    const entry = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (entry?.isSymbolicLink()) return canonicalPath(resolve(dirname(filename), await readlink(filename)))
    return canonicalPath(dirname(filename)).then((parent) => join(parent, basename(filename)))
  })
}

async function verifyDatabaseOwnership(engineDatabase: string, arena: string) {
  if (engineDatabase === ":memory:") return
  const home = resolve(dirname(arena))
  const database = await canonicalPath(resolve(engineDatabase))
  const file = await stat(database).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  const within = relative(await canonicalPath(home), database)
  if (file?.nlink !== undefined && file.nlink > 1) {
    throw new Error(
      `Engine database ${engineDatabase} does not belong to PASEO_HOME ${home}: it has multiple hard links.`,
    )
  }
  if (within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)) return
  // Only the default home may upgrade the packaged 1.x location. An XDG override alone cannot
  // prove ownership for another home; require that home's engine database to live inside it.
  if (
    home === join(homedir(), ".paseo") &&
    resolve(engineDatabase) === join(homedir(), ".local", "share", "opencode", basename(engineDatabase))
  )
    return
  throw new Error(
    `Engine database ${engineDatabase} does not belong to PASEO_HOME ${home}. Set XDG_DATA_HOME inside that home before starting Arena.`,
  )
}

function v1ImportState(filename: string): ImportState {
  // WAL databases may need SQLite to recreate missing sidecars even for a read.
  using database = new SQLite(filename, { readwrite: true })
  const hasTable = (name: string) =>
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  if (!hasTable("session")) return "done"
  // The kv table arrives with the 2.0 migrations, so without it the file is as 1.x wrote it.
  if (!hasTable("kv")) return "not-started"
  const state = database.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()
  return state && (JSON.parse(state.value) as { phase?: string }).phase === "completed" ? "done" : "started"
}

async function copyDatabase(source: string, target: string) {
  // VACUUM INTO reads through the WAL, so the copy holds the committed state in one file.
  using database = new SQLite(source, { readwrite: true })
  database.query("VACUUM INTO ?").run(target)
  await chmod(target, 0o600)
}

/**
 * Copies the engine database and arena.sqlite before the first 2.0 engine imports the 1.x rows.
 * Runs before the engine opens either file. A failed backup stops an unfinished import so an
 * accidental old build cannot require discarding the only pre-upgrade copy.
 */
export async function backUpBeforeUpgrade(input: {
  readonly engineDatabase: string
  readonly arenaDirectory: string
  readonly now?: number
}) {
  await verifyDatabaseOwnership(input.engineDatabase, input.arenaDirectory)
  const directory = join(input.arenaDirectory, BACKUP_DIRECTORY)
  const temporary = `${directory}.tmp`
  const state =
    input.engineDatabase === ":memory:" || !existsSync(input.engineDatabase)
      ? "done"
      : v1ImportState(input.engineDatabase)
  await rm(temporary, { recursive: true, force: true }).catch((error) => {
    if (state !== "done") throw error
    console.warn(`[arena-upgrade] Could not remove the partial backup at ${temporary}: ${error}`)
  })
  let existing = await stat(directory).catch(() => undefined)
  if (existing && (input.now ?? Date.now()) - existing.mtimeMs >= BACKUP_RETENTION_MS) {
    try {
      await rm(directory, { recursive: true, force: true })
      existing = undefined
      console.log(`[arena-upgrade] Removed the backup from before OpenCode 2.0: ${directory}`)
    } catch (error) {
      console.warn(`[arena-upgrade] Could not remove the expired backup at ${directory}: ${error}`)
    }
  }
  if (state === "done") return
  // A resumed import keeps the first copy. A file with no 2.0 tables was restored and then used on
  // 1.x, so its copy replaces the old one.
  if (state === "started" && existing) return
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  try {
    console.log("[arena-upgrade] Backing up databases before OpenCode 2.0")
    await copyDatabase(input.engineDatabase, join(temporary, basename(input.engineDatabase)))
    const arenaDatabase = join(input.arenaDirectory, "arena.sqlite")
    if (existsSync(arenaDatabase)) await copyDatabase(arenaDatabase, join(temporary, "arena.sqlite"))
    await rm(directory, { recursive: true, force: true })
    await rename(temporary, directory)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log(`[arena-upgrade] Backed up the 1.x databases to ${directory}`)
}

export async function backUpEngineDatabases() {
  const filename = engineDatabaseFilename()
  await backUpBeforeUpgrade({
    engineDatabase: filename === ":memory:" || isAbsolute(filename) ? filename : join(Global.Path.data, filename),
    arenaDirectory: arenaDirectory(),
  })
}

/** Waits for the V1 import, whichever fiber runs it, then makes the database refuse a 1.x engine. */
export const fenceLegacyEngines = Effect.gen(function* () {
  yield* V1Migration.run()
  const { db } = yield* Database.Service
  const legacy = yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)
  if (!legacy) return
  yield* db.run(sql`ALTER TABLE ${sql.identifier("session")} RENAME TO ${sql.identifier(FENCED_SESSION_TABLE)}`)
  yield* Effect.logInfo("database fenced against 1.x engines")
})

export const fenceLegacyEnginesLayer = Layer.effectDiscard(
  fenceLegacyEngines.pipe(
    Effect.catchCause((cause) => Effect.logError("could not fence the database against 1.x engines", { cause })),
    Effect.forkScoped({ startImmediately: true }),
  ),
)
