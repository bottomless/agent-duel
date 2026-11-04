import { expect, test } from "vitest";
import { databaseUpgradeNotice } from "./database-upgrade-notice";
import { toDaemonServerInfo } from "@/stores/session-store";
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
    "Upgrading your database. This can take a few minutes.",
  );
  expect(databaseUpgradeNotice([status(null)])).toBeNull();
});
