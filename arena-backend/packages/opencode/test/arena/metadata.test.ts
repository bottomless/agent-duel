import { afterEach, describe, expect, test } from "bun:test"
import { MAX_METADATA_CHANGES_CHARS } from "@agent-duel/arena-service/metadata"
import { utilityModels } from "@agent-duel/arena-service/utility-model"
import { hashArenaControlToken, setArenaCredentials } from "@/arena/credentials"
import { generate } from "@/arena/metadata"
import { closeStore } from "@/arena/runtime"

type NetworkRequest = {
  readonly url: string
  readonly authorization: string | null
  readonly body: Record<string, unknown>
}

const originalFetch = globalThis.fetch

afterEach(async () => {
  await closeStore()
  setArenaCredentials(undefined)
  globalThis.fetch = originalFetch
})

function fakeNetwork(answer: () => Response) {
  const requests: NetworkRequest[] = []
  const execute = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    })
    return answer()
  }
  globalThis.fetch = Object.assign(execute, { preconnect: originalFetch.preconnect.bind(originalFetch) })
  return requests
}

function hosted() {
  setArenaCredentials({
    mode: "hosted",
    researchPartition: "test-research-partition",
    researchAccountID: "test-account",
    token: "test-session",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: hashArenaControlToken("local-control-token"),
  })
}

describe("ArenaMetadata", () => {
  test("BYOK writes a commit message in process on the user's key, without a rate limit", async () => {
    setArenaCredentials({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-user-key",
      controlTokenHash: hashArenaControlToken("local-control-token"),
    })
    const network = fakeNetwork(() => Response.json({ choices: [{ message: { content: "Add retries" } }] }))

    expect(await generate({ kind: "commit_message", changes: "M\tsrc/retry.ts\t(+4 -0)" })).toEqual({
      message: "Add retries",
    })
    expect(network).toEqual([
      {
        url: "https://openrouter.ai/api/v1/chat/completions",
        authorization: "Bearer sk-or-v1-user-key",
        body: expect.objectContaining({ model: utilityModels[0].id, max_tokens: 1_024 }),
      },
    ])
  })

  test("hosted sends the account's request to the control plane with the changes trimmed to its cap", async () => {
    hosted()
    const network = fakeNetwork(() => Response.json({ title: "Fix login", body: "Keeps the query." }))

    const result = await generate({
      kind: "pull_request",
      changes: "x".repeat(MAX_METADATA_CHANGES_CHARS + 100),
      instructions: "  Lead with a summary  ",
    })

    expect(result).toEqual({ title: "Fix login", body: "Keeps the query." })
    expect(network[0]?.url).toBe("https://control.test/api/arena/metadata")
    expect(network[0]?.authorization).toBe("Bearer test-session")
    expect(String(network[0]?.body.changes)).toHaveLength(MAX_METADATA_CHANGES_CHARS)
    expect(network[0]?.body.instructions).toBe("Lead with a summary")
  })

  test("answers a suggested branch name", async () => {
    hosted()
    fakeNetwork(() => Response.json({ branch: "feat/retry-backoff" }))

    expect(await generate({ kind: "branch_name", changes: "Chat: Add retries" })).toEqual({
      branch: "feat/retry-backoff",
    })
  })

  test("answers a chat title", async () => {
    hosted()
    fakeNetwork(() => Response.json({ title: "Explain the retry policy" }))

    expect(await generate({ kind: "chat_title", changes: "Explain what retry.js does" })).toEqual({
      title: "Explain the retry policy",
    })
  })

  test("throws on a refusal or a malformed answer, so the daemon writes its fixed text", async () => {
    hosted()
    fakeNetwork(() => Response.json({ error: "Too many Arena metadata requests" }, { status: 429 }))
    await expect(generate({ kind: "commit_message", changes: "diff" })).rejects.toThrow("status 429")

    fakeNetwork(() => Response.json({ title: "No body" }))
    await expect(generate({ kind: "pull_request", changes: "diff" })).rejects.toThrow("without text")
  })

  test("throws before any request without credentials", async () => {
    const network = fakeNetwork(() => Response.json({}))
    await expect(generate({ kind: "commit_message", changes: "diff" })).rejects.toThrow("credentials")
    expect(network).toEqual([])
  })
})
