import { describe, expect, test } from "vitest";
import { openCodeStartupTimeoutMessage } from "./startup-timeout.js";

describe("engine startup timeout", () => {
  const copying = "[arena-upgrade] Backing up databases before OpenCode 2.0\n";
  const copied =
    "[arena-upgrade] Backed up the 1.x databases to /scratch/arena/pre-opencode-2-backup\n";

  test("explains when the limit stopped startup while waiting for a required backup", () => {
    expect(openCodeStartupTimeoutMessage(true, copying)).toBe(
      "Arena's pre-upgrade database backup did not report completion within the 30-second engine startup limit. " +
        "Startup was stopped. A complete backup is required to upgrade; do not skip it.",
    );
  });

  test("keeps the ordinary timeout after the backup finished", () => {
    expect(openCodeStartupTimeoutMessage(true, copying + copied)).toBe(
      "OpenCode server startup timeout",
    );
  });

  test("keeps the ordinary timeout when no backup ran or the engine is not Arena", () => {
    expect(openCodeStartupTimeoutMessage(true, "")).toBe("OpenCode server startup timeout");
    expect(openCodeStartupTimeoutMessage(false, copying)).toBe("OpenCode server startup timeout");
  });
});
