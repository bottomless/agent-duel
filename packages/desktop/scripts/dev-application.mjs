import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const APP_NAME = "Agent Duel Dev";
const BUNDLE_ID = "sh.paseo.desktop.dev";

export async function prepareDevApplication({
  electronPath,
  rootDir,
  runtimeDir = path.join(os.homedir(), "Library/Application Support/Agent Duel/Development"),
  platform = process.platform,
}) {
  if (platform !== "darwin") return electronPath;

  const sourceBundle = path.resolve(electronPath, "../../..");
  const iconPath = path.join(rootDir, "packages/desktop/assets/icon.icns");
  const fingerprint = createHash("sha256");
  for (const file of [
    new URL(import.meta.url),
    path.join(sourceBundle, "Contents/Info.plist"),
    electronPath,
    iconPath,
  ]) {
    fingerprint.update(await readFile(file));
  }
  const checkoutId = createHash("sha256").update(path.resolve(rootDir)).digest("hex").slice(0, 12);
  const cacheRoot = path.join(runtimeDir, checkoutId);
  const cacheDir = path.join(cacheRoot, fingerprint.digest("hex").slice(0, 20));
  const bundleName = `${APP_NAME}.app`;
  // Keep Electron's executable names: renaming them makes app.isPackaged true.
  const executable = path.join(cacheDir, bundleName, "Contents/MacOS/Electron");
  if (existsSync(executable)) return executable;

  await mkdir(cacheRoot, { recursive: true });
  const stagingDir = await mkdtemp(path.join(cacheRoot, ".prepare-"));
  try {
    const bundle = path.join(stagingDir, bundleName);
    await cp(sourceBundle, bundle, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const plist = path.join(bundle, "Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleName: APP_NAME,
      CFBundleDisplayName: APP_NAME,
      CFBundleIdentifier: BUNDLE_ID,
      CFBundleIconFile: "agent-duel.icns",
    })) {
      execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    }
    await copyFile(iconPath, path.join(bundle, "Contents/Resources/agent-duel.icns"));

    const frameworks = path.join(bundle, "Contents/Frameworks");
    for (const helper of await readdir(frameworks)) {
      if (!helper.startsWith("Electron Helper") || !helper.endsWith(".app")) continue;
      const helperPlist = path.join(frameworks, helper, "Contents/Info.plist");
      const helperId = execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", helperPlist],
        { encoding: "utf8" },
      ).trim();
      execFileSync("/usr/bin/plutil", [
        "-replace",
        "CFBundleIdentifier",
        "-string",
        helperId.replace("com.github.Electron", BUNDLE_ID),
        helperPlist,
      ]);
    }
    // Re-sign only this generated copy after changing its bundle metadata.
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", bundle],
      { stdio: "pipe" },
    );
    await rename(stagingDir, cacheDir);
    return executable;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
