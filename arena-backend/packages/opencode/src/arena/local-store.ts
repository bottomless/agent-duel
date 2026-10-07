import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { compileFilter, fieldExpression } from "./sqlite-query"
import type { CreateIndexesOptions, IndexSpecification } from "mongodb"
import type {
  ArenaClient,
  ArenaCollection,
  ArenaCursor,
  ArenaDb,
  ArenaFindOptions,
  ArenaFindOneAndUpdateOptions,
  ArenaMutation,
  ArenaRecord,
  ArenaReplaceOneOptions,
  ArenaWriteResult,
} from "@agent-duel/arena-service/collection"
import { Store } from "./mongo"

const marker = "__arena_value_type"
const blindedTelemetryPrivacyKey = "privacy.blinded-generation-telemetry"
const blindedTelemetryPendingKey = "privacy.blinded-generation-telemetry-pending"
const blindedTelemetryPrivacyVersion = "4"
/**
 * A file this recent may belong to a record another handle on the same directory has not inserted
 * yet: `artifact` writes the file before the record that names it.
 */
const ARTIFACT_RECLAIM_GRACE_MS = 10 * 60_000
/** Set when artifact records are deleted, so a start looks for unshared files only after that. */
const artifactReclaimKey = "artifacts.reclaim"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function quote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

export class ArenaDuplicateError extends Error {
  readonly code = "ARENA_DUPLICATE"
}

function encode(value: unknown): unknown {
  if (value instanceof Date) return { [marker]: "date", value: value.toISOString() }
  if (value instanceof Uint8Array) return { [marker]: "bytes", value: Buffer.from(value).toString("base64") }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
  }
  return value
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record[marker] === "date" && typeof record.value === "string") return new Date(record.value)
    if (record[marker] === "bytes" && typeof record.value === "string") return Buffer.from(record.value, "base64")
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decode(child)]))
  }
  return value
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return decode(JSON.parse(JSON.stringify(encode(value)))) as T
}

function at(value: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[part]
  }, value)
}

function equal(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.from(left).equals(Buffer.from(right))
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((x, i) => equal(x, right[i]))
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = Object.keys(left as object)
    const b = Object.keys(right as object)
    return (
      a.length === b.length &&
      a.every((key) => equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
    )
  }
  return Object.is(left, right)
}

function documents(database: Database, collection: string) {
  return database
    .query<{ id: string; document: string }, [string]>(
      "SELECT id, document FROM arena_documents WHERE collection = ?",
    )
    .all(collection)
    .map((row) => ({ id: row.id, document: decode(JSON.parse(row.document)) as Record<string, unknown> }))
}

async function removeUnreferencedArtifactFiles(database: Database, paths: readonly string[]) {
  const live = new Set(
    documents(database, "artifacts")
      .map(({ document }) => document.artifactPath)
      .filter((value): value is string => typeof value === "string"),
  )
  for (const artifactPath of new Set(paths)) {
    if (!live.has(artifactPath)) await rm(artifactPath, { force: true })
  }
}

/**
 * Delete the artifact files no record names. Deleting an artifact record leaves its file, because
 * files are content-addressed and another record can share it; this is where the unshared ones go.
 * Compared by name, the content hash, so a moved data directory does not orphan every file.
 */
export async function reclaimArtifactFiles(
  database: Database,
  artifactsRoot: string,
  now = Date.now(),
): Promise<{ readonly removed: number; readonly deferred: number }> {
  const referenced = new Set(
    database
      .query<{ artifactPath: string | null }, []>(
        "SELECT json_extract(document, '$.artifactPath') AS artifactPath FROM arena_documents WHERE collection = 'artifacts'",
      )
      .all()
      .flatMap((row) => (row.artifactPath ? [path.basename(row.artifactPath)] : [])),
  )
  let removed = 0
  let deferred = 0
  for (const name of await readdir(artifactsRoot).catch(() => [] as string[])) {
    if (referenced.has(name)) continue
    const file = path.join(artifactsRoot, name)
    const modified = await stat(file).then(
      (info) => (info.isFile() ? info.mtimeMs : undefined),
      () => undefined,
    )
    if (modified === undefined) continue
    if (now - modified < ARTIFACT_RECLAIM_GRACE_MS) {
      deferred += 1
      continue
    }
    await rm(file, { force: true })
    removed += 1
  }
  return { removed, deferred }
}

