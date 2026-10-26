import { appendFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

export interface DesktopRuntimeConfig {
  serverId: string;
  updateAvailable?: boolean;
  latestVersion?: string;
  updateReadyToInstall?: boolean;
  manualUpdateBypassesRollout?: boolean;
  slowInstall?: boolean;
  /** Initial PID reported by desktop_daemon_status. Defaults to null. */
  daemonPid?: number | null;
  daemonHome?: string;
  /** Current-session ownership, independent of the legacy management flag. */
  ownedByDesktop?: boolean;
  daemonVersion?: string | null;
  daemonLogPath?: string;
  /** Initial manageBuiltInDaemon setting. Defaults to false. */
  manageBuiltInDaemon?: boolean;
  /** Daemon listen address reported by desktop_daemon_status. Defaults to 127.0.0.1:6767. */
  daemonListen?: string;
  /** Keep start_desktop_daemon pending to hold the desktop startup blocker open. */
  hangDaemonStart?: boolean;
  /** Delay the desktop settings IPC response to exercise startup ordering. */
  desktopSettingsDelayMs?: number;
  dialogOpenResult?: string | string[] | null;
  editorTargets?: DesktopEditorTargetConfig[];
  editorRecordPath?: string;
}

interface DesktopEditorTargetConfig {
  id: string;
  label: string;
  kind: "editor" | "file-manager";
  icon: { kind: "image"; dataUrl: string } | { kind: "symbol"; name: "folder" | "terminal" };
}

interface DesktopEditorOpenRecord {
  editorId: string;
  workspacePath: string;
  filePath?: string;
  line?: number;
  column?: number;
}

declare global {
  interface Window {
    __capturedDialogOpenCalls: Array<Record<string, unknown> | undefined>;
    __recordDesktopEditorOpen?: (input: DesktopEditorOpenRecord) => Promise<void>;
    __desktopDaemonStartRequested?: boolean;
  }
}

/**
 * Injects window.paseoDesktop before app load so all Electron-gated code
 * activates. The update-check IPC is mocked at the boundary so the real
 * auto-updater never fires. Daemon start/stop commands are stateful: the mock
 * tracks running state and assigns a fresh PID on each start, letting tests
 * observe PID changes without touching the real E2E daemon process.
 */
export async function installDesktopRuntime(
  page: Page,
  config: DesktopRuntimeConfig,
): Promise<void> {
  if (config.editorRecordPath) {
    await page.exposeFunction(
      "__recordDesktopEditorOpen",
      async (input: DesktopEditorOpenRecord) => {
        await appendFile(config.editorRecordPath as string, `${JSON.stringify(input)}\n`, "utf8");
      },
    );
  }

  await page.addInitScript((cfg) => {
    // Mutable state shared across IPC calls within this page
    let manageDaemon = cfg.manageBuiltInDaemon ?? false;
    let daemonRunning = true;
    let currentPid: number | null = cfg.daemonPid ?? null;
    let ownedByDesktop = cfg.ownedByDesktop ?? false;
    let manualUpdateAdmitted = false;
    window.__desktopDaemonStartRequested = false;

    function buildDaemonStatus() {
      return {
        serverId: cfg.serverId,
        status: daemonRunning ? "running" : "stopped",
        listen: cfg.daemonListen ?? "127.0.0.1:6767",
        hostname: null,
        pid: currentPid,
        home: cfg.daemonHome ?? "",
        startedAt: currentPid === null ? null : "2026-09-01T00:00:00.000Z",
        ownedByDesktop,
        version: cfg.daemonVersion ?? null,
        desktopManaged: manageDaemon,
        error: null,
      };
    }

    function startDesktopDaemon() {
      window.__desktopDaemonStartRequested = true;
      if (cfg.hangDaemonStart) {
        return new Promise(() => undefined);
      }
      if (!daemonRunning) {
        currentPid = (cfg.daemonPid ?? 10000) + 1000;
        ownedByDesktop = true;
      }
      daemonRunning = true;
      return buildDaemonStatus();
    }

    async function waitForDesktopSettingsResponse() {
      const delayMs = cfg.desktopSettingsDelayMs ?? 0;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    function buildAppUpdateCheckResult(hasUpdate: boolean, readyToInstall: boolean) {
      return {
        hasUpdate,
        readyToInstall,
        currentVersion: "1.0.0",
        latestVersion: hasUpdate ? (cfg.latestVersion ?? "1.2.3") : null,
        body: null,
        date: null,
      };
    }

    function checkAppUpdate(intent: unknown) {
      if (!cfg.manualUpdateBypassesRollout) {
        return buildAppUpdateCheckResult(
          cfg.updateAvailable === true,
          cfg.updateAvailable === true && (cfg.updateReadyToInstall ?? true),
        );
      }

      if (intent === "manual") {
        manualUpdateAdmitted = true;
        return buildAppUpdateCheckResult(true, false);
      }

      return buildAppUpdateCheckResult(manualUpdateAdmitted, manualUpdateAdmitted);
    }

    const desktopBridge: {
      platform: string;
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      dialog: {
        open: (options?: Record<string, unknown>) => Promise<string | string[] | null>;
      };
      getPendingOpenProject: () => Promise<string | null>;
      events: { on: () => Promise<() => void> };
      editor?: {
        listTargets: () => Promise<DesktopEditorTargetConfig[]>;
        openTarget: (input: DesktopEditorOpenRecord) => Promise<void>;
      };
    } = {
      platform: "darwin",
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "check_app_update") {
          return checkAppUpdate(args?.intent);
        }

        if (command === "install_app_update") {
          if (cfg.slowInstall) {
            await new Promise<void>((resolve) => setTimeout(resolve, 3000));
          }
          return {
            installed: true,
            version: cfg.latestVersion ?? "1.2.3",
            message: "App update installed. Restart required.",
          };
        }

        if (command === "desktop_daemon_status") {
          return buildDaemonStatus();
        }

        if (command === "desktop_daemon_logs") {
          return { logPath: cfg.daemonLogPath ?? "", contents: "" };
        }

        if (command === "get_desktop_settings") {
          await waitForDesktopSettingsResponse();
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: manageDaemon, keepRunningAfterQuit: true },
          };
        }

        if (command === "patch_desktop_settings") {
          const daemon = args?.daemon;
          if (
            daemon !== null &&
            typeof daemon === "object" &&
            "manageBuiltInDaemon" in daemon &&
            typeof daemon.manageBuiltInDaemon === "boolean"
          ) {
            manageDaemon = daemon.manageBuiltInDaemon;
          }
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: manageDaemon, keepRunningAfterQuit: true },
          };
        }

        if (command === "stop_desktop_daemon") {
          ownedByDesktop = false;
          daemonRunning = false;
          currentPid = null;
          return buildDaemonStatus();
        }

        if (command === "start_desktop_daemon") {
          return startDesktopDaemon();
        }

        return null;
      },
      dialog: {
        open: async (options?: Record<string, unknown>) => {
          window.__capturedDialogOpenCalls.push(options);
          return cfg.dialogOpenResult ?? null;
        },
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };

    if (cfg.editorTargets) {
      desktopBridge.editor = {
        listTargets: async () => cfg.editorTargets ?? [],
        openTarget: async (input: DesktopEditorOpenRecord) => {
          await window.__recordDesktopEditorOpen?.(input);
        },
      };
    }

    window.__capturedDialogOpenCalls = [];
    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = desktopBridge;
  }, config);
}

export async function waitForDesktopDaemonStartRequest(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__desktopDaemonStartRequested === true);
  // Give the startup state two paints to expose any app → splash regression.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export async function waitForDirectoryDialog(
  page: Page,
): Promise<Record<string, unknown> | undefined> {
  await expect.poll(() => page.evaluate(() => window.__capturedDialogOpenCalls.length)).toBe(1);
  return page.evaluate(() => window.__capturedDialogOpenCalls[0]);
}

export async function expectUpdateBanner(page: Page, version: string): Promise<void> {
  const callout = page.getByTestId("update-callout");
  await expect(callout).toBeVisible({ timeout: 15_000 });
  await expect(callout).toContainText(`v${version.replace(/^v/i, "")}`);
}

export async function clickInstallUpdate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Install & restart" }).click();
}

export async function expectInstallInProgress(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Installing..." })).toBeVisible();
}
