import { describe, expect, it } from "vitest";
import {
  createNotificationPermissions,
  type NotificationPermission,
} from "./notification-permissions.js";

function harness(initial: NotificationPermission) {
  let permission = initial;
  let requests = 0;
  const permissions = createNotificationPermissions(() => ({
    getPermission: async () => permission,
    requestPermission: async () => {
      requests++;
      permission = "authorized";
      return permission;
    },
  }));
  return {
    permissions,
    requests: () => requests,
    set: (next: NotificationPermission) => {
      permission = next;
    },
  };
}

describe("native notification permission policy", () => {
  it.each(["denied", "not-determined", "unknown"] as const)(
    "prevents sending when %s",
    async (state) => {
      expect(await harness(state).permissions.canSend()).toBe(false);
    },
  );
  it.each(["authorized", "provisional"] as const)("allows sending when %s", async (state) => {
    expect(await harness(state).permissions.canSend()).toBe(true);
  });
  it("checks current permission again before another send", async () => {
    const h = harness("authorized");
    expect(await h.permissions.canSend()).toBe(true);
    h.set("denied");
    expect(await h.permissions.canSend()).toBe(false);
  });
  it("does not reuse an earlier in-flight settings read for a send", async () => {
    let finishRead!: (permission: NotificationPermission) => void;
    let reads = 0;
    const permissions = createNotificationPermissions(() => ({
      getPermission: () => {
        reads++;
        return reads === 1
          ? new Promise((resolve) => {
              finishRead = resolve;
            })
          : Promise.resolve("denied");
      },
      requestPermission: async () => "denied",
    }));
    const earlier = permissions.getPermission();
    await Promise.resolve();
    expect(await permissions.canSend()).toBe(false);
    finishRead("authorized");
    expect(await earlier).toBe("authorized");
  });
  it("allows retrying a failed permission request", async () => {
    let requests = 0;
    const permissions = createNotificationPermissions(() => ({
      getPermission: async () => "not-determined",
      requestPermission: async () => {
        if (++requests === 1) throw new Error("request failed");
        return "denied";
      },
    }));
    await expect(permissions.requestPermission()).rejects.toThrow("request failed");
    expect(await permissions.requestPermission()).toBe("denied");
    expect(requests).toBe(2);
  });
  it("returns denial when macOS reports the user's rejection as a request error", async () => {
    let permission: NotificationPermission = "not-determined";
    const permissions = createNotificationPermissions(() => ({
      getPermission: async () => permission,
      requestPermission: async () => {
        permission = "denied";
        throw new Error("Unable to read notification permission");
      },
    }));
    await expect(permissions.requestPermission()).resolves.toBe("denied");
    expect(await permissions.canSend()).toBe(false);
  });
  it("requests initial permission once for concurrent clicks", async () => {
    const h = harness("not-determined");
    expect(
      await Promise.all([h.permissions.requestPermission(), h.permissions.requestPermission()]),
    ).toEqual(["authorized", "authorized"]);
    expect(h.requests()).toBe(1);
  });
  it("does not request again after denial", async () => {
    const h = harness("denied");
    expect(await h.permissions.requestPermission()).toBe("denied");
    expect(h.requests()).toBe(0);
  });
  it("propagates a native load failure without claiming permission", async () => {
    const permissions = createNotificationPermissions(() => {
      throw new Error("module unavailable");
    });
    await expect(permissions.getPermission()).rejects.toThrow("module unavailable");
    await expect(permissions.canSend()).rejects.toThrow("module unavailable");
  });
});
