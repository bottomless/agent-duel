import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";
import type { AssistantImageSourceResolution } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
} from "./acquisition-cache";

// Each rendered occurrence persists its own copy, and the client holds the whole file in memory
// while it arrives, so a reply pointing at a huge file could stall the app.
export const MAX_ASSISTANT_IMAGE_FILE_BYTES = 25 * 1024 * 1024;

export interface AssistantImageFileAcquisitionPort {
  readFile(cwd: string, path: string): Promise<FileReadResult>;
  /** The file's size, or null when it can't be told without reading the file. */
  fileSize?(cwd: string, path: string): Promise<number | null>;
  persist(input: {
    id: string;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

export interface AssistantImageAcquisition {
  key: string;
  locate: () => Promise<AttachmentMetadata>;
}

export function createAssistantImageFileAcquisition(input: {
  port: AssistantImageFileAcquisitionPort | null;
  resolution: AssistantImageSourceResolution | null;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
}): AssistantImageAcquisition | null {
  if (input.resolution?.kind !== "file_rpc") {
    return null;
  }
  const { port, resolution } = input;
  return {
    key: createAssistantImageFileAcquisitionKey({
      serverId: input.serverId,
      occurrenceKey: input.occurrenceKey,
      cwd: resolution.cwd,
      path: resolution.path,
    }),
    locate: async () => {
      if (!port) {
        throw new Error(input.unavailableMessage);
      }
      // A failed size lookup falls through to the read, which reports the real error.
      const size = await port.fileSize?.(resolution.cwd, resolution.path).catch(() => null);
      if (size != null && size > MAX_ASSISTANT_IMAGE_FILE_BYTES) {
        throw new Error(input.unavailableMessage);
      }
      const file = await port.readFile(resolution.cwd, resolution.path).catch((error: unknown) => {
        // A Node errno message ("ENOENT: no such file or directory, open '<path>'") names the
        // full path and nothing the reader can act on.
        if (error instanceof Error && /^E[A-Z]+:/.test(error.message)) {
          throw new Error(input.unavailableMessage, { cause: error });
        }
        throw error;
      });
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      return await port.persist({
        id: createAssistantImageFilePreviewAttachmentId({
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
    },
  };
}

export function splitFilePath(path: string): { directory: string; name: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return { directory: ".", name: path };
  return { directory: path.slice(0, index) || path.slice(0, 1), name: path.slice(index + 1) };
}
