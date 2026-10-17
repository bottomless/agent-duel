import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";
import { MissingImageError, onDaemonReconnect } from "@/attachments/daemon-image-cache";

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
): string | null {
  return useAttachmentPreview(attachment).url;
}

/**
 * The preview URL, and whether resolving it failed. An image a page names loads from the daemon, so
 * `url` stays null for a while before it arrives, which is not a failure.
 */
export function useAttachmentPreview(attachment: AttachmentMetadata | null | undefined): {
  url: string | null;
  failed: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // An image a page names that failed while its daemon was away is asked again when it is back; one
  // the daemon no longer has is not.
  const [retriable, setRetriable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!retriable) return;
    return onDaemonReconnect(() => setAttempt((count) => count + 1));
  }, [retriable]);
  const activeAttachmentRef = useRef<AttachmentMetadata | null>(null);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;

  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;

  useEffect(() => {
    let disposed = false;
    let currentUrl: string | null = null;
    const current = attachmentRef.current;

    activeAttachmentRef.current = current ?? null;
    setFailed(false);
    setRetriable(false);
    if (!current) {
      setUrl(null);
      return;
    }

    void (async () => {
      try {
        const resolved = await resolveAttachmentPreviewUrl(current);
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment: current, url: resolved });
          return;
        }
        currentUrl = resolved;
        setUrl(resolved);
      } catch (error) {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: current.id,
          error,
        });
        if (!disposed) {
          setUrl(null);
          setFailed(true);
          setRetriable(!(error instanceof MissingImageError));
        }
      }
    })();

    return () => {
      disposed = true;
      const activeAttachment = activeAttachmentRef.current;
      if (!currentUrl || !activeAttachment) {
        return;
      }
      void releaseAttachmentPreviewUrl({
        attachment: activeAttachment,
        url: currentUrl,
      });
    };
  }, [id, storageType, storageKey, mimeType, attempt]);

  return { url, failed };
}
