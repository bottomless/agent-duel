#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createElectronSpawnOptions,
  findElectronPage,
  registerDevRunnerShutdownSignals,
  resolveChildKillTarget,
  shouldStopDevDaemonOnSignal,
} from "./dev-runner-config.mjs";

import { resolveDevElectronArgs } from "./dev-runner-args.mjs";
import { prepareDevApplication } from "./dev-application.mjs";
import { ensureDevSessionKeys } from "./dev-session-keys.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const appDir = path.resolve(desktopDir, "../app");
const controlPlaneDir = path.resolve(rootDir, "arena-backend/packages/control-plane");
const require = createRequire(import.meta.url);

const expoPort = Number(process.env.EXPO_PORT);
if (!Number.isInteger(expoPort) || expoPort <= 0) {
  console.error("[dev] EXPO_PORT must be set before running desktop dev");
  process.exit(1);
}

// dev.sh decides: "bundled" spawns arena-backend's control plane, "external" waits for the one at
// PASEO_CONTROL_PLANE_URL, and "none" is a bring-your-own-key stack.
const controlPlaneMode = process.env.PASEO_DEV_CONTROL_PLANE;
if (!["bundled", "external", "none"].includes(controlPlaneMode)) {
  console.error("[dev] PASEO_DEV_CONTROL_PLANE must be bundled, external, or none");
  process.exit(1);
}

const expoDevUrl = process.env.EXPO_DEV_URL || `http://localhost:${expoPort}`;
const electronArgs = resolveDevElectronArgs(process.platform, process.argv.slice(2));
const colorEnv = {
  FORCE_COLOR: process.env.FORCE_COLOR || "1",
  npm_config_color: process.env.npm_config_color || "always",
};
const devBuildLabel = execFileSync("git", ["branch", "--show-current"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();
const electron = await prepareDevApplication({ electronPath: require("electron"), rootDir });
if (process.platform === "darwin") {
  // Register the sender identity before the first notification reaches macOS.
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", path.resolve(electron, "../../..")],
    { stdio: "pipe" },
  );
}

const children = new Map();
let stopping = false;
let exitCode = 0;
let stopDaemonOnExit = false;
let finishing = false;

function prefixStream(name, stream, target) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      target.write(line ? `[${name}] ${line}\n` : `[${name}]\n`);
    }
  });
  stream.on("end", () => {
    if (buffered) {
      target.write(`[${name}] ${buffered}\n`);
    }
  });
}

function spawnChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...colorEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  const managedChild = {
    process: child,
    detached: options.detached === true,
  };
  children.set(name, managedChild);
  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);

  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    exitCode = 1;
    stopAll("SIGTERM");
  });

  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      if (code !== 0) {
        exitCode = code ?? 1;
        console.error(`[${name}] exited with ${signal ?? code}`);
      }
      stopAll("SIGTERM");
    }
  });

  return child;
}

function killChild({ process: child, detached }, signal) {
  // The child stays in `children` until its exit event. Node's `killed` and
  // `signalCode` fields can change after signal delivery while Electron is
  // still completing its asynchronous quit path, so neither is proof of exit.
  if (!child.pid) {
    return;
  }

  try {
    process.kill(resolveChildKillTarget(child.pid, detached), signal);
  } catch {
    // The child may have exited between the liveness check and the signal.
  }
}

function stopOwnedDevDaemon() {
  if (!stopDaemonOnExit || !shouldStopDevDaemonOnSignal(process.env)) {
    return;
  }

  const cliEntrypoint = path.resolve(rootDir, "packages/cli/dist/index.js");
  try {
    execFileSync(
      process.execPath,
      [
        cliEntrypoint,
        "daemon",
        "stop",
        "--home",
        process.env.PASEO_HOME,
        "--timeout",
        "5",
        "--force",
        "--kill-timeout",
        "3",
      ],
      { cwd: rootDir, stdio: "inherit", timeout: 10_000 },
    );
  } catch (error) {
    console.error(`[dev] failed to stop worktree daemon during shutdown: ${error.message}`);
  }
}

function stopAll(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children.values()) {
    killChild(child, signal);
  }

  const forceKill = setTimeout(() => {
    for (const child of children.values()) {
      killChild(child, "SIGKILL");
    }
  }, 2500);
  forceKill.unref();

  const finish = setInterval(() => {
    if (children.size === 0 && !finishing) {
      finishing = true;
      clearInterval(finish);
      stopOwnedDevDaemon();
      process.exit(exitCode);
    }
  }, 50);
}

async function waitForPort(port, host = "127.0.0.1", timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canConnect(port, host)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // The control plane is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForElectronPage(port, expectedUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const target = response.ok ? findElectronPage(await response.json(), expectedUrl) : undefined;
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // Electron or its renderer is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Electron to load ${expectedUrl}`);
}

