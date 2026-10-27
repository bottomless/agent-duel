import { createHash } from "crypto"
import type { ArenaCollection, ArenaDb } from "./collection"

// A contestant stream can die between the control plane and the desktop without either side seeing
// a close: the function finishes, and the desktop waits for bytes that never come. Heartbeats let the
// desktop tell a dead connection from a model that is thinking, and the recorded response lets it
// fetch the answer it lost instead of paying for a new one.

/** How quiet a recovering stream may get before the proxy writes a heartbeat comment. */
export const HEARTBEAT_MS = 10_000
/** Set on every stream that carries heartbeats and can be replayed, with the heartbeat period. */
export const HEARTBEAT_HEADER = "x-arena-heartbeat-ms"
export const HEARTBEAT_LINE = ": arena-heartbeat"
/** Ends a replay that waited for a response that will never be recorded. */
export const REPLAY_UNAVAILABLE_LINE = ": arena-replay-unavailable"
/** Below `/api/openrouter`, beside the two model routes. */
export const REPLAY_PATH = "/api/v1/arena/replay"

// A TTL index on `expiresAt` deletes expired records; the control plane creates it by migration.
const REPLAY_TTL_MS = 15 * 60_000
// A record is one MongoDB document. Sealed reasoning makes a response larger than its text.
const REPLAY_MAX_CHARS = 8 * 1024 * 1024
// The engine's model-idle deadline is 150 seconds from the last chunk it received, and the desktop
// spends 30 of them deciding the connection is dead.
const REPLAY_WAIT_MS = 120_000
const REPLAY_POLL_MS = 1_000

type ReplayDocument = {
  readonly _id: string
  readonly userId: string
  readonly state: "streaming" | "complete" | "failed"
  readonly body?: string
  readonly expiresAt: Date
}

export type ReplayKey = {
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly generationID: string
}

function replays(db: ArenaDb): ArenaCollection<ReplayDocument> {
  return db.collection<ReplayDocument>("arenaGenerationReplays")
}

function replayID(key: ReplayKey) {
  return createHash("sha256")
    .update(
      `${key.userId.length}:${key.userId}|${key.scopeID.length}:${key.scopeID}|${key.assignmentID.length}:${key.assignmentID}|${key.generationID}`,
    )
    .digest("hex")
}

export type ReplayRecorder = ReturnType<typeof replayRecorder>

/** Keeps the exact bytes a stream sent, minus heartbeats, until the response ends. */
export function replayRecorder(db: ArenaDb, key: ReplayKey, now: () => Date) {
  const id = replayID(key)
  const parts: string[] = []
  let size = 0
  let oversized = false
  let settled = false
  // Writes run in order, so a slow "streaming" marker can never land after the final record.
  let writes = Promise.resolve()
  const save = (fields: Pick<ReplayDocument, "state" | "body">) => {
    writes = writes
      .then(() =>
        replays(db).replaceOne(
          { _id: id },
          { _id: id, userId: key.userId, ...fields, expiresAt: new Date(now().getTime() + REPLAY_TTL_MS) },
          { upsert: true },
        ),
      )
      .then(
        () => undefined,
        () => console.error("[arena-service] Arena generation replay could not be recorded"),
      )
    return writes
  }
  void save({ state: "streaming" })
  return {
    record(text: string) {
      if (oversized || settled) return
      size += text.length
      if (size <= REPLAY_MAX_CHARS) {
        parts.push(text)
        return
      }
      oversized = true
      parts.length = 0
    },
    complete() {
      if (settled) return writes
      settled = true
      return save(oversized ? { state: "failed" } : { state: "complete", body: parts.join("") })
    },
    fail() {
      if (settled) return writes
      settled = true
      parts.length = 0
      return save({ state: "failed" })
    },
  }
}

const streamHeaders = () =>
  new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    [HEARTBEAT_HEADER]: String(HEARTBEAT_MS),
  })

/**
 * Answers with the recorded response for a generation. While the original request still streams,
 * it waits with heartbeats and sends the response once recorded, or ends with
 * `REPLAY_UNAVAILABLE_LINE`. With nothing to wait for it answers 404 before any byte.
 */
export async function replayResponse(db: ArenaDb, key: ReplayKey, now: () => Date, signal?: AbortSignal) {
  const id = replayID(key)
  const read = () => replays(db).findOne({ _id: id, userId: key.userId })
  const usable = (document: ReplayDocument | null) =>
    document !== null && document.state !== "failed" && document.expiresAt.getTime() > now().getTime()
  const first = await read()
  if (!usable(first)) {
    return Response.json(
      { error: { message: "Arena contestant response is not available", type: "arena_replay_unavailable" } },
      { status: 404 },
    )
  }
  const encoder = new TextEncoder()
  if (first!.state === "complete") {
    return new Response(encoder.encode(first!.body ?? ""), { status: 200, headers: streamHeaders() })
  }
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now()
      let lastWrite = startedAt
      try {
        while (!cancelled && !signal?.aborted && Date.now() - startedAt < REPLAY_WAIT_MS) {
          await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS))
          const document = await read()
          if (cancelled) return
          if (document?.state === "complete") {
            controller.enqueue(encoder.encode(document.body ?? ""))
            controller.close()
            return
          }
          if (!usable(document)) break
          if (Date.now() - lastWrite >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(`${HEARTBEAT_LINE}\n`))
            lastWrite = Date.now()
          }
        }
        if (cancelled) return
        controller.enqueue(encoder.encode(`${REPLAY_UNAVAILABLE_LINE}\n`))
        controller.close()
      } catch {
        if (cancelled) return
        controller.enqueue(encoder.encode(`${REPLAY_UNAVAILABLE_LINE}\n`))
        controller.close()
      }
    },
    cancel() {
      cancelled = true
    },
  })
  return new Response(body, { status: 200, headers: streamHeaders() })
}
