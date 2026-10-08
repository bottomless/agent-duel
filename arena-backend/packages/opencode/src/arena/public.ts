import { Schema } from "effect"
import { basename } from "path"
import type { Resolution, Side } from "./domain"
import { ArenaActiveOperation } from "./operation-tracker"
import type { BattleSnapshot, HiddenAssignment, RunDocument } from "./records"
import { ArenaSchema } from "./schema"
import { runPaymentMessage } from "@agent-duel/arena-service/request-error"

export type PublicIdentity = {
  readonly name: string
}

type PublicCopyOmission = {
  readonly relativePath: string
  readonly omissionReason?: string
}

type PublicTransition = {
  readonly id: string
  readonly previousWinningRunID: string
  readonly stoppedCommands: readonly {
    readonly command: string
    readonly relativeCwd: string
    readonly status: "stopped" | "already_absent" | "failed"
    readonly verified: boolean
    readonly listeners?: readonly { readonly alias?: string }[]
    readonly error?: string
  }[]
  readonly copyOmissions: readonly PublicCopyOmission[]
  readonly summary: {
    readonly commandsStopped: number
    readonly commandsAlreadyAbsent: number
    readonly stopFailures: number
    readonly listenersReleased: number
    readonly pathsOmitted: number
  }
  readonly createdAt: Date
}

export type PublicRun = {
  readonly id: string
  readonly side: Side
  readonly sessionID: string
  readonly descendantSessionIDs: readonly string[]
  readonly worktree: string
  readonly worktreeName: string
  readonly branchAtRun?: string
  readonly worktreeActive: boolean
  readonly copyOmissions?: readonly PublicCopyOmission[]
  readonly portAliases?: RunDocument["portAliases"]
  readonly services?: readonly {
    readonly kind?: "owned_process"
    readonly command: string
    readonly relativeCwd: string
    readonly listeners: readonly { readonly port: number; readonly alias?: string }[]
    readonly proxyRoutes: readonly {
      readonly hostname: string
      readonly url?: string
      readonly port?: number
      readonly alias?: string
      readonly active: boolean
    }[]
  }[]
  readonly retention?: RunDocument["retention"]
  readonly runState: RunDocument["runState"]
  readonly error?: string
  readonly startedAt?: Date
  readonly firstEventAt?: Date
  readonly lastEventAt?: Date
  readonly completedAt?: Date
  readonly durationMs: number | null
  readonly promptMessageID?: string
  readonly diff?: RunDocument["diff"]
  readonly finalCommit?: string
  readonly finalTree?: string
  readonly permanentRef?: string
  readonly selectable: boolean
  readonly applicable: boolean
  readonly identity?: PublicIdentity
  readonly messages?: readonly unknown[]
  readonly parts?: Readonly<Record<string, readonly unknown[]>>
  readonly status?: unknown
  readonly permissions?: readonly unknown[]
  readonly questions?: readonly unknown[]
}

function identity(assignment: HiddenAssignment): PublicIdentity {
  if (!assignment.model) throw new Error("Arena contestant identity was not revealed")
  return { name: assignment.model }
}

function resolution(value: Resolution): Resolution {
  if (value.kind !== "stopped") return value
  return {
    kind: value.kind,
    resolution: value.resolution,
    ...(value.appliedSide === "a" || value.appliedSide === "b" ? { appliedSide: value.appliedSide } : {}),
  }
}

function copyOmissions(values: RunDocument["copyOmissions"]): readonly PublicCopyOmission[] | undefined {
  if (!values) return undefined
  return values.map(({ relativePath, omissionReason }) => ({
    relativePath: safeRelativePath(relativePath),
    ...(omissionReason ? { omissionReason } : {}),
  }))
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return "<path>"
  return normalized || "."
}

