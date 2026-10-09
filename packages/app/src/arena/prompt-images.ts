import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ComposerAttachment } from "@/attachments/types";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { LabeledAttachment } from "@/attachments/labeled-attachment";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface ArenaUserMessageContent {
  /** The words the user wrote, without the text the engine added for each attachment. */
  text: string;
  /** Held inline, since this device may never have stored them. */
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

/**
 * What one user message in a contestant's session carried, read from its parts: the user's text,
 * its images, and its attachments. The engine sends an attachment as a text part tagged with its
 * label, so that text stays out of the message and the label shows instead.
 */
export function arenaUserMessageContent(
  messageID: string,
  parts: readonly unknown[],
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
    if (
      part?.type === "file" &&
      typeof part.mime === "string" &&
      part.mime.startsWith("image/") &&
      typeof part.url === "string" &&
      part.url.startsWith("data:")
    ) {
      images.push({
        id: `${messageID}:image:${index}`,
        mimeType: part.mime,
        storageType: "inline",
        storageKey: part.url,
        createdAt: 0,
      });
    }
  });
  return { text: text.join("\n\n"), images, attachments };
}

/**
 * The images a battle's prompt carried, read back from a contestant's copy of that prompt. The
 * turn keeps only their labels, but each contestant session holds the images it was sent, and
 * both hold the same ones.
 */
export function arenaPromptImages(runs: readonly ArenaRun[]): UserMessageImageAttachment[] {
  for (const run of runs) {
    const parts = run.promptMessageID ? run.parts?.[run.promptMessageID] : undefined;
    if (!parts || !run.promptMessageID) continue;
    return arenaUserMessageContent(run.promptMessageID, parts).images;
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
