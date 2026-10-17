import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../messages.js";

type AgentStreamEvent = Extract<
  SessionOutboundMessage,
  { type: "agent_stream" }
>["payload"]["event"];

/**
 * A history page names a replayed message's images instead of carrying them, and the app fetches
 * each one as it shows it (`agent.timeline.get_image`). Pages are counted in messages, not bytes, so
 * a long battle chat's pasted screenshots made one page tens of megabytes, near the daemon's 64 MiB
 * socket limit. The timeline itself keeps the bytes; only what goes to a window changes.
 */
export function withHistoryImageRefs(agentId: string, item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "user_message" || !item.images?.length || !item.messageId) return item;
  const { images, ...rest } = item;
  const messageId = item.messageId;
  return {
    ...rest,
    imageRefs: images.map((image, index) => ({
      agentId,
      messageId,
      index,
      mimeType: image.mimeType,
      byteSize: Math.floor((image.data.length * 3) / 4),
    })),
  };
}

/**
 * A streamed user message names its images too. Reload, Unarchive, a rewind or a rebuilt winner
 * history replays every row at once, and a long chat's pasted screenshots sent inline passed the
 * socket limit. The window that sent a message keeps its own copies of its images.
 */
export function withStreamImageRefs(agentId: string, event: AgentStreamEvent): AgentStreamEvent {
  if (event.type !== "timeline") return event;
  const item = withHistoryImageRefs(agentId, event.item);
  return item === event.item ? event : { ...event, item };
}

export function findHistoryImage(
  items: readonly AgentTimelineItem[],
  messageId: string,
  index: number,
): { mimeType: string; data: string } | null {
  for (const item of items) {
    if (item.type === "user_message" && item.messageId === messageId) {
      return item.images?.[index] ?? null;
    }
  }
  return null;
}
