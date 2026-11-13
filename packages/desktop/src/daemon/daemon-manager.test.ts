import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { ExternalCliCommandError } from "./cli/external";
import {
  createDaemonCommandHandlers,
  keepsTerminalsOnStop,
  stopCapturedDaemon,
  stopDesktopDaemon,
  type DesktopDaemonStopReason,
} from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
  deploymentConfig: {} as Record<string, unknown>,
  startDaemonInstance: vi.fn(),
}));

const HOSTED_DEPLOYMENT_CONFIG = {
  controlPlaneUrl: "https://control.agentduel.test",
  sessionPublicKey: "test-session-public-key",
  updatesEnabled: false,
  arenaBuildSha: "0123456789abcdef0123456789abcdef01234567",
};

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((file, options) => {
      if (String(file).endsWith("deployment-config.json")) {
        return JSON.stringify(mocks.deploymentConfig);
      }
      return actual.readFileSync(file, options);
    }),
  };
});

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
  startDaemonInstance: mocks.startDaemonInstance,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/tmp/paseo-desktop-daemon-manager-test-resources",
    });
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.deploymentConfig = HOSTED_DEPLOYMENT_CONFIG;
    mocks.startDaemonInstance.mockReset();
    mocks.startDaemonInstance.mockResolvedValue({ instance: null, spawned: true });
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    delete process.resourcesPath;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  it("reuses a daemon that refuses the probe for want of a signed-in account", async () => {
    // The daemon is up and answering; it is refusing the probe. Reading that as
    // "not running" makes the shell spawn a second daemon onto the same port,
    // which dies with EADDRINUSE.
    mkdirSync(mocks.paseoHome);
    writeFileSync(
      path.join(mocks.paseoHome, "paseo.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: "127.0.0.1:6769",
        desktopManaged: true,
      }),
    );
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      connectedDaemon: "sign_in_required",
      serverId: "srv_signed_out",
      listen: "127.0.0.1:6769",
      hostname: "macbookpro.home",
      pid: process.pid,
      desktopManaged: true,
    });

    const status = await createDaemonCommandHandlers().start_desktop_daemon();

    expect(status.status).toBe("running");
    expect(status.serverId).toBe("srv_signed_out");
    expect(status.listen).toBe("127.0.0.1:6769");
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });

  it("starts the packaged daemon with the bundled Arena engine and the hosted control plane", async () => {
    await createDaemonCommandHandlers().start_desktop_daemon();

    const env = mocks.startDaemonInstance.mock.calls.at(-1)?.[0]?.env;
    expect(env).toMatchObject({
      PASEO_ARENA_BACKEND_EXECUTABLE: expect.stringContaining("agent-duel-arena"),
      PASEO_CONTROL_PLANE_URL: "https://control.agentduel.test",
      PASEO_SESSION_PUBLIC_KEY: "test-session-public-key",
      OPENCODE_ARENA_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(env).not.toHaveProperty("PASEO_ARENA_STORE_URL");
  });

  it("starts the daemon of a bring-your-own-key build without a control plane", async () => {
    mocks.deploymentConfig = {
      ...HOSTED_DEPLOYMENT_CONFIG,
      controlPlaneUrl: null,
      sessionPublicKey: null,
    };
    mocks.createNodeEntrypointInvocation.mockReturnValue({
      command: "node",
      args: [],
      env: {
        PASEO_CONTROL_PLANE_URL: "https://inherited-from-login-shell.test",
        PASEO_SESSION_PUBLIC_KEY: "inherited-public-key",
      },
    });

    await createDaemonCommandHandlers().start_desktop_daemon();

    const env = mocks.startDaemonInstance.mock.calls.at(-1)?.[0]?.env;
    expect(env?.PASEO_ARENA_BACKEND_EXECUTABLE).toContain("agent-duel-arena");
    expect(env?.PASEO_CONTROL_PLANE_URL).toBeUndefined();
    expect(env?.PASEO_SESSION_PUBLIC_KEY).toBeUndefined();
  });
});

