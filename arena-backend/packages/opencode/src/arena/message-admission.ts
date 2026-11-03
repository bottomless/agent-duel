import { ArenaCredentialsError } from "./credentials"
import { backend } from "./runtime"

/** Mirrors `SIGN_IN_REQUIRED_CODE` in the protocol's account schemas, which this package cannot import. */
export const SIGN_IN_REQUIRED_CODE = "sign_in_required"

/** An anonymous account has used its messages. The app answers with the sign-in screen. */
export class ArenaSignInRequiredError extends Error {
  readonly code = SIGN_IN_REQUIRED_CODE
  constructor(message = "Sign in to keep using Agent Duel.") {
    super(message)
    this.name = "ArenaSignInRequiredError"
  }
}

/**
 * Asks the control plane before a message the user sends a model goes out, so it can count an
 * anonymous account's messages. `messageID` is the idempotency key: asking again for one message,
 * as a retried request does, counts it once.
 */
export async function admitMessage(messageID: string) {
  const target = backend()
  if (!target) throw new ArenaCredentialsError()
  const response = await target.fetch(`${target.url}/api/arena/messages`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ messageID }),
  })
  if (response.ok) return
  // A control plane deployed before this route has no anonymous accounts to count.
  if (response.status === 404) return
  const payload = (await response.json().catch(() => undefined)) as
    | { readonly error?: unknown; readonly code?: unknown }
    | undefined
  const message = typeof payload?.error === "string" ? payload.error : undefined
  if (payload?.code === SIGN_IN_REQUIRED_CODE) throw new ArenaSignInRequiredError(message)
  throw new Error(message ?? `Arena message request failed with status ${response.status}`)
}
