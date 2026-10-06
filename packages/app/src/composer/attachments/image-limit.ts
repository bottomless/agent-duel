import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";

function countImages(attachments: readonly ComposerAttachment[]): number {
  return attachments.filter((attachment) => attachment.kind === "image").length;
}

/** Append images up to `maxImages` in total; `refused` counts the ones that did not fit. */
export function appendImagesWithinLimit(
  current: UserComposerAttachment[],
  images: UserComposerAttachment[],
  maxImages: number | undefined,
): { attachments: UserComposerAttachment[]; refused: number } {
  const room =
    maxImages === undefined ? images.length : Math.max(0, maxImages - countImages(current));
  const accepted = images.slice(0, room);
  return { attachments: [...current, ...accepted], refused: images.length - accepted.length };
}

/** How many images to remove before `attachments` fits within `maxImages`. */
export function imagesOverLimit(
  attachments: readonly ComposerAttachment[],
  maxImages: number | undefined,
): number {
  return maxImages === undefined ? 0 : Math.max(0, countImages(attachments) - maxImages);
}
