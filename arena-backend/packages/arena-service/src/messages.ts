import { authorize, type ArenaContext } from "./context"

// The engine asks this route before each message the user sends a model: a battle prompt, a reply or
// steer, and a single-agent message. The hosted control plane serves its own version, which counts an
// anonymous account's messages and refuses them with `sign_in_required` once they run out. Here,
// where a BYOK engine answers it in process, every message is admitted.

const MAX_MESSAGE_ID_CHARS = 512

/** The engine's idempotency key: asking twice for one message counts it once. */
export function messageID(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>).messageID
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= MAX_MESSAGE_ID_CHARS ? trimmed : undefined
}

export async function handleMessagesRequest(request: Request, context: ArenaContext) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
  const caller = await authorize(request, context, (message, status) => Response.json({ error: message }, { status }))
  if (caller instanceof Response) return caller
  const input = await request.json().catch(() => undefined)
  if (!messageID(input)) return Response.json({ error: "Arena message request is invalid" }, { status: 400 })
  return Response.json({ ok: true })
}
