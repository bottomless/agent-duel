import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";

/**
 * The height kept for the older-history spinner at the top of the scroll.
 *
 * The slot is there whether or not a spinner is in it, so reaching the start of the loaded
 * history does not shove the conversation down when one appears.
 */
export const STREAM_HISTORY_START_SLOT_HEIGHT = SPACING[8];

/** The scroll's own padding above that slot. */
export const STREAM_CONTENT_PADDING_TOP = SPACING[4];

/**
 * How far the first message sits below the top of the scroll.
 *
 * Anything drawn in the stream's place before the stream exists — the draft's battle, waiting
 * for the chat that will own it — starts here too. Otherwise the conversation drops by this
 * much when the real stream takes over, which reads as the whole screen jumping.
 */
export const STREAM_CONTENT_TOP_INSET =
  STREAM_HISTORY_START_SLOT_HEIGHT + STREAM_CONTENT_PADDING_TOP;

export function getAssistantMessageSpacing(params: {
  item: StreamItem;
  hasFooterBelow?: boolean;
}): "default" | "compactBottom" {
  return params.item.kind === "assistant_message" && params.hasFooterBelow
    ? "compactBottom"
    : "default";
}

const isUserMessageItem = (item?: StreamItem | null) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem | null) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";

export function getGapBetweenStreamItems(
  item: StreamItem | null,
  belowItem: StreamItem | null,
): number {
  if (!item || !belowItem) {
    return 0;
  }

  if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
    return SPACING[1];
  }
  if (item.kind === "user_message" && belowItem.kind === "assistant_message") {
    return 0;
  }
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return 0;
  }
  if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
    return SPACING[4];
  }
  if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
    return SPACING[1];
  }
  if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
    return SPACING[1];
  }
  return SPACING[4];
}

function isSubagentRow(item: StreamItem): boolean {
  return (
    item.kind === "tool_call" &&
    item.payload.source === "agent" &&
    item.payload.data.detail.type === "sub_agent"
  );
}

/** Work that folds into a row beneath the text or subagent it follows. */
function isWorkRow(item: StreamItem): boolean {
  return (item.kind === "tool_call" && !isSubagentRow(item)) || item.kind === "thought";
}

/**
 * A battle chat's spacing, which is its battle pane's (`run-thread.tsx`): one rhythm down the
 * turn. A text and the work row it led into sit together, separated by nothing but the text's own
 * trailing paragraph margin; every other block starts after one gap. So text, its work, the next
 * text are evenly spaced, and a text that a new text or subagent follows gets the margin and the
 * gap, as a new segment does in the pane. The assistant message's own padding is left out
 * (`getArenaAssistantBlockSpacing`), and every row is flush.
 */
export function getArenaGapBetweenStreamItems(
  item: StreamItem | null,
  belowItem: StreamItem | null,
): number {
  if (!item || !belowItem) {
    return 0;
  }
  if (isUserMessageItem(item) || isUserMessageItem(belowItem)) {
    return getGapBetweenStreamItems(item, belowItem);
  }
  if (item.kind === "assistant_message") {
    return isWorkRow(belowItem) ? 0 : SPACING[3];
  }
  // Work after a subagent sits the same small step below its status line as the status sits below
  // the heading, as the pane folds that work under the subagent.
  if (isSubagentRow(item) && isWorkRow(belowItem)) {
    return SPACING[0.5];
  }
  return SPACING[3];
}
