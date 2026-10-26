/**
 * Runtime permission policy for Arena sessions.
 *
 * Core creates and evaluates permission requests after the HTTP turn has
 * started, so the setting must be looked up by session at evaluation time.
 * Keep this state in-process; it is policy state, not a persisted user
 * preference and must never be serialized into a prompt or provider request.
 */
const values = new Map<string, boolean>()

export function setArenaAutoAccept(sessionID: string, enabled: boolean) {
  values.set(sessionID, enabled)
}

export function getArenaAutoAccept(sessionID: string) {
  return values.get(sessionID) ?? false
}

export function clearArenaAutoAccept(sessionID: string) {
  values.delete(sessionID)
}

/** Clear all entries when a host tears down a test or an Arena runtime. */
export function clearArenaAutoAcceptRegistry() {
  values.clear()
}
