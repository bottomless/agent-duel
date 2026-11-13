import { afterEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { fenceLegacyEngines, finishLegacyCleanup } from "@/arena/database-upgrade"
import { removeImportedLegacyTables } from "@/arena/database-cleanup"
import { databaseLease, engineDatabaseLease } from "@/arena/database-lease"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function write(filename: string, query: string) {
  using db = new SQLite(filename)
  db.run(query)
}
function read<T>(filename: string, query: string) {
  using db = new SQLite(filename)
  return db.query<T, []>(query).all()
}
function run(filename: string) {
  return Effect.runPromise(
    fenceLegacyEngines.pipe(
      Effect.provide(
        Layer.provideMerge(
          Database.layer({ path: filename }),
          Layer.succeed(Global.Service, Global.make({ data: dirname(filename) })),
        ),
      ),
      Effect.scoped,
    ),
  )
}
async function fixture(options: { skipped?: boolean; imported?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "arena-cleanup-"))
  roots.push(root)
  const input = { engineDatabase: join(root, "engine.db"), arenaDirectory: join(root, "arena") }
  await mkdir(input.arenaDirectory)
  await run(input.engineDatabase)
  write(
    input.engineDatabase,
    `
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
      path TEXT, title TEXT, version TEXT, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
      summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0, revert TEXT, permission TEXT, agent TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE todo (session_id TEXT REFERENCES session(id) ON DELETE CASCADE, content TEXT);
    CREATE INDEX todo_session_idx ON todo(session_id);
    CREATE TABLE session_share (session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE, secret TEXT);
    INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
      VALUES ('ses_old','global','old','/tmp/old','Old','1',1,2);
    INSERT INTO message VALUES ('msg_old','ses_old',1,2,'${
      options.skipped
        ? "{"
        : JSON.stringify({
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "arena", modelID: "contestant" },
          })
    }');
    INSERT INTO todo VALUES ('ses_old','keep this task');
    INSERT INTO session_share VALUES ('ses_old','fixture-value');
  `,
  )
  using db = new SQLite(input.engineDatabase)
  db.query("INSERT INTO part VALUES ('prt_old','msg_old','ses_old',1,2,?)").run(
    JSON.stringify({ type: "text", text: "history ".repeat(150_000) }),
  )
  if (options.imported !== false) await run(input.engineDatabase)
  return input
}
function tables(input: { engineDatabase: string }) {
  return read<{ name: string }>(input.engineDatabase, "SELECT name FROM sqlite_master WHERE type='table'").map(
    (row) => row.name,
  )
}
function state(input: { engineDatabase: string }) {
  return JSON.parse(
    read<{ value: string }>(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")[0].value,
  )
}
// Windows has no signals: a process that kills itself ends through TerminateProcess with exit code 1.
function expectSelfKilled(child: { signalCode: string | null; exitCode: number | null }) {
  if (process.platform === "win32") expect(child.exitCode).toBe(1)
  else expect(child.signalCode).toBe("SIGKILL")
}
function expectKept(input: { engineDatabase: string }) {
  expect(tables(input)).toContain("message")
  expect(tables(input)).toContain("part")
  expect(tables(input)).toContain("_arena_v1_session")
}

test("complete import drops duplicates, reclaims bytes, preserves other rows, restarts and refuses 1.x", async () => {
  const input = await fixture()
  const before = (await stat(input.engineDatabase)).size
  await removeImportedLegacyTables(input)
  expect(tables(input)).not.toContain("message")
  expect(tables(input)).not.toContain("part")
  expect(tables(input)).not.toContain("_arena_v1_session")
  expect(read(input.engineDatabase, "SELECT id FROM session_v2")).toEqual([{ id: "ses_old" }])
  expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
  expect(read(input.engineDatabase, "SELECT content FROM todo")).toEqual([{ content: "keep this task" }])
  expect(read(input.engineDatabase, "SELECT secret FROM session_share")).toEqual([{ secret: "fixture-value" }])
  expect(read(input.engineDatabase, "PRAGMA foreign_key_check")).toEqual([])
  expect(read(input.engineDatabase, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
  expect((await stat(input.engineDatabase)).size).toBeLessThan(before)
  expect(state(input).phase).toBe("done")
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input, {
    vacuum: () => {
      throw new Error("second VACUUM")
    },
  })
  expect(state(input).phase).toBe("done")
  // Released 1.x bootstrap predicate, executed on the real file. No engine is launched.
  using old = new SQLite(input.engineDatabase)
  const bootstrap1x = () => {
    const existing = old
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1)<>'_'")
      .all()
    if (!existing.some((table) => table.name === "session") && existing.length > 0)
      throw new Error("Database is not empty and has no session table")
  }
  expect(bootstrap1x).toThrow("Database is not empty and has no session table")
})

test("unfinished import does not drop or vacuum", async () => {
  const input = await fixture({ imported: false })
  write(input.engineDatabase, `INSERT INTO kv VALUES ('migration.v1-v2','{"phase":"sessions"}',1,1)`)
  await removeImportedLegacyTables(input, {
    vacuum: () => {
      throw new Error("unexpected VACUUM")
    },
  })
  expect(tables(input)).toContain("session")
  expect(tables(input)).toContain("part")
})

test("skipped rows have a durable count and keep the source tables", async () => {
  const input = await fixture({ skipped: true })
  expect(read(input.engineDatabase, "SELECT value FROM kv WHERE key='migration.v1-v2.skipped'")).toEqual([
    { value: "1" },
  ])
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(state(input).skippedTotal).toBe(1)
  await removeImportedLegacyTables(input)
  expect(state(input).skippedTotal).toBe(1)
})

test("earlier 2.0 imports are audited without a recorded skipped count", async () => {
  const input = await fixture({ skipped: true })
  write(input.engineDatabase, "DELETE FROM kv WHERE key='migration.v1-v2.skipped'")
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(state(input).skippedTotal).toBe(1)
})

test("clean imports from earlier 2.0 builds can be dropped", async () => {
  const input = await fixture()
  write(input.engineDatabase, "DELETE FROM kv WHERE key='migration.v1-v2.skipped'")
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("a missing V2 session blocks cleanup", async () => {
  const input = await fixture()
  write(input.engineDatabase, "DELETE FROM session_v2 WHERE id='ses_old'")
  await removeImportedLegacyTables(input)
  expectKept(input)
})

test("orphan source rows block cleanup without inflating the count each restart", async () => {
  const input = await fixture()
  write(input.engineDatabase, "INSERT INTO part VALUES ('prt_orphan','absent','absent',1,2,'{}')")
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(state(input).skippedTotal).toBe(1)
  await removeImportedLegacyTables(input)
  expect(state(input).skippedTotal).toBe(1)
})

test("a complete audit drops without a saved database, even with an invalid Arena store", async () => {
  const input = await fixture()
  await Bun.write(join(input.arenaDirectory, "arena.sqlite"), "not SQLite: must never be opened by cleanup")
  expect(existsSync(join(input.arenaDirectory, "pre-opencode-2-backup"))).toBe(false)
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
  expect(tables(input)).not.toContain("_arena_v1_session")
  expect(await Bun.file(join(input.arenaDirectory, "arena.sqlite")).text()).toBe(
    "not SQLite: must never be opened by cleanup",
  )
})

test("a real kill between drop and VACUUM leaves a durable pending step", async () => {
  const input = await fixture()
  const module = fileURLToPath(new URL("../../src/arena/database-cleanup.ts", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const { removeImportedLegacyTables } = await import(${JSON.stringify(module)});
    await removeImportedLegacyTables(JSON.parse(await Bun.stdin.text()), { afterDrop: () => process.kill(process.pid, 'SIGKILL') });
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  await child.exited
  expectSelfKilled(child)
  expect(state(input).phase).toBe("vacuum")
  expect(tables(input)).not.toContain("message")
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
  await run(input.engineDatabase)
})

test("too little disk space defers VACUUM and allows normal database startup", async () => {
  const input = await fixture()
  let vacuums = 0
  await removeImportedLegacyTables(input, {
    availableBytes: async () => 0,
    vacuum: () => {
      vacuums++
    },
  })
  expect(vacuums).toBe(0)
  expect(state(input).phase).toBe("vacuum")
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("failed VACUUM allows startup, skips the next launch and retries a day later", async () => {
  const input = await fixture()
  let vacuums = 0
  await removeImportedLegacyTables(input, {
    now: () => 1,
    vacuum: () => {
      vacuums++
      throw new Error("disk error")
    },
  })
  expect(vacuums).toBe(1)
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input, {
    now: () => 2,
    vacuum: () => {
      vacuums++
    },
  })
  expect(vacuums).toBe(1)
  await removeImportedLegacyTables(input, { now: () => 24 * 60 * 60 * 1000 + 2 })
  expect(state(input).phase).toBe("done")
})

test("fresh V2 databases never VACUUM", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-cleanup-"))
  roots.push(root)
  const input = { engineDatabase: join(root, "fresh.db"), arenaDirectory: join(root, "arena") }
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input, {
    vacuum: () => {
      throw new Error("unexpected VACUUM")
    },
  })
  expect(tables(input)).toContain("session_v2")
  expect(read(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([])
})

test("the early maintenance subprocess finishes without launching an engine", async () => {
  const input = await fixture()
  await finishLegacyCleanup(input)
  expect(state(input).phase).toBe("done")
})

test("a missing projected V2 message retains the old rows", async () => {
  const input = await fixture()
  write(input.engineDatabase, "DELETE FROM session_message WHERE id='msg_old'")
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(state(input).expectedMessages).toBe(1)
  expect(state(input).importedMessages).toBe(0)
})

test("an audit is invalidated when V2 changes between starts", async () => {
  const input = await fixture()
  // Leave the completed audit waiting for an unknown dependent table, then change V2.
  write(input.engineDatabase, "CREATE TABLE custom_keep (id TEXT REFERENCES _arena_v1_session(id))")
  await removeImportedLegacyTables(input)
  expect(state(input).importedMessages).toBe(1)
  write(input.engineDatabase, "DROP TABLE custom_keep; DELETE FROM session_message WHERE id='msg_old'")
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(state(input).importedMessages).toBe(0)
})

test("pending historical migrations delay drop until ordinary schema startup applies them", async () => {
  const input = await fixture()
  write(input.engineDatabase, "DELETE FROM migration WHERE id='20260910120000_clear_v1_session_permission'")
  await removeImportedLegacyTables(input)
  expectKept(input)
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("maintenance time limit returns to startup and the next start can finish", async () => {
  const input = await fixture()
  await finishLegacyCleanup(input, 1)
  expectKept(input)
  await run(input.engineDatabase)
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

for (const point of ["beforeRename", "afterRename"] as const) {
  test(`a real kill ${point} leaves a complete database`, async () => {
    const input = await fixture()
    const module = fileURLToPath(new URL("../../src/arena/database-cleanup.ts", import.meta.url))
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
      const { removeImportedLegacyTables } = await import(${JSON.stringify(module)});
      await removeImportedLegacyTables(JSON.parse(await Bun.stdin.text()), {
        ${point}: () => process.kill(process.pid, 'SIGKILL')
      });
    `,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    await child.exited
    expectSelfKilled(child)
    expect(read(input.engineDatabase, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
    expect(read(input.engineDatabase, "SELECT id FROM session_v2")).toEqual([{ id: "ses_old" }])
    expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
    const temp = `${input.engineDatabase}.vacuum-into.tmp`
    expect(await Bun.file(temp).exists()).toBe(point === "beforeRename")
    expect(state(input).phase).toBe(point === "beforeRename" ? "vacuum" : "done")
    // A killed copy waits a day, but even an ineligible start removes the leftover copy.
    await removeImportedLegacyTables(input, {
      now: () => Date.now() + 24 * 60 * 60 * 1000 + 1,
      ...(point === "afterRename"
        ? {
            vacuum: () => {
              throw new Error("must not recopy")
            },
          }
        : {}),
    })
    expect(state(input).phase).toBe("done")
    expect(await Bun.file(temp).exists()).toBe(false)
    await run(input.engineDatabase)
  })
}

test("a real kill before DROP commits rolls back all DDL and the pending marker", async () => {
  const input = await fixture()
  const module = fileURLToPath(new URL("../../src/arena/database-cleanup.ts", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const { removeImportedLegacyTables } = await import(${JSON.stringify(module)});
    await removeImportedLegacyTables(JSON.parse(await Bun.stdin.text()), {
      beforeDropCommit: () => process.kill(process.pid, 'SIGKILL')
    });
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  await child.exited
  expectSelfKilled(child)
  expectKept(input)
  expect(state(input).phase).toBe("audit")
  expect(read(input.engineDatabase, "SELECT content FROM todo")).toEqual([{ content: "keep this task" }])
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("a copy missing a V2 message never replaces the original", async () => {
  const input = await fixture()
  await removeImportedLegacyTables(input, {
    vacuum: (db, temporary) => {
      db.query("VACUUM INTO ?").run(temporary)
      write(temporary, "DELETE FROM session_message")
    },
  })
  expect(state(input).phase).toBe("vacuum")
  expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
  expect(await Bun.file(`${input.engineDatabase}.vacuum-into.tmp`).exists()).toBe(false)
})

test("unknown foreign-key children of message or part postpone deletion", async () => {
  const input = await fixture()
  write(input.engineDatabase, "CREATE TABLE custom_parts (id TEXT REFERENCES part(id))")
  await removeImportedLegacyTables(input)
  expectKept(input)
  expect(tables(input)).toContain("custom_parts")
})

test("compiled maintenance identifies its own executable without a source script", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-compiled-maintenance-"))
  roots.push(root)
  const source = join(root, "entry.ts")
  const binary = join(root, "maintenance")
  await Bun.write(source, "console.log(JSON.stringify({ main: Bun.main, exec: process.execPath, argv: Bun.argv }))")
  const result = await Bun.build({ entrypoints: [source], compile: { outfile: binary } })
  expect(result.success).toBe(true)
  const child = Bun.spawn([binary, "--arena-database-cleanup"], { env: {}, stdout: "pipe", stderr: "pipe" })
  const observed = JSON.parse(await new Response(child.stdout).text())
  expect(await child.exited).toBe(0)
  // Bun.main is a virtual embedded path whose basename is the compiled executable's name.
  // This is the source/compiled predicate and flag position used by the maintenance dispatcher.
  expect(observed.main.endsWith(".ts")).toBe(false)
  expect(observed.argv[2]).toBe("--arena-database-cleanup")
})

test("leftover partial copy is removed even when retry is not due", async () => {
  const input = await fixture()
  await removeImportedLegacyTables(input, {
    now: () => 1,
    vacuum: () => {
      throw new Error("failed")
    },
  })
  const temporary = `${input.engineDatabase}.vacuum-into.tmp`
  await Bun.write(temporary, "incomplete SQLite copy")
  await removeImportedLegacyTables(input, { now: () => 2 })
  expect(await Bun.file(temporary).exists()).toBe(false)
  expect(state(input).phase).toBe("vacuum")
})

test("one final-size copy plus headroom is sufficient", async () => {
  const input = await fixture()
  let copied = false
  await removeImportedLegacyTables(input, {
    availableBytes: async (required) => required,
    vacuum: (db, temporary) => {
      copied = true
      db.query("VACUUM INTO ?").run(temporary)
    },
  })
  expect(copied).toBe(true)
  expect(state(input).phase).toBe("done")
})

test("an idle holder in another process postpones cleanup and swap", async () => {
  const input = await fixture()
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const { Database } = await import('bun:sqlite');
    const db = new Database(Bun.argv[1]); db.query('SELECT count(*) FROM session_v2').get();
    console.log('held'); await Bun.stdin.text(); db.close();
  `,
      input.engineDatabase,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held")
    await removeImportedLegacyTables(input)
    expectKept(input)
  } finally {
    child.stdin.end()
    expect(await child.exited).toBe(0)
  }
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("a running engine's shared lease postpones maintenance", async () => {
  const input = await fixture()
  {
    using lease = await engineDatabaseLease(input.engineDatabase)
    expect(lease).toBeDefined()
    await removeImportedLegacyTables(input)
    expectKept(input)
  }
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
})

test("a new engine cannot acquire a lease until the rename is complete", async () => {
  const input = await fixture()
  await removeImportedLegacyTables(input, {
    beforeRename: () => {
      using lease = databaseLease(input.engineDatabase, false)
      expect(lease).toBeUndefined()
    },
    afterRename: () => {
      using lease = databaseLease(input.engineDatabase, false)
      expect(lease).toBeUndefined()
    },
  })
  using lease = await engineDatabaseLease(input.engineDatabase)
  expect(lease).toBeDefined()
  expect(state(input).phase).toBe("done")
})

test("a slow audit saves its cursor and does not start a copy without enough time", async () => {
  const input = await fixture()
  let clock = 0
  let copied = false
  const ports = {
    now: () => clock,
    afterAuditSession: () => {
      clock = 3 * 60_000
    },
    vacuum: (db: SQLite, temporary: string) => {
      copied = true
      db.query("VACUUM INTO ?").run(temporary)
    },
  }
  await removeImportedLegacyTables({ ...input, deadline: 3 * 60_000 + 4_000 }, ports)
  expectKept(input)
  expect(state(input).cursor).toBe("ses_old")
  expect(state(input).sessions).toBe(1)
  clock = 0
  await removeImportedLegacyTables({ ...input, deadline: 3 * 60_000 }, ports)
  expect(copied).toBe(false)
  expect(state(input).phase).toBe("vacuum")
  clock = 0
  await removeImportedLegacyTables({ ...input, deadline: 8 * 60_000 }, ports)
  expect(copied).toBe(true)
  expect(state(input).phase).toBe("done")
})

test("an already exhausted engine-spawn budget runs no maintenance", async () => {
  const input = await fixture()
  await finishLegacyCleanup({ ...input, deadline: Date.now() - 1 })
  expectKept(input)
  expect(read(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([])
})

test("a durable deletion explains an absent session without erasing skipped-row checks", async () => {
  const input = await fixture()
  write(
    input.engineDatabase,
    `
    INSERT INTO event(id,aggregate_id,seq,created,type,data)
    VALUES ('deleted','ses_old',10,10,'session.deleted.2','{"sessionID":"ses_old"}');
    DELETE FROM session_v2 WHERE id='ses_old';
  `,
  )
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
  expect(read(input.engineDatabase, "SELECT id FROM session_v2")).toEqual([])
  expect(read(input.engineDatabase, "SELECT * FROM todo")).toEqual([])
  expect(read(input.engineDatabase, "SELECT * FROM session_share")).toEqual([])
})

test("stale source sidecars are absent at the publication boundary", async () => {
  const input = await fixture()
  // The source really uses WAL before maintenance. Seed a committed write in that mode.
  write(input.engineDatabase, "PRAGMA journal_mode=WAL; UPDATE session_v2 SET title='WAL committed'")
  let checked = false
  await removeImportedLegacyTables(input, {
    beforeRename: () => {
      checked = true
      expect(existsSync(`${input.engineDatabase}-wal`)).toBe(false)
      expect(existsSync(`${input.engineDatabase}-shm`)).toBe(false)
    },
  })
  expect(checked).toBe(true)
  expect(read(input.engineDatabase, "SELECT title FROM session_v2")).toEqual([{ title: "WAL committed" }])
})

test("a short shared deadline interrupts maintenance without spending a fresh timeout", async () => {
  const input = await fixture()
  const started = Date.now()
  await finishLegacyCleanup({ ...input, deadline: started + 30 }, 60_000)
  expect(Date.now() - started).toBeLessThan(2_000)
  expectKept(input)
})

test("a raw holder arriving during the copy prevents the final swap", async () => {
  const input = await fixture()
  let release = async () => {}
  try {
    await removeImportedLegacyTables(input, {
      vacuum: async (db, temporary) => {
        db.query("VACUUM INTO ?").run(temporary)
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `
          const { Database } = await import('bun:sqlite');
          const db = new Database(Bun.argv[1]);
          console.log('held'); await Bun.stdin.text(); db.close();
        `,
            input.engineDatabase,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        )
        release = async () => {
          child.stdin.end()
          expect(await child.exited).toBe(0)
        }
        expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("held")
      },
    })
    expect(state(input).phase).toBe("vacuum")
    expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
  } finally {
    await release()
  }
  await removeImportedLegacyTables(input, { now: () => Date.now() + 24 * 60 * 60 * 1000 + 1 })
  expect(state(input).phase).toBe("done")
})

test("a SIGKILL during audit keeps source tables and resumes committed audit progress", async () => {
  const input = await fixture()
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { removeImportedLegacyTables } from "@/arena/database-cleanup";
    await removeImportedLegacyTables(${JSON.stringify(input)}, {
      afterAuditSession: () => process.kill(process.pid, "SIGKILL")
    });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const out = new Response(child.stdout).text()
  const err = new Response(child.stderr).text()
  await child.exited
  await out
  await err
  expectSelfKilled(child)
  expectKept(input)
  expect(state(input)).toMatchObject({ phase: "audit", cursor: "ses_old" })
  await removeImportedLegacyTables(input)
  expect(state(input).phase).toBe("done")
  expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
})

test("SIGKILL while real VACUUM INTO writes its copy keeps the source and retries later", async () => {
  const input = await fixture()
  write(
    input.engineDatabase,
    "CREATE TABLE copy_payload (data BLOB); INSERT INTO copy_payload VALUES (randomblob(64000000))",
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { removeImportedLegacyTables } from "@/arena/database-cleanup";
    await removeImportedLegacyTables(${JSON.stringify(input)});
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const out = new Response(child.stdout).text()
  const err = new Response(child.stderr).text()
  try {
    const until = Date.now() + 10_000
    const temporary = `${input.engineDatabase}.vacuum-into.tmp`
    while (Bun.file(temporary).size === 0) {
      if (child.exitCode !== null || Date.now() > until) throw new Error("copy did not start before exit")
      await Bun.sleep(1)
    }
    child.kill("SIGKILL")
    await child.exited
    expect(child.signalCode).toBe("SIGKILL")
    expect(state(input).phase).toBe("vacuum")
    expect(read(input.engineDatabase, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }])
    expect(read(input.engineDatabase, "SELECT id FROM session_message")).toEqual([{ id: "msg_old" }])
    expect(read(input.engineDatabase, "SELECT length(data) AS n FROM copy_payload")).toEqual([{ n: 64000000 }])
    await removeImportedLegacyTables(input, { now: () => Date.now() + 24 * 60 * 60_000 + 1 })
    expect(state(input).phase).toBe("done")
    expect(read(input.engineDatabase, "SELECT length(data) AS n FROM copy_payload")).toEqual([{ n: 64000000 }])
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
    await out
    await err
  }
}, 20_000)
