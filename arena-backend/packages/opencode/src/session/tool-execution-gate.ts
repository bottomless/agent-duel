import type { SessionID } from "./schema"
import path from "path"
import { lstat, realpath } from "fs/promises"
import type { Effect } from "effect"

/** Runs an effect in the contestant's own instance rather than the one hosting its request. */
export type ToolExecutionProvider = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

export type PendingEnvironment = {
  readonly worktree: string
  readonly copiedPaths: readonly string[]
  readonly removedPaths?: readonly string[]
  /** Set when the session's request is hosted by another instance, such as the canonical checkout's. */
  readonly provide?: ToolExecutionProvider
}

export type ToolExecution = {
  readonly toolID: string
  readonly args: Record<string, unknown>
}

type PendingGate = {
  state: "pending" | "released" | "failed"
  error?: unknown
  /** `base` until the tracked and untracked checkout exists, then `ignored` until the copy ends. */
  phase: "base" | "ignored"
  readonly basePromise: Promise<void>
  readonly promise: Promise<void>
  readonly release: () => void
  readonly fail: (error: unknown) => void
  environment: PendingEnvironment
}

const gates = new Map<SessionID, PendingGate>()
// Outlives the gate: a request hosted elsewhere keeps running its tools in the contestant instance.
const environments = new Map<SessionID, PendingEnvironment>()

const ENVIRONMENT_INDEPENDENT_TOOLS = new Set(["invalid", "question", "todowrite", "webfetch", "websearch"])
const READ_ONLY_GIT_COMMANDS = new Set(["diff", "log", "ls-files", "rev-parse", "show", "status"])

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function resolvedToolPath(environment: PendingEnvironment, value: unknown) {
  if (typeof value !== "string") return undefined
  return path.isAbsolute(value) ? value : path.resolve(environment.worktree, value)
}

function pendingRoots(environment: PendingEnvironment) {
  return [...environment.copiedPaths, ...(environment.removedPaths ?? [])].map((relativePath) =>
    path.resolve(environment.worktree, relativePath),
  )
}

