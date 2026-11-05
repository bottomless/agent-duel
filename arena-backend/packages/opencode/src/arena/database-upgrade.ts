import { Database as SQLite } from "bun:sqlite"
import { existsSync } from "node:fs"
import { lstat, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { removeImportedLegacyTables, type CleanupInput } from "./database-cleanup"
import { engineDatabaseLease } from "./database-lease"
import { Global } from "@opencode/util/global"
import { sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer, Option } from "effect"

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

export async function verifyDatabaseOwnership(engineDatabase: string, arena: string) {
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

/** Cheap preflight only: no schema migrations, transcript scans, or Arena store opens here. */
export async function prepareDatabaseUpgrade(
  input: { readonly engineDatabase: string; readonly arenaDirectory: string },
  log: (line: string) => void = console.log,
) {
  await verifyDatabaseOwnership(input.engineDatabase, input.arenaDirectory)
  if (input.engineDatabase === ":memory:" || !existsSync(input.engineDatabase)) return false
  using lease = await engineDatabaseLease(input.engineDatabase)
  // WAL databases may need SQLite to recreate missing sidecars even for a read.
  using database = new SQLite(input.engineDatabase, { readwrite: true })
  const has = (name: string) =>
    database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null
  const legacy = has("session")
  const fenced = has(FENCED_SESSION_TABLE)
  if (!has("kv")) {
    if (legacy || fenced) log("[arena-upgrade] Importing OpenCode 1.x chats")
    return legacy || fenced ? "import" : false
  }
  const get = (key: string): { phase?: string; retryAfter?: number } | undefined => {
    const row = database.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key=?").get(key)
    return row ? JSON.parse(row.value) : undefined
  }
  if (
    ((legacy || fenced) && get("migration.v1-v2")?.phase !== "completed") ||
    (legacy && !fenced && get("arena.v1-cleanup")?.phase !== "done")
  ) {
    log("[arena-upgrade] Importing OpenCode 1.x chats")
    return "import"
  }
  const cleanup = get("arena.v1-cleanup")
  const pending = cleanup?.phase !== "done" && (fenced || cleanup?.phase === "vacuum")
  // A kill after publication can leave the compacted temporary filename behind. Maintenance
  // removes it even when the completed marker or retry delay otherwise makes this start idle.
  if (!pending || (cleanup?.retryAfter ?? 0) > Date.now()) return existsSync(`${input.engineDatabase}.vacuum-into.tmp`)
  log("[arena-upgrade] Removing imported OpenCode 1.x tables")
  return true
}

// Cleanup and import waiting share the spawn budget, leaving two minutes to finish startup.
const UPGRADE_DEADLINE = Date.now() - process.uptime() * 1000 + 8 * 60_000
let engineLease: Awaited<ReturnType<typeof engineDatabaseLease>>

export async function prepareEngineDatabases() {
  const filename = engineDatabaseFilename()
  const input = {
    engineDatabase: filename === ":memory:" || isAbsolute(filename) ? filename : join(Global.Path.data, filename),
    arenaDirectory: arenaDirectory(),
  }
  await prepareDatabaseMaintenance(input)
  // Keep the shared lease until process exit, before any runtime connection opens.
  engineLease = input.engineDatabase === ":memory:" ? undefined : await engineDatabaseLease(input.engineDatabase)
}

/** All maintenance finishes (and closes SQLite) before the runtime acquires its shared lease. */
export async function prepareDatabaseMaintenance(input: CleanupInput, maintenance = runDatabaseMaintenance) {
  const action = await prepareDatabaseUpgrade(input)
  if (!action) return
  const bounded = { ...input, deadline: Math.min(input.deadline ?? UPGRADE_DEADLINE, UPGRADE_DEADLINE) }
  if (action === "import" && !(await maintenance(bounded, "import"))) return
  await maintenance(bounded, "cleanup")
}

/** The child owns the only import connection; exiting releases it before any inode swap. */
export async function importLegacyDatabase(input: CleanupInput, acquireLease = engineDatabaseLease) {
  await verifyDatabaseOwnership(input.engineDatabase, input.arenaDirectory)
  using lease = await acquireLease(input.engineDatabase)
  await Effect.runPromise(
    fenceLegacyEngines.pipe(
      Effect.provide(Database.layer({ path: input.engineDatabase })),
      Effect.provideService(Global.Service, Global.make({ data: dirname(input.engineDatabase) })),
      Effect.scoped,
    ),
  )
}

/** Bound synchronous SQLite work without blocking the engine's main thread or killing its startup. */
export async function runDatabaseMaintenance(input: CleanupInput, step: "import" | "cleanup") {
  if (input.engineDatabase === ":memory:" || !existsSync(input.engineDatabase)) return false
  const deadline = Math.min(input.deadline ?? UPGRADE_DEADLINE, UPGRADE_DEADLINE)
  if (deadline <= Date.now()) return false
  const label = step === "import" ? "Import" : "Cleanup"
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        ...(Bun.main.endsWith(".ts") ? ["--no-env-file", fileURLToPath(new URL("../index.ts", import.meta.url))] : []),
        `--arena-database-${step}`,
      ],
      { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    try {
      child.stdin.write(JSON.stringify({ ...input, deadline }))
      child.stdin.end()
      timer = setTimeout(
        () => {
          expired = true
          console.warn(
            `[arena-upgrade] ${label} startup budget exhausted; startup continues${step === "import" ? " with import in the background" : ""}`,
          )
          child.kill("SIGKILL")
        },
        Math.max(0, deadline - Date.now()),
      )
      const code = await child.exited
      if (code !== 0 && !expired)
        console.warn(`[arena-upgrade] ${label} interrupted; startup continues and a later start will resume`)
      return code === 0 && !expired
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  } catch {
    console.warn(`[arena-upgrade] Could not run ${step} maintenance; startup continues`)
    return false
  }
}

export async function finishLegacyCleanup(input: CleanupInput, timeoutMs = Math.max(0, UPGRADE_DEADLINE - Date.now())) {
  await runDatabaseMaintenance(
    { ...input, deadline: Math.min(input.deadline ?? UPGRADE_DEADLINE, Date.now() + timeoutMs) },
    "cleanup",
  )
}

export { removeImportedLegacyTables }

/** Waits for the V1 import, whichever fiber runs it, then makes the database refuse a 1.x engine. */
export const fenceLegacyEngines = Effect.gen(function* () {
  yield* V1Migration.run()
  const { db } = yield* Database.Service
  const legacy = yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)
  if (!legacy) return
  yield* db.run(sql`ALTER TABLE ${sql.identifier("session")} RENAME TO ${sql.identifier(FENCED_SESSION_TABLE)}`)
  yield* Effect.logInfo("database fenced against 1.x engines")
})

/** Timeout only the join: the scoped import keeps its cursor and continues after readiness. */
export function waitForLegacyImport(
  options: {
    readonly deadline?: number
    readonly log?: (line: string) => void
  } = {},
) {
  return Effect.gen(function* () {
    const status = yield* V1Migration.status()
    const fence = fenceLegacyEngines.pipe(
      Effect.catchCause((cause) => Effect.logError("could not fence the database against 1.x engines", { cause })),
    )
    if (status.status === "completed") {
      yield* fence
      return
    }
    const log = options.log ?? console.log
    log("[arena-upgrade] Importing OpenCode 1.x chats")
    let background = false
    let ended: "finished" | "failed" | undefined
    const fiber = yield* fenceLegacyEngines.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          ended = Exit.isSuccess(exit) ? "finished" : "failed"
          if (background) log(`[arena-upgrade] Background import ${ended}`)
        }),
      ),
      Effect.catchCause((cause) => Effect.logError("could not fence the database against 1.x engines", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
    const remaining = Math.max(0, Math.min(options.deadline ?? UPGRADE_DEADLINE, UPGRADE_DEADLINE) - Date.now())
    const result = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(remaining))
    if (Option.isNone(result)) {
      background = true
      log("[arena-upgrade] Import startup budget exhausted; startup continues with import in the background")
      // The fiber can finish as its timed join expires. Publish the end after the fallback in that case.
      if (ended) log(`[arena-upgrade] Background import ${ended}`)
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("could not wait for the database import; startup continues", { cause }),
    ),
  )
}

export const fenceLegacyEnginesLayer = Layer.effectDiscard(waitForLegacyImport())
