import { afterEach, describe, expect, it, vi } from "vitest";
import {
  historyImageAttachment,
  resolveHistoryImage,
  setHistoryImageFetcher,
} from "./history-image";

const ref = { agentId: "agent", messageId: "msg", index: 1, mimeType: "image/png", byteSize: 3 };

afterEach(() => setHistoryImageFetcher(null));

describe("history images", () => {
  it("fetches a named image once and keeps it for the next time it is shown", async () => {
    const fetcher = vi.fn(async () => ({ mimeType: "image/png", data: "AAA=" }));
    setHistoryImageFetcher(fetcher);
    const attachment = historyImageAttachment(ref);

    await expect(resolveHistoryImage(attachment)).resolves.toBe("data:image/png;base64,AAA=");
    await expect(resolveHistoryImage(attachment)).resolves.toBe("data:image/png;base64,AAA=");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ agentId: "agent", messageId: "msg", index: 1 });
  });

  it("tries again after a failed fetch instead of keeping the failure", async () => {
    const fetcher = vi
      .fn<() => Promise<{ mimeType: string; data: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ mimeType: "image/png", data: "BBB=" });
    setHistoryImageFetcher(fetcher);
    const attachment = historyImageAttachment(ref);

    await expect(resolveHistoryImage(attachment)).rejects.toThrow(
      "no longer in the chat's history",
    );
    await expect(resolveHistoryImage(attachment)).resolves.toBe("data:image/png;base64,BBB=");
  });
});
