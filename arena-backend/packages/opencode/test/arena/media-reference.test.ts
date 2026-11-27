import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "crypto"
import { createArenaService } from "@agent-duel/arena-service"
import type { ArenaDb } from "@agent-duel/arena-service/collection"
import {
  MEDIA_FILE_BYTES,
  mediaMissingError,
  mediaUnavailableError,
  mediaUploadAnswer,
} from "@agent-duel/arena-service/media"
import { mediaUploadLimitError } from "@agent-duel/arena-service/media-limit"
import { networkUnavailableError } from "@agent-duel/arena-service/request-error"
import { memoryMediaStore } from "@agent-duel/arena-service/memory-media-store"
import { AssignmentRegistry, proxy } from "../../src/arena/proxy"
import { referenceMedia, referencesSupported, uploadMedia } from "../../src/arena/media-reference"
import { carriageOf } from "../../src/arena/runtime"

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
    // arena-service tests the upload limit; this database has no collection for it.
    mediaUploadLimit: null,
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

const storeDown = () => Response.json({ error: { message: "Arena media store is unavailable" } }, { status: 502 })

/**
 * A control plane that only answers: upload URLs from `urls`, `answer` to a contestant call, and
 * `relay` to a file sent to it instead of the storage host, which by default its store cannot take.
 */
