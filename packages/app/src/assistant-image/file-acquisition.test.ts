import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  createAssistantImageFileAcquisition,
  MAX_ASSISTANT_IMAGE_FILE_BYTES,
  splitFilePath,
  type AssistantImageFileAcquisitionPort,
} from "./file-acquisition";

class MemoryFileAcquisitionPort implements AssistantImageFileAcquisitionPort {
  readonly reads: Array<{ cwd: string; path: string }> = [];

  async readFile(cwd: string, path: string) {
    this.reads.push({ cwd, path });
    return {
      kind: "image" as const,
      path,
      mime: "image/png",
      size: 4,
      modifiedAt: "1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
  }

  async persist(input: { id: string; mimeType: string; fileName: string | null }) {
    return {
      id: input.id,
      mimeType: input.mimeType,
      storageType: "web-indexeddb" as const,
      storageKey: input.id,
      fileName: input.fileName,
      byteSize: 4,
      createdAt: 1,
    } satisfies AttachmentMetadata;
  }
}

describe("assistant image file acquisition", () => {
  it("recreates the same acquisition with a live port after reconnect", async () => {
    const common = {
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "reconnect.png" },
      serverId: "server",
      occurrenceKey: "agent:message:reconnect-image",
      unavailableMessage: "Image unavailable",
    };
    const disconnected = createAssistantImageFileAcquisition({ ...common, port: null });
    const connectedPort = new MemoryFileAcquisitionPort();
    const connected = createAssistantImageFileAcquisition({ ...common, port: connectedPort });

    expect(disconnected?.key).toBe(connected?.key);
    await expect(disconnected?.locate()).rejects.toThrow("Image unavailable");
    await expect(connected?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
    expect(connectedPort.reads).toEqual([{ cwd: "/workspace", path: "reconnect.png" }]);
  });

  it("hides a filesystem error behind the unavailable message", async () => {
    const failing = (message: string): AssistantImageFileAcquisitionPort => ({
      readFile: async () => {
        throw new Error(message);
      },
      persist: async () => {
        throw new Error("not reached");
      },
    });
    const common = {
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "gone.png" },
      serverId: "server",
      occurrenceKey: "agent:message:gone-image",
      unavailableMessage: "Image unavailable",
    };

    const missing = createAssistantImageFileAcquisition({
      ...common,
      port: failing("ENOENT: no such file or directory, open '/workspace/gone.png'"),
    });
    await expect(missing?.locate()).rejects.toThrow(/^Image unavailable$/);

    const outside = createAssistantImageFileAcquisition({
      ...common,
      port: failing("Access outside of workspace is not allowed"),
    });
    await expect(outside?.locate()).rejects.toThrow("Access outside of workspace is not allowed");
  });

  it("does not read an image over the size cap", async () => {
    const sizes: Record<string, number | null> = {
      "big.png": MAX_ASSISTANT_IMAGE_FILE_BYTES + 1,
      "cap.png": MAX_ASSISTANT_IMAGE_FILE_BYTES,
      "unknown.png": null,
    };
    const port = new MemoryFileAcquisitionPort();
    const sized: AssistantImageFileAcquisitionPort = {
      readFile: (cwd, path) => port.readFile(cwd, path),
      persist: (input) => port.persist(input),
      fileSize: async (_cwd, path) => sizes[path] ?? null,
    };
    const locate = (path: string) =>
      createAssistantImageFileAcquisition({
        port: sized,
        resolution: { kind: "file_rpc", cwd: "/workspace", path },
        occurrenceKey: `agent:message:${path}`,
        unavailableMessage: "Image unavailable",
      })?.locate();

    await expect(locate("big.png")).rejects.toThrow("Image unavailable");
    await expect(locate("cap.png")).resolves.toMatchObject({ mimeType: "image/png" });
    await expect(locate("unknown.png")).resolves.toMatchObject({ mimeType: "image/png" });
    expect(port.reads.map((read) => read.path)).toEqual(["cap.png", "unknown.png"]);
  });

  it("reads the image when its size can't be looked up", async () => {
    const port = new MemoryFileAcquisitionPort();
    const acquisition = createAssistantImageFileAcquisition({
      port: {
        readFile: (cwd, path) => port.readFile(cwd, path),
        persist: (input) => port.persist(input),
        fileSize: async () => {
          throw new Error("Access outside of workspace is not allowed");
        },
      },
      resolution: { kind: "file_rpc", cwd: "/workspace", path: "shot.png" },
      occurrenceKey: "agent:message:shot",
      unavailableMessage: "Image unavailable",
    });

    await expect(acquisition?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("splits a path into its directory and name", () => {
    expect(splitFilePath("shot.png")).toEqual({ directory: ".", name: "shot.png" });
    expect(splitFilePath("docs/shot one.png")).toEqual({ directory: "docs", name: "shot one.png" });
    expect(splitFilePath("/shot.png")).toEqual({ directory: "/", name: "shot.png" });
    expect(splitFilePath("C:\\shots\\a.png")).toEqual({ directory: "C:\\shots", name: "a.png" });
  });
});
