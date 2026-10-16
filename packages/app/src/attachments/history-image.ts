import type { AttachmentMetadata } from "@/attachments/types";

export interface HistoryImageRef {
  agentId: string;
  messageId: string;
  index: number;
}

type HistoryImageFetcher = (
  ref: HistoryImageRef,
) => Promise<{ mimeType: string; data: string } | null>;

let fetcher: HistoryImageFetcher | null = null;
// Scrolling back through a chat shows the same images again; keep the latest few.
const CACHE_LIMIT = 32;
const cache = new Map<string, Promise<string>>();

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

/** The image as a data URL. */
export function resolveHistoryImage(attachment: AttachmentMetadata): Promise<string> {
  const key = attachment.storageKey;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = load(key).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(oldest);
  }
  return pending;
}

async function load(key: string): Promise<string> {
  if (!fetcher) throw new Error("Chat history images are unavailable");
  const image = await fetcher(JSON.parse(key) as HistoryImageRef);
  if (!image) throw new Error("This image is no longer in the chat's history");
  return `data:${image.mimeType};base64,${image.data}`;
}
