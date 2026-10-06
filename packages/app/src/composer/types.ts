import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
}

export interface ComposerSubmitAction {
  id: string;
  label: string;
  accessibilityLabel?: string;
  testID?: string;
  isDefault?: boolean;
}
