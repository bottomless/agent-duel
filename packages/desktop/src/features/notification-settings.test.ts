import { describe, expect, it } from "vitest";
import { openNotificationSettings } from "./notification-settings.js";

const base = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
describe("macOS notification settings", () => {
  it.each([false, true])("opens the correct bundle, packaged=%s", async (isPackaged) => {
    const urls: string[] = [];
    await openNotificationSettings({
      isPackaged,
      openExternal: async (url) => {
        urls.push(url);
      },
    });
    expect(urls).toEqual([`${base}?id=sh.paseo.desktop${isPackaged ? "" : ".dev"}`]);
  });
  it("falls back to Notifications when the app destination fails", async () => {
    const urls: string[] = [];
    await openNotificationSettings({
      isPackaged: false,
      openExternal: async (url) => {
        urls.push(url);
        if (urls.length === 1) throw new Error("unavailable destination");
      },
    });
    expect(urls).toEqual([`${base}?id=sh.paseo.desktop.dev`, base]);
  });
  it("reports failure when both destinations fail", async () => {
    const urls: string[] = [];
    await expect(
      openNotificationSettings({
        isPackaged: false,
        openExternal: async (url) => {
          urls.push(url);
          throw new Error("settings unavailable");
        },
      }),
    ).rejects.toThrow("settings unavailable");
    expect(urls).toEqual([`${base}?id=sh.paseo.desktop.dev`, base]);
  });
});
