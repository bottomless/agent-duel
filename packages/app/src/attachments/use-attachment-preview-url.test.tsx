/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { MissingImageError, watchDaemonConnection } from "@/attachments/daemon-image-cache";
import { useAttachmentPreview } from "./use-attachment-preview-url";

const resolveAttachmentPreviewUrl = vi.hoisted(() => vi.fn());
vi.mock("@/attachments/service", () => ({
  resolveAttachmentPreviewUrl,
  releaseAttachmentPreviewUrl: vi.fn(async () => {}),
}));

const image: AttachmentMetadata = {
  id: "msg:image:0",
  mimeType: "image/png",
  storageType: "inline",
  storageKey: "named",
  createdAt: 0,
};

describe("an image preview", () => {
  it("is loading, not failed, until it resolves", async () => {
    resolveAttachmentPreviewUrl.mockReset().mockResolvedValue("data:image/png;base64,AA==");
    const view = renderHook(() => useAttachmentPreview(image));
    expect(view.result.current).toEqual({ url: null, failed: false });
    await waitFor(() =>
      expect(view.result.current).toEqual({ url: "data:image/png;base64,AA==", failed: false }),
    );
  });

  it("asks again when the daemon connection comes back after a failure", async () => {
    resolveAttachmentPreviewUrl
      .mockReset()
      .mockRejectedValueOnce(new Error("Transport not connected"))
      .mockResolvedValueOnce("data:image/png;base64,BB==");
    const listeners: Array<(state: { status: string }) => void> = [];
    watchDaemonConnection({
      isConnected: false,
      subscribeConnectionStatus: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
    const view = renderHook(() => useAttachmentPreview(image));
    await waitFor(() => expect(view.result.current.failed).toBe(true));

    act(() => listeners[0]!({ status: "connected" }));
    await waitFor(() =>
      expect(view.result.current).toEqual({ url: "data:image/png;base64,BB==", failed: false }),
    );
    expect(resolveAttachmentPreviewUrl).toHaveBeenCalledTimes(2);
  });

  it("does not ask again for an image the daemon no longer has", async () => {
    resolveAttachmentPreviewUrl
      .mockReset()
      .mockRejectedValue(new MissingImageError("This image is no longer in the battle"));
    const listeners: Array<(state: { status: string }) => void> = [];
    watchDaemonConnection({
      isConnected: false,
      subscribeConnectionStatus: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
    const view = renderHook(() => useAttachmentPreview(image));
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    act(() => listeners[0]!({ status: "connected" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolveAttachmentPreviewUrl).toHaveBeenCalledTimes(1);
  });
});
