import { createHash } from "crypto"
import { ArenaLive } from "./live"
import { constants } from "fs"
import { open } from "fs/promises"
import path from "path"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { MAX_ARTIFACT_BYTES } from "./artifact"
import { ArenaPrivacy } from "./privacy"
import type { Assignment } from "./proxy"
import { registry } from "./runtime"
import type { Store } from "./mongo"

type RunBinding = {
  readonly turnID: string
  readonly runID: string
  readonly rootSessionID: string
  readonly directory: string
  readonly assignment: Assignment
}

type PendingPartUpdate = {
  readonly event: GlobalEvent
  readonly binding: RunBinding
  readonly ids: { sessionID?: string; parentSessionID?: string }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function session(value: unknown): { sessionID?: string; parentSessionID?: string } {
  if (!record(value)) return {}
  const sessionID = typeof value.sessionID === "string" ? value.sessionID : undefined
  const parentSessionID = typeof value.parentID === "string" ? value.parentID : undefined
  if (sessionID || parentSessionID) return { sessionID, parentSessionID }
  for (const key of ["info", "part", "message", "session", "properties", "data", "syncEvent", "payload"]) {
    const nested = session(value[key])
    if (nested.sessionID || nested.parentSessionID) return nested
  }
  return {}
}

function content(value: unknown) {
  const serialized = JSON.stringify(value)
  return {
    serialized,
    bytes: new TextEncoder().encode(serialized),
    hash: createHash("sha256").update(serialized).digest("hex"),
  }
}

function eventType(event: GlobalEvent) {
  return record(event.payload) && typeof event.payload.type === "string" ? event.payload.type : "unknown"
}

function intermediateUserSummary(event: GlobalEvent) {
  if (!record(event.payload)) return false
  const source =
    event.payload.type === "sync" && record(event.payload.syncEvent) ? event.payload.syncEvent : event.payload
  const type = typeof source.type === "string" ? source.type.replace(/\.\d+$/, "") : ""
  if (type !== "message.updated") return false
  const properties = record(source.data) ? source.data : record(source.properties) ? source.properties : undefined
  const info = properties && record(properties.info) ? properties.info : undefined
  const summary = info && record(info.summary) ? info.summary : undefined
  return info?.role === "user" && Array.isArray(summary?.diffs)
}

function updatedPartKey(event: GlobalEvent, runID: string) {
  if (eventType(event) !== "message.part.updated" || !record(event.payload)) return undefined
  const properties = record(event.payload.properties) ? event.payload.properties : undefined
  const part = properties && record(properties.part) ? properties.part : undefined
  if (!part || typeof part.id !== "string") return undefined
  const messageID = typeof part.messageID === "string" ? part.messageID : ""
  return `${runID.length}:${runID}|${messageID.length}:${messageID}|${part.id}`
}

function durable(event: GlobalEvent) {
  if (!record(event.payload)) return {}
  const source = record(event.payload.syncEvent) ? event.payload.syncEvent : event.payload
  return {
    durableID: typeof source.id === "string" ? source.id : undefined,
    durableSequence:
      typeof source.seq === "number" ? source.seq : typeof source.sequence === "number" ? source.sequence : undefined,
    durableVersion:
      typeof source.version === "number"
        ? source.version
        : typeof source.type === "string"
          ? Number.parseInt(source.type.match(/\.(\d+)$/)?.[1] ?? "", 10) || undefined
          : undefined,
  }
}

function completedTool(event: GlobalEvent) {
  if (!record(event.payload)) return undefined
  const properties = record(event.payload.properties) ? event.payload.properties : undefined
  const part = properties && record(properties.part) ? properties.part : undefined
  const state = part && record(part.state) ? part.state : undefined
  const metadata = state && record(state.metadata) ? state.metadata : undefined
  if (!part || part.type !== "tool" || state?.status !== "completed") return undefined
  return {
    id: typeof part.id === "string" ? part.id : JSON.stringify(part),
    tool: typeof part.tool === "string" ? part.tool : "unknown",
    input: record(state.input) ? state.input : {},
    outputPath: typeof metadata?.outputPath === "string" ? metadata.outputPath : undefined,
  }
}

function toolStartedAt(event: GlobalEvent) {
  if (!record(event.payload)) return undefined
  const properties = record(event.payload.properties) ? event.payload.properties : undefined
  const part = properties && record(properties.part) ? properties.part : undefined
  const state = part && record(part.state) ? part.state : undefined
  const time = state && record(state.time) ? state.time : undefined
  if (!part || part.type !== "tool" || typeof time?.start !== "number" || !Number.isFinite(time.start)) return undefined
  return new Date(time.start)
}

export async function externalToolOutput(file: string, root = TRUNCATION_DIR, maxStoredBytes = MAX_ARTIFACT_BYTES) {
  if (!Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 0) return undefined
  const resolvedRoot = path.resolve(root)
  const resolvedFile = path.resolve(file)
  if (path.dirname(resolvedFile) !== resolvedRoot || !path.basename(resolvedFile).startsWith("tool_")) return undefined

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    handle = await open(resolvedFile, constants.O_RDONLY | noFollow)
    const stat = await handle.stat()
    if (!stat.isFile()) return undefined

    const hash = createHash("sha256")
    const prefix: Buffer[] = []
    let originalSize = 0
    let storedSize = 0
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      originalSize += chunk.byteLength
      hash.update(chunk)
      if (storedSize >= maxStoredBytes) continue
      const selected = chunk.subarray(0, Math.min(chunk.byteLength, maxStoredBytes - storedSize))
      prefix.push(selected)
      storedSize += selected.byteLength
    }
    return {
      data: Buffer.concat(prefix, storedSize),
      originalSize,
      contentHash: hash.digest("hex"),
    }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function testCommand(tool: ReturnType<typeof completedTool>) {
  if (!tool || !["bash", "shell"].includes(tool.tool)) return undefined
  const command = typeof tool.input.command === "string" ? tool.input.command : undefined
  if (!command) return undefined
  return /(^|\s)(test|pytest|vitest|jest|bun\s+test|npm\s+test|pnpm\s+test|cargo\s+test|go\s+test)(\s|$)/i.test(command)
    ? command
    : undefined
}

export class Recorder {
  readonly live = new ArenaLive()
  readonly bySession = new Map<string, RunBinding>()
  readonly byDirectory = new Map<string, RunBinding>()
  readonly sequence = new Map<string, number>()
  readonly receiveSequence = new Map<string, number>()
  readonly queues = new Map<string, Promise<void>>()
  readonly failures = new Map<string, { readonly cause: unknown; readonly count: number }>()
  readonly gaps = new Set<string>()
  readonly tools = new Map<string, Set<string>>()
  readonly firstToolRuns = new Set<string>()
  readonly firstEventRuns = new Set<string>()
  readonly firstTokenRuns = new Set<string>()
  readonly lastActivityWrites = new Map<string, number>()
  readonly normalizedByDurable = new Map<string, string>()
  readonly pendingPartUpdates = new Map<string, PendingPartUpdate>()
  readonly listener: (event: GlobalEvent) => void

  constructor(readonly store: Store) {
    this.listener = (event) => {
      const ids = session(event)
      const binding =
        (ids.sessionID ? this.bySession.get(ids.sessionID) : undefined) ??
        (ids.parentSessionID ? this.bySession.get(ids.parentSessionID) : undefined) ??
        (event.directory ? this.byDirectory.get(event.directory) : undefined)
      if (!binding) return
      this.live.capture(binding, event.payload)
      const previous = this.queues.get(binding.turnID) ?? Promise.resolve()
      const next = previous
        .then(async () => {
          const firstToolAt = toolStartedAt(event)
          if (firstToolAt && !this.firstToolRuns.has(binding.runID)) {
            await this.store.writeRun(
              { _id: binding.runID },
              { $min: { firstToolAt }, $set: { updatedAt: new Date() } },
            )
            this.firstToolRuns.add(binding.runID)
          }
          const partKey = updatedPartKey(event, binding.runID)
          if (partKey) {
            // Transcript snapshots are coalesced, but progress still makes the run active.
            await this.recordActivity(binding, new Date())
            this.pendingPartUpdates.set(partKey, { event, binding, ids })
            return
          }
          if (eventType(event) !== "message.part.delta") await this.drainPendingParts(binding.runID)
          await this.capture(event, binding, ids)
        })
        .catch((cause) => {
          this.recordFailure(binding.turnID, cause)
        })
      this.queues.set(binding.turnID, next)
    }
    GlobalBus.on("event", this.listener)
  }

  async register(binding: RunBinding) {
    if (!this.sequence.has(binding.turnID)) {
      const last = await this.store.events.find({ turnID: binding.turnID }).sort({ sequence: -1 }).limit(1).next()
      if (!this.sequence.has(binding.turnID)) this.sequence.set(binding.turnID, last ? last.sequence + 1 : 0)
    }
    if (!this.receiveSequence.has(binding.runID)) {
      const last = await this.store.rawEvents
        .find({ runID: binding.runID })
        .sort({ receiveSequence: -1 })
        .limit(1)
        .next()
      if (!this.receiveSequence.has(binding.runID)) {
        this.receiveSequence.set(binding.runID, last ? last.receiveSequence + 1 : 0)
      }
    }
    // Events may arrive as soon as a binding is visible. Initialize counters first
    // so registration cannot reset a sequence already advanced by capture().
    this.bySession.set(binding.rootSessionID, binding)
    this.byDirectory.set(binding.directory, binding)
  }

  close() {
    this.live.close()
    GlobalBus.off("event", this.listener)
  }

  async flush(turnID: string): Promise<void> {
    const queue = this.queues.get(turnID)
    if (queue) {
      await queue
      if (this.queues.get(turnID) !== queue) return this.flush(turnID)
    }
    const runIDs = new Set(
      Array.from(this.bySession.values()).flatMap((binding) => (binding.turnID === turnID ? [binding.runID] : [])),
    )
    if (Array.from(this.pendingPartUpdates.values()).some((pending) => runIDs.has(pending.binding.runID))) {
      const previous = this.queues.get(turnID) ?? Promise.resolve()
      const drain = previous
        .then(async () => {
          for (const runID of runIDs) await this.drainPendingParts(runID)
        })
        .catch((cause) => this.recordFailure(turnID, cause))
      this.queues.set(turnID, drain)
      await drain
      if (this.queues.get(turnID) !== drain) return this.flush(turnID)
    }
    const failure = this.failures.get(turnID)
    if (!failure) return
    if (this.gaps.has(turnID)) {
      const previous = this.queues.get(turnID) ?? Promise.resolve()
      const marker = previous
        .then(() => this.persistGap(turnID, failure))
        .catch((cause) => {
          this.recordFailure(turnID, cause)
        })
      this.queues.set(turnID, marker)
      await marker
      if (this.queues.get(turnID) !== marker) return this.flush(turnID)
      if (this.gaps.has(turnID)) throw this.persistenceError(this.failures.get(turnID)!)
    }
    const current = this.failures.get(turnID)!
    this.failures.delete(turnID)
    throw this.persistenceError(current)
  }

  private recordFailure(turnID: string, cause: unknown) {
    const failure = this.failures.get(turnID)
    const count = cause instanceof AggregateError ? Math.max(cause.errors.length, 1) : 1
    this.failures.set(turnID, { cause: failure?.cause ?? cause, count: (failure?.count ?? 0) + count })
    this.gaps.add(turnID)
  }

  private persistenceError(failure: { readonly cause: unknown; readonly count: number }) {
    return new Error(`Arena event persistence failed for ${failure.count} write${failure.count === 1 ? "" : "s"}`, {
      cause: failure.cause,
    })
  }

  private async persistGap(turnID: string, failure: { readonly count: number }) {
    const sequence = this.sequence.get(turnID) ?? 0
    const receivedAt = new Date()
    await this.store.saveEvent({
      _id: `event|${turnID.length}:${turnID}|${sequence}`,
      turnID,
      sequence,
      receivedAt,
      type: "arena.persistence.gap",
      payload: { failedWrites: failure.count },
      redactionVersion: "arena-privacy-v1",
      normalizationVersion: "arena-events-v1",
      coalesced: false,
      gap: true,
    })
    this.sequence.set(turnID, sequence + 1)
    this.gaps.delete(turnID)
  }

  unregister(runID: string) {
    this.live.release(runID)
    const turnIDs = new Set(
      Array.from(this.bySession.values()).flatMap((binding) => (binding.runID === runID ? [binding.turnID] : [])),
    )
    for (const [sessionID, binding] of this.bySession) {
      if (binding.runID === runID) {
        ArenaPrivacy.forgetSession(sessionID)
        this.bySession.delete(sessionID)
      }
    }
    for (const [directory, binding] of this.byDirectory) {
      if (binding.runID === runID) this.byDirectory.delete(directory)
    }
    for (const [sessionID, assignment] of registry.assignments) {
      if (assignment.runID === runID) registry.assignments.delete(sessionID)
    }
    this.receiveSequence.delete(runID)
    this.tools.delete(runID)
    this.firstToolRuns.delete(runID)
    this.firstEventRuns.delete(runID)
    this.firstTokenRuns.delete(runID)
    this.lastActivityWrites.delete(runID)
    for (const [key, pending] of this.pendingPartUpdates) {
      if (pending.binding.runID === runID) this.pendingPartUpdates.delete(key)
    }
    for (const turnID of turnIDs) {
      if (Array.from(this.bySession.values()).some((binding) => binding.turnID === turnID)) continue
      this.sequence.delete(turnID)
      this.queues.delete(turnID)
      this.failures.delete(turnID)
      this.gaps.delete(turnID)
    }
  }

  private async recordActivity(binding: RunBinding, receivedAt: Date) {
    const previousActivityWrite = this.lastActivityWrites.get(binding.runID) ?? 0
    const firstEvent = !this.firstEventRuns.has(binding.runID)
    if (receivedAt.getTime() - previousActivityWrite >= 5_000) {
      this.lastActivityWrites.set(binding.runID, receivedAt.getTime())
      await this.store.writeRun(
        { _id: binding.runID },
        {
          $set: { lastEventAt: receivedAt, updatedAt: receivedAt },
          ...(firstEvent ? { $min: { firstEventAt: receivedAt } } : {}),
        },
      )
    }
    if (firstEvent) this.firstEventRuns.add(binding.runID)
  }

  private async capture(
    event: GlobalEvent,
    binding: RunBinding,
    ids: { sessionID?: string; parentSessionID?: string },
  ) {
    if (ids.sessionID && !this.bySession.has(ids.sessionID)) {
      this.bySession.set(ids.sessionID, binding)
      registry.assign(ids.sessionID, binding.assignment)
      if (ids.sessionID !== binding.rootSessionID) await this.store.addDescendant(binding.runID, ids.sessionID)
    }
    const receivedAt = new Date()
    const sync = record(event.payload) && event.payload.type === "sync"
    const type = eventType(event)
    if (!sync && type === "message.part.delta") {
      // Deltas are token-sized transport fragments. The corresponding
      // message.part.updated event carries the coalesced part, so persisting
      // every fragment as a raw event, artifact, and normalized event only
      // multiplies storage without adding durable information.
      const firstToken = !this.firstTokenRuns.has(binding.runID)
      const previousActivityWrite = this.lastActivityWrites.get(binding.runID) ?? 0
      if (!firstToken && receivedAt.getTime() - previousActivityWrite < 5_000) return
      this.lastActivityWrites.set(binding.runID, receivedAt.getTime())
      if (firstToken) {
        this.firstTokenRuns.add(binding.runID)
        this.firstEventRuns.add(binding.runID)
      }
      await this.store.writeRun(
        { _id: binding.runID, ...(firstToken ? { firstTokenAt: { $exists: false } } : {}) },
        {
          $set: {
            ...(firstToken ? { firstTokenAt: receivedAt } : {}),
            lastEventAt: receivedAt,
            updatedAt: receivedAt,
          },
          ...(firstToken ? { $min: { firstEventAt: receivedAt } } : {}),
        },
      )
      return
    }
    await this.recordActivity(binding, receivedAt)
    // Session summary recomputation publishes the complete file patch after each
    // step. Keep it available in the live session, but do not archive the same
    // multi-megabyte snapshot on every intermediate update.
    if (intermediateUserSummary(event)) return
    const durability = durable(event)
    if (sync && durability.durableID && this.normalizedByDurable.has(durability.durableID)) return
    if (sync && durability.durableID) {
      const existing = await this.store.rawEvents.findOne(
        { runID: binding.runID, durableID: durability.durableID },
        { sort: { receiveSequence: -1 }, projection: { normalizedEventID: 1 } },
      )
      if (existing) {
        if (existing.normalizedEventID) {
          this.normalizedByDurable.set(durability.durableID, existing.normalizedEventID)
        }
        return
      }
    }
    const sequence = this.sequence.get(binding.turnID) ?? 0
    const receiveSequence = this.receiveSequence.get(binding.runID) ?? 0
    if (!sync) this.sequence.set(binding.turnID, sequence + 1)
    this.receiveSequence.set(binding.runID, receiveSequence + 1)
    const snapshotKey = !sync ? updatedPartKey(event, binding.runID) : undefined
    const normalizedID = snapshotKey
      ? `event-snapshot|${snapshotKey.length}:${snapshotKey}`
      : `event|${binding.turnID.length}:${binding.turnID}|${sequence}`
    const rawID = snapshotKey
      ? `raw-event-snapshot|${snapshotKey.length}:${snapshotKey}`
      : `raw-event|${binding.runID.length}:${binding.runID}|${receiveSequence}`
    const safeEvent = ArenaPrivacy.event(event)
    const raw = content(safeEvent)
    const artifactID = snapshotKey ? undefined : `${rawID}|payload`
    const artifact = artifactID
      ? await this.store.storeArtifact({
          _id: artifactID,
          runID: binding.runID,
          turnID: binding.turnID,
          kind: "other",
          mimeType: "application/json",
          encoding: "json",
          compression: "none",
          data: raw.bytes,
          createdAt: receivedAt,
        })
      : undefined
    if (!sync && durability.durableID) this.normalizedByDurable.set(durability.durableID, normalizedID)
    const linkedNormalizedID =
      sync && durability.durableID ? this.normalizedByDurable.get(durability.durableID) : normalizedID
    const safe = record(safeEvent) && "payload" in safeEvent ? safeEvent.payload : ArenaPrivacy.event(event.payload)
    const tool = completedTool(event)
    const gap = this.gaps.has(binding.turnID)
    const writes: Promise<unknown>[] = [
      this.store.saveRawEvent({
        _id: rawID,
        turnID: binding.turnID,
        runID: binding.runID,
        rootSessionID: binding.rootSessionID,
        sessionID: ids.sessionID ?? binding.rootSessionID,
        parentSessionID: ids.parentSessionID,
        receiveSequence,
        receivedAt,
        type,
        directory: event.directory,
        workspaceID: event.workspace,
        ...durability,
        classification: sync ? "sync" : "live",
        normalizedEventID: linkedNormalizedID,
        ...(artifactID ? { artifactID } : {}),
        originalSize: artifact?.originalSize ?? raw.bytes.byteLength,
        storedSize: artifact?.storedSize ?? 0,
        contentHash: raw.hash,
        truncated: artifact?.truncated ?? true,
        ...(snapshotKey ? { snapshotKey } : {}),
      }),
    ]
    if (!sync) {
      writes.push(
        this.store.saveEvent({
          _id: normalizedID,
          turnID: binding.turnID,
          runID: binding.runID,
          sessionID: ids.sessionID ?? binding.rootSessionID,
          sequence,
          receivedAt,
          type,
          payload: (record(safe) ? safe : { value: safe }) as Readonly<Record<string, unknown>>,
          redactionVersion: "arena-privacy-v1",
          normalizationVersion: "arena-events-v1",
          coalesced: snapshotKey !== undefined,
          gap,
          ...(snapshotKey ? { snapshotKey, contentHash: raw.hash } : {}),
        }),
      )
    }
    const outcomes = await Promise.allSettled(writes)
    const failed = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (failed.length) throw new AggregateError(failed, "Arena event persistence failed")
    if (!sync && gap) this.gaps.delete(binding.turnID)
    if (tool?.outputPath) {
      const output = await externalToolOutput(tool.outputPath)
      if (output) {
        await this.store.storePreparedArtifact({
          _id: `tool-output|${binding.runID.length}:${binding.runID}|${tool.id.length}:${tool.id}`,
          runID: binding.runID,
          turnID: binding.turnID,
          kind: "tool_output",
          mimeType: "text/plain",
          encoding: "utf8",
          compression: "none",
          ...output,
          createdAt: receivedAt,
        })
      }
    }
    if (tool) {
      const seen = this.tools.get(binding.runID) ?? new Set<string>()
      this.tools.set(binding.runID, seen)
      if (!seen.has(tool.id)) {
        seen.add(tool.id)
        const test = testCommand(tool)
        await this.store.writeRun(
          { _id: binding.runID },
          {
            $inc: { toolCount: 1 },
            $set: { updatedAt: receivedAt },
            ...(test ? { $addToSet: { testCommands: test } } : {}),
          },
        )
      }
    }
  }

  private async drainPendingParts(runID: string) {
    const pending = Array.from(this.pendingPartUpdates.entries()).filter(([, value]) => value.binding.runID === runID)
    for (const [key, value] of pending) {
      this.pendingPartUpdates.delete(key)
      await this.capture(value.event, value.binding, value.ids)
    }
  }
}

export * as ArenaEvents from "./events"
