import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/native/vote-input.node");
mkdirSync(dirname(output), { recursive: true });

function buildDarwin() {
  execFileSync(
    "xcrun",
    [
      "clang++",
      "-std=c++17",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-fobjc-arc",
      "-fblocks",
      "-DNAPI_VERSION=8",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=12.0",
      "-I",
      require("node-api-headers").include_dir,
      "-framework",
      "AppKit",
      "-framework",
      "CoreGraphics",
      resolve(root, "native/vote-input.mm"),
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      stdio: "ignore",
    });
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
  const programFiles = process.env["ProgramFiles"];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFiles) {
    candidates.push(join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  }
  if (programFilesX86) {
    candidates.push(join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe"));
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
      if (installationPath) {
        const devCmd = join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
        if (existsSync(devCmd)) return devCmd;
      }
    } catch {
      // Try the next installed Visual Studio instance.
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

function runMsvc(clArgs, linkArgs, targetArch) {
  const devCmd = findVsDevCmd();
  if (devCmd) {
    const command = [
      `call ${quoteCmd(devCmd)} -arch=${targetArch} -host_arch=amd64`,
      `cl.exe ${clArgs.map(quoteCmd).join(" ")}`,
      `link.exe ${linkArgs.map(quoteCmd).join(" ")}`,
    ].join(" && ");
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      stdio: "inherit",
      windowsVerbatimArguments: true,
    });
    return;
  }

  if (
    commandExists("cl.exe") &&
    commandExists("link.exe") &&
    compilerEnvironmentMatches(targetArch)
  ) {
    execFileSync("cl.exe", clArgs, { stdio: "inherit" });
    execFileSync("link.exe", linkArgs, { stdio: "inherit" });
    return;
  }

  throw new Error(
    `Windows vote-input build needs Visual Studio target ${targetArch}; no matching VsDevCmd environment or compiler was found.`,
  );
}

async function downloadElectronNodeLib(electronVersion, targetArch, cacheDir) {
  const cached = resolve(cacheDir, "node.lib");
  if (existsSync(cached)) return cached;

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://electronjs.org/headers/v${electronVersion}/win-${targetArch}/node.lib`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Unable to download Electron ${electronVersion} ${targetArch} node.lib: ${response.status} ${response.statusText}`,
    );
  }
  writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  return cached;
}

async function buildWindows() {
  const targetArch =
    process.env.npm_config_arch || process.env.npm_config_target_arch || process.arch;
  if (targetArch !== "x64" && targetArch !== "arm64") {
    throw new Error(
      `Unsupported Windows vote-input architecture: ${targetArch}. Use x64 or arm64.`,
    );
  }

  const electronPackage = require.resolve("electron/package.json", { paths: [root] });
  const electronVersion = require(electronPackage).version;
  const nodeApiHeaders = require("node-api-headers").include_dir;
  const source = resolve(root, "native/vote-input-win.cpp");
  const buildDir = resolve(tmpdir(), `agent-duel-vote-input-${process.pid}`);
  mkdirSync(buildDir, { recursive: true });
  const object = resolve(buildDir, "vote-input-win.obj");
  const nodeLibOverride = process.env.ELECTRON_NODE_LIB;
  const nodeLib =
    nodeLibOverride ||
    (await downloadElectronNodeLib(
      electronVersion,
      targetArch,
      resolve(
        root,
        "node_modules/.cache/electron-headers",
        `v${electronVersion}`,
        `win-${targetArch}`,
      ),
    ));

  const clArgs = [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/MD",
    "/c",
    "/DWIN32_LEAN_AND_MEAN",
    "/DNOMINMAX",
    "/DNAPI_VERSION=8",
    `/I${nodeApiHeaders}`,
    source,
    `/Fo${object}`,
  ];
  const linkArgs = [
    "/nologo",
    "/DLL",
    `/OUT:${output}`,
    object,
    nodeLib,
    "user32.lib",
    "delayimp.lib",
    "/DELAYLOAD:node.exe",
  ];
  runMsvc(clArgs, linkArgs, targetArch === "x64" ? "amd64" : "arm64");
}

if (process.platform === "darwin") {
  buildDarwin();
} else if (process.platform === "win32") {
  await buildWindows();
}
