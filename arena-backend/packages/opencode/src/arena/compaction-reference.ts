import { Effect } from "effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { MessageID, type SessionID } from "@/session/schema"
import type { SessionInterface } from "./session-runtime"

/**
 * Since OpenCode 2.1 a summary compaction stores its verbatim tail as `metadata.keepID`, the ID of the
 * message the tail starts at, and history rebuilds the tail by finding that ID in the same session. A
 * missing ID silently drops the tail. Core's fork remaps the reference; any Arena path that copies rows
 * into another session under new IDs has to do the same.
 */
export type KeptReferenceContext = {
  /** Source message ID to the ID of its copy, for every row copied so far. */
  readonly copied: ReadonlyMap<string, string>
  /** Every source message ID, in session order. */
  readonly sourceOrder: readonly string[]
  /**
   * Rows below this ID were not copied: they are the fork of the target's own history the source started
   * from. Core's fork keeps each row's `seq`, so they resolve to the target row at the same `seq`.
   */
  readonly boundary?: string
  readonly sourceSeq?: ReadonlyMap<string, number>
  readonly targetBySeq?: ReadonlyMap<number, string>
}

/** The target ID a copied summary's `keepID` must name, or undefined when it cannot be resolved. */
export function resolveKeptReference(keepID: string, context: KeptReferenceContext): string | undefined {
  const copied = context.copied.get(keepID)
  if (copied !== undefined) return copied
  if (context.boundary !== undefined && keepID < context.boundary) {
    const seq = context.sourceSeq?.get(keepID)
    return seq === undefined ? undefined : context.targetBySeq?.get(seq)
  }
  // A tail can start at a row the copy leaves out, such as a resume note; it then starts at the next copied row.
  const index = context.sourceOrder.indexOf(keepID)
  if (index < 0) return undefined
  for (const id of context.sourceOrder.slice(index + 1)) {
    const next = context.copied.get(id)
    if (next !== undefined) return next
  }
  return undefined
}

/**
 * The message with its summary's `keepID` pointed at the copy. Returns `unresolved` when the message
 * names a tail this context cannot place, so the caller can report it.
 */
export function remapKeptReference(
  message: SessionMessage.Info,
  context: KeptReferenceContext,
): { readonly message: SessionMessage.Info; readonly unresolved?: string } {
  if (message.type !== "compaction") return { message }
  const keepID = message.metadata?.keepID
  if (typeof keepID !== "string") return { message }
  const target = resolveKeptReference(keepID, context)
  if (target === undefined) return { message, unresolved: keepID }
  if (target === keepID) return { message }
  return { message: { ...message, metadata: { ...message.metadata, keepID: target } } }
}

/**
 * Copies `messages` from one session into another under new IDs, in order, carrying each summary's tail
 * reference to its copy. With `boundary`, the target already holds the rows below it (the source was
 * forked from the target), and references into those rows resolve by `seq`. Returns the last copy's ID.
 */
export const copyKeepingReferences = Effect.fn("Arena.copyKeepingReferences")(function* (input: {
  readonly sessions: SessionInterface
  readonly sourceSessionID: SessionID
  readonly targetSessionID: SessionID
  /** Every row of the source session, in order. */
  readonly source: readonly SessionMessage.Info[]
  /** The rows to copy, in order. */
  readonly messages: readonly SessionMessage.Info[]
  readonly boundary?: string
  readonly transform?: (message: SessionMessage.Info) => Effect.Effect<SessionMessage.Info, Error>
  readonly onCopied?: (source: SessionMessage.Info, copy: SessionMessage.Info) => Effect.Effect<void, Error>
}) {
  const copied = new Map<string, string>()
  const seqs =
    input.boundary === undefined
      ? undefined
      : {
          sourceSeq: yield* input.sessions.messageSeqs(input.sourceSessionID),
          targetBySeq: new Map(
            [...(yield* input.sessions.messageSeqs(input.targetSessionID))].map(([id, seq]) => [seq, id] as const),
          ),
        }
  const context: KeptReferenceContext = {
    copied,
    sourceOrder: input.source.map((message) => String(message.id)),
    ...(input.boundary === undefined ? {} : { boundary: input.boundary }),
    ...seqs,
  }
  let last: MessageID | undefined
  for (const message of input.messages) {
    const id = MessageID.ascending()
    const copy = yield* input.sessions.copyMessage({
      sourceSessionID: input.sourceSessionID,
      sourceMessageID: MessageID.make(String(message.id)),
      targetSessionID: input.targetSessionID,
      targetMessageID: id,
      transform: (native) =>
        Effect.gen(function* () {
          const transformed = input.transform ? yield* input.transform(native) : native
          const remapped = remapKeptReference(transformed, context)
          if (remapped.unresolved)
            yield* Effect.logWarning("Arena could not carry a summary's kept tail into the copied session", {
              sourceSessionID: input.sourceSessionID,
              keepID: remapped.unresolved,
            })
          return remapped.message
        }),
    })
    copied.set(String(message.id), String(copy.id))
    last = id
    if (input.onCopied) yield* input.onCopied(message, copy)
  }
  return last
})
