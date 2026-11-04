import { afterEach, expect, test, vi } from "vitest";
import {
  arenaUpgradeTimeout,
  waitsForArenaEngine,
  type ArenaDatabaseUpgrade,
} from "./arena-upgrade.js";
import { ServerInfoStatusPayloadSchema, DaemonGetStatusResponseSchema } from "./messages.js";

afterEach(() => vi.useRealTimers());

test("upgrade status survives the existing daemon status schemas", () => {
  const upgrade = { startedAt: 1000, deadline: 601000 };
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "test",
      arenaDatabaseUpgrade: upgrade,
    }).arenaDatabaseUpgrade,
  ).toEqual(upgrade);
  expect(
    DaemonGetStatusResponseSchema.parse({
      type: "daemon.get_status.response",
      payload: {
        requestId: "test",
        serverId: "test",
        pid: 1,
        nodePath: "node",
        listen: null,
        providers: [],
        arenaDatabaseUpgrade: upgrade,
      },
    }).payload.arenaDatabaseUpgrade,
  ).toEqual(upgrade);
});

test("only engine-dependent RPCs use the upgrade deadline", () => {
  for (const type of [
    "fetch_agent_request",
    "fetch_agent_timeline_request",
    "send_agent_message_request",
    "refresh_providers_snapshot_request",
    "arena.turn.start.request",
    "arena.session.resolve.request",
  ])
    expect(waitsForArenaEngine(type)).toBe(true);
  for (const type of [
    "daemon.get_status.request",
    "arena.byok.key.set.request",
    "ping",
    "get_daemon_config_request",
  ])
    expect(waitsForArenaEngine(type)).toBe(false);
});

test("ordinary deadlines stay unchanged and cancel removes the subscription", async () => {
  vi.useFakeTimers();
  const fired = vi.fn();
  const unsubscribed = vi.fn();
  const cancel = arenaUpgradeTimeout({
    timeoutMs: 60_000,
    getUpgrade: () => null,
    subscribe: () => unsubscribed,
    onTimeout: fired,
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(fired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fired).toHaveBeenCalledOnce();
  cancel();
  expect(unsubscribed).toHaveBeenCalledOnce();
});

test("an upgrade arriving during a wait extends through readiness, without resetting its absolute deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let upgrade: ArenaDatabaseUpgrade | null = null;
  let changed = () => {};
  const fired = vi.fn();
  const cancel = arenaUpgradeTimeout({
    timeoutMs: 60_000,
    getUpgrade: () => upgrade,
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
    onTimeout: fired,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  upgrade = { startedAt: 0, deadline: 600_000 };
  changed();
  await vi.advanceTimersByTimeAsync(580_000);
  upgrade = null;
  changed();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(fired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fired).toHaveBeenCalledOnce();
  cancel();
});
