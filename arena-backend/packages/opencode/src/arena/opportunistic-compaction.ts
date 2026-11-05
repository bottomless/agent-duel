/** Storage-agnostic coordination for speculative (opportunistic) summaries. */

export type CompactionStatus = "pending" | "ready" | "used" | "canceled" | "failed" | "discarded"

export interface CompactionSnapshot<Candidate = unknown> {
  readonly id: number
  readonly runID: string
  readonly sourceSessionID: string
  readonly sessionID: string
  readonly sourceVersion: unknown
  readonly targetVersion: unknown
  readonly status: CompactionStatus
  readonly createdAt: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly readyAt?: number
  readonly canceledAt?: number
  readonly cancellationFailed: boolean
  readonly perceivedWaitMs: 0
  readonly candidate?: Candidate
  readonly error?: unknown
}

export interface CompactionFinish<Candidate = unknown> {
  readonly id: number
  readonly runID: string
  readonly sourceSessionID: string
  readonly sessionID: string
  readonly sourceVersion: unknown
  readonly targetVersion: unknown
  readonly status: CompactionStatus
  readonly candidate?: Candidate
  readonly error?: unknown
  readonly cancellationFailed: boolean
  readonly finishedAt?: number
}

export interface CompactionStart<Candidate> {
  readonly runID: string
  readonly sessionID: string
  readonly sourceVersion: unknown
  readonly generate: (signal: AbortSignal) => Promise<Candidate> | Candidate
  /** Optional atomic publication gate for a caller's storage transaction. */
  readonly publish?: (candidate: Candidate, publish: () => boolean) => Promise<boolean> | boolean
  readonly cancel?: () => void | Promise<void>
}

export interface CompactionEntry<Candidate> {
  readonly id: number
  readonly runID: string
  readonly sourceSessionID: string
  readonly signal: AbortSignal
  readonly finished: Promise<CompactionFinish<Candidate>>
  readonly done: Promise<CompactionFinish<Candidate>>
  readonly status: CompactionStatus
  readonly candidate?: Candidate
  readonly sourceVersion: unknown
  readonly targetVersion: unknown
  readonly sessionID: string
  readonly cancellationFailed: boolean
  readonly snapshot: () => CompactionSnapshot<Candidate>
  readonly finishInfo: () => CompactionFinish<Candidate>
  readonly invalidate: () => boolean
  readonly cancel: () => boolean
  readonly discard: () => boolean
}

export interface CompactionSelection<Candidate> {
  readonly candidate: Candidate
  readonly runID: string
  readonly sourceSessionID: string
  readonly sessionID: string
  readonly sourceVersion: unknown
  readonly version: unknown
  readonly targetVersion: unknown
  readonly entry: CompactionEntry<Candidate>
}

export interface CompactionTransfer<Candidate> {
  readonly sourceVersion: unknown
  readonly targetVersion: unknown
  readonly mapCandidate?: (candidate: Candidate) => Candidate
}

export interface CompactionMetrics {
  readonly started: number
  readonly used: number
  readonly canceled: number
  readonly failed: number
  readonly discarded: number
}

type MutableMetrics = { -readonly [Key in keyof CompactionMetrics]: number }

export type CompactionObserve<Candidate> = (snapshot: CompactionSnapshot<Candidate>) => void
export interface CreateCompactionsOptions<Candidate> {
  readonly observe?: CompactionObserve<Candidate>
  readonly now?: () => number
}

type State<Candidate> = {
  id: number
  runID: string
  sourceSessionID: string
  sessionID: string
  sourceVersion: unknown
  targetVersion: unknown
  status: CompactionStatus
  controller: AbortController
  generate: (signal: AbortSignal) => Promise<Candidate> | Candidate
  publish?: (candidate: Candidate, publish: () => boolean) => Promise<boolean> | boolean
  cancel?: () => void | Promise<void>
  cancelRequested: boolean
  cancellationFailed: boolean
  createdAt: number
  startedAt: number
  finishedAt?: number
  readyAt?: number
  canceledAt?: number
  candidate?: Candidate
  error?: unknown
  discardedRecorded: boolean
  mapCandidate?: (candidate: Candidate) => Candidate
  resolveFinished: (finish: CompactionFinish<Candidate>) => void
  finishedPromise?: Promise<CompactionFinish<Candidate>>
}

