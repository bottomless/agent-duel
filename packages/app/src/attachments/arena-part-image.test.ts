import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arenaPartImageAttachment,
  resolveArenaPartImage,
  setArenaPartImageFetcher,
} from "./arena-part-image";

const ref = { serverId: "server", agentId: "agent", runId: "run", partId: "prt_photo" };
const attachment = arenaPartImageAttachment({ ...ref, id: "msg:image:0", mimeType: "image/png" });

afterEach(() => setArenaPartImageFetcher(null));

describe("a battle photo sent without its data", () => {
  it("loads the photo from its run once and keeps it", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ id: "prt_photo", url: "data:image/png;base64,AAAA" });
    setArenaPartImageFetcher(fetcher);

    expect(await resolveArenaPartImage(attachment)).toBe("data:image/png;base64,AAAA");
    expect(await resolveArenaPartImage(attachment)).toBe("data:image/png;base64,AAAA");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(ref);
  });

  it("asks again after a failed load", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: "data:image/png;base64,BBBB" });
    setArenaPartImageFetcher(fetcher);

    await expect(resolveArenaPartImage(attachment)).rejects.toThrow("no longer in the battle");
    expect(await resolveArenaPartImage(attachment)).toBe("data:image/png;base64,BBBB");
  });
});
