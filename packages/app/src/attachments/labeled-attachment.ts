import { getFileTypeLabel } from "@/attachments/file-types";

/**
 * An attachment a battle sent beside a message, known by its label: an uploaded file's name or a
 * text attachment's title. Its kind travels with it, except on a message recorded before the engine
 * kept it.
 */
export interface LabeledAttachment {
  label: string;
  kind?: "file" | "text";
}

/** A label recorded without its kind is taken as a file when it ends in a file extension. */
export function labeledAttachmentKind(attachment: LabeledAttachment): "file" | "text" {
  return attachment.kind ?? (getFileTypeLabel(attachment.label) ? "file" : "text");
}

/**
 * The pill subtitle, the same in a live battle and in the chat's history: a file's type, "File" for
 * one without an extension, and "Text" for a text attachment.
 */
export function labeledAttachmentSubtitle(attachment: LabeledAttachment): string {
  if (labeledAttachmentKind(attachment) === "text") return "Text";
  return getFileTypeLabel(attachment.label) ?? "File";
}
