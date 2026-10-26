import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { Context as EffectContext, Effect } from "effect"
import type { SystemPart } from "@opencode/ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { ArenaRuntime } from "../runtime"
import { environment as previewForDirectory } from "../preview"
import { tmpDirectory } from "../contestant"
import { ArenaEngineAssignment, type ArenaAssignmentRegistry } from "./assignment"
import { ArenaEngineModels, CONTESTANT_IDENTITY, PROVIDER_ID, modelReference } from "./models"
import { promptCacheKey, requestHeaders, requestNeedsCompaction } from "./request"
import { ArenaEngineSandbox, previewEnvironment } from "./sandbox"
import type { ToolExecutionGate } from "./gate"
import { getArenaAutoAccept } from "./auto-accept"
import { readNetworkUnavailable } from "@agent-duel/arena-service/request-error"
import {
  toolExecutionProvider,
  toolExecutionWorktree,
  waitForToolExecution,
  type ToolExecution,
} from "../../session/tool-execution-gate"
import { SessionID } from "../../session/schema"

export interface ArenaEngineRuntimeOptions {
  /** Defaults to the process Arena runtime switch. */
  readonly enabled?: boolean | (() => boolean)
  /** Defaults to the process Arena assignment registry. */
  readonly assignments?: ArenaAssignmentRegistry
  /** Defaults to the in-process credential-bearing Arena proxy. */
  readonly contestantFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Returns the preview variables for the contestant worktree. */
  readonly previewEnvironment?: (sessionID: string, directory: string) => Readonly<Record<string, string | undefined>>
  /** Returns a staging gate for a contestant session, if worktree setup is still running. */
  readonly gate?: ToolExecutionGate | ((sessionID: string) => Effect.Effect<void>)
  /** Enables automatic permission approval for Arena runs. Questions are always left interactive. */
  readonly autoAccept?: boolean | ((sessionID: string) => boolean)
  /** Maximum silence between streamed model chunks. Defaults to the Arena 150-second bound. */
  readonly modelIdleTimeoutMs?: number
  /** Optional retry delay override for deterministic host-side recovery tests. */
  readonly retryDelayMs?: number
}

// The OpenRouter SDK requires a non-empty key before it calls its fetch override. Arena's proxy
// strips this sentinel and authenticates the upstream request inside contestantFetch.
const PROXY_KEY = "arena-local-proxy"

const CurrentToolSession = EffectContext.Reference<string | undefined>("agent-duel/ArenaToolSession", {
  defaultValue: () => undefined,
})

const defaultOptions: Required<Pick<ArenaEngineRuntimeOptions, "assignments" | "contestantFetch">> = {
  assignments: ArenaRuntime.registry,
  contestantFetch: ArenaRuntime.contestantFetch,
}

type InstalledOptions = ArenaEngineRuntimeOptions & typeof defaultOptions

function enabled(options: ArenaEngineRuntimeOptions) {
  return typeof options.enabled === "function" ? options.enabled() : (options.enabled ?? ArenaRuntime.enabled())
}

function autoAccept(options: ArenaEngineRuntimeOptions, sessionID: string) {
  return typeof options.autoAccept === "function"
    ? options.autoAccept(sessionID)
    : (options.autoAccept ?? getArenaAutoAccept(sessionID))
}

function arenaNetworkUnavailable(error: {
  readonly type: string
  readonly status?: number
  readonly response?: { readonly body: string }
}) {
  return error.type === "provider.internal" && error.status === 503 && readNetworkUnavailable(error.response?.body)
}

function stagedTool(tool: string, input: unknown): ToolExecution {
  const args = typeof input === "object" && input !== null ? { ...(input as Record<string, unknown>) } : {}
  if (tool === "shell") return { toolID: "bash", args }
  if (tool === "read" && args.filePath === undefined && typeof args.path === "string") args.filePath = args.path
  return { toolID: tool, args }
}

function arenaModel(ref: Model.Ref) {
  return String(ref.providerID) === String(PROVIDER_ID)
}

function arenaSession(options: ArenaEngineRuntimeOptions, sessionID: string) {
  return options.assignments?.assignments.has(sessionID) ?? false
}

function sessionModel(options: ArenaEngineRuntimeOptions, sessionID: string) {
  const assignment = options.assignments?.assignments.get(sessionID)
  return assignment?.modelSize === "medium" ? modelReference("medium") : modelReference(undefined)
}

function allowedArenaModel(value: unknown, expected: string) {
  return value === expected
}

