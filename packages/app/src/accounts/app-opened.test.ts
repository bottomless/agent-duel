import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

import {
  appOpenedSessionOf,
  decideInstallLaunch,
  forgetAppOpenedReportForTests,
  hasHeldSession,
  markSessionHeld,
  reportAppOpenedOnce,
} from "./app-opened";
import type { AppOpenedRequest } from "@getpaseo/protocol/accounts/schemas";
import type { AccountsEndpoint } from "./client";
import type { AccountGate } from "./gate";

const endpoint: AccountsEndpoint = {
  baseUrl: "http://127.0.0.1:7000",
  authHeader: null,
  daemonPassword: "daemon-password",
};

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

const brokenStorage = {
  getItem: async (): Promise<string | null> => {
    throw new Error("storage unavailable");
  },
  setItem: async (): Promise<void> => {
    throw new Error("storage unavailable");
  },
};

function sendStub() {
  return vi.fn(async (_endpoint: AccountsEndpoint, _input: AppOpenedRequest) => {});
}

const fresh = async () => false;
const upgraded = async () => true;

/** A new window load in the same install: a new renderer with the same storage. */
function nextWindowLoad() {
  forgetAppOpenedReportForTests();
}

beforeEach(() => {
  forgetAppOpenedReportForTests();
});

describe("reportAppOpenedOnce", () => {
  it("reports a fresh install's first launch once, then repeats", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    await decideInstallLaunch({ storage, installOpenedBefore: fresh });
    expect(storage.items.get("agent-duel.app-opened-before")).toBe("pending");

    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    await reportAppOpenedOnce({ endpoint, session: "signed-in", storage, send });
    expect(send.mock.calls).toEqual([
      [endpoint, { session: "signed-out", launch: "first", returning: false }],
    ]);
    expect(storage.items.get("agent-duel.app-opened-before")).toBe("1");

    nextWindowLoad();
    // By now this launch has created desktop-settings.json, so the desktop says opened before.
    await decideInstallLaunch({ storage, installOpenedBefore: upgraded });
    await reportAppOpenedOnce({ endpoint, session: "signed-in", storage, send });
    expect(send.mock.calls[1]).toEqual([
      endpoint,
      { session: "signed-in", launch: "repeat", returning: false },
    ]);
  });

  it("reports an upgraded install's first launch of this build as a repeat", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    await decideInstallLaunch({ storage, installOpenedBefore: upgraded });
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(send.mock.calls).toEqual([
      [endpoint, { session: "signed-out", launch: "repeat", returning: false }],
    ]);
  });

  it("keeps the first of a first launch that never reported for a later one", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    // The first launch shows the unreachable screen and reports nothing.
    await decideInstallLaunch({ storage, installOpenedBefore: fresh });

    nextWindowLoad();
    await decideInstallLaunch({ storage, installOpenedBefore: upgraded });
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(send.mock.calls).toEqual([
      [endpoint, { session: "signed-out", launch: "first", returning: false }],
    ]);
  });

  it("reports a repeat from a second window that loads while the first open is in flight", async () => {
    const storage = memoryStorage();
    let answer = () => {};
    const send = vi.fn(
      (_endpoint: AccountsEndpoint, _input: AppOpenedRequest) =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    await decideInstallLaunch({ storage, installOpenedBefore: fresh });
    const first = reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    nextWindowLoad();
    const second = sendStub();
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send: second });
    answer();
    await first;
    expect(send.mock.calls[0]?.[1]).toMatchObject({ launch: "first" });
    expect(second.mock.calls[0]?.[1]).toMatchObject({ launch: "repeat" });
  });

  it("keeps the first when the daemon did not take the report", async () => {
    const storage = memoryStorage();
    const send = sendStub().mockRejectedValueOnce(new Error("daemon unreachable"));
    await decideInstallLaunch({ storage, installOpenedBefore: fresh });
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(storage.items.get("agent-duel.app-opened-before")).toBe("pending");

    nextWindowLoad();
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(send.mock.calls[1]?.[1]).toEqual({
      session: "signed-out",
      launch: "first",
      returning: false,
    });
  });

  it("decides the launch itself when the gate has not", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    // No desktop bridge outside Electron, so the install reads as fresh.
    expect(send.mock.calls[0]?.[1]).toEqual({
      session: "signed-out",
      launch: "first",
      returning: false,
    });
  });

  it("says whether this install has held a session", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    await decideInstallLaunch({ storage, installOpenedBefore: upgraded });
    void markSessionHeld(storage);
    // Read after the mark lands, even when the report starts before the write finishes.
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(send.mock.calls[0]?.[1]).toEqual({
      session: "signed-out",
      launch: "repeat",
      returning: true,
    });
  });

  it("never throws when storage or the report fails", async () => {
    const send = sendStub().mockRejectedValue(new Error("daemon unreachable"));
    await expect(
      decideInstallLaunch({ storage: brokenStorage, installOpenedBefore: fresh }),
    ).resolves.toBeUndefined();
    await expect(
      reportAppOpenedOnce({ endpoint, session: "signed-out", storage: brokenStorage, send }),
    ).resolves.toBeUndefined();
    // An unreadable store reads as a repeat that has never held a session.
    expect(send.mock.calls[0]).toEqual([
      endpoint,
      { session: "signed-out", launch: "repeat", returning: false },
    ]);
  });

  it("reads a launch the desktop cannot answer as a repeat", async () => {
    const storage = memoryStorage();
    const send = sendStub();
    await decideInstallLaunch({
      storage,
      installOpenedBefore: async () => {
        throw new Error("no handler");
      },
    });
    await reportAppOpenedOnce({ endpoint, session: "signed-out", storage, send });
    expect(send.mock.calls[0]?.[1]).toMatchObject({ launch: "repeat" });
  });
});

describe("hasHeldSession", () => {
  it("is false until a session is held, and false on a storage error", async () => {
    const storage = memoryStorage();
    await expect(hasHeldSession(storage)).resolves.toBe(false);
    await markSessionHeld(storage);
    await expect(hasHeldSession(storage)).resolves.toBe(true);
    await expect(markSessionHeld(brokenStorage)).resolves.toBeUndefined();
    await expect(hasHeldSession(brokenStorage)).resolves.toBe(false);
  });
});

describe("appOpenedSessionOf", () => {
  it.each<[AccountGate["kind"], "signed-in" | "signed-out" | null]>([
    ["signed-out", "signed-out"],
    ["signed-in", "signed-in"],
    ["acceptance-required", "signed-in"],
    ["checking", null],
    ["waiting-for-daemon", null],
    ["unreachable", null],
    ["update-required", null],
    ["disabled", null],
  ])("reports %s as %s", (gate, session) => {
    expect(appOpenedSessionOf({ gate, accountsEnabled: true })).toBe(session);
  });

  it("reports nothing unless the control plane said accounts are on", () => {
    expect(appOpenedSessionOf({ gate: "signed-in", accountsEnabled: false })).toBeNull();
    expect(appOpenedSessionOf({ gate: "signed-out", accountsEnabled: false })).toBeNull();
  });
});
