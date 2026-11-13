import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  metrics: [] as { type: string; pid: number }[],
  warn: vi.fn(),
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));
vi.mock("electron", () => ({
  app: { getAppMetrics: () => mocks.metrics },
  powerMonitor: mocks.powerMonitor,
}));
vi.mock("electron-log/main", () => ({ default: { warn: mocks.warn } }));

import { setupDarwinCompositorWatchdog, shouldRecoverFromFrameStall } from ".";
import { isExpectedGpuRestart } from "./gpu-restart";

/** A visible, unlocked window whose renderer never produces a frame: the stall the probe detects. */
function stalledWindow() {
  const closedHandlers: (() => void)[] = [];
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    once: (event: string, handler: () => void) => {
      if (event === "closed") closedHandlers.push(handler);
    },
    webContents: {
      executeJavaScript: vi.fn(async () => ({ producedFrame: false, visibilityState: "visible" })),
    },
  };
  return {
    window: window as unknown as BrowserWindow,
    // Stops the probe interval the way closing the window does.
    teardown: () => closedHandlers.forEach((handler) => handler()),
  };
}

describe("compositor-watchdog", () => {
  describe("shouldRecoverFromFrameStall", () => {
    const recoverable = {
      stalledChecks: 3,
      recovering: false,
      msSinceLastRecovery: 120_000,
      consecutiveRecoveries: 0,
    };

    it("recovers once the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall(recoverable)).toBe(true);
    });

    it("waits until the stall threshold is reached", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, stalledChecks: 2 })).toBe(false);
    });

    it("does not recover while a recovery is already in progress", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, recovering: true })).toBe(false);
    });

    it("respects the cooldown between recoveries", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, msSinceLastRecovery: 30_000 })).toBe(
        false,
      );
    });

    it("stops recovering after the consecutive-recovery cap", () => {
      expect(shouldRecoverFromFrameStall({ ...recoverable, consecutiveRecoveries: 3 })).toBe(false);
    });
  });

  describe("recovery", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let kill: Mock;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      vi.useFakeTimers();
      mocks.metrics.length = 0;
      mocks.metrics.push({ type: "GPU", pid: 4242 });
      mocks.warn.mockClear();
      kill = vi.spyOn(process, "kill").mockReturnValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
      kill.mockRestore();
      Object.defineProperty(process, "platform", platform);
    });

    it("kills the stalled GPU process, announces the restart, and logs it", async () => {
      const { window, teardown } = stalledWindow();
      try {
        setupDarwinCompositorWatchdog(window);
        // Three stalled probes, two seconds apart.
        for (let probe = 0; probe < 3; probe++) {
          await vi.advanceTimersByTimeAsync(2_000);
        }

        expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
        // Announced, so the crash reporter does not file this recovery as a crash.
        expect(isExpectedGpuRestart("GPU")).toBe(true);
        // In the log file, not only on stdout, so a later report's tail can explain itself.
        expect(mocks.warn.mock.calls[0]?.[0]).toContain("restarting GPU process");
      } finally {
        teardown();
      }
    });
  });
});
