import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto"

export const REDACTED_THINKING = "[Thinking redacted]"
const prefix = "arena_reasoning_v1."
const markerID = "arena_redacted_thinking"
const plaintextFields = ["reasoning", "reasoning_content"]
const fields = new Set([...plaintextFields, "reasoning_details"])
// Count incoming serialized bytes, including metadata, rather than retaining an entire step.
// A single upstream chunk can exceed this limit; it is sealed immediately.
const batchBytes = 64 * 1024

type Binding = { readonly userId: string; readonly scopeID: string; readonly assignmentID: string }
type Packet = {
  kind: "chat" | "responses"
  value: Record<string, unknown>
  stream: boolean
  rendered: string
  plaintextDeduplicated?: boolean
  /** Absent on legacy or unsigned packets. Null means the upstream did not identify the signer. */
  signatureProvider?: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reasoningDetails(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.reasoning_details) ? value.reasoning_details : []
}

function signed(packet: Packet) {
  if (packet.kind === "responses") {
    const content = packet.value.encrypted_content
    return typeof content === "string" && content.length > 0
  }
  return reasoningDetails(packet.value).some(
    (detail) =>
      record(detail) &&
      ((typeof detail.signature === "string" && detail.signature.length > 0) ||
        (detail.type === "reasoning.encrypted" && typeof detail.data === "string" && detail.data.length > 0)),
  )
}

function appendPlaintext(target: Record<string, unknown>, value: Record<string, unknown>) {
  for (const field of plaintextFields) {
    const text = value[field]
    if (typeof text !== "string") continue
    const previous = target[field]
    target[field] = typeof previous === "string" ? previous + text : text
  }
}

function renderedReasoning(value: Record<string, unknown>, details: unknown[]) {
  if (details.length === 0) return typeof value.reasoning === "string" ? value.reasoning : ""
  return details
    .map((detail: unknown) => {
      if (!record(detail)) return ""
      if (detail.type === "reasoning.text" && typeof detail.text === "string") return detail.text
      if (detail.type === "reasoning.summary" && typeof detail.summary === "string") return detail.summary
      return ""
    })
    .join("")
}

/**
 * The engine must echo original reasoning (including late signatures) during tool continuation.
 * Seal it at the cloud boundary instead of disabling thinking or forwarding provider-shaped blocks.
 * Authenticated envelopes need no per-token database writes and survive cloud function restarts.
 */