/**
 * Reclaim at a start when records were deleted since the last complete pass, or when no pass has
 * run yet. Before the store opens, so nothing in this process writes a file while it looks.
 */
async function reclaimArtifactFilesIfPending(database: Database, artifactsRoot: string) {
  const state = database
    .query<{ value: string }, [string]>("SELECT value FROM arena_metadata WHERE key = ?")
    .get(artifactReclaimKey)?.value
  if (state === "done") return
  const { deferred } = await reclaimArtifactFiles(database, artifactsRoot)
  // A file inside the grace period may still be orphaned; the next start looks again.
  if (deferred > 0) return
  database.query("INSERT OR REPLACE INTO arena_metadata (key, value) VALUES (?, 'done')").run(artifactReclaimKey)
}

/** Remove legacy per-side telemetry that can fingerprint a contestant before a vote. */
async function scrubLegacyBlindedTelemetry(database: Database) {
  const version = database
    .query<{ value: string }, [string]>("SELECT value FROM arena_metadata WHERE key = ?")
    .get(blindedTelemetryPrivacyKey)?.value
  if (version === blindedTelemetryPrivacyVersion) return

  const pending = database
    .query<{ value: string }, [string]>("SELECT value FROM arena_metadata WHERE key = ?")
    .get(blindedTelemetryPendingKey)?.value
  if (pending) {
    await removeUnreferencedArtifactFiles(database, JSON.parse(pending) as string[])
    database.transaction(() => {
      database
        .query("INSERT OR REPLACE INTO arena_metadata (key, value) VALUES (?, ?)")
        .run(blindedTelemetryPrivacyKey, blindedTelemetryPrivacyVersion)
      database.query("DELETE FROM arena_metadata WHERE key = ?").run(blindedTelemetryPendingKey)
    })()
    return
  }

  const unresolvedTurnIDs = new Set(
    documents(database, "turns")
      .filter(({ document }) => document.resolution === undefined)
      .map(({ id }) => id),
  )
  const blindedRuns = documents(database, "runs").filter(({ document }) =>
    unresolvedTurnIDs.has(String(document.turnID)),
  )
  const blindedRunIDs = new Set(blindedRuns.map(({ id }) => id))
  const blindedGenerations = documents(database, "generations").filter(({ document }) =>
    blindedRunIDs.has(String(document.runID)),
  )
  const generationArtifactIDs = new Set(
    blindedGenerations
      .flatMap(({ document }) => [document.requestArtifactID, document.responseArtifactID])
      .filter((value): value is string => typeof value === "string"),
  )
  const generationArtifacts = documents(database, "artifacts").filter(({ id }) => generationArtifactIDs.has(id))
  const artifactPaths = generationArtifacts
    .map(({ document }) => document.artifactPath)
    .filter((value): value is string => typeof value === "string")

  database.transaction(() => {
    for (const { id, document } of blindedRuns) {
      delete document.usage
      database
        .query("UPDATE arena_documents SET document = ? WHERE collection = 'runs' AND id = ?")
        .run(JSON.stringify(encode(document)), id)
    }
    for (const { id, document } of blindedGenerations) {
      delete document.usage
      delete document.finishReason
      delete document.providerGenerationID
      delete document.requestArtifactID
      delete document.responseArtifactID
      if (document.error !== undefined) document.error = "Arena contestant request failed"
      delete document.payloadHashes
      if (record(document.routing) && record(document.routing.headers)) {
        const headers = Object.fromEntries(
          Object.entries(document.routing.headers).filter(([name]) => {
            const normalized = name.toLowerCase()
            return (
              !normalized.includes("model") &&
              !normalized.includes("provider") &&
              !normalized.includes("openrouter") &&
              !normalized.includes("fingerprint")
            )
          }),
        )
        document.routing = { ...document.routing, headers }
      }
      database
        .query("UPDATE arena_documents SET document = ? WHERE collection = 'generations' AND id = ?")
        .run(JSON.stringify(encode(document)), id)
    }
    for (const { id } of generationArtifacts) {
      database.query("DELETE FROM arena_documents WHERE collection = 'artifacts' AND id = ?").run(id)
    }
    for (const turnID of unresolvedTurnIDs) {
      database.query("DELETE FROM arena_documents WHERE collection = 'battleMetrics' AND id = ?").run(turnID)
    }
    database
      .query("INSERT OR REPLACE INTO arena_metadata (key, value) VALUES (?, ?)")
      .run(blindedTelemetryPendingKey, JSON.stringify(artifactPaths))
  })()

  await removeUnreferencedArtifactFiles(database, artifactPaths)
  database.transaction(() => {
    database
      .query("INSERT OR REPLACE INTO arena_metadata (key, value) VALUES (?, ?)")
      .run(blindedTelemetryPrivacyKey, blindedTelemetryPrivacyVersion)
    database.query("DELETE FROM arena_metadata WHERE key = ?").run(blindedTelemetryPendingKey)
  })()
}

