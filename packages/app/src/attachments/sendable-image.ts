import { persistAttachmentFromBlob } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";
import { getIsElectron } from "@/constants/platform";
import { readDesktopFileBytes } from "@/attachments/picked-file";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

/**
 * The image types every agent provider and the battle engine take as an image
 * (`arena-backend/packages/opencode/src/arena/attachments.ts`). Anything else the renderer can
 * read is re-encoded as PNG when it is attached, so a send never fails on its format.
 */
const SENDABLE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class UnreadableImageError extends Error {
  readonly fileName: string | null;

  constructor(fileName: string | null, options?: { cause?: unknown }) {
    super(`Image could not be read: ${fileName ?? "image"}`, options);
    this.name = "UnreadableImageError";
    this.fileName = fileName;
  }
}

export interface ImageCodec {
  /** Rejects when the bytes are not an image the renderer can decode. */
  decode(blob: Blob): Promise<DecodedImage>;
}

export interface DecodedImage {
  toPng(): Promise<Blob>;
  close(): void;
}

export const browserImageCodec: ImageCodec = {
  async decode(blob) {
    const bitmap = await createImageBitmap(blob);
    return {
      async toPng() {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        context.drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: "image/png" });
      },
      close() {
        bitmap.close();
      },
    };
  },
};

export interface SendableImage {
  blob: Blob;
  mimeType: string;
  fileName: string | null;
}

/**
 * Decode an attached image and hand back bytes every agent accepts: the original when its type is
 * already sendable, a PNG otherwise. Throws `UnreadableImageError` when the bytes do not decode,
 * which covers a corrupted file and a format the renderer cannot read (HEIC, TIFF).
 */
export async function toSendableImage(
  image: SendableImage,
  codec: ImageCodec = browserImageCodec,
): Promise<SendableImage> {
  let decoded: DecodedImage;
  try {
    decoded = await codec.decode(image.blob);
  } catch (error) {
    throw new UnreadableImageError(image.fileName, { cause: error });
  }
  try {
    if (SENDABLE_IMAGE_MIME_TYPES.has(image.mimeType)) return image;
    return {
      blob: await decoded.toPng(),
      mimeType: "image/png",
      fileName: image.fileName ? image.fileName.replace(/(\.[^./\\]+)?$/, ".png") : null,
    };
  } finally {
    decoded.close();
  }
}

async function readPickedImage(picked: PickedImageAttachmentInput): Promise<Blob> {
  if (picked.source.kind === "blob") return picked.source.blob;
  // Main reads only desktop-managed storage, so a picked file is copied in before it is read.
  if (picked.source.kind === "file_uri" && getIsElectron()) {
    const bytes = await readDesktopFileBytes(picked.source.uri);
    return new Blob([new Uint8Array(bytes)], { type: picked.mimeType });
  }
  const url = picked.source.kind === "data_url" ? picked.source.dataUrl : picked.source.uri;
  return await (await fetch(url)).blob();
}

/** Store an image the user attached, once it is known to be one every agent can take. */
export async function persistSendableImage(
  picked: PickedImageAttachmentInput,
  codec?: ImageCodec,
): Promise<AttachmentMetadata> {
  const fileName =
    picked.fileName ??
    (picked.source.kind === "file_uri" ? getFileNameFromPath(picked.source.uri) : null);
  let blob: Blob;
  try {
    blob = await readPickedImage(picked);
  } catch (error) {
    throw new UnreadableImageError(fileName, { cause: error });
  }
  const image = await toSendableImage({ blob, mimeType: picked.mimeType, fileName }, codec);
  return await persistAttachmentFromBlob(image);
}

/** Persist each image on its own, so one unreadable image does not drop the others. */
export async function persistSendableImages(
  images: readonly PickedImageAttachmentInput[],
  codec?: ImageCodec,
): Promise<{ attachments: AttachmentMetadata[]; errors: unknown[] }> {
  const settled = await Promise.allSettled(
    images.map((image) => persistSendableImage(image, codec)),
  );
  return {
    attachments: settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    errors: settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  };
}
