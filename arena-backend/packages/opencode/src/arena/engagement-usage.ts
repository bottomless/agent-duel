import { randomUUID } from "node:crypto"
import {
  addUsageTotals,
  isRootModelCall,
  type RootUsageCall,
  type UsageTotals,
  usageTotalsVersion,
} from "@agent-duel/arena-service/usage"

export type EngagementUsageCall = RootUsageCall & {
  readonly contextTokens?: number
  readonly finalizedAt: Date
}

export type EngagementUsageSnapshot = {
  readonly engagementID: string
  readonly runID: string
  readonly sessionID: string
  readonly usage?: UsageTotals
  readonly compactionUsage?: UsageTotals
  readonly calls: readonly EngagementUsageCall[]
  readonly rootCalls: number
  readonly compactionCalls: number
  /** Last root request's estimated context, including provider usage when it is available. */
  readonly contextTokens?: number
}

type Engagement = {
  readonly id: string
  readonly runID: string
  readonly sessionID: string
  readonly calls: Map<string, EngagementUsageCall>
  readonly listeners: Set<(snapshot: EngagementUsageSnapshot) => void>
  closed: boolean
}

const zero: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  attempts: 0,
  latencyMs: 0,
  provenance: "provider",
  version: usageTotalsVersion,
}

function merge(values: readonly UsageTotals[]) {
  return values.length ? values.reduce(addUsageTotals, zero) : undefined
}

function unknownCallUsage(): UsageTotals {
  return {
    ...zero,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    attempts: 1,
  }
}

function snapshot(engagement: Engagement): EngagementUsageSnapshot {
  const calls = [...engagement.calls.values()]
  const roots = calls.filter(isRootModelCall)
  const compactions = calls.filter((call) => call.classification === "compaction" || call.requestKind === "compaction")
  const rootUsage = merge(roots.map((call) => call.usage ?? unknownCallUsage()))
  const compactionUsage = merge(compactions.map((call) => call.usage ?? unknownCallUsage()))
  const contextTokens = roots
    .toSorted((left, right) => left.finalizedAt.getTime() - right.finalizedAt.getTime())
    .at(-1)?.contextTokens
  return {
    engagementID: engagement.id,
    runID: engagement.runID,
    sessionID: engagement.sessionID,
    ...(rootUsage ? { usage: rootUsage } : {}),
    ...(compactionUsage ? { compactionUsage } : {}),
    calls,
    rootCalls: roots.length,
    compactionCalls: compactions.length,
    ...(contextTokens === undefined ? {} : { contextTokens }),
  }
}

const engagements = new Map<string, Engagement>()
const active = new Map<string, string>()
const generations = new Map<string, string>()

function sessionKey(runID: string, sessionID: string) {
  return `${runID}\0${sessionID}`
}

export function begin(input: { readonly runID: string; readonly sessionID: string }) {
  const id = `${input.runID}|${randomUUID()}`
  const engagement: Engagement = {
    id,
    runID: input.runID,
    sessionID: input.sessionID,
    calls: new Map(),
    listeners: new Set(),
    closed: false,
  }
  engagements.set(id, engagement)
  active.set(sessionKey(input.runID, input.sessionID), id)
  return id
}

/** Bind a provider generation to the engagement active when its HTTP call starts. */
export function bind(generationID: string, input: { readonly runID: string; readonly sessionID: string }) {
  const id = active.get(sessionKey(input.runID, input.sessionID))
  if (id) generations.set(generationID, id)
  return id
}

export function onUpdate(engagementID: string, listener: (snapshot: EngagementUsageSnapshot) => void) {
  const engagement = engagements.get(engagementID)
  if (!engagement) return () => undefined
  engagement.listeners.add(listener)
  return () => engagement.listeners.delete(listener)
}

/** Record exactly once per generation ID. Calls can arrive after `finish`. */
export function finalize(call: EngagementUsageCall) {
  const engagementID = call.engagementID ?? generations.get(call.generationID)
  if (!engagementID) return
  const engagement = engagements.get(engagementID)
  if (!engagement || engagement.calls.has(call.generationID)) return
  engagement.calls.set(call.generationID, call)
  const current = snapshot(engagement)
  for (const listener of engagement.listeners) listener(current)
}

type EngagementRef = string | { readonly runID: string; readonly sessionID: string }

function resolve(ref: EngagementRef) {
  return typeof ref === "string" ? ref : active.get(sessionKey(ref.runID, ref.sessionID))
}

export function read(ref: EngagementRef) {
  const engagementID = resolve(ref)
  if (!engagementID) return undefined
  const engagement = engagements.get(engagementID)
  return engagement ? snapshot(engagement) : undefined
}

/** Mark an engagement complete while retaining it for late stream completions. */
export function finish(ref: EngagementRef) {
  const engagementID = resolve(ref)
  if (!engagementID) return undefined
  const engagement = engagements.get(engagementID)
  if (!engagement) return undefined
  engagement.closed = true
  return snapshot(engagement)
}

export function clear(engagementID: string) {
  engagements.delete(engagementID)
  for (const [key, value] of active) if (value === engagementID) active.delete(key)
  for (const [key, value] of generations) if (value === engagementID) generations.delete(key)
}

export function reset() {
  engagements.clear()
  active.clear()
  generations.clear()
}

export function snapshotFor(engagementID: string) {
  return read(engagementID)
}

export const finishSession = finish
export const readSession = read

export * as ArenaEngagementUsage from "./engagement-usage"