function compare(left: unknown, right: unknown) {
  if (left instanceof Date) left = left.getTime()
  if (right instanceof Date) right = right.getTime()
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right)
  if (typeof left === "number" && typeof right === "number") return left - right
  return left === right
    ? 0
    : left === undefined
      ? -1
      : right === undefined
        ? 1
        : String(left).localeCompare(String(right))
}

function setAt(target: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".")
  const last = parts.pop()!
  let current = target
  for (const part of parts) {
    const next = current[part]
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[last] = clone(value)
}

function deleteAt(target: Record<string, unknown>, key: string) {
  const parts = key.split(".")
  const last = parts.pop()!
  let current: Record<string, unknown> | undefined = target
  for (const part of parts) {
    const next = current[part]
    if (!next || typeof next !== "object") return
    current = next as Record<string, unknown>
  }
  delete current[last]
}

function updateDocument<T extends ArenaRecord>(document: T, update: Record<string, unknown>, inserting = false): T {
  const result = clone(document)
  const operators = Object.keys(update).filter((key) => key.startsWith("$"))
  if (operators.length === 0) return clone(update as T)
  for (const [operator, value] of Object.entries(update)) {
    const fields = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
    if (operator === "$set" || (operator === "$setOnInsert" && inserting)) {
      for (const [key, child] of Object.entries(fields)) setAt(result as Record<string, unknown>, key, child)
    } else if (operator === "$unset") {
      for (const key of Object.keys(fields)) deleteAt(result as Record<string, unknown>, key)
    } else if (operator === "$rename") {
      for (const [source, destination] of Object.entries(fields)) {
        if (typeof destination !== "string") throw new Error("$rename requires string destinations")
        if (source === destination) continue
        const child = at(result, source)
        if (child === undefined) continue
        setAt(result as Record<string, unknown>, destination, child)
        deleteAt(result as Record<string, unknown>, source)
      }
    } else if (operator === "$inc") {
      for (const [key, child] of Object.entries(fields))
        setAt(result as Record<string, unknown>, key, ((at(result, key) as number | undefined) ?? 0) + Number(child))
    } else if (operator === "$push" || operator === "$addToSet") {
      for (const [key, child] of Object.entries(fields)) {
        const current = at(result, key)
        if (current !== undefined && !Array.isArray(current)) throw new Error(`${operator} requires an array field`)
        const list = Array.isArray(current) ? [...current] : []
        const values =
          child && typeof child === "object" && "$each" in child ? (child as { $each: unknown[] }).$each : [child]
        if (!Array.isArray(values)) throw new Error(`${operator} $each requires an array`)
        for (const item of values) {
          if (operator === "$push" || !list.some((existing) => equal(existing, item))) list.push(clone(item))
        }
        setAt(result as Record<string, unknown>, key, list)
      }
    } else if (operator === "$pullAll") {
      for (const [key, child] of Object.entries(fields)) {
        const current = at(result, key)
        if (!Array.isArray(child)) throw new Error("$pullAll requires an array")
        if (current === undefined) continue
        if (!Array.isArray(current)) throw new Error("$pullAll requires an array field")
        setAt(
          result as Record<string, unknown>,
          key,
          current.filter((item) => !child.some((candidate) => equal(item, candidate))),
        )
      }
    } else if (operator === "$min" || operator === "$max") {
      for (const [key, child] of Object.entries(fields)) {
        const current = at(result, key)
        const relation = compare(current, child)
        if (current === undefined || (operator === "$min" ? relation > 0 : relation < 0))
          setAt(result as Record<string, unknown>, key, child)
      }
    } else if (operator !== "$setOnInsert") {
      throw new Error(`Unsupported Arena update operator: ${operator}`)
    }
  }
  if (result._id !== document._id) throw new Error("Arena document IDs are immutable")
  return result
}

