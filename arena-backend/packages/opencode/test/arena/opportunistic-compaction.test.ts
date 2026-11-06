import { describe, expect, test } from "bun:test"
import { createCompactions, shouldCompact, shouldUseCompactionForSteer } from "../../src/arena/opportunistic-compaction"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("opportunistic compaction coordinator", () => {
  test("only the winning completion becomes ready", async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const coordinator = createCompactions<string>()
    const old = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: 1,
      generate: () => first.promise,
    })
    coordinator.start({ runID: "run", sessionID: "session", sourceVersion: 2, generate: () => second.promise })
    first.resolve("old")
    await settle()
    expect(old.status).toBe("discarded")
    second.resolve("new")
    await settle()
    expect(coordinator.select("session", 2)).toBe("new")
    expect(coordinator.metrics()).toMatchObject({ used: 1, discarded: 1 })
  })

  test("late values after cancellation are discarded once", async () => {
    const generated = deferred<string>()
    let canceled = 0
    const coordinator = createCompactions<string>()
    const entry = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: "v1",
      generate: () => generated.promise,
      cancel: () => {
        canceled += 1
      },
    })
    expect(coordinator.invalidate("session", "v1")).toBe(true)
    expect(entry.status).toBe("canceled")
    generated.resolve("too late")
    await settle()
    expect(entry.status).toBe("discarded")
    expect(coordinator.metrics()).toMatchObject({ canceled: 1, discarded: 1 })
    expect(canceled).toBe(1)
    generated.resolve("still too late")
    await settle()
    expect(coordinator.metrics().discarded).toBe(1)
  })

  test("cancellation failure is observed without waiting", async () => {
    const generated = deferred<string>()
    const snapshots: Array<{ status: string; cancellationFailed: boolean; perceivedWaitMs: number }> = []
    const coordinator = createCompactions<string>((snapshot) => snapshots.push(snapshot))
    const entry = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: 1,
      generate: () => generated.promise,
      cancel: async () => {
        throw new Error("provider did not cancel")
      },
    })
    entry.cancel()
    await settle()
    expect(entry.status).toBe("canceled")
    expect(entry.cancellationFailed).toBe(true)
    expect(snapshots.at(-1)).toMatchObject({ cancellationFailed: true, perceivedWaitMs: 0 })
  })

  test("a cancellation that never resolves does not block selection", () => {
    const generated = deferred<string>()
    const cancel = deferred<void>()
    const coordinator = createCompactions<string>()
    const entry = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: 1,
      generate: () => generated.promise,
      cancel: () => cancel.promise,
    })
    expect(coordinator.invalidate("session")).toBe(true)
    expect(entry.status).toBe("canceled")
    expect(coordinator.select("session", 1)).toBeNull()
    expect(coordinator.metrics().canceled).toBe(1)
  })

  test("a canceled generation rejection finalizes the canceled snapshot", async () => {
    const generated = deferred<string>()
    const snapshots: Array<{ status: string; finishedAt?: number }> = []
    const coordinator = createCompactions<string>((snapshot) => snapshots.push(snapshot))
    coordinator.start({ runID: "run", sessionID: "session", sourceVersion: 1, generate: () => generated.promise })
    coordinator.invalidate("session")
    generated.reject(new Error("aborted"))
    await settle()
    expect(snapshots.at(-1)?.status).toBe("canceled")
    expect(snapshots.at(-1)?.finishedAt).toBeNumber()
    expect(coordinator.metrics()).toMatchObject({ canceled: 1, failed: 0, discarded: 0 })
  })

  test("publication gate false discards a stale result without failing", async () => {
    const generated = deferred<string>()
    const coordinator = createCompactions<string>()
    const entry = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: 1,
      generate: () => generated.promise,
      publish: () => false,
    })
    generated.resolve("stale")
    await settle()
    expect(entry.status).toBe("discarded")
    expect(coordinator.metrics()).toMatchObject({ failed: 0, discarded: 1 })
  })

  test("publication gate guards an asynchronous transaction race", async () => {
    const generated = deferred<string>()
    const publication = deferred<boolean>()
    let guarded!: () => boolean
    const coordinator = createCompactions<string>()
    const entry = coordinator.start({
      runID: "run",
      sessionID: "session",
      sourceVersion: 1,
      generate: () => generated.promise,
      publish: (_candidate, publish) => {
        guarded = publish
        return publication.promise
      },
    })
    generated.resolve("candidate")
    await settle()
    expect(entry.status).toBe("pending")
    coordinator.invalidate("session")
    expect(guarded()).toBe(false)
    publication.resolve(false)
    await settle()
    expect(entry.status).toBe("discarded")
    expect(coordinator.metrics()).toMatchObject({ canceled: 1, discarded: 1, failed: 0 })
  })

  test("dispose invalidates active and reserved entries", async () => {
    const one = deferred<string>()
    const two = deferred<string>()
    const coordinator = createCompactions<string>()
    coordinator.start({ runID: "run", sessionID: "one", sourceVersion: 1, generate: () => one.promise })
    coordinator.start({ runID: "run", sessionID: "two", sourceVersion: 1, generate: () => two.promise })
    one.resolve("ready")
    await settle()
    const reserved = coordinator.select("one")
    expect(reserved).not.toBeNull()
    expect(coordinator.invalidateAll()).toBe(2)
    expect(coordinator.select("one")).toBeNull()
    expect(coordinator.select("two")).toBeNull()
  })

  test("sync and async generation failures are distinct from cancellation", async () => {
    const coordinator = createCompactions<string>()
    const sync = coordinator.start({
      runID: "run",
      sessionID: "sync",
      sourceVersion: 1,
      generate: () => {
        throw new Error("sync")
      },
    })
    const failed = coordinator.start({
      runID: "run",
      sessionID: "failed",
      sourceVersion: 1,
      generate: () => Promise.reject(new Error("async")),
    })
    await settle()
    expect(sync.status).toBe("failed")
    expect(failed.status).toBe("failed")
    expect(coordinator.metrics().failed).toBe(2)
  })

  test("contestants cannot consume each other's candidate", async () => {
    const left = deferred<string>()
    const right = deferred<string>()
    const coordinator = createCompactions<string>()
    coordinator.start({ runID: "left", sessionID: "left", sourceVersion: 1, generate: () => left.promise })
    coordinator.start({ runID: "right", sessionID: "right", sourceVersion: 1, generate: () => right.promise })
    left.resolve("left candidate")
    right.resolve("right candidate")
    await settle()
    expect(coordinator.select("right", 1)).toBe("right candidate")
    expect(coordinator.select("left", 1)).toBe("left candidate")
    expect(coordinator.select("right", 1)).toBeNull()
  })

  test("transfer preserves a pending candidate and changes its expected target version", async () => {
    const generated = deferred<string>()
    const coordinator = createCompactions<string>()
    const entry = coordinator.start({
      runID: "run",
      sessionID: "branch",
      sourceVersion: "source",
      generate: () => generated.promise,
    })
    const moved = coordinator.transfer("branch", "canonical", {
      sourceVersion: "source",
      targetVersion: "target",
      mapCandidate: (value) => `${value}!`,
    })
    expect(moved?.sessionID).toBe("canonical")
    generated.resolve("summary")
    await settle()
    expect(coordinator.select("branch", "source")).toBeNull()
    expect(coordinator.select("canonical", "target")).toBe("summary!")
    expect(entry.sourceVersion).toBe("source")
  })

  test("take reserves for a storage check, then commits or discards", async () => {
    const coordinator = createCompactions<string>()
    const generated = deferred<string>()
    coordinator.start({ runID: "run", sessionID: "session", sourceVersion: 1, generate: () => generated.promise })
    generated.resolve("candidate")
    await settle()
    const selection = coordinator.select("session")
    expect(selection?.candidate).toBe("candidate")
    expect(coordinator.metrics().used).toBe(0)
    expect(coordinator.commitUsed(selection!)).toBe(true)
    expect(coordinator.metrics().used).toBe(1)
  })

  test("steering uses a summary only at two-thirds of the runtime context threshold", () => {
    expect(shouldUseCompactionForSteer(181_333)).toBe(false)
    expect(shouldUseCompactionForSteer((272_000 * 2) / 3)).toBe(true)
    expect(shouldUseCompactionForSteer(181_334)).toBe(true)
    expect(shouldUseCompactionForSteer(272_000)).toBe(true)
    expect(shouldUseCompactionForSteer(undefined)).toBe(false)
    expect(shouldUseCompactionForSteer(NaN)).toBe(false)
    expect(shouldUseCompactionForSteer(Infinity)).toBe(false)
  })

  test("compaction thresholds handle unknown usage and context pressure", () => {
    expect(shouldCompact({ reasoningTokens: null, generatedTokens: 10, contextTokens: 1 })).toBe(true)
    expect(shouldCompact({ reasoningTokens: 10, generatedTokens: null, contextTokens: 1 })).toBe(true)
    expect(shouldCompact({ reasoningTokens: 500, generatedTokens: 10_000, contextTokens: 1 })).toBe(false)
    expect(shouldCompact({ reasoningTokens: 1_000, generatedTokens: 2_000, contextTokens: 1 })).toBe(false)
    expect(shouldCompact({ reasoningTokens: 1_001, generatedTokens: 2_000, contextTokens: 1 })).toBe(true)
    expect(shouldCompact({ reasoningTokens: 1, generatedTokens: 2, contextTokens: 272_000 })).toBe(true)
  })
})
