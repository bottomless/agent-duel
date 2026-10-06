import type { CopyManifest } from "./copy-snapshot"
import { generationName, type Side } from "./domain"
import type { WarmWorktreeRecord } from "./records"

/** The one source from which both sides of a warm pair are materialized. */
export type WarmSourceSnapshot = {
  readonly baseCommit: string
  readonly baseRef: string
  readonly gitTree: string
  readonly copyManifestID: string
  readonly ignoredSeedID: string
  readonly ignoredSeedRoot?: string
  /** The complete manifest is useful to adapters that implement refresh. */
  readonly copyManifest?: CopyManifest
}

export type WarmSeed = {
  readonly seedID: string
  readonly copyManifestID: string
  readonly seedRoot?: string
}

export type WarmPathInput = {
  readonly chatID: string
  readonly chatSlug: string
  readonly generation: number
  readonly worktreeRoot: string
  readonly side: Side
  readonly branch?: string
  readonly path: string
  readonly source: WarmSourceSnapshot
}

export type WarmRefreshInput = WarmPathInput & {
  readonly seed: WarmSeed
  readonly previousManifestID: string
}

export type WarmVerification = {
  readonly gitTree: string
  /** Identity of the included-content manifest after materialization. */
  readonly copyManifestID: string
  readonly branch?: string
  readonly sourceCommit?: string
  readonly sourceRef?: string
  readonly seedID?: string
}

/**
 * This is deliberately narrower than the Git and filesystem implementations.
 * Production adapters can use ArenaGit/copy-snapshot; tests can model the
 * lifecycle with an in-memory repository without mocking module functions.
 */
export type WarmPoolAdapter = {
  readonly createIgnoredSeed: (source: WarmSourceSnapshot) => Promise<WarmSeed>
  readonly cloneIgnoredSeed: (input: { readonly seed: WarmSeed; readonly target: string }) => Promise<void>
  readonly refreshIgnoredSeed: (input: {
    readonly source: WarmSourceSnapshot
    readonly previous: WarmSeed
  }) => Promise<WarmSeed>
  readonly registerWorktree: (input: WarmPathInput) => Promise<void>
  readonly resetBranch: (input: WarmPathInput & { readonly attached?: boolean }) => Promise<void>
  readonly refreshWorktree?: (input: WarmRefreshInput) => Promise<void>
  readonly detachWorktree: (input: WarmPathInput) => Promise<void>
  readonly removeWorktree: (input: WarmPathInput) => Promise<void>
  readonly verifyWorktree: (input: WarmPathInput) => Promise<WarmVerification>
}

export type WarmSlotRecord = WarmWorktreeRecord & {
  readonly gitTree: string
  readonly includedContentManifestID: string
  readonly sourceRef: string
}

export type WarmPairState = {
  readonly chatID: string
  readonly chatSlug: string
  readonly generation: number
  readonly state: "pending" | "ready" | "failed"
  readonly source: WarmSourceSnapshot
  readonly seed?: WarmSeed
  readonly worktrees: Record<Side, WarmSlotRecord>
  readonly error?: string
}

export type WarmPoolStore = {
  /** Save must reject when expectedGeneration does not match its durable value. */
  readonly save: (input: { readonly state: WarmPairState; readonly expectedGeneration?: number }) => Promise<void>
  readonly load?: (chatID: string) => Promise<WarmPairState | undefined>
}

export type WarmPoolInput = {
  readonly chatID: string
  readonly chatSlug: string
  readonly generation: number
  readonly worktreeRoot: string
  /** The developer's canonical branch; absent when the checkout is detached. */
  readonly branch?: string
  readonly source: WarmSourceSnapshot
  /** Used as a CAS precondition against a state loaded by the caller. */
  readonly expectedGeneration?: number
}

export type WarmRefreshPairInput = WarmPoolInput & {
  readonly expectedGeneration: number
}

export type WarmPair = {
  readonly generation: number
  readonly source: WarmSourceSnapshot
  readonly seed: WarmSeed
  readonly worktrees: Record<Side, WarmSlotRecord>
}

export class WarmPoolConflictError extends Error {
  readonly expectedGeneration: number | undefined
  readonly actualGeneration: number | undefined

