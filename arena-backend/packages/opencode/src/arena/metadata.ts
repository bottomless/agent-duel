import {
  MAX_METADATA_CHANGES_CHARS,
  MAX_METADATA_INSTRUCTIONS_CHARS,
  type MetadataKind,
} from "@agent-duel/arena-service/metadata"
import { backend } from "./runtime"

export type Request = {
  readonly kind: MetadataKind
  readonly changes: string
  readonly instructions?: string
}

export type Result =
  | { readonly message: string }
  | { readonly title: string; readonly body: string }
  | { readonly branch: string }
  | { readonly title: string }

const truncated = "\n\n... (changes truncated)"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function result(kind: MetadataKind, value: unknown): Result | undefined {
  if (!record(value)) return undefined
  if (kind === "commit_message") {
    return typeof value.message === "string" && value.message ? { message: value.message } : undefined
  }
  if (kind === "branch_name") {
    return typeof value.branch === "string" && value.branch ? { branch: value.branch } : undefined
  }
  if (kind === "chat_title") {
    return typeof value.title === "string" && value.title ? { title: value.title } : undefined
  }
  if (typeof value.title !== "string" || !value.title || typeof value.body !== "string") return undefined
  return { title: value.title, body: value.body }
}

/**
 * Writes a commit message, pull request text, a branch name or a chat title on the comparison's
 * model, through the same backend as the battle routes: the control plane when hosted, the
 * in-process service with the user's key when BYOK. The route caps what it accepts, so the source
 * text is trimmed to fit here.
 */
export async function generate(input: Request, signal?: AbortSignal): Promise<Result> {
  const target = backend()
  if (!target) throw new Error("Arena metadata credentials are unavailable")
  const changes =
    input.changes.length > MAX_METADATA_CHANGES_CHARS
      ? `${input.changes.slice(0, MAX_METADATA_CHANGES_CHARS - truncated.length)}${truncated}`
      : input.changes
  const instructions = input.instructions?.trim().slice(0, MAX_METADATA_INSTRUCTIONS_CHARS)
  const response = await target.fetch(`${target.url}/api/arena/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: input.kind, changes, ...(instructions ? { instructions } : {}) }),
    signal,
  })
  if (!response.ok) throw new Error(`Arena metadata failed with status ${response.status}`)
  const value = result(input.kind, await response.json().catch(() => undefined))
  if (!value) throw new Error("Arena metadata answered without text")
  return value
}

export * as ArenaMetadata from "./metadata"
