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

export function isSameAssistantBlockGroup(params: {
  item: StreamItem | null | undefined;
  other: StreamItem | null | undefined;
}): boolean {
  return (
    params.item?.kind === "assistant_message" &&
    params.other?.kind === "assistant_message" &&
    params.item.blockGroupId !== undefined &&
    params.item.blockGroupId === params.other.blockGroupId
  );
}

export function getAssistantBlockSpacing(params: {
  item: StreamItem;
  aboveItem: StreamItem | null | undefined;
  belowItem: StreamItem | null | undefined;
}): "default" | "compactTop" | "compactBottom" | "compactBoth" {
  if (params.item.kind !== "assistant_message") {
    return "default";
  }
  const compactTop = isSameAssistantBlockGroup({ item: params.item, other: params.aboveItem });
  const compactBottom = isSameAssistantBlockGroup({ item: params.item, other: params.belowItem });
  if (compactTop && compactBottom) return "compactBoth";
  if (compactTop) return "compactTop";
  if (compactBottom) return "compactBottom";
  return "default";
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
  if (isSameAssistantBlockGroup({ item, other: belowItem })) {
    return SPACING[3];
  }
  return SPACING[4];
}
