/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DesktopNotificationPermission } from "@/desktop/host";
import { useDesktopPermissions } from "./use-desktop-permissions";

const previousHost = window.paseoDesktop;
afterEach(() => {
  cleanup();
  window.paseoDesktop = previousHost;
});

function installPermissionReader(read: () => Promise<DesktopNotificationPermission>) {
  window.paseoDesktop = {
    platform: "darwin",
    notification: { isSupported: async () => true, getPermission: read },
  };
}

it("refreshes the actual permission after returning from System Settings", async () => {
  let permission: DesktopNotificationPermission = "authorized";
  installPermissionReader(async () => permission);
  const { result } = renderHook(useDesktopPermissions);
  await waitFor(() => expect(result.current.snapshot?.notifications.state).toBe("granted"));
  permission = "denied";
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(result.current.snapshot?.notifications.state).toBe("denied"));
  permission = "authorized";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(result.current.snapshot?.notifications.state).toBe("granted"));
});

it("does not let an older refresh replace the latest macOS permission", async () => {
  const replies: Array<(value: DesktopNotificationPermission) => void> = [];
  installPermissionReader(
    () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  );
  const { result } = renderHook(useDesktopPermissions);
  await waitFor(() => expect(replies).toHaveLength(1));
  act(() => {
    void result.current.refreshPermissions();
  });
  await waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => {
    replies[1]("denied");
  });
  expect(result.current.snapshot?.notifications.state).toBe("denied");
  await act(async () => {
    replies[0]("authorized");
  });
  expect(result.current.snapshot?.notifications.state).toBe("denied");
  expect(result.current.isRefreshing).toBe(false);
});

it("removes focus listeners and ignores pending reads after unmount", async () => {
  const replies: Array<(value: DesktopNotificationPermission) => void> = [];
  installPermissionReader(
    () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  );
  const { result, unmount } = renderHook(useDesktopPermissions);
  await waitFor(() => expect(replies).toHaveLength(1));
  unmount();
  await act(async () => {
    replies[0]("authorized");
    await result.current.refreshPermissions();
    window.dispatchEvent(new Event("focus"));
  });
  expect(replies).toHaveLength(1);
  expect(result.current.snapshot).toBeNull();
});

it("keeps the test pending until native acceptance and shows native send failures", async () => {
  let rejectSend!: (error: Error) => void;
  window.paseoDesktop = {
    platform: "darwin",
    notification: {
      isSupported: async () => true,
      getPermission: async () => "authorized",
      sendNotification: () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    },
  };
  const { result } = renderHook(useDesktopPermissions);
  await waitFor(() => expect(result.current.snapshot?.notifications.state).toBe("granted"));
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.sendTestNotification();
  });
  expect(result.current.testNotificationState.status).toBe("sending");
  await act(async () => {
    rejectSend(new Error("macOS rejected delivery"));
    await sending;
  });
  expect(result.current.testNotificationState.status).toBe("error");
});
