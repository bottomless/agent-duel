import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { createArenaService } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import { MEDIA_FILE_BYTES, mediaMissingError, mediaUploadAnswer } from "@agent-duel/arena-service/media"
import { memoryMediaStore } from "@agent-duel/arena-service/memory-media-store"
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
function contestantRequest(url: string | string[] = dataUrl) {
  return new Request("http://arena.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": "session-root",
      "x-arena-request-id": `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`,
    },
    body: JSON.stringify({
      model: "contestant",
      messages: [
        { role: "user", content: [url].flat().map((item) => ({ type: "image_url", image_url: { url: item } })) },
      ],
    }),
  })
}

// Two 3 MB screenshots: together they pass the hosted body limit inline.
const large = [1, 2].map((fill) => `data:image/png;base64,${Buffer.alloc(3_000_000, fill).toString("base64")}`)
const largeRequest = () => contestantRequest(large)

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

/** The battle's assignment set, in memory: every account owns the same one. */
const memoryDb = {
  collection: () => ({
    find: (filter: { userId: string }) => ({
      toArray: async () => [
        { userId: filter.userId, scopeID: "turn-a", assignments: [{ assignmentID: "opaque-assignment", model }] },
      ],
    }),
  }),
} as unknown as ArenaDb

type Seen = { readonly path: string; readonly body: string }

/**
 * A control plane for one account, with what reached it, OpenRouter and the storage host. `execute`
 * adds the account's credential, as the hosted backend's fetch does.
 */
function controlPlane(options: { readonly user: string; readonly store?: boolean; readonly now?: () => Date }) {
  const host = memoryMediaStore(options.now)
  const toOpenRouter: string[] = []
  const toControlPlane: Seen[] = []
  const toStorage: { readonly headers: Headers; readonly bytes: number }[] = []
  const service = createArenaService({
    now: options.now,
    resolveCaller: async (request) =>
      request.headers.get("authorization") === "Bearer account-token" ? { id: options.user } : undefined,
    db: async () => memoryDb,
    pool: [],
    openRouterApiKey: "server-secret",
    streamRecovery: false,
    mediaStore: options.store === false ? undefined : host.store,
    fetch: async (_url, init) => {
      toOpenRouter.push(new TextDecoder().decode(init?.body as ArrayBuffer))
      return answer()
    },
  })
  return {
    host,
    toOpenRouter,
    toControlPlane,
    toStorage,
    execute: async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("Authorization", "Bearer account-token")
      const request = new Request(input, { ...init, headers })
      toControlPlane.push({ path: new URL(request.url).pathname, body: await request.clone().text() })
      return (await service.route(request)) ?? Response.json({}, { status: 404 })
    },
    mediaUpload: async (input: string, init: RequestInit) => {
      toStorage.push({ headers: new Headers(init.headers), bytes: (init.body as Uint8Array).byteLength })
      return host.upload(input, init)
    },
  }
}

const uploadRequests = (seen: ReadonlyArray<Seen>) => seen.filter(({ path }) => path.endsWith("/arena/media-upload"))
const calls = (seen: ReadonlyArray<Seen>) => seen.filter(({ path }) => path.endsWith("/chat/completions"))

/** A control plane that only answers: upload URLs from `urls`, and `answer` to a contestant call. */
function scripted(urls: (files: ReadonlyArray<{ digest: string }>) => Response) {
  const seen: string[] = []
  const bodies: string[] = []
  return {
    seen,
    bodies,
    execute: async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      seen.push(path.split("/").pop()!)
      if (path.endsWith("/media-upload")) {
        return urls((JSON.parse(String(init?.body)) as { files: { digest: string }[] }).files)
      }
      bodies.push(String(init?.body))
      return answer()
    },
  }
}

const storageUrls = (files: ReadonlyArray<{ digest: string }>) =>
  Response.json(mediaUploadAnswer(files.map(({ digest }) => ({ digest, url: `https://storage.invalid/${digest}` }))))

/** For a test in which nothing may reach the storage host. */
const noStorage = async (): Promise<Response> => {
  throw new Error("Unexpected upload to the storage host")
}

