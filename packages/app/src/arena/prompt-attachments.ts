import type { ArenaPromptAttachments } from "@getpaseo/client/internal/daemon-client";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import type { ComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { encodeImages } from "@/utils/encode-images";

/** A battle message's attachments in the shape `arenaStart` and `arenaReply` send, as a chat message would. */
export async function encodeArenaPromptAttachments(
  attachments: readonly ComposerAttachment[] | undefined,
): Promise<ArenaPromptAttachments | undefined> {
  if (!attachments?.length) return undefined;
  const wire = splitComposerAttachmentsForSubmit([...attachments]);
  const images = (await encodeImages(wire.images)) ?? [];
  // Sending without an image the composer still shows would start a battle on a different prompt.
  if (images.length < wire.images.length) {
    throw new Error("An attached image could not be read. Attach it again and resend.");
  }
  return { images, attachments: wire.attachments };
}

/**
 * Keep a battle message's images on disk until the send finishes. The composer empties its draft
 * the moment you send, and an image in no draft, queue, or chat row is garbage collected; a battle
 * prompt waits on the repository check and the start before it reads its images, and is in none
 * of them meanwhile. Take this before the first await, and release it when the send settles.
 */
export function retainArenaPromptImages(attachments: readonly ComposerAttachment[]): () => void {
  const releases = splitComposerAttachmentsForSubmit([...attachments]).images.map((image) =>
    retainAttachmentForGarbageCollection(image.id),
  );
  return () => {
    for (const release of releases) release();
  };
}
