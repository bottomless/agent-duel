/** The backup runs before import and emits these lines at its start and successful completion. */
export function openCodeStartupTimeoutMessage(arena: boolean, stdout: string): string {
  if (
    arena &&
    stdout.includes("[arena-upgrade] Backing up databases before OpenCode 2.0\n") &&
    !stdout.includes("[arena-upgrade] Backed up the 1.x databases to ")
  ) {
    return (
      "Arena's pre-upgrade database backup did not report completion within the 30-second engine startup limit. " +
      "Startup was stopped. A complete backup is required to upgrade; do not skip it."
    );
  }
  return "OpenCode server startup timeout";
}
