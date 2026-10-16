import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ComposerAttachment } from "@/attachments/types";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { LabeledAttachment } from "@/attachments/labeled-attachment";
import { arenaPartImageAttachment } from "@/attachments/arena-part-image";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The daemon, chat and run a message comes from, which an image sent without its data loads from. */
export interface ArenaImageSource {
  serverId: string;
  agentId: string;
  runId: string;
}

export interface ArenaUserMessageContent {
  /** The words the user wrote, without the text the engine added for each attachment. */
  text: string;
  /** Held inline or in the run, since this device may never have stored them. */
  images: UserMessageImageAttachment[];
  /** Each uploaded file or text attachment, by the label and kind the engine tagged it with. */
  attachments: LabeledAttachment[];
}

function labeledAttachment(part: Record<string, unknown>): LabeledAttachment | undefined {
  const tag = record(record(part.metadata)?.arenaAttachment);
  if (typeof tag?.label !== "string") return undefined;
  return tag.kind === "file" || tag.kind === "text"
    ? { label: tag.label, kind: tag.kind }
    : { label: tag.label };
}

function previewed(part: Record<string, unknown>): boolean {
  return Array.isArray(part.previewed) && part.previewed.includes("url");
}

/**
 * What one user message in a contestant's session carried, read from its parts: the user's text,
 * its images, and its attachments. The engine sends an attachment as a text part tagged with its
 * label, so that text stays out of the message and the label shows instead. A large image comes
 * without its data and loads from `source` when shown; without a source it is only counted.
 */
export function arenaUserMessageContent(
  messageID: string,
  parts: readonly unknown[],
  source?: ArenaImageSource,
): ArenaUserMessageContent {
  const text: string[] = [];
  const images: UserMessageImageAttachment[] = [];
  const attachments: LabeledAttachment[] = [];
  parts.forEach((value, index) => {
    const part = record(value);
    if (part?.type === "text" && typeof part.text === "string") {
      const attachment = labeledAttachment(part);
      if (attachment !== undefined) attachments.push(attachment);
      else if (part.synthetic !== true) text.push(part.text);
      return;
    }
    if (part?.type !== "file" || typeof part.mime !== "string" || !part.mime.startsWith("image/")) {
      return;
    }
    const id = `${messageID}:image:${index}`;
    if (typeof part.url === "string" && part.url.startsWith("data:")) {
      images.push({
        id,
        mimeType: part.mime,
        storageType: "inline",
        storageKey: part.url,
        createdAt: 0,
      });
    } else if (previewed(part) && typeof part.id === "string") {
      images.push(
        arenaPartImageAttachment({
          id,
          mimeType: part.mime,
          serverId: source?.serverId ?? "",
          agentId: source?.agentId ?? "",
          runId: source?.runId ?? "",
          partId: part.id,
        }),
      );
    }
  });
  return { text: text.join("\n\n"), images, attachments };
}

/**
 * The images a battle's prompt carried, read back from a contestant's copy of that prompt. The
 * turn keeps only their labels, but each contestant session holds the images it was sent, and
 * both hold the same ones.
 */
export function arenaPromptImages(
  runs: readonly ArenaRun[],
  chat: Omit<ArenaImageSource, "runId">,
): UserMessageImageAttachment[] {
  for (const run of runs) {
    const parts = run.promptMessageID ? run.parts?.[run.promptMessageID] : undefined;
    if (!parts || !run.promptMessageID) continue;
    return arenaUserMessageContent(run.promptMessageID, parts, { ...chat, runId: run.id }).images;
  }
  return [];
}

/** The images a battle that is still starting was sent with, from the composer's own store. */
export function startingPromptImages(
  attachments: readonly ComposerAttachment[] | undefined,
): UserMessageImageAttachment[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image" ? [attachment.metadata] : [],
  );
}
