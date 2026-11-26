import { describe, expect, spyOn, test } from "bun:test"
import { createHash } from "crypto"
import type { ArenaDb } from "./collection"
import { KEEP_ALIVE_HEADER } from "./keep-alive"
import {
  MEDIA_FILE_BYTES,
  MEDIA_PATH,
  MEDIA_TYPE_HEADER,
  MEDIA_UPLOAD_PATH,
  mediaReference,
  mediaUploadRequest,
  readMediaMissing,
  readMediaUnavailable,
  readMediaUploadAnswer,
  type MediaUpload,
} from "./media"
import { resolveMedia } from "./generation-capture"
import type { MediaUploadLimit } from "./media-limit"
import { mediaPathname, type MediaStore } from "./media-store"
import { memoryMediaStore } from "./memory-media-store"
import { createArenaService } from "./service"

const model = {
  displayName: "Hidden",
  slug: "provider/hidden",
  canonicalSlug: "provider/hidden",
  contextWindow: 200_000,
  routing: { sort: "throughput" },
}

type LimitRecord = { _id: string; userId: string; window: number; bytes: number; files: number }

/** The upload limit's documents, in memory: one per account, as `media-limit.ts` keeps them. */
function memoryLimits(records = new Map<string, LimitRecord>()) {
  return {
    records,
    findOneAndUpdate: async (
      filter: { _id: string; window: number },
      update: { $inc: { bytes: number; files: number } },
    ) => {
      const record = records.get(filter._id)
      if (!record || record.window !== filter.window) return null
      record.bytes += update.$inc.bytes
      record.files += update.$inc.files
      return { ...record }
    },
    replaceOne: async (filter: { _id: string }, replacement: LimitRecord) => {
      records.set(filter._id, { ...replacement })
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
    },
  }
}

/** Every account owns both sides of the same battle, so only the media differs between accounts. */
function memoryDb(assigned = model, limits = memoryLimits()) {
  return {
    collection: (name: string) => {
      if (name === "arenaMediaUploadLimits") return limits
      if (name !== "arenaAssignmentSets") throw new Error(`Unexpected Arena collection: ${name}`)
      return {
        find: (filter: { userId: string; scopeID: string }) => ({
          toArray: async () =>
            filter.scopeID === "turn-1"
              ? [
                  {
                    userId: filter.userId,
                    scopeID: "turn-1",
                    assignments: [
                      { assignmentID: "opaque-id", model: assigned },
                      { assignmentID: "other-side", model: assigned },
                    ],
                  },
                ]
              : [],
        }),
      }
    },
  } as unknown as ArenaDb
}

function service(
  options: {
    readonly mediaStore?: MediaStore
    readonly user?: string
    readonly upstream?: (body: string) => void
    readonly now?: () => Date
    readonly assigned?: typeof model
    readonly mediaUploadLimit?: MediaUploadLimit
  } = {},
) {
  const limits = memoryLimits()
  return createArenaService({
    now: options.now,
    resolveCaller: async () => ({ id: options.user ?? "user-1" }),
    db: async () => memoryDb(options.assigned, limits),
    mediaUploadLimit: options.mediaUploadLimit,
    pool: [],
    openRouterApiKey: "server-secret",
    streamRecovery: false,
    mediaStore: options.mediaStore,
    fetch: async (_url, init) => {
      options.upstream?.(String(init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : ""))
      return Response.json({ id: "gen-real", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] })
    },
  }).openrouter
}

const routing = { "X-Arena-Assignment-ID": "opaque-id", "X-Arena-Scope-ID": "turn-1" }

/** What a desktop released before the upload route sends: one file's raw bytes. */
const legacyUpload = (data: Uint8Array<ArrayBuffer>, mimeType = "image/png", scope = "turn-1") =>
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

const uploadUrls = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://control.test/api/openrouter${MEDIA_UPLOAD_PATH}`, {
    method: "POST",
    headers: { ...routing, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

const contestant = (url: string | string[], headers: Record<string, string> = {}) =>
  new Request("https://control.test/api/openrouter/api/v1/chat/completions", {
    method: "POST",
    headers: { ...routing, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "contestant",
      messages: [
        { role: "user", content: [url].flat().map((item) => ({ type: "image_url", image_url: { url: item } })) },
      ],
    }),
  })

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const png = new TextEncoder().encode("a screenshot's bytes")
const digest = sha256(png)
const file = (data: Uint8Array, mimeType = "image/png"): MediaUpload => ({
  digest: sha256(data),
  mimeType,
  size: data.byteLength,
})

