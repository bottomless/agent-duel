import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { MAX_ASSISTANT_IMAGE_FILE_BYTES, splitFilePath } from "./file-acquisition";

/** The shared Markdown renderer accepts a read-only client, so enforce the cap at that port. */
export function createSizeLimitedImageClient(
  client: Pick<DaemonClient, "readFile" | "listDirectory"> | null | undefined,
): Pick<DaemonClient, "readFile"> | null {
  if (!client) return null;
  return {
    readFile: async (cwd, path) => {
      const { directory, name } = splitFilePath(path);
      // A failed lookup falls through to the read, which reports the actual error.
      const listing = await client.listDirectory(cwd, directory).catch(() => null);
      const size = listing?.entries.find(
        (item) => item.kind === "file" && item.name === name,
      )?.size;
      if (size != null && size > MAX_ASSISTANT_IMAGE_FILE_BYTES) {
        throw new Error("Image unavailable");
      }
      return client.readFile(cwd, path);
    },
  };
}
