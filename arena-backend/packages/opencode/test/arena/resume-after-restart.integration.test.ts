import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
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

// The time one request of the run took, from the start and end the run record holds for it.
function requestMs(run: RunDocument) {
  if (!run.startedAt || !run.completedAt) throw new Error(`Arena run ${run._id} has no settled request`)
  return run.completedAt.getTime() - run.startedAt.getTime()
}

// The metrics row is written in the background after the vote.
async function waitForBattleMetrics(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const row = await store.battleMetrics.findOne({ _id: turnID })
    if (row) return row
    await Bun.sleep(10)
  }
  throw new Error("Arena battle metrics were not recorded")
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
      const firstRuns = await store.runsForTurn(turnID)
      const before = await recorded(store, firstRuns)
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
        // The run's time is both requests, not only the follow-up's.
        const first = firstRuns.find((candidate) => candidate._id === run._id)!
        expect(run.priorDurationMs).toBe(requestMs(first))
        expect(run.durationMs).toBe(requestMs(first) + requestMs(run))
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
      const metrics = await waitForBattleMetrics(store, turnID)
      for (const run of continued) expect(metrics.sides[run.side]?.durationMs).toBe(run.durationMs!)
    } finally {
      router.restore()
      await store.close()
    }
  }, 60_000)

  test("a battle ref a crash left empty is removed at startup, so the next battle still reaches the vote", async () => {
    await using directory = await fixture()
    await using arenaDirectory = await tmpdir()
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const first = await startBattle(headers, "Battle before a crash", "Create two results.")
      await waitForTurn(store, first, "awaiting_vote")
      await waitForSettledComparison(store, first)
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${first}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(store, first, "complete")
      const chatID = (await store.turn(first))?.chatID
      if (!chatID) throw new Error("The first battle has no chat")

      // Another chat's freeze was the last write before the machine went down: its base ref file
      // came back empty, and git now fails every fetch into the checkout on it.
      const crashed = `${directory.path}/.git/refs/battles/crashed/turn-0`
      await fs.mkdir(crashed, { recursive: true })
      await fs.writeFile(`${crashed}/base`, "")
      store = await restartEngine(store, arenaDirectory.path)

      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${chatID}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Create two more results." }),
        }),
      )
      const second = admitted.turn?.id
      if (!second) throw new Error("Arena did not admit the battle after the restart")
      await waitForTurn(store, second, "awaiting_vote")
      expect((await store.runsForTurn(second)).map((run) => [run.side, run.runState, run.selectable])).toEqual([
        ["a", "complete", true],
        ["b", "complete", true],
      ])
      expect(await fs.readdir(crashed)).toEqual([])
      const fetched = await $`git fetch --quiet --no-tags --no-write-fetch-head . HEAD:refs/probe`
        .cwd(directory.path)
        .quiet()
        .nothrow()
      expect({ exitCode: fetched.exitCode, stderr: fetched.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" })
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
      // The failed attempt counts toward the run's time, as the retry that follows it does.
      const recovered = continued.find((run) => run._id === failed._id)!
      expect(recovered.priorDurationMs).toBe(requestMs(failed))
      expect(recovered.durationMs).toBe(requestMs(failed) + requestMs(recovered))
    } finally {
      router.restore()
      await store.close()
    }
  }, 60_000)
})