const sameVersion = (left: unknown, right: unknown) => Object.is(left, right)

function getOptions<Candidate>(input?: CompactionObserve<Candidate> | CreateCompactionsOptions<Candidate>) {
  // Fractional epoch time makes the prompt's millisecond arrival cutoff conservative:
  // a result published later in the same millisecond cannot be mistaken for an earlier result.
  const now = () => performance.timeOrigin + performance.now()
  if (typeof input === "function") return { observe: input, now }
  return { observe: input?.observe, now: input?.now ?? now }
}

export interface CompactionCoordinator<Candidate> {
  readonly start: (input: CompactionStart<Candidate>) => CompactionEntry<Candidate>
  readonly select: {
    (sessionID: string, version: unknown): Candidate | null
    (sessionID: string): CompactionSelection<Candidate> | null
  }
  readonly take: (sessionID: string, version?: unknown) => CompactionSelection<Candidate> | null
  readonly commitUsed: (selection: CompactionSelection<Candidate>) => boolean
  readonly used: (selection: CompactionSelection<Candidate>) => boolean
  readonly markUsed: (selection: CompactionSelection<Candidate>) => boolean
  readonly transfer: (
    sourceSessionID: string,
    targetSessionID: string,
    transfer: CompactionTransfer<Candidate>,
  ) => CompactionEntry<Candidate> | null
  readonly invalidate: (sessionID: string, expectedVersion?: unknown) => boolean
  readonly invalidateAll: () => number
  readonly dispose: () => void
  readonly discard: (entry: CompactionEntry<Candidate> | CompactionSelection<Candidate>) => boolean
  readonly inspect: (sessionID: string) => CompactionSnapshot<Candidate> | null
  readonly metrics: () => CompactionMetrics
  readonly stats: () => CompactionMetrics
}

/**
 * Start generation immediately, but never await it. Entries are keyed by the
 * owning session and one new start supersedes that session's old entry.
 */