function scripted(urls: (files: ReadonlyArray<{ digest: string }>) => Response, relay: () => Response = storeDown) {
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
      if (path.endsWith("/arena/media")) return relay()
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

// The pause after a store failure (`media-reference.ts`), plus a moment.
const PAUSE_OVER_MS = 5 * 60 * 1000 + 1

describe("media by reference", () => {
  afterEach(() => {
    setSystemTime()
  })

  test("the file goes straight to the store, the control plane gets a reference, and OpenRouter the image", async () => {
    const upstream = "http://control-once.invalid/api/openrouter"
    const plane = controlPlane({ user: "direct" })
    // Sized for references before any upload: nothing is left out of the first request after a start.
    expect(referencesSupported(upstream)).toBe(true)

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

  test("both sides sending the same file at once upload it once", async () => {
    const upstream = "http://control-shared.invalid/api/openrouter"
    const plane = controlPlane({ user: "shared" })
    const options = {
      upstream,
      fetch: plane.execute,
      // Slow enough that the second request asks while the first one's PUT is still under way.
      mediaUpload: async (input: string, init: RequestInit) => {
        await Bun.sleep(20)
        return plane.mediaUpload(input, init)
      },
      mediaByReference: true,
    }
    const answers = await Promise.all([
      proxy(contestantRequest(), registry(), options),
      proxy(contestantRequest(), registry(), options),
    ])
    expect(answers.map((response) => response.status)).toEqual([200, 200])
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(1)
    expect(plane.toStorage).toHaveLength(1)
    for (const call of calls(plane.toControlPlane)) expect(call.body).not.toContain(screenshot)
  })

  test("a request waiting on another's upload sends the file itself when that one is stopped", async () => {
    const upstream = "http://control-shared-stop.invalid/api/openrouter"
    const { media } = referenceMedia({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }],
    })
    const plane = scripted(storageUrls)
    const stop = new AbortController()
    const first = uploadMedia({
      execute: plane.execute,
      // Never answers: only the stop ends it.
      put: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        }),
      upstream,
      routing: {},
      media: media.values(),
      signal: stop.signal,
    })
    await Bun.sleep(5)
    let puts = 0
    const second = uploadMedia({
      execute: plane.execute,
      put: async () => {
        puts++
        return new Response(null, { status: 200 })
      },
      upstream,
      routing: {},
      media: media.values(),
      signal: new AbortController().signal,
    })
    await Bun.sleep(5)
    expect(plane.seen).toEqual(["media-upload"])
    stop.abort(new Error("Side stopped"))
    expect(first).rejects.toThrow("Side stopped")
    expect(await second).toBeUndefined()
    expect(puts).toBe(1)
    expect(plane.seen).toEqual(["media-upload", "media-upload"])
  })

  test("a file the store no longer has is uploaded again and the request sent again", async () => {
    const upstream = "http://control-lost.invalid/api/openrouter"
    let time = Date.parse("2026-11-20T00:00:00Z")
    const plane = controlPlane({ user: "expiring", now: () => new Date(time) })
    const options = { upstream, fetch: plane.execute, mediaUpload: plane.mediaUpload, mediaByReference: true }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    // The control plane counts a file missing 3 days after its upload; this process still counts it as uploaded.
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

  test("a file the store still cannot read after its second upload goes inline, and so do the next calls for a while", async () => {
    const upstream = "http://control-losing.invalid/api/openrouter"
    const seen: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media-upload")) {
        seen.push("media-upload")
        return storageUrls((JSON.parse(String(init?.body)) as { files: { digest: string }[] }).files)
      }
      const named = [...String(init?.body).matchAll(/arena-media:sha256:([0-9a-f]{64})/g)].map((match) => match[1]!)
      seen.push(named.length === 0 ? "inline" : "reference")
      return named.length === 0 ? answer() : Response.json(mediaMissingError(named), { status: 409 })
    }
    let puts = 0
    const options = {
      upstream,
      fetch: execute,
      mediaUpload: async () => {
        puts++
        return new Response(null, { status: 200 })
      },
      mediaByReference: true,
    }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(seen).toEqual(["media-upload", "reference", "media-upload", "reference", "inline"])
    expect(puts).toBe(2)
    // The store is paused: a body that fits does not ask it.
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(seen.slice(5)).toEqual(["inline"])
    // A body that cannot go inline asks all the same, one file first, and fails in a way the engine
    // retries: none of its images is left out to make it fit.
    expect((await proxy(largeRequest(), registry(), options)).status).toBe(503)
    expect(seen.slice(6)).toEqual(["media-upload", "media-upload", "reference", "media-upload", "reference"])
    // After the pause the store gets another try.
    setSystemTime(new Date(Date.now() + PAUSE_OVER_MS))
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(seen.slice(11)).toEqual(["reference", "media-upload", "reference", "inline"])
  })

  test("a store that cannot give media back sends it inline, and the next calls skip the store for a while", async () => {
    const upstream = "http://control-unreadable.invalid/api/openrouter"
    const seen: string[] = []
    const execute = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname
      if (path.endsWith("/media-upload")) {
        seen.push("media-upload")
        return storageUrls((JSON.parse(String(init?.body)) as { files: { digest: string }[] }).files)
      }
      const inline = String(init?.body).includes(screenshot)
      seen.push(inline ? "inline" : "reference")
      return inline ? answer() : Response.json(mediaUnavailableError(), { status: 503 })
    }
    const options = {
      upstream,
      fetch: execute,
      mediaUpload: async () => new Response(null, { status: 200 }),
      mediaByReference: true,
    }
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    // No upload again: the file is there, the store just did not give it back.
    expect(seen).toEqual(["media-upload", "reference", "inline"])
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(seen.slice(3)).toEqual(["inline"])
  })

  test("a hosted request is sized for references from its first call, and inline only after a 404", async () => {
    const target = { url: "http://control-sizing.invalid", mediaByReference: true }
    const upstream = `${target.url}/api/openrouter`
    // Counting media in full until an upload had succeeded left images out of the first request
    // after every start.
    expect(carriageOf(target)).toBe("reference")
    // A store that fails changes nothing: a body that then cannot go inline is tried again.
    const failing = scripted(() => Response.json({ error: { message: "No" } }, { status: 500 }))
    const sent = (plane: ReturnType<typeof scripted>) =>
      proxy(contestantRequest(), registry(), {
        upstream,
        fetch: plane.execute,
        mediaUpload: noStorage,
        mediaByReference: true,
      })
    expect((await sent(failing)).status).toBe(200)
    expect(carriageOf(target)).toBe("reference")
    // Only a control plane that will never take a reference is sized inline, and not for good.
    setSystemTime(new Date(Date.now() + PAUSE_OVER_MS))
    expect((await sent(scripted(() => Response.json({ error: "Not found" }, { status: 404 })))).status).toBe(200)
    expect(carriageOf(target)).toBe("inline")
    setSystemTime(new Date(Date.now() + 30 * 60 * 1000 + 1))
    expect(carriageOf(target)).toBe("reference")
    expect(carriageOf({ url: target.url })).toBe("local")
    expect(carriageOf(undefined)).toBe("inline")
  })

  test("a control plane without the upload route gets the media inline, and is not asked again for a while", async () => {
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
    expect(referencesSupported(upstream)).toBe(false)
    // A deploy can lose its store and get it back: the route is asked again later.
    setSystemTime(new Date(Date.now() + 30 * 60 * 1000 + 1))
    expect(
      (
        await proxy(contestantRequest(), registry(), {
          upstream,
          fetch: plane.execute,
          mediaUpload: plane.mediaUpload,
          mediaByReference: true,
        })
      ).status,
    ).toBe(200)
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(2)
  })

  test("an upload neither the storage host nor the control plane takes sends the media inline, and the next calls skip the store for a while", async () => {
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
      let failing = false
      const options = {
        upstream,
        fetch: plane.execute,
        mediaUpload: () => {
          puts++
          return failing ? put() : Promise.resolve(new Response(null, { status: 200 }))
        },
        mediaByReference: true,
      }
      expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
      failing = true
      for (let round = 0; round < 2; round++) {
        expect((await proxy(contestantRequest([dataUrl, large[0]!]), registry(), options)).status).toBe(200)
      }
      // The control plane is offered the file the storage host did not take. One failed upload
      // pauses the store: the second call neither asks for a URL nor waits on a PUT.
      expect(plane.seen).toEqual(["media-upload", "completions", "media-upload", "media", "completions", "completions"])
      expect(puts).toBe(2)
      expect(plane.bodies[1]).toContain(dataUrl)
      expect(plane.bodies[2]).toContain(dataUrl)
      setSystemTime(new Date(Date.now() + PAUSE_OVER_MS))
      failing = false
      expect((await proxy(contestantRequest([dataUrl, large[0]!]), registry(), options)).status).toBe(200)
      expect(plane.seen.slice(6)).toEqual(["media-upload", "completions"])
      expect(plane.bodies[3]).not.toContain(screenshot)
      setSystemTime()
    }
  })

  test("a file neither the storage host nor the control plane takes fails a body that cannot go inline in a way the engine retries", async () => {
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
    expect(plane.seen).toEqual(["media-upload", "media", "media"])
  })

  test("a control plane that answers 404 to a file's bytes fails the upload, and references stay on", async () => {
    const upstream = "http://control-norelay.invalid/api/openrouter"
    const plane = scripted(storageUrls, () => Response.json({ error: "Not found" }, { status: 404 }))
    const response = await proxy(largeRequest(), registry(), {
      upstream,
      fetch: plane.execute,
      mediaUpload: async () => new Response(null, { status: 503 }),
      mediaByReference: true,
    })
    // Tried again at the same size: only the upload route says a control plane has no store.
    expect(response.status).toBe(502)
    expect(referencesSupported(upstream)).toBe(true)
  })

  test("the control plane's answer to a file's bytes: its limit is a store failure, a refusal is the request's", async () => {
    for (const [status, expected] of [
      [429, 502],
      [403, 403],
    ] as const) {
      const upstream = `http://control-relay-${status}.invalid/api/openrouter`
      const plane = scripted(storageUrls, () =>
        Response.json({ error: { message: "No" } }, { status, headers: { "Retry-After": "36000" } }),
      )
      const response = await proxy(largeRequest(), registry(), {
        upstream,
        fetch: plane.execute,
        mediaUpload: async () => new Response(null, { status: 503 }),
        mediaByReference: true,
      })
      expect(response.status).toBe(expected)
      if (status === 429) expect(response.headers.get("retry-after")).toBeNull()
      expect(plane.bodies).toHaveLength(0)
    }
  })

  test("an offline machine's answer is passed on from both upload routes, and pauses and throttles nothing", async () => {
    const offline = () => Response.json(networkUnavailableError(), { status: 503 })
    for (const [name, urls, relay, put] of [
      ["route", offline, undefined, noStorage],
      [
        "relay",
        storageUrls,
        offline,
        async (): Promise<Response> => {
          throw new Error("getaddrinfo ENOTFOUND")
        },
      ],
    ] as const) {
      const upstream = `http://control-offline-${name}.invalid/api/openrouter`
      let online = false
      const plane = scripted(
        (files) => (online ? storageUrls(files) : urls(files)),
        () => (online ? Response.json({ sha256: "digest" }) : (relay ?? storeDown)()),
      )
      const options = {
        upstream,
        fetch: plane.execute,
        mediaUpload: (input: string, init: RequestInit) =>
          online ? Promise.resolve(new Response(null, { status: 200 })) : put(input, init),
        mediaByReference: true,
      }
      // The session waits for the network on this answer without spending a retry, so every retry
      // has to get it: none may meet a store that looks paused.
      for (let retry = 0; retry < 3; retry++) {
        const response = await proxy(largeRequest(), registry(), options)
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual(networkUnavailableError())
      }
      online = true
      expect((await proxy(largeRequest(), registry(), options)).status).toBe(200)
      expect(Buffer.byteLength(plane.bodies[0]!)).toBeLessThan(10_000)
    }
  })

  test("a storage host this machine cannot reach: files go through the control plane, and skip the storage host for a while", async () => {
    const upstream = "http://control-relay.invalid/api/openrouter"
    const plane = controlPlane({ user: "relayed" })
    let puts = 0
    const options = {
      upstream,
      fetch: plane.execute,
      mediaUpload: async (): Promise<Response> => {
        puts++
        throw new Error("connect ETIMEDOUT")
      },
      mediaByReference: true,
    }
    const relays = () => plane.toControlPlane.filter(({ path }) => path.endsWith("/arena/media"))
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(puts).toBe(1)
    expect(relays()).toHaveLength(1)
    // By reference all the same: the control plane wrote the file to the store itself.
    expect(calls(plane.toControlPlane)[0]!.body).toContain("arena-media:sha256:")
    expect(plane.host.files.size).toBe(1)
    expect(plane.toOpenRouter[0]).toContain(dataUrl)
    // The next file neither waits on the storage host nor asks for a URL it would not use.
    expect((await proxy(contestantRequest([dataUrl, large[0]!]), registry(), options)).status).toBe(200)
    expect(puts).toBe(1)
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(1)
    expect(relays()).toHaveLength(2)
    expect(calls(plane.toControlPlane)[1]!.body).not.toContain(screenshot)
    // After a while the storage host gets another try.
    setSystemTime(new Date(Date.now() + 30 * 60 * 1000 + 1))
    expect((await proxy(largeRequest(), registry(), options)).status).toBe(200)
    expect(puts).toBe(2)
    expect(uploadRequests(plane.toControlPlane)).toHaveLength(2)
    expect(relays()).toHaveLength(3)
    expect(plane.host.files.size).toBe(3)
    // A file over what one hosted request carries has no other way in.
    const poster = `data:image/png;base64,${Buffer.alloc(6_000_000, 3).toString("base64")}`
    expect((await proxy(contestantRequest(poster), registry(), options)).status).toBe(502)
    expect(puts).toBe(3)
    expect(relays()).toHaveLength(3)
  })

  test("a body that cannot go inline asks a paused store for one file, not on every retry, and goes by reference once it is back", async () => {
    const upstream = "http://control-recovering.invalid/api/openrouter"
    const plane = scripted(storageUrls)
    let failing = true
    let puts = 0
    const options = {
      upstream,
      fetch: plane.execute,
      mediaUpload: async () => {
        puts++
        return new Response(null, { status: failing ? 500 : 200 })
      },
      mediaByReference: true,
    }
    // The store fails: this body fits, so it goes inline, and the store is paused.
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(plane.bodies[0]).toContain(dataUrl)
    expect(puts).toBe(1)
    // Nothing is left out of a body that does not fit: the engine tries the step again. The paused
    // store is asked for one of its two files, and the retries that follow at once do not ask.
    for (let retry = 0; retry < 3; retry++) {
      expect((await proxy(largeRequest(), registry(), options)).status).toBe(502)
    }
    expect(puts).toBe(2)
    expect(plane.seen).toEqual(["media-upload", "media", "completions", "media-upload", "media"])
    expect(plane.bodies).toHaveLength(1)
    failing = false
    setSystemTime(new Date(Date.now() + 15_001))
    expect((await proxy(largeRequest(), registry(), options)).status).toBe(200)
    expect(puts).toBe(4)
    expect(Buffer.byteLength(plane.bodies[1]!)).toBeLessThan(10_000)
    // The store took a file, so a body that fits goes by reference again too.
    expect((await proxy(contestantRequest(), registry(), options)).status).toBe(200)
    expect(plane.bodies[2]).not.toContain(screenshot)
  })

  test("an upload route that refuses, or answers without a file's URL, sends the media inline when the body fits", async () => {
    let closed = 0
    for (const [name, urls, pauses] of [
      ["failing", () => new Response(new ReadableStream({ cancel: () => void closed++ }), { status: 503 }), true],
      ["empty", () => Response.json(mediaUploadAnswer([])), true],
      ["garbled", () => new Response("<html>"), true],
      // The account's upload limit: no reference until the pause ends.
      ["limited", () => Response.json(mediaUploadLimitError(), { status: 429 }), true],
      // A refused assignment is the request's own problem, not the store's.
      ["refusing", () => Response.json({ error: { message: "No" } }, { status: 403 }), false],
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
      expect(plane.seen).toEqual(
        pauses
          ? ["media-upload", "completions", "completions"]
          : ["media-upload", "completions", "media-upload", "completions"],
      )
      for (const body of plane.bodies) expect(body).toContain(dataUrl)
    }
    expect(closed).toBe(1)
  })

  test("a body sized for references that cannot go inline fails in a way the engine retries", async () => {
    for (const [status, expected] of [
      [404, 503],
      [500, 500],
      // The account's upload limit: tried again like a store failure, with no hint to wait on.
      [429, 502],
    ] as const) {
      const upstream = `http://control-${status}.invalid/api/openrouter`
      let completions = 0
      const execute = async (input: string | URL | Request) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname
        if (path.endsWith("/media-upload")) {
          const headers = status === 429 ? { "Retry-After": "36000" } : undefined
          return Response.json({ error: { message: "No" } }, { status, headers })
        }
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
      if (status === 429) expect(response.headers.get("retry-after")).toBeNull()
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
