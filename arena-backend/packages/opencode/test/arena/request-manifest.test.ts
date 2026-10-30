import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { MAX_ARTIFACT_BYTES, MAX_RUN_ARTIFACT_BYTES } from "@/arena/artifact"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { ArtifactDocument } from "@/arena/records"
import { loadRequest, splitRequest, storeRequest } from "@/arena/request-manifest"

function memoryStore() {
  const artifacts = new Map<string, ArtifactDocument>()
  const store = {
    storeArtifact: async (input: {
      _id: string
      data: Uint8Array
      kind: string
      mimeType?: string
      encoding?: string
      compression?: string
      runID?: string
      createdAt?: Date
    }) => {
      const document = {
        ...input,
        originalSize: input.data.byteLength,
        storedSize: input.data.byteLength,
        contentHash: input._id,
        truncated: false,
        mimeType: input.mimeType ?? "application/json",
        encoding: (input.encoding ?? "json") as ArtifactDocument["encoding"],
        compression: (input.compression ?? "gzip") as ArtifactDocument["compression"],
        createdAt: input.createdAt ?? new Date(0),
        data: Buffer.from(input.data),
      } as unknown as ArtifactDocument
      if (!artifacts.has(input._id)) artifacts.set(input._id, document)
      return document
    },
    artifact: async (id: string) => artifacts.get(id),
  } as unknown as Store
  return { store, artifacts }
}

function memoryStoreWithLimit(limit: number) {
  const { store, artifacts } = memoryStore()
  const storeArtifact = store.storeArtifact.bind(store)
  ;(store as { storeArtifact: unknown }).storeArtifact = async (
    input: { data: Uint8Array } & Record<string, unknown>,
  ) => {
    if (input.data.byteLength <= limit) return storeArtifact(input as never)
    const document = await storeArtifact({ ...input, data: new Uint8Array() } as never)
    const dropped = { ...document, truncated: true }
    artifacts.set(String(input._id), dropped)
    return dropped
  }
  return { store, artifacts }
}

const baseBody = {
  model: "contestant",
  stream: true,
  temperature: 0.2,
  system: [{ type: "text", text: "you are a contestant" }],
  tools: [{ type: "function", function: { name: "bash" } }],
  messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "earlier" },
    { role: "user", content: "second" },
  ],
}

