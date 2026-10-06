import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  createElectronSpawnOptions,
  findElectronPage,
  hasElectronPage,
  registerDevRunnerShutdownSignals,
  resolveChildKillTarget,
  shouldStopDevDaemonOnSignal,
} from "./dev-runner-config.mjs";

describe("desktop dev process ownership", () => {
  test("makes the signal-handling runner the workspace terminal process", () => {
    const paseoConfig = JSON.parse(
      readFileSync(new URL("../../../paseo.json", import.meta.url), "utf8"),
    );
    const devScript = readFileSync(new URL("./dev.sh", import.meta.url), "utf8");
    const devRunner = readFileSync(new URL("./dev-runner.mjs", import.meta.url), "utf8");

    expect(paseoConfig.scripts.desktop.command).toContain("exec ./packages/desktop/scripts/dev.sh");
    expect(devScript).toContain('npm --prefix "$DESKTOP_DIR" run build:main');
    expect(devScript).toContain('node "$SCRIPT_DIR/dev-arena-preflight.mjs" "$ROOT_DIR"');
    expect(devScript).toContain("daemon start");
    expect(devScript).toContain('dev-daemon-state.mjs" verify');
    expect(devScript).toContain('exec node "$SCRIPT_DIR/dev-runner.mjs"');
    expect(devRunner).toContain('killChild(child, "SIGKILL")');
    expect(devRunner).not.toContain("child.killed");
  });

  test("keeps Electron in the runner process group", () => {
    const options = createElectronSpawnOptions({
      env: { PATH: "/usr/bin" },
      colorEnv: { FORCE_COLOR: "1" },
      expoDevUrl: "http://localhost:8082",
    });

    expect(options).toMatchObject({
      detached: false,
      env: {
        PATH: "/usr/bin",
        FORCE_COLOR: "1",
        EXPO_DEV_URL: "http://localhost:8082",
      },
    });
  });

  test("recognizes only a loaded Electron page from this Metro instance", () => {
    const targets = [
      { type: "page", url: "http://localhost:8084/settings" },
      { type: "service_worker", url: "http://localhost:8085/worker.js" },
    ];
    expect(hasElectronPage(targets, "http://localhost:8084")).toBe(true);
    expect(hasElectronPage(targets, "http://localhost:8085")).toBe(false);
    expect(findElectronPage(targets, "http://localhost:8084")).toEqual(targets[0]);
  });

  test("targets the whole process group for detached child trees", () => {
    expect(resolveChildKillTarget(42, true)).toBe(-42);
    expect(resolveChildKillTarget(42, false)).toBe(42);
  });

  test("stops only a daemon explicitly owned by this dev runner", () => {
    expect(
      shouldStopDevDaemonOnSignal({
        PASEO_DEV_OWNS_DAEMON: "1",
        PASEO_HOME: "/tmp/worktree-home",
      }),
    ).toBe(true);
    expect(shouldStopDevDaemonOnSignal({ PASEO_HOME: "/tmp/worktree-home" })).toBe(false);
    expect(shouldStopDevDaemonOnSignal({ PASEO_DEV_OWNS_DAEMON: "1" })).toBe(false);
  });

  test("stops children when the owning terminal hangs up", () => {
    const listeners = new Map();
    const receivedSignals = [];

    registerDevRunnerShutdownSignals({
      signalSource: {
        on(signal, listener) {
          listeners.set(signal, listener);
        },
      },
      stop(signal) {
        receivedSignals.push(signal);
      },
    });

    expect(Array.from(listeners.keys())).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    listeners.get("SIGHUP")();
    expect(receivedSignals).toEqual(["SIGTERM"]);
  });
});