function transition(value: NonNullable<NonNullable<BattleSnapshot["turn"]>["transitionEvent"]>): PublicTransition {
  const summary = {
    commandsStopped: value.stoppedCommands.filter((command) => command.status === "stopped").length,
    commandsAlreadyAbsent: value.stoppedCommands.filter((command) => command.status === "already_absent").length,
    stopFailures: value.stoppedCommands.filter((command) => command.status === "failed").length,
    listenersReleased: value.stoppedCommands
      .filter((command) => command.status === "stopped" && command.verified)
      .reduce((total, command) => total + (command.listeners?.length ?? 0), 0),
    pathsOmitted: value.copyOmissions.length,
  }
  return {
    id: value.id,
    previousWinningRunID: value.previousWinningRunID,
    stoppedCommands: value.stoppedCommands.map((command) => ({
      command: command.command,
      relativeCwd: command.relativeCwd,
      status: command.status,
      verified: command.verified,
      ...(command.listeners?.length
        ? { listeners: command.listeners.map((listener) => ({ ...(listener.alias ? { alias: listener.alias } : {}) })) }
        : {}),
      ...(command.error ? { error: command.error } : {}),
    })),
    copyOmissions: value.copyOmissions.map(({ relativePath, omissionReason }) => ({
      relativePath: safeRelativePath(relativePath),
      ...(omissionReason ? { omissionReason } : {}),
    })),
    summary,
    createdAt: value.createdAt,
  }
}

const omitted = Symbol("arena-json-omitted")

function normalize(value: unknown, ancestors: WeakSet<object>): unknown | typeof omitted {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return value.toString()
  if (["undefined", "function", "symbol"].includes(typeof value)) return omitted
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value !== "object") return omitted
  if (ancestors.has(value)) return omitted
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        try {
          const item = normalize(value[index], ancestors)
          return item === omitted ? null : item
        } catch {
          return null
        }
      })
    }
    return Object.fromEntries(
      Object.keys(value).flatMap((key) => {
        try {
          const item = normalize((value as Record<string, unknown>)[key], ancestors)
          return item === omitted ? [] : ([[key, item]] as const)
        } catch {
          return []
        }
      }),
    )
  } catch {
    return omitted
  } finally {
    ancestors.delete(value)
  }
}

export function jsonValue(value: unknown): unknown {
  try {
    const normalized = normalize(value, new WeakSet())
    return normalized === omitted ? null : normalized
  } catch {
    return null
  }
}

export function parseSnapshot(value: unknown): ArenaSchema.Snapshot {
  return Schema.decodeUnknownSync(ArenaSchema.Snapshot)(value)
}

const ACTIVE_TURN_STATES = new Set([
  "creating",
  "worktrees_ready",
  "running",
  "early_selected",
  "applying",
  "canonicalizing",
  "cleanup_pending",
])