  constructor(expectedGeneration: number | undefined, actualGeneration: number | undefined) {
    super(
      `Warm pool generation conflict: expected ${expectedGeneration === undefined ? "none" : expectedGeneration}, ` +
        `found ${actualGeneration === undefined ? "none" : actualGeneration}`,
    )
    this.name = "WarmPoolConflictError"
    this.expectedGeneration = expectedGeneration
    this.actualGeneration = actualGeneration
  }
}

export class WarmPoolPairError extends Error {
  readonly generation: number

  constructor(generation: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WarmPoolPairError"
    this.generation = generation
  }
}

const SIDES: readonly Side[] = ["a", "b"]

function warmName(chatSlug: string, generation: number, side: Side) {
  return `${chatSlug}/${generationName(generation, side)}`
}

function pathFor(input: WarmPoolInput, side: Side) {
  return `${input.worktreeRoot.replace(/[\\/]$/, "")}/${warmName(input.chatSlug, input.generation, side)}`
}

function pathInput(input: WarmPoolInput, side: Side): WarmPathInput {
  return {
    ...input,
    side,
    path: pathFor(input, side),
  }
}

function slot(input: WarmPathInput, verified: WarmVerification, copyManifestID: string): WarmSlotRecord {
  return {
    side: input.side,
    name: warmName(input.chatSlug, input.generation, input.side),
    directory: input.path,
    ...(input.branch ? { branch: input.branch } : {}),
    sourceCommit: input.source.baseCommit,
    copyManifestID,
    ready: true,
    gitTree: verified.gitTree,
    includedContentManifestID: verified.copyManifestID,
    sourceRef: input.source.baseRef,
  }
}

function emptyWorktrees(): Record<Side, WarmSlotRecord> {
  // The records are filled before a state is persisted. Keeping this explicit
  // avoids ever serializing a one-sided warm pair as usable state.
  return {} as Record<Side, WarmSlotRecord>
}

function samePair(a: WarmSlotRecord, b: WarmSlotRecord) {
  return a.gitTree === b.gitTree && a.includedContentManifestID === b.includedContentManifestID
}

export class WarmPool {
  constructor(
    private readonly adapter: WarmPoolAdapter,
    private readonly store: WarmPoolStore,
  ) {}

  /**
   * Prepare both generation-scoped paths from one seed. Any one-sided error
   * removes both paths and persists a failed pair; it never returns a lease.
   */
  async prepare(input: WarmPoolInput): Promise<WarmPairState> {
    const previous = await this.store.load?.(input.chatID)
    this.assertExpected(input.expectedGeneration, previous?.generation)
    const paths = SIDES.map((side) => pathInput(input, side))
    const pending: WarmPairState = {
      chatID: input.chatID,
      chatSlug: input.chatSlug,
      generation: input.generation,
      state: "pending",
      source: input.source,
      worktrees: emptyWorktrees(),
    }
    await this.store.save({ state: pending, expectedGeneration: input.expectedGeneration })

    let seed: WarmSeed | undefined
    try {
      seed = await this.adapter.createIgnoredSeed(input.source)
      if (seed.copyManifestID !== input.source.copyManifestID) {
        throw new Error("Ignored seed manifest does not match the frozen source manifest")
      }
      // Reset before registration so a retained winner that did not detach
      // cannot be silently bypassed by the adapter.
      for (const path of paths) {
        await this.adapter.resetBranch(path)
        await this.adapter.registerWorktree(path)
      }
      const records = emptyWorktrees()
      for (const path of paths) {
        await this.adapter.cloneIgnoredSeed({ seed, target: path.path })
        await this.adapter.resetBranch({ ...path, attached: true })
        const verified = await this.adapter.verifyWorktree(path)
        records[path.side] = slot(path, verified, seed.copyManifestID)
      }
      this.assertPair(input.source, records)
      const ready: WarmPairState = { ...pending, state: "ready", seed, worktrees: records }
      await this.store.save({ state: ready, expectedGeneration: input.generation })
      return ready
    } catch (cause) {
      await this.cleanup(paths)
      const error = cause instanceof Error ? cause.message : String(cause)
      const failed: WarmPairState = { ...pending, state: "failed", ...(seed ? { seed } : {}), error }
      // A failed generation remains durable. Consumers can safely fall back to
      // cold creation without accidentally leasing one partially prepared side.
      await this.store.save({ state: failed, expectedGeneration: input.generation })
      throw new WarmPoolPairError(input.generation, error, { cause })
    }
  }

