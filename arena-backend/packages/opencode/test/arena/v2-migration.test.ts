import { afterEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Exit, Effect, Layer, Scope } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ArenaRuntime } from "@/arena/runtime"
import { connectLocalStore } from "@/arena/local-store"
import type { ChatDocument } from "@/arena/records"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { Server } from "@/server/server"

const controlToken = "v2-migration-test"
const previousHome = process.env.PASEO_HOME
const previousArena = process.env.OPENCODE_ARENA
async function bootstrapCurrentDatabase(filename: string) {
  const scope = Scope.makeUnsafe()
  const layer = Database.layer({ path: filename }).pipe(
    Layer.provide(Layer.succeed(Global.Service, Global.make({ data: path.dirname(filename) }))),
  )
  try {
    await Effect.runPromise(Layer.buildWithScope(layer, scope))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

function legacySession(id: string, title: string, time: number) {
  return {
    id,
    project_id: "global",
    workspace_id: null,
    parent_id: null,
    fork_session_id: null,
    fork_boundary: null,
    slug: id,
    directory: "/tmp/arena-migration",
    path: null,
    title,
    version: "1",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: 2,
    tokens_input: 3,
    tokens_output: 4,
    tokens_reasoning: 5,
    tokens_cache_read: 6,
    tokens_cache_write: 7,
    revert: null,
    permission: null,
    agent: "build",
    model: JSON.stringify({ id: "contestant", providerID: "arena", variant: "high" }),
    time_created: time,
    time_updated: time + 1,
    time_compacting: null,
    time_archived: null,
  }
}

function insertLegacyRows(filename: string) {
  const database = new BunDatabase(filename)
  // Core's V1 migration reads these unprefixed tables from an existing current
  // database. They are intentionally created after the normal schema bootstrap
  // so the test exercises the same upgrade path as an installed V1 database.
  database.run(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      workspace_id text,
      parent_id text,
      slug text NOT NULL,
      directory text NOT NULL,
      path text,
      title text NOT NULL,
      version text NOT NULL,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      metadata text,
      cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      revert text,
      permission text,
      agent text,
      model text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_compacting integer,
      time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `)
  const insertSession = database.prepare(`
    INSERT INTO session (
      id, project_id, slug, directory, title, version, model, agent, time_created, time_updated
    ) VALUES ($id, $project, $slug, $directory, $title, $version, $model, $agent, $created, $updated)
  `)
  for (const value of [
    legacySession("ses_arena_canonical", "Canonical chat", 10),
    legacySession("ses_arena_contestant", "Contestant side", 20),
  ])
    insertSession.run({
      $id: value.id,
      $project: value.project_id,
      $slug: value.slug,
      $directory: value.directory,
      $title: value.title,
      $version: value.version,
      $model: value.model,
      $agent: value.agent,
      $created: value.time_created,
      $updated: value.time_updated,
    })
  const insertMessage = database.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($id, $session, $created, $updated, $data)",
  )
  const insertPart = database.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ($id, $message, $session, $created, $updated, $data)",
  )
  const addHistory = (sessionID: string, prefix: string, time: number) => {
    const userID = `msg_${prefix}_user`
    const assistantID = `msg_${prefix}_assistant`
    insertMessage.run({
      $id: userID,
      $session: sessionID,
      $created: time,
      $updated: time + 1,
      $data: JSON.stringify({
        role: "user",
        time: { created: time },
        agent: "build",
        model: { providerID: "arena", modelID: "contestant" },
      }),
    })
    insertMessage.run({
      $id: assistantID,
      $session: sessionID,
      $created: time + 2,
      $updated: time + 3,
      $data: JSON.stringify({
        role: "assistant",
        parentID: userID,
        time: { created: time + 2, completed: time + 4 },
        modelID: "contestant",
        providerID: "arena",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/arena-migration", root: "/tmp/arena-migration" },
        cost: 1,
        tokens: { total: 10, input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
        finish: "stop",
      }),
    })
    insertPart.run({
      $id: `prt_${prefix}_text`,
      $message: assistantID,
      $session: sessionID,
      $created: time + 2,
      $updated: time + 3,
      $data: JSON.stringify({ type: "text", text: `preserved ${prefix}` }),
    })
    insertPart.run({
      $id: `prt_${prefix}_reasoning`,
      $message: assistantID,
      $session: sessionID,
      $created: time + 2,
      $updated: time + 3,
      $data: JSON.stringify({
        type: "reasoning",
        text: "private reasoning",
        time: { start: time + 2, end: time + 3 },
      }),
    })
    insertPart.run({
      $id: `prt_${prefix}_tool`,
      $message: assistantID,
      $session: sessionID,
      $created: time + 2,
      $updated: time + 3,
      $data: JSON.stringify({
        type: "tool",
        callID: `${prefix}_call`,
        tool: "read",
        state: {
          status: "completed",
          input: { path: "README.md" },
          output: "tool output",
          title: "Read",
          metadata: { preserved: true },
          time: { start: time + 2, end: time + 3 },
          attachments: [
            {
              id: `prt_${prefix}_attachment`,
              sessionID,
              messageID: assistantID,
              type: "file",
              mime: "image/png",
              filename: "image.png",
              url: "data:image/png;base64,aGk=",
            },
          ],
        },
      }),
    })
  }
  addHistory("ses_arena_canonical", "canonical", 30)
  addHistory("ses_arena_contestant", "contestant", 40)
  database.close()
}

function chat(): ChatDocument {
  const now = new Date("2026-10-26T00:00:00Z")
  return {
    _id: "chat-migration",
    repository: { projectID: "global", root: "/tmp/arena-migration", branch: "main" },
    initialCanonicalSHA: "base",
    currentCanonicalSHA: "base",
    canonicalSessionID: "ses_arena_canonical",
    canonicalTranscriptVersion: 1,
    canonicalTranscriptHash: "migration-hash",
    turnCount: 0,
    status: "ready",
    agentDuelCommit: "migration-commit",
    agentDuelBuildNumber: 0,
    opencodeVersion: "migration-test",
    agentDuelVersion: "migration-test",
    configuration: {
      modelPool: "pool",
      agent: "agent",
      plugins: "plugins",
      mcp: "mcp",
      skills: "skills",
      tools: "tools",
      system: "system",
    },
    utilityPromptVersion: "utility",
    createdAt: now,
    updatedAt: now,
  }
}

describe("Arena v2 on-disk migration", () => {
  let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
  let home: string | undefined

  afterEach(async () => {
    if (listener) await listener.stop(true)
    listener = undefined
    await ArenaRuntime.closeStore()
    setArenaCredentials(undefined)
    if (previousHome === undefined) delete process.env.PASEO_HOME
    else process.env.PASEO_HOME = previousHome
    if (previousArena === undefined) delete process.env.OPENCODE_ARENA
    else process.env.OPENCODE_ARENA = previousArena
    if (home) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  test("boots over V1 rows, preserves canonical and contestant history, and keeps Arena refs", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-migration-"))
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    // Bootstrap the current schema first, then add the legacy V1 tables to the
    // same primary file. The restart below runs the durable V1 migration.
    const databasePath = path.join(home, "opencode.db")
    const arenaStore = await connectLocalStore({ directory: path.join(home, "arena") })
    await arenaStore.createChat(chat())
    await arenaStore.close()
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "test-only-key",
      controlTokenHash: hashArenaControlToken(controlToken),
    })

    await bootstrapCurrentDatabase(databasePath)
    insertLegacyRows(databasePath)

    listener = await Server.listen({
      hostname: "127.0.0.1",
      port: 0,
      database: { path: databasePath },
      fs: { filewatcher: false },
      models: { fetch: false },
    })

    const deadline = Date.now() + 15_000
    const sqlite = new BunDatabase(databasePath, { readonly: true })
    try {
      while (Date.now() < deadline) {
        const state = sqlite.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()
        if (state?.value === '{"phase":"completed"}') break
        await Bun.sleep(25)
      }
      expect(
        sqlite.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()?.value,
      ).toBe('{"phase":"completed"}')
      const sessions = sqlite
        .query<{ id: string }, []>("SELECT id FROM session_v2 WHERE id LIKE 'ses_arena_%' ORDER BY id")
        .all()
      expect(sessions.map((row) => row.id)).toEqual(["ses_arena_canonical", "ses_arena_contestant"])
      for (const sessionID of sessions.map((row) => row.id)) {
        const messages = sqlite
          .query<
            { type: string; data: string },
            [string]
          >("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
          .all(sessionID)
        const prefix = sessionID === "ses_arena_canonical" ? "canonical" : "contestant"
        expect(
          sqlite
            .query<{ id: string }, [string]>("SELECT id FROM session_message WHERE session_id = ? ORDER BY seq")
            .all(sessionID)
            .map((row) => row.id)
            .slice(0, 2),
        ).toEqual([`msg_${prefix}_user`, `msg_${prefix}_assistant`])
        expect(messages.map((row) => row.type)).toEqual(["user", "assistant", "system"])
        const assistant = JSON.parse(messages[1]!.data) as { content?: unknown[] }
        expect(assistant.content?.some((part) => JSON.stringify(part).includes("private reasoning"))).toBe(true)
        expect(assistant.content?.some((part) => JSON.stringify(part).includes("preserved"))).toBe(true)
        expect(assistant.content?.some((part) => JSON.stringify(part).includes("image.png"))).toBe(true)
      }
    } finally {
      sqlite.close()
    }

    const reopened = await ArenaRuntime.store()
    expect((await reopened.chat("chat-migration"))?.canonicalSessionID).toBe("ses_arena_canonical")
    const headers = { "x-paseo-control-token": controlToken }
    for (const sessionID of ["ses_arena_canonical", "ses_arena_contestant"]) {
      const response = await fetch(new URL(`/api/session/${sessionID}`, listener.url), { headers })
      expect(response.status).toBe(200)
      expect((await response.json()).data.id).toBe(sessionID)
    }
  }, 30_000)
})
