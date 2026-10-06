import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectFilesFromClipboardData,
  filesToImageAttachments,
} from "./image-attachments-from-files";
import { UnreadableImageError, type ImageCodec } from "@/attachments/sendable-image";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";

function createClipboardItem(params: { kind: string; type: string; file?: File | null }) {
  return {
    kind: params.kind,
    type: params.type,
    getAsFile: () => params.file ?? null,
  };
}

/** Decodes any bytes but a leading zero, the way a corrupted file fails to decode. */
const testCodec: ImageCodec = {
  async decode(blob) {
    const [first] = new Uint8Array(await blob.arrayBuffer());
    if (first === 0) throw new Error("decode failed");
    return {
      toPng: async () => new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
      close: () => {},
    };
  },
};

function createTestStore(): AttachmentStore {
  let sequence = 0;
  return {
    storageType: "web-indexeddb",
    async save(input) {
      sequence += 1;
      const id = input.id ?? `att-${sequence}`;
      const mimeType = input.mimeType ?? "image/jpeg";
      const fileName = input.fileName ?? null;
      let byteSize = 0;
      if (input.source.kind === "blob") {
        byteSize = input.source.blob.size;
      } else if (input.source.kind === "data_url") {
        byteSize = input.source.dataUrl.length;
      } else if (input.source.kind === "file_uri") {
        byteSize = input.source.uri.length;
      } else {
        byteSize = input.source.bytes.byteLength;
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize,
        createdAt: 1700000000000 + sequence,
      };
    },
    async encodeBase64() {
      throw new Error("not used in this test");
    },
    async resolvePreviewUrl() {
      throw new Error("not used in this test");
    },
    async delete() {},
    async garbageCollect() {},
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(createTestStore());
});

afterEach(() => {
  __setAttachmentStoreForTests(null);
});

describe("collectFilesFromClipboardData", () => {
  it("splits pasted files into raster images and other files", () => {
    const imagePng = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });
    const textFile = new File(["not image"], "notes.txt", { type: "text/plain" });

    const files = collectFilesFromClipboardData({
      items: [
        createClipboardItem({ kind: "string", type: "text/plain" }),
        createClipboardItem({ kind: "file", type: "text/plain", file: textFile }),
        createClipboardItem({ kind: "file", type: "image/png", file: imagePng }),
        createClipboardItem({ kind: "file", type: "image/jpeg", file: null }),
      ],
    });

    expect(files).toEqual({
      images: [{ file: imagePng, mimeType: "image/png" }],
      others: [textFile],
    });
  });

  it("keeps an SVG as a file rather than dropping it", () => {
    const svgFile = new File(["<svg />"], "logo.svg", { type: "image/svg+xml" });

    const files = collectFilesFromClipboardData({
      items: [createClipboardItem({ kind: "file", type: "image/svg+xml", file: svgFile })],
    });

    expect(files).toEqual({ images: [], others: [svgFile] });
  });

  it("returns nothing when clipboard data is missing", () => {
    expect(collectFilesFromClipboardData(undefined)).toEqual({ images: [], others: [] });
  });
});

describe("filesToImageAttachments", () => {
  it("persists sendable images as they are, in order", async () => {
    const first = new File([new Uint8Array([1, 2, 3, 4])], "first.png", { type: "image/png" });
    const second = new File([new Uint8Array([5, 6, 7, 8])], "second.jpg", { type: "" });

    const result = await filesToImageAttachments(
      [
        { file: first, mimeType: "image/png" },
        { file: second, mimeType: "image/jpeg" },
      ],
      testCodec,
    );

    expect(result.errors).toEqual([]);
    expect(result.attachments).toEqual([
      {
        id: "att-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-1",
        fileName: "first.png",
        byteSize: 4,
        createdAt: 1700000000001,
      },
      {
        id: "att-2",
        mimeType: "image/jpeg",
        storageType: "web-indexeddb",
        storageKey: "att-2",
        fileName: "second.jpg",
        byteSize: 4,
        createdAt: 1700000000002,
      },
    ]);
  });

  it("re-encodes a BMP as PNG", async () => {
    const bmp = new File([new Uint8Array([0x42, 0x4d, 1, 2])], "photo.bmp", { type: "image/bmp" });

    const { attachments } = await filesToImageAttachments(
      [{ file: bmp, mimeType: "image/bmp" }],
      testCodec,
    );

    expect(attachments).toMatchObject([
      { mimeType: "image/png", fileName: "photo.png", byteSize: 2 },
    ]);
  });

  it("refuses an image that does not decode and keeps the others", async () => {
    const broken = new File([new Uint8Array([0, 1])], "broken.png", { type: "image/png" });
    const good = new File([new Uint8Array([1, 1])], "good.png", { type: "image/png" });

    const { attachments, errors } = await filesToImageAttachments(
      [
        { file: broken, mimeType: "image/png" },
        { file: good, mimeType: "image/png" },
      ],
      testCodec,
    );

    expect(attachments.map((attachment) => attachment.fileName)).toEqual(["good.png"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnreadableImageError);
    expect((errors[0] as UnreadableImageError).fileName).toBe("broken.png");
  });
});