  /** Warming is an optimization after promotion, so callers can make it non-fatal. */
  async prepareAfterPromotion(input: WarmPoolInput): Promise<WarmPoolStateResult> {
    try {
      return { state: await this.prepare(input), coldFallback: false }
    } catch (error) {
      const state = (await this.store.load?.(input.chatID)) ?? {
        chatID: input.chatID,
        chatSlug: input.chatSlug,
        generation: input.generation,
        state: "failed" as const,
        source: input.source,
        worktrees: emptyWorktrees(),
        error: error instanceof Error ? error.message : String(error),
      }
      return { state, coldFallback: true }
    }
  }

  /** Refresh both warm sides from one authoritative next-send snapshot. */
  async refresh(input: WarmRefreshPairInput): Promise<WarmPairState> {
    const current = await this.store.load?.(input.chatID)
    this.assertExpected(input.expectedGeneration, current?.generation)
    if (!current || current.state !== "ready" || current.generation !== input.generation || !current.seed) {
      throw new WarmPoolConflictError(input.expectedGeneration, current?.generation)
    }
    if (!current.worktrees.a || !current.worktrees.b) {
      throw new WarmPoolPairError(input.generation, "Warm pair is missing a side")
    }
    const paths = SIDES.map((side) => pathInput(input, side))
    if (paths.some((path) => current.worktrees[path.side].directory !== path.path)) {
      throw new WarmPoolPairError(input.generation, "Warm paths are not generation-scoped")
    }
    const pending: WarmPairState = { ...current, state: "pending", source: input.source }
    await this.store.save({ state: pending, expectedGeneration: input.expectedGeneration })
    try {
      const seed = await this.adapter.refreshIgnoredSeed({ source: input.source, previous: current.seed })
      if (seed.copyManifestID !== input.source.copyManifestID) {
        throw new Error("Refreshed ignored seed manifest does not match the authoritative source manifest")
      }
      const records = emptyWorktrees()
      for (const path of paths) {
        const previous = current.worktrees[path.side]
        if (this.adapter.refreshWorktree) {
          await this.adapter.refreshWorktree({
            ...path,
            seed,
            previousManifestID: previous.includedContentManifestID,
          })
        } else {
          await this.adapter.cloneIgnoredSeed({ seed, target: path.path })
        }
        await this.adapter.resetBranch({ ...path, attached: true })
        const verified = await this.adapter.verifyWorktree(path)
        records[path.side] = slot(path, verified, seed.copyManifestID)
      }
      this.assertPair(input.source, records)
      const ready: WarmPairState = { ...pending, state: "ready", seed, worktrees: records }
      await this.store.save({ state: ready, expectedGeneration: input.generation })
      return ready
    } catch (cause) {
      await this.cleanup(paths)
      const error = cause instanceof Error ? cause.message : String(cause)
      const failed: WarmPairState = { ...pending, state: "failed", error }
      await this.store.save({ state: failed, expectedGeneration: input.generation })
      throw new WarmPoolPairError(input.generation, error, { cause })
    }
  }

  /** Non-fatal next-send refresh; callers may create a cold pair on failure. */
  async refreshForSend(input: WarmRefreshPairInput): Promise<WarmPoolStateResult> {
    try {
      return { state: await this.refresh(input), coldFallback: false }
    } catch (error) {
      const state = await this.store.load?.(input.chatID)
      return {
        state: state ?? {
          chatID: input.chatID,
          chatSlug: input.chatSlug,
          generation: input.generation,
          state: "failed",
          source: input.source,
          worktrees: emptyWorktrees(),
          error: error instanceof Error ? error.message : String(error),
        },
        coldFallback: true,
      }
    }
  }

