import { describe, expect, it } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpServer } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Session as CoreSession } from "@opencode/core/session"
import { AssignmentRegistry } from "@/arena/proxy"
import { clearToolExecutionEnvironment, gateToolExecution } from "@/session/tool-execution-gate"
import { SessionID } from "@/session/schema"
import { createArenaEnginePlugin, toolEnvironment } from "@/arena/engine-runtime"

type Side = "a" | "b"

const sideConfig = {
  a: {
    port: "56101",
    port2: "56102",
    port3: "56103",
    url: "http://turn-a.localhost:6771",
  },
  b: {
    port: "56201",
    port2: "56202",
    port3: "56203",
    url: "http://turn-b.localhost:6771",
  },
} as const

function shellResponse(sessionID: string, side: Side, request: number) {
  if (request > 1) {
    return [
      `data: ${JSON.stringify({
        id: `response-${sessionID}`,
        choices: [{ index: 0, delta: { content: `shell environment ${side} verified` }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: `response-${sessionID}`,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n")
  }

  const command =
    'printf "%s\\n" "HOST=$HOST" "PORT=$PORT" "PASEO_PORT=$PASEO_PORT" "PASEO_PORT2=$PASEO_PORT2" "PASEO_PORT3=$PASEO_PORT3" "ARENA_PREVIEW_URL=$ARENA_PREVIEW_URL" "TMPDIR=$TMPDIR" "TMP=$TMP" "TEMP=$TEMP" "OPENCODE_SESSION_ID=$OPENCODE_SESSION_ID"'
  const argumentsJSON = JSON.stringify({ command })
  return [
    `data: ${JSON.stringify({
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
                function: { name: "shell", arguments: argumentsJSON },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: `response-${sessionID}`,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n")
}

describe("Arena V2 shell environment", () => {
  it("isolates preview and temp variables for concurrent assigned sessions", async () => {
    const assignments = new AssignmentRegistry()
    const requests = new Map<string, number>()
    const sessionSides = new Map<string, Side>()
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const incoming = new Request(request)
          const sessionID = incoming.headers.get("x-arena-session-id")
          if (!sessionID) return new Response("missing session", { status: 400 })
          await incoming.json()
          const side = sessionSides.get(sessionID)
          if (!side) return new Response("unknown session", { status: 400 })
          if (incoming.headers.get("x-arena-generation-classification") !== "generation")
            return new Response(shellResponse(sessionID, side, 2), {
              headers: { "content-type": "text/event-stream" },
            })
          const count = (requests.get(sessionID) ?? 0) + 1
          requests.set(sessionID, count)
          return new Response(shellResponse(sessionID, side, count), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })

      const scope = Scope.makeUnsafe()
      const sessionIDs: string[] = []
      try {
        const extension = Layer.effectDiscard(
          Effect.gen(function* () {
            const sdk = yield* SdkPlugins.Service
            yield* sdk.register(
              createArenaEnginePlugin({
                enabled: true,
                assignments,
                autoAccept: true,
                previewEnvironment: (sessionID, _directory) => {
                  const side = sessionSides.get(sessionID)
                  if (!side) throw new Error(`missing test side for ${sessionID}`)
                  const config = sideConfig[side]
                  return toolEnvironment(sessionID, {
                    HOST: "127.0.0.1",
                    PORT: config.port,
                    PASEO_PORT: config.port,
                    PASEO_PORT2: config.port2,
                    PASEO_PORT3: config.port3,
                    ARENA_PREVIEW_URL: config.url,
                  })
                },
                contestantFetch: async (input, init) => {
                  const incoming = new Request(input, init)
                  const headers = new Headers(incoming.headers)
                  headers.delete("authorization")
                  return fetch(server!.url, {
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
        const infos = await Promise.all(
          (["a", "b"] as const).map((side) =>
            Effect.runPromise(
              sessions.create({
                location: { directory: import.meta.dir },
                model: { providerID: "arena", id: "contestant", variant: "high" },
              }),
            ).then((info) => ({ info, side })),
          ),
        )

        for (const { info, side } of infos) {
          sessionIDs.push(info.id)
          sessionSides.set(info.id, side)
          assignments.assign(info.id, {
            runID: `run-${info.id}`,
            rootSessionID: info.id,
            scopeID: `scope-${info.id}`,
            assignmentID: `assignment-${info.id}`,
            telemetry: false,
          })
          const gate = gateToolExecution(SessionID.make(info.id), {
            worktree: import.meta.dir,
            copiedPaths: [],
            provide: (effect) => effect,
          })
          gate.release()
        }

        await Promise.all(
          infos.map(({ info }) =>
            Effect.runPromise(
              sessions.prompt({ sessionID: info.id, text: "print the Arena environment", resume: true }),
            ),
          ),
        )
        await Promise.all(
          infos.map(({ info }) => Effect.runPromise(sessions.wait(info.id).pipe(Effect.timeout("15 seconds")))),
        )

        const outputs = new Map<string, string>()
        const tempDirectories = new Set<string>()
        for (const { info, side } of infos) {
          const messages = await Effect.runPromise(sessions.messages({ sessionID: info.id, order: "asc" }))
          const tool = messages
            .flatMap((message) => (message.type === "assistant" ? message.content : []))
            .find((part) => part.type === "tool" && part.name === "shell")
          if (!tool || tool.type !== "tool" || tool.state.status !== "completed")
            throw new Error(`completed shell tool missing for ${side}`)
          const output = tool.state.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          outputs.set(info.id, output)
          const tempDirectory = output
            .split("\n")
            .find((line) => line.startsWith("TMPDIR="))
            ?.slice(7)
          expect(tempDirectory?.endsWith(path.join("arena", info.id))).toBe(true)
          if (tempDirectory) tempDirectories.add(tempDirectory)
          const config = sideConfig[side]
          const expected = toolEnvironment(info.id, {
            HOST: "127.0.0.1",
            PORT: config.port,
            PASEO_PORT: config.port,
            PASEO_PORT2: config.port2,
            PASEO_PORT3: config.port3,
            ARENA_PREVIEW_URL: config.url,
          })
          for (const [key, value] of Object.entries(expected)) expect(output).toContain(`${key}=${value}`)
          expect(output).toContain(`OPENCODE_SESSION_ID=${info.id}`)
        }

        const [first, second] = sessionIDs.map((id) => outputs.get(id) ?? "")
        expect(first).not.toContain("PASEO_PORT=56201")
        expect(second).not.toContain("PASEO_PORT=56101")
        expect(new Set(sessionIDs).size).toBe(2)
        expect(tempDirectories.size).toBe(2)
      } finally {
        for (const sessionID of sessionIDs) clearToolExecutionEnvironment(SessionID.make(sessionID))
        await Effect.runPromise(Scope.close(scope, Exit.void))
        for (const sessionID of sessionIDs)
          await rm(toolEnvironment(sessionID).TMPDIR, { recursive: true, force: true })
      }
    } finally {
      server?.stop(true)
    }
  }, 30_000)
})
