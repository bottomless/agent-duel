import {
  MongoClient,
  type Collection,
  type CreateIndexesOptions,
  type Db,
  type FindCursor,
  type IndexSpecification,
  type OptionalUnlessRequiredId,
} from "mongodb"
import type {
  ArenaCollection,
  ArenaCursor,
  ArenaDb,
  ArenaFilter,
  ArenaFindOneAndUpdateOptions,
  ArenaFindOptions,
  ArenaRecord,
  ArenaReplaceOneOptions,
  ArenaUpdate,
  ArenaWriteResult,
} from "./collection"

export type Configuration = {
  readonly uri: string
  readonly database: string
}

export function configuration(env: Readonly<Record<string, string | undefined>> = process.env) {
  const uri = env.OPENCODE_ARENA_MONGODB_URI?.trim()
  if (!uri) return undefined
  return {
    uri,
    database: env.OPENCODE_ARENA_MONGODB_DATABASE?.trim() || "opencode_arena",
  } satisfies Configuration
}

class MongoCursor<T extends ArenaRecord> implements ArenaCursor<T> {
  constructor(private readonly cursor: FindCursor<T>) {}
  sort(sort: Record<string, 1 | -1>) {
    return new MongoCursor(this.cursor.sort(sort))
  }
  limit(count: number) {
    return new MongoCursor(this.cursor.limit(count))
  }
  next() {
    return this.cursor.next()
  }
  toArray() {
    return this.cursor.toArray()
  }
}

class MongoCollection<T extends ArenaRecord> implements ArenaCollection<T> {
  constructor(private readonly collection: Collection<T>) {}
  find(filter: ArenaFilter<T> = {}, options?: ArenaFindOptions) {
    const cursor = this.collection.find<T>(filter, options)
    if (options?.sort) cursor.sort(options.sort)
    return new MongoCursor<T>(cursor)
  }
  findOne(filter: ArenaFilter<T> = {}, options?: ArenaFindOptions) {
    return this.collection.findOne<T>(filter, options)
  }
  findOneAndUpdate(filter: ArenaFilter<T>, update: ArenaUpdate<T>, options?: ArenaFindOneAndUpdateOptions) {
    return this.collection.findOneAndUpdate(filter, update, {
      ...(options ?? {}),
      includeResultMetadata: false,
    }) as Promise<T | null>
  }
  async insertOne(document: T): Promise<ArenaWriteResult> {
    const result = await this.collection.insertOne(document as OptionalUnlessRequiredId<T>)
    return {
      acknowledged: result.acknowledged,
      matchedCount: 0,
      modifiedCount: 0,
      insertedId: String(result.insertedId),
    }
  }
  async replaceOne(filter: ArenaFilter<T>, replacement: T, options?: ArenaReplaceOneOptions) {
    const { _id: _, ...document } = replacement
    const result = await this.collection.replaceOne(filter, document as never, options)
    return {
      acknowledged: result.acknowledged,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      insertedId: result.upsertedId === null ? undefined : String(result.upsertedId),
    }
  }
  async updateOne(filter: ArenaFilter<T>, update: ArenaUpdate<T>) {
    const result = await this.collection.updateOne(filter, update)
    return { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }
  }
  async updateMany(filter: ArenaFilter<T>, update: ArenaUpdate<T>) {
    const result = await this.collection.updateMany(filter, update)
    return { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }
  }
  async deleteOne(filter: ArenaFilter<T>) {
    const result = await this.collection.deleteOne(filter)
    return { acknowledged: result.acknowledged, matchedCount: 0, modifiedCount: 0, deletedCount: result.deletedCount }
  }
  async deleteMany(filter: ArenaFilter<T>) {
    const result = await this.collection.deleteMany(filter)
    return { acknowledged: result.acknowledged, matchedCount: 0, modifiedCount: 0, deletedCount: result.deletedCount }
  }
  createIndex(index: IndexSpecification, options?: CreateIndexesOptions) {
    return this.collection.createIndex(index, options)
  }
  async dropIndex(name: string) {
    await this.collection.dropIndex(name)
  }
}

export class MongoDb implements ArenaDb {
  constructor(private readonly db: Db) {}
  command(command: Record<string, unknown>) {
    return this.db.command(command)
  }
  collection<T extends ArenaRecord>(name: string) {
    return new MongoCollection<T>(this.db.collection<T>(name))
  }
}

/** A plain MongoDB connection: no Arena collections, indexes or migrations. */
export async function connectMongoDb(input: Configuration) {
  const client = new MongoClient(input.uri)
  await client.connect()
  return { client, db: new MongoDb(client.db(input.database)) }
}