function project<T extends ArenaRecord>(document: T, options?: ArenaFindOptions): T {
  const projection = options?.projection
  if (!projection) return clone(document)
  const entries = Object.entries(projection)
  const include = entries.some(([, value]) => value === 1)
  if (!include) {
    const result = clone(document) as Record<string, unknown>
    for (const [key, value] of entries) if (value === 0) deleteAt(result, key)
    return result as T
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const child = at(document, key)
    if (value === 1 && child !== undefined) setAt(result, key, child)
  }
  if (projection._id !== 0) result._id = document._id
  return result as T
}

interface LocalReadOptions extends ArenaFindOptions {
  sort?: Record<string, 1 | -1>
  limit?: number
  offset?: number
}

class LocalCursor<T extends ArenaRecord> implements ArenaCursor<T> {
  private readonly options: LocalReadOptions
  private offset = 0
  private done = false

  constructor(
    private readonly owner: LocalDatabase,
    private readonly name: string,
    private readonly filter: Record<string, unknown>,
    options?: ArenaFindOptions,
  ) {
    this.options = { ...options }
  }

  sort(sort: Record<string, 1 | -1>) {
    this.options.sort = sort
    return this
  }

  limit(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Arena cursor limit")
    this.options.limit = count || undefined
    return this
  }

  private async materialize(value: ArenaRecord): Promise<T> {
    const projection = this.options.projection
    const includes = projection && Object.values(projection).some((value) => value === 1)
    const includeData = !projection || (includes ? projection.data === 1 : projection.data !== 0)
    const document = this.name === "artifacts" && includeData ? await this.owner.hydrate(value) : value
    return project(document, this.options) as T
  }

  async next() {
    if (this.done) return null
    const reachedLimit = this.options.limit !== undefined && this.offset >= this.options.limit
    if (reachedLimit) return null
    const [value] = this.owner.rows(this.name, this.filter, { ...this.options, limit: 1, offset: this.offset })
    if (!value) {
      this.done = true
      return null
    }
    this.offset += 1
    return this.materialize(value)
  }

  async toArray() {
    if (this.done) return []
    const limit = this.options.limit === undefined ? undefined : this.options.limit - this.offset
    if (limit === 0) return []
    const values = this.owner.rows(this.name, this.filter, { ...this.options, limit, offset: this.offset })
    this.done = true
    return Promise.all(values.map((value) => this.materialize(value)))
  }
}

class LocalDatabase implements ArenaDb, ArenaClient {
  readonly sourceID: string
  readonly artifactsRoot: string
  private readonly collections = new Map<string, ArenaCollection<ArenaRecord>>()
  private pendingMutations?: ArenaMutation[]
  private readonly collectionVersions = new Map<string, number>()

  constructor(
    readonly database: Database,
    readonly directory: string,
    private readonly onMutation?: (mutation: ArenaMutation) => void | Promise<void>,
    private readonly onClose?: () => void | Promise<void>,
  ) {
    database.query("INSERT OR IGNORE INTO arena_metadata (key, value) VALUES ('sourceID', ?)").run(randomUUID())
    database.query("INSERT OR IGNORE INTO arena_metadata (key, value) VALUES ('revision', '0')").run()
    const row = database.query<{ value: string }, []>("SELECT value FROM arena_metadata WHERE key = 'sourceID'").get()
    if (!row) throw new Error("Arena database identity is missing")
    this.sourceID = row.value
    this.artifactsRoot = path.join(directory, "artifacts", "sha256")
  }
  cacheVersion(collection: string) {
    // data_version changes for commits from other SQLite connections, including recovery tools.
    const external = this.database.query<{ data_version: number }, []>("PRAGMA data_version").get()
    return `${external?.data_version}:${this.collectionVersions.get(collection) ?? 0}`
  }
  command(command: Record<string, unknown>) {
    if (command.ping === 1) return Promise.resolve({ ok: 1 })
    throw new Error("Unsupported local Arena database command")
  }
  collection<T extends ArenaRecord>(name: string) {
    const existing = this.collections.get(name)
    if (existing) return existing as ArenaCollection<T>
    const created = new LocalCollection<T>(this, name)
    this.collections.set(name, created as ArenaCollection<ArenaRecord>)
    return created
  }
  run<T>(callback: () => T): T {
    const previous = this.pendingMutations
    const mutations: ArenaMutation[] = []
    this.pendingMutations = mutations
    let result: T
    try {
      result = this.database.transaction(callback).immediate()
    } catch (error) {
      this.pendingMutations = previous
      throw error
    }
    this.pendingMutations = previous
    if (previous) previous.push(...mutations)
    else for (const mutation of mutations) this.dispatch(mutation)
    return result
  }
  rows(name: string, filter: Record<string, unknown>, options: LocalReadOptions = {}) {
    const predicate = compileFilter(filter)
    const parameters: SQLQueryBindings[] = [name, ...predicate.parameters]
    const ordering = Object.entries(options.sort ?? {}).map(
      ([field, direction]) => `${fieldExpression(field)} ${direction === 1 ? "ASC" : "DESC"}`,
    )
    const order = ordering.length ? ` ORDER BY ${ordering.join(", ")}` : ""
    const limit = options.limit === undefined ? -1 : options.limit
    const rows = this.database
      .query<
        { document: string },
        SQLQueryBindings[]
      >(`SELECT document FROM arena_documents WHERE collection = ? AND ${predicate.sql}${order} LIMIT ? OFFSET ?`)
      .all(...parameters, limit, options.offset ?? 0)
    return rows.map((row) => decode(JSON.parse(row.document)) as ArenaRecord)
  }

