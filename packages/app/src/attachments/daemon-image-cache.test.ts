import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonImageCache, MissingImageError } from "./daemon-image-cache";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: (url: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("images loaded from the daemon", () => {
  it("loads four at a time, as two panes of photos ask for dozens at once", async () => {
    const waiting = new Map<string, ReturnType<typeof deferred>>();
    const load = vi.fn((key: string) => {
      const next = deferred();
      waiting.set(key, next);
      return next.promise;
    });
    const cache = new DaemonImageCache(load, 1_000_000);
    const shown = Array.from({ length: 10 }, (_, index) => cache.resolve(`photo-${index}`));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(4);

    waiting.get("photo-0")!.resolve("data:image/png;base64,AA==");
    await expect(shown[0]).resolves.toBe("data:image/png;base64,AA==");
    expect(load).toHaveBeenCalledTimes(5);
    for (const [, next] of waiting) next.resolve("data:image/png;base64,AA==");
    for (let round = 0; round < 10 && load.mock.calls.length < 10; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const [, next] of waiting) next.resolve("data:image/png;base64,AA==");
    }
    await Promise.all(shown);
    expect(load).toHaveBeenCalledTimes(10);
  });

  it("asks again after a failure such as a reconnect, but not for an image that is gone", async () => {
    vi.useFakeTimers();
    const flaky = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Transport not connected"))
      .mockResolvedValueOnce("data:image/png;base64,BB==");
    const cache = new DaemonImageCache(flaky, 1_000_000);
    const shown = cache.resolve("photo");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(shown).resolves.toBe("data:image/png;base64,BB==");
    expect(flaky).toHaveBeenCalledTimes(2);

    const gone = vi.fn(async () => {
      throw new MissingImageError("This image is no longer in the battle");
    });
    await expect(new DaemonImageCache(gone, 1_000_000).resolve("photo")).rejects.toThrow(
      "no longer in the battle",
    );
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest images up to its budget and loads an evicted one again", async () => {
    const load = vi.fn(async (key: string) => `data:${key}:${"x".repeat(40)}`);
    const cache = new DaemonImageCache(load, 100);
    await cache.resolve("a");
    await cache.resolve("b");
    await cache.resolve("c");
    await cache.resolve("c");
    expect(load).toHaveBeenCalledTimes(3);
    await cache.resolve("a");
    expect(load).toHaveBeenCalledTimes(4);
  });
});
