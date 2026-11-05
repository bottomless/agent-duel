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

/** Only complete, exact engine stdout lines can change the background-import state. */
export function arenaBackgroundImportLine(line: string): boolean | undefined {
  if (
    line ===
    "[arena-upgrade] Import startup budget exhausted; startup continues with import in the background"
  )
    return true;
  if (
    line === "[arena-upgrade] Background import finished" ||
    line === "[arena-upgrade] Background import failed"
  )
    return false;
  return undefined;
}
