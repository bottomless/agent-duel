import inspector from "node:inspector";
import { app, dialog } from "electron";
import log from "electron-log/main";
import { readPackagedDeploymentConfig } from "../deployment-config.js";

// Switches that open the app's main process or renderers to an outside debugger, which is how
// Playwright and other CDP clients drive Electron. The nodeCliInspect fuse also ignores the
// inspector ones in a packaged build; refusing them here covers Chromium's and says why.
const DEBUGGER_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-wait",
] as const;

interface DebuggerProbe {
  hasSwitch: (name: string) => boolean;
  inspectorUrl: () => string | undefined;
}

/** What would let a debugger attach: a debugging switch, or an inspector already listening. */
export function attachedDebuggers({ hasSwitch, inspectorUrl }: DebuggerProbe): string[] {
  const switches = DEBUGGER_SWITCHES.filter((name) => hasSwitch(name)).map((name) => `--${name}`);
  return inspectorUrl() === undefined ? switches : [...switches, "inspector"];
}

/** Development and packaged smoke builds take a debugger; a release build does not. */
export function isDebuggingAllowed(): boolean {
  return !app.isPackaged || readPackagedDeploymentConfig().debuggingAllowed;
}

/**
 * Stops a release build that was launched for a debugger, before any window exists. Call it after
 * every Chromium switch, including `PASEO_ELECTRON_FLAGS`, has been applied.
 */
export function refuseDebuggersInRelease(): void {
  if (isDebuggingAllowed()) return;
  const attached = attachedDebuggers({
    hasSwitch: (name) => app.commandLine.hasSwitch(name),
    inspectorUrl: () => inspector.url(),
  });
  if (attached.length === 0) return;
  log.error("[debugging] refused a release launch with a debugger", { attached });
  dialog.showErrorBox(
    "Agent Duel can't start",
    `This build doesn't run with a debugger attached. Start it without ${attached.join(", ")}.`,
  );
  process.exit(1);
}
