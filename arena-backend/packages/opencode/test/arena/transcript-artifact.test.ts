import { describe, expect, test } from "bun:test"
import { ArenaTranscriptArtifact } from "@/arena/transcript-artifact"

describe("ArenaTranscriptArtifact", () => {
  test("compresses and restores the complete transcript", () => {
    const transcript = [
      {
        sessionID: "session-a",
        messages: [
          {
            info: {
              id: "message-a",
              role: "user",
              summary: { diffs: [{ file: "large.svg", patch: "<path d='M0 0'/>".repeat(150_000) }] },
            },
            parts: [],
          },
        ],
      },
    ]

    const encoded = ArenaTranscriptArtifact.encode(transcript)

    expect(encoded.compression).toBe("gzip")
    expect(encoded.data.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(transcript)))
    expect(ArenaTranscriptArtifact.decode(encoded)).toEqual(transcript)
  })

  test("reads legacy uncompressed transcript artifacts", () => {
    const transcript = [{ sessionID: "legacy", messages: [] }]

    expect(
      ArenaTranscriptArtifact.decode({
        compression: "none",
        data: Buffer.from(JSON.stringify(transcript)),
      }),
    ).toEqual(transcript)
  })
})
