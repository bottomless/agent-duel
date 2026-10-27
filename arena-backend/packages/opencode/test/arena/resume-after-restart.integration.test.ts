import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { connectLocalStore } from "@/arena/local-store"
import type { Store } from "@/arena/mongo"
import type { RunDocument } from "@/arena/records"
import { registry, setStoreForTest } from "@/arena/runtime"
import * as GitState from "@/worktree/git-state"
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

// A comparison never blocks a reply or a vote. Wait for it to settle so it cannot finish under the
// restart.
async function waitForSettledComparison(store: Store, turnID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const turn = await store.turn(turnID)
    const state = turn?.comparisonState
    if (state === "complete" || state === "failed") return
    // Skipped while the title request is out; settled once its record is written.
    if (state === "skipped" && turn?.comparisonID && (await store.comparisons.findOne({ turnID }))) return
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

  test("a battle the restart cut off reopens to the vote and resumes both sides together", async () => {
    await using directory = await fixture()
    await using arenaDirectory = await tmpdir()
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    // Both models' first step runs a command that outlives the engine.
    const router = installOpenRouterStub({ contestantCommands: { 1: "sleep 30", 2: "sleep 30" } })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const turnID = await startBattle(headers, "Interrupted Arena battle", "Create a result.")
      const deadline = Date.now() + 20_000
      let runs = await store.runsForTurn(turnID)
      while (
        Date.now() < deadline &&
        !(runs.length === 2 && runs.every((run) => !run.finalizedAt && run.environmentReadyAt && run.firstToolAt))
      ) {
        await Bun.sleep(20)
        runs = await store.runsForTurn(turnID)
      }
      if (!runs.every((run) => run.firstToolAt)) throw new Error("The contestants did not reach their commands")
      expect((await store.turn(turnID))?.state).toBe("running")
      const models = runs.map((run) => router.modelForAssignment(run.assignment.assignmentID))
      if (models.some((model) => !model)) throw new Error("A run did not retain an opaque assignment")
      expect(models.map((model) => router.calls.get(model!))).toEqual([1, 1])

      store = await restartEngine(store, arenaDirectory.path)

      const reopened = await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${encodeURIComponent(turnID)}`, { headers }),
      )
      expect(reopened.turn?.state).toBe("awaiting_vote")
      expect(reopened.turn?.canResumeBattle).toBe(true)
      expect(reopened.runs.map((run) => [run.side, run.runState, run.selectable, run.canRetry, run.error])).toEqual([
        ["a", "interrupted", false, false, "Interrupted when Agent Duel closed"],
        ["b", "interrupted", false, false, "Interrupted when Agent Duel closed"],
      ])
      // Nothing the restart cut off is left running in the panes.
      const toolStates = reopened.runs.flatMap((run) =>
        Object.values(run.parts ?? {})
          .flat()
          .flatMap((part) => (part.type === "tool" ? [(part.state as { status: string }).status] : [])),
      )
      expect(toolStates.filter((status) => status === "pending" || status === "running")).toEqual([])
      expect(reopened.turn?.canDiscardBattle).toBe(true)
      // Interrupted sides have nothing to compare yet, so no report is paid for.
      await waitForSettledComparison(store, turnID)
      expect((await store.turn(turnID))?.comparisonState).toBe("skipped")
      expect(router.reportCalls()).toBe(0)
      // The battle is resumed or discarded, never voted on as it stands.
      const voted = await arenaRequest(`/arena/turns/${encodeURIComponent(turnID)}/vote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ vote: "a" }),
      })
      expect(voted.ok).toBe(false)
      // A side cannot be resumed alone.
      const single = await arenaRequest(`/arena/runs/${encodeURIComponent(runs[0]!._id)}/retry`, {
        method: "POST",
        headers,
      })
      expect(single.ok).toBe(false)

      const resumed = await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${encodeURIComponent(turnID)}/resume`, { method: "POST", headers }),
      )
      expect(resumed.turn?.state).toBe("running")
      expect(resumed.runs.map((run) => run.runState)).toEqual(["pending", "pending"])
      await waitForTurn(store, turnID, "awaiting_vote")

      const continued = await store.runsForTurn(turnID)
      expect(continued.map((run) => [run.side, run.runState, run.selectable, run.manualRetries])).toEqual([
        ["a", "complete", true, undefined],
        ["b", "complete", true, undefined],
      ])
      // Each side continued its session on its own assignment.
      expect(models.map((model) => router.calls.get(model!))).toEqual([2, 2])
      // Both sides finished after the resume, so the turn is compared again; their trees are
      // identical, so that needs no report.
      await waitForSettledComparison(store, turnID)
      expect((await store.turn(turnID))?.comparisonState).toBe("complete")
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
      await waitForTurn(store, turnID, "awaiting_vote")
      await waitForSettledComparison(store, turnID)
      // The finished side has nothing to be compared against yet, so no report is paid for.
      expect((await store.turn(turnID))?.comparisonState).toBe("skipped")
      expect(router.reportCalls()).toBe(0)
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
      // Both sides finished after the retry, so the turn now gets its report.
      await waitForSettledComparison(store, turnID)
      expect((await store.turn(turnID))?.comparisonState).toBe("complete")
      expect(router.reportCalls()).toBe(1)
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
  test("a battle the restart cut off while it failed to start ends without naming either side", async () => {
    await using directory = await fixture()
    await using arenaDirectory = await tmpdir()
    let store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)
    const held = spyOn(GitState, "copyGitState").mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }),
    )
    // The engine stops before it can record the abort, as if it was quit during it.
    const cutOff = spyOn(store, "recordAbort").mockRejectedValueOnce(new Error("Arena engine stopped"))

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const turnID = await startBattle(headers, "Battle cut off while failing", "This battle cannot start.")
      const deadline = Date.now() + 20_000
      while (cutOff.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect((await store.turn(turnID))?.state).toBe("creation_failed")

      store = await restartEngine(store, arenaDirectory.path)

      const reopened = await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${encodeURIComponent(turnID)}`, { headers }),
      )
      expect(reopened.chat.status).toBe("ready")
      expect(reopened.turn?.state).toBe("discarded")
      expect(reopened.turn?.revealed).toBe(false)
      expect(reopened.turn?.identities).toBeUndefined()
      const ended = await store.turn(turnID)
      expect(ended?.resolution).toEqual({
        kind: "aborted",
        reason: "Arena battle failed before resolution",
        revealed: false,
      })
      expect(ended?.placement.a.model).toBeUndefined()
      expect(ended?.placement.b.model).toBeUndefined()
      expect((await store.runsForTurn(turnID)).map((run) => run.runState)).toEqual(["error", "error"])
    } finally {
      cutOff.mockRestore()
      held.mockRestore()
      router.restore()
      await store.close()
    }
  }, 60_000)
})
