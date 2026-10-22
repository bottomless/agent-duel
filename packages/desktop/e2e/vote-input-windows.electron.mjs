import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

if (process.platform !== "win32") {
  console.log("SKIP: Windows vote-input regression requires Windows and SendInput.");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "vote-input-windows-electron-"));
const helperSource = path.join(scriptDir, "vote-input-windows-helper.cpp");
const helper = path.join(fixtureDir, "vote-input-windows-helper.exe");
const fixture = path.join(fixtureDir, "main.cjs");
const preload = path.join(fixtureDir, "preload.cjs");
const addon = path.join(desktopDir, "dist/native/vote-input.node");

function commandExists(command) {
  try {
    execFileSync("where.exe", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function quoteCmd(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function findVsDevCmd() {
  const candidates = [];
  for (const root of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
    if (root)
      candidates.push(path.join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const installationPath = execFileSync(
        candidate,
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property",
          "installationPath",
        ],
        { encoding: "utf8" },
      ).trim();
      const devCmd = path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
      if (installationPath && existsSync(devCmd)) return devCmd;
    } catch {
      // Continue searching installed Visual Studio instances.
    }
  }
  return null;
}

function normalizedTargetArch(value) {
  const normalized = value?.toLowerCase();
  if (normalized === "x64" || normalized === "amd64") return "amd64";
  if (normalized === "arm64") return "arm64";
  return null;
}

function compilerEnvironmentMatches(targetArch) {
  const configuredTarget = normalizedTargetArch(process.env.VSCMD_ARG_TGT_ARCH);
  if (configuredTarget) return configuredTarget === targetArch;
  return normalizedTargetArch(process.arch) === targetArch;
}

function buildHelper() {
  const targetArch = process.arch === "arm64" ? "arm64" : "amd64";
  const args = [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    helperSource,
    `/Fe:${helper}`,
    `/Fo${path.join(fixtureDir, "vote-input-windows-helper.obj")}`,
    "/link",
    "/SUBSYSTEM:CONSOLE",
    "user32.lib",
  ];
  const devCmd = findVsDevCmd();
  if (devCmd) {
    const command = [
      `call ${quoteCmd(devCmd)} -arch=${targetArch} -host_arch=amd64`,
      `cl.exe ${args.map(quoteCmd).join(" ")}`,
    ].join(" && ");
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      stdio: "inherit",
      windowsVerbatimArguments: true,
    });
    return;
  }
  if (commandExists("cl.exe") && compilerEnvironmentMatches(targetArch)) {
    execFileSync("cl.exe", args, { stdio: "inherit" });
    return;
  }
  throw new Error(
    `Windows vote-input fixture needs Visual Studio target ${targetArch}; no matching compiler environment was found.`,
  );
}

function sourceIsSafe(source) {
  assert.equal(source, "injected", `SendInput must retain its injected origin: ${source}`);
}

function runHelper(windowHandle, mode) {
  const output = execFileSync(helper, [windowHandle, mode], { encoding: "utf8" }).trim();
  if (!output) return null;
  const [x, y] = output.split(/\s+/).map(Number);
  assert.ok(Number.isFinite(x) && Number.isFinite(y), `Invalid helper output: ${output}`);
  return { x, y };
}

try {
  buildHelper();
  const html = `<button id="vote">Vote</button><button id="keyboard">Keyboard</button>
<script>window.results = [];</script>`;
  await writeFile(
    preload,
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voteTest', {
  status: () => ipcRenderer.invoke('vote-input:status'),
  consume: input => ipcRenderer.invoke('vote-input:consume', input),
});`,
  );
  await writeFile(
    fixture,
    `const { app, BrowserWindow, ipcMain } = require('electron');
const native = require(${JSON.stringify(addon)});
let startError = null;
try { native.start(); } catch (error) { startError = String(error && error.message || error); }
ipcMain.handle('vote-input:status', () => ({ started: startError === null, error: startError }));
ipcMain.handle('vote-input:consume', (event, input) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('fixture window unavailable');
  return native.consume(window.getNativeWindowHandle(), input);
});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 500, height: 350, show: true,
    webPreferences: { preload: ${JSON.stringify(preload)}, sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
  window.show();
  window.focus();
});
app.on('window-all-closed', () => app.quit());`,
  );

  let electron;
  try {
    electron = await _electron.launch({ executablePath: require("electron"), args: [fixture] });
    const page = await electron.firstWindow();
    await page.waitForSelector("#vote");
    const status = await page.evaluate(() => window.voteTest.status());
    assert.deepEqual(status, { started: true, error: null });
    const handle = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window.getNativeWindowHandle().readBigUInt64LE(0).toString();
    });

    const consumePointer = async (point) =>
      page.evaluate((input) => window.voteTest.consume(input), {
        kind: "pointer",
        screenX: point.x,
        screenY: point.y,
      });
    const consumeEnter = async () =>
      page.evaluate(() => window.voteTest.consume({ kind: "keyboard", key: "Enter" }));

    const sendPointer = runHelper(handle, "send-pointer");
    assert(sendPointer);
    const injectedPointer = await consumePointer(sendPointer);
    sourceIsSafe(injectedPointer);
    assert.equal(await consumePointer(sendPointer), "unverified");

    runHelper(handle, "send-enter");
    const injectedEnter = await consumeEnter();
    sourceIsSafe(injectedEnter);
    assert.equal(await consumeEnter(), "unverified");

    runHelper(handle, "send-enter");
    const secondEnter = await consumeEnter();
    sourceIsSafe(secondEnter);
    assert.equal(await consumeEnter(), "unverified");

    const postedPointer = runHelper(handle, "post-pointer");
    assert(postedPointer);
    const postedSource = await consumePointer(postedPointer);
    assert.notEqual(postedSource, "native");
    assert.ok(["unknown", "unverified"].includes(postedSource));

    const sentPointer = runHelper(handle, "send-message-pointer");
    assert(sentPointer);
    const sentSource = await consumePointer(sentPointer);
    assert.notEqual(sentSource, "native");
    assert.ok(["unknown", "unverified"].includes(sentSource));

    runHelper(handle, "post-enter");
    const postedEnter = await consumeEnter();
    assert.notEqual(postedEnter, "native");
    assert.ok(["unknown", "unverified"].includes(postedEnter));

    runHelper(handle, "send-message-enter");
    const sentEnter = await consumeEnter();
    assert.notEqual(sentEnter, "native");
    assert.ok(["unknown", "unverified"].includes(sentEnter));

    runHelper(handle, "send-enter");
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(await consumeEnter(), "unverified");

    console.log(
      "PASS: SendInput evidence is never native, repeated distinct Enter releases remain consumable, replay is one-shot, PostMessage/SendMessage are not native, and expiry is enforced.",
    );
  } finally {
    await electron?.close();
  }
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}
