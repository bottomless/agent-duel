import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import path from "path"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import type { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
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
   * copies retarget ports and preview URLs here so each part is written once.
   */
  readonly part?: (part: SessionV1.Part, info: SessionV1.Info) => SessionV1.Part
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
  const forked = yield* instances.provide(
    { directory: source.directory },
    sessions.fork({
      sessionID: input.sessionID,
      ...(input.messageID ? { messageID: input.messageID } : {}),
      ...(input.onMessageMapping ? { onMessageMapping: input.onMessageMapping } : {}),
    }),
  )
  const roots = input.roots ?? {
    canonical: yield* topLevel(source.directory),
    worktree: yield* topLevel(input.destination),
  }
  if (roots.canonical === roots.worktree && !input.part) return forked
  yield* mover.moveSession({
    sessionID: forked.id,
    destination: { directory: AbsolutePath.make(input.destination) },
    moveChanges: false,
  })
  const transcript = yield* sessions.messages({ sessionID: forked.id })
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
      yield* sessions.updatePart(input.part ? input.part(localized, message.info) : localized)
    }
  }
  return forked
})

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
