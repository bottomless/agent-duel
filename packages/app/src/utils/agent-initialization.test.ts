import { afterEach, expect, test, vi } from "vitest";
import type { ArenaDatabaseUpgrade } from "@getpaseo/protocol/arena-upgrade";
import {
  createInitDeferred,
  refreshInitTimeout,
  resolveInitDeferred,
} from "./agent-initialization";

afterEach(() => vi.useRealTimers());
test.each([false, true])(
  "history initialization only extends during an upgrade: %s",
  async (upgrading) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deferred = createInitDeferred("test", "tail");
    let upgrade: ArenaDatabaseUpgrade | null = null;
    let changed = () => {};
    const expired = vi.fn();
    refreshInitTimeout({
      key: "test",
      onTimeout: expired,
      upgrade: {
        getUpgrade: () => upgrade,
        subscribe: (listener) => {
          changed = listener;
          return () => {};
        },
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    if (upgrading) {
      upgrade = { startedAt: 0, deadline: 600_000 };
      changed();
    }
    await vi.advanceTimersByTimeAsync(55_000);
    expect(expired).toHaveBeenCalledTimes(upgrading ? 0 : 1);
    if (upgrading) {
      upgrade = null;
      changed();
      await vi.advanceTimersByTimeAsync(599_999);
      expect(expired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(expired).toHaveBeenCalledOnce();
    }
    resolveInitDeferred("test");
    await deferred.promise;
  },
);
