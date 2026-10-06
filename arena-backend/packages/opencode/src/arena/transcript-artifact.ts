import { gunzipSync, gzipSync } from "node:zlib"
import type { ArtifactDocument } from "./records"

type TranscriptArtifact = Pick<ArtifactDocument, "compression" | "data">

function bytes(data: Buffer) {
  if (Buffer.isBuffer(data)) return data
  const binary = data as unknown as { readonly buffer?: Uint8Array }
  if (binary.buffer instanceof Uint8Array) return Buffer.from(binary.buffer)
  throw new Error("Arena transcript artifact has an unsupported binary payload")
}

export function encode(value: unknown) {
  const source = Buffer.from(JSON.stringify(value))
  return {
    compression: "gzip" as const,
    data: gzipSync(source, { level: 6 }),
    originalSize: source.byteLength,
  }
}

export function decode(artifact: TranscriptArtifact): unknown {
  const data = bytes(artifact.data)
  const decoded = artifact.compression === "gzip" ? gunzipSync(data) : data
  return JSON.parse(decoded.toString("utf8")) as unknown
}

export * as ArenaTranscriptArtifact from "./transcript-artifact"
