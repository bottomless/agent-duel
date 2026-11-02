import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BACKUP_DIRECTORY,
  BACKUP_RETENTION_MS,
  FENCED_SESSION_TABLE,
  backUpBeforeUpgrade,
  backUpEngineDatabases,
  fenceLegacyEngines,
} from "@/arena/database-upgrade"

const roots: string[] = []

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-database-upgrade-"))
  roots.push(root)
  const arenaDirectory = path.join(root, "arena")
  await mkdir(arenaDirectory)
  return { root, arenaDirectory, engineDatabase: path.join(root, "opencode-local.db") }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function write(filename: string, statements: string) {
  using database = new SQLite(filename)
  database.run("PRAGMA journal_mode = WAL")
  database.run(statements)
}

function read<T>(filename: string, query: string) {
  using database = new SQLite(filename, { readonly: true })
  return database.query<T, []>(query).all()
}

const legacySessions = (ids: string) => `
  CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY);
  INSERT INTO session VALUES ${ids};
`
const sessionIDs = (filename: string) => read<{ id: string }>(filename, "SELECT id FROM session").map((row) => row.id)

describe("backUpBeforeUpgrade", () => {
  test("the engine entrypoint refuses shared XDG data for a custom PASEO_HOME", async () => {
    const other = await workspace()
    const previousHome = process.env.PASEO_HOME
    const previousDatabase = process.env.OPENCODE_DB
    const filename = "r71-shared.db"
    const shared = path.join(Global.Path.data, filename)
    await mkdir(Global.Path.data, { recursive: true })
    write(shared, legacySessions("('shared')"))
    const before = await Bun.file(shared).arrayBuffer()
    try {
      process.env.PASEO_HOME = other.root
      process.env.OPENCODE_DB = filename
      await expect(backUpEngineDatabases()).rejects.toThrow("does not belong to PASEO_HOME")
      expect(await Bun.file(shared).arrayBuffer()).toEqual(before)
      expect(existsSync(path.join(other.arenaDirectory, BACKUP_DIRECTORY))).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.PASEO_HOME
      else process.env.PASEO_HOME = previousHome
      if (previousDatabase === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = previousDatabase
      await rm(shared, { force: true })
      await rm(`${shared}-wal`, { force: true })
      await rm(`${shared}-shm`, { force: true })
    }
  })

  test("refuses another home's engine database before changing either home", async () => {
    const owner = await workspace()
    const other = await workspace()
    write(owner.engineDatabase, legacySessions("('owned-by-A')"))
    write(path.join(owner.arenaDirectory, "arena.sqlite"), "CREATE TABLE turns (id TEXT);")
    const before = await Bun.file(owner.engineDatabase).arrayBuffer()
    const partial = path.join(other.arenaDirectory, `${BACKUP_DIRECTORY}.tmp`, "partial.db")
    await Bun.write(partial, "do not clean another home's backup")

    await expect(
      backUpBeforeUpgrade({
        engineDatabase: owner.engineDatabase,
        arenaDirectory: other.arenaDirectory,
      }),
    ).rejects.toThrow("does not belong to PASEO_HOME")

    expect(await Bun.file(owner.engineDatabase).arrayBuffer()).toEqual(before)
    expect(sessionIDs(owner.engineDatabase)).toEqual(["owned-by-A"])
    expect(await Bun.file(partial).text()).toBe("do not clean another home's backup")
    expect(existsSync(path.join(other.arenaDirectory, BACKUP_DIRECTORY))).toBe(false)
    await backUpBeforeUpgrade(owner)
    expect(sessionIDs(path.join(owner.arenaDirectory, BACKUP_DIRECTORY, "opencode-local.db"))).toEqual(["owned-by-A"])
    expect(read(path.join(owner.arenaDirectory, BACKUP_DIRECTORY, "arena.sqlite"), "SELECT id FROM turns")).toEqual([])
  })

  test("refuses a symlink from one home to another home's engine database", async () => {
    const owner = await workspace()
    const other = await workspace()
    write(owner.engineDatabase, legacySessions("('owned-by-A')"))
    await symlink(owner.engineDatabase, other.engineDatabase)
    await expect(backUpBeforeUpgrade(other)).rejects.toThrow("does not belong to PASEO_HOME")
    expect(sessionIDs(owner.engineDatabase)).toEqual(["owned-by-A"])
  })

  test("refuses an outside path for a new engine database without creating it", async () => {
    const owner = await workspace()
    const other = await workspace()
    await expect(
      backUpBeforeUpgrade({
        engineDatabase: owner.engineDatabase,
        arenaDirectory: other.arenaDirectory,
      }),
    ).rejects.toThrow("does not belong to PASEO_HOME")
    expect(existsSync(owner.engineDatabase)).toBe(false)
  })

  test("refuses a dangling symlink and a hard link into another home", async () => {
    const owner = await workspace()
    const other = await workspace()
    await symlink(owner.engineDatabase, other.engineDatabase)
    await expect(backUpBeforeUpgrade(other)).rejects.toThrow("does not belong to PASEO_HOME")
    expect(existsSync(owner.engineDatabase)).toBe(false)
    await rm(other.engineDatabase)
    write(owner.engineDatabase, legacySessions("('owned-by-A')"))
    await link(owner.engineDatabase, other.engineDatabase)
    await expect(backUpBeforeUpgrade(other)).rejects.toThrow("does not belong to PASEO_HOME")
    expect(sessionIDs(owner.engineDatabase)).toEqual(["owned-by-A"])
  })

  test("opens healthy WAL databases without sidecars, before and after import", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    const arenaDatabase = path.join(arenaDirectory, "arena.sqlite")
    write(engineDatabase, legacySessions("('one')"))
    write(arenaDatabase, "CREATE TABLE arena_documents (id TEXT); INSERT INTO arena_documents VALUES ('turn');")
    for (const file of [engineDatabase, arenaDatabase]) {
      await rm(`${file}-wal`, { force: true })
      await rm(`${file}-shm`, { force: true })
    }

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
    const backup = path.join(arenaDirectory, BACKUP_DIRECTORY)
    expect(sessionIDs(path.join(backup, "opencode-local.db"))).toEqual(["one"])
    expect(read(path.join(backup, "arena.sqlite"), "SELECT id FROM arena_documents")).toEqual([{ id: "turn" }])

    write(engineDatabase, `ALTER TABLE session RENAME TO ${FENCED_SESSION_TABLE};`)
    await rm(`${engineDatabase}-wal`, { force: true })
    await rm(`${engineDatabase}-shm`, { force: true })
    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
    expect(sessionIDs(path.join(backup, "opencode-local.db"))).toEqual(["one"])
  })

  test("copies a 1.x engine database and arena.sqlite, with rows that are still in the WAL", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(
      path.join(arenaDirectory, "arena.sqlite"),
      "CREATE TABLE arena_documents (id TEXT); INSERT INTO arena_documents VALUES ('turn');",
    )
    using open = new SQLite(engineDatabase)
    open.run("PRAGMA journal_mode = WAL")
    open.run(legacySessions("('one'), ('two')"))
    expect(existsSync(`${engineDatabase}-wal`)).toBe(true)

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })

    const backup = path.join(arenaDirectory, BACKUP_DIRECTORY)
    expect(sessionIDs(path.join(backup, "opencode-local.db")).sort()).toEqual(["one", "two"])
    expect(read(path.join(backup, "arena.sqlite"), "SELECT id FROM arena_documents")).toEqual([{ id: "turn" }])
    expect(read(path.join(backup, "opencode-local.db"), "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
    expect((await stat(path.join(backup, "opencode-local.db"))).mode & 0o777).toBe(0o600)
    expect(existsSync(`${backup}.tmp`)).toBe(false)
  })

  test("makes no backup for a missing, new, or imported database", async () => {
    const missing = await workspace()
    await backUpBeforeUpgrade(missing)
    expect(existsSync(path.join(missing.arenaDirectory, BACKUP_DIRECTORY))).toBe(false)

    const created = await workspace()
    write(created.engineDatabase, "CREATE TABLE session_v2 (id TEXT PRIMARY KEY);")
    await backUpBeforeUpgrade(created)
    expect(existsSync(path.join(created.arenaDirectory, BACKUP_DIRECTORY))).toBe(false)

    const imported = await workspace()
    write(
      imported.engineDatabase,
      `CREATE TABLE session (id TEXT PRIMARY KEY);
       CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
       INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"completed"}');`,
    )
    await backUpBeforeUpgrade(imported)
    expect(existsSync(path.join(imported.arenaDirectory, BACKUP_DIRECTORY))).toBe(false)
  })

  test("keeps the first copy when an interrupted import resumes", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(engineDatabase, legacySessions("('before')"))
    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
    write(
      engineDatabase,
      `INSERT INTO session VALUES ('during');
       CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
       INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"sessions"}');`,
    )

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })

    expect(sessionIDs(path.join(arenaDirectory, BACKUP_DIRECTORY, "opencode-local.db"))).toEqual(["before"])
  })

  test("replaces the copy when a restored database comes back with new 1.x work", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(engineDatabase, legacySessions("('before')"))
    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
    write(engineDatabase, legacySessions("('after-restore')"))

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })

    expect(sessionIDs(path.join(arenaDirectory, BACKUP_DIRECTORY, "opencode-local.db")).sort()).toEqual([
      "after-restore",
      "before",
    ])
  })

  test("removes the backup at the first start after the retention period", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(engineDatabase, "CREATE TABLE session_v2 (id TEXT PRIMARY KEY);")
    const backup = path.join(arenaDirectory, BACKUP_DIRECTORY)
    await mkdir(backup)
    const created = (await stat(backup)).mtimeMs

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory, now: created + BACKUP_RETENTION_MS - 1000 })
    expect(existsSync(backup)).toBe(true)

    await backUpBeforeUpgrade({ engineDatabase, arenaDirectory, now: created + BACKUP_RETENTION_MS + 1000 })
    expect(existsSync(backup)).toBe(false)
  })

  test("reports a failed copy and removes the partial folder", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(engineDatabase, legacySessions("('one')"))
    await Bun.write(path.join(arenaDirectory, "arena.sqlite"), "this is not a database, and it is long enough")

    await expect(backUpBeforeUpgrade({ engineDatabase, arenaDirectory })).rejects.toThrow()

    expect(existsSync(path.join(arenaDirectory, BACKUP_DIRECTORY))).toBe(false)
    expect(existsSync(path.join(arenaDirectory, `${BACKUP_DIRECTORY}.tmp`))).toBe(false)
  })

  test("starts an imported database when the expired backup cannot be removed", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(engineDatabase, "CREATE TABLE session_v2 (id TEXT PRIMARY KEY);")
    const backup = path.join(arenaDirectory, BACKUP_DIRECTORY)
    await mkdir(backup)
    await Bun.write(path.join(backup, "keep.db"), "backup")
    const created = (await stat(backup)).mtimeMs
    await chmod(backup, 0o500)
    try {
      await backUpBeforeUpgrade({ engineDatabase, arenaDirectory, now: created + BACKUP_RETENTION_MS })
      expect(await Bun.file(path.join(backup, "keep.db")).text()).toBe("backup")
      expect(read(engineDatabase, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
    } finally {
      await chmod(backup, 0o700)
    }
  })

  test("does not require backup files or writable backup cleanup after import", async () => {
    const { arenaDirectory, engineDatabase } = await workspace()
    write(
      engineDatabase,
      `CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"completed"}');`,
    )
    await Bun.write(path.join(arenaDirectory, "arena.sqlite"), "unreadable as SQLite")
    const temporary = path.join(arenaDirectory, `${BACKUP_DIRECTORY}.tmp`)
    await mkdir(temporary)
    await Bun.write(path.join(temporary, "partial.db"), "incomplete copy")
    await chmod(temporary, 0o500)
    try {
      await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
      expect(existsSync(path.join(arenaDirectory, BACKUP_DIRECTORY))).toBe(false)
      expect(read(engineDatabase, "SELECT value FROM kv")).toEqual([{ value: '{"phase":"completed"}' }])
    } finally {
      await chmod(temporary, 0o700)
    }
  })
})

