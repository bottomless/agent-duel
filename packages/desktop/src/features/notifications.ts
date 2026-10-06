import path from "node:path";
import { existsSync } from "node:fs";
import { app, BrowserWindow, Notification, ipcMain, nativeImage, shell } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";

import { openNotificationSettings } from "./notification-settings.js";

import { createMacNotificationDelivery } from "./mac-notification-delivery.js";
import {
  getNativeNotificationBridge,
  notificationPermissions,
} from "./notification-permissions.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

const activeNotifications = new Set<Notification>();

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationIcon(): Electron.NativeImage | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return null;
}

function focusSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

export function registerNotificationHandlers(): void {
  let sendMacNotification: ReturnType<typeof createMacNotificationDelivery> | null = null;
  try {
    if (process.platform === "darwin")
      sendMacNotification = createMacNotificationDelivery(
        getNativeNotificationBridge(),
        ({ windowId, data }) => {
          const win =
            (windowId === undefined ? null : BrowserWindow.fromId(windowId)) ??
            BrowserWindow.getAllWindows()[0];
          if (!win || win.isDestroyed()) return;
          focusSenderWindow(win.webContents);
          if (data && Object.keys(data).length > 0) {
            win.webContents.send("paseo:event:notification-click", { data });
          }
        },
      );
  } catch (error) {
    console.error("[notifications] Native notification initialization failed", error);
  }

  ipcMain.handle("paseo:notification:getPermission", () => notificationPermissions.getPermission());
  ipcMain.handle("paseo:notification:requestPermission", () =>
    notificationPermissions.requestPermission(),
  );
  ipcMain.handle("paseo:notification:openSettings", async () => {
    if (process.platform !== "darwin") throw new Error("Notification settings require macOS");
    await openNotificationSettings({
      isPackaged: app.isPackaged,
      openExternal: (url) => shell.openExternal(url),
    });
  });
  ipcMain.handle("paseo:notification:isSupported", () => {
    return Notification.isSupported();
  });

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      return false;
    }

    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const settings = await getDesktopSettingsStore().get();
    if (process.platform === "darwin" && !(await notificationPermissions.canSend())) return false;
    if (process.platform === "darwin") {
      if (!sendMacNotification) throw new Error("Native notification bridge unavailable");
      return sendMacNotification({
        title,
        body,
        silent: !settings.notifications.playSound,
        route: { windowId: BrowserWindow.fromWebContents(event.sender)?.id, data },
      });
    }
    const icon = getNotificationIcon();
    const notification = new Notification({
      title,
      ...(body ? { body } : {}),
      ...(icon ? { icon } : {}),
      silent: !settings.notifications.playSound,
    });

    activeNotifications.add(notification);

    notification.on("click", () => {
      const win = focusSenderWindow(event.sender);
      if (win && data && Object.keys(data).length > 0) {
        const payload: NotificationClickPayload = { data };
        win.webContents.send("paseo:event:notification-click", payload);
      }
      activeNotifications.delete(notification);
    });

    notification.on("close", () => {
      activeNotifications.delete(notification);
    });

    notification.show();
    return true;
  });
}
