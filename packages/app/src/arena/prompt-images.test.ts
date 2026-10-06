import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaPromptImages, arenaUserMessageContent, startingPromptImages } from "./prompt-images";

function run(input: Partial<ArenaRun>): ArenaRun {
  return { id: "run-a", side: "a", runState: "pending", ...input } as ArenaRun;
}

const image = {
  type: "file",
  mime: "image/png",
  filename: "attachment-1.png",
  url: "data:image/png;base64,iVBORw0KGgo=",
};

describe("arenaPromptImages", () => {
  it("reads the prompt's images from a contestant's copy of the prompt", () => {
    const images = arenaPromptImages([
      run({
        promptMessageID: "msg_prompt",
        parts: {
          msg_prompt: [{ type: "text", text: "Use this design system" }, image],
          msg_reply: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }],
        },
      }),
    ]);

    expect(images).toEqual([
      {
        id: "msg_prompt:image:1",
        mimeType: "image/png",
        storageType: "inline",
        storageKey: "data:image/png;base64,iVBORw0KGgo=",
        createdAt: 0,
      },
    ]);
  });

  it("skips files that are not inline images", () => {
    const images = arenaPromptImages([
      run({
        promptMessageID: "msg_prompt",
        parts: {
          msg_prompt: [
            { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" },
            { type: "file", mime: "image/png", url: "file:///tmp/shot.png" },
          ],
        },
      }),
    ]);

    expect(images).toEqual([]);
  });

  it("waits for a run whose prompt has arrived", () => {
    expect(arenaPromptImages([run({ parts: {} })])).toEqual([]);
    expect(
      arenaPromptImages([
        run({ promptMessageID: "msg_missing", parts: {} }),
        run({ id: "run-b", side: "b", promptMessageID: "msg_b", parts: { msg_b: [image] } }),
      ]),
    ).toHaveLength(1);
  });
});

describe("startingPromptImages", () => {
  it("keeps the composer's images while the battle starts", () => {
    const metadata = {
      id: "att_1",
      mimeType: "image/png",
      storageType: "desktop-file" as const,
      storageKey: "/tmp/att_1.png",
      createdAt: 1,
    };

    expect(
      startingPromptImages([
        { kind: "image", metadata },
        { kind: "github.pull_request_comment", id: "c", title: "Comment", text: "text" },
      ]),
    ).toEqual([metadata]);
  });
});

describe("arenaUserMessageContent", () => {
  it("separates a reply's words, images, and attachments", () => {
    const content = arenaUserMessageContent("msg_reply", [
      { type: "text", text: "What color is the image?" },
      image,
      {
        type: "text",
        text: "Uploaded file: secret.txt\nPath: /home/user/.paseo/uploads/upload_1/secret.txt",
        metadata: { arenaAttachment: { label: "secret.txt", kind: "file" } },
      },
      { type: "text", text: "And the secret word?" },
    ]);

    expect(content).toEqual({
      text: "What color is the image?\n\nAnd the secret word?",
      images: [
        {
          id: "msg_reply:image:1",
          mimeType: "image/png",
          storageType: "inline",
          storageKey: "data:image/png;base64,iVBORw0KGgo=",
          createdAt: 0,
        },
      ],
      attachments: [{ label: "secret.txt", kind: "file" }],
    });
  });

  it("keeps a reply that carried only an attachment", () => {
    expect(
      arenaUserMessageContent("msg_reply", [
        {
          type: "text",
          text: "notes",
          metadata: { arenaAttachment: { label: "Review comments", kind: "text" } },
        },
      ]),
    ).toEqual({ text: "", images: [], attachments: [{ label: "Review comments", kind: "text" }] });
  });
});
