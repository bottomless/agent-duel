import type { ArenaHistoryItem, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineCursorState } from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { isResolvingBattleState } from "./battle-result";
import { orderArenaChat } from "./chat-order";

export function isArenaBattleUnresolved(snapshot: ArenaSnapshot | undefined): boolean {
  return snapshot?.chat.status === "battle_active" && snapshot.turn?.resolution === undefined;
}

/** The battle that shows its own prompt, while it is on screen. */
export function arenaOnScreenTurnId(snapshot: ArenaSnapshot | undefined): string | null {
  return isArenaBattleOnScreen(snapshot) ? (snapshot?.turn?.id ?? null) : null;
}

/** Whether the chat can take a new battle now: none is on screen and the chat is ready. */
export function arenaChatCanStartBattle(
  snapshot: ArenaSnapshot | undefined,
  battleOnScreen: boolean,
): boolean {
  return !battleOnScreen && snapshot?.chat.status === "ready";
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
  return (
    isResolvingBattleState(snapshot.turn.state) ||
    snapshot.turn.state === "awaiting_stop_resolution"
  );
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

export interface ArenaPresentedStream {
  tail: StreamItem[];
  head: StreamItem[];
}

/** The presentation-only row that stands for a battle's prompt before, or instead of, its graft. */
export function arenaPromptRowId(turnId: string): string {
  return `arena-prompt:${turnId}`;
}

/** A presentation-only row: never put this projection back into the session store. */
export function projectPendingArenaPrompt(
  stream: ArenaPresentedStream,
  turn: ArenaSnapshot["turn"] | null,
): ArenaPresentedStream {
  if (!turn || turn.state !== "complete") return stream;
  return insertPromptRow(stream, turn.id, turn.prompt, new Date(turn.createdAt));
}

/**
 * Discarded turns' prompts, as presentation-only rows. A discard grafts nothing into the session,
 * so without them the chat lost the prompt and the discarded card had no row to sit under.
 * A turn older than the first loaded row waits for its page, rather than landing at its top.
 */
export function projectDiscardedArenaPrompts(
  stream: ArenaPresentedStream,
  history: readonly ArenaHistoryItem[],
  options: { onScreenTurnId: string | null; hasOlderTimeline: boolean },
): ArenaPresentedStream {
  let projected = stream;
  for (const item of history) {
    if (item.prompt === undefined || item.canonicalUserMessageID) continue;
    if (item.id === options.onScreenTurnId) continue;
    const timestamp = new Date(item.createdAt);
    const first = [...projected.tail, ...projected.head][0];
    if (options.hasOlderTimeline && (!first || first.timestamp > timestamp)) continue;
    projected = insertPromptRow(projected, item.id, item.prompt, timestamp);
  }
  return projected;
}

function insertPromptRow(
  stream: ArenaPresentedStream,
  turnId: string,
  text: string,
  timestamp: Date,
): ArenaPresentedStream {
  const prompt = createUserMessage({ id: arenaPromptRowId(turnId), text, timestamp });
  const { tail, head } = stream;
  // Assistant timestamps can refresh during replay. Use the next user prompt as
  // the boundary so the previous answer stays with its original turn.
  const nextItem = [...tail, ...head].findIndex(
    (item) => item.kind === "user_message" && item.timestamp > timestamp,
  );
  const index = nextItem < 0 ? tail.length + head.length : nextItem;
  if (index <= tail.length) {
    return { tail: [...tail.slice(0, index), prompt, ...tail.slice(index)], head };
  }
  // The head can still hold the end of the previous answer: a grafted winner sends no turn
  // completion to move it into the tail. Left in the head, it would draw below the prompt.
  const settled = index - tail.length;
  return { tail: [...tail, ...head.slice(0, settled), prompt], head: head.slice(settled) };
}

interface ArenaAnchorItem {
  id: string;
  kind: string;
  messageId?: string;
}

function isCanonicalPrompt(item: ArenaHistoryItem, streamItem: ArenaAnchorItem): boolean {
  return (
    streamItem.kind === "user_message" &&
    (streamItem.messageId === item.canonicalUserMessageID ||
      streamItem.id === item.canonicalUserMessageID)
  );
}

/**
 * The battle's last prompt in the chat: its own, or the last reply sent inside the battle. Those
 * replies are grafted with the winner as user messages, so the next user message is not where the
 * battle ends. Canonical message IDs ascend, so the battle's prompts are the user messages from its
 * own prompt through the last message the graft copied. A turn grafted before that bound was
 * recorded falls back to its own prompt.
 */
function lastBattlePromptIndex(
  item: ArenaHistoryItem,
  streamItems: ReadonlyArray<ArenaAnchorItem>,
): number {
  const first = item.canonicalUserMessageID;
  // A discarded turn has only its projected prompt (`projectDiscardedArenaPrompts`).
  if (!first)
    return streamItems.findIndex((streamItem) => streamItem.id === arenaPromptRowId(item.id));
  const last = item.canonicalLastMessageID;
  if (!last) return streamItems.findIndex((streamItem) => isCanonicalPrompt(item, streamItem));
  return streamItems.findLastIndex(
    (streamItem) =>
      isCanonicalPrompt(item, streamItem) ||
      (streamItem.kind === "user_message" &&
        streamItem.messageId !== undefined &&
        streamItem.messageId >= first &&
        streamItem.messageId <= last),
  );
}

/**
 * Where a decided battle's summary goes: right after the battle's own prompt, so the kept agent's
 * heading (its model, its time, Show battle) sits above the answer it heads, the way each agent's
 * name heads its answer while the battle runs.
 */
export function arenaSummaryAnchor(
  item: ArenaHistoryItem,
  streamItems: ReadonlyArray<ArenaAnchorItem>,
): string | null {
  return streamItems.find((streamItem) => isCanonicalPrompt(item, streamItem))?.id ?? null;
}

/**
 * The rows of a decided battle's kept answer: everything after its own prompt through the end of
 * the battle, replies sent inside it included. Show battle stands the battle in for them.
 */
export function arenaKeptAnswerRowIds(
  item: ArenaHistoryItem,
  stream: ArenaPresentedStream,
): Set<string> {
  const items = orderArenaChat([...stream.tail, ...stream.head]);
  const promptIndex = items.findIndex((streamItem) => isCanonicalPrompt(item, streamItem));
  const lastPromptIndex = lastBattlePromptIndex(item, items);
  if (promptIndex < 0 || lastPromptIndex < 0) return new Set();
  const nextUserOffset = items
    .slice(lastPromptIndex + 1)
    .findIndex((streamItem) => streamItem.kind === "user_message");
  const endIndex = nextUserOffset < 0 ? items.length - 1 : lastPromptIndex + nextUserOffset;
  return new Set(items.slice(promptIndex + 1, endIndex + 1).map((streamItem) => streamItem.id));
}

/**
 * The prompts that start a turn: every prompt in the chat, battles' and plain turns' alike, except
 * the replies sent inside a battle, which belong to that battle's turn (`arenaKeptAnswerRowIds`).
 * The chat draws its turn rule above each of them after its first row.
 */
export function arenaTurnStartRowIds(
  history: readonly ArenaHistoryItem[],
  stream: ArenaPresentedStream,
): Set<string> {
  const inside = new Set<string>();
  for (const item of history) for (const id of arenaKeptAnswerRowIds(item, stream)) inside.add(id);
  const ids = new Set<string>();
  for (const row of [...stream.tail, ...stream.head]) {
    if (row.kind === "user_message" && !inside.has(row.id)) ids.add(row.id);
  }
  return ids;
}

/**
 * Each summary's anchor, searched over tail and head. A grafted winner sends no turn completion,
 * so its turn can stay in the head until the next canonical event; in a chat whose history has
 * not loaded yet, the whole turn is there.
 */
export function arenaSummaryAnchors(
  history: readonly ArenaHistoryItem[],
  stream: ArenaPresentedStream,
): (string | null)[] {
  const items = orderArenaChat([...stream.tail, ...stream.head]);
  return history.map((item) => arenaSummaryAnchor(item, items));
}

/**
 * Whether the chat has moved past this battle's turn: a later prompt, such as a Battle-off reply,
 * follows it. Its summary then belongs under its turn rather than below everything after it.
 * Replies sent inside the battle are part of its turn, not a later prompt.
 */
export function arenaTurnFollowedUp(item: ArenaHistoryItem, stream: ArenaPresentedStream): boolean {
  const items = [...stream.tail, ...stream.head];
  const promptIndex = lastBattlePromptIndex(item, items);
  if (promptIndex >= 0) {
    return items.slice(promptIndex + 1).some((streamItem) => streamItem.kind === "user_message");
  }
  // The loaded page can start after the battle's prompts. A canonical prompt past the graft still
  // means the chat moved on.
  const last = item.canonicalLastMessageID;
  return (
    last !== undefined &&
    items.some(
      (streamItem) =>
        streamItem.kind === "user_message" &&
        streamItem.messageId !== undefined &&
        streamItem.messageId > last,
    )
  );
}

export function partitionArenaSummaries(
  history: readonly ArenaHistoryItem[],
  battleIsActive: boolean,
): {
  inline: readonly ArenaHistoryItem[];
  live: ArenaHistoryItem | null;
} {
  // Recording the vote reveals identities before application and transcript grafting finish.
  // That turn still belongs to the live battle, even if its history anchor already exists. A
  // battle nobody saw (it failed to start, or was discarded before either side answered) is
  // decided without identities.
  const resolved = history.filter(
    (item) =>
      item.resolution &&
      !isResolvingBattleState(item.state) &&
      item.state !== "awaiting_stop_resolution",
  );
  if (battleIsActive || resolved.length === 0) {
    return { inline: resolved, live: null };
  }
  return {
    inline: resolved.slice(0, -1),
    live: resolved.at(-1) ?? null,
  };
}
