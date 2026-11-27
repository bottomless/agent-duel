/**
 * Where the control plane keeps the images and PDFs a contestant request names by reference
 * (`media.ts`). The hosted control plane implements it on a private object store, in its own
 * repository; this package carries no storage SDK. A service without a store answers 404 on the
 * media routes, and the engine sends media inline.
 *
 * A file expires `MEDIA_LIFETIME_DAYS` after it was written, by either write below, and the store
 * deletes it no more than a day later. A write to a pathname that already holds a file replaces it,
 * so a file that expired, or whose bytes went wrong, is uploaded again under the same reference.
 */
export type MediaStore = {
  /**
   * A URL that takes one PUT of `contentType` and at most `maxBytes`, valid for a few minutes. The
   * desktop sends the file's bytes straight to it, with no Arena credential.
   */
  readonly uploadUrl: (input: {
    readonly pathname: string
    readonly contentType: string
    readonly maxBytes: number
  }) => Promise<string>
  /** Writes bytes the control plane received itself. */
  readonly write: (input: {
    readonly pathname: string
    readonly contentType: string
    readonly data: Uint8Array
  }) => Promise<void>
  /**
   * The file's size and expiry, with its body still unread; undefined when the pathname holds no file.
   * Gives up, body included, when `signal` aborts.
   */
  readonly read: (pathname: string, options?: { readonly signal?: AbortSignal }) => Promise<StoredMedia | undefined>
}

export type StoredMedia = {
  readonly size: number
  readonly expiresAt: Date
  /** The reader cancels a body it does not read. */
  readonly body: ReadableStream<Uint8Array>
}

export const MEDIA_LIFETIME_DAYS = 3

/** Every file of one account: a privacy request deletes them by this prefix. */
export const mediaAccountPrefix = (userId: string) => `arena-media/${userId}/`

/**
 * Files are per account, so a caller never reads another account's file by naming its digest: the
 * account comes from the session and the digest is the last segment.
 */
export const mediaPathname = (userId: string, digest: string) => `${mediaAccountPrefix(userId)}${digest}`
