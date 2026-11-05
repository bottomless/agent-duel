import { expect, test } from "vitest";
import { databaseUpgradeNotice } from "./database-upgrade-notice";
import { toDaemonServerInfo, useSessionStore } from "@/stores/session-store";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";

test("daemon status shows the upgrade message until the engine is ready", () => {
  const status = (arenaDatabaseUpgrade: { startedAt: number; deadline: number } | null) => ({
    serverInfo: toDaemonServerInfo(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "test",
        arenaDatabaseUpgrade,
      }),
    ),
  });
  expect(databaseUpgradeNotice([status(null)])).toBeNull();
  expect(databaseUpgradeNotice([status({ startedAt: 0, deadline: 600_000 })])).toBe(
    "Upgrading your database. Keep the app open until this finishes. This can take a few minutes.",
  );
  expect(databaseUpgradeNotice([status(null)])).toBeNull();
});

test("stored background-only status changes keep the sidebar notice until import ends", () => {
  const serverId = "background-import-test";
  const info = { serverId, hostname: "test", version: "2" };
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null!);
  try {
    const upgrade = { startedAt: 0, deadline: 600_000 };
    store.updateSessionServerInfo(serverId, { ...info, arenaDatabaseUpgrade: upgrade });
    const startup = useSessionStore.getState().sessions[serverId];
    store.updateSessionServerInfo(serverId, {
      ...info,
      arenaDatabaseUpgrade: { ...upgrade, backgroundImport: true },
    });
    const background = useSessionStore.getState().sessions[serverId];
    expect(background).not.toBe(startup);
    expect(background.serverInfo?.arenaDatabaseUpgrade?.backgroundImport).toBe(true);
    expect(databaseUpgradeNotice([background])).toBe(
      "Upgrading your database. Keep the app open until this finishes. This can take a few minutes.",
    );
    store.updateSessionServerInfo(serverId, { ...info, arenaDatabaseUpgrade: null });
    expect(databaseUpgradeNotice([useSessionStore.getState().sessions[serverId]])).toBeNull();
  } finally {
    store.clearSession(serverId);
  }
});
