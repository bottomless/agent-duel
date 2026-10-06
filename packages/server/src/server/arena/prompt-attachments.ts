import { stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { renderPromptAttachmentAsText } from "../agent/prompt-attachments.js";

/**
 * A battle attachment as the Arena engine takes it: pasted images as bytes, context rendered to
 * text, and uploaded files by path, for the contestants to open with their own tools the way a
 * single agent does.
 */
export type ArenaPromptAttachment =
  | { type: "image"; mimeType: string; data: string }
  | { type: "text"; label: string; text: string }
  | { type: "file"; path: string; name: string; mimeType: string; size: number };

export async function buildArenaPromptAttachments(input: {
  images?: ReadonlyArray<{ data: string; mimeType: string }>;
  attachments?: readonly AgentAttachment[];
  paseoHome: string;
}): Promise<ArenaPromptAttachment[]> {
  const images: ArenaPromptAttachment[] = (input.images ?? []).map((image) => ({
    type: "image",
    mimeType: image.mimeType,
    data: image.data,
  }));
  const others = await Promise.all(
    (input.attachments ?? []).map((attachment) =>
      attachment.type === "uploaded_file"
        ? uploadedFile(attachment, input.paseoHome)
        : Promise.resolve<ArenaPromptAttachment>({
            type: "text",
            label: attachmentLabel(attachment),
            text: renderPromptAttachmentAsText(attachment),
          }),
    ),
  );
  return [...images, ...others];
}

type UploadedFile = Extract<AgentAttachment, { type: "uploaded_file" }>;

/**
 * Locate an upload by its id rather than the path the client sent. The engine lets the contestants
 * read the directory this names, so it must be one of the daemon's uploads and nothing else.
 */
async function uploadedFile(
  attachment: UploadedFile,
  paseoHome: string,
): Promise<ArenaPromptAttachment> {
  const uploads = resolve(paseoHome, "uploads");
  const path = resolve(uploads, attachment.id, basename(attachment.fileName));
  const inside = relative(uploads, path);
  if (inside.startsWith("..") || inside.split(sep).length !== 2) {
    throw new Error(`${attachment.fileName} is not an uploaded file`);
  }
  const { size } = await stat(path);
  return { type: "file", path, name: attachment.fileName, mimeType: attachment.mimeType, size };
}

function attachmentLabel(attachment: Exclude<AgentAttachment, UploadedFile>): string {
  switch (attachment.type) {
    case "text":
      return attachment.title?.trim() || "Text";
    case "review":
      return "Review comments";
    case "forge_change_request":
    case "github_pr":
    case "forge_issue":
    case "github_issue":
      return `#${attachment.number} ${attachment.title}`;
  }
}
