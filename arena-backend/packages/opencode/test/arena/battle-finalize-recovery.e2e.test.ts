import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function sseToolCall(id: string, callID: string, name: string, args: Record<string, unknown>) {
  const first = JSON.stringify({
    id,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: callID,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })
  const done = JSON.stringify({
    id,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })
  return new Response(`data: ${first}\n\ndata: ${done}\n\ndata: [DONE]\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function sseText(id: string, content: string) {
  const chunk = JSON.stringify({
    id,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
  })
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

describe("Arena real battle finalize recovery", () => {
  let originalFetch: typeof globalThis.fetch | undefined
  let home: string | undefined
  const previousArena = process.env.OPENCODE_ARENA
  const previousHome = process.env.PASEO_HOME
  const previousDb = process.env.OPENCODE_DB

  afterEach(async () => {
    if (originalFetch) globalThis.fetch = originalFetch
    originalFetch = undefined
    const [{ ArenaRuntime }, credentials] = await Promise.all([
      import("@/arena/runtime"),
      import("@/arena/credentials"),
    ])
    await ArenaRuntime.closeStore()
    credentials.setArenaCredentials(undefined)
    if (previousArena === undefined) delete process.env.OPENCODE_ARENA
    else process.env.OPENCODE_ARENA = previousArena
    if (previousHome === undefined) delete process.env.PASEO_HOME
    else process.env.PASEO_HOME = previousHome
    if (previousDb === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previousDb
    if (home) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  test("recovers in a real battle when a steered contestant rewrites history, prunes base objects, and rewrites its battle ref", async () => {
    const [{ Server }, { ArenaRuntime }, credentials] = await Promise.all([
      import("@/server/server"),
      import("@/arena/runtime"),
      import("@/arena/credentials"),
    ])
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-duel-battle-recovery-")))
    const directory = await realpath(await mkdtemp(path.join(home, "workspace-")))
    await $`git init -q -b main`.cwd(directory).quiet()
    await $`git config user.email test@example.com`.cwd(directory).quiet()
    await $`git config user.name test`.cwd(directory).quiet()
    await writeFile(path.join(directory, "README.md"), "arena\n")
    await writeFile(path.join(directory, "opencode.json"), "{}\n")
    await $`git add README.md opencode.json`.cwd(directory).quiet()
    await $`git commit -qm initial`.cwd(directory).quiet()
    const canonicalHead = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
    // Dirty working tree so snapshotBase creates a synthetic baseCommit separate from canonical HEAD.
    await writeFile(path.join(directory, "untracked.txt"), "dirty base\n")

    const toolOutputs: string[] = []
    const turnCountByAssignment = new Map<string, number>()
    let frozenBaseSHA = ""
    let reqCounter = 0

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.origin === "https://control.test") {
        const req = new Request(input, init)
        if (url.pathname === "/api/arena/assignments") {
          const body = (await req.json()) as { action: string; kind: string; decision?: string }
          if (body.action === "create") {
            return Response.json({
              assignments: [{ assignmentID: "assign-a" }, { assignmentID: "assign-b" }],
            })
          }
          return Response.json({
            decision: body.decision,
            assignments: [
              { assignmentID: "assign-a", model: "model-a" },
              { assignmentID: "assign-b", model: "model-b" },
            ],
          })
        }
        if (url.pathname === "/api/arena/comparison") {
          return Response.json({ provider: "test", choices: [{ message: { content: "comparison" } }] })
        }
        if (url.pathname.startsWith("/api/arena/research") || url.pathname.includes("research")) {
          const body = (await req.json().catch(() => ({}))) as { records?: readonly unknown[] }
          const count = body.records?.length ?? 0
          return Response.json({ received: count, stored: count })
        }
        if (url.pathname === "/api/openrouter/api/v1/chat/completions") {
          const body = (await req.json()) as {
            messages?: readonly { role?: string; content?: unknown }[]
          }
          const messages = body.messages ?? []
          const assignmentID =
            req.headers.get("x-arena-assignment-id") ??
            req.headers.get("x-assignment-id") ??
            req.headers.get("authorization") ??
            ""
          const serialized = JSON.stringify(messages)
          const last = messages.at(-1)
          const id = `r-${++reqCounter}`

          if (last?.role === "tool") {
            toolOutputs.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content))
            return sseText(id, `Tool completed (${assignmentID || "side"}).`)
          }

          // Detect side by worktree path in system prompt (`generation-1-a` vs `generation-1-b`).
          const isSideB = serialized.includes("generation-1-b")
          const isSteer = serialized.includes("REWRITE_AND_PRUNE")

          if (isSideB && isSteer) {
            // Simulate `git filter-repo` + `git gc --prune=now` inside side b's own worktree:
            // 1. Create orphan rewritten history on main
            // 2. Rewrite side b's private battle ref and delete its -index ref in the bare host
            // 3. Expire reflogs and prune all unreachable objects (deleting both baseSHA and frozenHead)
            const command = [
              "set -euo pipefail",
              "git checkout --orphan clean-history",
              "git rm -rf --cached . >/dev/null 2>&1 || true",
              "printf 'rewritten by side b\\n' > rewritten.txt",
              "git add -A",
              "git commit -qm 'rewritten history'",
              "NEW_HEAD=$(git rev-parse HEAD)",
              'git branch -f main "$NEW_HEAD"',
              "git switch -q main",
              "git branch -D clean-history >/dev/null",
              "for ref in $(git for-each-ref --format='%(refname)' 'refs/agent-duel/start/'); do git update-ref \"$ref\" \"$NEW_HEAD\"; done",
              "for ref in $(git for-each-ref --format='%(refname)' 'refs/battles/*/turn-0*/b'); do git update-ref \"$ref\" \"$NEW_HEAD\" && echo REF_REWRITTEN:$ref; done",
              "for ref in $(git for-each-ref --format='%(refname)' 'refs/battles/*/turn-0*/b-index'); do git update-ref -d \"$ref\" && echo INDEX_DELETED:$ref; done",
              "git reflog expire --expire=now --all",
              "git gc --prune=now -q",
              `git cat-file -e ${frozenBaseSHA} 2>/dev/null && echo BASE_PRESENT || echo BASE_PRUNED`,
              `git cat-file -e ${canonicalHead} 2>/dev/null && echo HEAD_PRESENT || echo HEAD_PRUNED`,
              "echo PRUNE_DONE:$NEW_HEAD",
            ].join("\n")
            return sseToolCall(id, `call-steer-${reqCounter}`, "shell", {
              command,
              description: "Rewrite history and prune unreachable git objects",
            })
          }

          const key = isSideB ? "b" : "a"
          const count = (turnCountByAssignment.get(key) ?? 0) + 1
          turnCountByAssignment.set(key, count)
          if (count === 1) {
            const file = isSideB ? "side-b-initial.txt" : "side-a.txt"
            return sseToolCall(id, `call-init-${reqCounter}`, "shell", {
              command: `printf '${key} initial\\n' > ${file} && git add ${file} && git commit -qm '${key} initial'`,
              description: `Create initial commit for side ${key}`,
            })
          }

          return sseText(id, `Completed side ${key}.`)
        }
      }
      return originalFetch!(input, init)
    }) as typeof globalThis.fetch

    const controlToken = "battle-recovery-token"
    credentials.setArenaCredentials({
      mode: "hosted",
      token: "test-token",
      controlPlaneUrl: "https://control.test",
      researchPartition: "test",
      researchAccountID: "acct-test",
      controlTokenHash: credentials.hashArenaControlToken(controlToken),
    })
    process.env.PASEO_HOME = home
    process.env.OPENCODE_ARENA = "1"
    delete process.env.OPENCODE_DB

    const app = Server.Default().app
    const request = (route: string, init?: RequestInit) =>
      app.request(route, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-paseo-control-token": controlToken,
          ...(init?.headers ?? {}),
        },
      })

    // 1. Create session and start battle turn 0
    const created = await request("/api/session", {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({
        location: { directory },
        model: { providerID: "arena", id: "medium" },
      }),
    })
    expect(created.status).toBe(200)
    const source = (await created.json()).data as { id: string }

    const attached = await request(`/arena/sessions/${source.id}`, {
      headers: { "x-opencode-directory": directory },
    })
    expect(attached.status).toBe(200)
    const attachedBody = (await attached.json()) as { chat: { id: string } }

    const started = await request(`/arena/chats/${attachedBody.chat.id}/turns`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ prompt: "Make an initial change.", autoAccept: true }),
    })
    expect(started.status).toBe(200)
    await started.text()

    type SnapshotBody = {
      chat: { id: string; canonicalSessionID: string; activeTurnID?: string }
      runs?: readonly {
        id: string
        side: "a" | "b"
        sessionID: string
        runState: string
        selectable?: boolean
        error?: string
        finalCommit?: string
        worktree?: string
      }[]
      turn?: {
        id: string
        state: string
        gitApplication?: {
          state?: string
          review?: {
            items?: readonly {
              key: string
              fingerprint: string
              proposal: string
            }[]
          }
        }
      }
    }

    const snapshot = async () => {
      const res = await request(`/arena/sessions/${source.id}`, {
        headers: { "x-opencode-directory": directory },
      })
      return (await res.json()) as SnapshotBody
    }

    const waitFor = async (predicate: (s: SnapshotBody) => boolean, label: string, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs
      let current = await snapshot()
      while (Date.now() < deadline && !predicate(current)) {
        await Bun.sleep(100)
        current = await snapshot()
      }
      if (!predicate(current)) {
        throw new Error(
          `Timed out waiting for ${label}; last state=${JSON.stringify(current.turn)} runs=${JSON.stringify(current.runs?.map((r) => ({ side: r.side, state: r.runState, error: r.error })))}`,
        )
      }
      return current
    }

    // Wait for first finalize of both sides
    let current = await waitFor((s) => s.turn?.state === "awaiting_vote", "initial awaiting_vote")
    const turnID = current.turn!.id
    const initialRunB = current.runs?.find((r) => r.side === "b")
    expect(initialRunB?.runState).toBe("complete")
    expect(initialRunB?.finalCommit).toBeTruthy()
    const firstCommitB = initialRunB!.finalCommit!
    frozenBaseSHA = (
      await $`git for-each-ref --format='%(objectname)' 'refs/battles/*/turn-0*/base'`.cwd(directory).quiet().text()
    ).trim()
    expect(frozenBaseSHA).toMatch(/^[0-9a-f]{40}$/)
    expect(frozenBaseSHA).not.toBe(canonicalHead)

    // 2. Steer side b to rewrite history, rewrite its battle ref, and run `git gc --prune=now`
    const steered = await request(`/arena/turns/${turnID}/reply`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ target: "b", prompt: "REWRITE_AND_PRUNE" }),
    })
    expect(steered.status).toBe(200)
    await steered.text()

    // Wait for side b to finish running and finalize again cleanly (no error!)
    current = await waitFor(
      (s) =>
        s.turn?.state === "awaiting_vote" &&
        s.runs?.find((r) => r.side === "b")?.finalCommit !== undefined &&
        s.runs?.find((r) => r.side === "b")?.finalCommit !== firstCommitB,
      "steered side b re-finalization",
    )

    // Confirm the contestant really pruned both base objects and rewrote/deleted its host battle refs
    const combinedOutput = toolOutputs.join("\n")
    expect(combinedOutput).toContain("REF_REWRITTEN:")
    expect(combinedOutput).toContain("INDEX_DELETED:")
    expect(combinedOutput).toContain("BASE_PRUNED")
    expect(combinedOutput).toContain("HEAD_PRUNED")
    expect(combinedOutput).toContain("PRUNE_DONE:")

    const updatedRunB = current.runs?.find((r) => r.side === "b")
    expect(updatedRunB?.runState).toBe("complete")
    expect(updatedRunB?.selectable).toBe(true)
    expect(updatedRunB?.error).toBeUndefined()

    // Verify diff endpoint for turn still works against the frozen dirty base!
    const diffRes = await request(`/arena/turns/${turnID}/diff`, {
      headers: { "x-opencode-directory": directory },
    })
    expect(diffRes.status).toBe(200)
    const diffBody = await diffRes.text()
    expect(diffBody).toContain("rewritten.txt")

    // 3. Vote for side b and confirm resolution completes (answering review if history rewrite prompts review)
    const voted = await request(`/arena/turns/${turnID}/vote`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
      body: JSON.stringify({ vote: "b" }),
    })
    expect(voted.status).toBe(200)
    await voted.text()

    current = await waitFor(
      (s) => !s.chat.activeTurnID || s.turn?.gitApplication?.state === "review",
      "vote resolution or review",
    )

    if (current.turn?.gitApplication?.review?.items?.length) {
      const answers = current.turn.gitApplication.review.items.map((item) => ({
        key: item.key,
        choice: item.proposal === "ask_agent" ? "agent" : item.proposal,
        fingerprint: item.fingerprint,
      }))
      const resolved = await request(`/arena/turns/${turnID}/retry-resolution`, {
        method: "POST",
        headers: { "x-opencode-directory": directory },
        body: JSON.stringify({ answers }),
      })
      expect(resolved.status).toBe(200)
      await resolved.text()
      current = await waitFor((s) => !s.chat.activeTurnID, "post-review promotion")
    }

    expect(current.chat.activeTurnID).toBeUndefined()
    expect(await readFile(path.join(directory, "rewritten.txt"), "utf8")).toBe("rewritten by side b\n")
    const finalLog = (await $`git log -1 --format=%s`.cwd(directory).quiet().text()).trim()
    expect(finalLog).toBe("rewritten history")
  }, 60_000)
})
