import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import type { ArenaDb } from "./collection"
import { MEDIA_PATH, MEDIA_TYPE_HEADER, mediaReference, readMediaMissing } from "./media"
import { createArenaService } from "./service"

const model = {
  displayName: "Hidden",
  slug: "provider/hidden",
  canonicalSlug: "provider/hidden",
  contextWindow: 200_000,
  routing: { sort: "throughput" },
}

type Row = Record<string, unknown> & { _id: string }

function matches(row: Row, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected.$in as unknown[]).includes(row[key])
    }
    return row[key] === expected
  })
}

/** Keeps the parts in memory; every account owns the same assignment, so only part scoping differs. */
function memoryDb() {
  const parts = new Map<string, Row>()
  let inserts = 0
  const db = {
    collection: (name: string) => {
      if (name === "arenaAssignmentSets") {
        return {
          find: (filter: { userId: string; scopeID: string }) => ({
            toArray: async () =>
              filter.scopeID === "turn-1"
                ? [{ userId: filter.userId, scopeID: "turn-1", assignments: [{ assignmentID: "opaque-id", model }] }]
                : [],
          }),
        }
      }
      if (name !== "arenaGenerationParts") throw new Error(`Unexpected Arena collection: ${name}`)
      return {
        find: (filter: Record<string, unknown>) => ({
          toArray: async () => [...parts.values()].filter((row) => matches(row, filter)),
        }),
        insertOne: async (document: Row) => {
          if (parts.has(document._id)) throw Object.assign(new Error("duplicate"), { code: 11000 })
          inserts++
          parts.set(document._id, document)
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
        },
      }
    },
  } as unknown as ArenaDb
  return { db, inserts: () => inserts }
}

function service(db: ArenaDb, user = "user-1", upstream: (body: string) => void = () => {}) {
  return createArenaService({
    resolveCaller: async () => ({ id: user }),
    db: async () => db,
    pool: [],
    openRouterApiKey: "server-secret",
    streamRecovery: false,
    fetch: async (_url, init) => {
      upstream(String(init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : ""))
      return Response.json({ id: "gen-real", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] })
    },
  }).openrouter
}

const routing = { "X-Arena-Assignment-ID": "opaque-id", "X-Arena-Scope-ID": "turn-1" }

const upload = (data: Uint8Array<ArrayBuffer>, mimeType = "image/png", scope = "turn-1") =>
  new Request(`https://control.test/api/openrouter${MEDIA_PATH}`, {
    method: "POST",
    headers: {
      ...routing,
      "X-Arena-Scope-ID": scope,
      "Content-Type": "application/octet-stream",
      [MEDIA_TYPE_HEADER]: mimeType,
    },
    body: data,
  })

const contestant = (url: string) =>
  new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
    method: "POST",
    headers: { ...routing, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "contestant",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    }),
  })

const png = new TextEncoder().encode("a screenshot's bytes")
const digest = createHash("sha256").update(png).digest("hex")

describe("media by reference", () => {
  test("an upload stores the bytes once under the account and answers their digest", async () => {
    const store = memoryDb()
    const proxy = service(store.db)
    const first = await proxy(upload(png))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ sha256: digest })
    expect((await proxy(upload(png))).status).toBe(200)
    expect(store.inserts()).toBe(1)
  })

  test("an upload needs a supported type and a live assignment", async () => {
    const proxy = service(memoryDb().db)
    expect((await proxy(upload(png, "text/plain"))).status).toBe(400)
    expect((await proxy(upload(png, "image/png", "another-turn"))).status).toBe(403)
  })

  test("the proxy puts the data back before OpenRouter sees the request", async () => {
    const store = memoryDb()
    let sent = ""
    const proxy = service(store.db, "user-1", (body) => (sent = body))
    await proxy(upload(png))
    const response = await proxy(contestant(mediaReference(digest, "image/png")))
    expect(response.status).toBe(200)
    expect(sent).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
    expect(sent).not.toContain("arena-media:")
  })

  test("a reference with no stored media answers which ones are missing, without calling OpenRouter", async () => {
    const store = memoryDb()
    let calls = 0
    await service(store.db)(upload(png))
    // Another account cannot read user-1's media by its digest.
    const proxy = service(store.db, "user-2", () => calls++)
    const response = await proxy(contestant(mediaReference(digest, "image/png")))
    expect(response.status).toBe(409)
    expect(readMediaMissing(await response.text())).toEqual([digest])
    expect(calls).toBe(0)
  })

  test("text that only looks like a reference is left alone", async () => {
    let sent = ""
    const proxy = service(memoryDb().db, "user-1", (body) => (sent = body))
    const text = `see ${mediaReference(digest, "image/png")}`
    const response = await proxy(contestant(text))
    expect(response.status).toBe(200)
    expect(sent).toContain(text)
  })
})
