import { afterEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  prepareDatabaseUpgrade,
  prepareDatabaseMaintenance,
  runDatabaseMaintenance,
  importLegacyDatabase,
  fenceLegacyEngines,
  fenceLegacyEnginesLayer,
  waitForLegacyImport,
} from "@/arena/database-upgrade"

const roots: string[] = []
const pendingLine = "[arena-upgrade] Importing OpenCode 1.x chats"
const fallbackLine = "[arena-upgrade] Import startup budget exhausted; startup continues with import in the background"

function services(filename: string) {
  return Layer.provideMerge(
    Database.layer({ path: filename }),
    Layer.succeed(Global.Service, Global.make({ data: path.dirname(filename) })),
  )
}

async function profile(count: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-import-wait-"))
  roots.push(root)
  const engineDatabase = path.join(root, "engine.db")
  const arenaDirectory = path.join(root, "arena")
  await mkdir(arenaDirectory)
  await Effect.runPromise(fenceLegacyEngines.pipe(Effect.provide(services(engineDatabase)), Effect.scoped))
  if (count > 0) {
    using database = new SQLite(engineDatabase)
    database.run(`
      CREATE TABLE session AS SELECT * FROM session_v2 WHERE 0;
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${count})
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
      SELECT printf('ses_%06d',i), 'global', 'old', '/tmp/old', 'Old', '1', i, i, 0, 0, 0, 0, 0, 0 FROM n;
      INSERT INTO message SELECT 'msg_' || id, id, time_created, time_updated,
        json_object('role','user','time',json_object('created',time_created),'agent','build',
          'model',json_object('providerID','arena','modelID','old')) FROM session;
      INSERT INTO part SELECT 'prt_' || id, 'msg_' || id, id, time_created, time_updated,
        '{"type":"text","text":"Saved prompt"}' FROM session;
      CREATE TABLE import_visit (id TEXT PRIMARY KEY, visits INTEGER);
      CREATE TRIGGER visit BEFORE INSERT ON session_v2 BEGIN
        INSERT INTO import_visit VALUES (NEW.id,1) ON CONFLICT(id) DO UPDATE SET visits=visits+1;
      END;
    `)
  }
  return { root, engineDatabase, arenaDirectory }
}

function rows<T>(filename: string, query: string) {
  using database = new SQLite(filename, { readonly: true })
  database.run("PRAGMA busy_timeout = 1000")
  return database.query<T, []>(query).all()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("readiness waits for every session on a real SQLite profile and fences before returning", async () => {
  const input = await profile(100)
  const lines: string[] = []
  await prepareDatabaseUpgrade(input)
  await Effect.runPromise(
    waitForLegacyImport({ log: (line) => lines.push(line) }).pipe(
      Effect.provide(services(input.engineDatabase)),
      Effect.scoped,
    ),
  )
  expect(lines).toEqual([pendingLine])
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")).toEqual([{ n: 100 }])
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 100 }])
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='migration.v1-v2'")).toEqual([
    { value: '{"phase":"completed"}' },
  ])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='session'")).toEqual([])
})

test("fresh and already imported databases do not enter the wait even with no budget left", async () => {
  for (const count of [0, 3]) {
    const input = await profile(count)
    await Effect.runPromise(fenceLegacyEngines.pipe(Effect.provide(services(input.engineDatabase)), Effect.scoped))
    const lines: string[] = []
    await Effect.runPromise(
      Layer.build(
        Layer.merge(
          V1Migration.layer,
          Layer.effectDiscard(waitForLegacyImport({ deadline: 0, log: (line) => lines.push(line) })),
        ),
      ).pipe(Effect.provide(services(input.engineDatabase)), Effect.scoped),
    )
    expect(lines).toEqual([])
  }
})

