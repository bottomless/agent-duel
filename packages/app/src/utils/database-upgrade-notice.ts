import type { DaemonServerInfo } from "@/stores/session-store";

export function databaseUpgradeNotice(
  sessions: readonly { serverInfo: DaemonServerInfo | null }[],
): string | null {
  return sessions.some((session) => session.serverInfo?.arenaDatabaseUpgrade)
    ? "Upgrading your database. This can take a few minutes."
    : null;
}