  /** Verify both persisted sides after a backend restart before leasing. */
  async reconcile(chatID: string): Promise<WarmPoolStateResult> {
    const current = await this.store.load?.(chatID)
    if (!current) return { state: undefined, coldFallback: true }
    if (current.state !== "ready" || !current.seed) return { state: current, coldFallback: true }
    if (!current.worktrees.a || !current.worktrees.b) {
      const failed = { ...current, state: "failed" as const, error: "Warm pair is missing a side" }
      await this.store.save({ state: failed, expectedGeneration: current.generation })
      return { state: failed, coldFallback: true }
    }
    const paths = SIDES.map((side) => ({
      chatID: current.chatID,
      chatSlug: current.chatSlug,
      generation: current.generation,
      worktreeRoot: current.worktrees[side].directory.slice(
        0,
        -(`/${warmName(current.chatSlug, current.generation, side)}`).length,
      ),
      side,
      branch: current.worktrees[side].branch,
      path: current.worktrees[side].directory,
      source: current.source,
    }))
    try {
      const records = emptyWorktrees()
      for (const path of paths) {
        const verified = await this.adapter.verifyWorktree(path)
        const persisted = current.worktrees[path.side]
        if (
          verified.gitTree !== persisted.gitTree ||
          verified.copyManifestID !== persisted.includedContentManifestID ||
          (verified.branch !== undefined && verified.branch !== persisted.branch) ||
          (verified.sourceCommit !== undefined && verified.sourceCommit !== current.source.baseCommit) ||
          (verified.sourceRef !== undefined && verified.sourceRef !== persisted.sourceRef) ||
          (verified.seedID !== undefined && verified.seedID !== current.seed.seedID)
        ) {
          throw new Error(`Warm ${path.side} does not match persisted generation ${current.generation}`)
        }
        records[path.side] = { ...persisted, ready: true }
      }
      this.assertPair(current.source, records)
      const ready = { ...current, state: "ready" as const, worktrees: records }
      await this.store.save({ state: ready, expectedGeneration: current.generation })
      return { state: ready, coldFallback: false }
    } catch (error) {
      const failed = { ...current, state: "failed" as const, error: error instanceof Error ? error.message : String(error) }
      await this.store.save({ state: failed, expectedGeneration: current.generation })
      return { state: failed, coldFallback: true }
    }
  }

  /** A lease is all-or-nothing; callers create both sides cold when absent. */
  async lease(input: { readonly chatID: string; readonly expectedGeneration: number }): Promise<WarmPair | undefined> {
    const current = await this.store.load?.(input.chatID)
    if (!current || current.generation !== input.expectedGeneration || current.state !== "ready" || !current.seed) return
    if (!this.isReadyPair(current)) return
    return { generation: current.generation, source: current.source, seed: current.seed, worktrees: current.worktrees }
  }

  private assertExpected(expected: number | undefined, actual: number | undefined) {
    if (expected !== undefined && expected !== actual) throw new WarmPoolConflictError(expected, actual)
  }

  private assertPair(source: WarmSourceSnapshot, records: Record<Side, WarmSlotRecord>) {
    const a = records.a
    const b = records.b
    if (!a || !b || !a.ready || !b.ready || !samePair(a, b)) {
      throw new Error("Warm pair Git trees or included-content manifests do not match")
    }
    if (a.gitTree !== source.gitTree || b.gitTree !== source.gitTree) {
      throw new Error("Warm pair Git tree does not match the frozen base")
    }
    if (a.includedContentManifestID !== source.copyManifestID || b.includedContentManifestID !== source.copyManifestID) {
      throw new Error("Warm pair included-content manifest does not match the source snapshot")
    }
  }

  private isReadyPair(state: WarmPairState) {
    try {
      this.assertPair(state.source, state.worktrees)
      return true
    } catch {
      return false
    }
  }

  private async cleanup(paths: readonly WarmPathInput[]) {
    await Promise.all(
      paths.map(async (path) => {
        await this.adapter.detachWorktree(path).catch(() => undefined)
        await this.adapter.removeWorktree(path).catch(() => undefined)
      }),
    )
  }
}

export type WarmPoolStateResult = {
  readonly state: WarmPairState | undefined
  readonly coldFallback: boolean
}

export function createWarmPool(adapter: WarmPoolAdapter, store: WarmPoolStore) {
  return new WarmPool(adapter, store)
}

export const ArenaWarmPool = {
  WarmPool,
  createWarmPool,
  WarmPoolConflictError,
  WarmPoolPairError,
}
