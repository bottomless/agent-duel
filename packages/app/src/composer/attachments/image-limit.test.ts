import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { appendImagesWithinLimit, imagesOverLimit } from "./image-limit";

function image(id: string): UserComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: `/attachments/${id}.png`,
      createdAt: 0,
    },
  };
}

const issue: UserComposerAttachment = {
  kind: "forge_issue",
  item: {
    kind: "issue",
    number: 7,
    title: "Crash",
    url: "https://github.com/acme/app/issues/7",
    state: "open",
    body: null,
    labels: [],
    baseRefName: null,
    headRefName: null,
  },
};

describe("appendImagesWithinLimit", () => {
  it("attaches every image when there is no limit", () => {
    const result = appendImagesWithinLimit([issue], [image("a"), image("b")], undefined);

    expect(result).toEqual({ attachments: [issue, image("a"), image("b")], refused: 0 });
  });

  it("attaches images until the limit and refuses the rest", () => {
    const current = [image("a"), issue, image("b"), image("c")];

    const result = appendImagesWithinLimit(current, [image("d"), image("e")], 4);

    expect(result).toEqual({ attachments: [...current, image("d")], refused: 1 });
  });
});

describe("imagesOverLimit", () => {
  it("counts the images a send holds beyond the limit", () => {
    const attachments = [image("a"), image("b"), issue, image("c")];

    expect(imagesOverLimit(attachments, 2)).toBe(1);
    expect(imagesOverLimit(attachments, 3)).toBe(0);
    expect(imagesOverLimit(attachments, undefined)).toBe(0);
  });
});
