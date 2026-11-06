// Installs Electron's binary when node_modules/electron has none. Electron 44
// dropped its postinstall, so on a fresh install this script is what puts the
// binary in place, on every platform. Older Electron postinstalls used
// extract-zip, which stops partway on newer Node releases (seen on Node 26) and
// leaves the app bundle without its frameworks or path.txt. Either way, unpack
// the downloaded zip with the platform's own unzip tool.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const electronDir = resolve("node_modules/electron");
if (!existsSync(join(electronDir, "package.json")) || process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  process.exit(0);
}

const platformPath = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  mas: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  freebsd: "electron",
  openbsd: "electron",
  win32: "electron.exe",
}[process.platform];
if (!platformPath) process.exit(0);

const dist = join(electronDir, "dist");
const complete = () => {
  const recorded = existsSync(join(electronDir, "path.txt"))
    ? readFileSync(join(electronDir, "path.txt"), "utf8")
    : "";
  if (recorded !== platformPath || !existsSync(join(dist, platformPath))) return false;
  // The binary alone is not enough on macOS: a cut-off extraction leaves it without its framework.
  if (process.platform !== "darwin") return true;
  return existsSync(join(dist, "Electron.app/Contents/Frameworks/Electron Framework.framework"));
};
if (complete()) process.exit(0);

const require = createRequire(join(electronDir, "package.json"));
const { version } = require("./package.json");
const { downloadArtifact } = require("@electron/get");
const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  platform: process.platform,
  arch: process.env.npm_config_arch || process.arch,
  checksums: require("./checksums.json"),
});

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
// Windows' own tar.exe (bsdtar) unpacks zips. A bare `tar` can resolve to Git's GNU tar, which is
// first on PATH under Git Bash (the release workflow's shell) and reads the `C:` in the zip path as
// a remote host: "Cannot connect to C: resolve failed".
const windowsTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const unzipCommand = {
  darwin: ["ditto", ["-x", "-k", zipPath, dist]],
  win32: [windowsTar, ["-xf", zipPath, "-C", dist]],
}[process.platform] ?? ["unzip", ["-q", "-o", zipPath, "-d", dist]];
const unzip = spawnSync(...unzipCommand, { stdio: "inherit" });
if (unzip.status !== 0) {
  console.error(
    `[ensure-electron] Could not extract ${zipPath}; delete node_modules/electron and reinstall.`,
  );
  process.exit(1);
}
writeFileSync(join(electronDir, "path.txt"), platformPath);
if (!complete()) {
  console.error("[ensure-electron] Electron is still incomplete after extraction.");
  process.exit(1);
}
console.log(`[ensure-electron] Repaired the Electron ${version} binary.`);
