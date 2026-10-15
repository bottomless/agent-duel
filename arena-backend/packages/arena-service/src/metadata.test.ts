import { describe, expect, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { MAX_METADATA_CHANGES_CHARS, parseMetadataReply } from "./metadata"
import { createArenaService, type ArenaServiceOptions } from "./service"
import { comparisonModel } from "./utility-model"

function request(body: unknown) {
  return new Request("https://control.test/api/arena/metadata", {
    method: "POST",
    headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

// Enough of a collection for the per-account window: one document per account.
function memoryDb() {
  const documents = new Map<string, Record<string, unknown>>()
  const db = {
    collection: () => ({
      async findOneAndUpdate(filter: Record<string, unknown>, update: { $inc: { count: number } }) {
        const current = documents.get(String(filter._id))
        if (!current || current.window !== filter.window) return null
        const next = { ...current, count: Number(current.count) + update.$inc.count }
        documents.set(String(filter._id), next)
        return next
      },
      async replaceOne(filter: Record<string, unknown>, replacement: Record<string, unknown>) {
        documents.set(String(filter._id), replacement)
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
      },
    }),
  }
  return db as unknown as ArenaDb
}

function reply(content: string) {
  return Response.json({ choices: [{ message: { content } }] })
}

function service(options: Partial<ArenaServiceOptions>) {
  const db = memoryDb()
  return createArenaService({
    resolveCaller: async () => ({ id: "user-1" }),
    db: async () => db,
    pool: [],
    openRouterApiKey: "server-secret",
    ...options,
  })
}

describe("Arena metadata route", () => {
  test("builds the prompt and calls the fixed utility model with a reply cap", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const response = await service({
      fetch: async (_url, init) => {
        upstreamBody = JSON.parse(String(init?.body))
        return reply("Fix the login redirect")
      },
    }).route(
      request({
        kind: "commit_message",
        changes: "M\tsrc/login.ts\t(+2 -1)",
        instructions: "Use Conventional Commits",
      }),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ message: "Fix the login redirect" })
    expect(upstreamBody?.model).toBe(comparisonModel.id)
    expect(upstreamBody?.provider).toEqual(comparisonModel.routing)
    expect(upstreamBody?.max_tokens).toBe(1_024)
    const messages = upstreamBody?.messages as { role: string; content: string }[]
    expect(messages).toHaveLength(1)
    const content = messages[0]?.content
    expect(content).toStartWith("Write a git commit message for the changes below.")
    expect(content).toContain("Use Conventional Commits")
    expect(content).toEndWith("## Changes\nM\tsrc/login.ts\t(+2 -1)")
  })

  test("answers a pull request as a title and a body", async () => {
    const response = await service({
      fetch: async () =>
        reply("```markdown\n# Title: Fix the login redirect\n\nThe redirect now keeps the query.\n```"),
    }).metadata(request({ kind: "pull_request", changes: "diff" }))

    expect(await response.json()).toEqual({
      title: "Fix the login redirect",
      body: "The redirect now keeps the query.",
    })
  })

  test("suggests a branch name with the project's style", async () => {
    let content = ""
    const response = await service({
      fetch: async (_url, init) => {
        content = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0]?.content ?? ""
        return reply("feat/retry-backoff")
      },
    }).metadata(
      request({ kind: "branch_name", changes: "Chat: Add retries", instructions: "Prefix with feat/ or fix/" }),
    )

    expect(await response.json()).toEqual({ branch: "feat/retry-backoff" })
    expect(content).toStartWith("Suggest a git branch name for the work below.")
    expect(content).toContain("Prefix with feat/ or fix/")
  })

  test("refuses fields the route does not build into its prompt", async () => {
    let contacted = false
    const fetch = async () => {
      contacted = true
      return reply("x")
    }
    const refused = await Promise.all([
      service({ fetch }).metadata(request({ kind: "commit_message", changes: "diff", model: "openai/gpt-5" })),
      service({ fetch }).metadata(request({ kind: "commit_message", changes: "diff", messages: [] })),
      service({ fetch }).metadata(request({ kind: "poem", changes: "diff" })),
      service({ fetch }).metadata(request({ kind: "commit_message", changes: " " })),
    ])

    expect(refused.map((response) => response.status)).toEqual([400, 400, 400, 400])
    expect(contacted).toBe(false)
  })

  test("refuses changes over the cap before contacting OpenRouter", async () => {
    let contacted = false
    const response = await service({
      fetch: async () => {
        contacted = true
        return reply("x")
      },
    }).metadata(request({ kind: "commit_message", changes: "x".repeat(MAX_METADATA_CHANGES_CHARS + 1) }))

    expect(response.status).toBe(413)
    expect(contacted).toBe(false)
  })

  test("limits each account per window and opens the next window", async () => {
    let now = new Date("2026-10-15T10:00:00Z")
    const arena = service({
      metadataRateLimit: { max: 2, windowMs: 60_000 },
      now: () => now,
      fetch: async () => reply("Update docs"),
    })
    const send = () => arena.metadata(request({ kind: "commit_message", changes: "diff" }))

    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")

    now = new Date("2026-10-15T10:01:00Z")
    expect((await send()).status).toBe(200)
  })

  test("a null limit never reads the database", async () => {
    const response = await service({
      metadataRateLimit: null,
      db: async () => {
        throw new Error("no database")
      },
      fetch: async () => reply("Update docs"),
    }).metadata(request({ kind: "commit_message", changes: "diff" }))

    expect(response.status).toBe(200)
  })

  test("collapses an upstream failure and an empty reply to 502", async () => {
    const failed = await service({
      fetch: async () => Response.json({ error: { message: "provider detail" } }, { status: 402 }),
    }).metadata(request({ kind: "commit_message", changes: "diff" }))
    const empty = await service({ fetch: async () => reply("<think>hmm</think>\n\n") }).metadata(
      request({ kind: "commit_message", changes: "diff" }),
    )

    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: "Arena metadata failed" })
    expect(empty.status).toBe(502)
  })

  test("answers 503 without a key", async () => {
    const response = await service({ openRouterApiKey: undefined }).metadata(
      request({ kind: "commit_message", changes: "diff" }),
    )

    expect(response.status).toBe(503)
  })
})

describe("parseMetadataReply", () => {
  test("keeps one line of a commit message within 72 characters", () => {
    expect(parseMetadataReply("commit_message", '"Commit message: Add retries"\nextra')).toEqual({
      message: "Add retries",
    })
    const long = parseMetadataReply("commit_message", `Refactor ${"the session store ".repeat(10)}`) as {
      message: string
    }
    expect(long.message.length).toBeLessThanOrEqual(72)
    expect(long.message).not.toEndWith(" ")
  })

  test("folds a branch name into the slug the desktop accepts", () => {
    expect(parseMetadataReply("branch_name", "Branch name: `Feat/Retry Backoff--PR #42`")).toEqual({
      branch: "feat/retry-backoff-pr-42",
    })
    expect(parseMetadataReply("branch_name", "/fix//login.redirect-/")).toEqual({ branch: "fix/login-redirect" })
    const long = parseMetadataReply("branch_name", `feat/${"retry-".repeat(30)}`) as { branch: string }
    expect(long.branch.length).toBeLessThanOrEqual(60)
    expect(long.branch).not.toEndWith("-")
    expect(parseMetadataReply("branch_name", "***")).toBeUndefined()
  })

  test("answers nothing for a blank reply", () => {
    expect(parseMetadataReply("pull_request", "\n \n")).toBeUndefined()
  })
})
