import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Context as EffectContext, Effect, Stream } from "effect"
import type { Message, SystemPart } from "@opencode/ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { AISDK } from "@opencode/core/aisdk"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { contestantShellInput, contestantShellTimeoutMessage, shellNotification } from "./shell"
import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { reasoningContext } from "../reasoning"
import { ArenaRuntime } from "../runtime"
import { environment as previewForDirectory } from "../preview"
import { tmpDirectory } from "../contestant"
import { ArenaEngineAssignment, type ArenaAssignmentRegistry } from "./assignment"
import { ArenaEngineModels, CONTESTANT_IDENTITY, PROVIDER_ID, modelReference } from "./models"
import { OUTPUT_TOKEN_LIMIT } from "../model-profile"
import {
  canCompactHistory,
  compactionResponse,
  classification,
  promptCacheKey,
  requestHeaders,
  requestNeedsCompaction,
  sessionRequestIDs,
} from "./request"
import { COMPACTION_HEADER, COMPACTION_OFFER } from "@agent-duel/arena-service/request-budget"
import { ArenaPorts } from "../ports"
import { ArenaEngineSandbox, previewEnvironment } from "./sandbox"
import type { ToolExecutionGate } from "./gate"
import { getArenaAutoAccept } from "./auto-accept"
import { askOutsideProject, isTrusted, shellOutsideDirectories } from "./outside-project"
import { battlePathDenial, battleToolInput } from "./battle-sandbox"
import {
  readNetworkUnavailable,
  readSessionRejected,
  SESSION_REJECTED_RETRY_MESSAGE,
} from "@agent-duel/arena-service/request-error"
import { withHeldToolCalls } from "./tool-stream"
import { MODEL_IDLE_TIMEOUT_MS } from "../model-idle"
import { ArenaResponseRecovery } from "../response-recovery"
import { idleBudgetFetch, idleExhausted, idleTimeout, resetIdleBudget } from "./idle"
import { ArenaShellLedger } from "./shell-ledger"
import {
  toolExecutionProvider,
  toolExecutionWorktree,
  waitForToolExecution,
  type ToolExecution,
} from "../../session/tool-execution-gate"
import { SessionID } from "../../session/schema"
import { GlobalBus } from "../../bus/global"

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
  /** Maximum time between streamed model events; heartbeat comments do not count. Defaults to 150 seconds. */
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