export function createCompactions<Candidate>(
  input?: CompactionObserve<Candidate> | CreateCompactionsOptions<Candidate>,
): CompactionCoordinator<Candidate> {
  const { observe, now } = getOptions(input)
  const entries = new Map<string, State<Candidate>>()
  const reservedEntries = new Map<number, State<Candidate>>()
  let nextID = 1
  const counts: MutableMetrics = { started: 0, used: 0, canceled: 0, failed: 0, discarded: 0 }

  const snapshot = (entry: State<Candidate>): CompactionSnapshot<Candidate> => ({
    id: entry.id,
    runID: entry.runID,
    sourceSessionID: entry.sourceSessionID,
    sessionID: entry.sessionID,
    sourceVersion: entry.sourceVersion,
    targetVersion: entry.targetVersion,
    status: entry.status,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    readyAt: entry.readyAt,
    canceledAt: entry.canceledAt,
    cancellationFailed: entry.cancellationFailed,
    perceivedWaitMs: 0,
    candidate: entry.candidate,
    error: entry.error,
  })

  const emit = (entry: State<Candidate>) => {
    if (!observe) return
    try {
      observe(snapshot(entry))
    } catch {
      // Diagnostics must never affect the generation state machine.
    }
  }

  const finish = (entry: State<Candidate>): CompactionFinish<Candidate> => ({
    id: entry.id,
    runID: entry.runID,
    sourceSessionID: entry.sourceSessionID,
    sessionID: entry.sessionID,
    sourceVersion: entry.sourceVersion,
    targetVersion: entry.targetVersion,
    status: entry.status,
    candidate: entry.candidate,
    error: entry.error,
    cancellationFailed: entry.cancellationFailed,
    finishedAt: entry.finishedAt,
  })

  const remove = (entry: State<Candidate>) => {
    if (entries.get(entry.sessionID) === entry) entries.delete(entry.sessionID)
  }

  const resolve = (entry: State<Candidate>) => {
    entry.resolveFinished(finish(entry))
  }

  const discard = (entry: State<Candidate>) => {
    if (entry.discardedRecorded) return
    entry.discardedRecorded = true
    counts.discarded += 1
    entry.status = "discarded"
    entry.finishedAt = now()
    emit(entry)
    resolve(entry)
    remove(entry)
    reservedEntries.delete(entry.id)
  }

  const requestCancel = (entry: State<Candidate>): boolean => {
    if (entry.status === "ready") {
      discard(entry)
      return false
    }
    if (entry.status !== "pending" || entry.cancelRequested) return false
    entry.cancelRequested = true
    entry.status = "canceled"
    entry.canceledAt = now()
    counts.canceled += 1
    emit(entry)
    // The caller must not wait for cancellation (a provider can hang forever).
    resolve(entry)
    remove(entry)
    entry.controller.abort()
    if (entry.cancel) {
      try {
        const result = entry.cancel()
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch(() => {
            entry.cancellationFailed = true
            emit(entry)
          })
        }
      } catch {
        entry.cancellationFailed = true
        emit(entry)
      }
    }
    return true
  }

  const invalidateEntry = (entry: State<Candidate>) => {
    if (entry.status === "pending") return requestCancel(entry)
    if (entry.status === "ready") {
      discard(entry)
      return true
    }
    return false
  }

  const fail = (entry: State<Candidate>, error: unknown) => {
    if (entry.status !== "pending" && entry.status !== "ready") return
    entry.status = "failed"
    entry.error = error
    entry.finishedAt = now()
    counts.failed += 1
    emit(entry)
    resolve(entry)
    remove(entry)
  }

  const handleFor = (
    entry: State<Candidate>,
    finished: Promise<CompactionFinish<Candidate>>,
  ): CompactionEntry<Candidate> => ({
    id: entry.id,
    runID: entry.runID,
    sourceSessionID: entry.sourceSessionID,
    signal: entry.controller.signal,
    finished,
    done: finished,
    get status() {
      return entry.status
    },
    get candidate() {
      return entry.candidate
    },
    get sourceVersion() {
      return entry.sourceVersion
    },
    get targetVersion() {
      return entry.targetVersion
    },
    get sessionID() {
      return entry.sessionID
    },
    get cancellationFailed() {
      return entry.cancellationFailed
    },
    snapshot: () => snapshot(entry),
    finishInfo: () => finish(entry),
    invalidate: () => invalidateEntry(entry),
    cancel: () => requestCancel(entry),
    discard: () => invalidateEntry(entry),
  })

  const deferred = (entry: State<Candidate>) => {
    let resolveFinished!: (value: CompactionFinish<Candidate>) => void
    const promise = new Promise<CompactionFinish<Candidate>>((resolveValue) => {
      resolveFinished = resolveValue
    })
    entry.resolveFinished = resolveFinished
    return promise
  }

  const start = (input: CompactionStart<Candidate>) => {
    const old = entries.get(input.sessionID)
    if (old) invalidateEntry(old)
    const entry: State<Candidate> = {
      id: nextID++,
      runID: input.runID,
      sourceSessionID: input.sessionID,
      sessionID: input.sessionID,
      sourceVersion: input.sourceVersion,
      targetVersion: input.sourceVersion,
      status: "pending" as CompactionStatus,
      controller: new AbortController(),
      generate: input.generate,
      publish: input.publish,
      cancel: input.cancel,
      cancelRequested: false,
      cancellationFailed: false,
      createdAt: now(),
      startedAt: now(),
      candidate: undefined,
      discardedRecorded: false,
      resolveFinished: (() => undefined) as (value: CompactionFinish<Candidate>) => void,
    }
    const finished = deferred(entry)
    entry.finishedPromise = finished
    entries.set(entry.sessionID, entry)
    counts.started += 1
    emit(entry)
    const handle = handleFor(entry, finished)
    let generated: Promise<Candidate> | Candidate
    try {
      generated = entry.generate(entry.controller.signal)
    } catch (error) {
      fail(entry, error)
      return handle
    }
    void Promise.resolve(generated).then(
      (candidate) => {
        if (entry.status === "canceled") {
          // Providers may ignore AbortSignal. A late value is discarded once.
          discard(entry)
          return
        }
        if (entry.status !== "pending" || entries.get(entry.sessionID) !== entry) return
        let mapped: Candidate
        try {
          mapped = entry.mapCandidate ? entry.mapCandidate(candidate) : candidate
        } catch (error) {
          fail(entry, error)
          return
        }
        const guardedPublish = () => {
          if (entry.status !== "pending" || entries.get(entry.sessionID) !== entry) return false
          entry.candidate = mapped
          entry.status = "ready"
          entry.readyAt = now()
          emit(entry)
          return true
        }
        let published: Promise<boolean> | boolean
        try {
          published = entry.publish ? entry.publish(mapped, guardedPublish) : guardedPublish()
        } catch (error) {
          if ((entry.status as CompactionStatus) === "canceled") discard(entry)
          else fail(entry, error)
          return
        }
        void Promise.resolve(published).then(
          (accepted) => {
            if (accepted) return
            if (entry.status === "pending" || entry.status === "canceled") discard(entry)
          },
          (error) => {
            if (entry.status === "canceled") discard(entry)
            else fail(entry, error)
          },
        )
      },
      (error) => {
        // Rejection caused by an abort is cancellation, not a failed request.
        if (entry.status === "canceled") {
          // Keep the canceled outcome, but only now mark generation as
          // settled. A provider that never settles intentionally remains
          // without finishedAt.
          if (entry.finishedAt === undefined) entry.finishedAt = now()
          emit(entry)
          return
        }
        fail(entry, error)
      },
    )
    return handle
  }

  const take = (sessionID: string, version?: unknown): CompactionSelection<Candidate> | null => {
    const entry = entries.get(sessionID)
    if (!entry || entry.status !== "ready") {
      if (entry) invalidateEntry(entry)
      return null
    }
    if (version !== undefined && !sameVersion(entry.targetVersion, version)) {
      invalidateEntry(entry)
      return null
    }
    const candidate = entry.candidate as Candidate
    // A versioned selection is the original atomic API: it consumes the
    // candidate immediately. `take` without a version reserves it for the
    // caller, who can commit or discard after validating storage.
    if (version !== undefined) {
      entry.status = "used"
      counts.used += 1
      entry.finishedAt = now()
      emit(entry)
      resolve(entry)
    }
    remove(entry)
    if (version === undefined) reservedEntries.set(entry.id, entry)
    const handle = handleFor(entry, entry.finishedPromise ?? Promise.resolve(finish(entry)))
    return {
      candidate,
      runID: entry.runID,
      sourceSessionID: entry.sourceSessionID,
      sessionID: entry.sessionID,
      sourceVersion: entry.sourceVersion,
      version: entry.targetVersion,
      targetVersion: entry.targetVersion,
      entry: handle,
    }
  }

  const select = ((sessionID: string, version?: unknown) => {
    const selection = take(sessionID, version)
    if (!selection) return null
    return version === undefined ? selection : selection.candidate
  }) as CompactionCoordinator<Candidate>["select"]

  const commitUsed = (selection: CompactionSelection<Candidate>) => {
    const state = selection.entry.status
    if (state === "used") return true
    if (state !== "ready") return false
    const reserved = reservedEntries.get(selection.entry.id)
    if (!reserved || reserved.status !== "ready") return false
    reserved.status = "used"
    counts.used += 1
    reserved.finishedAt = now()
    emit(reserved)
    resolve(reserved)
    reservedEntries.delete(reserved.id)
    return true
  }

  const transfer = (
    sourceSessionID: string,
    targetSessionID: string,
    input: CompactionTransfer<Candidate>,
  ): CompactionEntry<Candidate> | null => {
    const entry = entries.get(sourceSessionID)
    if (!entry || !sameVersion(entry.sourceVersion, input.sourceVersion)) return null
    if (sourceSessionID !== targetSessionID) {
      const target = entries.get(targetSessionID)
      if (target) invalidateEntry(target)
    }
    entries.delete(sourceSessionID)
    entry.sessionID = targetSessionID
    entry.targetVersion = input.targetVersion
    if (input.mapCandidate) {
      if (entry.status === "ready") {
        try {
          entry.candidate = input.mapCandidate(entry.candidate as Candidate)
        } catch (error) {
          fail(entry, error)
        }
      } else if (entry.status === "pending") {
        const old = entry.mapCandidate
        entry.mapCandidate = old ? (candidate) => input.mapCandidate!(old(candidate)) : input.mapCandidate
      }
    }
    if (entry.status === "pending" || entry.status === "ready") entries.set(targetSessionID, entry)
    emit(entry)
    return handleFor(entry, entry.finishedPromise ?? Promise.resolve(finish(entry)))
  }

  const invalidate = (sessionID: string, expectedVersion?: unknown) => {
    const entry = entries.get(sessionID)
    if (!entry || (expectedVersion !== undefined && !sameVersion(entry.targetVersion, expectedVersion))) return false
    return invalidateEntry(entry)
  }

  const invalidateAll = () => {
    let invalidated = 0
    for (const entry of [...entries.values()]) {
      if (invalidateEntry(entry)) invalidated += 1
    }
    for (const entry of [...reservedEntries.values()]) {
      if (entry.status === "ready") {
        discard(entry)
        invalidated += 1
      }
    }
    return invalidated
  }

  const discardPublic = (entryOrSelection: CompactionEntry<Candidate> | CompactionSelection<Candidate>) => {
    const entry = "entry" in entryOrSelection ? entryOrSelection.entry : entryOrSelection
    const state = entries.get(entry.sessionID)
    if (state && state.id === entry.id) return invalidateEntry(state)
    const reserved = reservedEntries.get(entry.id)
    if (reserved && reserved.status === "ready") {
      reservedEntries.delete(reserved.id)
      discard(reserved)
      return true
    }
    // A committed entry is no longer cancellable.
    return false
  }

  const inspect = (sessionID: string) => {
    const entry = entries.get(sessionID)
    return entry ? snapshot(entry) : null
  }
  const metrics = () => ({ ...counts })
  return {
    start,
    select,
    take,
    commitUsed,
    used: commitUsed,
    markUsed: commitUsed,
    transfer,
    invalidate,
    invalidateAll,
    dispose: () => {
      invalidateAll()
    },
    discard: discardPublic,
    inspect,
    metrics,
    stats: metrics,
  }
}

export interface CompactUsage {
  readonly reasoningTokens: number | null
  readonly generatedTokens: number | null
  readonly contextTokens: number
}

export function shouldCompact(usage: CompactUsage): boolean {
  if (usage.reasoningTokens === null || usage.generatedTokens === null) return true
  if (usage.contextTokens >= 272_000) return true
  if (usage.reasoningTokens <= 500) return false
  if (usage.reasoningTokens <= 1_000 && usage.reasoningTokens <= usage.generatedTokens / 2) return false
  return true
}

export * as OpportunisticCompaction from "./opportunistic-compaction"
