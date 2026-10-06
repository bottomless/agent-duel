import { describe, expect, test } from "bun:test"
import type { Side } from "../../src/arena/domain"
import {
  createWarmPool,
  type WarmPairState,
  type WarmPoolAdapter,
  type WarmPoolStore,
  type WarmSeed,
  type WarmSourceSnapshot,
} from "../../src/arena/warm-pool"

function source(overrides: Partial<WarmSourceSnapshot> = {}): WarmSourceSnapshot {
  return {
    baseCommit: "base-1",
    baseRef: "refs/battles/chat/turn-2/base",
    gitTree: "tree-1",
    copyManifestID: "manifest-1",
    ignoredSeedID: "seed-1",
    ...overrides,
  }
}

function harness() {
  const paths = new Set<string>()
  const states = new Map<string, { tree: string; manifest: string; branch: string; source: string }>()
  const calls: string[] = []
  let failSide: Side | undefined
  let seedVersion = 0
  const adapter: WarmPoolAdapter = {
    async createIgnoredSeed(input) {
      calls.push("create-seed")
      return { seedID: input.ignoredSeedID, copyManifestID: input.copyManifestID }
    },
    async cloneIgnoredSeed({ seed, target }) {
      const side = target.endsWith("-a") ? "a" : "b"
      calls.push(`clone-${side}`)
      if (side === failSide) throw new Error(`copy ${side} failed`)
      paths.add(target)
      states.set(target, { tree: "tree-1", manifest: seed.copyManifestID, branch: `branch-${side}`, source: "base-1" })
    },
    async refreshIgnoredSeed({ source: next }) {
      seedVersion++
      calls.push("refresh-seed")
      return { seedID: `seed-${seedVersion + 1}`, copyManifestID: next.copyManifestID }
    },
    async registerWorktree(input) {
      calls.push(`register-${input.side}`)
      paths.add(input.path)
    },
    async resetBranch(input) {
      calls.push(`reset-${input.side}`)
      const existing = states.get(input.path)
      if (existing) existing.source = input.source.baseCommit
    },
    async refreshWorktree({ side, path, seed, source: next }) {
      calls.push(`refresh-${side}`)
      const existing = states.get(path)
      if (!existing) throw new Error("missing registered worktree")
      existing.tree = next.gitTree
      existing.manifest = seed.copyManifestID
      existing.source = next.baseCommit
    },
    async detachWorktree(input) {
      calls.push(`detach-${input.side}`)
    },
    async removeWorktree(input) {
      calls.push(`remove-${input.side}`)
      paths.delete(input.path)
      states.delete(input.path)
    },
    async verifyWorktree(input) {
      calls.push(`verify-${input.side}`)
      const value = states.get(input.path)
      if (!value) throw new Error("worktree is not registered")
      return { gitTree: value.tree, copyManifestID: value.manifest, branch: input.branch, sourceCommit: value.source }
    },
  }
  let durable: WarmPairState | undefined
  const store: WarmPoolStore = {
    async load() {
      return durable
    },
    async save({ state, expectedGeneration }) {
      if (expectedGeneration !== undefined && durable?.generation !== expectedGeneration) {
        throw new Error("CAS conflict")
      }
      durable = state
    },
  }
  return { adapter, store, calls, paths, states, setFailSide: (side: Side | undefined) => (failSide = side), get state() { return durable } }
}

describe("Arena warm pool", () => {
  test("prepares exactly two generation-scoped sides from one seed, named from one", async () => {
    const h = harness()
    const pool = createWarmPool(h.adapter, h.store)
    const result = await pool.prepare({
      chatID: "chat-1",
      chatSlug: "chat-slug",
      generation: 3,
      worktreeRoot: "/arena",
      source: source(),
    })

    expect(result.state).toBe("ready")
    expect(result.worktrees.a.directory).toBe("/arena/chat-slug/generation-4-a")
    expect(result.worktrees.b.directory).toBe("/arena/chat-slug/generation-4-b")
    expect(result.worktrees.a.branch).toBe("agent-duel/chat-slug-agent-a")
    expect(result.worktrees.a.sourceCommit).toBe("base-1")
    expect(h.paths.size).toBe(2)
    expect(h.calls.filter((call) => call === "create-seed")).toHaveLength(1)
  })

  test("discards both paths when one side fails and never exposes a partial pair", async () => {
    const h = harness()
    h.setFailSide("b")
    const pool = createWarmPool(h.adapter, h.store)
    await expect(
      pool.prepare({ chatID: "chat-1", chatSlug: "slug", generation: 1, worktreeRoot: "/arena", source: source() }),
    ).rejects.toThrow("copy b failed")
    expect(h.paths.size).toBe(0)
    expect(h.calls.filter((call) => call.startsWith("remove-")).sort()).toEqual(["remove-a", "remove-b"])
    expect(h.state?.state).toBe("failed")
  })

  test("refreshes both sides from one authoritative source and detects pair identity", async () => {
    const h = harness()
    const pool = createWarmPool(h.adapter, h.store)
    await pool.prepare({ chatID: "chat-1", chatSlug: "slug", generation: 2, worktreeRoot: "/arena", source: source() })
    const refreshed = await pool.refresh({
      chatID: "chat-1",
      chatSlug: "slug",
      generation: 2,
      worktreeRoot: "/arena",
      expectedGeneration: 2,
      source: source({ baseCommit: "base-2", baseRef: "refs/battles/chat/turn-3/base", gitTree: "tree-2", copyManifestID: "manifest-2", ignoredSeedID: "seed-2" }),
    })
    expect(refreshed.state).toBe("ready")
    expect(refreshed.source.baseCommit).toBe("base-2")
    expect(refreshed.worktrees.a.gitTree).toBe("tree-2")
    expect(refreshed.worktrees.b.includedContentManifestID).toBe("manifest-2")
    expect(h.calls.filter((call) => call === "refresh-seed")).toHaveLength(1)
    expect(h.calls.filter((call) => call.startsWith("refresh-")).sort()).toEqual(["refresh-a", "refresh-b", "refresh-seed"])
  })

  test("restart reconciliation and lease are all-or-nothing", async () => {
    const h = harness()
    const pool = createWarmPool(h.adapter, h.store)
    await pool.prepare({ chatID: "chat-1", chatSlug: "slug", generation: 4, worktreeRoot: "/arena", source: source() })
    const recovered = await pool.reconcile("chat-1")
    expect(recovered.coldFallback).toBe(false)
    expect((await pool.lease({ chatID: "chat-1", expectedGeneration: 4 }))?.worktrees.b.ready).toBe(true)
    h.states.get("/arena/slug/generation-5-b")!.manifest = "wrong-manifest"
    const invalid = await pool.reconcile("chat-1")
    expect(invalid.coldFallback).toBe(true)
    expect(await pool.lease({ chatID: "chat-1", expectedGeneration: 4 })).toBeUndefined()
  })
})
