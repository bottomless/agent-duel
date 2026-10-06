import { ArenaCredentialsError } from "./credentials"
import { backend } from "./runtime"
import {
  isAssignmentDecision,
  type AssignmentDecision,
  type BattleAssignmentDecision,
  type SingleAssignmentDecision,
} from "@agent-duel/arena-service/assignment-decision"
import type { GenerationMetrics, UsageTotals } from "./records"

export type OpaqueAssignment = {
  readonly assignmentID: string
}

export type RevealedAssignment = {
  readonly assignmentID: string
  readonly model: string
  readonly metrics: readonly GenerationMetrics[]
}

async function request(input: Readonly<Record<string, unknown>>) {
  const target = backend()
  if (!target) throw new ArenaCredentialsError()
  const response = await target.fetch(`${target.url}/api/arena/assignments`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
  const payload = (await response.json()) as {
    readonly assignments?: readonly unknown[]
    readonly decision?: unknown
    readonly error?: string
  }
  if (!response.ok) throw new Error(payload.error ?? `Arena assignment request failed with status ${response.status}`)
  if (!Array.isArray(payload.assignments)) throw new Error("Arena assignment response is invalid")
  return { assignments: payload.assignments, decision: payload.decision }
}

function opaque(value: unknown): OpaqueAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena opaque assignment is invalid")
  }
  const input = value as Record<string, unknown>
  if (typeof input.assignmentID !== "string" || !input.assignmentID) {
    throw new Error("Arena assignment ID is invalid")
  }
  return { assignmentID: input.assignmentID }
}

function revealed(value: unknown): RevealedAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena revealed assignment is invalid")
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.assignmentID !== "string" ||
    !input.assignmentID ||
    typeof input.model !== "string" ||
    !input.model
  ) {
    throw new Error("Arena revealed assignment is invalid")
  }
  const metrics = Array.isArray(input.metrics) ? input.metrics.map(generationMetrics) : []
  return { assignmentID: input.assignmentID, model: input.model, metrics }
}

function finite(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Arena revealed assignment ${name} is invalid`)
  }
  return value
}

function usage(value: unknown): UsageTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena revealed assignment usage is invalid")
  }
  const input = value as Record<string, unknown>
  return {
    promptTokens: finite(input.promptTokens, "prompt tokens"),
    completionTokens: finite(input.completionTokens, "completion tokens"),
    reasoningTokens: finite(input.reasoningTokens, "reasoning tokens"),
    totalTokens: finite(input.totalTokens, "total tokens"),
    cacheReadTokens: finite(input.cacheReadTokens, "cache read tokens"),
    cacheWriteTokens: finite(input.cacheWriteTokens, "cache write tokens"),
    cost: finite(input.cost, "cost"),
    attempts: finite(input.attempts, "attempts"),
    latencyMs: finite(input.latencyMs, "latency"),
  }
}

function generationMetrics(value: unknown): GenerationMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena revealed assignment metrics are invalid")
  }
  const input = value as Record<string, unknown>
  if (typeof input.generationID !== "string" || !input.generationID) {
    throw new Error("Arena revealed assignment generation ID is invalid")
  }
  if (input.finishReason !== undefined && typeof input.finishReason !== "string") {
    throw new Error("Arena revealed assignment finish reason is invalid")
  }
  return {
    generationID: input.generationID,
    ...(input.usage === undefined ? {} : { usage: usage(input.usage) }),
    ...(typeof input.finishReason === "string" ? { finishReason: input.finishReason } : {}),
  }
}

export async function createBattleAssignments(scopeID: string) {
  const { assignments: values } = await request({ action: "create", kind: "battle", scopeID })
  if (values.length !== 2) throw new Error("Arena battle assignment response must contain two contestants")
  return { a: opaque(values[0]), b: opaque(values[1]) } as const
}

export async function createSingleAssignment(scopeID: string) {
  const { assignments: values } = await request({ action: "create", kind: "single", scopeID })
  if (values.length !== 1) throw new Error("Arena single-agent assignment response must contain one contestant")
  return opaque(values[0])
}

type ResolvedAssignments<D extends AssignmentDecision> = {
  readonly decision: D
  readonly assignments: readonly RevealedAssignment[]
}

export function resolveAssignments(
  kind: "battle",
  scopeID: string,
  decision: BattleAssignmentDecision,
): Promise<ResolvedAssignments<BattleAssignmentDecision>>
export function resolveAssignments(
  kind: "single",
  scopeID: string,
  decision: SingleAssignmentDecision,
): Promise<ResolvedAssignments<SingleAssignmentDecision>>
export async function resolveAssignments(
  kind: "battle" | "single",
  scopeID: string,
  decision: AssignmentDecision,
): Promise<ResolvedAssignments<AssignmentDecision>> {
  const payload = await request({ action: "resolve", kind, scopeID, decision })
  if (!isAssignmentDecision(kind, payload.decision)) {
    throw new Error("Arena resolved assignment decision is invalid")
  }
  return {
    decision: payload.decision,
    assignments: payload.assignments.map(revealed),
  }
}

export * as ArenaAssignmentClient from "./assignment-client"
