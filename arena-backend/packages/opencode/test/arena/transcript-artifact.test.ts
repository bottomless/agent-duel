import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { imageArtifactID } from "@agent-duel/arena-service/research-protocol"
import { MAX_ARTIFACT_BYTES, MAX_RUN_ARTIFACT_BYTES } from "@/arena/artifact"
import { connectLocalStore } from "@/arena/local-store"
import { ArenaTranscriptArtifact } from "@/arena/transcript-artifact"

/** Random bytes do not compress, like the screenshots a contestant reads. */
function screenshot(bytes = 512 * 1024) {
  return `data:image/png;base64,${randomBytes(bytes).toString("base64")}`
}

/** A run's archived session after it read each screenshot with the read tool. */
function archivedRun(sessionID: string, screenshots: readonly string[]) {
  return [
    {
      sessionID,
      messages: [
        { info: { id: "msg_0", role: "user" }, parts: [{ type: "text", text: "Make the page match the design." }] },
        ...screenshots.map((url, index) => ({
          info: { id: `msg_${index + 1}`, role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "read",
              state: {
                status: "completed",
                output: "Image read successfully",
                attachments: [{ type: "file", mime: "image/png", url }],
              },
            },
          ],
        })),
      ],
    },
  ]
}

async function withLocalStore(
  run: (store: Awaited<ReturnType<typeof connectLocalStore>>, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-transcript-"))
  try {
    const store = await connectLocalStore({ directory })
    try {
      await run(store, directory)
    } finally {
      await store.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

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

  test("refuses a transcript the store did not keep whole", () => {
    const encoded = ArenaTranscriptArtifact.encode([{ sessionID: "cut", messages: [] }])
    expect(() =>
      ArenaTranscriptArtifact.decode({ ...encoded, data: encoded.data.subarray(0, 8), truncated: true }),
    ).toThrow("larger than the artifact limit")
  })

  test("keeps a run's screenshots out of its transcript, so a long run's archive is kept whole", async () => {
    const screenshots = Array.from({ length: 24 }, () => screenshot())
    // The run looked at its first screenshot again at the end.
    const archived = archivedRun("ses_long", [...screenshots, screenshots[0]!])
    // Inline, these screenshots alone put the transcript over the artifact limit, and it was not kept.
    expect(ArenaTranscriptArtifact.encode(archived).data.byteLength).toBeGreaterThan(MAX_ARTIFACT_BYTES)

    await withLocalStore(async (store) => {
      const written = await ArenaTranscriptArtifact.write(store, { runID: "run-a", turnID: "turn", archived })
      expect(written.transcript.truncated).toBe(false)
      expect(written.transcript.storedSize).toBeLessThan(64 * 1024)
      const ids = screenshots.map((url) =>
        createHash("sha256")
          .update(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"))
          .digest("hex"),
      )
      expect(written.transcript.imageIDs).toEqual(ids)
      expect(written.artifactIDs).toEqual(["run-a|transcript", ...ids.map((id) => imageArtifactID("run-a", id))])
      for (const id of ids) {
        expect(await store.artifact(imageArtifactID("run-a", id))).toMatchObject({
          kind: "image",
          mimeType: "image/png",
          contentHash: id,
          storedSize: 512 * 1024,
          truncated: false,
        })
      }

      const stored = (await store.artifact("run-a|transcript"))!
      expect(JSON.stringify(ArenaTranscriptArtifact.decode(stored))).not.toContain("data:image")
      expect(await ArenaTranscriptArtifact.read(store, stored)).toEqual(archived)
    })
  })

  test("an image both sides read is one file", async () => {
    const shared = [screenshot(), screenshot()]
    await withLocalStore(async (store, directory) => {
      await ArenaTranscriptArtifact.write(store, {
        runID: "run-a",
        turnID: "turn",
        archived: archivedRun("ses_a", shared),
      })
      await ArenaTranscriptArtifact.write(store, {
        runID: "run-b",
        turnID: "turn",
        archived: archivedRun("ses_b", shared),
      })
      // Two transcripts and the two images they share.
      expect(await readdir(path.join(directory, "artifacts", "sha256"))).toHaveLength(4)
    })
  })

  test("keeps a run's images when its per-call artifacts used up the run budget", async () => {
    const archived = archivedRun("ses_budget", [screenshot()])
    await withLocalStore(async (store) => {
      await store.storeArtifact({
        _id: "requests",
        runID: "run-a",
        kind: "generation_request",
        mimeType: "application/json",
        encoding: "binary",
        compression: "none",
        data: Buffer.alloc(MAX_RUN_ARTIFACT_BYTES),
        createdAt: new Date(),
      })
      await ArenaTranscriptArtifact.write(store, { runID: "run-a", turnID: "turn", archived })
      expect(await ArenaTranscriptArtifact.read(store, (await store.artifact("run-a|transcript"))!)).toEqual(archived)
    })
  })
})
