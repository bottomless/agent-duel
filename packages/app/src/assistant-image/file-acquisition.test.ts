import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  createAssistantImageFileAcquisition,
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
});
