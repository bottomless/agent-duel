import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { RunDocument } from "@/arena/records"
import { registry, setStoreForTest } from "@/arena/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { arenaRequest, installOpenRouterStub, json, type PublicSnapshot, waitForTurn } from "./harness"

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

// The shared stub does not answer the comparison route, so the comparison fails; a failed one never
// blocks a reply or a vote. Wait for it to settle so it cannot finish under the restart.
async function waitForSettledComparison(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = (await store.turn(turnID))?.comparisonState
    if (state === "complete" || state === "failed" || state === "skipped") return
    await Bun.sleep(10)
  }
  throw new Error("Arena comparison did not settle")
}

async function waitForFinalizedRuns(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const runs = await store.runsForTurn(turnID)
    if (runs.length === 2 && runs.every((run) => run.finalizedAt)) return runs
    await Bun.sleep(10)
  }
  throw new Error("Arena contestants did not settle")
}

async function callIndexes(store: Store, runID: string) {
  return (await store.generationsForRuns([runID])).map((generation) => generation.callIndex).toSorted((a, b) => a - b)
}

async function rawEventCount(store: Store, runID: string) {
  return (await store.rawEvents.find({ runID }).toArray()).length
}

async function recorded(store: Store, runs: readonly RunDocument[]) {
  return new Map(
    await Promise.all(
      runs.map(
        async (run) =>
          [
            run._id,
            { callIndexes: await callIndexes(store, run._id), rawEvents: await rawEventCount(store, run._id) },
          ] as const,
      ),
    ),
  )
}

// What an engine restart leaves: a new store connection, so a new recorder and telemetry, no proxy
// assignments, and no loaded instances.
async function restartEngine(store: Store, arenaDirectory: string) {
  await store.close()
  registry.assignments.clear()
  await disposeAllInstances()
  const restarted = await connectLocalStore({ directory: arenaDirectory })
  setStoreForTest(restarted)
  return restarted
}

async function fixture() {
  const directory = await tmpdir({
    git: true,
    config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
  })
  await $`git add opencode.json`.cwd(directory.path).quiet()
  await $`git commit -m "test: configure restarted resume fixture"`.cwd(directory.path).quiet()
  return directory
}

async function startBattle(headers: Record<string, string>, title: string, prompt: string) {
  const source = await json<{ id: string }>(
    await arenaRequest("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title, permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
    }),
  )
  const attached = await json<PublicSnapshot>(await arenaRequest(`/arena/sessions/${source.id}`, { headers }))
  const admitted = await json<PublicSnapshot>(
    await arenaRequest(`/arena/chats/${attached.chat.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt }),
    }),
  )
  const turnID = admitted.turn?.id
  if (!turnID) throw new Error("Arena did not return an admitted turn")
  return turnID
}

describe("Arena after an engine restart", () => {
  test("a reply resumes both finished contestants, keeps their telemetry, and still takes the vote", async () => {
    await using directory = await fixture()
    await using arenaDirectory = await tmpdir()
    // The SQLite store, because its unique (runID, callIndex) index is what a restarted
    // telemetry counter used to collide with.
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const turnID = await startBattle(headers, "Restarted Arena reply", "Create two results, then wait for feedback.")
      await waitForTurn(store, turnID, "awaiting_vote")
      await waitForSettledComparison(store, turnID)
      const before = await recorded(store, await store.runsForTurn(turnID))
      const requestBoundary = router.contestantRequests.length

      store = await restartEngine(store, arenaDirectory.path)

      const resumed = await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Apply this follow-up after the restart.", target: "both" }),
        }),
      )
      expect(resumed.turn?.state).toBe("running")
      await waitForTurn(store, turnID, "awaiting_vote")

      const continued = await store.runsForTurn(turnID)
      expect(continued.map((run) => [run.side, run.runState, run.selectable, run.error])).toEqual([
        ["a", "complete", true, undefined],
        ["b", "complete", true, undefined],
      ])
      expect(router.contestantRequests.slice(requestBoundary)).toHaveLength(2)
      for (const run of continued) {
        const previous = before.get(run._id)!
        // The resumed request continues the run's numbering instead of starting again at 0.
        expect(previous.callIndexes.length).toBeGreaterThan(0)
        expect(await callIndexes(store, run._id)).toEqual([...previous.callIndexes, previous.callIndexes.length])
        // The recorder took the resumed session's events.
        expect(await rawEventCount(store, run._id)).toBeGreaterThan(previous.rawEvents)
      }

      await waitForSettledComparison(store, turnID)
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(store, turnID, "complete")
    } finally {
      router.restore()
      await store.close()
    }
  }, 60_000)

  test("a retry runs a failed contestant again on its assignment and keeps its telemetry", async () => {
    await using directory = await fixture()
    await using arenaDirectory = await tmpdir()
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub({ failFirstOrdinals: [1] })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const turnID = await startBattle(headers, "Restarted Arena retry", "Fail once on one side.")
      const settled = await waitForFinalizedRuns(store, turnID)
      const failed = settled.find((run) => run.runState === "error")
      if (!failed) throw new Error("No contestant failed")
      expect(failed.errorRetryable).toBe(true)
      const failedModel = router.modelForAssignment(failed.assignment.assignmentID)
      if (!failedModel) throw new Error("Failed run did not retain an opaque assignment")
      expect(router.calls.get(failedModel)).toBe(1)
      const settledTurn = await store.turn(turnID)
      if (settledTurn?.state === "awaiting_vote") await waitForSettledComparison(store, turnID)
      const before = await recorded(store, [failed])

      store = await restartEngine(store, arenaDirectory.path)

      const retried = await json<PublicSnapshot>(
        await arenaRequest(`/arena/runs/${encodeURIComponent(failed._id)}/retry`, { method: "POST", headers }),
      )
      expect(retried.turn?.state).toBe("running")
      await waitForTurn(store, turnID, "awaiting_vote")

      const continued = await store.runsForTurn(turnID)
      expect(continued.map((run) => [run.side, run.runState, run.selectable, run.error])).toEqual([
        ["a", "complete", true, undefined],
        ["b", "complete", true, undefined],
      ])
      expect(router.calls.get(failedModel)).toBe(2)
      const previous = before.get(failed._id)!
      expect(previous.callIndexes.length).toBeGreaterThan(0)
      expect(await callIndexes(store, failed._id)).toEqual([...previous.callIndexes, previous.callIndexes.length])
      expect(await rawEventCount(store, failed._id)).toBeGreaterThan(previous.rawEvents)
    } finally {
      router.restore()
      await store.close()
    }
  }, 60_000)
})