// Only the matching shell call has already checked cwd, cd and writes as one request.
const CheckedShell = EffectContext.Reference<string | undefined>("agent-duel/CheckedShell", {
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

// The control plane refused the user's session. Only a new sign-in fixes it, and the daemon then
// forwards the new session, so the contestant waits as it does for the network.
function arenaSessionRejected(error: { readonly status?: number; readonly response?: { readonly body: string } }) {
  return error.status === 401 && readSessionRejected(error.response?.body)
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

function capOutput(event: { model: Model.Ref; options: { maxTokens?: number } }) {
  if (!arenaModel(event.model)) return
  event.options.maxTokens = Math.min(event.options.maxTokens ?? OUTPUT_TOKEN_LIMIT, OUTPUT_TOKEN_LIMIT)
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

function ensureAssignment(context: Context, options: InstalledOptions, sessionID: string): Effect.Effect<void> {
  if (arenaSession(options, sessionID)) return Effect.void
  return context.session.get({ sessionID: sessionID as Session.ID }).pipe(
    Effect.flatMap((session) =>
      session.parentID
        ? ensureAssignment(context, options, String(session.parentID)).pipe(
            Effect.andThen(
              Effect.sync(() =>
                ArenaEngineAssignment.registerChildAssignment(options.assignments, session.id, session.parentID!),
              ),
            ),
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
    // Arena owns session locations and worktree lifecycle, including with Battle off.
    yield* context.tool.transform((editor) => {
      editor.namespace({ name: "opencode", description: "Tools for reading MCP resources." })
      const blocked = [
        "session_rename",
        "session_move",
        "worktree_create",
        "worktree_list",
        "worktree_remove",
        "models",
      ]
      for (const tool of editor.list()) {
        if (tool.options?.namespace === "opencode" && blocked.includes(tool.name)) editor.remove(tool.id)
      }
    })
    // Core's OpenCodeTools hooks run first. Remove only their worktree advice; tool removal
    // already keeps the Code Mode catalog and execute's callable inventory in agreement.
    for (const name of ["context", "compaction", "generate"] as const) {
      yield* context.session.hook(name, (event) =>
        Effect.sync(() => {
          event.system = event.system.filter(
            (part) =>
              part.text !==
              "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.",
          )
        }),
      )
    }

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
          // Wrap it in Core's provider fetch: it owns the header timeout and the SSE chunk deadline,
          // which moves only on parsed events, so heartbeat comments cannot hide a stalled model.
          // As in 1.x, one bound covers both the wait for headers and each silence after them.
          // The header deadline is ours (see `idleBudgetFetch`), so Core's is turned off.
          const idle = options.modelIdleTimeoutMs ?? MODEL_IDLE_TIMEOUT_MS
          event.options.fetch = idleBudgetFetch(
            AISDK.providerFetch(
              { ...event.model, settings: { ...event.model.settings, headerTimeout: false, chunkTimeout: idle } },
              options.contestantFetch,
            ),
            {
              headerTimeoutMs: idle,
              // Only the contestant's own model requests count, as in 1.x; not titles or compaction.
              mainSession: (headers) => {
                const sessionID = headers.get("x-arena-session-id")
                if (!sessionID || headers.get("x-arena-generation-classification") !== classification("primary")) return
                return { sessionID, rootSessionID: headers.get("x-arena-root-session-id") ?? sessionID }
              },
            },
          )
          event.sdk = createOpenRouter({ ...event.options, apiKey: PROXY_KEY })
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.aisdk.hook(
      "language",
      (event) =>
        Effect.sync(() => {
          if (!arenaModel(event.model)) return
          event.language = withHeldToolCalls(
            event.sdk.languageModel(event.model.modelID ?? event.model.id),
            (sessionID) => {
              GlobalBus.emit("event", {
                directory: "",
                payload: { type: "arena.model.activity", properties: { sessionID } },
              })
            },
          )
        }),
      { providerID: String(PROVIDER_ID) },
    )

    const prepareContext = (event: {
      model: Model.Ref
      system: SystemPart[]
      messages: Message[]
      sessionID: Session.ID
    }) => {
      if (!arenaModel(event.model)) return
      event.messages = reasoningContext(
        event.messages,
        options.assignments.assignments.get(String(event.sessionID))?.reasoningFromMessageID,
      )
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
          Effect.andThen(Effect.sync(() => prepareContext(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    yield* context.session.hook(
      "compaction",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(Effect.sync(() => prepareContext(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    yield* context.session.hook(
      "generate",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(Effect.sync(() => prepareContext(event))),
          Effect.andThen(Effect.sync(() => capOutput(event))),
        ),
      {
        providerID: String(PROVIDER_ID),
      },
    )
    // Core sends no output limit for titles and generate requests, so the provider would reserve the
    // drawn model's whole output. Primary and compaction requests already carry the catalog limit.
    yield* context.session.hook("title", (event) => Effect.sync(() => capOutput(event)), {
      providerID: String(PROVIDER_ID),
    })
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
      "compaction",
      (event) =>
        Effect.sync(() => {
          if (arenaModel(event.model)) event.preservePendingInput = true
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook(
      "model.request",
      (event) =>
        ensureAssignment(context, options, String(event.sessionID)).pipe(
          Effect.andThen(
            Effect.all({
              session: context.session.get({ sessionID: event.sessionID }),
              history:
                event.kind === "primary"
                  ? context.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => []))
                  : Effect.succeed([]),
            }).pipe(
              Effect.map(({ session, history }) => {
                const assignment = options.assignments?.assignments.get(String(event.sessionID))
                event.headers = {
                  ...event.headers,
                  ...requestHeaders({
                    sessionID: String(event.sessionID),
                    kind: event.kind,
                    parentSessionID: session.parentID,
                    rootSessionID: assignment?.rootSessionID,
                    requestID: sessionRequestIDs.next(String(event.sessionID), event.kind),
                    arenaCompaction: canCompactHistory(history),
                  }),
                }
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
          if (
            event.request.http?.headers?.[COMPACTION_HEADER] === COMPACTION_OFFER &&
            requestNeedsCompaction(event.request)
          )
            event.decision = "compact"
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook(
      "http.response",
      (event) =>
        Effect.promise(async () => {
          event.response = await compactionResponse(event.response, event.request, event.kind)
        }),
      { providerID: String(PROVIDER_ID) },
    )

    yield* context.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        // A new prompt starts a new turn, and with it a new model-timeout budget (1.x counted from
        // the last real user message).
        resetIdleBudget(String(event.sessionID))
        const session = yield* context.session.get({ sessionID: event.sessionID })
        if (session.parentID)
          ArenaEngineAssignment.registerChildAssignment(options.assignments, session.id, session.parentID)
      }).pipe(Effect.orElseSucceed(() => undefined)),
    )

    yield* context.session.hook(
      "retry",
      (event) =>
        Effect.sync(() => {
          if (!arenaSession(options, String(event.sessionID))) return
          const offline = arenaNetworkUnavailable(event.error)
          const signedOut = !offline && arenaSessionRejected(event.error)
          if (offline || signedOut) {
            event.decision = {
              retry: true,
              delay: Math.min(Math.max(event.decision.retry ? event.decision.delay : 2_000, 2_000), 10_000),
              persistent: true,
              message: offline ? "Waiting for network" : SESSION_REJECTED_RETRY_MESSAGE,
            }
            return
          }
          if (event.decision.persistent)
            event.decision = {
              retry: true,
              delay: event.decision.delay,
              persistent: false,
            }
          if (idleExhausted(event.error)) {
            event.decision = { retry: false }
            return
          }
          if (event.decision.retry && idleTimeout(event.error))
            event.decision.message = ArenaResponseRecovery.IDLE_RECOVERING
          if (options.retryDelayMs !== undefined && event.decision.retry) event.decision.delay = options.retryDelayMs
        }),
      { providerID: String(PROVIDER_ID) },
    )

    // Registered after the Arena retry policy above, so it sees the final decision. A retried
    // request keeps its request ID, which is how telemetry counts the retry.
    yield* context.session.hook(
      "retry",
      (event) =>
        Effect.sync(() => {
          if (arenaSession(options, String(event.sessionID)) && event.decision.retry)
            sessionRequestIDs.retryScheduled(String(event.sessionID), event.decision.delay)
        }),
      { providerID: String(PROVIDER_ID) },
    )
    // A prompt to a subagent session is a new task from its parent, so a retry its last step decided
    // but never sent is over. A prompt to a root session is a steer, and its pending retry still runs;
    // a new turn starts a new run, which telemetry links nothing across.
    yield* context.session.hook("prompt", (event) =>
      context.session.get({ sessionID: event.sessionID }).pipe(
        Effect.map((session) => {
          if (session.parentID) sessionRequestIDs.reset(String(event.sessionID))
        }),
        Effect.orElseSucceed(() => undefined),
      ),
    )

    yield* context.agent.transform((editor) => {
      for (const agent of editor.list()) editor.update(agent.id, (item) => askOutsideProject(item.permissions))
    })

    yield* context.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        yield* ensureAssignment(context, options, String(event.sessionID))
        if (
          options.assignments.assignments.get(String(event.sessionID))?.telemetry &&
          ["edit", "read", "external_directory"].includes(event.action)
        ) {
          const session = yield* context.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
          const operation = event.action === "edit" ? "write" : "read"
          const message = event.resources
            .map((resource) =>
              battlePathDenial(session.permissions ?? [], operation, resource, context.location.directory),
            )
            .find((message) => message !== undefined)
          if (message) {
            event.effect = "deny"
            event.message = message
            return
          }
          // There is no voter to answer a filesystem permission request for a side.
          if (event.effect === "ask") {
            event.effect = "deny"
            event.message = "Arena contestants cannot request approval for filesystem access."
          }
          return
        }
        if (event.action === "external_directory" && event.effect === "ask") {
          const checked = yield* CheckedShell
          if (event.source?.type === "tool" && checked === `${event.sessionID}:${event.source.id}`) {
            event.effect = "allow"
            return
          }
          const skills = yield* context.skill.list().pipe(
            Effect.map((result) => result.data.map((skill) => String(skill.path))),
            Effect.orElseSucceed((): string[] => []),
          )
          if (isTrusted(event.resources, skills)) event.effect = "allow"
        }
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
        const assignment = options.assignments.assignments.get(sessionID)
        const owner = assignment?.telemetry ? assignment.rootSessionID : sessionID
        Object.assign(event.env, options.previewEnvironment?.(owner, event.cwd) ?? previewEnvironment(owner))
        yield* Effect.promise(() => mkdir(tmpDirectory(owner), { recursive: true }))
      }),
    )

    // Core spawns each shell as its own process group, so one outlives an engine that dies without
    // teardown. Keep them on disk for the next start to stop (`stopOrphanShells`). Every shell counts,
    // since a chat with Battle off runs its commands here as well.
    // Read now, so the first shell's record does not wait for it.
    yield* Effect.promise(() => ArenaShellLedger.engineOwner().catch(() => undefined))
    yield* context.event.subscribe().pipe(
      Stream.runForEach((event) => {
        const directory = ArenaRuntime.shellLedgerDirectory()
        const change =
          event.type === "shell.created"
            ? () => ArenaShellLedger.recordShell(directory, event.data.info)
            : event.type === "shell.exited" || event.type === "shell.deleted"
              ? () => ArenaShellLedger.releaseShell(directory, event.data.id)
              : undefined
        if (!change) return Effect.void
        return Effect.tryPromise(change).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Arena could not update the shell ledger", { cause })),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Check the whole shell call before execution. Core's independent cd scan resolves every cd
    // from the initial cwd, so its duplicate asks are suppressed only within this executor.
    yield* context.tool.transform((editor) => {
      if (!editor.get("shell")) return
      editor.update("shell", (tool) => {
        const execute = tool.execute
        tool.execute = (input, call) => {
          const params = input as { readonly command?: unknown; readonly workdir?: unknown }
          if (typeof params.command !== "string") return execute(input, call)
          const command = params.command
          return Effect.gen(function* () {
            const sessionID = String(call.sessionID)
            if (arenaSession(options, sessionID)) {
              // A failed lookup refuses nothing, matching the legacy shell policy.
              const refusal = yield* Effect.tryPromise(async () => {
                const environment = await ArenaPorts.environment(await ArenaRuntime.store(), sessionID)
                return environment ? ArenaPorts.violation(environment, command) : undefined
              }).pipe(Effect.orElseSucceed(() => undefined))
              if (refusal) return yield* new Tool.Error({ message: refusal })
            }
            const assignment = options.assignments.assignments.get(sessionID)
            if (assignment?.telemetry) {
              return yield* execute(contestantShellInput(input as Record<string, unknown>), call).pipe(
                Effect.provideService(ShellTool.Notification, shellNotification(assignment.rootSessionID)),
                Effect.provideService(ShellTool.TimeoutMessage, contestantShellTimeoutMessage),
              )
            }
            const { directory, project } = context.location
            const cwd = path.resolve(directory, typeof params.workdir === "string" ? params.workdir : ".")
            const resources = yield* Effect.promise(() =>
              shellOutsideDirectories(command, cwd, [directory, project.directory]),
            )
            if (resources.length)
              yield* context.permission.assert({
                action: "external_directory",
                resources,
                save: resources,
                sessionID: call.sessionID,
                agent: call.agent,
                source: { type: "tool", messageID: call.messageID, id: call.id },
              })
            return yield* execute(input, call).pipe(Effect.provideService(CheckedShell, `${call.sessionID}:${call.id}`))
          })
        }
      })
    })

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

    // Core tools capture Location when built; providing another layer cannot rehost them.
    // Resolve battle paths against the side before calling them, and check writes independently
    // of Core's location-relative permission names. Descendants use the root side's gate and paths.
    yield* context.tool.transform((editor) => {
      if (typeof editor.list !== "function") return
      for (const info of editor.list()) {
        const original = info.execute
        editor.update(info.id, (tool) => {
          tool.execute = (input, call) => {
            const sessionID = String(call.sessionID)
            return Effect.gen(function* () {
              yield* ensureAssignment(context, options, sessionID)
              if (!arenaSession(options, sessionID)) return yield* original(input, call)
              const assignment = options.assignments.assignments.get(sessionID)!
              const owner = assignment.telemetry ? assignment.rootSessionID : sessionID
              yield* Effect.promise(() => waitForToolExecution(SessionID.make(owner), stagedTool(info.name, input)))
              let params = input
              if (assignment.telemetry) {
                const session = yield* context.session
                  .get({ sessionID: call.sessionID })
                  .pipe(
                    Effect.mapError(() => new Tool.Error({ message: "Arena could not load the contestant sandbox." })),
                  )
                const root =
                  owner === sessionID
                    ? session
                    : yield* context.session
                        .get({ sessionID: owner as Session.ID })
                        .pipe(
                          Effect.mapError(
                            () => new Tool.Error({ message: "Arena could not load the contestant sandbox." }),
                          ),
                        )
                const directory = toolExecutionWorktree(SessionID.make(owner)) ?? root.location.directory
                params = yield* battleToolInput({
                  tool: info.name,
                  args: input,
                  directory,
                  rules: root.permissions ?? [],
                })
              }
              const provide = toolExecutionProvider(SessionID.make(owner))
              const execute = original(params, call).pipe(Effect.provideService(CurrentToolSession, sessionID))
              return yield* provide ? provide(execute) : execute
            })
          }
        })
      }
    })

    // `model.request` sets the request ID, and its retries reuse it. This covers a request that did
    // not pass through that hook, without touching provider state or native context replay in Core.
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