export function project(snapshot: BattleSnapshot) {
  const turn = snapshot.turn
  const revealed = turn?.resolution !== undefined
  // Progress is stored on the turn, so it can hold a step name from an older or newer build. The
  // snapshot schema accepts only this build's names, and one unknown name would fail the snapshot.
  const operationProgress = turn?.operationProgress?.filter(
    (entry) =>
      ArenaActiveOperation.includes(entry.operation) &&
      (entry.state !== "running" || ACTIVE_TURN_STATES.has(turn.state)),
  )
  const selected = turn?.appliedSide ? snapshot.runs.find((run) => run.side === turn.appliedSide) : undefined
  const trunkBranch = snapshot.chat.canonicalCheckout?.branch ?? snapshot.chat.arenaBranch
  const retained = snapshot.chat.retainedWinner
    ? snapshot.runs.find((run) => run._id === snapshot.chat.retainedWinner?.runID)
    : undefined
  // Before its first turn, a chat holds the pair that turn will use.
  const warm = turn ? turn.warmPreparation : snapshot.chat.initialWarmPreparation
  const projection = {
    chat: {
      id: snapshot.chat._id,
      status: snapshot.chat.status,
      canonicalSessionID: snapshot.chat.canonicalSessionID,
      canonicalSHA: snapshot.chat.currentCanonicalSHA,
      ...(snapshot.chat.blockedReason ? { blockedReason: snapshot.chat.blockedReason } : {}),
      ...(snapshot.chat.trunkConflicts?.length ? { trunkConflicts: snapshot.chat.trunkConflicts } : {}),
      trunk: {
        worktreeName: basename(snapshot.chat.repository.root),
        ...(trunkBranch ? { branch: trunkBranch } : {}),
      },
      ...(snapshot.chat.activeTurnID ? { activeTurnID: snapshot.chat.activeTurnID } : {}),
    },
    environment: {
      ...(retained && snapshot.chat.retainedWinner
        ? {
            retainedWinner: {
              runID: retained._id,
              side: retained.side,
              worktreeName: retained.worktreeName ?? basename(retained.worktree),
              ...(retained.branchAtRun ? { branch: retained.branchAtRun } : {}),
              state: snapshot.chat.retainedWinner.state,
            },
          }
        : {}),
      ...(warm
        ? {
            warmPair: {
              generation: warm.generation,
              state: warm.state,
              sides: (["a", "b"] as const).flatMap((side) => {
                const worktree = warm.worktrees[side]
                if (!worktree) return []
                return [
                  {
                    side,
                    worktreeName: worktree.name || basename(worktree.directory),
                    ...(worktree.branch ? { branch: worktree.branch } : {}),
                    ready: worktree.ready,
                  },
                ]
              }),
              ...(warm.error ? { error: warm.error } : {}),
            },
          }
        : {}),
    },
    ...(snapshot.singleAgentRating?.completedAt
      ? {
          singleAgent: {
            id: snapshot.singleAgentRating._id,
            revealed: snapshot.singleAgentRating.vote !== undefined,
            ...(snapshot.singleAgentRating.vote ? { vote: snapshot.singleAgentRating.vote } : {}),
            ...(snapshot.singleAgentRating.vote ? { identity: identity(snapshot.singleAgentRating.assignment) } : {}),
          },
        }
      : {}),
    ...(turn
      ? {
          turn: {
            id: turn._id,
            index: turn.turnIndex,
            prompt: turn.userPrompt,
            ...(turn.userAttachments?.length
              ? { attachments: turn.userAttachments.map(({ kind, label }) => ({ kind, label })) }
              : {}),
            baseSHA: turn.frozenBaseSHA,
            state: turn.state,
            comparisonState: turn.comparisonState,
            ...(operationProgress?.length ? { operationProgress } : {}),
            ...(ACTIVE_TURN_STATES.has(turn.state) && turn.activeOperations?.length
              ? {
                  activeOperations: turn.activeOperations.filter((operation) =>
                    ArenaActiveOperation.includes(operation),
                  ),
                }
              : {}),
            ...(turn.resolution ? { resolution: resolution(turn.resolution) } : {}),
            ...(turn.vote ? { vote: turn.vote } : {}),
            ...(turn.selectedEarly === undefined ? {} : { selectedEarly: turn.selectedEarly }),
            ...(turn.appliedSide ? { appliedSide: turn.appliedSide } : {}),
            ...(turn.canonicalUserMessageID ? { canonicalUserMessageID: turn.canonicalUserMessageID } : {}),
            ...(turn.gitApplication ? { gitApplication: turn.gitApplication } : {}),
            ...(turn.transitionEvent ? { transition: transition(turn.transitionEvent) } : {}),
            ...(revealed ? { identities: { a: identity(turn.placement.a), b: identity(turn.placement.b) } } : {}),
            canVote: turn.state === "awaiting_vote",
            canRetryResolution:
              turn.state === "canonicalization_failed" ||
              (turn.state === "application_failed" &&
                !!selected?.finalCommit &&
                turn.gitApplication?.state !== "blocked"),
            // Discarding is open while nothing of the winner is in the checkout.
            canDiscardWinner:
              turn.state === "application_failed" &&
              ["review", "manual", "blocked", "failed"].includes(turn.gitApplication?.state ?? ""),
            revealed,
            // Background cleanup can update updatedAt after ordinary chat resumes.
            endedAt: turn.transitionTimestamps.complete ?? turn.transitionTimestamps.discarded,
            createdAt: turn.createdAt,
            updatedAt: turn.updatedAt,
          },
        }
      : {}),
    history: (snapshot.history ?? []).map((item) => ({
      id: item._id,
      index: item.turnIndex,
      state: item.state,
      ...(item.resolution ? { resolution: resolution(item.resolution) } : {}),
      ...(item.vote ? { vote: item.vote } : {}),
      ...(item.selectedEarly === undefined ? {} : { selectedEarly: item.selectedEarly }),
      ...(item.appliedSide ? { appliedSide: item.appliedSide } : {}),
      ...(item.canonicalUserMessageID ? { canonicalUserMessageID: item.canonicalUserMessageID } : {}),
      ...(item.gitApplication ? { gitApplication: item.gitApplication } : {}),
      ...(item.transitionEvent ? { transition: transition(item.transitionEvent) } : {}),
      endedAt: item.transitionTimestamps.complete ?? item.transitionTimestamps.discarded,
      ...(item.resolution ? { identities: { a: identity(item.placement.a), b: identity(item.placement.b) } } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    runs: snapshot.runs.map(
      (run): PublicRun => ({
        id: run._id,
        side: run.side,
        sessionID: run.rootSessionID,
        descendantSessionIDs: run.descendantSessionIDs,
        worktree: run.worktree,
        worktreeName: run.worktreeName ?? basename(run.worktree),
        ...(run.branchAtRun ? { branchAtRun: run.branchAtRun } : {}),
        worktreeActive: !run.worktreeRemovedAt,
        ...(run.copyOmissions ? { copyOmissions: copyOmissions(run.copyOmissions) } : {}),
        ...(run.portAliases ? { portAliases: run.portAliases } : {}),
        ...(run.services
          ? {
              services: run.services
                .filter((service) => service.kind !== "environment")
                .map((service) => ({
                  kind: "owned_process" as const,
                  command: service.command,
                  relativeCwd: service.relativeCwd,
                  listeners: service.listeners.map((listener) => ({
                    port: listener.port,
                    ...(listener.alias ? { alias: listener.alias } : {}),
                  })),
                  proxyRoutes: service.proxyRoutes.map((route) => ({
                    hostname: route.hostname,
                    ...(route.url ? { url: route.url } : {}),
                    ...(route.port ? { port: route.port } : {}),
                    ...(route.alias ? { alias: route.alias } : {}),
                    active: route.active,
                  })),
                })),
            }
          : {}),
        ...(run.retention ? { retention: run.retention } : {}),
        runState: run.runState,
        ...(run.error
          ? { error: runPaymentMessage(run.error) ?? (revealed ? run.error : "Contestant run failed") }
          : {}),
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.firstEventAt ? { firstEventAt: run.firstEventAt } : {}),
        ...(run.lastEventAt ? { lastEventAt: run.lastEventAt } : {}),
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        durationMs: run.durationMs ?? null,
        ...(run.promptMessageID ? { promptMessageID: run.promptMessageID } : {}),
        ...(run.diff ? { diff: run.diff } : {}),
        ...(run.finalCommit ? { finalCommit: run.finalCommit } : {}),
        ...(run.finalTree ? { finalTree: run.finalTree } : {}),
        ...(run.permanentRef ? { permanentRef: run.permanentRef } : {}),
        selectable: run.selectable === true,
        applicable: run.applicability === "applicable",
        ...(revealed && turn ? { identity: identity(turn.placement[run.side]) } : {}),
      }),
    ),
    events: snapshot.events,
    ...(snapshot.comparison
      ? {
          comparison: {
            state: snapshot.comparison.state,
            ...(snapshot.comparison.output ? { output: snapshot.comparison.output } : {}),
            truncated: snapshot.comparison.truncated,
            omittedArtifacts: snapshot.comparison.omittedArtifacts,
          },
        }
      : {}),
  }
  return parseSnapshot(jsonValue(projection))
}

export * as ArenaPublic from "./public"
