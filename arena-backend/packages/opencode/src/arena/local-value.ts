const marker = "__arena_value_type"

export function encode(value: unknown): unknown {
  if (value instanceof Date) return { [marker]: "date", value: value.toISOString() }
  if (value instanceof Uint8Array) return { [marker]: "bytes", value: Buffer.from(value).toString("base64") }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
  }
  return value
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record[marker] === "date" && typeof record.value === "string") return new Date(record.value)
    if (record[marker] === "bytes" && typeof record.value === "string") return Buffer.from(record.value, "base64")
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, decode(child)]))
  }
  return value
}