test.each([0, 1])(
  "spent startup budget releases readiness and leaves the import running: %d ms left",
  async (remaining) => {
    const input = await profile(100)
    const lines: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* waitForLegacyImport({ deadline: Date.now() + remaining, log: (line) => lines.push(line) })
        const count = yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM session_v2`)
        expect(count!.n).toBeLessThan(100)
        expect(lines).toEqual([pendingLine, fallbackLine])
        // The same scoped fiber must finish after the barrier times out, without another run().
        while ((yield* V1Migration.status()).status !== "completed") yield* Effect.yieldNow
      }).pipe(Effect.provide(services(input.engineDatabase)), Effect.scoped),
    )
    expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")).toEqual([{ n: 100 }])
    expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 100 }])
    expect(rows(input.engineDatabase, "SELECT DISTINCT visits FROM import_visit")).toEqual([{ visits: 1 }])
  },
)

test("a SIGKILL during import preserves progress; the next start prints only the import marker and resumes", async () => {
  const input = await profile(2000)
  const fixture = `
    import { Effect, Layer } from "effect";
    import { Database } from "@opencode/core/database/database";
    import { Global } from "@opencode/util/global";
    import { prepareDatabaseUpgrade, waitForLegacyImport } from "@/arena/database-upgrade";
    const input = ${JSON.stringify(input)};
    await prepareDatabaseUpgrade(input);
    await Effect.runPromise(waitForLegacyImport().pipe(Effect.provide(Layer.provideMerge(
      Database.layer({path: input.engineDatabase}),
      Layer.succeed(Global.Service, Global.make({data: input.root}))
    )), Effect.scoped));
    console.log("fixture import complete");
  `
  // This process only imports a disposable SQLite file; it never starts an engine or a listener.
  const start = () =>
    Bun.spawn([process.execPath, "--no-env-file", "-e", fixture], {
      env: {
        PATH: process.env.PATH,
        XDG_DATA_HOME: input.root,
        XDG_CACHE_HOME: path.join(input.root, "cache"),
        XDG_CONFIG_HOME: path.join(input.root, "config"),
        XDG_STATE_HOME: path.join(input.root, "state"),
        PASEO_HOME: input.root,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  const first = start()
  const firstOut = new Response(first.stdout).text()
  const firstErr = new Response(first.stderr).text()
  try {
    const until = Date.now() + 10_000
    while (rows<{ n: number }>(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")[0].n < 3) {
      if (Date.now() >= until || first.exitCode !== null) throw new Error(`fixture made no progress: ${await firstErr}`)
      await Bun.sleep(5)
    }
    first.kill("SIGKILL")
    await first.exited
    expect(first.signalCode).toBe("SIGKILL")
    const output = await firstOut
    expect(output.split(pendingLine + "\n")).toHaveLength(3)
    expect(output).toContain(pendingLine + "\n")
    const progress = rows<{ n: number }>(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")[0].n
    expect(progress).toBeGreaterThan(0)
    expect(progress).toBeLessThan(2000)
    expect(
      rows<{ value: string }>(input.engineDatabase, "SELECT value FROM kv WHERE key='migration.v1-v2'").map((row) =>
        JSON.parse(row.value),
      ),
    ).toEqual([{ phase: "sessions", cursor: `ses_${String(2001 - progress).padStart(6, "0")}` }])
    expect(await Bun.file(path.join(input.arenaDirectory, "pre-opencode-2-backup")).exists()).toBe(false)
    const second = start()
    const secondOut = new Response(second.stdout).text()
    const secondErr = new Response(second.stderr).text()
    try {
      expect(await second.exited).toBe(0)
      expect(await secondErr).not.toContain("could not fence")
      const output = await secondOut
      expect(output).toContain(pendingLine + "\n")
      expect(output.split(pendingLine + "\n")).toHaveLength(3)
      expect(output).toContain("fixture import complete")
    } finally {
      if (second.exitCode === null) {
        second.kill("SIGKILL")
        await second.exited
      }
    }
    expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")).toEqual([{ n: 2000 }])
    expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 2000 }])
    expect(rows(input.engineDatabase, "SELECT DISTINCT visits FROM import_visit")).toEqual([{ visits: 1 }])
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      first.kill("SIGKILL")
      await first.exited
    }
    await firstErr
  }
}, 20_000)

test("the readiness layer also waits when Core starts its background importer concurrently", async () => {
  const input = await profile(100)
  await Effect.runPromise(
    Layer.build(Layer.merge(fenceLegacyEnginesLayer, V1Migration.layer)).pipe(
      Effect.provide(services(input.engineDatabase)),
      Effect.scoped,
    ),
  )
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")).toEqual([{ n: 100 }])
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 100 }])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='session'")).toEqual([])
})

test("an import failure does not turn the readiness wait into a failed start", async () => {
  const input = await profile(3)
  {
    using database = new SQLite(input.engineDatabase)
    database.run(`CREATE TRIGGER fail_import BEFORE INSERT ON session_v2
      WHEN NEW.id='ses_000002' BEGIN SELECT RAISE(ABORT,'interrupted import'); END`)
  }
  await Effect.runPromise(
    waitForLegacyImport({ log: () => {} }).pipe(Effect.provide(services(input.engineDatabase)), Effect.scoped),
  )
  expect(rows(input.engineDatabase, "SELECT id FROM session_v2")).toEqual([{ id: "ses_000003" }])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='session'")).toEqual([
    { name: "session" },
  ])
})

test("one start imports then cleans with no runtime connection across publication", async () => {
  const input = await profile(30)
  const steps: string[] = []
  const deadlines: number[] = []
  const deadline = Date.now() + 7 * 60_000
  await prepareDatabaseMaintenance({ ...input, deadline }, async (bounded, step) => {
    steps.push(step)
    deadlines.push(bounded.deadline!)
    if (step === "cleanup") {
      expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_v2")).toEqual([{ n: 30 }])
      // Both the preflight and import connections must have closed, including the child process.
      const { databaseHasHolders } = await import("@/arena/database-lease")
      expect(await databaseHasHolders(input.engineDatabase)).toBe(false)
    }
    return runDatabaseMaintenance(bounded, step)
  })
  expect(steps).toEqual(["import", "cleanup"])
  expect(deadlines).toEqual([deadline, deadline])
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"done"}' },
  ])
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 30 }])
  expect(
    rows(
      input.engineDatabase,
      "SELECT name FROM sqlite_master WHERE name IN ('session','message','part','_arena_v1_session')",
    ),
  ).toEqual([])
})

test("fresh and fully cleaned starts print nothing and spawn no child", async () => {
  for (const count of [0, 3]) {
    const input = await profile(count)
    if (count) await prepareDatabaseMaintenance(input)
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => {
      lines.push(line)
    }
    try {
      await prepareDatabaseMaintenance(input, async () => {
        throw new Error("unexpected child")
      })
    } finally {
      console.log = log
    }
    expect(lines).toEqual([])
  }
})

test("an expired import child leaves cleanup for later and runtime resumes in the background", async () => {
  const input = await profile(100)
  const steps: string[] = []
  await prepareDatabaseMaintenance({ ...input, deadline: Date.now() + 50 }, async (bounded, step) => {
    steps.push(step)
    return runDatabaseMaintenance(bounded, step)
  })
  expect(steps).toEqual(["import"])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='message'")).toHaveLength(1)
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* waitForLegacyImport({ deadline: 0, log: () => {} })
      const { db } = yield* Database.Service
      while (!(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name='_arena_v1_session'`)))
        yield* Effect.sleep(1)
    }).pipe(Effect.provide(services(input.engineDatabase)), Effect.scoped),
  )
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 100 }])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='message'")).toHaveLength(1)
})

