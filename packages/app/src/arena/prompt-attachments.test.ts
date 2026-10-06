import { describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { encodeArenaPromptAttachments, retainArenaPromptImages } from "./prompt-attachments";

vi.mock("@/utils/encode-images", () => ({
  // An id of "missing" stands for an image whose file the collector already deleted.
  encodeImages: async (images: AttachmentMetadata[] | undefined) => {
    const readable = (images ?? []).filter((image) => image.id !== "missing");
    return readable.length
      ? readable.map((image) => ({ data: `bytes-of-${image.id}`, mimeType: image.mimeType }))
      : undefined;
  },
}));

function metadata(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    createdAt: 0,
  };
}

describe("encodeArenaPromptAttachments", () => {
  it("sends nothing for a message without attachments", async () => {
    expect(await encodeArenaPromptAttachments([])).toBeUndefined();
    expect(await encodeArenaPromptAttachments(undefined)).toBeUndefined();
  });

  it("sends images as bytes and context attachments as text", async () => {
    const comment: ComposerAttachment = {
      kind: "github.pull_request_comment",
      id: "comment-1",
      title: "Review comment",
      text: "Make the hero bigger",
    };

    const encoded = await encodeArenaPromptAttachments([
      { kind: "image", metadata: metadata("pasted") },
      comment,
    ]);

    expect(encoded?.images).toEqual([{ data: "bytes-of-pasted", mimeType: "image/png" }]);
    expect(encoded?.attachments).toEqual([
      expect.objectContaining({ type: "text", text: "Make the hero bigger" }),
    ]);
  });
});

describe("retainArenaPromptImages", () => {
  it("keeps a battle message's images from garbage collection until it is released", () => {
    const release = retainArenaPromptImages([
      { kind: "image", metadata: metadata("held") },
      { kind: "github.pull_request_comment", id: "c", title: "Comment", text: "text" },
    ]);

    expect(collectRetainedAttachmentIds()).toEqual(new Set(["held"]));
    release();
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });
});

describe("encodeArenaPromptAttachments with an unreadable image", () => {
  it("refuses to send rather than dropping the image", async () => {
    await expect(
      encodeArenaPromptAttachments([{ kind: "image", metadata: metadata("missing") }]),
    ).rejects.toThrow("An attached image could not be read. Attach it again and resend.");
  });
});
