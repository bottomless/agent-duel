import type { SQLQueryBindings } from "bun:sqlite"

export interface SqlPredicate {
  sql: string
  parameters: SQLQueryBindings[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function jsonPath(field: string) {
  return `$.${field
    .split(".")
    .map((part) => JSON.stringify(part))
    .join(".")}`
}

export function fieldExpression(field: string) {
  return field === "_id" ? "id" : `json_extract(document, ${literal(jsonPath(field))})`
}

function fieldType(field: string) {
  return field === "_id" ? "'text'" : `json_type(document, ${literal(jsonPath(field))})`
}

function parameter(value: unknown): SQLQueryBindings {
  if (value === null || typeof value === "string" || typeof value === "number") return value
  if (typeof value === "boolean") return Number(value)
  if (value instanceof Date) return JSON.stringify({ __arena_value_type: "date", value: value.toISOString() })
  if (Array.isArray(value) || record(value)) return JSON.stringify(value)
  throw new Error("Unsupported SQLite query value")
}

function combine(predicates: SqlPredicate[], operation: "AND" | "OR"): SqlPredicate {
  if (predicates.length === 0) return { sql: operation === "AND" ? "1" : "0", parameters: [] }
  return {
    sql: `(${predicates.map((predicate) => predicate.sql).join(` ${operation} `)})`,
    parameters: predicates.flatMap((predicate) => predicate.parameters),
  }
}

const scalarFields = new Set([
  "_id",
  "chatID",
  "turnID",
  "runID",
  "rootSessionID",
  "sessionID",
  "canonicalSessionID",
  "sourceCanonicalSessionID",
  "userId",
  "state",
  "status",
  "type",
  "side",
  "requestID",
  "messageID",
  "providerGenerationID",
  "durableID",
])

function equal(field: string, value: unknown): SqlPredicate {
  const expression = fieldExpression(field)
  if (value === undefined) return { sql: `${fieldType(field)} IS NULL`, parameters: [] }
  if (value === null) return { sql: `${expression} IS NULL`, parameters: [] }
  const direct = { sql: `${expression} = ?`, parameters: [parameter(value)] }
  if (scalarFields.has(field) || Array.isArray(value) || record(value) || value instanceof Date) return direct
  const item = `EXISTS (SELECT 1 FROM json_each(${expression}) WHERE value = ?)`
  return {
    sql: `(${direct.sql} OR (${fieldType(field)} = 'array' AND ${item}))`,
    parameters: [...direct.parameters, parameter(value)],
  }
}

function negate(predicate: SqlPredicate): SqlPredicate {
  return { sql: `NOT COALESCE((${predicate.sql}), 0)`, parameters: predicate.parameters }
}

function ordered(field: string, operator: string, value: unknown): SqlPredicate {
  const expression =
    value instanceof Date ? `json_extract(document, ${literal(`${jsonPath(field)}.value`)})` : fieldExpression(field)
  return {
    sql: `${expression} ${operator} ?`,
    parameters: [value instanceof Date ? value.toISOString() : parameter(value)],
  }
}

function condition(field: string, expected: unknown): SqlPredicate {
  if (!record(expected) || !Object.keys(expected).some((key) => key.startsWith("$"))) return equal(field, expected)
  const predicates = Object.entries(expected).map(([operator, operand]): SqlPredicate => {
    if (operator === "$exists") return { sql: `${fieldType(field)} IS ${operand ? "NOT " : ""}NULL`, parameters: [] }
    if (operator === "$eq") return equal(field, operand)
    if (operator === "$ne") return negate(equal(field, operand))
    if (operator === "$not") return negate(condition(field, operand))
    if (operator === "$gt") return ordered(field, ">", operand)
    if (operator === "$gte") return ordered(field, ">=", operand)
    if (operator === "$lt") return ordered(field, "<", operand)
    if (operator === "$lte") return ordered(field, "<=", operand)
    if (operator === "$in" || operator === "$nin") {
      if (!Array.isArray(operand)) throw new Error(`${operator} requires an array`)
      const selected = combine(
        operand.map((item) => equal(field, item)),
        "OR",
      )
      return operator === "$nin" ? negate(selected) : selected
    }
    if (operator === "$all") {
      if (!Array.isArray(operand)) throw new Error("$all requires an array")
      const members = operand.map((item) => ({
        sql: `EXISTS (SELECT 1 FROM json_each(${fieldExpression(field)}) WHERE value = ?)`,
        parameters: [parameter(item)],
      }))
      return combine([{ sql: `${fieldType(field)} = 'array'`, parameters: [] }, ...members], "AND")
    }
    if (operator === "$type") {
      if (operand === "string") return { sql: `${fieldType(field)} = 'text'`, parameters: [] }
      if (operand === "number") return { sql: `${fieldType(field)} IN ('integer', 'real')`, parameters: [] }
      if (operand === "array" || operand === "object") return { sql: `${fieldType(field)} = ?`, parameters: [operand] }
      throw new Error(`Unsupported SQLite query type: ${String(operand)}`)
    }
    throw new Error(`Unsupported SQLite query operator: ${operator}`)
  })
  return combine(predicates, "AND")
}

export function compileFilter(filter: Record<string, unknown>): SqlPredicate {
  const predicates = Object.entries(filter).map(([field, value]): SqlPredicate => {
    if (field === "$or" || field === "$and") {
      if (!Array.isArray(value) || !value.every(record)) throw new Error(`${field} requires an array of filters`)
      return combine(value.map(compileFilter), field === "$or" ? "OR" : "AND")
    }
    if (field.startsWith("$")) throw new Error(`Unsupported SQLite filter: ${field}`)
    return condition(field, value)
  })
  return combine(predicates, "AND")
}
