import { createHash } from "crypto"
import type { ArenaCollection, ArenaDb } from "./collection"

/**
 * How much one account may upload per window for contestant calls to send by reference (`media.ts`):
 * what its upload URLs may take, and what the route for released desktops writes. Guesses: well over
 * what a day of battles uploads, and low enough that a script cannot fill the store.
 */
export type MediaUploadLimit = {
  readonly maxBytes: number
  readonly maxFiles: number
  readonly windowMs: number
}

export const defaultMediaUploadLimit: MediaUploadLimit = {
  maxBytes: 2_000_000_000,
  maxFiles: 20_000,
  windowMs: 24 * 60 * 60_000,
}

type LimitDocument = {
  readonly _id: string
  readonly userId: string
  readonly window: number
  readonly bytes: number
  readonly files: number
}

function limits(db: ArenaDb): ArenaCollection<LimitDocument> {
  return db.collection<LimitDocument>("arenaMediaUploadLimits")
}

/**
 * Counts an upload against the caller's window and answers whether it is within the limit. A refused
 * upload counts too: an account over the limit stays over it until the window ends.
 */
export async function admitMediaUpload(
  db: ArenaDb,
  userId: string,
  upload: { readonly bytes: number; readonly files: number },
  limit: MediaUploadLimit,
  now: Date,
) {
  const window = Math.floor(now.getTime() / limit.windowMs)
  const _id = createHash("sha256").update(`${userId.length}:${userId}|media`).digest("hex")
  const within = (total: { readonly bytes: number; readonly files: number }) =>
    total.bytes <= limit.maxBytes && total.files <= limit.maxFiles
  const counted = await limits(db).findOneAndUpdate(
    { _id, window },
    { $inc: { bytes: upload.bytes, files: upload.files } },
    { returnDocument: "after" },
  )
  if (counted) return within(counted)
  // A new window replaces the last one, so each account keeps one document. Two uploads that open a
  // window at once can both start it, which lets one through uncounted.
  await limits(db).replaceOne({ _id }, { _id, userId, window, ...upload }, { upsert: true })
  return within(upload)
}

/** The account uploaded its limit for now. The engine sends media inline until it may again. */
export function mediaUploadLimitError() {
  return { error: { message: "Arena media upload limit reached", type: "arena_media_upload_limit" } }
}
