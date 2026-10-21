import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./ports.txt"
import { ArenaPorts } from "@/arena/ports"
import { ArenaRuntime } from "@/arena/runtime"

export const Parameters = Schema.Struct({
  port: Schema.optional(Schema.Number).annotate({
    description: "A port number from earlier messages to translate, such as 54012",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "A URL from earlier messages to translate, such as a preview URL or http://localhost:54012/",
  }),
})

/** The tool inputs that reach a port: a shell command (which covers `open URL`) and a fetched URL. */
const PORT_INPUTS: Readonly<Record<string, string>> = { bash: "command", webfetch: "url" }

/**
 * The note for a contestant's `bash` or `webfetch` call that names a retired port or preview host
 * of its chat. It is new output; the stored history is never rewritten. A failed lookup adds
 * nothing rather than failing the call.
 */
export function retiredPortNote(sessionID: string, toolID: string, args: Record<string, unknown>) {
  const field = PORT_INPUTS[toolID]
  const input = field ? args[field] : undefined
  if (typeof input !== "string" || !ArenaRuntime.enabled()) return Effect.succeed(undefined)
  return Effect.tryPromise(async () => {
    const history = await ArenaPorts.portHistory(await ArenaRuntime.store(), sessionID)
    return history ? ArenaPorts.note(history, input) : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))
}

/**
 * Arena contestants only (gated in the registry). Answers from the run that owns the calling
 * session, so a subagent gets its parent's environment.
 */
export const PortsTool = Tool.define(
  "ports",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const history = ArenaRuntime.enabled()
          ? await ArenaPorts.portHistory(await ArenaRuntime.store(), ctx.sessionID)
          : undefined
        if (!history) {
          return { title: "ports", output: "This session has no Arena port environment.", metadata: {} }
        }
        const answers = [
          ...(params.port !== undefined ? [await ArenaPorts.translatePort(history, params.port)] : []),
          ...(params.url !== undefined ? [await ArenaPorts.translateUrl(history, params.url)] : []),
        ]
        const output = answers.length ? answers.join("\n\n") : await ArenaPorts.describe(history)
        const title = params.port !== undefined ? String(params.port) : (params.url ?? "current ports")
        return { title, output, metadata: {} }
      }),
  }),
)
