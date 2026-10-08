import { $ } from "bun"
import { afterEach, expect, test } from "bun:test"
import { setArenaCredentials } from "@/arena/credentials"
import { connectLocalStore } from "@/arena/local-store"
import { registry, setStoreForTest } from "@/arena/runtime"
import type { Snapshot } from "@/arena/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { arenaRequest, installOpenRouterStub, json, waitForTurn } from "./harness"

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setArenaCredentials(undefined)
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

test("keeps a failed recovery retryable and completes after its safety ref is repaired", async () => {
  await using directory = await tmpdir({
    git: true,
    config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
  })
  await $`git add opencode.json && git commit -m "test: configure recovery fixture"`.cwd(directory.path).quiet()
  await using data = await tmpdir()
  const store = await connectLocalStore({ directory: data.path })
  const router = installOpenRouterStub()
  process.env.OPENCODE_ARENA = "1"
  setStoreForTest(store)
  const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }

  try {
    const source = await json<{ id: string }>(
      await arenaRequest("/session", { method: "POST", headers, body: JSON.stringify({ title: "Failed recovery" }) }),
    )
    const attached = await json<Snapshot>(await arenaRequest(`/arena/sessions/${source.id}`, { headers }))
    const admitted = await json<Snapshot>(
      await arenaRequest(`/arena/chats/${attached.chat.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Create a retained result." }),
      }),
    )
    const turnID = admitted.turn?.id
    if (!turnID) throw new Error("Arena did not admit the recovery test turn")
    await waitForTurn(store, turnID, "awaiting_vote")
    const winner = (await store.runsForTurn(turnID)).find((run) => run.side === "a")
    if (!winner?.finalCommit || !winner.permanentRef) throw new Error("Arena did not retain the winner")
    const winnerContent = await Bun.file(`${winner.worktree}/arena-result.txt`).text()
    const head = (await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()
    const safetyRef = winner.permanentRef.replace(/\/a$/, "/public-safety")
    const saved = (
      await $`git commit-tree HEAD^{tree} -p HEAD -m "Saved public state"`.cwd(directory.path).quiet().text()
    ).trim()
    await $`git update-ref ${safetyRef} ${saved}`.cwd(directory.path).quiet()
    await store.recordResolution({
      turnID,
      resolution: { kind: "vote", vote: "a", appliedSide: "a" },
      vote: "a",
      appliedSide: "a",
      models: { a: "Test Model A", b: "Test Model B" },
      expectedState: "awaiting_vote",
      at: new Date(),
    })
    await store.updateTurn(turnID, {
      gitApplication: { state: "failed", reason: "Interrupted apply", resultCommit: winner.finalCommit },
    })
    await store.transitionTurn(turnID, "application_failed")

    const failed = await arenaRequest(`/arena/turns/${turnID}/retry-resolution`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    expect(failed.ok).toBe(false)
    const retryable = await json<Snapshot>(await arenaRequest(`/arena/chats/${attached.chat.id}`, { headers }))
    expect(retryable.turn?.state).toBe("application_failed")
    expect(retryable.turn?.canRetryResolution).toBe(true)
    expect(retryable.turn?.gitApplication?.state).toBe("failed")
    expect(retryable.turn?.gitApplication?.reason).toContain(`${safetyRef}-index`)
    expect((await store.turn(turnID))?.resolution).toEqual({ kind: "vote", vote: "a", appliedSide: "a" })
    expect((await $`git rev-parse HEAD`.cwd(directory.path).quiet().text()).trim()).toBe(head)

    await $`git update-ref ${`${safetyRef}-index`} ${head}`.cwd(directory.path).quiet()
    await json<Snapshot>(
      await arenaRequest(`/arena/turns/${turnID}/retry-resolution`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    )
    await waitForTurn(store, turnID, "complete")
    const completed = await json<Snapshot>(await arenaRequest(`/arena/chats/${attached.chat.id}`, { headers }))
    expect(completed.chat.status).toBe("ready")
    expect(await Bun.file(`${directory.path}/arena-result.txt`).text()).toBe(winnerContent)
  } finally {
    router.restore()
    await store.close()
  }
}, 30_000)
