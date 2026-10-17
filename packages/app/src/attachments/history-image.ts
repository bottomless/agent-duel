import type { AttachmentMetadata } from "@/attachments/types";
import { DaemonImageCache, MissingImageError } from "@/attachments/daemon-image-cache";

export interface HistoryImageRef {
  agentId: string;
  messageId: string;
  index: number;
}

type HistoryImageFetcher = (
  ref: HistoryImageRef,
) => Promise<{ mimeType: string; data: string } | null>;

let fetcher: HistoryImageFetcher | null = null;
// Scrolling back through a chat shows the same images again; keep the latest 64 MB of them.
const cache = new DaemonImageCache(load, 64 * 1024 * 1024);

/** The session store says how to reach the daemon that holds an agent's history. */
export function setHistoryImageFetcher(next: HistoryImageFetcher | null): void {
  fetcher = next;
  cache.clear();
}

/** An image a history page named instead of carrying (`imageRefs`), fetched when it is shown. */
export function historyImageAttachment(
  ref: HistoryImageRef & { mimeType: string; byteSize: number },
): AttachmentMetadata {
  return {
    id: `${ref.messageId}:image:${ref.index}`,
    mimeType: ref.mimeType,
    storageType: "daemon-history",
    storageKey: JSON.stringify({
      agentId: ref.agentId,
      messageId: ref.messageId,
      index: ref.index,
    }),
    byteSize: ref.byteSize,
    createdAt: 0,
  };
}

/** The image as a data URL; `show` keeps it while it is on screen, until `hideHistoryImage`. */
export function resolveHistoryImage(attachment: AttachmentMetadata, show = false): Promise<string> {
  return cache.resolve(attachment.storageKey, show);
}

export function hideHistoryImage(attachment: AttachmentMetadata): void {
  cache.hide(attachment.storageKey);
}

async function load(key: string): Promise<string> {
  if (!fetcher) throw new Error("Chat history images are unavailable");
  const image = await fetcher(JSON.parse(key) as HistoryImageRef);
  if (!image) throw new MissingImageError("This image is no longer in the chat's history");
  return `data:${image.mimeType};base64,${image.data}`;
}
