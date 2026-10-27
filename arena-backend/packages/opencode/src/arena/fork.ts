import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import path from "path"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import type { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { notedUpload } from "./attachments"
import { localizeEmbeddedPaths, localizeTranscriptPaths } from "./canonical-path"

export interface Roots {
  /** The directory the source transcript names. */
  readonly canonical: string
  /** The directory the copy names instead. */
  readonly worktree: string
}

export interface Input {
  readonly sessionID: SessionID
  /** Absolute directory the copy runs in. */
  readonly destination: string
  /** Exclusive boundary, as `Session.fork` takes it. */
  readonly messageID?: MessageID
  readonly onMessageMapping?: (mapping: ReadonlyMap<string, MessageID>) => void
  /**
   * The rewrite maps between these two roots. Defaults to the Git top levels of the source
   * session directory and of the destination, so a session opened in a subdirectory still maps
   * onto the matching subdirectory of the destination worktree.
   */
  readonly roots?: Roots
  /** Battle history keeps prompts and tool output intact while retargeting executable references. */
  readonly pathMode?: "transcript"
  /**
   * Runs on every copied part after its canonical paths point at the destination. Contestant
   * copies retarget ports and preview URLs here so each part is written once. `sourceMessageID`
   * is the message the part was copied from, which says which battle turn wrote it.
   */
  readonly part?: (part: SessionV1.Part, info: SessionV1.Info, sourceMessageID?: string) => SessionV1.Part
  /**
   * Hide the output of tool calls copied from source messages older than this one, when the copy
   * can produce that output again (`recoverable`). Contestant copies set it to the start of the
   * chat's last finished turn: a new turn starts with an empty cache (a new model, a new worktree
   * path), so clearing older output here costs no cache while every request of the turn sends less.
   * The source keeps the output visible.
   */
  readonly pruneToolOutputBefore?: MessageID
}

/**
 * Fork a session into another directory. `Session.fork` copies the transcript as is and
 * `MoveSession` only relocates the session, so the copy still names the source directory in
 * every tool call and message. A model that reads those paths keeps working in the source
 * checkout; rewriting them here is what makes the copy work where it was moved.
 */
export const forkSessionInto = Effect.fn("ArenaFork.forkSessionInto")(function* (input: Input) {
  const sessions = yield* Session.Service
  const mover = yield* MoveSession.Service
  const instances = yield* InstanceStore.Service
  const source = yield* sessions.get(input.sessionID)
  // Copy ID to source ID, so `part` can tell where each copied message came from.
  const sources = new Map<string, string>()
  let pruneBefore: MessageID | undefined
  const forked = yield* instances.provide(
    { directory: source.directory },
    sessions.fork({
      sessionID: input.sessionID,
      ...(input.messageID ? { messageID: input.messageID } : {}),
      onMessageMapping(mapping) {
        mapping.forEach((target, from) => sources.set(target, from))
        if (input.pruneToolOutputBefore) pruneBefore = mapping.get(input.pruneToolOutputBefore)
        input.onMessageMapping?.(mapping)
      },
    }),
  )
  const roots = input.roots ?? {
    canonical: yield* topLevel(source.directory),
    worktree: yield* topLevel(input.destination),
  }
  if (roots.canonical === roots.worktree && !input.part && !pruneBefore) return forked
  yield* mover.moveSession({
    sessionID: forked.id,
    destination: { directory: AbsolutePath.make(input.destination) },
    moveChanges: false,
  })
  const transcript = yield* sessions.messages({ sessionID: forked.id })
  const prune = pruneBefore
    ? { before: pruneBefore, at: Date.now(), worktree: roots.worktree, uploads: uploadDirectories(transcript) }
    : undefined
  for (const message of transcript) {
    yield* sessions.updateMessage(
      input.pathMode === "transcript"
        ? yield* Effect.tryPromise({
            try: () => localizeTranscriptPaths(message.info, roots),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          })
        : localizeEmbeddedPaths(message.info, roots),
    )
    for (const part of message.parts) {
      const localized =
        input.pathMode === "transcript"
          ? yield* Effect.tryPromise({
              try: () => localizeTranscriptPaths(part, roots, message.info.role),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
          : localizeEmbeddedPaths(part, roots)
      const copied = input.part ? input.part(localized, message.info, sources.get(message.info.id)) : localized
      // Copies keep their source's order, so an older copied message has a smaller id.
      yield* sessions.updatePart(prune && message.info.id < prune.before ? pruneToolOutput(copied, prune) : copied)
    }
  }
  return forked
})

/**
 * Marks a finished tool call's output compacted, the way OpenCode's own prune does: the model gets
 * a placeholder instead (`MessageV2.toModelMessages`), and the input stays so it still sees what
 * was done. An interrupted call has no compacted mark, so its partial output becomes the placeholder.
 */
function pruneToolOutput(part: SessionV1.Part, prune: Prune): SessionV1.Part {
  if (part.type !== "tool" || !recoverable(part, prune)) return part
  if (part.state.status === "completed") {
    if (part.state.time.compacted) return part
    return { ...part, state: { ...part.state, time: { ...part.state.time, compacted: prune.at } } }
  }
  if (part.state.status === "error" && typeof part.state.metadata?.output === "string") {
    return { ...part, state: { ...part.state, metadata: { ...part.state.metadata, output: CLEARED } } }
  }
  return part
}

// What `MessageV2.toModelMessages` sends for compacted output.
const CLEARED = "[Old tool result content cleared]"

/**
 * Tools whose output the copy can produce again by repeating the call in its own worktree or on the
 * network. Every other output is kept: a question's output is the only record of the user's answers,
 * a subagent's report cannot be reproduced, a skill is instructions the model was told to follow,
 * and an MCP tool's output is unknown.
 */
const RECOVERABLE_TOOLS = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "lsp",
  "edit",
  "write",
  "apply_patch",
  "webfetch",
  "websearch",
])

type Prune = {
  readonly before: MessageID
  readonly at: number
  readonly worktree: string
  readonly uploads: readonly string[]
}

/**
 * Whether repeating the call gives the copy its output again. A contestant may not reach outside
 * its worktree, and what an earlier turn reached there is gone or closed to it: that turn's
 * uploads, its temp directory. So a call that names an upload, or a path outside the worktree,
 * keeps its output.
 */
function recoverable(part: SessionV1.ToolPart, prune: Prune) {
  if (!RECOVERABLE_TOOLS.has(part.tool)) return false
  const input = part.state.input
  const strings = Object.values(input).filter((value) => typeof value === "string")
  if (strings.some((value) => prune.uploads.some((upload) => value.includes(upload)))) return false
  return [input.filePath, input.path].every(
    (target) => typeof target !== "string" || !path.isAbsolute(target) || inside(prune.worktree, target),
  )
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** The directories of the uploads the transcript's prompts name; each upload has its own. */
function uploadDirectories(transcript: readonly SessionV1.WithParts[]) {
  const uploads = transcript.flatMap((message) =>
    message.info.role === "user"
      ? message.parts.flatMap((part) => {
          const upload = part.type === "text" ? notedUpload(part.text) : undefined
          return upload ? [path.dirname(upload)] : []
        })
      : [],
  )
  return [...new Set(uploads)]
}

// `--show-cdup`, not `--show-toplevel`: the transcript names the directory in the form the session
// was opened with, and `--show-toplevel` resolves symlinks (`/tmp` on macOS), so the rewrite would
// look for a root the transcript never contains. A directory outside any repository is its own root.
const topLevel = Effect.fn("ArenaFork.topLevel")(function* (directory: string) {
  const git = yield* Git.Service
  const result = yield* git.run(["rev-parse", "--show-cdup"], { cwd: directory })
  if (result.exitCode !== 0) return directory
  return path.resolve(directory, result.text().trim() || ".")
})

export * as ArenaFork from "./fork"
