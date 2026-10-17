import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonImageCache,
  MissingImageError,
  onDaemonReconnect,
  watchDaemonClients,
  watchDaemonConnection,
} from "./daemon-image-cache";

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

  it("keeps an image on screen past the budget, and lets it go once it is hidden", async () => {
    const load = vi.fn(async (key: string) => `data:${key}:${"x".repeat(40)}`);
    const cache = new DaemonImageCache(load, 100);
    await cache.resolve("shown", true);
    await cache.resolve("b");
    await cache.resolve("c");
    await cache.resolve("shown");
    expect(load).toHaveBeenCalledTimes(3);

    // Hidden, it is evicted like any other once newer images fill the budget.
    cache.hide("shown");
    await cache.resolve("d");
    await cache.resolve("e");
    await cache.resolve("shown");
    expect(load).toHaveBeenCalledTimes(6);
  });

  it("tells listeners when a daemon connection comes back, not while it stays up", () => {
    const listeners: Array<(state: { status: string }) => void> = [];
    const client = {
      isConnected: true,
      subscribeConnectionStatus: (listener: (state: { status: string }) => void) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const reconnected = vi.fn();
    const off = onDaemonReconnect(reconnected);
    watchDaemonConnection(client);
    watchDaemonConnection(client);
    expect(listeners).toHaveLength(1);

    listeners[0]!({ status: "connected" });
    listeners[0]!({ status: "disconnected" });
    listeners[0]!({ status: "connecting" });
    listeners[0]!({ status: "connected" });
    expect(reconnected).toHaveBeenCalledTimes(1);
    off();
  });

  it("keeps an image shown from before it loads, so its own arrival cannot evict it", async () => {
    const load = vi.fn(async (key: string) => `data:${key}:${"x".repeat(60)}`);
    const cache = new DaemonImageCache(load, 100);
    await cache.resolve("a", true);
    await cache.resolve("b", true);
    await cache.resolve("b");
    await cache.resolve("a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks a waiting image at once when a daemon is reachable again", async () => {
    vi.useFakeTimers();
    const listeners: Array<(state: { status: string }) => void> = [];
    watchDaemonConnection({
      isConnected: false,
      subscribeConnectionStatus: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Transport not connected"))
      .mockRejectedValueOnce(new Error("Transport not connected"))
      .mockResolvedValueOnce("data:image/png;base64,CC==");
    const shown = new DaemonImageCache(load, 1_000_000).resolve("photo");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    // Now waiting 3 s; the connection is back after 100 ms.
    await vi.advanceTimersByTimeAsync(100);
    listeners.at(-1)!({ status: "connected" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(shown).resolves.toBe("data:image/png;base64,CC==");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("counts a session's new client as its daemon coming back once it connects", () => {
    const client = () => {
      const listeners: Array<(state: { status: string }) => void> = [];
      return {
        listeners,
        isConnected: true,
        subscribeConnectionStatus: (listener: (state: { status: string }) => void) => {
          listeners.push(listener);
          listener({ status: "connected" });
          return () => {};
        },
      };
    };
    const first = client();
    let sessions: Array<readonly [string, ReturnType<typeof client>]> = [["server", first]];
    let changed = () => {};
    const reachable = vi.fn();
    const off = onDaemonReconnect(reachable);
    watchDaemonClients(
      () => sessions,
      (listener) => {
        changed = listener;
      },
    );
    expect(reachable).not.toHaveBeenCalled();

    sessions = [["server", client()]];
    changed();
    expect(reachable).toHaveBeenCalledTimes(1);
    off();
  });
});
