import type { AttachmentMetadata } from "@/attachments/types";
import { resolveRasterImageMimeType } from "@/attachments/file-types";
import { type ImageCodec, persistSendableImages } from "@/attachments/sendable-image";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

/**
 * The files a paste carries, split the way a drop splits them: raster images attach as images,
 * and every other file (an SVG included) attaches as a file.
 */
export interface ClipboardFiles {
  images: ClipboardImageFile[];
  others: File[];
}

export function collectFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null,
): ClipboardFiles {
  const files: ClipboardFiles = { images: [], others: [] };
  if (!clipboardData?.items) {
    return files;
  }

  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    const mimeType = resolveRasterImageMimeType({ mimeType: item.type });
    if (mimeType) {
      files.images.push({ file, mimeType });
    } else {
      files.others.push(file);
    }
  }

  return files;
}

export async function filesToImageAttachments(
  files: readonly ClipboardImageFile[],
  codec?: ImageCodec,
): Promise<{ attachments: ImageAttachmentFromFile[]; errors: unknown[] }> {
  return await persistSendableImages(
    files.map(({ file, mimeType }) => ({
      source: { kind: "blob", blob: file },
      mimeType,
      fileName: file.name,
    })),
    codec,
  );
}
