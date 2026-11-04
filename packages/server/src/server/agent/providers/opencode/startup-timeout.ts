export const ARENA_DATABASE_UPGRADE_TIMEOUT_MS = 10 * 60_000;

export function hasArenaDatabaseUpgradeLine(stdout: string): boolean {
  return /(?:^|\n)\[arena-upgrade\] (?:Backing up databases before OpenCode 2\.0|Removing imported OpenCode 1\.x tables)\r?\n/.test(
    stdout,
  );
}

export function openCodeStartupTimeoutMessage(upgrading: boolean): string {
  if (upgrading) {
    return (
      "Arena did not finish starting within the 10-minute database upgrade limit. " +
      "Startup was stopped during database backup, import or cleanup. A complete backup is required to upgrade; do not skip it."
    );
  }
  return "OpenCode server startup timeout";
}
