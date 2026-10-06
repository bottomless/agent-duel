import { FileText, Image as ImageIcon } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  labeledAttachmentSubtitle,
  type LabeledAttachment,
} from "@/attachments/labeled-attachment";
import type { UserMessageAttachmentPill } from "@/components/message";
import { ICON_SIZE, type Theme } from "@/styles/theme";

type PromptAttachment = NonNullable<NonNullable<ArenaSnapshot["turn"]>["attachments"]>[number];

const ThemedImageIcon = withUnistyles(ImageIcon);
const ThemedFileText = withUnistyles(FileText);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const imageIcon = <ThemedImageIcon size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const fileIcon = <ThemedFileText size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;

/**
 * What a battle's prompt carried besides its text and image thumbnails, as the prompt bubble's
 * attachment pills. Labels, not previews: the engine keeps the bytes in the contestants' sessions,
 * and a reloaded chat has no local copy to show.
 */
export function arenaPromptAttachmentPills(
  attachments: readonly PromptAttachment[] | undefined,
): UserMessageAttachmentPill[] {
  // Two attachments can share a name, so the key carries the position too.
  return (attachments ?? []).map((attachment, index) => ({
    key: `${index}:${attachment.kind}:${attachment.label}`,
    icon: attachment.kind === "image" ? imageIcon : fileIcon,
    title: attachment.label,
    subtitle: subtitle(attachment),
  }));
}

/**
 * A reply's attachments as its bubble's pills. A contestant's copy of the message keeps each
 * attachment's label, a file name for an upload and a title for text, and its kind.
 */
export function arenaMessageAttachmentPills(
  attachments: readonly LabeledAttachment[],
): UserMessageAttachmentPill[] {
  return attachments.map((attachment, index) => ({
    key: `${index}:${attachment.label}`,
    icon: fileIcon,
    title: attachment.label,
    subtitle: labeledAttachmentSubtitle(attachment),
  }));
}

function subtitle(attachment: PromptAttachment): string {
  if (attachment.kind === "image") return "Image";
  return labeledAttachmentSubtitle({ label: attachment.label, kind: attachment.kind });
}
