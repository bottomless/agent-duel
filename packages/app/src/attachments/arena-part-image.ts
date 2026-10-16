import type { AttachmentMetadata } from "@/attachments/types";

export interface ArenaPartImageRef {
  serverId: string;
  agentId: string;
  runId: string;
  partId: string;
}

type ArenaPartFetcher = (ref: ArenaPartImageRef) => Promise<unknown>;

let fetcher: ArenaPartFetcher | null = null;
// Both panes of a long turn show dozens of photos, and a pane remounts when its view changes.
const CACHE_LIMIT = 64;
const cache = new Map<string, Promise<string>>();

/** The session store says how to reach the daemon that holds a battle chat. */
export function setArenaPartImageFetcher(next: ArenaPartFetcher | null): void {
  fetcher = next;
  cache.clear();
}

/**
 * An image a battle snapshot sent without its data (engine `withPartPreviews`), fetched from its run
 * when it is shown.
 */
export function arenaPartImageAttachment(
  ref: ArenaPartImageRef & { id: string; mimeType: string },
): AttachmentMetadata {
  return {
    id: ref.id,
    mimeType: ref.mimeType,
    storageType: "arena-part",
    storageKey: JSON.stringify({
      serverId: ref.serverId,
      agentId: ref.agentId,
      runId: ref.runId,
      partId: ref.partId,
    }),
    createdAt: 0,
  };
}

/** The image as a data URL. */
export function resolveArenaPartImage(attachment: AttachmentMetadata): Promise<string> {
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
  if (!fetcher) throw new Error("Battle images are unavailable");
  const part = await fetcher(JSON.parse(key) as ArenaPartImageRef);
  const url =
    typeof part === "object" && part !== null && "url" in part ? (part.url as unknown) : null;
  if (typeof url !== "string" || !url.startsWith("data:")) {
    throw new Error("This image is no longer in the battle");
  }
  return url;
}