function ensureAssignment(context: Context, options: InstalledOptions, sessionID: string) {
  if (arenaSession(options, sessionID)) return Effect.void
  return context.session.get({ sessionID: sessionID as Session.ID }).pipe(
    Effect.flatMap((session) =>
      session.parentID
        ? Effect.sync(() =>
            ArenaEngineAssignment.registerChildAssignment(options.assignments, session.id, session.parentID!),
          )
        : Effect.void,
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.asVoid,
  )
}

/**
 * Build the Arena extension against OpenCode's v2 plugin seams.
 *
 * The plugin owns only Arena-specific model routing and execution policy. Core still owns native
 * model/provider context, history replay, tool execution, and session persistence.
 */
export function createArenaEnginePlugin(options: ArenaEngineRuntimeOptions = {}) {
  const runtime = { ...defaultOptions, ...options }
  return define({
    id: "arena.engine-runtime",
    effect: (context) =>
      Effect.gen(function* () {
        if (!enabled(runtime)) return
        yield* install(context, runtime)
      }),
  })
}

export interface ArenaEnginePluginRegistry {
  readonly register: (plugin: ReturnType<typeof createArenaEnginePlugin>) => Effect.Effect<void>
}

/** Register the built-in plugin before the first Location graph is activated. */
export function registerArenaEnginePlugin(
  registry: ArenaEnginePluginRegistry,
  options: ArenaEngineRuntimeOptions = {},
) {
  return registry.register(createArenaEnginePlugin(options))
}

function install(context: Context, options: InstalledOptions) {
  return Effect.gen(function* () {
    yield* context.provider.transform((editor) => {
      if (editor.get(String(PROVIDER_ID))) return
      editor.add({ info: ArenaEngineModels.provider, models: ArenaEngineModels.models })
    })

    yield* context.aisdk.hook(
      "sdk",
      (event) =>
        Effect.sync(() => {
          if (!arenaModel(event.model)) return
          // DynamicProviderPlugin may already have created a provider before this built-in plugin
          // runs. Recreate it here so the credential-bearing fetch is captured by the provider
          // closure; mutating options alone would leave the native network fetch active.
          event.options.fetch = options.contestantFetch
          event.sdk = createOpenRouter({ ...event.options, apiKey: PROXY_KEY })
        }),
      { providerID: String(PROVIDER_ID) },
    )

    const identity = (event: { model: Model.Ref; system: SystemPart[] }) => {
      if (!arenaModel(event.model)) return
      // Replace model-family identity text. Native replay remains intact for user and tool
      // messages, while upstream provider branding cannot reach a blinded contestant.
      event.system = event.system.filter(
        (part) =>
          !/^You are powered by the model named .*\. The exact model ID is /s.test(part.text) &&
          !/^# Your Model\n(?:- (?:Name|Provider ID|Model ID):.*\n?){3}$/s.test(part.text),
      )
      if (!event.system.some((part) => part.text === CONTESTANT_IDENTITY)) {
        event.system.unshift({ type: "text", text: CONTESTANT_IDENTITY })
      }
    }
    yield* context.session.hook(
      "context",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(Effect.sync(() => identity(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    yield* context.session.hook(
      "compaction",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(Effect.sync(() => identity(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    yield* context.session.hook(
      "generate",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(Effect.sync(() => identity(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    yield* context.session.hook(
      "context",
      (event) =>
        Effect.sync(() => {
          if (!arenaModel(event.model)) return
          // OpenRouter uses the provider option to retain the prompt prefix between calls. Keep
          // the cache key opaque and stable for the session while preserving the native options.
          event.options.promptCacheKey = promptCacheKey(String(event.sessionID))
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook(
      "model.request",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(
            context.session.get({ sessionID: event.sessionID }).pipe(
              Effect.map((session) => {
                const assignment = options.assignments?.assignments.get(String(event.sessionID))
                event.headers = {
                  ...event.headers,
                  ...requestHeaders({
                    sessionID: String(event.sessionID),
                    kind: event.kind,
                    parentSessionID: session.parentID,
                    rootSessionID: assignment?.rootSessionID,
                  }),
                }
                if (arenaSession(options, String(event.sessionID)))
                  event.chunkTimeout = options.modelIdleTimeoutMs ?? 150_000
              }),
              Effect.orElseSucceed(() => undefined),
            ),
          ),
        ),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook(
      "preflight",
      (event) =>
        Effect.sync(() => {
          if (!arenaSession(options, String(event.sessionID)) || event.kind !== "primary") return
          if (requestNeedsCompaction(event.request)) event.decision = "compact"
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook("prompt", (event) =>
      context.session.get({ sessionID: event.sessionID }).pipe(
        Effect.flatMap((session) =>
          session.parentID
            ? Effect.sync(() =>
                ArenaEngineAssignment.registerChildAssignment(options.assignments, session.id, session.parentID!),
              )
            : Effect.void,
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    )

    yield* context.session.hook(
      "retry",
      (event) =>
        Effect.sync(() => {
          if (!arenaSession(options, String(event.sessionID))) return
          const offline = arenaNetworkUnavailable(event.error)
          if (offline) {
            event.decision = {
              retry: true,
              delay: Math.min(Math.max(event.decision.retry ? event.decision.delay : 2_000, 2_000), 10_000),
              persistent: true,
              message: "Waiting for network",
            }
            return
          }
          if (event.decision.persistent)
            event.decision = {
              retry: true,
              delay: event.decision.delay,
              persistent: false,
            }
          if (options.retryDelayMs !== undefined && event.decision.retry) event.decision.delay = options.retryDelayMs
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        if (!autoAccept(options, String(event.sessionID)) || !arenaSession(options, String(event.sessionID))) return
        if (event.effect === "deny") return
        if (/^question(?:$|[.:/])/.test(event.action)) return
        event.effect = "allow"
      }),
    )

    yield* context.shell.hook("create.before", (event) =>
      Effect.gen(function* () {
        // Core invokes shell hooks before its tool callback sets OPENCODE_SESSION_ID.
        // Carry the session through the tool effect so concurrent calls and descendants
        // receive their own preview variables and temp directory.
        const sessionID = (yield* CurrentToolSession) ?? event.env.OPENCODE_SESSION_ID
        if (!sessionID || !arenaSession(options, sessionID)) return
        const worktree = toolExecutionWorktree(SessionID.make(sessionID)) ?? event.cwd
        Object.assign(event.env, previewForDirectory(worktree, process.env, event.cwd))
        Object.assign(event.env, options.previewEnvironment?.(sessionID, event.cwd) ?? previewEnvironment(sessionID))
        yield* Effect.promise(() => mkdir(tmpDirectory(sessionID), { recursive: true }))
      }),
    )

    yield* context.tool.hook("execute.before", (event) => {
      if (!arenaSession(options, String(event.sessionID))) return Effect.void
      if (typeof options.gate === "function") return options.gate(String(event.sessionID))
      if (options.gate) return options.gate.wait(String(event.sessionID))
      return Effect.promise(() =>
        waitForToolExecution(String(event.sessionID) as SessionID, stagedTool(event.tool, event.input)),
      )
    })

    // The built-in subagent tool accepts an explicit model override. Pin Arena descendants to the
    // opaque model and bounded reasoning while leaving ordinary sessions untouched.
    yield* context.tool.transform((editor) => {
      const subagent = editor.get("subagent")
      if (!subagent) return
      editor.update("subagent", (tool) => {
        const execute = tool.execute
        tool.execute = (input, call) => {
          if (!arenaSession(options, String(call.sessionID)) || typeof input !== "object" || input === null)
            return execute(input, call)
          const params = input as Record<string, unknown>
          const expected = sessionModel(options, String(call.sessionID))
          const model = allowedArenaModel(params.model, expected) ? params.model : expected
          return execute({ ...params, model }, call)
        }
      })
    })

    // Core's v2 execute.before hook can hold a call while a contestant checkout is staged, but
    // it cannot change the runtime that owns the tool effect. Wrap registered executors so calls
    // hosted by the canonical instance run through the contestant's ToolExecutionProvider.
    yield* context.tool.transform((editor) => {
      if (typeof editor.list !== "function") return
      for (const info of editor.list()) {
        const original = info.execute
        editor.update(info.id, (tool) => {
          tool.execute = (input, call) => {
            const sessionID = String(call.sessionID)
            if (!arenaSession(options, sessionID)) return original(input, call)
            return Effect.gen(function* () {
              yield* Effect.promise(() => waitForToolExecution(sessionID as SessionID, stagedTool(info.name, input)))
              const provide = toolExecutionProvider(SessionID.make(sessionID))
              const execute = original(input, call).pipe(Effect.provideService(CurrentToolSession, sessionID))
              return yield* provide ? provide(execute) : execute
            })
          }
        })
      }
    })

    // A model request ID is intentionally generated at the request boundary. This keeps request
    // headers unique while preserving provider state and native context replay in Core.
    yield* context.session.hook(
      "http.request",
      (event) =>
        Effect.sync(() => {
          if (!arenaModel(event.model)) return
          event.request.headers.set(
            "x-arena-request-id",
            event.request.headers.get("x-arena-request-id") ?? randomUUID(),
          )
        }),
      { providerID: String(PROVIDER_ID) },
    )
  })
}

export function contestantPermissionsForSession(
  source: Parameters<typeof ArenaEngineSandbox.permissionRules>[0],
  sandbox: Parameters<typeof ArenaEngineSandbox.permissionRules>[1],
) {
  return ArenaEngineSandbox.permissionRules(source, sandbox)
}

export const ArenaEnginePlugin = { create: createArenaEnginePlugin }

export * as ArenaEngineRuntime from "./plugin.js"