async function waitForElectronRenderer(webSocketUrl, developmentSession, timeoutMs = 60_000) {
  const expression = developmentSession
    ? `(async () => {
        const storage = window.paseoDesktop?.accounts.session;
        if (!storage) return false;
        const session = ${JSON.stringify(developmentSession)};
        if (await storage.load() !== session) {
          window.__paseoDevLogin ??= storage.save(session).then(() => location.reload());
          return false;
        }
        const store = window.__paseoHostRuntimeStore;
        return store?.getHosts().some(host =>
          host.connections.some(connection => connection.type === "directTcp" &&
            connection.endpoint === ${JSON.stringify(process.env.PASEO_DAEMON_ENDPOINT)}) &&
          store.getSnapshot(host.serverId)?.connectionStatus === "online");
      })()`
    : 'document.readyState === "complete" && (document.querySelector("#root")?.childElementCount ?? 0) > 0';
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const deadline = Date.now() + timeoutMs;
    let requestId = 0;
    let timer;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.addEventListener("open", () => {
      timer = setInterval(() => {
        if (Date.now() >= deadline) {
          finish(new Error("Timed out waiting for the Electron renderer to become ready"));
          return;
        }
        requestId += 1;
        socket.send(
          JSON.stringify({
            id: requestId,
            method: "Runtime.evaluate",
            params: {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        );
      }, 250);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.result?.result?.value === true) finish();
      } catch {
        // Ignore unrelated CDP messages.
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Electron debugger connection failed")),
    );
  });
}

function bundledControlPlaneEnv() {
  // Process env wins over the control plane's --env-file, so these override arena-backend/.env.
  const { privateKey, publicKey } = ensureDevSessionKeys(rootDir);
  return { PASEO_SESSION_PRIVATE_KEY: privateKey, PASEO_SESSION_PUBLIC_KEY: publicKey };
}

function createDevelopmentSession() {
  if (process.env.PASEO_DEV_LOGIN !== "1") {
    return undefined;
  }

  // PASEO_DEV_LOGIN_COMMAND prints the same JSON as the bundled dev-login.ts.
  const command = process.env.PASEO_DEV_LOGIN_COMMAND?.trim();
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  };
  // Sessions must be signed with the key of the control plane the daemon trusts.
  const env =
    controlPlaneMode === "bundled" ? { ...process.env, ...bundledControlPlaneEnv() } : process.env;
  const result = command
    ? spawnSync(command, { ...options, cwd: rootDir, env, shell: true })
    : spawnSync("bun", ["--env-file=../../.env", "src/dev-login.ts"], {
        ...options,
        cwd: controlPlaneDir,
        env,
      });
  // Never include captured output or the subprocess error: they may contain the session.
  const source = command ? "PASEO_DEV_LOGIN_COMMAND" : "dev-login.ts";
  const failure = (reason) =>
    new Error(`Could not create the local development session: ${source} ${reason}`);
  if (result.status !== 0) {
    throw failure(`exited with ${result.signal ?? result.status ?? "no status"}`);
  }
  const session = result.stdout.trim();
  try {
    JSON.parse(session);
  } catch {
    throw failure("printed no session JSON");
  }
  return session;
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

registerDevRunnerShutdownSignals({
  signalSource: process,
  stop(signal) {
    stopDaemonOnExit = true;
    stopAll(signal);
  },
});

async function startControlPlane() {
  const controlPlanePort = Number(process.env.PASEO_CONTROL_PLANE_PORT);
  if (!Number.isInteger(controlPlanePort) || controlPlanePort <= 0) {
    console.error("[dev] PASEO_CONTROL_PLANE_PORT must be set before running desktop dev");
    process.exit(1);
  }

  spawnChild("control-plane", "bun", ["run", "dev"], {
    cwd: controlPlaneDir,
    detached: true,
    env: { ...process.env, ...colorEnv, ...bundledControlPlaneEnv() },
  });

  try {
    await waitForPort(controlPlanePort);
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    exitCode = 1;
    stopAll("SIGTERM");
  }
}

async function waitForExternalControlPlane() {
  const healthUrl = `${process.env.PASEO_CONTROL_PLANE_URL.replace(/\/$/, "")}/api/health`;
  try {
    await waitForHealth(healthUrl);
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    exitCode = 1;
    stopAll("SIGTERM");
  }
}

if (controlPlaneMode === "bundled") {
  await startControlPlane();
} else if (controlPlaneMode === "external") {
  await waitForExternalControlPlane();
}

if (!stopping) {
  spawnChild("metro", "npx", ["expo", "start", "--port", String(expoPort)], {
    cwd: appDir,
    detached: true,
    env: {
      ...process.env,
      ...colorEnv,
      BROWSER: "none",
      APP_VARIANT: "development",
      EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL: devBuildLabel,
      PASEO_WEB_PLATFORM: "electron",
    },
  });
}

try {
  await waitForPort(expoPort);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  exitCode = 1;
  stopAll("SIGTERM");
}

if (!stopping) {
  const electronProcess = spawnChild(
    "electron",
    electron,
    [...electronArgs, desktopDir],
    createElectronSpawnOptions({
      env: process.env,
      colorEnv,
      expoDevUrl,
    }),
  );
  const debuggerPort = Number(process.env.PASEO_ELECTRON_REMOTE_DEBUGGING_PORT);
  if (Number.isInteger(debuggerPort) && debuggerPort > 0) {
    try {
      await waitForPort(debuggerPort);
      const pageDebuggerUrl = await waitForElectronPage(debuggerPort, expoDevUrl);
      const developmentSession = createDevelopmentSession();
      await waitForElectronRenderer(pageDebuggerUrl, developmentSession);
      console.log(
        `[dev] healthy: daemon ${process.env.PASEO_DAEMON_ENDPOINT}, Metro ${expoDevUrl}, Electron debugger 127.0.0.1:${debuggerPort}`,
      );
    } catch (error) {
      console.error(`[dev] ${error.message}`);
      if (!electronProcess.killed) exitCode = 1;
      stopAll("SIGTERM");
    }
  }
}
