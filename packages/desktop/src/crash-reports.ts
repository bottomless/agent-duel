import { app } from "electron";
import log from "electron-log/main";
import {
  claimRunningMarker,
  describeError,
  describeUncleanShutdown,
  recordCrashReport,
  recordSessionEnding,
  releaseRunningMarker,
  resolvePaseoHome,
} from "@getpaseo/server";

type CrashInput = Parameters<typeof recordCrashReport>[0]["crash"];

function desktopLogPath(): string | undefined {
  try {
    return log.transports.file.getFile().path;
  } catch {
    return undefined;
  }
}

/**
 * Records the desktop app's crashes in the daemon's crash folder. The daemon sends them as
 * feedback (`packages/server/src/server/crash-reports/sender.ts`), so a build without any
 * reporting key reports too. Call once, after the single-instance lock: a second instance must not
 * take the running marker of the first. Call it before the first window opens, so every window
 * passes on the end of the session.
 */
export function startCrashReporting(): void {
  const home = resolvePaseoHome(process.env);
  const version = app.getVersion();
  let quitting = false;
  const record = (crash: CrashInput) => {
    const logPath = desktopLogPath();
    return recordCrashReport({
      home,
      crash,
      appVersion: version,
      logPaths: logPath ? [logPath] : [],
    });
  };

  const previous = claimRunningMarker({ home, name: "app", version });
  if (previous) {
    record({
      process: "app",
      kind: "unclean_shutdown",
      message: describeUncleanShutdown("Agent Duel", previous),
    });
  }
  // The quit lifecycle ends with app.exit(), which skips Electron's later quit events, so the
  // marker goes when the quit starts. `exit` covers every other way the process ends on its own.
  app.on("before-quit", () => {
    quitting = true;
    releaseRunningMarker(home, "app");
  });
  process.on("exit", () => releaseRunningMarker(home, "app"));

  // Windows skips `before-quit` when the user shuts down, restarts or signs out, and tells only the
  // windows. It then ends the app and the daemon without a signal, so their markers must say so now.
  app.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => {
      quitting = true;
      recordSessionEnding(home);
    });
  });

  // A monitor records the exception and leaves Electron's own handling of it unchanged.
  process.on("uncaughtExceptionMonitor", (error) => {
    record({ process: "app", kind: "exception", message: describeError(error) });
  });
  app.on("render-process-gone", (_event, _contents, details) => {
    if (details.reason === "clean-exit" || quitting) return;
    record({
      process: "window",
      kind: "exit",
      message: `A window's renderer process ended: ${details.reason}`,
      exitCode: details.exitCode,
      // `killed`: another process ended it, such as macOS reclaiming memory or Activity Monitor.
      external: details.reason === "killed",
    });
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || quitting) return;
    record({
      process: "app",
      kind: "exit",
      message: `Electron's ${details.type} process ended: ${details.reason}${details.name ? ` (${details.name})` : ""}`,
      exitCode: details.exitCode,
      external: details.reason === "killed",
    });
  });
}
