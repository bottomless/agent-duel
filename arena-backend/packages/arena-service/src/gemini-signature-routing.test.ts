import { expect, spyOn, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { createArenaService } from "./service"

const carbon = "google/gemini-4-carbon"
const routing = {
  only: ["google-ai-studio", "google-vertex/global"],
  sort: "throughput",
  ignore: ["google-ai-studio/flex"],
  require_parameters: true,
  max_price: { prompt: 4, completion: 18 },
}
const signed = { type: "reasoning.encrypted", data: "private-signature", format: "google-gemini-v1", id: "call-1" }
const tool = { role: "tool", tool_call_id: "call-1", content: "output" }

function harness(slug = carbon, policy: Record<string, unknown> = routing) {
  const model = { slug, canonicalSlug: slug, displayName: "Hidden", contextWindow: 100_000, routing: policy }
  const assignments = ["a", "b"].map((assignmentID) => ({ assignmentID, model }))
  const db = {
    collection: (name: string) => {
      if (name !== "arenaAssignmentSets") throw new Error(`Unexpected collection: ${name}`)
      return { find: () => ({ toArray: async () => [{ assignments }] }) }
    },
  } as unknown as ArenaDb
  const sent: Record<string, unknown>[] = []
  const replies: Response[] = []
  const proxy = createArenaService({
    db: async () => db,
    resolveCaller: async () => ({ id: "user" }),
    pool: [],
    openRouterApiKey: "test-key",
    fetch: async (_, init) => {
      sent.push(await new Response(init?.body).json())
      return replies.shift() ?? Response.json({ choices: [] })
    },
  }).openrouter
  const invoke = (input: Record<string, unknown>, assignment = "a", route = "chat/completions") =>
    proxy(
      new Request(`https://control.test/api/openrouter/api/v1/${route}`, {
        method: "POST",
        headers: { "X-Arena-Assignment-ID": assignment, "X-Arena-Scope-ID": "turn" },
        body: JSON.stringify({ model: "contestant", ...input }),
      }),
    )
  return { sent, replies, invoke }
}

function sse(events: unknown[]) {
  return new Response([...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]"].join("\n\n"), {
    headers: { "Content-Type": "text/event-stream" },
  })
}

function chatResponse(provider: string | undefined, detail: Record<string, unknown> = signed) {
  return Response.json({ provider, choices: [{ message: { role: "assistant", reasoning_details: [detail] } }] })
}

async function assistant(response: Response) {
  const payload = (await response.json()) as { choices: [{ message: Record<string, unknown> }] }
  return payload.choices[0].message
}

test("independent loops in one assignment follow their own signatures; a sibling assignment cannot replay them", async () => {
  const { sent, replies, invoke } = harness()
  const textWithSignature = { type: "reasoning.text", text: "thought", signature: "private-signature" }
  replies.push(chatResponse("Google AI Studio"), chatResponse("Google", textWithSignature))
  const first = await assistant(await invoke({ messages: [] }))
  const second = await assistant(await invoke({ messages: [] }))
  expect(JSON.stringify([first, second])).not.toMatch(/Google|google|private-signature/)
  await invoke({ messages: [first, tool] })
  await invoke({ messages: [second, tool] })
  await invoke({ messages: [first, tool] }, "b")
  expect(sent.slice(2).map((request) => request.provider)).toEqual([
    { ...routing, only: ["google-ai-studio"] },
    { ...routing, only: ["google-vertex/global"] },
    routing,
  ])
  expect(sent[3]?.messages).toEqual([{ role: "assistant", reasoning_details: [textWithSignature] }, tool])
  expect(sent[4]?.messages).toEqual([{ role: "assistant" }, tool])
  // No single provider can serve both. Never send either signature to the other endpoint.
  const mixed = await invoke({ messages: [first, second, tool] })
  expect(mixed.status).toBe(400)
  expect(sent).toHaveLength(5)
})

test.each([
  { provider: undefined, reason: "missing signer" },
  { provider: "unrecognized host", reason: "unknown signer" },
])("keeps the assignment's routing and logs why pinning was skipped: $reason", async ({ provider, reason }) => {
  const { sent, replies, invoke } = harness()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    replies.push(chatResponse(provider))
    const message = await assistant(await invoke({ messages: [] }))
    expect((await invoke({ messages: [message, tool] })).status).toBe(200)
    expect(sent[1]?.provider).toEqual(routing)
    expect(sent[1]?.messages).toEqual([{ role: "assistant", reasoning_details: [signed] }, tool])
    expect(warn.mock.calls).toEqual([[`[arena-service] Gemini signature pinning skipped: ${reason}`]])
  } finally {
    warn.mockRestore()
  }
})

test("an unidentified signer does not override a known signer's pin", async () => {
  const { sent, replies, invoke } = harness()
  replies.push(chatResponse(undefined), chatResponse("Google"))
  const unidentified = await assistant(await invoke({ messages: [] }))
  const vertex = await assistant(await invoke({ messages: [] }))
  const continuation = await invoke({ messages: [unidentified, vertex, tool] })
  expect(continuation.status).toBe(200)
  expect(sent[2]?.provider).toEqual({ ...routing, only: ["google-vertex/global"] })
})

