import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Database } from "@opencode/core/database/database"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { migrations } from "@opencode/core/database/migration.gen"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { sqliteLayer } from "@opencode/core/database/sqlite.bun"
import { Global } from "@opencode/util/global"
import { Effect, Layer, Logger } from "effect"
import { existsSync } from "node:fs"
import { link, mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  FENCED_SESSION_TABLE,
  prepareDatabaseUpgrade,
  prepareEngineDatabases,
  prepareDatabaseMaintenance,
  fenceLegacyEngines,
} from "@/arena/database-upgrade"

const roots: string[] = []
const pendingLine = "[arena-upgrade] Importing OpenCode 1.x chats"

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

const legacySessions = "CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('one');"

describe("database upgrade preflight", () => {
  test("first start writes no copy or directory and never opens arena.sqlite", async () => {
    const input = await workspace()
    write(input.engineDatabase, legacySessions)
    const arena = path.join(input.arenaDirectory, "arena.sqlite")
    await Bun.write(arena, "not SQLite: preflight must not open this file")
    const before = await Bun.file(input.engineDatabase).arrayBuffer()
    const lines: string[] = []
    expect(await prepareDatabaseUpgrade(input, (line) => lines.push(line))).toBe("import")
    expect(lines).toEqual([pendingLine])
    expect(await Bun.file(input.engineDatabase).arrayBuffer()).toEqual(before)
    expect(await Bun.file(arena).text()).toBe("not SQLite: preflight must not open this file")
    expect(
      (await readdir(input.root)).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")).sort(),
    ).toEqual(["arena", "opencode-local.db", "opencode-local.db.arena-lock"])
    expect(await readdir(input.arenaDirectory)).toEqual(["arena.sqlite"])
  })

  test.each([false, true])(
    "first upgrade line precedes real schema migrations, partially imported=%s",
    async (partial) => {
      const input = await workspace()
      // Build the real lineage immediately before the V2 squash that introduces kv and session_v2.
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* EffectDrizzleSqlite.makeWithDefaults()
          yield* DatabaseMigration.applyOnly(
            db,
            migrations.filter((migration) => migration.id < "20260804233008"),
          )
        }).pipe(
          Effect.provide(sqliteLayer({ filename: input.engineDatabase })),
          Effect.provideService(Global.Service, Global.make({ data: input.root })),
          Effect.scoped,
        ),
      )
      if (partial) {
        await Effect.runPromise(
          Layer.build(Database.layer({ path: input.engineDatabase })).pipe(
            Effect.provideService(Global.Service, Global.make({ data: input.root })),
            Effect.scoped,
          ),
        )
        write(
          input.engineDatabase,
          `INSERT INTO kv VALUES ('migration.v1-v2','{"phase":"sessions","cursor":"ses_2"}',1,1);
        DELETE FROM migration WHERE id='20261010180456_project_time_archived';
        ALTER TABLE project DROP COLUMN time_archived;`,
        )
      }
      const events: string[] = []
      await prepareDatabaseUpgrade(input, (line) => {
        events.push(line)
        expect(
          read(input.engineDatabase, "SELECT id FROM migration WHERE id='20261010180456_project_time_archived'"),
        ).toEqual([])
      })
      expect(events).toEqual([pendingLine])
      await Effect.runPromise(
        Layer.build(Database.layer({ path: input.engineDatabase })).pipe(
          Effect.provideService(Global.Service, Global.make({ data: input.root })),
          Effect.provide(
            Logger.layer([
              Logger.map(Logger.formatStructured, (entry) => {
                events.push(JSON.stringify(entry.message))
              }),
            ]),
          ),
          Effect.scoped,
        ),
      )
      expect(events[0]).toBe(pendingLine)
      expect(events.findIndex((line) => line.includes("database schema bootstrap started"))).toBeGreaterThan(0)
      expect(events.findIndex((line) => line.includes("database migration started"))).toBeGreaterThan(0)
      expect(
        read(input.engineDatabase, "SELECT id FROM migration WHERE id='20261010180456_project_time_archived'"),
      ).toEqual([{ id: "20261010180456_project_time_archived" }])
    },
  )

  test("leftover test-build directories stay untouched even when older than fourteen days", async () => {
    const input = await workspace()
    write(input.engineDatabase, legacySessions)
    for (const name of ["pre-opencode-2-backup", "pre-opencode-2-backup.tmp"]) {
      const directory = path.join(input.arenaDirectory, name)
      await mkdir(directory)
      await Bun.write(path.join(directory, "engine.db"), "invalid SQLite, keep exactly")
      await utimes(directory, new Date(0), new Date(0))
    }
    await prepareDatabaseUpgrade(input, () => {})
    for (const name of ["pre-opencode-2-backup", "pre-opencode-2-backup.tmp"]) {
      expect(await Bun.file(path.join(input.arenaDirectory, name, "engine.db")).text()).toBe(
        "invalid SQLite, keep exactly",
      )
    }
  })

  test("fresh, missing, memory and finished databases emit no upgrade line", async () => {
    const input = await workspace()
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    await prepareDatabaseUpgrade(input, log)
    expect(existsSync(input.engineDatabase)).toBe(false)
    await prepareDatabaseUpgrade({ ...input, engineDatabase: ":memory:" }, log)
    write(input.engineDatabase, "CREATE TABLE session_v2 (id TEXT PRIMARY KEY);")
    await prepareDatabaseUpgrade(input, log)
    write(
      input.engineDatabase,
      `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('migration.v1-v2','{"phase":"completed"}');
      INSERT INTO kv VALUES ('arena.v1-cleanup','{"phase":"done"}');`,
    )
    await prepareDatabaseUpgrade(input, log)
    write(input.engineDatabase, "CREATE TABLE session (id TEXT PRIMARY KEY);")
    await prepareDatabaseUpgrade(input, log)
    expect(lines).toEqual([])
  })

  test("an unfinished fenced import is announced before Core can open the file", async () => {
    const input = await workspace()
    write(
      input.engineDatabase,
      `CREATE TABLE ${FENCED_SESSION_TABLE} (id TEXT PRIMARY KEY);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('migration.v1-v2','{"phase":"sessions","cursor":"ses_2"}');`,
    )
    const lines: string[] = []
    await prepareDatabaseUpgrade(input, (line) => lines.push(line))
    expect(lines).toEqual([pendingLine])
  })

  test("pending cleanup is announced before maintenance opens the file", async () => {
    const input = await workspace()
    write(
      input.engineDatabase,
      `CREATE TABLE ${FENCED_SESSION_TABLE} (id TEXT PRIMARY KEY);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('migration.v1-v2','{"phase":"completed"}');`,
    )
    const lines: string[] = []
    expect(await prepareDatabaseUpgrade(input, (line) => lines.push(line))).toBe(true)
    expect(lines).toEqual(["[arena-upgrade] Removing imported OpenCode 1.x tables"])
  })

  test.each(["done", "vacuum"])(
    "a leftover compaction file still gets maintenance when cleanup is %s",
    async (phase) => {
      const input = await workspace()
      write(
        input.engineDatabase,
        `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('arena.v1-cleanup','${JSON.stringify({ phase, retryAfter: Date.now() + 86400000 })}');`,
      )
      await Bun.write(input.engineDatabase + ".vacuum-into.tmp", "leftover compaction")
      const lines: string[] = []
      expect(await prepareDatabaseUpgrade(input, (line) => lines.push(line))).toBe(true)
      expect(lines).toEqual([])
    },
  )

  test("the engine entrypoint refuses shared XDG data before opening any database or lease", async () => {
    const other = await workspace()
    const previousHome = process.env.PASEO_HOME
    const previousDatabase = process.env.OPENCODE_DB
    const filename = "r71-shared.db"
    const shared = path.join(Global.Path.data, filename)
    await mkdir(Global.Path.data, { recursive: true })
    await Bun.write(shared, "not SQLite: ownership must fail first")
    try {
      process.env.PASEO_HOME = other.root
      process.env.OPENCODE_DB = filename
      await expect(prepareEngineDatabases()).rejects.toThrow("does not belong to PASEO_HOME")
      expect(await Bun.file(shared).text()).toBe("not SQLite: ownership must fail first")
      expect(existsSync(shared + ".arena-lock")).toBe(false)
      expect(existsSync(shared + "-wal")).toBe(false)
      expect(await readdir(other.arenaDirectory)).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.PASEO_HOME
      else process.env.PASEO_HOME = previousHome
      if (previousDatabase === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = previousDatabase
      await rm(shared, { force: true })
    }
  })

  test("refuses another home's file, absent path, symlink, dangling symlink and hard link", async () => {
    const owner = await workspace()
    const other = await workspace()
    const foreign = { ...other, engineDatabase: owner.engineDatabase }
    await expect(prepareDatabaseUpgrade(foreign)).rejects.toThrow("does not belong to PASEO_HOME")
    expect(existsSync(owner.engineDatabase)).toBe(false)
    await symlink(owner.engineDatabase, other.engineDatabase)
    await expect(prepareDatabaseUpgrade(other)).rejects.toThrow("does not belong to PASEO_HOME")
    await Bun.write(owner.engineDatabase, "not SQLite")
    await expect(prepareDatabaseUpgrade(foreign)).rejects.toThrow("does not belong to PASEO_HOME")
    await expect(prepareDatabaseUpgrade(other)).rejects.toThrow("does not belong to PASEO_HOME")
    await rm(other.engineDatabase)
    await link(owner.engineDatabase, other.engineDatabase)
    await expect(prepareDatabaseUpgrade(other)).rejects.toThrow("multiple hard links")
    expect(await Bun.file(owner.engineDatabase).text()).toBe("not SQLite")
    expect((await readdir(owner.root)).sort()).toEqual(["arena", "opencode-local.db"])
    expect((await readdir(other.root)).sort()).toEqual(["arena", "opencode-local.db"])
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

test("one-start maintenance migrates the real 1.x schema before import and cleanup", async () => {
  const input = await workspace()
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.applyOnly(
        db,
        migrations.filter((migration) => migration.id < "20260804233008"),
      )
    }).pipe(
      Effect.provide(sqliteLayer({ filename: input.engineDatabase })),
      Effect.provideService(Global.Service, Global.make({ data: input.root })),
      Effect.scoped,
    ),
  )
  write(
    input.engineDatabase,
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('global', '/tmp', 1, 1, '[]');
    INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
    VALUES ('ses_legacy','global','old','/tmp','Old','1',1,1);`,
  )
  await prepareDatabaseMaintenance(input)
  expect(read(input.engineDatabase, "SELECT id FROM session_v2")).toEqual([{ id: "ses_legacy" }])
  expect(read(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"done"}' },
  ])
})