  row(name: string, id: string) {
    const result = this.database
      .query<
        { document: string },
        [string, string]
      >("SELECT document FROM arena_documents WHERE collection = ?1 AND id = ?2")
      .get(name, id)
    return result?.document ? (decode(JSON.parse(result.document)) as ArenaRecord) : undefined
  }
  save(name: string, document: ArenaRecord, artifactPath?: string) {
    const stored = artifactPath ? { ...document, data: undefined, artifactPath } : document
    const encoded = JSON.stringify(encode(stored))
    this.database
      .query(
        "INSERT INTO arena_documents (collection, id, document) VALUES (?1, ?2, ?3) ON CONFLICT(collection, id) DO UPDATE SET document = excluded.document",
      )
      .run(name, document._id, encoded)
  }
  insert(name: string, document: ArenaRecord, artifactPath?: string) {
    const stored = artifactPath ? { ...document, data: undefined, artifactPath } : document
    this.database
      .query("INSERT INTO arena_documents (collection, id, document) VALUES (?1, ?2, ?3)")
      .run(name, document._id, JSON.stringify(encode(stored)))
  }
  remove(name: string, id: string) {
    this.database.query("DELETE FROM arena_documents WHERE collection = ?1 AND id = ?2").run(name, id)
  }
  mutation(name: string, id: string, document: Record<string, unknown> | null) {
    const row = this.database
      .query("UPDATE arena_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision' RETURNING value")
      .get() as { value: string }
    const mutation = {
      collection: name,
      id,
      revision: Number(row.value),
      document: document ? (clone(document) as Record<string, unknown>) : null,
    }
    if (this.pendingMutations) {
      this.pendingMutations.push(mutation)
      return
    }
    this.dispatch(mutation)
  }
  private dispatch(mutation: ArenaMutation) {
    this.collectionVersions.set(mutation.collection, mutation.revision)
    try {
      const result = this.onMutation?.(mutation)
      if (result && typeof (result as Promise<void>).catch === "function")
        void (result as Promise<void>).catch((error) => console.warn("[arena] local mutation callback failed", error))
    } catch (error) {
      console.warn("[arena] local mutation callback failed", error)
    }
  }
  async artifact(document: ArenaRecord & { readonly data?: Uint8Array }) {
    if (!document.data) return undefined
    const bytes = Buffer.from(document.data)
    const hash = createHash("sha256").update(bytes).digest("hex")
    await mkdir(this.artifactsRoot, { recursive: true })
    const destination = path.join(this.artifactsRoot, hash)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes)
      const handle = await open(temporary, "r+")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, destination)
      // Windows does not support opening directories for fsync.
      if (process.platform !== "win32") {
        const directoryHandle = await open(this.artifactsRoot, "r")
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error(`Arena artifact write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return destination
  }
  async hydrate<T extends ArenaRecord>(document: T): Promise<T> {
    const artifactPath = at(document, "artifactPath")
    if (typeof artifactPath !== "string") return clone(document)
    const bytes = await readFile(artifactPath)
    const result = clone(document) as Record<string, unknown>
    delete result.artifactPath
    result.data = bytes
    return result as T
  }
  async close() {
    this.database.close()
    await this.onClose?.()
  }
}

class LocalCollection<T extends ArenaRecord> implements ArenaCollection<T> {
  constructor(
    private readonly owner: LocalDatabase,
    private readonly name: string,
  ) {}
  find(filter: Record<string, unknown> = {}, options?: ArenaFindOptions) {
    return new LocalCursor<T>(this.owner, this.name, filter, options)
  }
  findOne(filter: Record<string, unknown> = {}, options?: ArenaFindOptions) {
    return this.find(filter, options).next()
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: ArenaFindOneAndUpdateOptions,
  ) {
    let before: T | undefined
    let after: T | undefined
    this.owner.run(() => {
      before = this.owner.rows(this.name, filter, { limit: 1 })[0] as T | undefined
      if (!before && options?.upsert) {
        const base = {
          ...Object.fromEntries(
            Object.entries(filter).filter(
              ([key, value]) => !key.startsWith("$") && !(value && typeof value === "object"),
            ),
          ),
          _id: String((filter._id as string | undefined) ?? randomUUID()),
        } as T
        after = updateDocument(base, update, true)
        this.owner.insert(this.name, after)
        this.owner.mutation(this.name, after._id, after as Record<string, unknown>)
        return
      }
      if (!before) return
      after = updateDocument(before, update)
      if (!equal(before, after)) {
        this.owner.save(this.name, after)
        this.owner.mutation(this.name, after._id, after as Record<string, unknown>)
      }
    })
    const value = options?.returnDocument === "after" ? after : before
    return value ? (this.name === "artifacts" ? await this.owner.hydrate(value) : clone(value)) : null
  }
  async insertOne(document: T): Promise<ArenaWriteResult> {
    let artifactPath: string | undefined
    if (this.name === "artifacts") artifactPath = await this.owner.artifact(document)
    try {
      this.owner.run(() => {
        this.owner.insert(this.name, document, artifactPath)
        this.owner.mutation(this.name, document._id, document as Record<string, unknown>)
      })
    } catch (error) {
      if (error instanceof ArenaDuplicateError) throw error
      if (error instanceof Error && error.message.toLowerCase().includes("unique constraint")) {
        throw new ArenaDuplicateError(`Duplicate Arena document: ${document._id}`)
      }
      throw error
    }
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, insertedId: document._id }
  }
  async replaceOne(filter: Record<string, unknown>, replacement: T, options?: ArenaReplaceOneOptions) {
    let matchedCount = 0
    let modifiedCount = 0
    let insertedId: string | undefined
    this.owner.run(() => {
      const current = this.owner.rows(this.name, filter, { limit: 1 })[0] as T | undefined
      if (!current) {
        if (!options?.upsert) return
        this.owner.insert(this.name, replacement)
        this.owner.mutation(this.name, replacement._id, replacement as Record<string, unknown>)
        insertedId = replacement._id
        return
      }
      matchedCount = 1
      if (equal(current, replacement)) return
      if (current._id !== replacement._id) throw new Error("Arena replacement document IDs are immutable")
      this.owner.save(this.name, replacement)
      this.owner.mutation(this.name, replacement._id, replacement as Record<string, unknown>)
      modifiedCount = 1
    })
    return { acknowledged: true, matchedCount, modifiedCount, insertedId }
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const result = await this.updateRows(filter, update, true)
    return result
  }
  private async updateRows(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    one = false,
  ): Promise<ArenaWriteResult> {
    let matchedCount = 0
    let modifiedCount = 0
    this.owner.run(() => {
      const rows = this.owner.rows(this.name, filter, one ? { limit: 1 } : undefined)
      for (const row of rows) {
        if (one && matchedCount) break
        matchedCount += 1
        const updated = updateDocument(row, update)
        if (equal(row, updated)) continue
        modifiedCount += 1
        this.owner.save(this.name, updated)
        this.owner.mutation(this.name, updated._id, updated as Record<string, unknown>)
      }
    })
    return { acknowledged: true, matchedCount, modifiedCount }
  }
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    return this.updateRows(filter, update)
  }
  async deleteOne(filter: Record<string, unknown>) {
    return this.deleteRows(filter, true)
  }
  private async deleteRows(filter: Record<string, unknown>, one = false): Promise<ArenaWriteResult> {
    let deletedCount = 0
    this.owner.run(() => {
      const rows = this.owner.rows(this.name, filter, one ? { limit: 1 } : undefined)
      for (const row of rows) {
        if (one && deletedCount) break
        this.owner.remove(this.name, row._id)
        this.owner.mutation(this.name, row._id, null)
        deletedCount += 1
      }
      // The file can be shared, so it stays; the next start reclaims it if nothing names it.
      if (this.name === "artifacts" && deletedCount > 0) {
        this.owner.database
          .query("INSERT OR REPLACE INTO arena_metadata (key, value) VALUES (?, 'pending')")
          .run(artifactReclaimKey)
      }
    })
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, deletedCount }
  }
  deleteMany(filter: Record<string, unknown>) {
    return this.deleteRows(filter)
  }
  createIndex(index: IndexSpecification, options: CreateIndexesOptions = {}) {
    if (!record(index)) throw new Error("Arena indexes must specify their fields")
    const entries = Object.entries(index)
    const keys = entries.map(([field, direction]) => {
      if (direction !== 1 && direction !== -1) throw new Error("Unsupported Arena index ordering")
      return `${fieldExpression(field)} ${direction === 1 ? "ASC" : "DESC"}`
    })
    const name = options.name ?? entries.map(([field, direction]) => `${field}_${direction}`).join("_")
    const nameSQL = identifier(`arena_${this.name}_${name}`)
    const partial = options.partialFilterExpression ? compileFilter(options.partialFilterExpression) : undefined
    let condition = `collection = ${quote(this.name)}`
    if (partial) {
      let offset = 0
      const expression = partial.sql.replaceAll("?", () => {
        const parameter = partial.parameters[offset++]
        if (typeof parameter === "string") return quote(parameter)
        if (typeof parameter === "number") return String(parameter)
        throw new Error("Unsupported Arena partial index value")
      })
      condition += ` AND ${expression}`
    }
    this.owner.database.run(
      `CREATE ${options.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${nameSQL} ON arena_documents(${keys.join(", ")}) WHERE ${condition}`,
    )
    return Promise.resolve(name)
  }
  dropIndex(name: string) {
    this.owner.database.run(`DROP INDEX IF EXISTS ${identifier(`arena_${this.name}_${name}`)}`)
    return Promise.resolve()
  }
}

export type LocalStoreConfiguration = {
  readonly directory: string
  readonly onMutation?: (mutation: ArenaMutation) => void | Promise<void>
  readonly onClose?: () => void | Promise<void>
}

export async function connectLocalStore(
  input: LocalStoreConfiguration,
): Promise<Store & { readonly sourceID: string }> {
  await mkdir(input.directory, { recursive: true })
  const database = new Database(path.join(input.directory, "arena.sqlite"))
  database.run("PRAGMA journal_mode = WAL")
  database.run("PRAGMA synchronous = FULL")
  database.run("PRAGMA busy_timeout = 5000")
  database.run("CREATE TABLE IF NOT EXISTS arena_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  database.run(
    "CREATE TABLE IF NOT EXISTS arena_documents (collection TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(collection, id))",
  )
  database.run("CREATE INDEX IF NOT EXISTS arena_documents_collection ON arena_documents(collection)")
  for (const [name, field] of [
    ["chat", "chatID"],
    ["turn", "turnID"],
    ["run", "runID"],
    ["session", "sessionID"],
    ["canonical_session", "canonicalSessionID"],
    ["source_session", "sourceCanonicalSessionID"],
    ["state", "state"],
    ["status", "status"],
    ["user", "userId"],
  ] as const) {
    database.run(
      `CREATE INDEX IF NOT EXISTS arena_documents_${name} ON arena_documents(collection, json_extract(document, '$."${field}"'))`,
    )
  }
  await scrubLegacyBlindedTelemetry(database)
  await reclaimArtifactFilesIfPending(database, path.join(input.directory, "artifacts", "sha256"))
  const local = new LocalDatabase(database, input.directory, input.onMutation, input.onClose)
  const store = Object.assign(new Store(local, local), { sourceID: local.sourceID })
  try {
    await store.initialize()
  } catch (error) {
    await store.close()
    throw error
  }
  return store
}

export * as ArenaLocalStore from "./local-store"
