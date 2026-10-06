import { describe, expect, test } from "bun:test"
import { ARENA_COPY_DEFAULTS, decideIgnoredCopy, isArenaCopyExcluded, resolveArenaCopyPolicy } from "@/arena/copy-policy"

describe("Arena copy policy", () => {
  test("resolves paseo.json-shaped settings and treats zero as the daemon default", () => {
    const policy = resolveArenaCopyPolicy({ worktree: { arenaCopy: { ignoredFileMaxBytes: 0, exclude: ["tmp"] } } })
    expect(policy.ignoredFileMaxBytes).toBe(ARENA_COPY_DEFAULTS.ignoredFileMaxBytes)
    expect(policy.ignoredTotalMaxBytes).toBe(ARENA_COPY_DEFAULTS.ignoredTotalMaxBytes)
    expect(policy.exclude).toContain("tmp")
  })

  test("matches excluded directories and globs", () => {
    const policy = resolveArenaCopyPolicy({ exclude: ["node_modules", "**/*.secret"] })
    expect(isArenaCopyExcluded("node_modules/cache.bin", policy)).toBe(true)
    expect(isArenaCopyExcluded("config.secret", policy)).toBe(true)
    expect(isArenaCopyExcluded("nested/config.secret", policy)).toBe(true)
    expect(isArenaCopyExcluded("src/config.ts", policy)).toBe(false)
  })

  test("records file and aggregate limit decisions", () => {
    const policy = resolveArenaCopyPolicy({ ignoredFileMaxBytes: 10, ignoredTotalMaxBytes: 15 })
    expect(decideIgnoredCopy("small", 10, 0, policy)).toEqual({ state: "copy" })
    expect(decideIgnoredCopy("large", 11, 0, policy)).toEqual({ state: "omit", reason: "ignored_file_too_large" })
    expect(decideIgnoredCopy("over-budget", 6, 10, policy)).toEqual({ state: "omit", reason: "ignored_total_limit" })
  })
})
