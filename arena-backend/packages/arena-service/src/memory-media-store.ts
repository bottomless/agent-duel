import { MEDIA_LIFETIME_DAYS, type MediaStore } from "./media-store"

const UPLOAD_URL_MS = 5 * 60 * 1000
const LIFETIME_MS = MEDIA_LIFETIME_DAYS * 24 * 60 * 60 * 1000

type Grant = {
  readonly pathname: string
  readonly contentType: string
  readonly maxBytes: number
  readonly expiresAt: number
}

/**
 * A `MediaStore` in memory, for tests. `upload` stands in for the storage host: it takes a PUT to a
 * URL `uploadUrl` gave, and holds it to the URL's content type, size and time. A file past its
 * lifetime stays readable with its expiry, as it does in a store that has not deleted it yet.
 */
export function memoryMediaStore(now: () => Date = () => new Date()) {
  const files = new Map<string, { readonly data: Uint8Array; readonly contentType: string; readonly expiresAt: Date }>()
  const grants = new Map<string, Grant>()
  let bodies = 0
  const keep = (pathname: string, contentType: string, data: Uint8Array) =>
    files.set(pathname, { data, contentType, expiresAt: new Date(now().getTime() + LIFETIME_MS) })
  const store: MediaStore = {
    async uploadUrl({ pathname, contentType, maxBytes }) {
      const url = `https://media-store.test/${pathname}?grant=${crypto.randomUUID()}`
      grants.set(url, { pathname, contentType, maxBytes, expiresAt: now().getTime() + UPLOAD_URL_MS })
      return url
    },
    async write({ pathname, contentType, data }) {
      keep(pathname, contentType, data)
    },
    async read(pathname) {
      const file = files.get(pathname)
      if (!file) return undefined
      return {
        size: file.data.byteLength,
        expiresAt: file.expiresAt,
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodies++
              controller.enqueue(file.data)
              controller.close()
            },
          },
          // Nothing is read ahead, so `bodies` counts only the bodies a reader asked for.
          { highWaterMark: 0 },
        ),
      }
    },
  }
  return {
    store,
    files,
    /** How many file bodies were read, as opposed to opened for their size. */
    bodies: () => bodies,
    async upload(input: string | URL | Request, init?: RequestInit) {
      const request = new Request(input, init)
      const grant = grants.get(request.url)
      if (request.method !== "PUT" || !grant || grant.expiresAt <= now().getTime()) {
        return new Response(null, { status: 403 })
      }
      if (request.headers.get("content-type") !== grant.contentType) return new Response(null, { status: 400 })
      const data = new Uint8Array(await request.arrayBuffer())
      if (data.byteLength > grant.maxBytes) return new Response(null, { status: 413 })
      keep(grant.pathname, grant.contentType, data)
      return new Response(null, { status: 200 })
    },
  }
}
