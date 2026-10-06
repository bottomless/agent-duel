import { createHash } from "node:crypto"
import path from "node:path"
import type { CopyOmission, EnvironmentTransition, TransitionStoppedCommand, CapturedService } from "./records"
import type { ServiceStopRecord } from "./services"

const MAX_VALUE_BYTES = 512

export type TransitionSummary = {
  readonly commandsStopped: number
  readonly commandsAlreadyAbsent: number
  readonly stopFailures: number
  readonly listenersReleased: number
  readonly pathsOmitted: number
}

export type DurableEnvironmentTransition = EnvironmentTransition & {
  readonly summary: TransitionSummary
}

export type EnvironmentTransitionInput = {
  readonly id?: string
  readonly previousWinningRunID: string
  readonly stoppedCommands?: readonly (TransitionStoppedCommand | ServiceStopRecord)[]
  readonly services?: readonly CapturedService[]
  readonly stopRecords?: readonly ServiceStopRecord[]
  readonly copyOmissions?: readonly CopyOmission[]
  readonly createdAt?: Date
}

function bounded(value: string, limit = MAX_VALUE_BYTES) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return Buffer.byteLength(normalized) <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function portsFor(service: CapturedService) {
  const ports = service.listeners.map((listener) => listener.port)
  for (const value of Object.values(service.env)) {
    for (const match of value.matchAll(/(?:^|[:=])([0-9]{2,5})(?=$|\D)/g)) {
      const port = Number(match[1])
      if (port > 0 && port <= 65_535) ports.push(port)
    }
  }
  return [...new Set(ports)]
}

function redactAbsolutePaths(value: string) {
  // Commands are retained as useful diagnostics, but host paths must not become a durable
  // cross-machine artifact. Keep relative project paths; collapse absolute path components.
  return value.replace(/(?:^|\s)(\/(?:[^\s/:]+\/){1,}[^\s:]*)/g, (whole, absolute: string) => {
    const prefix = whole.slice(0, whole.indexOf(absolute))
    return `${prefix}<path>`
  })
}

function redactPort(value: string, ports: readonly number[]) {
  let result = value
  // Handle the common forms first so a port number in a command remains understandable.
  result = result.replace(/((?:--?port|PORT|DEV_SERVER_PORT|SERVER_PORT)(?:=|\s+))([0-9]{1,5})/gi, "$1{port}")
  result = result.replace(/(https?:\/\/[^\s/:]+:)([0-9]{1,5})/gi, "$1{port}")
  for (const port of ports) {
    result = result.replace(new RegExp(`(?<!\\d)${port}(?!\\d)`, "g"), "{port}")
  }
  // A stop error or a manually written command can contain a listener number without
  // structured service metadata. Four- and five-digit numbers are the bounded port range
  // that can occur in those diagnostics; redact them conservatively as well.
  result = result.replace(/\b\d{4,5}\b/g, "{port}")
  return result
}

function safeCommand(command: string, args: readonly string[], ports: readonly number[]) {
  return {
    command: bounded(redactPort(redactAbsolutePaths(command), ports)),
    args: args.slice(0, 128).map((arg) => bounded(redactPort(redactAbsolutePaths(arg), ports))),
  }
}

function safeRelativeCwd(value: string) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"))
  if (normalized === "." || normalized === "") return "."
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return "<path>"
  return bounded(normalized)
}

function safeListeners(service: CapturedService) {
  return service.listeners.slice(0, 64).map((listener) =>
    listener.alias ? { alias: bounded(listener.alias, 64) } : {},
  )
}

function safeStoppedListeners(command: TransitionStoppedCommand) {
  return (command.listeners ?? []).slice(0, 64).map((listener) =>
    listener.alias ? { alias: bounded(listener.alias, 64) } : {},
  )
}

function fromService(service: CapturedService): TransitionStoppedCommand {
  const command = safeCommand(service.command, service.args, portsFor(service))
  const listeners = safeListeners(service)
  return {
    command: [command.command, ...command.args].join(" "),
    relativeCwd: safeRelativeCwd(service.relativeCwd),
    status: "stopped",
    verified: true,
    ...(listeners.length > 0 ? { listeners } : {}),
  }
}

