import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import { AssignmentRegistry } from "@/arena/proxy"
import { ArenaRuntime } from "@/arena/runtime"
import { createArenaEnginePlugin } from "@/arena/engine-runtime"
import { parseRecord, type ShellRecord } from "@/arena/engine-runtime/shell-ledger"
import { clearToolExecutionEnvironment, gateToolExecution } from "@/session/tool-execution-gate"
import { SessionID } from "@/session/schema"

function stream(sessionID: string, request: number, command: string) {
  const chunks =
    request === 1
      ? [
          {
            id: `response-${sessionID}`,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${sessionID}`,
                      type: "function",
                      function: { name: "shell", arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: `response-${sessionID}`, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { id: `response-${sessionID}`, choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
          { id: `response-${sessionID}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n")
}

describe("Arena shell ledger through Core", () => {
  it("records a running shell's process and releases it when the shell exits", async () => {
    const assignments = new AssignmentRegistry()
    const requests = new Map<string, number>()
    // The shell runs until the test has seen its record, so a slow start cannot make it miss the shell.
    const release = path.join(await mkdtemp(path.join(tmpdir(), "arena-shell-ledger-")), "release")
    const command = `until [ -e "${release}" ]; do sleep 0.05; done`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = new Request(request)
        const sessionID = incoming.headers.get("x-arena-session-id") ?? ""
        await incoming.json()
        const generation = incoming.headers.get("x-arena-generation-classification") === "generation"
        const count = generation ? (requests.get(sessionID) ?? 0) + 1 : 2
        if (generation) requests.set(sessionID, count)
        return new Response(stream(sessionID, count, command), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const scope = Scope.makeUnsafe()
    const ledger = ArenaRuntime.shellLedgerDirectory()
    let sessionID: string | undefined
    try {
      const extension = Layer.effectDiscard(
        Effect.gen(function* () {
          const sdk = yield* SdkPlugins.Service
          yield* sdk.register(
            createArenaEnginePlugin({
              enabled: true,
              assignments,
              autoAccept: true,
              previewEnvironment: () => ({}),
              contestantFetch: async (input, init) => {
                const incoming = new Request(input, init)
                const headers = new Headers(incoming.headers)
                headers.delete("authorization")
                return fetch(server.url, {
                  method: incoming.method,
                  headers,
                  body: incoming.body,
                  duplex: "half",
                } as RequestInit)
              },
            }),
          )
        }),
      )
      const context = await Effect.runPromise(
        Layer.buildWithScope(
          createRoutes(
            {
              app: { version: "test" },
              database: { path: ":memory:" },
              fs: { filewatcher: false },
              models: { fetch: false },
            },
            () => [],
            [],
            extension,
          ).pipe(Layer.provide(HttpServer.layerServices)),
          scope,
        ),
      )
      const sessions = Context.get(context, CoreSession.Service)
      const info = await Effect.runPromise(
        sessions.create({
          location: { directory: import.meta.dir },
          model: { providerID: "arena", id: "contestant", variant: "high" },
        }),
      )
      sessionID = info.id
      assignments.assign(info.id, {
        runID: `run-${info.id}`,
        rootSessionID: info.id,
        scopeID: `scope-${info.id}`,
        assignmentID: `assignment-${info.id}`,
        telemetry: false,
      })
      gateToolExecution(SessionID.make(info.id), {
        worktree: import.meta.dir,
        copiedPaths: [],
        provide: (effect) => effect,
      }).release()

      await Effect.runPromise(sessions.prompt({ sessionID: info.id, text: "sleep", resume: true }))

      let record: ShellRecord | undefined
      for (let i = 0; i < 3_000 && !record; i++) {
        const [name] = await readdir(ledger).catch(() => [] as string[])
        if (name) record = parseRecord(await readFile(path.join(ledger, name), "utf8"))
        if (!record) await Bun.sleep(20)
      }
      expect(record?.pid).toBeGreaterThan(0)
      expect(record?.owner.pid).toBe(process.pid)
      expect(() => process.kill(record!.pid, 0)).not.toThrow()

      await writeFile(release, "")
      await Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("60 seconds")))
      for (let i = 0; i < 1_500 && (await readdir(ledger)).length > 0; i++) await Bun.sleep(20)
      expect(await readdir(ledger)).toEqual([])
    } finally {
      await writeFile(release, "")
      if (sessionID) clearToolExecutionEnvironment(SessionID.make(sessionID))
      await Effect.runPromise(Scope.close(scope, Exit.void))
      server.stop(true)
    }
  }, 120_000)
})
