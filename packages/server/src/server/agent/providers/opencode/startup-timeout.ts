export const ARENA_DATABASE_UPGRADE_TIMEOUT_MS = 10 * 60_000;

export function hasArenaDatabaseUpgradeLine(stdout: string): boolean {
  return /(?:^|\n)\[arena-upgrade\] (?:Importing OpenCode 1\.x chats|Removing imported OpenCode 1\.x tables)\r?\n/.test(
    stdout,
  );
}

export function openCodeStartupTimeoutMessage(upgrading: boolean): string {
  if (upgrading) {
    return (
      "Arena did not finish starting within the 10-minute database upgrade limit. " +
      "Startup was stopped during database import or cleanup. Start again to resume the upgrade."
    );
  }
  return "OpenCode server startup timeout";
}
