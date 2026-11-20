import { describe, expect, test } from "bun:test"
import { createArenaService } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { mediaMissingError } from "@agent-duel/arena-service/media"
import { AssignmentRegistry, proxy } from "../../src/arena/proxy"
import { referenceMedia, referencesConfirmed } from "../../src/arena/media-reference"

const assignment = {
  runID: "run-a",
  rootSessionID: "session-root",
  scopeID: "turn-a",
  assignmentID: "opaque-assignment",
  telemetry: false,
} as const

const model = {
  displayName: "Hidden",
  slug: "provider/hidden",
  canonicalSlug: "provider/hidden",
  contextWindow: 200_000,
  routing: { sort: "throughput" },
}

const screenshot = Buffer.from("a screenshot's bytes").toString("base64")
const dataUrl = `data:image/png;base64,${screenshot}`

let requests = 0
function contestantRequest(url = dataUrl) {
  return new Request("http://arena.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": "session-root",
      "x-arena-request-id": `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`,
    },
    body: JSON.stringify({
      model: "contestant",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    }),
  })
}

// Two 3 MB screenshots: each fits one upload, together they pass the hosted body limit inline.
const large = [1, 2].map((fill) => `data:image/png;base64,${Buffer.alloc(3_000_000, fill).toString("base64")}`)
function largeRequest() {
  return new Request("http://arena.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": "session-root",
      "x-arena-request-id": `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`,
    },
    body: JSON.stringify({
      model: "contestant",
      messages: [{ role: "user", content: large.map((url) => ({ type: "image_url", image_url: { url } })) }],
    }),
  })
}

function registry() {
  const value = new AssignmentRegistry()
  value.assign("session-root", assignment)
  return value
}

const answer = () =>
  Response.json({
    id: "gen-real",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  })

/** The uploads and the battle's assignment set, in memory. */
function memoryDb() {
  const parts = new Map<string, Record<string, unknown> & { _id: string }>()
  return {
    collection: (name: string) => {
      if (name === "arenaAssignmentSets") {
        return {
          find: () => ({
            toArray: async () => [
              { userId: "local", scopeID: "turn-a", assignments: [{ assignmentID: "opaque-assignment", model }] },
            ],
          }),
        }
      }
      return {
        find: (filter: { _id: { $in: string[] } }) => ({
          toArray: async () => filter._id.$in.flatMap((id) => parts.get(id) ?? []),
        }),
        findOne: async (filter: { _id: string }) => parts.get(filter._id) ?? null,
        replaceOne: async (filter: { _id: string }, document: Record<string, unknown> & { _id: string }) => {
          parts.set(filter._id, document)
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
        },
      }
    },
  } as unknown as ArenaDb
}