describe.runIf(process.platform === "win32")("stopping the managed daemon on Windows", () => {
  let fixtureRoot: string;
  let supervisor: ChildProcess | undefined;

  beforeEach(() => {
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/tmp/paseo-desktop-daemon-manager-test-resources",
    });
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon stop "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mkdirSync(path.join(mocks.paseoHome, "crash-reports"), { recursive: true });
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.deploymentConfig = HOSTED_DEPLOYMENT_CONFIG;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.startDaemonInstance.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
  });

  afterEach(() => {
    delete process.resourcesPath;
    supervisor?.kill("SIGKILL");
    supervisor = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("ends the daemon it launched when the CLI is refused for want of a signed-in account", async () => {
    const markerPath = path.join(mocks.paseoHome, "crash-reports", "daemon.running");
    mocks.startDaemonInstance.mockImplementation(
      async (input: { onAcquired?: (instance: unknown) => void }) => {
        supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
          stdio: "ignore",
        });
        const pid = supervisor.pid;
        if (pid === undefined) throw new Error("supervisor did not start");
        const instance = {
          pid,
          startedAt: new Date().toISOString(),
          hostname: hostname(),
          uid: 0,
          listen: "127.0.0.1:6798",
          desktopManaged: true,
        };
        writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), JSON.stringify(instance));
        writeFileSync(
          markerPath,
          JSON.stringify({ pid, version: "0.4.0", startedAt: instance.startedAt }),
        );
        input.onAcquired?.(instance);
        return { instance, spawned: true };
      },
    );
    // What a daemon with accounts answers the CLI, which carries no account session.
    mocks.runExternalCliJsonCommand.mockImplementation(async (args: string[]) => {
      if (args[0] === "daemon" && args[1] === "stop")
        throw new Error('{"error":{"code":"SIGN_IN_REQUIRED"}}');
      return { localDaemon: "stopped" };
    });
    await createDaemonCommandHandlers().start_desktop_daemon();
    const exited = new Promise<void>((resolve) => supervisor?.once("exit", () => resolve()));

    await stopDesktopDaemon("quit");

    await exited;
    expect(mocks.runExternalCliJsonCommand).toHaveBeenCalledWith(
      expect.arrayContaining(["daemon", "stop", "--host", "127.0.0.1:6798"]),
    );
    expect(existsSync(path.join(mocks.paseoHome, "paseo.pid"))).toBe(false);
    // Asked for, so the next start must not report it as a crash.
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("desktop stops and terminals", () => {
  const reasons: DesktopDaemonStopReason[] = [
    "manual_ipc",
    "settings",
    "host_remove",
    "quit",
    "app_update",
    "version_mismatch",
    "restart",
  ];

  it("keeps terminals only for an app update or version-mismatch restart, never on Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, platform))).toEqual([
        "app_update",
        "version_mismatch",
      ]);
    }
    expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, "win32"))).toEqual([]);
  });

  function stopHarness(runCliJson: (args: string[]) => Promise<unknown>) {
    const stops: Array<{ keepTerminals: boolean | undefined }> = [];
    const logged: string[] = [];
    const instance = {
      pid: 4242,
      startedAt: "2026-10-21T00:00:00.000Z",
      hostname: "host",
      uid: 501,
      listen: "127.0.0.1:6799",
    };
    const stopInstance = (async (
      _home: string,
      options: {
        keepTerminals?: boolean;
        requestShutdown?: (ready: { listen: string }) => Promise<void>;
      },
    ) => {
      stops.push({ keepTerminals: options.keepTerminals });
      await options.requestShutdown?.({ listen: instance.listen });
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    }) as unknown as NonNullable<Parameters<typeof stopCapturedDaemon>[0]["stopInstance"]>;
    return {
      stops,
      logged,
      input: {
        home: "/tmp/paseo-home",
        instance,
        stopInstance,
        runCliJson,
        log: (message: string) => logged.push(message),
      } as Omit<Parameters<typeof stopCapturedDaemon>[0], "reason" | "keepTerminals">,
    };
  }

  it("asks the daemon to keep its terminals on an app update", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }]);
    expect(calls).toEqual([
      ["daemon", "stop", "--host", "127.0.0.1:6799", "--keep-terminals", "--json"],
    ]);
  });

  it("stops a daemon without the capability with its terminals closed, and says so", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      if (args.includes("--keep-terminals")) {
        throw new ExternalCliCommandError("refused", {
          code: "TERMINALS_KEEP_UNSUPPORTED",
          version: "0.11.0",
        });
      }
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }, { keepTerminals: false }]);
    expect(calls[1]).toEqual(["daemon", "stop", "--host", "127.0.0.1:6799", "--json"]);
    expect(harness.logged).toContain(
      "daemon v0.11.0 cannot keep terminals; stopping it and closing them",
    );
  });

  it("does not retry a keep stop that failed for another reason", async () => {
    const harness = stopHarness(async () => {
      throw new ExternalCliCommandError("unreachable", { code: "DAEMON_UNREACHABLE" });
    });

    await expect(
      stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true }),
    ).rejects.toThrow("unreachable");
    expect(harness.stops).toEqual([{ keepTerminals: true }]);
  });
});
