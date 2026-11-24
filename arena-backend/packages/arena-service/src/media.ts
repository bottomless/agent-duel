import { MEDIA_REFERENCE } from "./generation-capture"

/**
 * Media a hosted contestant request carries by reference. Vercel refuses a function request over
 * about 4.5 MB, and a chat that reads screenshots sends every one again on every call. Leaving the
 * oldest out to fit rewrote the prompt prefix, which costs Claude a full cache write each time. So
 * the engine asks `MEDIA_UPLOAD_PATH` for an upload URL per image or PDF, PUTs each file's bytes
 * straight to the control plane's object store (`media-store.ts`), and names it in the request with
 * `mediaReference`. The proxy puts the data back before OpenRouter sees the body. A file is stored
 * per account under the SHA-256 of its bytes. It is missing 3 days after the upload, and the store
 * deletes it within the next day.
 */
export const MEDIA_UPLOAD_PATH = "/api/v1/arena/media-upload"
/**
 * Desktops released before `MEDIA_UPLOAD_PATH` POST each file's raw bytes here, one function request
 * per file. The control plane writes them to the same store.
 */
export const MEDIA_PATH = "/api/v1/arena/media"
/** A `MEDIA_PATH` upload's media type; its body is the raw bytes. */
export const MEDIA_TYPE_HEADER = "x-arena-media-type"
/**
 * The largest file one upload URL takes. No provider takes this much media in one request
 * (`request-size.ts` in opencode), so every file a request can send goes by reference.
 */
export const MEDIA_FILE_BYTES = 16_000_000
// As many files as a request may name (`generation-capture.ts`).
const MEDIA_UPLOAD_FILES = 200
const MEDIA_MISSING_TYPE = "arena_media_missing"

export { MEDIA_REFERENCE }

/** Images and PDFs: what a contestant request carries as base64 data URLs. */
export function sendsByReference(mimeType: string) {
  const type = mimeType.toLowerCase()
  return type.startsWith("image/") || type === "application/pdf"
}

/** A media type the routes take: an image or a PDF, written as a reference can carry it. */
export function isMediaType(value: unknown): value is string {
  return typeof value === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value) && sendsByReference(value)
}

export function mediaReference(digest: string, mimeType: string) {
  return `${MEDIA_REFERENCE}${digest}:${mimeType}`
}

/** One file a `MEDIA_UPLOAD_PATH` request asks an upload URL for. */
export type MediaUpload = {
  /** SHA-256 of the file's bytes, in lowercase hex. */
  readonly digest: string
  readonly mimeType: string
  /** The file's size in bytes; its URL takes no more. */
  readonly size: number
}

/** What `MEDIA_UPLOAD_PATH` takes: every file a call needs uploaded, in one request. */
export function mediaUploadRequest(files: ReadonlyArray<MediaUpload>) {
  return { files: files.map(({ digest, mimeType, size }) => ({ digest, mimeType, size })) }
}

/** The files a `mediaUploadRequest` body lists, or undefined when the route refuses the body. */
export function readMediaUploadRequest(body: string): MediaUpload[] | undefined {
  let files: unknown
  try {
    files = (JSON.parse(body) as { files?: unknown } | null)?.files
  } catch {
    return undefined
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MEDIA_UPLOAD_FILES) return undefined
  const uploads = files.flatMap((file: Partial<Record<keyof MediaUpload, unknown>> | null): MediaUpload[] => {
    if (typeof file !== "object" || file === null) return []
    const { digest, mimeType, size } = file
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !isMediaType(mimeType)) return []
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MEDIA_FILE_BYTES) return []
    return [{ digest, mimeType, size }]
  })
  return uploads.length === files.length ? uploads : undefined
}

/** What `MEDIA_UPLOAD_PATH` answers: one URL per file, each taking one PUT of that file's bytes. */
export function mediaUploadAnswer(uploads: ReadonlyArray<{ readonly digest: string; readonly url: string }>) {
  return { uploads: uploads.map(({ digest, url }) => ({ digest, url })) }
}

/** Each file's upload URL by digest from a `mediaUploadAnswer` body, or undefined for any other body. */
export function readMediaUploadAnswer(body: string) {
  try {
    const uploads = (JSON.parse(body) as { uploads?: unknown } | null)?.uploads
    if (!Array.isArray(uploads)) return undefined
    const urls = new Map<string, string>()
    for (const upload of uploads as ReadonlyArray<{ digest?: unknown; url?: unknown } | null>) {
      if (typeof upload?.digest !== "string" || typeof upload.url !== "string") return undefined
      urls.set(upload.digest, upload.url)
    }
    return urls
  } catch {
    return undefined
  }
}

/** The proxy has no media for these references; the engine uploads them and sends the request again. */
export function mediaMissingError(missing: ReadonlyArray<string>) {
  return { error: { message: "Arena media is missing", type: MEDIA_MISSING_TYPE, missing: [...missing] } }
}

/** The request names more media than any provider takes. Refused before it is built, not retried. */
export function mediaTooLargeError() {
  return { error: { message: "Arena request carries too much media", type: "arena_media_too_large" } }
}

/** The digests a `mediaMissingError` body names, or undefined for any other body. */
export function readMediaMissing(body: string | undefined) {
  if (!body) return undefined
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; missing?: unknown } } | null)?.error
    if (error?.type !== MEDIA_MISSING_TYPE || !Array.isArray(error.missing)) return undefined
    return error.missing.filter((digest): digest is string => typeof digest === "string")
  } catch {
    return undefined
  }
}
