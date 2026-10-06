import { describe, expect, test } from "bun:test"
import { bound, boundPrepared } from "../../src/arena/artifact"

describe("ArenaArtifact", () => {
  test("stores a complete artifact under both caps", () => {
    const result = bound({ data: Buffer.from("complete"), runStoredBytes: 0, artifactLimit: 20, runLimit: 100 })
    expect(result.data.toString()).toBe("complete")
    expect(result).toMatchObject({ originalSize: 8, storedSize: 8, truncated: false })
    expect(result.contentHash).toHaveLength(64)
  })

  test("stores a deterministic prefix and hash when the artifact cap is reached", () => {
    const result = bound({ data: Buffer.from("0123456789"), runStoredBytes: 0, artifactLimit: 4, runLimit: 100 })
    expect(result.data.toString()).toBe("0123")
    expect(result).toMatchObject({
      originalSize: 10,
      storedSize: 4,
      truncated: true,
      truncationReason: "artifact_limit",
    })
  })

  test("gives the total run cap precedence when less space remains", () => {
    const result = bound({ data: Buffer.from("0123456789"), runStoredBytes: 98, artifactLimit: 8, runLimit: 100 })
    expect(result.data.toString()).toBe("01")
    expect(result).toMatchObject({ storedSize: 2, truncated: true, truncationReason: "run_limit" })
  })

  test("rejects invalid accounting inputs", () => {
    expect(() => bound({ data: Buffer.alloc(0), runStoredBytes: -1 })).toThrow("Run stored byte count")
  })

  test("retains full-file evidence metadata for a streamed prefix", () => {
    const result = boundPrepared({
      data: new TextEncoder().encode("prefix"),
      originalSize: 100,
      contentHash: "full-file-sha256",
      runStoredBytes: 0,
      artifactLimit: 6,
      runLimit: 100,
    })
    expect(result.data.toString()).toBe("prefix")
    expect(result.originalSize).toBe(100)
    expect(result.contentHash).toBe("full-file-sha256")
    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toBe("artifact_limit")
  })
})
