import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArenaPromptAttachments } from "./prompt-attachments.js";

let paseoHome: string;

beforeEach(async () => {
  paseoHome = await mkdtemp(join(tmpdir(), "arena-prompt-attachments-"));
});

afterEach(async () => {
  await rm(paseoHome, { recursive: true, force: true });
});

async function upload(id: string, fileName: string, contents: string | Buffer, mimeType: string) {
  const directory = join(paseoHome, "uploads", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), contents);
  return {
    type: "uploaded_file" as const,
    id,
    fileName,
    mimeType,
    size: Buffer.byteLength(contents),
    path: join(directory, fileName),
  };
}

describe("buildArenaPromptAttachments", () => {
  it("sends images as bytes and renders other attachments to labelled text", async () => {
    const attachments = await buildArenaPromptAttachments({
      paseoHome,
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Review comment",
          text: "<div>Hi</div>",
        },
      ],
    });

    expect(attachments).toEqual([
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "text", label: "Review comment", text: "<div>Hi</div>" },
    ]);
  });

  it("points the contestants at an uploaded file of any type, as a single agent is", async () => {
    const pdf = await upload(
      "upload_a",
      "coffee_poem.pdf",
      Buffer.from("%PDF-1.7\n"),
      "application/pdf",
    );
    const zip = await upload(
      "upload_b",
      "archive.zip",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      "application/zip",
    );

    expect(await buildArenaPromptAttachments({ paseoHome, attachments: [pdf, zip] })).toEqual([
      {
        type: "file",
        path: join(paseoHome, "uploads", "upload_a", "coffee_poem.pdf"),
        name: "coffee_poem.pdf",
        mimeType: "application/pdf",
        size: 9,
      },
      {
        type: "file",
        path: join(paseoHome, "uploads", "upload_b", "archive.zip"),
        name: "archive.zip",
        mimeType: "application/zip",
        size: 5,
      },
    ]);
  });

  it("refuses an upload that is no longer on disk", async () => {
    const file = await upload("upload_c", "notes.csv", "id\n", "text/csv");
    await rm(join(paseoHome, "uploads", "upload_c"), { recursive: true });

    await expect(buildArenaPromptAttachments({ paseoHome, attachments: [file] })).rejects.toThrow();
  });

  it("reads uploads by id and never follows the path the client sent", async () => {
    await writeFile(join(paseoHome, "secret.txt"), "secret");
    const escaping = {
      type: "uploaded_file" as const,
      id: "..",
      fileName: "secret.txt",
      mimeType: "text/plain",
      size: 6,
      path: join(paseoHome, "secret.txt"),
    };

    await expect(
      buildArenaPromptAttachments({ paseoHome, attachments: [escaping] }),
    ).rejects.toThrow("secret.txt is not an uploaded file");
  });
});