function fromStopRecord(record: TransitionStoppedCommand | ServiceStopRecord): TransitionStoppedCommand {
  if ("captured" in record) {
    const service = record.captured
    const command = safeCommand(service.command, service.args, portsFor(service))
    const listeners = safeListeners(service)
    return {
      command: [command.command, ...command.args].join(" "),
      relativeCwd: safeRelativeCwd(record.relativeCwd),
      status: record.status,
      verified: record.verified,
      ...(listeners.length > 0 ? { listeners } : {}),
      ...(record.error ? { error: safeCommand(record.error, [], []).command } : {}),
    }
  }
  const command = safeCommand(record.command, [], [])
  const listeners = safeStoppedListeners(record)
  return {
    command: command.command,
    relativeCwd: safeRelativeCwd(record.relativeCwd),
    status: record.status,
    verified: record.verified,
    ...(listeners.length > 0 ? { listeners } : {}),
    ...(record.error ? { error: safeCommand(record.error, [], []).command } : {}),
  }
}

function safeOmission(omission: CopyOmission): CopyOmission {
  const relativePath = omission.relativePath.replaceAll("\\", "/")
  return {
    relativePath: safeRelativeCwd(relativePath),
    fileType: omission.fileType,
    logicalBytes: omission.logicalBytes,
    sourceIdentity: bounded(redactAbsolutePaths(omission.sourceIdentity)),
    ...(omission.omissionReason ? { omissionReason: omission.omissionReason } : {}),
  }
}

function stableID(input: Omit<EnvironmentTransitionInput, "id" | "createdAt">, createdAt: Date) {
  return `transition-${createHash("sha256").update(JSON.stringify({
    previousWinningRunID: input.previousWinningRunID,
    stoppedCommands: input.stoppedCommands,
    services: input.services,
    stopRecords: input.stopRecords,
    copyOmissions: input.copyOmissions,
    createdAt: createdAt.toISOString(),
  })).digest("hex").slice(0, 24)}`
}

/** Build one redacted, winner-derived event for both next-turn contestants. */
export function buildEnvironmentTransition(input: EnvironmentTransitionInput): DurableEnvironmentTransition {
  const createdAt = input.createdAt ?? new Date()
  const records = [
    ...(input.stopRecords ?? []),
    ...(input.stoppedCommands ?? []),
    ...(input.stopRecords || input.stoppedCommands ? [] : (input.services ?? []).map(fromService)),
  ].map(fromStopRecord)
  const stoppedCommands = [...new Map(records.map((record) => [JSON.stringify(record), record])).values()].sort((a, b) =>
    `${a.relativeCwd}\u0000${a.command}\u0000${a.status}`.localeCompare(`${b.relativeCwd}\u0000${b.command}\u0000${b.status}`),
  )
  const copyOmissions = [...new Map((input.copyOmissions ?? []).map((omission) => {
    const safe = safeOmission(omission)
    return [JSON.stringify(safe), safe] as const
  })).values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const summary = {
    commandsStopped: stoppedCommands.filter((record) => record.status === "stopped").length,
    commandsAlreadyAbsent: stoppedCommands.filter((record) => record.status === "already_absent").length,
    stopFailures: stoppedCommands.filter((record) => record.status === "failed").length,
    listenersReleased: stoppedCommands
      .filter((record) => record.status === "stopped" && record.verified)
      .reduce((total, record) => total + (record.listeners?.length ?? 0), 0),
    pathsOmitted: copyOmissions.length,
  } satisfies TransitionSummary
  return {
    id: input.id ?? stableID(input, createdAt),
    previousWinningRunID: bounded(input.previousWinningRunID, 256),
    stoppedCommands,
    copyOmissions,
    createdAt,
    summary,
  }
}

export const createEnvironmentTransition = buildEnvironmentTransition
export const transitionEvent = buildEnvironmentTransition

export * as ArenaTransition from "./transition"
