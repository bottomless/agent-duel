import {
  hasFinalProviderUsage,
  parseProviderUsage,
  usageTotalsVersion,
  type UsageTotals,
} from "@agent-duel/arena-service/usage"

type JsonRecord = Record<string, unknown>

type AuditedCall = {
  readonly generationID: string
  readonly runID?: string
  readonly sessionID?: string
  readonly engagementID?: string
  readonly usage: "known" | "unknown"
  readonly reasoningTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  readonly cost: number | null
  readonly suspectZero: boolean
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function trustedUsage(value: unknown): value is UsageTotals {
  return (
    record(value) &&
    value.provenance === "provider" &&
    value.version === usageTotalsVersion &&
    (value.promptTokens === null || finite(value.promptTokens)) &&
    (value.cacheReadTokens === null || finite(value.cacheReadTokens)) &&
    (value.cacheWriteTokens === null || finite(value.cacheWriteTokens)) &&
    (value.completionTokens === null || finite(value.completionTokens)) &&
    (value.reasoningTokens === null || finite(value.reasoningTokens)) &&
    (value.totalTokens === null || finite(value.totalTokens)) &&
    (value.cost === null || finite(value.cost))
  )
}

function parseRawProviderResponse(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    const events = value.split(/\r?\n/).flatMap((line) => {
      const data = line.trim()
      if (!data.startsWith("data:") || data.slice(5).trim() === "[DONE]") return []
      try {
        return [JSON.parse(data.slice(5).trim()) as unknown]
      } catch {
        return []
      }
    })
    return events.length > 0 ? events : undefined
  }
}

function generationID(generation: JsonRecord, index: number) {
  return typeof generation._id === "string"
    ? generation._id
    : typeof generation.requestID === "string"
      ? generation.requestID
      : `generation-${index + 1}`
}

function isRootModelCall(generation: JsonRecord) {
  return (
    generation.classification === "root" &&
    generation.requestKind === "generation" &&
    typeof generation.sessionID === "string" &&
    generation.sessionID === generation.rootSessionID
  )
}

function auditGeneration(generation: JsonRecord, index: number): AuditedCall {
  const id = generationID(generation, index)
  const stored = record(generation.usage) ? generation.usage : undefined
  const hasRaw = generation.rawProviderResponse !== undefined
  // A raw response, when present, is authoritative for this audit. This keeps
  // legacy stored zeros visible as suspect when the provider never reported reasoning.
  const rawInput = hasRaw ? parseRawProviderResponse(generation.rawProviderResponse) : undefined
  const parsedRaw = rawInput !== undefined && hasFinalProviderUsage(rawInput) ? parseProviderUsage(rawInput) : undefined
  const usage = hasRaw ? (trustedUsage(parsedRaw) ? parsedRaw : undefined) : trustedUsage(stored) ? stored : undefined
  const storedReasoning = stored?.reasoningTokens
  const suspectZero = storedReasoning === 0 && (!usage || usage.reasoningTokens === null)
  if (!usage || usage.reasoningTokens === null || usage.completionTokens === null) {
    return {
      generationID: id,
      runID: typeof generation.runID === "string" ? generation.runID : undefined,
      sessionID: typeof generation.sessionID === "string" ? generation.sessionID : undefined,
      engagementID: typeof generation.engagementID === "string" ? generation.engagementID : undefined,
      usage: "unknown",
      reasoningTokens: usage?.reasoningTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      cost: usage?.cost ?? null,
      suspectZero,
    }
  }
  return {
    generationID: id,
    runID: typeof generation.runID === "string" ? generation.runID : undefined,
    sessionID: typeof generation.sessionID === "string" ? generation.sessionID : undefined,
    engagementID: typeof generation.engagementID === "string" ? generation.engagementID : undefined,
    usage: "known",
    reasoningTokens: usage.reasoningTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cost: usage.cost,
    suspectZero,
  }
}

const inputPath = Bun.argv[2]
if (!inputPath) {
  console.error("Usage: bun run script/audit-compaction-usage.ts <generations.json>")
  process.exit(1)
}

let input: unknown
try {
  input = await Bun.file(inputPath).json()
} catch {
  console.error("Unable to read the generations JSON export")
  process.exit(1)
}

const generations = Array.isArray(input)
  ? input
  : record(input) && Array.isArray(input.generations)
    ? input.generations
    : undefined
if (!generations || generations.some((generation) => !record(generation))) {
  console.error("Expected a GenerationDocument[] JSON export")
  process.exit(1)
}

const calls = generations.filter(
  (generation): generation is JsonRecord => record(generation) && isRootModelCall(generation),
)
const audits = calls.map(auditGeneration)
const known = audits.filter((audit) => audit.usage === "known")
const unknown = audits.length - known.length
const excludedRecords = generations.length - calls.length
const unclassifiedExcludedRecords = generations.filter(
  (generation) =>
    record(generation) && (generation.classification === undefined || generation.requestKind === undefined),
).length

const report = {
  totalRecords: generations.length,
  countedCalls: audits.length,
  excludedRecords,
  unclassifiedExcludedRecords,
  knownUsage: known.length,
  unknownUsage: unknown,
  suspectZeroIDs: audits.filter((audit) => audit.suspectZero).map((audit) => audit.generationID),
  calls: audits,
}

console.log(JSON.stringify(report, null, 2))