describe("ArenaRequestManifest", () => {
  test("splits params, system, tools, and each message into their own component", () => {
    const { components, media } = splitRequest(baseBody)
    expect(media).toEqual([])
    expect(components.map((component) => [component.kind, component.role])).toEqual([
      ["params", undefined],
      ["system", undefined],
      ["tools", undefined],
      ["message", "user"],
      ["message", "assistant"],
      ["message", "user"],
    ])
    const params = JSON.parse(components[0]!.text) as Record<string, unknown>
    expect(params).toEqual({ model: "contestant", stream: true, temperature: 0.2 })
    expect(params).not.toHaveProperty("messages")
    expect(params).not.toHaveProperty("system")
    expect(params).not.toHaveProperty("tools")
  })

  test("keeps an empty messages list inside params", () => {
    const { components } = splitRequest({ model: "contestant", messages: [] })
    expect(components).toHaveLength(1)
    expect(JSON.parse(components[0]!.text)).toEqual({ model: "contestant", messages: [] })
  })

  test("rebuilds the wire body from stored components and verifies its hash", async () => {
    const { store, artifacts } = memoryStore()
    const createdAt = new Date("2026-08-05T12:00:00.000Z")
    const manifest = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: baseBody,
      createdAt,
    })

    expect(manifest.version).toBe(2)
    expect(manifest.generationID).toBe("gen_00000000000000000000000000000001")
    expect(manifest.components).toHaveLength(6)
    expect([...artifacts.keys()]).toEqual([
      ...manifest.components.map((component) => `component|${component.sha256}`),
      "gen_00000000000000000000000000000001|manifest",
    ])
    expect(artifacts.get("gen_00000000000000000000000000000001|manifest")?.kind).toBe("generation_manifest")
    for (const id of artifacts.keys()) {
      if (id.startsWith("component|")) expect(artifacts.get(id)?.kind).toBe("generation_component")
    }

    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.verified).toBe(true)
    expect(loaded?.missing).toEqual([])
    expect(loaded?.body).toEqual(baseBody)
  })

  test("writes unchanged components once across a run's generations", async () => {
    const { store, artifacts } = memoryStore()
    const known = new Set<string>()
    const createdAt = new Date("2026-08-05T12:00:00.000Z")
    const first = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: baseBody,
      createdAt,
      known,
    })
    const writesAfterFirst = artifacts.size

    const second = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000002",
      body: {
        ...baseBody,
        messages: [...baseBody.messages, { role: "user", content: "third" }],
      },
      createdAt,
      known,
    })

    expect(artifacts.size).toBe(writesAfterFirst + 2)
    expect(first.components[0]?.sha256).toBe(second.components[0]?.sha256)
    expect(second.components).toHaveLength(7)
    expect(artifacts.has("gen_00000000000000000000000000000002|manifest")).toBe(true)

    const loaded = await loadRequest(store, "gen_00000000000000000000000000000002")
    expect(loaded?.verified).toBe(true)
    expect(loaded?.body.messages).toHaveLength(4)
  })

  test("reports a missing component instead of verifying a rebuilt body", async () => {
    const { store, artifacts } = memoryStore()
    const createdAt = new Date("2026-08-05T12:00:00.000Z")
    const manifest = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: baseBody,
      createdAt,
    })
    const doomed = manifest.components[3]!
    artifacts.delete(`component|${doomed.sha256}`)

    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.missing).toEqual([doomed.sha256])
    expect(loaded?.verified).toBe(false)
    expect(loaded?.body.messages).toHaveLength(2)
  })

  test("treats a truncated manifest artifact as absent", async () => {
    const { store, artifacts } = memoryStore()
    const createdAt = new Date("2026-08-05T12:00:00.000Z")
    await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: baseBody,
      createdAt,
    })
    const manifestID = "gen_00000000000000000000000000000001|manifest"
    const stored = artifacts.get(manifestID)!
    artifacts.set(manifestID, { ...stored, truncated: true, data: Buffer.alloc(0) })

    expect(await loadRequest(store, "gen_00000000000000000000000000000001")).toBeUndefined()
  })

  test("component artifacts are gzip-compressed JSON", async () => {
    const { store, artifacts } = memoryStore()
    await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: { model: "contestant", messages: [] },
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    })
    const artifact = [...artifacts.values()].find((value) => value.kind === "generation_component")!
    expect(artifact.compression).toBe("gzip")
    expect(artifact.mimeType).toBe("application/json")
    expect(JSON.parse(gunzipSync(artifact.data).toString())).toEqual({
      model: "contestant",
      messages: [],
    })
  })

  test("keeps each inline image once as raw bytes and puts it back on read", async () => {
    const { store, artifacts } = memoryStore()
    const known = new Set<string>()
    const pixels = randomBytes(64 * 1024)
    const imageID = createHash("sha256").update(pixels).digest("hex")
    const url = `data:image/png;base64,${pixels.toString("base64")}`
    const screenshot = (text: string) => ({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url } },
      ],
    })
    const body = { model: "contestant", messages: [screenshot("first read"), screenshot("second read")] }

    const manifest = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body,
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
      known,
    })

    expect(manifest.media).toEqual([{ sha256: imageID, mimeType: "image/png", bytes: pixels.byteLength }])
    const image = artifacts.get(`media|${imageID}`)!
    expect(image).toMatchObject({ kind: "generation_component", mimeType: "image/png", compression: "none" })
    expect(Buffer.compare(image.data, pixels)).toBe(0)
    const messages = manifest.components.filter((component) => component.kind === "message")
    for (const message of messages) {
      const stored = gunzipSync(artifacts.get(`component|${message.sha256}`)!.data).toString()
      expect(stored).toContain(`arena-media:sha256:${imageID}:image/png`)
      expect(stored).not.toContain("base64")
    }

    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.verified).toBe(true)
    expect(loaded?.body).toEqual(body)
  })

  test("round-trips through the local SQLite store", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-request-manifest-"))
    try {
      const store = await connectLocalStore({ directory })
      try {
        const pixels = randomBytes(32 * 1024)
        const body = {
          ...baseBody,
          messages: [
            ...baseBody.messages,
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${pixels.toString("base64")}` } },
              ],
            },
          ],
        }
        const known = new Set<string>()
        await storeRequest(store, {
          runID: "run-local",
          generationID: "gen_00000000000000000000000000000001",
          body,
          createdAt: new Date("2026-08-05T12:00:00.000Z"),
          known,
        })
        await storeRequest(store, {
          runID: "run-local",
          generationID: "gen_00000000000000000000000000000002",
          body: { ...body, messages: [...body.messages, { role: "user", content: "next" }] },
          createdAt: new Date("2026-08-05T12:00:01.000Z"),
          known,
        })

        const stored = await store.artifacts.find({ runID: "run-local" }).toArray()
        expect(stored.filter((artifact) => artifact.kind === "generation_manifest")).toHaveLength(2)
        expect(stored.filter((artifact) => artifact.kind === "generation_component")).toHaveLength(9)

        const first = await loadRequest(store, "gen_00000000000000000000000000000001")
        expect(first?.verified).toBe(true)
        expect(first?.body).toEqual(body)
        const second = await loadRequest(store, "gen_00000000000000000000000000000002")
        expect(second?.verified).toBe(true)
        expect(second?.body.messages).toHaveLength(5)
      } finally {
        await store.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps components outside the run budget and out of its total", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-request-manifest-"))
    try {
      const store = await connectLocalStore({ directory })
      try {
        const filler = (index: number) => ({
          _id: `run-full|filler|${index}`,
          runID: "run-full",
          kind: "generation_response" as const,
          mimeType: "application/octet-stream",
          encoding: "binary" as const,
          compression: "none" as const,
          data: Buffer.alloc(MAX_ARTIFACT_BYTES),
          createdAt: new Date("2026-08-05T12:00:00.000Z"),
        })
        const pixels = randomBytes(4 * 1024 * 1024)
        const body = {
          model: "contestant",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${pixels.toString("base64")}` } },
              ],
            },
          ],
        }
        await storeRequest(store, {
          runID: "run-full",
          generationID: "gen_00000000000000000000000000000001",
          body,
          createdAt: new Date("2026-08-05T12:00:00.000Z"),
        })
        // The run's own artifacts still get the whole budget.
        for (let index = 0; index < MAX_RUN_ARTIFACT_BYTES / MAX_ARTIFACT_BYTES; index++) {
          expect(await store.storeArtifact(filler(index))).toMatchObject({ truncated: false })
        }
        await storeRequest(store, {
          runID: "run-full",
          generationID: "gen_00000000000000000000000000000002",
          body: { ...body, messages: [...body.messages, { role: "user", content: "after the budget" }] },
          createdAt: new Date("2026-08-05T12:00:01.000Z"),
        })
        const loaded = await loadRequest(store, "gen_00000000000000000000000000000002")
        expect(loaded?.verified).toBe(true)
      } finally {
        await store.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("drops an oversized component whole and names it as missing", async () => {
    const { store } = memoryStoreWithLimit(MAX_ARTIFACT_BYTES)
    const pixels = randomBytes(MAX_ARTIFACT_BYTES + 1)
    const imageID = createHash("sha256").update(pixels).digest("hex")
    await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: {
        model: "contestant",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pixels.toString("base64")}` } }],
          },
        ],
      },
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    })
    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.manifest.media.map((entry) => entry.sha256)).toEqual([imageID])
    expect(loaded?.missing).toEqual([imageID])
    expect(loaded?.verified).toBe(false)
  })

  test("shares components across runs and writes only the new manifest", async () => {
    const { store, artifacts } = memoryStore()
    const createdAt = new Date("2026-08-05T12:00:00.000Z")
    await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body: baseBody,
      createdAt,
    })
    const before = artifacts.size
    await storeRequest(store, {
      runID: "run-b",
      generationID: "gen_00000000000000000000000000000002",
      body: baseBody,
      createdAt,
    })
    expect(artifacts.size).toBe(before + 1)
    expect((await loadRequest(store, "gen_00000000000000000000000000000002"))?.verified).toBe(true)
  })

  test("rebuilds the body byte for byte, key order included", async () => {
    const { store } = memoryStore()
    const body = {
      stream: true,
      messages: baseBody.messages,
      model: "contestant",
      tools: baseBody.tools,
      reasoning: { effort: "high", summary: "auto" },
      max_tokens: 32000,
    }
    await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body,
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    })
    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.verified).toBe(true)
    expect(JSON.stringify(loaded?.body)).toBe(JSON.stringify(body))
  })

  test("keeps a PDF the agent read as raw bytes and puts it back on read", async () => {
    const { store, artifacts } = memoryStore()
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(8 * 1024)])
    const pdfID = createHash("sha256").update(pdf).digest("hex")
    const body = {
      model: "contestant",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Attached media from tool result:" },
            {
              type: "file",
              file: { filename: "", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` },
            },
          ],
        },
      ],
    }
    const manifest = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body,
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    })
    expect(manifest.media).toEqual([{ sha256: pdfID, mimeType: "application/pdf", bytes: pdf.byteLength }])
    expect(Buffer.compare(artifacts.get(`media|${pdfID}`)!.data, pdf)).toBe(0)
    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.verified).toBe(true)
    expect(JSON.stringify(loaded?.body)).toBe(JSON.stringify(body))
  })

  test("leaves a data URL inline when its base64 would not re-encode to the same text", async () => {
    const { store } = memoryStore()
    const url = "data:image/png;base64,iVBORw0KGgo=\n"
    const body = {
      model: "contestant",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    }
    const manifest = await storeRequest(store, {
      runID: "run-a",
      generationID: "gen_00000000000000000000000000000001",
      body,
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    })
    expect(manifest.media).toEqual([])
    const loaded = await loadRequest(store, "gen_00000000000000000000000000000001")
    expect(loaded?.verified).toBe(true)
    expect(JSON.stringify(loaded?.body)).toBe(JSON.stringify(body))
  })
})
