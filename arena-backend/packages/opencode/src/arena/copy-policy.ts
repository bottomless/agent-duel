/** The limits applied to ignored content while preparing an Arena contestant. */
export type ArenaCopyPolicy = {
  readonly ignoredFileMaxBytes?: number
  readonly ignoredTotalMaxBytes?: number
  readonly exclude?: readonly string[]
}

export type ResolvedArenaCopyPolicy = {
  readonly ignoredFileMaxBytes: number
  readonly ignoredTotalMaxBytes: number
  readonly exclude: readonly string[]
}

/**
 * These defaults are deliberately finite. A zero in paseo.json means “use this
 * daemon default”, rather than disabling the guard. Keep these values in the
 * snapshot record so old omission decisions remain explainable.
 *
 * The byte limits only apply where the checkout cannot be cloned copy-on-write. A clone
 * shares blocks with its source, so it costs no disk however large the tree is, and
 * measuring a tree to enforce a limit would mean walking the very files the clone was
 * chosen to avoid touching.
 */
export const ARENA_COPY_DEFAULTS: ResolvedArenaCopyPolicy = {
  ignoredFileMaxBytes: 64 * 1024 * 1024,
  ignoredTotalMaxBytes: 512 * 1024 * 1024,
  exclude: [],
}

export type CopyOmissionReason =
  | "changed_during_snapshot"
  | "copy_failed"
  | "excluded"
  | "git_admin"
  | "ignored_file_too_large"
  | "ignored_total_limit"
  | "nested_worktree"
  | "outside_root"
  | "special_file"

export type IgnoredCopyDecision =
  | { readonly state: "copy" }
  | { readonly state: "omit"; readonly reason: CopyOmissionReason }

type RawArenaCopy = Partial<ArenaCopyPolicy> | undefined

function finiteLimit(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback
  return value === 0 ? fallback : Math.floor(value)
}

function normalizeExclude(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean)
}

/** Resolve either the arenaCopy object or a complete paseo.json-shaped value. */
export function resolveArenaCopyPolicy(value?: unknown, defaults: ResolvedArenaCopyPolicy = ARENA_COPY_DEFAULTS) {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  const raw =
    object && "worktree" in object ? (object.worktree as Record<string, unknown> | undefined)?.arenaCopy : value
  const config = raw && typeof raw === "object" ? (raw as RawArenaCopy) : undefined
  return {
    ignoredFileMaxBytes: finiteLimit(config?.ignoredFileMaxBytes, defaults.ignoredFileMaxBytes),
    ignoredTotalMaxBytes: finiteLimit(config?.ignoredTotalMaxBytes, defaults.ignoredTotalMaxBytes),
    exclude: [...defaults.exclude, ...normalizeExclude(config?.exclude)],
  } satisfies ResolvedArenaCopyPolicy
}

function globRegex(pattern: string) {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          // `**/name` includes `name` at the root as well as below folders.
          expression += "(?:.*/)?"
          index += 2
        } else {
          expression += ".*"
          index++
        }
      } else expression += "[^/]*"
    } else if (character === "?") expression += "[^/]"
    else expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`${expression}$`)
}

/** Match exact paths, directory prefixes, and the small glob syntax used by paseo.json. */
export function isArenaCopyExcluded(relativePath: string, policy: ResolvedArenaCopyPolicy) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "")
  return policy.exclude.some((pattern) => {
    if (pattern.includes("*") || pattern.includes("?")) return globRegex(pattern).test(normalized)
    return normalized === pattern || normalized.startsWith(`${pattern}/`)
  })
}

export function decideIgnoredCopy(
  relativePath: string,
  logicalBytes: number,
  copiedIgnoredBytes: number,
  policy: ResolvedArenaCopyPolicy,
): IgnoredCopyDecision {
  if (isArenaCopyExcluded(relativePath, policy)) return { state: "omit", reason: "excluded" }
  if (logicalBytes > policy.ignoredFileMaxBytes) return { state: "omit", reason: "ignored_file_too_large" }
  if (copiedIgnoredBytes + logicalBytes > policy.ignoredTotalMaxBytes) {
    return { state: "omit", reason: "ignored_total_limit" }
  }
  return { state: "copy" }
}

/**
 * A whole ignored tree on the plain-copy path. It has no single-file size, so only the
 * exclude list and the aggregate limit apply.
 */
export function decideIgnoredTreeCopy(
  relativePath: string,
  logicalBytes: number,
  copiedIgnoredBytes: number,
  policy: ResolvedArenaCopyPolicy,
): IgnoredCopyDecision {
  if (isArenaCopyExcluded(relativePath, policy)) return { state: "omit", reason: "excluded" }
  if (copiedIgnoredBytes + logicalBytes > policy.ignoredTotalMaxBytes) {
    return { state: "omit", reason: "ignored_total_limit" }
  }
  return { state: "copy" }
}

export function gitAdministrationPath(relativePath: string) {
  return relativePath === ".git" || relativePath.startsWith(".git/") || relativePath.split("/").includes(".git")
}

export * as ArenaCopyPolicy from "./copy-policy"
