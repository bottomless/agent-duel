import { afterEach, expect, test, vi } from "vitest";
import {
  runProviderRefreshWithDeadline,
  raceProviderRefreshAbort,
} from "./provider-refresh-deadline.js";
import { setArenaDatabaseUpgrade } from "./providers/opencode/arena-upgrade.js";

const owner = {};
afterEach(() => {
  setArenaDatabaseUpgrade(owner, null);
  vi.useRealTimers();
});

test.each([true, false])(
  "provider refresh only extends for the Arena provider: %s",
  async (arena) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending = runProviderRefreshWithDeadline({
      label: "test",
      timeoutMs: 120_000,
      arena,
      operation: (context) => raceProviderRefreshAbort(context.signal, new Promise(() => {})),
    });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    setArenaDatabaseUpgrade(owner, { startedAt: 0, deadline: 600_000 });
    let settled = false;
    void outcome.then(() => {
      settled = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(settled).toBe(!arena);
    if (arena) {
      setArenaDatabaseUpgrade(owner, null);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await outcome).toBeInstanceOf(Error);
    expect(settled).toBe(true);
  },
);
