import type { SessionID } from "@/session/schema"

type PendingDispatch = {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

const pending = new Map<SessionID, PendingDispatch>()

/** Register the root generation before prompting so setup can wait for the request to leave the engine. */
export function waitForInitialDispatch(sessionID: SessionID) {
  if (pending.has(sessionID)) throw new Error(`Arena dispatch is already pending for ${sessionID}`)
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  void promise.catch(() => undefined)
  const entry = { promise, resolve, reject }
  pending.set(sessionID, entry)
  const finish = (complete: () => void) => {
    if (pending.get(sessionID) !== entry) return
    pending.delete(sessionID)
    complete()
  }
  return {
    promise,
    cancel: (error: unknown) => finish(() => reject(error)),
  }
}

/** Called immediately after the upstream fetch has been initiated. */
export function markInitialDispatch(sessionID: string) {
  const key = sessionID as SessionID
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  entry.resolve()
}