describe("media by reference", () => {
  test("the file goes straight to the store, the control plane gets a reference, and OpenRouter the image", async () => {
    const upstream = "http://control-once.invalid/api/openrouter"
    const plane = controlPlane({ user: "direct" })
    // The request size counts media in full until the store has taken an upload.
    expect(referencesConfirmed(upstream)).toBe(false)

    for (let round = 0; round < 2; round++) {
      const response = await proxy(contestantRequest(), registry(), {
        upstream,
        fetch: plane.execute,
        mediaUpload: plane.mediaUpload,
        mediaByReference: true,
      })
      expect(response.status).toBe(200)
    }

    // It uploads once, and never through the route released desktops POST their bytes to.
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(1)
    expect(plane.toControlPlane.filter(({ path }) => path.endsWith("/arena/media"))).toHaveLength(0)
    expect(calls(plane.toControlPlane)).toHaveLength(2)
    for (const seen of plane.toControlPlane) expect(seen.body).not.toContain(screenshot)
    for (const call of calls(plane.toControlPlane)) expect(call.body).toContain("arena-media:sha256:")
    // The storage host gets the bytes and their type, and nothing that names the account or the side.
    expect(plane.toStorage).toHaveLength(1)
    expect(plane.toStorage[0]!.bytes).toBe(Buffer.from(screenshot, "base64").byteLength)
    expect([...plane.toStorage[0]!.headers.keys()]).toEqual(["content-type"])
    expect(plane.toStorage[0]!.headers.get("content-type")).toBe("image/png")
    expect([...plane.host.files.keys()]).toEqual([
      `arena-media/direct/${createHash("sha256").update(Buffer.from(screenshot, "base64")).digest("hex")}`,
    ])
    expect(plane.toOpenRouter).toHaveLength(2)
    for (const body of plane.toOpenRouter) expect(body).toContain(dataUrl)
    expect(referencesConfirmed(upstream)).toBe(true)
  })

  test("without an upload function the file goes out in a plain request, with no Arena credential", async () => {
    const upstream = "http://control-plain.invalid/api/openrouter"
    const puts: { readonly method: string; readonly headers: Headers; readonly body: Buffer }[] = []
    using storage = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        puts.push({
          method: request.method,
          headers: request.headers,
          body: Buffer.from(await request.arrayBuffer()),
        })
        return new Response(null, { status: 200 })
      },
    })
    const plane = scripted((files) =>
      Response.json(
        mediaUploadAnswer(files.map(({ digest }) => ({ digest, url: `${storage.url}${digest}?signature=s` }))),
      ),
    )
    // The hosted backend's fetch adds the account's credential to everything it sends.
    const response = await proxy(contestantRequest(), registry(), {
      upstream,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("Authorization", "Bearer account-token")
        return plane.execute(input, { ...init, headers })
      },
      mediaByReference: true,
    })
    expect(response.status).toBe(200)
    expect(plane.seen).toEqual(["media-upload", "completions"])
    expect(plane.bodies[0]).not.toContain(screenshot)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.method).toBe("PUT")
    expect(puts[0]!.body.toString("base64")).toBe(screenshot)
    expect(puts[0]!.headers.get("content-type")).toBe("image/png")
    const sent = [...puts[0]!.headers.keys()]
    expect(sent.filter((name) => /authorization|cookie|arena|session/i.test(name))).toEqual([])
    expect(JSON.stringify([...puts[0]!.headers])).not.toContain("account-token")
    expect(JSON.stringify([...puts[0]!.headers])).not.toContain(assignment.assignmentID)
  })

  test("one request asks for every file's URL, and a file over 4.5 MB goes by reference", async () => {
    const upstream = "http://control-large.invalid/api/openrouter"
    const plane = controlPlane({ user: "large" })
    // 6 MB cannot pass a hosted function, in one upload or in the body.
    const poster = `data:image/png;base64,${Buffer.alloc(6_000_000, 3).toString("base64")}`
    const urls = [...large, poster]
    const response = await proxy(contestantRequest(urls), registry(), {
      upstream,
      fetch: plane.execute,
      mediaUpload: plane.mediaUpload,
      mediaByReference: true,
    })
    expect(response.status).toBe(200)
    const asked = uploadRequests(plane.toControlPlane)
    expect(asked).toHaveLength(1)
    expect((JSON.parse(asked[0]!.body) as { files: { size: number }[] }).files.map((file) => file.size)).toEqual([
      3_000_000, 3_000_000, 6_000_000,
    ])
    expect(plane.toStorage.map((put) => put.bytes).toSorted()).toEqual([3_000_000, 3_000_000, 6_000_000])
    for (const seen of plane.toControlPlane) expect(Buffer.byteLength(seen.body)).toBeLessThan(10_000)
    expect(plane.toOpenRouter).toHaveLength(1)
    for (const url of urls) expect(plane.toOpenRouter[0]!.includes(url)).toBe(true)
  })

  test("a file the store no longer has is uploaded again and the request sent again", async () => {
    const upstream = "http://control-lost.invalid/api/openrouter"
    let time = Date.parse("2026-11-20T00:00:00Z")
    const plane = controlPlane({ user: "expiring", now: () => new Date(time) })
    const options = { upstream, fetch: plane.execute, mediaUpload: plane.mediaUpload, mediaByReference: true }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    // The store deletes a file 3 days after its upload; this process still counts it as uploaded.
    time += 3 * 24 * 60 * 60 * 1000 + 1
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(plane.toControlPlane.map(({ path }) => path.split("/").pop())).toEqual([
      "media-upload",
      "completions",
      "completions",
      "media-upload",
      "completions",
    ])
    expect(plane.toStorage).toHaveLength(2)
    expect(plane.toOpenRouter).toHaveLength(2)
    expect(plane.toOpenRouter[1]).toContain(dataUrl)
  })

  test("a file that is still missing after its second upload is not uploaded a third time", async () => {
    const upstream = "http://control-losing.invalid/api/openrouter"
    const { media } = referenceMedia({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }],
    })
    const digest = [...media.keys()][0]!
    const seen: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      seen.push(path.split("/").pop()!)
      if (path.endsWith("/media-upload")) return storageUrls([{ digest }])
      expect(String(init?.body)).not.toContain(screenshot)
      return Response.json(mediaMissingError([digest]), { status: 409 })
    }
    let puts = 0
    const response = await proxy(contestantRequest(), registry(), {
      upstream,
      fetch: execute,
      mediaUpload: async () => {
        puts++
        return new Response(null, { status: 200 })
      },
      mediaByReference: true,
    })
    expect(response.status).toBe(409)
    expect(seen).toEqual(["media-upload", "completions", "media-upload", "completions"])
    expect(puts).toBe(2)
  })

  test("a control plane without the upload route gets the media inline, and is not asked again", async () => {
    const upstream = "http://control-old.invalid/api/openrouter"
    // No store: arena-service answers the route as a control plane from before it does.
    const plane = controlPlane({ user: "old", store: false })
    for (let round = 0; round < 2; round++) {
      const response = await proxy(contestantRequest(), registry(), {
        upstream,
        fetch: plane.execute,
        mediaUpload: plane.mediaUpload,
        mediaByReference: true,
      })
      expect(response.status).toBe(200)
    }
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(1)
    expect(plane.toStorage).toHaveLength(0)
    expect(calls(plane.toControlPlane)).toHaveLength(2)
    for (const call of calls(plane.toControlPlane)) expect(call.body).toContain(dataUrl)
    expect(referencesConfirmed(upstream)).toBe(false)
  })

  test("an upload the storage host does not take sends the media inline when the body fits", async () => {
    for (const [name, put] of [
      ["refusing", async () => new Response("signature expired", { status: 403 })],
      [
        "unreachable",
        async () => {
          throw new Error("socket closed")
        },
      ],
    ] as const) {
      const upstream = `http://storage-${name}.invalid/api/openrouter`
      const plane = scripted(storageUrls)
      let puts = 0
      for (let round = 0; round < 2; round++) {
        const response = await proxy(contestantRequest(), registry(), {
          upstream,
          fetch: plane.execute,
          mediaUpload: () => {
            puts++
            return put()
          },
          mediaByReference: true,
        })
        expect(response.status).toBe(200)
      }
      // A failed PUT is not a missing route: the next request asks for a URL and tries again.
      expect(plane.seen).toEqual(["media-upload", "completions", "media-upload", "completions"])
      expect(puts).toBe(2)
      for (const body of plane.bodies) expect(body).toContain(dataUrl)
      expect(referencesConfirmed(upstream)).toBe(false)
    }
  })

  test("a file the storage host does not take fails a body that cannot go inline in a way the engine retries", async () => {
    const upstream = "http://storage-down.invalid/api/openrouter"
    const plane = scripted(storageUrls)
    const response = await proxy(largeRequest(), registry(), {
      upstream,
      fetch: plane.execute,
      mediaUpload: async () => new Response("<Error>AccessDenied</Error>", { status: 403 }),
      mediaByReference: true,
    })
    // The control plane's kind of failure, not the storage host's status or text.
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
    })
    expect(plane.seen).toEqual(["media-upload"])
  })

  test("an upload route that refuses, or answers without a file's URL, sends the media inline when the body fits", async () => {
    let closed = 0
    for (const [name, urls] of [
      ["refusing", () => new Response(new ReadableStream({ cancel: () => void closed++ }), { status: 503 })],
      ["empty", () => Response.json(mediaUploadAnswer([]))],
      ["garbled", () => new Response("<html>")],
    ] as const) {
      const upstream = `http://control-${name}.invalid/api/openrouter`
      const plane = scripted(urls)
      for (let round = 0; round < 2; round++) {
        const response = await proxy(contestantRequest(), registry(), {
          upstream,
          fetch: plane.execute,
          mediaUpload: noStorage,
          mediaByReference: true,
        })
        expect(response.status).toBe(200)
      }
      // A refusal is not a missing route: the next request asks again.
      expect(plane.seen).toEqual(["media-upload", "completions", "media-upload", "completions"])
      for (const body of plane.bodies) expect(body).toContain(dataUrl)
      expect(referencesConfirmed(upstream)).toBe(false)
    }
    expect(closed).toBe(2)
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
        if (path.endsWith("/media-upload")) return Response.json({ error: { message: "No" } }, { status })
        completions++
        return answer()
      }
      const response = await proxy(largeRequest(), registry(), {
        upstream,
        fetch: execute,
        mediaUpload: noStorage,
        mediaByReference: true,
      })
      expect(response.status).toBe(expected)
      expect(completions).toBe(0)
    }
  })

  test("a request sized for references before another found the route missing is retried, not sent", async () => {
    const upstream = "http://control-gone.invalid/api/openrouter"
    let completions = 0
    const execute = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media-upload")) return Response.json({ error: "Not found" }, { status: 404 })
      completions++
      return answer()
    }
    const options = { upstream, fetch: execute, mediaUpload: noStorage, mediaByReference: true }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(completions).toBe(1)
    // This one was sized while the route still counted, so inline it would pass the limit.
    expect((await proxy(largeRequest(), registry(), options)).status).toBe(503)
    expect(completions).toBe(1)
  })

  test("an upload route that cannot be reached at all sends the media inline when the body fits", async () => {
    const upstream = "http://control-unreachable.invalid/api/openrouter"
    const bodies: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media-upload")) throw new Error("socket closed")
      bodies.push(String(init?.body))
      return answer()
    }
    const response = await proxy(contestantRequest(), registry(), {
      upstream,
      fetch: execute,
      mediaUpload: noStorage,
      mediaByReference: true,
    })
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
      mediaUpload: noStorage,
    })
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(dataUrl)
  })

  test("only images and PDFs an upload URL takes, in canonical base64, become references", () => {
    const text = `data:text/plain;base64,${Buffer.from("notes").toString("base64")}`
    const loose = "data:image/png;base64,YWJj\n"
    const atCap = `data:image/png;base64,${Buffer.alloc(MEDIA_FILE_BYTES, 5).toString("base64")}`
    const overCap = `data:image/png;base64,${Buffer.alloc(MEDIA_FILE_BYTES + 1, 5).toString("base64")}`
    const { body, media } = referenceMedia({ a: dataUrl, b: text, c: loose, d: [dataUrl], e: atCap, f: overCap })
    expect(media.size).toBe(2)
    expect(body.b).toBe(text)
    expect(body.c).toBe(loose)
    expect(String(body.e)).toStartWith("arena-media:sha256:")
    expect(body.f).toBe(overCap)
    expect(String(body.a)).toStartWith("arena-media:sha256:")
    expect(body.d).toEqual([body.a])
  })
})