describe("fenceLegacyEngines", () => {
  const run = (filename: string) =>
    Effect.runPromise(
      fenceLegacyEngines.pipe(
        Effect.provide(
          Layer.provideMerge(
            Database.layer({ path: filename }),
            Layer.succeed(Global.Service, Global.make({ data: path.dirname(filename) })),
          ),
        ),
        Effect.scoped,
      ),
    )

  test("renames the 1.x session table after the V1 import, keeps its rows, and repeats safely", async () => {
    const { root } = await workspace()
    const filename = path.join(root, "engine.db")
    await run(filename)
    write(
      filename,
      `CREATE TABLE session (
         id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL,
         directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text,
         summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
         metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
         tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
         tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
         revert text, permission text, agent text, model text, time_created integer NOT NULL,
         time_updated integer NOT NULL, time_compacting integer, time_archived integer
       );
       CREATE TABLE message (
         id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
         data text NOT NULL, FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
       );
       CREATE TABLE part (
         id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
         time_updated integer NOT NULL, data text NOT NULL
       );
       INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES ('ses_old', 'global', 'old', '/tmp/old', 'Old', '1', 1, 2);`,
    )

    await run(filename)
    await run(filename)

    const tables = read<{ name: string }>(filename, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
      (row) => row.name,
    )
    expect(tables).not.toContain("session")
    expect(tables).toContain(FENCED_SESSION_TABLE)
    expect(read(filename, `SELECT id FROM ${FENCED_SESSION_TABLE}`)).toEqual([{ id: "ses_old" }])
    expect(read(filename, "SELECT id FROM session_v2")).toEqual([{ id: "ses_old" }])
    const message = read<{ sql: string }>(filename, "SELECT sql FROM sqlite_master WHERE name = 'message'")[0]
    expect(message.sql).toContain(FENCED_SESSION_TABLE)
  })

  test("leaves a database with no 1.x table as it is", async () => {
    const { root } = await workspace()
    const filename = path.join(root, "engine.db")
    await run(filename)
    await run(filename)
    expect(read(filename, `SELECT name FROM sqlite_master WHERE name = '${FENCED_SESSION_TABLE}'`)).toEqual([])
  })
})

