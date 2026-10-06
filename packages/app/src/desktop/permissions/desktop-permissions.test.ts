import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { i18n } from "@/i18n/i18next";
import {
  createDesktopPermissions,
  type DesktopPermissionEnvironment,
  type NavigatorLike,
  type NotificationConstructorLike,
} from "./desktop-permissions";

interface FakeEnvironmentInput {
  isWeb?: boolean;
  desktopHost?: DesktopHostBridge | null;
  notification?: NotificationConstructorLike | null;
  navigator?: NavigatorLike | null;
}

function fakeEnvironment(input: FakeEnvironmentInput = {}): DesktopPermissionEnvironment {
  return {
    isWeb: input.isWeb ?? true,
    getDesktopHost: () => input.desktopHost ?? null,
    getNotification: () => input.notification ?? null,
    getNavigator: () => input.navigator ?? null,
  };
}

describe("desktop-permissions", () => {
  it("shows section only in desktop web runtime", () => {
    expect(
      createDesktopPermissions(
        fakeEnvironment({ isWeb: false }),
      ).shouldShowDesktopPermissionSection(),
    ).toBe(false);

    expect(
      createDesktopPermissions(
        fakeEnvironment({ isWeb: true, desktopHost: null }),
      ).shouldShowDesktopPermissionSection(),
    ).toBe(false);

    expect(
      createDesktopPermissions(
        fakeEnvironment({ isWeb: true, desktopHost: {} as DesktopHostBridge }),
      ).shouldShowDesktopPermissionSection(),
    ).toBe(true);
  });

  it("reads notification and microphone status", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        notification: { permission: "default" },
        navigator: {
          permissions: {
            query: vi.fn(async () => ({ state: "granted" })),
          },
          mediaDevices: {
            getUserMedia: vi.fn(),
          },
        },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("prompt");
    expect(snapshot.microphone.state).toBe("granted");
    expect(snapshot.checkedAt).toBeTypeOf("number");
  });

  it.each(["granted", "denied", "default"])(
    "keeps native permission system-managed when Chromium reports %s",
    async (permission) => {
      const permissions = createDesktopPermissions(
        fakeEnvironment({
          desktopHost: { notification: { isSupported: async () => true } },
          notification: { permission },
        }),
      );

      const snapshot = await permissions.getDesktopPermissionSnapshot();

      expect(snapshot.notifications.state).toBe("system-managed");
      expect(snapshot.notifications.detail).toContain("System Settings");
    },
  );

  it("reports unavailable native notifications even if Chromium grants permission", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        desktopHost: { notification: { isSupported: async () => false } },
        notification: { permission: "granted" },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("unavailable");
  });

  it("does not fall back to Chromium permission when the native check fails", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        desktopHost: {
          notification: {
            isSupported: async () => {
              throw new Error("IPC unavailable");
            },
          },
        },
        notification: { permission: "granted" },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("unknown");
    expect(snapshot.notifications.detail).toContain("refreshing");
  });

  it("does not use Chromium permission when the desktop notification bridge is absent", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        desktopHost: {},
        notification: { permission: "granted" },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("unavailable");
  });

  it("does not request Chromium permission for native notifications", async () => {
    const requestPermission = vi.fn(async () => "granted");
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        desktopHost: { notification: { isSupported: async () => true } },
        notification: { requestPermission },
      }),
    );

    const result = await permissions.requestDesktopPermission({ kind: "notifications" });

    expect(result.state).toBe("system-managed");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("queries microphone permission with correct Permissions instance binding", async () => {
    const permissionsApi = {
      query(this: unknown, _descriptor: { name: string }) {
        if (this !== permissionsApi) {
          throw new TypeError("Can only call Permissions.query on instances of Permissions");
        }
        return Promise.resolve({ state: "granted" as const });
      },
    };

    const permissions = createDesktopPermissions(
      fakeEnvironment({
        navigator: {
          permissions: permissionsApi,
          mediaDevices: { getUserMedia: vi.fn() },
        },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.microphone.state).toBe("granted");
  });

  it("returns a fallback message when runtime blocks Permissions.query", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        navigator: {
          permissions: {
            query: vi.fn(async () => {
              throw new TypeError("Can only call Permissions.query on instances of Permissions");
            }),
          },
          mediaDevices: { getUserMedia: vi.fn() },
        },
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.microphone.state).toBe("unknown");
    expect(snapshot.microphone.detail).toContain(
      "Microphone status API is unavailable in this runtime.",
    );
  });

  it("requests notification permission via the browser Notification API", async () => {
    const fakeNotification: NotificationConstructorLike = {
      permission: "default",
      requestPermission: vi.fn(async () => "granted"),
    };

    const permissions = createDesktopPermissions(
      fakeEnvironment({ notification: fakeNotification }),
    );
    const result = await permissions.requestDesktopPermission({ kind: "notifications" });

    expect(result.state).toBe("granted");
    expect(fakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("reads browser Notification permission when available", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        notification: { permission: "denied" },
        navigator: {},
      }),
    );

    const snapshot = await permissions.getDesktopPermissionSnapshot();

    expect(snapshot.notifications.state).toBe("denied");
  });

  it("requests microphone permission and stops acquired tracks", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }));
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        navigator: {
          permissions: {
            query: vi.fn(async () => ({ state: "granted" })),
          },
          mediaDevices: { getUserMedia },
        },
      }),
    );

    const result = await permissions.requestDesktopPermission({ kind: "microphone" });

    expect(result.state).toBe("granted");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("maps microphone request denial to denied status", async () => {
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        navigator: {
          mediaDevices: {
            getUserMedia: vi.fn(async () => {
              throw { name: "NotAllowedError", message: "denied" };
            }),
          },
        },
      }),
    );

    const result = await permissions.requestDesktopPermission({ kind: "microphone" });

    expect(result.state).toBe("denied");
  });

  it("uses the active app language for local status details", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      const permissions = createDesktopPermissions(
        fakeEnvironment({
          notification: { permission: "granted" },
          navigator: {
            permissions: {
              query: vi.fn(async () => ({ state: "prompt" })),
            },
            mediaDevices: { getUserMedia: vi.fn() },
          },
        }),
      );

      const snapshot = await permissions.getDesktopPermissionSnapshot();

      expect(snapshot.notifications.detail).toBe("系统已允许通知。");
      expect(snapshot.microphone.detail).toBe("麦克风权限尚未授予。");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

it.each([
  ["authorized", "granted"],
  ["provisional", "granted"],
  ["denied", "denied"],
  ["not-determined", "prompt"],
  ["unknown", "unknown"],
] as const)("maps macOS %s to %s instead of Chromium permission", async (native, expected) => {
  const permissions = createDesktopPermissions(
    fakeEnvironment({
      desktopHost: {
        platform: "darwin",
        notification: { isSupported: async () => true, getPermission: async () => native },
      },
      notification: { permission: "granted" },
    }),
  );
  expect((await permissions.getDesktopPermissionSnapshot()).notifications.state).toBe(expected);
});

it("maps failed native reads to unknown, never Chromium granted", async () => {
  const permissions = createDesktopPermissions(
    fakeEnvironment({
      desktopHost: {
        platform: "darwin",
        notification: {
          isSupported: async () => true,
          getPermission: async () => {
            throw new Error("query failed");
          },
        },
      },
      notification: { permission: "granted" },
    }),
  );
  expect((await permissions.getDesktopPermissionSnapshot()).notifications.state).toBe("unknown");
});

it.each(["authorized", "denied"] as const)(
  "returns the native %s decision from the initial prompt",
  async (decision) => {
    let requests = 0;
    const permissions = createDesktopPermissions(
      fakeEnvironment({
        desktopHost: {
          platform: "darwin",
          notification: {
            isSupported: async () => true,
            getPermission: async () => "not-determined",
            requestPermission: async () => {
              requests++;
              return decision;
            },
          },
        },
      }),
    );
    expect((await permissions.requestDesktopPermission({ kind: "notifications" })).state).toBe(
      decision === "authorized" ? "granted" : "denied",
    );
    expect(requests).toBe(1);
  },
);
