import { describe, expect, it, vi } from "vitest";

import {
  applyMacWindowControlsUpdate,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  getMainWindowChromeOptions,
  readWindowChromeUpdate,
  readWindowTheme,
  resolveWindowBounds,
  settleRestoredWindowSize,
} from "./window-manager";

describe("window-manager", () => {
  describe("readWindowTheme", () => {
    it("accepts supported title bar themes", () => {
      expect(readWindowTheme("light")).toBe("light");
      expect(readWindowTheme("dark")).toBe("dark");
    });

    it("rejects invalid title bar themes", () => {
      expect(readWindowTheme(undefined)).toBeNull();
      expect(readWindowTheme("auto")).toBeNull();
      expect(readWindowTheme("system")).toBeNull();
    });
  });

  describe("readWindowChromeUpdate", () => {
    it("accepts partial runtime overlay updates", () => {
      expect(
        readWindowChromeUpdate({
          backgroundColor: "#181B1A",
          trafficLightOffsetY: -5,
        }),
      ).toEqual({
        backgroundColor: "#181B1A",
        trafficLightOffsetY: -5,
      });
    });

    it("rejects empty and invalid payloads", () => {
      expect(readWindowChromeUpdate(undefined)).toBeNull();
      expect(readWindowChromeUpdate({})).toBeNull();
      expect(readWindowChromeUpdate({ backgroundColor: 12 })).toBeNull();
      expect(readWindowChromeUpdate({ trafficLightOffsetY: -11 })).toBeNull();
    });

    it("preserves fractional traffic-light offsets", () => {
      expect(readWindowChromeUpdate({ trafficLightOffsetY: 1.5 })).toEqual({
        trafficLightOffsetY: 1.5,
      });
    });
  });

  describe("applyMacWindowControlsUpdate", () => {
    it("uses the focus and normal traffic-light positions", () => {
      const setWindowButtonPosition = vi.fn();

      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: -5 },
      });
      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: 0.5 },
      });

      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(1, { x: 16, y: 9 });
      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(2, { x: 16, y: 14.5 });
    });
  });

  describe("getMainWindowChromeOptions", () => {
    it("uses renderer-painted controls on windows", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "custom-windows",
        }),
      ).toEqual({
        frame: false,
        autoHideMenuBar: true,
      });
    });

    it("uses renderer-painted controls on linux", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "custom-linux",
        }),
      ).toEqual({
        frame: false,
        autoHideMenuBar: true,
      });
    });

    it("keeps the mac traffic-light path separate", () => {
      expect(
        getMainWindowChromeOptions({
          mode: "native-mac",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: true,
        trafficLightPosition: { x: 16, y: 14 },
      });
    });
  });

  describe("resolveWindowBounds", () => {
    it("falls back to the default size when no state is saved", () => {
      expect(resolveWindowBounds(null)).toEqual({
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
      });
    });

    it("restores the full size and position", () => {
      expect(
        resolveWindowBounds({ x: 120, y: 80, width: 1024, height: 720, isMaximized: false }),
      ).toEqual({ width: 1024, height: 720, x: 120, y: 80 });
    });

    it("omits the position when only the size was persisted", () => {
      expect(resolveWindowBounds({ width: 1024, height: 720, isMaximized: true })).toEqual({
        width: 1024,
        height: 720,
      });
    });
  });

  describe("settleRestoredWindowSize", () => {
    // Mimics Windows at 168%: every requested size comes out 5x4 larger.
    function overshootingWindow(initial: Electron.Rectangle) {
      let bounds = initial;
      return {
        getNormalBounds: () => ({ ...bounds }),
        setBounds: vi.fn((next: Partial<Electron.Rectangle>) => {
          bounds = {
            ...bounds,
            ...next,
            width: (next.width ?? bounds.width) + 5,
            height: (next.height ?? bounds.height) + 4,
          };
        }),
      };
    }

    it("takes the overshoot off so the restored size stays the same across relaunches", () => {
      const win = overshootingWindow({ x: 358, y: 214, width: 1205, height: 804 });

      settleRestoredWindowSize(win, { width: 1200, height: 800 });

      expect(win.getNormalBounds()).toEqual({ x: 358, y: 214, width: 1200, height: 800 });
    });

    it("leaves a window that already has the restored size alone", () => {
      const win = overshootingWindow({ x: 0, y: 0, width: 1200, height: 800 });

      settleRestoredWindowSize(win, { width: 1200, height: 800 });

      expect(win.setBounds).not.toHaveBeenCalled();
    });
  });
});