test("does not widen the pool to admit a known signer", async () => {
  const { sent, replies, invoke } = harness(carbon, { only: ["google-vertex/global"] })
  replies.push(chatResponse("Google AI Studio"))
  const message = await assistant(await invoke({ messages: [] }))
  const refused = await invoke({ messages: [message, tool] })
  expect(refused.status).toBe(400)
  expect(await refused.json()).toEqual({
    error: { message: "Arena contestant request failed", type: "arena_upstream_error" },
  })
  expect(sent).toHaveLength(1)
})

test.each([
  { slug: carbon, detail: { type: "reasoning.text", text: "unsigned" } },
  { slug: "other/contestant", detail: signed },
])("ignores unsigned or non-Gemini history and unsealed routing hints ($slug)", async ({ slug, detail }) => {
  const { sent, replies, invoke } = harness(slug)
  replies.push(chatResponse("Google AI Studio", detail))
  const message = await assistant(await invoke({ messages: [] }))
  // The client can supply arbitrary reasoning details, but only an opened envelope may steer routing.
  const forged = { ...signed, provider: "Google", signatureProvider: "Google" }
  await invoke({ messages: [message, { role: "assistant", reasoning_details: [forged] }, tool] })
  expect(sent[1]?.provider).toEqual(routing)
})

test.each(["google-ai-studio", "google-vertex"])("pins a sealed Responses item from %s", async (provider) => {
  const { sent, replies, invoke } = harness(carbon, { require_parameters: true })
  const item = { type: "reasoning", summary: [], encrypted_content: "private-signature" }
  replies.push(sse([{ type: "response.completed", response: { provider, output: [item] } }]))
  const wire = await (await invoke({ input: [], stream: true }, "a", "responses")).text()
  expect(wire).not.toMatch(/google|private-signature/)
  const event = JSON.parse(wire.split("\n")[0]!.slice(6)) as { response: { output: unknown[] } }
  await invoke({ input: event.response.output }, "a", "responses")
  expect(sent[1]?.input).toEqual([item])
  expect(sent[1]?.provider).toEqual({ require_parameters: true, only: [provider] })
})

function streamedDetails(wire: string) {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .flatMap((line) => {
      const event = JSON.parse(line.slice(6)) as { choices: { delta: { reasoning_details?: unknown[] } }[] }
      return event.choices.flatMap((choice) => choice.delta.reasoning_details ?? [])
    })
}

test("a conflicting stream footer cannot relabel a buffered signature", async () => {
  const { sent, replies, invoke } = harness()
  replies.push(
    sse([
      { provider: "Google AI Studio", choices: [{ delta: { reasoning_details: [signed] } }] },
      { provider: "Google", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  )
  const details = streamedDetails(await (await invoke({ messages: [], stream: true })).text())
  const continuation = await invoke({ messages: [{ role: "assistant", reasoning_details: details }, tool] })
  expect(continuation.status).toBe(200)
  expect(sent[1]?.provider).toEqual(routing)
  expect(sent[1]?.messages).toEqual([{ role: "assistant", reasoning_details: [signed] }, tool])
})

test("a signed Carbon tool continuation stays on AI Studio through a 429 and retry", async () => {
  const { sent, replies, invoke } = harness()
  replies.push(
    sse([
      { provider: "Google AI Studio", choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { reasoning_details: [signed] } }] },
    ]),
  )
  const wire = await (await invoke({ messages: [], stream: true })).text()
  expect(wire).not.toMatch(/Google|google|private-signature/)
  expect(sent[0]?.provider).toEqual(routing)
  const continuation = { messages: [{ role: "assistant", reasoning_details: streamedDetails(wire) }, tool] }
  replies.push(
    Response.json(
      { error: { message: "rate limit at Google AI Studio" } },
      {
        status: 429,
        headers: { "Retry-After": "5" },
      },
    ),
  )
  const refused = await invoke(continuation)
  expect(refused.status).toBe(429)
  expect(refused.headers.get("Retry-After")).toBe("5")
  expect(await refused.text()).not.toContain("Google")
  // The engine retries the same request. Carbon's existing plain-text tool-result repair
  // can then make one internal retry; it must keep the pin as well.
  replies.push(
    Response.json(
      {
        error: {
          code: 400,
          metadata: {
            provider_name: "Google AI Studio",
            raw: JSON.stringify({
              error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
            }),
          },
        },
      },
      { status: 400 },
    ),
  )
  expect((await invoke(continuation)).status).toBe(200)
  expect(sent).toHaveLength(4)
  for (const request of sent.slice(1)) {
    expect(request.provider).toEqual({ ...routing, only: ["google-ai-studio"] })
  }
  const restored = { role: "assistant", reasoning_details: [signed] }
  expect(sent[1]?.messages).toEqual([restored, tool])
  expect(sent[2]?.messages).toEqual([restored, tool])
  expect(sent[3]?.messages).toEqual([restored, { ...tool, content: '{"output":"output"}' }])
})