test("the documented emergency recovery preserves committed rows in both moved-aside WAL files", async () => {
  const { root, arenaDirectory, engineDatabase } = await workspace()
  const arenaDatabase = path.join(arenaDirectory, "arena.sqlite")
  write(engineDatabase, legacySessions("('before')"))
  write(arenaDatabase, "CREATE TABLE turns (id TEXT); INSERT INTO turns VALUES ('before');")
  await backUpBeforeUpgrade({ engineDatabase, arenaDirectory })
  // A SQLite fixture process, not an engine: die without checkpointing either connection.
  const crashed = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const { Database } = require("bun:sqlite");
    const engine = new Database(process.argv[1]);
    const arena = new Database(process.argv[2]);
    engine.run("CREATE TABLE session_v2 (id TEXT); INSERT INTO session_v2 VALUES ('after-crash');");
    arena.run("INSERT INTO turns VALUES ('after-crash');");
    process.kill(process.pid, "SIGKILL");
  `,
      engineDatabase,
      arenaDatabase,
    ],
    { env: {}, stdout: "pipe", stderr: "pipe" },
  )
  expect(crashed.signalCode).toBe("SIGKILL")
  expect((await stat(`${engineDatabase}-wal`)).size).toBeGreaterThan(0)
  expect((await stat(`${arenaDatabase}-wal`)).size).toBeGreaterThan(0)

  const doc = await Bun.file(new URL("../../../../../docs/arena.md", import.meta.url)).text()
  const command = doc.match(/```sh\n(set -e\nsaved="\$PASEO_HOME\/arena\/pre-recovery"[\s\S]*?)\n```/)
  expect(command).not.toBeNull()
  const recovered = Bun.spawnSync(["/bin/sh", "-c", command![1]], {
    env: { PATH: "/usr/bin:/bin", PASEO_HOME: root, engine_database: engineDatabase },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(recovered.stderr.toString()).toBe("")
  expect(recovered.exitCode).toBe(0)
  expect(read(path.join(arenaDirectory, "pre-recovery", "opencode-local.db"), "SELECT id FROM session_v2")).toEqual([
    { id: "after-crash" },
  ])
  expect(read(path.join(arenaDirectory, "pre-recovery", "arena.sqlite"), "SELECT id FROM turns ORDER BY id")).toEqual([
    { id: "after-crash" },
    { id: "before" },
  ])
  expect(sessionIDs(engineDatabase)).toEqual(["before"])
  expect(read(arenaDatabase, "SELECT id FROM turns")).toEqual([{ id: "before" }])
})
