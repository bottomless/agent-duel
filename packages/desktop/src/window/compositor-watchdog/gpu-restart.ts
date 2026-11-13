// The macOS compositor watchdog kills Electron's GPU process on purpose to unfreeze a window
// (`index.ts`). Electron reports that SIGKILL as a child process something outside the app ended,
// so the watchdog announces it here and the crash reporter skips it. Plain module state is enough:
// both sides run in the one desktop main process.

/**
 * Must outlast the kill and Electron's `child-process-gone` for it, which arrive within
 * milliseconds, and stay short enough that a genuine GPU crash right after a recovery is still
 * reported. The watchdog waits this long too, for Chromium to relaunch the process.
 */
export const GPU_RESTART_WINDOW_MS = 5_000;

let restartAt: number | null = null;

/** Called immediately before the watchdog kills the GPU process. */
export function noteGpuRestart(now = Date.now()): void {
  restartAt = now;
}

/** Whether a child process of this type ending now is the watchdog's own restart, not a crash. */
export function isExpectedGpuRestart(processType: string, now = Date.now()): boolean {
  return processType === "GPU" && restartAt !== null && now - restartAt < GPU_RESTART_WINDOW_MS;
}