/** Uploads as the engine does: one request for the URLs, then each file's bytes to its URL. */
async function upload(
  proxy: ReturnType<typeof service>,
  host: ReturnType<typeof memoryMediaStore>,
  ...files: Uint8Array<ArrayBuffer>[]
) {
  const response = await proxy(uploadUrls(mediaUploadRequest(files.map((data) => file(data)))))
  expect(response.status).toBe(200)
  const urls = readMediaUploadAnswer(await response.text())!
  for (const data of files) {
    const stored = await host.upload(urls.get(sha256(data))!, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: data,
    })
    expect(stored.status).toBe(200)
  }
}

describe("media by reference", () => {
  test("the upload route answers one URL per file, and a file PUT there comes back in the request", async () => {
    const host = memoryMediaStore()
    const asked: Parameters<MediaStore["uploadUrl"]>[0][] = []
    const mediaStore: MediaStore = {
      ...host.store,
      uploadUrl: (input) => {
        asked.push(input)
        return host.store.uploadUrl(input)
      },
    }
    let sent = ""
    const proxy = service({ mediaStore, user: "user-direct", upstream: (body) => (sent = body) })
    const pdf = new TextEncoder().encode("%PDF-1.7 a spec")
    const response = await proxy(uploadUrls(mediaUploadRequest([file(png), file(pdf, "application/pdf")])))
    expect(response.status).toBe(200)
    const answer = (await response.json()) as { uploads: { digest: string; url: string }[] }
    expect(answer.uploads.map((item) => item.digest)).toEqual([digest, sha256(pdf)])
    // Each URL takes that file alone: its account's pathname, its type, and no more than its size.
    expect(asked).toEqual([
      { pathname: `arena-media/user-direct/${digest}`, contentType: "image/png", maxBytes: png.byteLength },
      { pathname: `arena-media/user-direct/${sha256(pdf)}`, contentType: "application/pdf", maxBytes: pdf.byteLength },
    ])
    // Nothing is stored until the desktop sends the bytes.
    expect((await proxy(contestant(mediaReference(digest, "image/png")))).status).toBe(409)

    const refused = await host.upload(answer.uploads[0]!.url, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: png,
    })
    expect(refused.ok).toBe(false)
    const stored = await host.upload(answer.uploads[0]!.url, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    })
    expect(stored.ok).toBe(true)
    expect((await proxy(contestant(mediaReference(digest, "image/png")))).status).toBe(200)
    expect(sent).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
    expect(sent).not.toContain("arena-media:")
  })

  test("both sides of a battle get URLs for the same files of the account", async () => {
    const host = memoryMediaStore()
    const proxy = service({ mediaStore: host.store })
    const pathnames = await Promise.all(
      ["opaque-id", "other-side"].map(async (assignmentID) => {
        const response = await proxy(
          uploadUrls(mediaUploadRequest([file(png)]), { "X-Arena-Assignment-ID": assignmentID }),
        )
        const answer = (await response.json()) as { uploads: { digest: string; url: string }[] }
        expect(Object.keys(answer)).toEqual(["uploads"])
        expect(answer.uploads.map((item) => Object.keys(item))).toEqual([["digest", "url"]])
        expect(answer.uploads[0]!.url).not.toContain(assignmentID)
        return new URL(answer.uploads[0]!.url).pathname
      }),
    )
    expect(pathnames).toEqual([`/arena-media/user-1/${digest}`, `/arena-media/user-1/${digest}`])
  })

  test("the upload route refuses a bad digest, type or size, too many files, and a dead assignment", async () => {
    const host = memoryMediaStore()
    const proxy = service({ mediaStore: host.store })
    const good = file(png)
    const refused = [
      {},
      { files: [] },
      { files: [{ ...good, digest: digest.toUpperCase() }] },
      { files: [{ ...good, digest: digest.slice(1) }] },
      { files: [{ ...good, mimeType: "text/plain" }] },
      { files: [{ ...good, mimeType: "image/png; charset=x" }] },
      { files: [{ ...good, size: 0 }] },
      { files: [{ ...good, size: 1.5 }] },
      { files: [{ ...good, size: MEDIA_FILE_BYTES + 1 }] },
      { files: [good, null] },
      { files: Array.from({ length: 201 }, () => good) },
    ]
    for (const body of refused) expect((await proxy(uploadUrls(body))).status).toBe(400)
    expect((await proxy(uploadUrls({ files: [{ ...good, size: MEDIA_FILE_BYTES }] }))).status).toBe(200)
    expect((await proxy(uploadUrls({ files: Array.from({ length: 200 }, () => good) }))).status).toBe(200)
    const dead = await proxy(uploadUrls(mediaUploadRequest([good]), { "X-Arena-Scope-ID": "another-turn" }))
    expect(dead.status).toBe(403)
  })

  test("a desktop released before the upload route still uploads, through the store", async () => {
    const host = memoryMediaStore()
    let sent = ""
    const proxy = service({ mediaStore: host.store, user: "user-legacy", upstream: (body) => (sent = body) })
    const first = await proxy(legacyUpload(png))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ sha256: digest })
    expect([...host.files.keys()]).toEqual([`arena-media/user-legacy/${digest}`])
    expect(host.files.get(`arena-media/user-legacy/${digest}`)?.contentType).toBe("image/png")
    expect((await proxy(contestant(mediaReference(digest, "image/png")))).status).toBe(200)
    expect(sent).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)

    expect((await proxy(legacyUpload(png, "text/plain"))).status).toBe(400)
    expect((await proxy(legacyUpload(new Uint8Array(0)))).status).toBe(400)
    expect((await proxy(legacyUpload(png, "image/png", "another-turn"))).status).toBe(403)
  })

  test("an account past its upload limit is refused until the window ends, on both routes", async () => {
    let time = Date.parse("2026-11-25T10:10:00Z")
    const host = memoryMediaStore()
    const proxy = service({
      mediaStore: host.store,
      user: "user-limited",
      now: () => new Date(time),
      mediaUploadLimit: { maxBytes: 100, maxFiles: 3, windowMs: 60 * 60 * 1000 },
    })
    const sized = (size: number, fill: number) => file(new Uint8Array(size).fill(fill))
    expect((await proxy(uploadUrls(mediaUploadRequest([sized(40, 1), sized(40, 2)])))).status).toBe(200)
    // 120 bytes would pass the limit: no URL is signed.
    const refused = await proxy(uploadUrls(mediaUploadRequest([sized(40, 3)])))
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({
      error: { message: "Arena media upload limit reached", type: "arena_media_upload_limit" },
    })
    // A session that got a hint from a released desktop would wait on it instead of trying again.
    expect(refused.headers.get("retry-after")).toBeNull()
    // Released desktops upload through the other route, which counts the same way.
    expect((await proxy(legacyUpload(new Uint8Array(10).fill(4)))).status).toBe(429)
    expect(host.files.size).toBe(0)
    time += 50 * 60 * 1000
    expect((await proxy(uploadUrls(mediaUploadRequest([sized(40, 3)])))).status).toBe(200)
    expect((await proxy(legacyUpload(new Uint8Array(10).fill(4)))).status).toBe(200)
    // Files count as well as bytes.
    expect((await proxy(uploadUrls(mediaUploadRequest([sized(1, 5), sized(1, 6)])))).status).toBe(429)
  })

  test("without a store both routes answer 404, as a control plane from before them does", async () => {
    const proxy = service()
    expect((await proxy(uploadUrls(mediaUploadRequest([file(png)])))).status).toBe(404)
    expect((await proxy(legacyUpload(png))).status).toBe(404)
    // A malformed request gets the same answer: there is no route to refuse it.
    expect((await proxy(uploadUrls({}))).status).toBe(404)
    const response = await proxy(contestant(mediaReference(digest, "image/png")))
    expect(response.status).toBe(409)
    expect(readMediaMissing(await response.text())).toEqual([digest])
  })

  test("a file is missing 3 days after its upload, and the same reference works once it is uploaded again", async () => {
    let time = Date.parse("2026-11-20T00:00:00Z")
    const now = () => new Date(time)
    const host = memoryMediaStore(now)
    let calls = 0
    // Its own account, so no earlier test's warm copy answers for it.
    const proxy = service({ mediaStore: host.store, user: "user-expiring", upstream: () => calls++, now })
    const reference = mediaReference(digest, "image/png")
    await upload(proxy, host, png)
    expect(host.files.get(`arena-media/user-expiring/${digest}`)?.expiresAt).toEqual(
      new Date(time + 3 * 24 * 60 * 60 * 1000),
    )
    time += 71 * 60 * 60 * 1000
    expect((await proxy(contestant(reference))).status).toBe(200)
    // Past its time it is missing, even while the store has not deleted it and the function keeps it warm.
    time += 2 * 60 * 60 * 1000
    const expired = await proxy(contestant(reference))
    expect(expired.status).toBe(409)
    expect(readMediaMissing(await expired.text())).toEqual([digest])
    await upload(proxy, host, png)
    expect((await proxy(contestant(reference))).status).toBe(200)
    expect(calls).toBe(2)
  })

  test("a warm function reads a file from the store once, and logs where each call's media came from", async () => {
    const host = memoryMediaStore()
    const proxy = service({ mediaStore: host.store, user: "user-logged" })
    const other = new TextEncoder().encode("another screenshot")
    await upload(proxy, host, png, other)
    const info = spyOn(console, "info").mockImplementation(() => {})
    try {
      const lines = () => info.mock.calls.filter(([label]) => label === "[arena-service] Arena media")
      expect((await proxy(contestant(mediaReference(digest, "image/png")))).status).toBe(200)
      expect(
        (await proxy(contestant([digest, sha256(other)].map((id) => mediaReference(id, "image/png"))))).status,
      ).toBe(200)
      expect((await proxy(contestant(mediaReference("0".repeat(64), "image/png")))).status).toBe(409)
      // A call that names no media logs nothing.
      expect((await proxy(contestant("https://example.com/a.png"))).status).toBe(200)
      expect(host.bodies()).toBe(2)
      const logged = lines().map(([, line]) => JSON.parse(String(line)) as Record<string, unknown>)
      expect(logged).toEqual([
        { files: 1, cached: 0, stored: 1, storeMs: expect.any(Number), missing: 0 },
        { files: 2, cached: 1, stored: 1, storeMs: expect.any(Number), missing: 0 },
        { files: 1, cached: 0, stored: 0, storeMs: expect.any(Number), missing: 1 },
      ])
      // Counts and a duration: no content, digest or account.
      const text = JSON.stringify(lines())
      for (const secret of [
        digest,
        sha256(other),
        "0".repeat(64),
        "user-logged",
        Buffer.from(png).toString("base64"),
      ]) {
        expect(text).not.toContain(secret)
      }
    } finally {
      info.mockRestore()
    }
  })

  test("a reference with no stored media answers which ones are missing, without calling OpenRouter", async () => {
    const host = memoryMediaStore()
    let calls = 0
    await upload(service({ mediaStore: host.store }), host, png)
    // Another account cannot read user-1's media by its digest.
    const proxy = service({ mediaStore: host.store, user: "user-2", upstream: () => calls++ })
    const response = await proxy(contestant(mediaReference(digest, "image/png")))
    expect(response.status).toBe(409)
    expect(readMediaMissing(await response.text())).toEqual([digest])
    expect(calls).toBe(0)
  })

  test("stored bytes that are not the file the digest names are missing, and are not kept", async () => {
    const host = memoryMediaStore()
    let sent = ""
    const proxy = service({ mediaStore: host.store, user: "user-corrupt", upstream: (body) => (sent = body) })
    const reference = mediaReference(digest, "image/png")
    const pathname = mediaPathname("user-corrupt", digest)
    for (const wrong of [new TextEncoder().encode("someone else's bytes"), png.slice(0, 5)]) {
      await host.store.write({ pathname, contentType: "image/png", data: wrong })
      const response = await proxy(contestant(reference))
      expect(response.status).toBe(409)
      expect(readMediaMissing(await response.text())).toEqual([digest])
    }
    expect(sent).toBe("")
    // The engine uploads it again over the wrong bytes, and the next call reads the right ones.
    await upload(proxy, host, png)
    expect((await proxy(contestant(reference))).status).toBe(200)
    expect(sent).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
  })

  test("a request that names more media than any provider takes is refused before any of it loads", async () => {
    const host = memoryMediaStore()
    let calls = 0
    const proxy = service({ mediaStore: host.store, user: "user-large", upstream: () => calls++ })
    await upload(proxy, host, png)
    const reference = mediaReference(digest, "image/png")
    // A refusal for the media, not the compaction refusal a request this size also earns.
    const tooMuchMedia = { error: { message: "Arena request carries too much media", type: "arena_media_too_large" } }
    const repeated = await proxy(contestant(Array.from({ length: 201 }, () => reference)))
    expect(repeated.status).toBe(413)
    expect(await repeated.json()).toEqual(tooMuchMedia)

    // 9 MB is 12 MB of base64: two copies fit the 32 MB a request may carry, three do not.
    const large = new Uint8Array(9_000_000).fill(7)
    const largeReference = mediaReference(sha256(large), "image/png")
    await upload(proxy, host, large)
    expect(host.bodies()).toBe(0)
    // Loading stops at the limit: the large file's size passes it, so its body is never read.
    const tooLarge = await proxy(contestant([reference, largeReference, largeReference, largeReference]))
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual(tooMuchMedia)
    expect(host.bodies()).toBe(1)
    expect(calls).toBe(0)
    expect((await proxy(contestant([reference, largeReference, largeReference]))).status).toBe(200)
    expect(host.bodies()).toBe(2)
    expect(calls).toBe(1)
  })

  test("a body that names many files reads a few at a time, and answers every missing one", async () => {
    const host = memoryMediaStore()
    let open = 0
    let most = 0
    const store: MediaStore = {
      ...host.store,
      read: async (pathname) => {
        most = Math.max(most, ++open)
        await Bun.sleep(1)
        open--
        return host.store.read(pathname)
      },
    }
    const proxy = service({ mediaStore: store, user: "user-many" })
    const files = Array.from({ length: 30 }, (_, index) => new TextEncoder().encode(`screenshot ${index}`))
    await upload(proxy, host, ...files.slice(0, 25))
    const references = files.map((data) => mediaReference(sha256(data), "image/png"))
    const response = await proxy(contestant(references))
    expect(response.status).toBe(409)
    expect(readMediaMissing(await response.text())).toEqual(files.slice(25).map(sha256))
    expect(most).toBe(8)
    // The files it found are warm for the call after the engine uploads the rest.
    await upload(proxy, host, ...files.slice(25))
    const reads = host.bodies()
    expect((await proxy(contestant(references))).status).toBe(200)
    expect(host.bodies() - reads).toBe(5)
  })

  test("a keep-alive ping answers the same whether or not the proxy has its media", async () => {
    const claude = { ...model, slug: "anthropic/hidden", canonicalSlug: "anthropic/hidden" }
    let calls = 0
    const ping = { [KEEP_ALIVE_HEADER]: "1" }
    const unknown = mediaReference("0".repeat(64), "image/png")
    const failing: MediaStore = { ...memoryMediaStore().store, read: () => Promise.reject(new Error("store down")) }
    for (const assigned of [model, claude]) {
      for (const mediaStore of [memoryMediaStore().store, failing, undefined]) {
        const response = await service({ mediaStore, assigned, upstream: () => calls++ })(contestant(unknown, ping))
        expect(response.status).toBe(204)
        expect(response.headers.get(KEEP_ALIVE_HEADER)).toBe("1")
      }
    }
    expect(calls).toBe(0)
  })

  test("a store that fails answers a call the engine can send inline, without calling OpenRouter", async () => {
    let calls = 0
    const failing: MediaStore = { ...memoryMediaStore().store, read: () => Promise.reject(new Error("store down")) }
    const response = await service({ mediaStore: failing, user: "user-down", upstream: () => calls++ })(
      contestant(mediaReference(digest, "image/png")),
    )
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(readMediaUnavailable(body)).toBe(true)
    expect(body).not.toContain("store down")
    expect(calls).toBe(0)
  })

  test("a store that stops answering lets the call go at its deadline, and lets go of what it opened", async () => {
    const host = memoryMediaStore()
    const other = new TextEncoder().encode("another screenshot")
    await upload(service({ mediaStore: host.store, user: "user-stuck" }), host, png, other)
    const body = { messages: [digest, sha256(other)].map((id) => mediaReference(id, "image/png")) }
    let cancelled = 0
    // It never opens one file, and the other's body never ends; neither looks at the signal.
    const stuck: MediaStore = {
      ...host.store,
      read: async (pathname) => {
        if (pathname.endsWith(digest)) return new Promise(() => {})
        const file = await host.store.read(pathname)
        return (
          file && {
            ...file,
            body: new ReadableStream<Uint8Array>({ cancel: () => void cancelled++ }),
          }
        )
      },
    }
    const startedAt = Date.now()
    const resolving = resolveMedia(stuck, "user-stuck", body, new Date(), AbortSignal.timeout(50))
    await expect(resolving).rejects.toMatchObject({ name: "TimeoutError" })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(cancelled).toBe(1)
  })

  test("text that only looks like a reference is left alone", async () => {
    let sent = ""
    const proxy = service({ mediaStore: memoryMediaStore().store, upstream: (body) => (sent = body) })
    const text = `see ${mediaReference(digest, "image/png")}`
    const response = await proxy(contestant(text))
    expect(response.status).toBe(200)
    expect(sent).toContain(text)
  })
})
