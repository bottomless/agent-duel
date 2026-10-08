import { createHash } from "crypto"

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
export const MAX_RUN_ARTIFACT_BYTES = 100 * 1024 * 1024

export type BoundInput = {
  readonly data: Uint8Array
  readonly runStoredBytes: number
  readonly artifactLimit?: number
  readonly runLimit?: number
  /**
   * Store all of `data` or none of it. A gzip stream cut at the limit does not decode, so a
   * prefix of compressed bytes is only disk spent on an artifact nothing can read.
   */
  readonly whole?: boolean
}

export type BoundResult = {
  readonly data: Buffer
  readonly originalSize: number
  readonly storedSize: number
  readonly contentHash: string
  readonly truncated: boolean
  readonly truncationReason?: "artifact_limit" | "run_limit"
}

export type PreparedBoundInput = {
  readonly data: Uint8Array
  readonly originalSize: number
  readonly contentHash: string
  readonly runStoredBytes: number
  readonly artifactLimit?: number
  readonly runLimit?: number
}

export function bound(input: BoundInput): BoundResult {
  const artifactLimit = input.artifactLimit ?? MAX_ARTIFACT_BYTES
  const runLimit = input.runLimit ?? MAX_RUN_ARTIFACT_BYTES
  if (!Number.isSafeInteger(artifactLimit) || artifactLimit < 0) throw new Error("Artifact limit must be non-negative")
  if (!Number.isSafeInteger(runLimit) || runLimit < 0) throw new Error("Run artifact limit must be non-negative")
  if (!Number.isSafeInteger(input.runStoredBytes) || input.runStoredBytes < 0) {
    throw new Error("Run stored byte count must be non-negative")
  }

  const source = Buffer.from(input.data)
  const remaining = Math.max(0, runLimit - input.runStoredBytes)
  const fits = Math.min(source.byteLength, artifactLimit, remaining)
  const storedSize = input.whole && fits < source.byteLength ? 0 : fits
  const data = source.subarray(0, storedSize)
  const truncated = storedSize < source.byteLength
  const truncationReason = !truncated
    ? undefined
    : remaining < Math.min(source.byteLength, artifactLimit)
      ? "run_limit"
      : "artifact_limit"

  return {
    data,
    originalSize: source.byteLength,
    storedSize,
    contentHash: createHash("sha256").update(source).digest("hex"),
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
  }
}

export function boundPrepared(input: PreparedBoundInput): BoundResult {
  const artifactLimit = input.artifactLimit ?? MAX_ARTIFACT_BYTES
  const runLimit = input.runLimit ?? MAX_RUN_ARTIFACT_BYTES
  if (!Number.isSafeInteger(artifactLimit) || artifactLimit < 0) throw new Error("Artifact limit must be non-negative")
  if (!Number.isSafeInteger(runLimit) || runLimit < 0) throw new Error("Run artifact limit must be non-negative")
  if (!Number.isSafeInteger(input.runStoredBytes) || input.runStoredBytes < 0) {
    throw new Error("Run stored byte count must be non-negative")
  }
  if (!Number.isSafeInteger(input.originalSize) || input.originalSize < input.data.byteLength) {
    throw new Error("Prepared artifact size must include every supplied byte")
  }
  if (!input.contentHash) throw new Error("Prepared artifact hash is required")

  const source = Buffer.from(input.data)
  const remaining = Math.max(0, runLimit - input.runStoredBytes)
  const storedSize = Math.min(source.byteLength, artifactLimit, remaining)
  const data = source.subarray(0, storedSize)
  const truncated = storedSize < input.originalSize
  const truncationReason = !truncated
    ? undefined
    : remaining < Math.min(input.originalSize, artifactLimit)
      ? "run_limit"
      : "artifact_limit"

  return {
    data,
    originalSize: input.originalSize,
    storedSize,
    contentHash: input.contentHash,
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
  }
}

export * as ArenaArtifact from "./artifact"