describe("media by reference", () => {
  test("the control plane gets a reference, OpenRouter gets the image, and it uploads once", async () => {
    const upstream = "http://control-once.invalid/api/openrouter"
    const toOpenRouter: string[] = []
    const db = memoryDb()
    const service = createArenaService({
      resolveCaller: async () => ({ id: "local" }),
      db: async () => db,
      pool: [],
      openRouterApiKey: "server-secret",
      streamRecovery: false,
      fetch: async (_url, init) => {
        toOpenRouter.push(new TextDecoder().decode(init?.body as ArrayBuffer))
        return answer()
      },
    })
    const toControlPlane: { path: string; body: string }[] = []
    // The request size counts media in full until the control plane has taken an upload.
    expect(referencesConfirmed(upstream)).toBe(false)
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      toControlPlane.push({ path, body: path.endsWith("/media") ? "" : await request.clone().text() })
      return (await service.route(request)) ?? Response.json({}, { status: 404 })
    }

    for (let round = 0; round < 2; round++) {
      const response = await proxy(contestantRequest(), registry(), {
        upstream,
        fetch: execute,
        mediaByReference: true,
      })
      expect(response.status).toBe(200)
    }

    const uploads = toControlPlane.filter(({ path }) => path.endsWith("/arena/media"))
    const calls = toControlPlane.filter(({ path }) => path.endsWith("/chat/completions"))
    expect(uploads).toHaveLength(1)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.body).not.toContain(screenshot)
      expect(call.body).toContain("arena-media:sha256:")
    }
    expect(toOpenRouter.at(-1)).toContain(dataUrl)
    expect(referencesConfirmed(upstream)).toBe(true)
  })

  test("media the control plane lost is uploaded again and the request sent again", async () => {
    const upstream = "http://control-lost.invalid/api/openrouter"
    const { media } = referenceMedia({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }],
    })
    const digest = [...media.keys()][0]!
    const seen: string[] = []
    let lost = true
    const execute = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      seen.push(path.split("/").pop()!)
      if (path.endsWith("/media")) return Response.json({ sha256: digest })
      if (lost) {
        lost = false
        return Response.json(mediaMissingError([digest]), { status: 409 })
      }
      return answer()
    }
    // The first request uploads it; the control plane then answers as if it had lost it.
    const response = await proxy(contestantRequest(), registry(), { upstream, fetch: execute, mediaByReference: true })
    expect(response.status).toBe(200)
    expect(seen).toEqual(["media", "completions", "media", "completions"])
  })

  test("a control plane without the upload route gets the media inline, and is not asked again", async () => {
    const upstream = "http://control-old.invalid/api/openrouter"
    const bodies: string[] = []
    let uploads = 0
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media")) {
        uploads++
        return Response.json({ error: "Not found" }, { status: 404 })
      }
      bodies.push(String(init?.body))
      return answer()
    }
    for (let round = 0; round < 2; round++) {
      const response = await proxy(contestantRequest(), registry(), {
        upstream,
        fetch: execute,
        mediaByReference: true,
      })
      expect(response.status).toBe(200)
    }
    expect(uploads).toBe(1)
    for (const body of bodies) expect(body).toContain(dataUrl)
    expect(referencesConfirmed(upstream)).toBe(false)
  })

  test("an upload the control plane refuses sends the media inline when the body fits", async () => {
    const upstream = "http://control-refusing.invalid/api/openrouter"
    const bodies: string[] = []
    let uploads = 0
    let closed = 0
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media")) {
        uploads++
        return new Response(new ReadableStream({ cancel: () => void closed++ }), { status: 503 })
      }
      bodies.push(String(init?.body))
      return answer()
    }
    for (let round = 0; round < 2; round++) {
      const response = await proxy(contestantRequest(), registry(), {
        upstream,
        fetch: execute,
        mediaByReference: true,
      })
      expect(response.status).toBe(200)
    }
    // A refusal is not a missing route: the next request tries the upload again.
    expect(uploads).toBe(2)
    expect(closed).toBe(2)
    for (const body of bodies) expect(body).toContain(dataUrl)
    expect(referencesConfirmed(upstream)).toBe(false)
  })

  test("a body sized for references that cannot go inline fails in a way the engine retries", async () => {
    for (const [status, expected] of [
      [404, 503],
      [500, 500],
    ] as const) {
      const upstream = `http://control-${status}.invalid/api/openrouter`
      let completions = 0
      const execute = async (input: string | URL | Request) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname
        if (path.endsWith("/media")) return Response.json({ error: { message: "No" } }, { status })
        completions++
        return answer()
      }
      const response = await proxy(largeRequest(), registry(), { upstream, fetch: execute, mediaByReference: true })
      expect(response.status).toBe(expected)
      expect(completions).toBe(0)
    }
  })

  test("a request sized for references before another found the route missing is retried, not sent", async () => {
    const upstream = "http://control-gone.invalid/api/openrouter"
    let completions = 0
    const execute = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media")) return Response.json({ error: "Not found" }, { status: 404 })
      completions++
      return answer()
    }
    const options = { upstream, fetch: execute, mediaByReference: true }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(completions).toBe(1)
    // This one was sized while the route still counted, so inline it would pass the limit.
    expect((await proxy(largeRequest(), registry(), options)).status).toBe(503)
    expect(completions).toBe(1)
  })

  test("an upload that cannot be sent at all sends the media inline when the body fits", async () => {
    const upstream = "http://control-unreachable.invalid/api/openrouter"
    const bodies: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media")) throw new Error("socket closed")
      bodies.push(String(init?.body))
      return answer()
    }
    const response = await proxy(contestantRequest(), registry(), { upstream, fetch: execute, mediaByReference: true })
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(dataUrl)
  })

  test("a BYOK request keeps its media inline", async () => {
    const bodies: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(`${String(input)} ${String(init?.body)}`)
      return answer()
    }
    const response = await proxy(contestantRequest(), registry(), {
      upstream: "http://arena.local/api/openrouter",
      fetch: execute,
    })
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(dataUrl)
  })

  test("only images and PDFs one upload can carry, in canonical base64, become references", () => {
    const text = `data:text/plain;base64,${Buffer.from("notes").toString("base64")}`
    const loose = "data:image/png;base64,YWJj\n"
    const { body, media } = referenceMedia({ a: dataUrl, b: text, c: loose, d: [dataUrl] })
    expect(media.size).toBe(1)
    expect(body.b).toBe(text)
    expect(body.c).toBe(loose)
    expect(String(body.a)).toStartWith("arena-media:sha256:")
    expect(body.d).toEqual([body.a])
  })
})
