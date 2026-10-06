import { describe, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { compileFilter, fieldExpression } from "../../src/arena/sqlite-query"
import type { ArenaFilter } from "@agent-duel/arena-service/collection"

function database() {
  const db = new Database(":memory:")
  db.run("CREATE TABLE arena_documents (collection TEXT, id TEXT, document TEXT, PRIMARY KEY (collection,id))")
  db.run(`CREATE INDEX by_turn ON arena_documents(collection, ${fieldExpression("turnID")})`)
  const insert = db.query("INSERT INTO arena_documents VALUES ('runs', ?, ?)")
  insert.run(
    "a",
    JSON.stringify({
      _id: "a",
      turnID: "turn-1",
      finalizedSides: ["a"],
      state: "running",
      at: { __arena_value_type: "date", value: "2026-09-14T00:00:00.000Z" },
    }),
  )
  insert.run(
    "b",
    JSON.stringify({ _id: "b", turnID: "turn-2", finalizedSides: ["a", "b"], state: "complete", resolution: null }),
  )
  return db
}

function ids(db: Database, filter: ArenaFilter) {
  const predicate = compileFilter(filter)
  return db
    .query<{ id: string }, SQLQueryBindings[]>(
      `SELECT id FROM arena_documents WHERE collection = 'runs' AND ${predicate.sql} ORDER BY id`,
    )
    .all(...predicate.parameters)
    .map((row) => row.id)
}

describe("SQLite Arena queries", () => {
  test("preserves vote guards, missing fields and array membership", () => {
    using db = database()
    expect(ids(db, { finalizedSides: { $all: ["a"], $nin: ["b"] }, resolution: { $exists: false } })).toEqual(["a"])
    expect(ids(db, { resolution: null })).toEqual(["a", "b"])
    expect(ids(db, { resolution: { $exists: true } })).toEqual(["b"])
    expect(ids(db, { $or: [{ turnID: "turn-2" }, { finalizedSides: { $in: ["a"] } }] })).toEqual(["a", "b"])
    expect(ids(db, { state: { $nin: ["running"] } })).toEqual(["b"])
  })

  test("compares stored dates and uses an index for a turn lookup", () => {
    using db = database()
    expect(ids(db, { at: { $gt: new Date("2026-09-13T00:00:00.000Z") } })).toEqual(["a"])
    const predicate = compileFilter({ turnID: "turn-1" })
    const plan = db
      .query<
        { detail: string },
        SQLQueryBindings[]
      >(`EXPLAIN QUERY PLAN SELECT document FROM arena_documents WHERE collection = 'runs' AND ${predicate.sql}`)
      .all(...predicate.parameters)
    expect(plan.some((step) => step.detail.includes("by_turn"))).toBe(true)
    expect(ids(db, { turnID: "turn-1" })).toEqual(["a"])
  })

  test("rejects unsupported operations instead of weakening a write guard", () => {
    expect(() => compileFilter({ state: { $unknown: "complete" } })).toThrow("Unsupported SQLite query operator")
    expect(() => compileFilter({ $unknown: [] })).toThrow("Unsupported SQLite filter")
  })
})
