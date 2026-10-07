import type { ArenaHistoryItem, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineCursorState } from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { isResolvingBattleState } from "./battle-result";

export function isArenaBattleUnresolved(snapshot: ArenaSnapshot | undefined): boolean {
  return snapshot?.chat.status === "battle_active" && snapshot.turn?.resolution === undefined;
}

/**
 * Whether the battle panes still own the live area.
 *
 * Not the same question as whether the vote has landed. Unmounting on the resolution left a
 * gap: the winner's work is not in the chat until the graft, and the winner's environment is
 * not reported until the retained winner is recorded after it, so the panes went and nothing
 * replaced them for a second or more. They stay until `complete`, which is the first moment
 * both of their replacements exist.
 */
export function isArenaBattleOnScreen(snapshot: ArenaSnapshot | undefined): boolean {
  if (snapshot?.chat.status !== "battle_active") return false;
  if (snapshot.turn?.resolution === undefined) return true;
  return isResolvingBattleState(snapshot.turn.state);
}

interface ArenaPromptTimelineItem extends Pick<StreamItem, "id" | "kind"> {
  messageId?: string;
}

interface PendingArenaPromptInput {
  snapshot: ArenaSnapshot | undefined;
  streamItems: readonly ArenaPromptTimelineItem[];
  pendingTurnId: string | null;
  timelineRange?: Pick<AgentTimelineCursorState, "epoch" | "startSeq">;
  promptIndex?: Pick<AgentTimelinePromptIndexPayload, "epoch" | "prompts">;
}

/** Keep only a live battle's prompt through the handoff to its canonical row. */
export function pendingArenaPrompt({
  snapshot,
  streamItems,
  pendingTurnId,
  timelineRange,
  promptIndex,
}: PendingArenaPromptInput): ArenaSnapshot["turn"] | null {
  const turn = snapshot?.turn;
  if (!turn) return null;
  if (isArenaBattleOnScreen(snapshot)) return turn;
  const awaitingCanonicalPrompt =
    turn.state === "complete" && turn.id === pendingTurnId && turn.canonicalUserMessageID;
  if (!awaitingCanonicalPrompt) return null;
  const canonicalPromptPresent = streamItems.some(
    (item) =>
      item.kind === "user_message" &&
      (item.messageId === turn.canonicalUserMessageID || item.id === turn.canonicalUserMessageID),
  );
  // A reconnect can load only the tail of the winner. Match identity and epoch,
  // rather than mistaking a later message for evidence that this prompt was loaded.
  const indexedPrompt = promptIndex?.prompts.find(
    (prompt) => prompt.messageId === turn.canonicalUserMessageID,
  );
  const promptBeforeLoadedPage =
    timelineRange &&
    promptIndex?.epoch === timelineRange.epoch &&
    indexedPrompt &&
    indexedPrompt.seq < timelineRange.startSeq;
  return canonicalPromptPresent || promptBeforeLoadedPage ? null : turn;
}

/** A presentation-only row: never put this projection back into the session store. */
export function projectPendingArenaPrompt(
  tail: StreamItem[],
  turn: ArenaSnapshot["turn"] | null,
): StreamItem[] {
  if (!turn || turn.state !== "complete") return tail;
  const timestamp = new Date(turn.createdAt);
  const prompt = createUserMessage({
    id: `arena-prompt:${turn.id}`,
    text: turn.prompt,
    timestamp,
  });
  // Assistant timestamps can refresh during replay. Use the next user prompt as
  // the boundary so the previous answer stays with its original turn.
  const nextItem = tail.findIndex(
    (item) => item.kind === "user_message" && item.timestamp > timestamp,
  );
  const index = nextItem < 0 ? tail.length : nextItem;
  return [...tail.slice(0, index), prompt, ...tail.slice(index)];
}

export function arenaSummaryAnchor(
  item: ArenaHistoryItem,
  streamItems: ReadonlyArray<{
    id: string;
    kind: string;
    messageId?: string;
  }>,
): string | null {
  if (!item.canonicalUserMessageID) return null;
  const userIndex = streamItems.findIndex(
    (streamItem) =>
      streamItem.kind === "user_message" &&
      (streamItem.messageId === item.canonicalUserMessageID ||
        streamItem.id === item.canonicalUserMessageID),
  );
  if (userIndex < 0) return null;
  const nextUserOffset = streamItems
    .slice(userIndex + 1)
    .findIndex((streamItem) => streamItem.kind === "user_message");
  const endIndex = nextUserOffset < 0 ? streamItems.length - 1 : userIndex + nextUserOffset;
  return streamItems[endIndex]?.id ?? null;
}

export function partitionArenaSummaries(
  history: readonly ArenaHistoryItem[],
  battleIsActive: boolean,
): {
  inline: readonly ArenaHistoryItem[];
  live: ArenaHistoryItem | null;
} {
  // Recording the vote reveals identities before application and transcript grafting finish.
  // That turn still belongs to the live battle, even if its history anchor already exists.
  const resolved = history.filter(
    (item) => item.resolution && item.identities && !isResolvingBattleState(item.state),
  );
  if (battleIsActive || resolved.length === 0) {
    return { inline: resolved, live: null };
  }
  return {
    inline: resolved.slice(0, -1),
    live: resolved.at(-1) ?? null,
  };
}
