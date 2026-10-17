import type { AttachmentMetadata } from "@/attachments/types";
import { DaemonImageCache, MissingImageError } from "@/attachments/daemon-image-cache";

export interface ArenaPartImageRef {
  serverId: string;
  agentId: string;
  runId: string;
  partId: string;
  /** Where the part lives, so the engine reads one row instead of the run's whole transcript. */
  sessionId?: string;
  messageId?: string;
}

type ArenaPartFetcher = (ref: ArenaPartImageRef) => Promise<unknown>;

let fetcher: ArenaPartFetcher | null = null;
// Both panes of a long turn show dozens of photos, and a pane remounts when its view changes, so the
// latest 64 MB of them are kept.
const cache = new DaemonImageCache(load, 64 * 1024 * 1024);

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
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(ref.messageId ? { messageId: ref.messageId } : {}),
    }),
    createdAt: 0,
  };
}

/** The image as a data URL. */
export function resolveArenaPartImage(attachment: AttachmentMetadata): Promise<string> {
  return cache.resolve(attachment.storageKey);
}

async function load(key: string): Promise<string> {
  if (!fetcher) throw new Error("Battle images are unavailable");
  let part: unknown;
  try {
    part = await fetcher(JSON.parse(key) as ArenaPartImageRef);
  } catch (error) {
    // Refused for its size, it is refused the same way every time.
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "arena_part_too_large")
      throw new MissingImageError("This image is too large to show");
    throw error;
  }
  const url =
    typeof part === "object" && part !== null && "url" in part ? (part.url as unknown) : null;
  if (typeof url !== "string" || !url.startsWith("data:")) {
    throw new MissingImageError("This image is no longer in the battle");
  }
  return url;
}
