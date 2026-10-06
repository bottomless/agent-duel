import path from "node:path";
import type { MacNotificationPort } from "./mac-notification-delivery.js";

export type NotificationPermission =
  | "authorized"
  | "denied"
  | "not-determined"
  | "provisional"
  | "unknown";
export interface NotificationPermissionPort {
  getPermission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
}

export function createNotificationPermissions(load: () => NotificationPermissionPort) {
  let pendingRead: Promise<NotificationPermission> | null = null;
  let pendingRequest: Promise<NotificationPermission> | null = null;
  const getPermission = (): Promise<NotificationPermission> => {
    pendingRead ??= Promise.resolve()
      .then(() => load().getPermission())
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  };
  return {
    getPermission,
    requestPermission(): Promise<NotificationPermission> {
      pendingRequest ??= (async () => {
        const current = await getPermission();
        if (current !== "not-determined") return current;
        try {
          return await load().requestPermission();
        } catch (error) {
          // macOS can report Don't Allow as an authorization error. Read the
          // settled status before treating the user's decision as a failure.
          if ((await load().getPermission()) === "denied") return "denied";
          throw error;
        }
      })().finally(() => {
        pendingRequest = null;
      });
      return pendingRequest;
    },
    async canSend(): Promise<boolean> {
      const permission = await load().getPermission();
      return permission === "authorized" || permission === "provisional";
    },
  };
}

type NativeNotificationBridge = NotificationPermissionPort & MacNotificationPort;
let native: NativeNotificationBridge | undefined;
export function getNativeNotificationBridge(): NativeNotificationBridge {
  if (process.platform !== "darwin") throw new Error("Notification permissions require macOS");
  native ??= require(
    path.join(__dirname, "../native/notification-permissions.node"),
  ) as NativeNotificationBridge;
  return native;
}
export const notificationPermissions = createNotificationPermissions(getNativeNotificationBridge);