async function physicalPath(candidate: string): Promise<string | undefined> {
  let current = candidate
  while (true) {
    try {
      return path.join(await realpath(current), path.relative(current, candidate))
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined
      // Missing descendants are expected during copying. A dangling link has an unknown
      // destination, so it cannot be treated as an ordinary missing path.
      try {
        if ((await lstat(current)).isSymbolicLink()) return undefined
      } catch (statError) {
        if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") return undefined
      }
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

async function touchesCopiedPath(environment: PendingEnvironment, candidate: string, includeAncestors: boolean) {
  const roots = pendingRoots(environment)
  if (roots.some((root) => isInside(root, candidate) || (includeAncestors && isInside(candidate, root)))) return true
  const [resolved, ...resolvedRoots] = await Promise.all([candidate, ...roots].map(physicalPath))
  if (!resolved || resolvedRoots.some((root) => !root)) return true
  return resolvedRoots.some(
    (root) => root !== undefined && (isInside(root, resolved) || (includeAncestors && isInside(resolved, root))),
  )
}

// `-i`, and `-o` without the standard excludes, list ignored files. `-k` lists files that clash
// with the index, which can include ignored ones. Short options bundle, as in `-io`.
function listsIgnoredFiles(options: readonly string[]) {
  const longOption = (option: string, name: string) => {
    const key = option.split("=", 1)[0]
    return key.length > 2 && name.startsWith(key)
  }
  const shortOption = (option: string, letters: string) =>
    /^-[^-]/u.test(option) && [...option.slice(1)].some((letter) => letters.includes(letter))
  if (
    options.some(
      (option) => shortOption(option, "ik") || longOption(option, "--ignored") || longOption(option, "--killed"),
    )
  )
    return true
  const others = options.some((option) => shortOption(option, "o") || longOption(option, "--others"))
  return others && !options.includes("--exclude-standard")
}

async function safeReadOnlyShell(args: Record<string, unknown>, environment: PendingEnvironment) {
  const workdir = resolvedToolPath(environment, args.workdir) ?? environment.worktree
  if (await touchesCopiedPath(environment, workdir, false)) return false
  if (typeof args.command !== "string") return false
  const command = args.command.trim()
  if (command === "pwd") return true
  // Quoted or escaped words need shell parsing before options can be classified.
  if (/[;&|`$()<>\n\r'"\\]/u.test(command)) return false
  const words = command.split(/\s+/u)
  if (words[0] !== "git" || !READ_ONLY_GIT_COMMANDS.has(words[1] ?? "")) return false
  if (words.some((word) => word.startsWith("--ignored") || word === "--no-index" || word === "--ext-diff")) return false
  if (words[1] === "ls-files" && listsIgnoredFiles(words.slice(2))) return false
  // Git accepts unambiguous long-option abbreviations as well as --output=<path>.
  if (
    words.some((word) => {
      const option = word.split("=", 1)[0]
      return option.length > 2 && "--output".startsWith(option)
    })
  )
    return false
  return true
}

/** Whether a tool is provably independent of ignored content still being copied. */
export async function canExecuteDuringEnvironmentSetup(environment: PendingEnvironment, execution: ToolExecution) {
  if (ENVIRONMENT_INDEPENDENT_TOOLS.has(execution.toolID)) return true

  if (execution.toolID === "bash") return safeReadOnlyShell(execution.args, environment)

  if (execution.toolID === "read") {
    const candidate = resolvedToolPath(environment, execution.args.filePath)
    return !!candidate && !(await touchesCopiedPath(environment, candidate, true))
  }

  if (execution.toolID === "glob" || execution.toolID === "grep") {
    const candidate = resolvedToolPath(environment, execution.args.path) ?? environment.worktree
    // Explicit glob patterns can override ignore files, so searches above a pending root
    // must wait too. Searches confined to unrelated directories can still run.
    return !(await touchesCopiedPath(environment, candidate, true))
  }

  // Mutations can trigger project formatters or language servers. Those and custom, MCP,
  // subagent, patch, and orchestration tools are opaque here, so they wait unless promoted
  // to one of the explicit policies above.
  return false
}

/**
 * Hold tool execution while an Arena worktree finishes becoming usable.
 *
 * Until `baseReady`, the worktree may not exist at all, so only tools with no filesystem
 * dependency run. After it, the tools `canExecuteDuringEnvironmentSetup` proves independent of
 * the pending ignored content run too, and everything else waits for `release`.
 */
export function gateToolExecution(sessionID: SessionID, environment: PendingEnvironment) {
  if (gates.has(sessionID)) throw new Error(`Tool execution is already gated for ${sessionID}`)
  let resolveBase!: () => void
  let rejectBase!: (error: unknown) => void
  const basePromise = new Promise<void>((onResolve, onReject) => {
    resolveBase = onResolve
    rejectBase = onReject
  })
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  // Setup can fail before the model asks for a gated tool. Keep the rejection observable by
  // future waiters without turning that valid race into an unhandled-rejection process error.
  void basePromise.catch(() => undefined)
  void promise.catch(() => undefined)
  const gate: PendingGate = {
    state: "pending",
    phase: "base",
    basePromise,
    promise,
    release: () => {
      if (gate.state !== "pending") return
      gate.state = "released"
      gate.phase = "ignored"
      gates.delete(sessionID)
      resolveBase()
      resolve()
    },
    fail: (error) => {
      if (gate.state !== "pending") return
      gate.state = "failed"
      gate.error = error
      rejectBase(error)
      reject(error)
    },
    environment,
  }
  gates.set(sessionID, gate)
  environments.set(sessionID, environment)
  return {
    /** Settles when the base checkout exists; rejects when setup fails first. */
    base: basePromise,
    /** Roots the sync will remove are known only once it has planned; they stay held too. */
    baseReady: (removedPaths?: readonly string[]) => {
      if (gate.state !== "pending" || gate.phase !== "base") return
      if (removedPaths) {
        gate.environment = { ...gate.environment, removedPaths }
        if (environments.get(sessionID) === environment) environments.set(sessionID, gate.environment)
      }
      gate.phase = "ignored"
      resolveBase()
    },
    release: gate.release,
    fail: gate.fail,
    // The owner disposes only after the session's execution has settled.
    dispose: () => {
      gate.fail(new Error("Environment setup gate disposed"))
      if (gates.get(sessionID) === gate) gates.delete(sessionID)
      if (environments.get(sessionID) === gate.environment) environments.delete(sessionID)
    },
  }
}

export function isToolExecutionGated(sessionID: SessionID) {
  return gates.has(sessionID)
}

/** The contestant worktree of a session whose request another instance hosts. */
export function toolExecutionWorktree(sessionID: SessionID) {
  const environment = environments.get(sessionID)
  return environment?.provide ? environment.worktree : undefined
}

/**
 * Name the contestant's copies of files a hosted request found in its host checkout, such as
 * instruction files and skills. Paths already inside the contestant worktree are left alone.
 */
export function relocateHostPaths(text: string, host: string, worktree: string) {
  if (host === worktree) return text
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const nested = isInside(host, worktree) ? worktree.slice(host.length) : undefined
  const pattern = new RegExp(`${escape(host)}${nested ? `(?!${escape(nested)})` : ""}(?=[\\/]|$|[^\\w.-])`, "gu")
  return text.replace(pattern, () => worktree)
}

export function toolExecutionProvider(sessionID: SessionID) {
  return environments.get(sessionID)?.provide
}

/** The environment a tool may run in now; undefined while the base checkout does not exist. */
export function readyToolExecutionEnvironment(sessionID: SessionID) {
  if (gates.get(sessionID)?.phase === "base") return undefined
  return environments.get(sessionID)
}

export function clearToolExecutionEnvironment(sessionID: SessionID) {
  gates.get(sessionID)?.fail(new Error(`Tool execution environment was cleared for ${sessionID}`))
  gates.delete(sessionID)
  environments.delete(sessionID)
}

/**
 * Throw when setup failed after a tool passed the gate. Taking the snapshot can outlast the
 * copy, so a tool allowed early must not then run against an environment that failed.
 */
export function assertToolExecutionUsable(sessionID: SessionID, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason
  const gate = gates.get(sessionID)
  if (gate?.state === "failed") throw gate.error
}

async function mayRunNow(gate: PendingGate, execution: ToolExecution) {
  if (gate.phase === "base") return ENVIRONMENT_INDEPENDENT_TOOLS.has(execution.toolID)
  return await canExecuteDuringEnvironmentSetup(gate.environment, execution)
}

export async function waitForToolExecution(sessionID: SessionID, execution: ToolExecution, signal?: AbortSignal) {
  const gate = gates.get(sessionID)
  if (!gate) return
  const phase = gate.phase
  const independent = await mayRunNow(gate, execution)
  // Setup may fail while the asynchronous path checks are running.
  if (independent && gate.state !== "failed") return
  // A read held for the base checkout is checked again once it exists: it may then run early.
  const pending = phase === "base" && !independent ? gate.basePromise : gate.promise
  await abortable(pending, signal)
  if (pending === gate.basePromise) return await waitForToolExecution(sessionID, execution, signal)
}

async function abortable(pending: Promise<void>, signal?: AbortSignal) {
  if (!signal) return await pending
  if (signal.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    void pending.then(
      () => {
        signal.removeEventListener("abort", aborted)
        resolve()
      },
      (error) => {
        signal.removeEventListener("abort", aborted)
        reject(error)
      },
    )
  })
}
