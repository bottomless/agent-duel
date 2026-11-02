import { i18n } from "@/i18n/i18next";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaUserMessageContent, type ArenaUserMessageContent } from "./prompt-images";
import { arenaRunningTool } from "./run-liveness";
import { arenaThreadMessages } from "./run-thread-selection";

export interface QueuedArenaSteer extends ArenaUserMessageContent {
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function arenaToolOutput(state: unknown): unknown {
  if (!isRecord(state)) return undefined;
  if (state.output !== undefined) return state.output;
  if (state.status === "running" && isRecord(state.metadata)) return state.metadata.output;
  return undefined;
}

export function arenaQueuedSteering(run: ArenaRun): QueuedArenaSteer[] {
  if (run.runState !== "pending") return [];
  // Subagent transcripts share the run's message list. Their task prompts and replies are not
  // steering, and a subagent reply must not mark the contestant's own steer as received.
  const messages = arenaThreadMessages(run)
    .filter(isRecord)
    .filter(
      (message) => typeof message.sessionID !== "string" || message.sessionID === run.sessionID,
    );
  const indices = new Map(messages.map((message, index) => [message.id, index]));
  let consumedThrough = -1;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const parentIndex = indices.get(message.parentID);
    if (parentIndex !== undefined) consumedThrough = Math.max(consumedThrough, parentIndex);
  }
  // An assistant created after submission can still belong to the earlier prompt.
  // Its parent identifies the input the model actually received, including batched steers.
  return messages.slice(consumedThrough + 1).flatMap((message) => {
    if (message.role !== "user" || typeof message.id !== "string") return [];
    // A steer can carry only an image or a file, and a file arrives as a text part: read the
    // message the way the thread does, so its words show and the file's contents do not.
    const content = arenaUserMessageContent(message.id, run.parts?.[message.id] ?? []);
    if (!content.text && content.images.length === 0 && content.attachments.length === 0) return [];
    return [{ id: message.id, ...content }];
  });
}

/**
 * When queued messages reach the model, named by what the contestant is in the middle of: a steer
 * goes out with the next model request, after the running tool call or reply.
 */
export function arenaQueuedSteerDelivery(run: ArenaRun): string {
  const tool = arenaRunningTool(run);
  if (tool === "command") return i18n.t("arena.queuedCommand");
  if (tool === "tool") return i18n.t("arena.queuedTool");
  return i18n.t("arena.queuedReply");
}

/** Send now cuts the running work short but, unlike Stop, keeps the contestant going. */
export function arenaSendNowHint(run: ArenaRun): string {
  const tool = arenaRunningTool(run);
  if (tool === "command") return i18n.t("arena.interruptCommand");
  if (tool === "tool") return i18n.t("arena.interruptTool");
  return i18n.t("arena.interruptReply");
}

/** What a queued steer attaches, as one line under its text: `2 images · notes.md`. */
export function arenaQueuedSteerAttachments(
  steer: Pick<QueuedArenaSteer, "images" | "attachments">,
) {
  const images = steer.images.length;
  const parts = steer.attachments.map((attachment) => attachment.label);
  if (images > 0)
    parts.unshift(
      images === 1 ? i18n.t("arena.oneImage") : i18n.t("arena.imageCount", { total: images }),
    );
  return parts.join(" · ");
}
