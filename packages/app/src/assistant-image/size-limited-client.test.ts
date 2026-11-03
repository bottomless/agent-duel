import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { MAX_ASSISTANT_IMAGE_FILE_BYTES } from "./file-acquisition";
import { createSizeLimitedImageClient } from "./size-limited-client";

class ImageClient implements Pick<DaemonClient, "readFile" | "listDirectory"> {
  readonly reads: string[] = [];
  readonly listings: Array<{ cwd: string; path: string }> = [];
  size = MAX_ASSISTANT_IMAGE_FILE_BYTES;
  listingError = false;

  async listDirectory(cwd: string, path: string) {
    this.listings.push({ cwd, path });
    if (this.listingError) throw new Error("Directory unavailable");
    return {
      path,
      entries: [
        {
          name: "shot one.png",
          path: `${path}/shot one.png`,
          kind: "file" as const,
          size: this.size,
          modifiedAt: "1",
        },
      ],
    };
  }

  async readFile(_cwd: string, path: string) {
    this.reads.push(path);
    return {
      kind: "image" as const,
      path,
      mime: "image/png",
      size: this.size,
      modifiedAt: "1",
      bytes: new Uint8Array([1]),
    };
  }
}

describe("shared Markdown image size port", () => {
  it("rejects an oversized reply image before reading its bytes", async () => {
    const port = new ImageClient();
    port.size += 1;
    const client = createSizeLimitedImageClient(port)!;
    await expect(client.readFile("/repo", "docs/shot one.png")).rejects.toThrow(
      "Image unavailable",
    );
    expect(port.listings).toEqual([{ cwd: "/repo", path: "docs" }]);
    expect(port.reads).toEqual([]);
  });

  it("reads an image exactly at the cap", async () => {
    const port = new ImageClient();
    await expect(
      createSizeLimitedImageClient(port)!.readFile("/repo", "docs/shot one.png"),
    ).resolves.toMatchObject({ kind: "image", path: "docs/shot one.png" });
    expect(port.reads).toEqual(["docs/shot one.png"]);
  });

  it("still attempts the read when size lookup fails", async () => {
    const port = new ImageClient();
    port.listingError = true;
    await expect(
      createSizeLimitedImageClient(port)!.readFile("/repo", "docs/shot one.png"),
    ).resolves.toMatchObject({ kind: "image" });
    expect(port.reads).toEqual(["docs/shot one.png"]);
  });

  it("keeps a removed contestant's image port unavailable", () => {
    expect(createSizeLimitedImageClient(null)).toBeNull();
  });
});