export function createReasoningRedactor(apiKey: string, binding: Binding, modelSlug?: string) {
  const gemini = modelSlug?.startsWith("google/gemini-")
  let responseProvider: string | null | undefined
  const key = createHash("sha256").update("arena-reasoning-v1\0").update(apiKey).digest()
  const aad = Buffer.from(JSON.stringify([binding.userId, binding.scopeID, binding.assignmentID]))
  const marked = new Set<number>()
  const textStarted = new Set<number>()
  const buffered = new Map<number, { value: Record<string, unknown>; rendered: string; bytes: number }>()

  function id(value: string) {
    return "rs_arena_" + createHmac("sha256", key).update(aad).update(value).digest("hex").slice(0, 32)
  }

  function seal(packet: Packet) {
    if (gemini && signed(packet)) packet.signatureProvider = responseProvider ?? null
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    cipher.setAAD(aad)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(packet)), cipher.final()])
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")
  }

  // An envelope sealed for another scope (an earlier single-agent message), assignment, account, or
  // server key does not open. Callers drop it: it reveals nothing, and only the current tool loop
  // needs its reasoning back.
  function open(token: string, kind: Packet["kind"], signers?: Set<string | null>): Packet | undefined {
    try {
      const bytes = Buffer.from(token.slice(prefix.length), "base64url")
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
      decipher.setAAD(aad)
      decipher.setAuthTag(bytes.subarray(12, 28))
      const decoded: unknown = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      )
      if (
        !record(decoded) ||
        !record(decoded.value) ||
        typeof decoded.stream !== "boolean" ||
        typeof decoded.rendered !== "string" ||
        decoded.kind !== kind
      )
        return undefined
      if (gemini && (typeof decoded.signatureProvider === "string" || decoded.signatureProvider === null)) {
        signers?.add(decoded.signatureProvider)
      }
      return {
        kind,
        value: decoded.value,
        stream: decoded.stream,
        rendered: decoded.rendered,
        plaintextDeduplicated: decoded.plaintextDeduplicated === true,
      }
    } catch {
      return undefined
    }
  }

  function redactMessage(message: Record<string, unknown>, stream: boolean, choice: number, finished = false) {
    const afterText = stream && textStarted.has(choice)
    if (stream && typeof message.content === "string" && message.content.length > 0) textStarted.add(choice)
    const reasoning = Object.fromEntries(
      [...fields].filter((field) => message[field] !== undefined).map((field) => [field, message[field]]),
    )
    const safe = Object.fromEntries(Object.entries(message).filter(([field]) => !fields.has(field)))
    const hasReasoning = Object.values(reasoning).some((value) =>
      Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0,
    )
    const chunkDetails = reasoningDetails(reasoning)
    const rendered = afterText ? "" : renderedReasoning(reasoning, chunkDetails)
    let packet: Packet | undefined
    if (stream) {
      if (hasReasoning) {
        const pending = buffered.get(choice) ?? { value: {}, rendered: "", bytes: 0 }
        // Prefer provider details only for the chunk that supplied them. A batch can also
        // contain plaintext-only chunks, which cannot be recovered from its merged details.
        if (chunkDetails.length > 0) {
          const details = reasoningDetails(pending.value)
          mergeDetails(details, chunkDetails, true)
          pending.value.reasoning_details = details
        } else appendPlaintext(pending.value, reasoning)
        pending.rendered += rendered
        pending.bytes += Buffer.byteLength(JSON.stringify(reasoning))
        buffered.set(choice, pending)
      }
      const pending = buffered.get(choice)
      if (
        pending &&
        (finished ||
          pending.bytes >= batchBytes ||
          (typeof message.content === "string" && message.content.length > 0) ||
          (Array.isArray(message.tool_calls) && message.tool_calls.length > 0))
      ) {
        packet = {
          kind: "chat",
          value: pending.value,
          rendered: pending.rendered,
          stream: true,
          plaintextDeduplicated: true,
        }
        buffered.delete(choice)
      }
    } else if (hasReasoning) packet = { kind: "chat", value: reasoning, stream: false, rendered }
    if (!hasReasoning && !packet) return safe
    const details: Record<string, unknown>[] = []
    // Empty markers keep reasoning progress flowing without repeating visible text or
    // making one encrypted continuation envelope for every provider token.
    if (hasReasoning) {
      details.push({
        type: "reasoning.text",
        text: !stream || !marked.has(choice) ? REDACTED_THINKING : "",
        format: "unknown",
        id: markerID,
      })
      marked.add(choice)
    }
    if (packet) details.push({ type: "reasoning.encrypted", data: seal(packet), format: "unknown" })
    return { ...safe, reasoning: REDACTED_THINKING, reasoning_details: details }
  }

  function flush() {
    const choices = [...buffered.keys()].map((index) => ({
      index,
      delta: redactMessage({}, true, index, true),
      finish_reason: null,
    }))
    return choices.length ? { choices } : undefined
  }

  function clear() {
    responseProvider = undefined
    buffered.clear()
    marked.clear()
    textStarted.clear()
  }

  function redactItem(item: Record<string, unknown>, stream: boolean) {
    return {
      type: "reasoning",
      ...(typeof item.id === "string" ? { id: id(item.id) } : {}),
      summary: [{ type: "summary_text", text: REDACTED_THINKING }],
      encrypted_content: seal({ kind: "responses", value: item, stream, rendered: "" }),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
    }
  }

  function redact(value: unknown, stream = false, provider?: string): unknown {
    if (provider) {
      // A signature can sit in a batch until a later SSE event. A conflicting label on the
      // flush event cannot identify which endpoint signed that batch.
      if (responseProvider === undefined) responseProvider = provider
      else if (responseProvider !== provider) responseProvider = null
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, stream))
    if (!record(value)) return value
    if (value.type === "reasoning") return redactItem(value, stream)
    const type = typeof value.type === "string" ? value.type : ""
    if (type.startsWith("response.reasoning")) {
      const safe = { ...value }
      if (typeof safe.item_id === "string") safe.item_id = id(safe.item_id)
      for (const field of ["delta", "text"]) if (typeof safe[field] === "string") safe[field] = REDACTED_THINKING
      if (record(safe.part)) safe.part = { type: "summary_text", text: REDACTED_THINKING }
      return safe
    }
    const safe: Record<string, unknown> = { ...value }
    if (Array.isArray(value.choices)) {
      safe.choices = value.choices.map((choice) => {
        if (!record(choice)) return choice
        const index = typeof choice.index === "number" ? choice.index : 0
        return {
          ...choice,
          ...(record(choice.delta) || (stream && choice.finish_reason != null)
            ? {
                delta: redactMessage(
                  record(choice.delta) ? choice.delta : {},
                  stream,
                  index,
                  choice.finish_reason != null,
                ),
              }
            : {}),
          ...(record(choice.message) ? { message: redactMessage(choice.message, false, index) } : {}),
        }
      })
    }
    for (const field of ["output", "item", "response", "data"]) {
      if (safe[field] !== undefined) safe[field] = redact(safe[field], stream)
    }
    return safe
  }

  // Match the OpenRouter SDK's streaming accumulator: text fragments share a block;
  // signatures can arrive in the final fragment, while encrypted/summary blocks stay ordered.
  function mergeDetails(target: unknown[], incoming: unknown[], stream: boolean) {
    for (const detail of incoming) {
      const previous = target.at(-1)
      if (
        stream &&
        record(detail) &&
        detail.type === "reasoning.text" &&
        record(previous) &&
        previous.type === "reasoning.text"
      ) {
        previous.text = String(previous.text ?? "") + String(detail.text ?? "")
        if (!previous.signature && detail.signature !== undefined) previous.signature = detail.signature
        if (!previous.format && detail.format !== undefined) previous.format = detail.format
      } else target.push(structuredClone(detail))
    }
  }

  function restoreMessage(message: Record<string, unknown>, signers?: Set<string | null>) {
    if (message.role !== "assistant" || !Array.isArray(message.reasoning_details)) return message
    const details: unknown[] = []
    const restored: Record<string, unknown> = { ...message }
    for (const field of fields) delete restored[field]
    let redacted = false
    let rendered = ""
    for (const detail of message.reasoning_details) {
      if (record(detail) && detail.id === markerID) {
        redacted = true
        continue
      }
      if (!record(detail) || typeof detail.data !== "string" || !detail.data.startsWith(prefix)) {
        details.push(detail)
        continue
      }
      redacted = true
      const packet = open(detail.data, "chat", signers)
      if (!packet) continue
      rendered += packet.rendered
      const packetDetails = reasoningDetails(packet.value)
      // Older envelopes and JSON replies did not filter plaintext before sealing. Prefer
      // their original provider details when present; never synthesize structured blocks.
      if (packet.plaintextDeduplicated || packetDetails.length === 0) appendPlaintext(restored, packet.value)
      mergeDetails(details, packetDetails, packet.stream)
    }
    // Markers never go upstream, even when no envelope opened.
    if (!redacted) return message
    if (details.length > 0) restored.reasoning_details = details
    else if (restored.reasoning === undefined && rendered) restored.reasoning = rendered
    return restored
  }

  function restore(input: Record<string, unknown>, signers?: Set<string | null>): Record<string, unknown> {
    const restored = { ...input }
    if (Array.isArray(input.messages))
      restored.messages = input.messages.map((message) =>
        record(message) ? restoreMessage(message, signers) : message,
      )
    if (Array.isArray(input.input)) {
      restored.input = input.input.flatMap((item) => {
        if (
          !record(item) ||
          item.type !== "reasoning" ||
          typeof item.encrypted_content !== "string" ||
          !item.encrypted_content.startsWith(prefix)
        )
          return [item]
        const packet = open(item.encrypted_content, "responses", signers)
        return packet ? [packet.value] : []
      })
    }
    return restored
  }

  return { redact, restore, flush, clear }
}