test("import consumes the shared window; insufficient copy time defers cleanup to the next start", async () => {
  const input = await profile(3)
  const deadline = Date.now() + 30_000
  await prepareDatabaseMaintenance({ ...input, deadline })
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 3 }])
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"vacuum"}' },
  ])
  const steps: string[] = []
  await prepareDatabaseMaintenance(input, async (bounded, step) => {
    steps.push(step)
    return runDatabaseMaintenance(bounded, step)
  })
  expect(steps).toEqual(["cleanup"])
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"done"}' },
  ])
})

test("missing lease support still imports and fences", async () => {
  const input = await profile(3)
  await importLegacyDatabase(input, async () => undefined)
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 3 }])
  expect(rows(input.engineDatabase, "SELECT name FROM sqlite_master WHERE name='_arena_v1_session'")).toHaveLength(1)
})

test("a kill between the import and cleanup resumes with cleanup only", async () => {
  const input = await profile(3)
  const driver = path.join(input.root, "maintenance-driver.ts")
  const module = new URL("../../src/arena/database-upgrade.ts", import.meta.url).pathname
  await Bun.write(
    driver,
    `
    import { prepareDatabaseMaintenance, runDatabaseMaintenance } from ${JSON.stringify(module)};
    await prepareDatabaseMaintenance(${JSON.stringify(input)}, async (input, step) => {
      if (step === "cleanup") process.kill(process.pid, "SIGKILL");
      return runDatabaseMaintenance(input, step);
    });
  `,
  )
  const child = Bun.spawn([process.execPath, "--no-env-file", driver], { stdout: "pipe", stderr: "pipe" })
  const out = new Response(child.stdout).text()
  const err = new Response(child.stderr).text()
  expect(await child.exited).not.toBe(0)
  expect(child.signalCode).toBe("SIGKILL")
  await out
  await err
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 3 }])
  await prepareDatabaseMaintenance(input)
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"done"}' },
  ])
})

test("the default import and cleanup budget is eight minutes from spawn, not from each child", async () => {
  const input = await profile(3)
  const spawnedAt = Date.now() - process.uptime() * 1000
  const deadlines: number[] = []
  await prepareDatabaseMaintenance(input, async (bounded) => {
    deadlines.push(bounded.deadline!)
    return true
  })
  expect(deadlines).toHaveLength(2)
  expect(deadlines[0]).toBe(deadlines[1])
  expect(Math.abs(deadlines[0] - (spawnedAt + 480_000))).toBeLessThan(100)
})

test("a completed import interrupted before fencing still cleans up in this start", async () => {
  const input = await profile(3)
  await importLegacyDatabase(input)
  {
    using db = new SQLite(input.engineDatabase)
    db.run("ALTER TABLE _arena_v1_session RENAME TO session")
  }
  await prepareDatabaseMaintenance(input)
  expect(rows(input.engineDatabase, "SELECT value FROM kv WHERE key='arena.v1-cleanup'")).toEqual([
    { value: '{"phase":"done"}' },
  ])
  expect(rows(input.engineDatabase, "SELECT DISTINCT visits FROM import_visit")).toEqual([{ visits: 1 }])
  expect(rows(input.engineDatabase, "SELECT COUNT(*) AS n FROM session_message")).toEqual([{ n: 3 }])
})
