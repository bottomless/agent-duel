/** The small persistence port used by the Arena store.  It intentionally
 * models the operations Arena uses instead of making alternate databases
 * implement MongoDB's complete driver API. */
import type { CreateIndexesOptions, Filter, IndexSpecification, UpdateFilter } from "mongodb"

export type ArenaRecord = { readonly _id: string }

export type ArenaFilter<T extends ArenaRecord = ArenaRecord> = Filter<T>
export type ArenaUpdate<T extends ArenaRecord = ArenaRecord> = UpdateFilter<T>

export type ArenaProjection = Record<string, number>
export type ArenaFindOptions = {
  readonly projection?: ArenaProjection
  readonly sort?: Record<string, 1 | -1>
}
export type ArenaFindOneAndUpdateOptions = {
  readonly returnDocument?: "before" | "after"
  readonly upsert?: boolean
}
export type ArenaReplaceOneOptions = {
  readonly upsert?: boolean
}

export type ArenaWriteResult = {
  readonly acknowledged: boolean
  readonly matchedCount: number
  readonly modifiedCount: number
  readonly deletedCount?: number
  readonly insertedId?: string
}

export interface ArenaCursor<T> {
  sort(sort: Record<string, 1 | -1>): ArenaCursor<T>
  limit(count: number): ArenaCursor<T>
  next(): Promise<T | null>
  toArray(): Promise<T[]>
}

export interface ArenaCollection<T extends ArenaRecord> {
  find(filter?: ArenaFilter<T>, options?: ArenaFindOptions): ArenaCursor<T>
  findOne(filter?: ArenaFilter<T>, options?: ArenaFindOptions): Promise<T | null>
  findOneAndUpdate(
    filter: ArenaFilter<T>,
    update: ArenaUpdate<T>,
    options?: ArenaFindOneAndUpdateOptions,
  ): Promise<T | null>
  insertOne(document: T): Promise<ArenaWriteResult>
  replaceOne(filter: ArenaFilter<T>, replacement: T, options?: ArenaReplaceOneOptions): Promise<ArenaWriteResult>
  updateOne(filter: ArenaFilter<T>, update: ArenaUpdate<T>): Promise<ArenaWriteResult>
  updateMany(filter: ArenaFilter<T>, update: ArenaUpdate<T>): Promise<ArenaWriteResult>
  deleteOne(filter: ArenaFilter<T>): Promise<ArenaWriteResult>
  deleteMany(filter: ArenaFilter<T>): Promise<ArenaWriteResult>
  createIndex(index: IndexSpecification, options?: CreateIndexesOptions): Promise<string>
  dropIndex(name: string): Promise<void>
}

export interface ArenaDb {
  /** A local collection version; changes through other connections must invalidate it too. */
  cacheVersion?(collection: string): string
  command(command: Record<string, unknown>): Promise<unknown>
  collection<T extends ArenaRecord>(name: string): ArenaCollection<T>
}

export interface ArenaClient {
  close(): Promise<unknown>
}

export type ArenaMutation = {
  readonly collection: string
  readonly id: string
  readonly revision: number
  readonly document: Record<string, unknown> | null
}

/**
 * A unique-key violation from either store: MongoDB's code 11000 or the local
 * SQLite store's ARENA_DUPLICATE. Checked structurally, because the error may
 * come from another copy of the mongodb driver.
 */
export function isDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  return error.code === 11000 || error.code === "ARENA_DUPLICATE"
}

export * as ArenaCollection from "./collection"
