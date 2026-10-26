import type { SessionV1 } from "./session-shape"
import { Effect } from "effect"
import path from "path"
import type { Permission } from "@opencode/schema/permission"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, MoveSessionService, Session, SessionID } from "./session-runtime"
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
  /**
   * Keep the fork at its source location until the caller has staged a cold worktree. Core's
   * runner resolves its instance from the persisted session location, so moving a session to a
   * reserved (still empty) path before the first request deadlocks the initial dispatch.
   */
  readonly moveSession?: boolean
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
   * copies retarget ports and preview URLs here so each part is written once.
   */
  readonly part?: (part: SessionV1.Part, info: SessionV1.Info) => SessionV1.Part
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
 * Core's empty-session fork guard means the fallback has to create a native root directly. Keep
 * the projected source fields on that root so location startup and the first runner dispatch see
 * the same agent/model/policy as the canonical session. `SessionV1` permissions use the old wire
 * names; Core stores the equivalent action/resource/effect rules.
 */
const rootFields = (source: SessionV1.SessionInfo) => ({
  title: source.title,
  agent: source.agent,
  model: source.model
    ? {
        providerID: source.model.providerID,
        modelID: source.model.id,
        ...(source.model.variant ? { variant: source.model.variant } : {}),
      }
    : undefined,
  metadata: source.metadata,
  permissions: source.permission?.map(
    (rule) =>
      ({
        action: rule.permission === "external_directory_write" ? "edit" : rule.permission,
        resource: rule.pattern,
        effect: rule.action,
      }) satisfies Permission.Rule,
  ),
})

/**
 * Fork a session into another directory. `Session.fork` copies the transcript as is and
 * `MoveSession` only relocates the session, so the copy still names the source directory in
 * every tool call and message. A model that reads those paths keeps working in the source
 * checkout; rewriting them here is what makes the copy work where it was moved.
 */
export const forkSessionInto = Effect.fn("ArenaFork.forkSessionInto")(function* (input: Input) {
  const sessions = yield* Session
  const mover = yield* MoveSessionService
  const instances = yield* InstanceStore.Service
  const source = yield* sessions.get(input.sessionID)
  let pruneBefore: MessageID | undefined
  const forked = yield* instances.provide(
    { directory: source.directory },
    sessions
      .fork({
        sessionID: input.sessionID,
        ...(input.messageID ? { messageID: input.messageID } : {}),
        onMessageMapping(mapping) {
          if (input.pruneToolOutputBefore) pruneBefore = mapping.get(input.pruneToolOutputBefore)
          input.onMessageMapping?.(mapping)
        },
      })
      .pipe(
        Effect.catchIf(
          (error): error is Error => error.message.includes("Cannot fork empty session"),
          () =>
            sessions.create({
              // Core rejects an empty fork. Contestants must remain native roots;
              // a synthetic canonical parent would consume the default
              // subagent depth before the contestant can delegate.
              ...rootFields(source),
              location: {
                directory: source.directory,
                ...(source.workspaceID ? { workspaceID: source.workspaceID } : {}),
              },
            }),
        ),
      ),
  )
  const roots = input.roots ?? {
    canonical: yield* topLevel(source.directory),
    worktree: yield* topLevel(input.destination),
  }
  if (roots.canonical === roots.worktree && !input.part && !pruneBefore) return forked
  if (input.moveSession !== false)
    yield* mover.moveSession({ sessionID: forked.id, directory: input.destination, moveChanges: false })
  // Core Session.fork already copied complete canonical rows.  Localize those rows in place so
  // provider state, images, compaction metadata, and non-text tool content survive the move.
  const canonicalMessages = yield* sessions.canonicalMessages(forked.id)
  for (const message of canonicalMessages) {
    const localized = localizeEmbeddedPaths(message, roots)
    // A user's prompt is input, not generated transcript text.  Keep its exact bytes while
    // still localizing file attachments and any other embedded paths.
    const transformed = message.type === "user" ? { ...localized, text: message.text } : localized
    yield* sessions.updateCanonicalMessage({ sessionID: forked.id, message: transformed })
  }
  const transcript = yield* sessions.messages({ sessionID: forked.id })
  const prune = pruneBefore
    ? { before: pruneBefore, at: Date.now(), worktree: roots.worktree, uploads: uploadDirectories(transcript) }
    : undefined
  for (const message of transcript) {
    for (const part of message.parts) {
      const localized =
        input.pathMode === "transcript"
          ? yield* Effect.tryPromise({
              try: () => localizeTranscriptPaths(part, roots, message.info.role),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
          : localizeEmbeddedPaths(part, roots)
      const copied = input.part ? input.part(localized, message.info) : localized
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
function uploadDirectories(transcript: readonly import("./session-runtime/schema").WithParts[]) {
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
