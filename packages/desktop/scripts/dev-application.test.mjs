import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { prepareDevApplication } from "./dev-application.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const temporaryRoots = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["linux", "win32"])("keeps the existing %s runtime", async (platform) => {
  expect(await prepareDevApplication({ electronPath, rootDir: "/unused", platform })).toBe(
    electronPath,
  );
});

describe.runIf(process.platform === "darwin")("macOS development identity", () => {
  test("prepares a signed app with its own identity and icon without changing Electron", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-duel-dev-app-"));
    temporaryRoots.push(rootDir);
    const assetsDir = path.join(rootDir, "packages/desktop/assets");
    await mkdir(assetsDir, { recursive: true });
    const iconPath = path.join(assetsDir, "icon.icns");
    await copyFile(new URL("../assets/icon.icns", import.meta.url), iconPath);
    const sourceBundle = path.resolve(electronPath, "../../..");
    const sourcePlist = await readFile(path.join(sourceBundle, "Contents/Info.plist"));

    const runtimeDir = path.join(rootDir, "runtime");
    const executable = await prepareDevApplication({ electronPath, rootDir, runtimeDir });
    const bundle = path.resolve(executable, "../../..");
    const plist = JSON.parse(
      execFileSync(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", path.join(bundle, "Contents/Info.plist")],
        { encoding: "utf8" },
      ),
    );
    expect(plist).toMatchObject({
      CFBundleName: "Agent Duel Dev",
      CFBundleDisplayName: "Agent Duel Dev",
      CFBundleIdentifier: "sh.paseo.desktop.dev",
      CFBundleIconFile: "agent-duel.icns",
      CFBundleExecutable: "Electron",
    });
    expect(await readFile(path.join(bundle, "Contents/Resources/agent-duel.icns"))).toEqual(
      await readFile(iconPath),
    );
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    expect(await readFile(path.join(sourceBundle, "Contents/Info.plist"))).toEqual(sourcePlist);

    const initialStat = await stat(executable);
    expect(await prepareDevApplication({ electronPath, rootDir, runtimeDir })).toBe(executable);
    expect((await stat(executable)).mtimeMs).toBe(initialStat.mtimeMs);

    await copyFile(path.join(sourceBundle, "Contents/Resources/electron.icns"), iconPath);
    const updatedExecutable = await prepareDevApplication({ electronPath, rootDir, runtimeDir });
    expect(updatedExecutable).not.toBe(executable);
    expect(
      await readFile(path.resolve(updatedExecutable, "../../Resources/agent-duel.icns")),
    ).toEqual(await readFile(iconPath));
    expect(await readFile(path.join(bundle, "Contents/Resources/agent-duel.icns"))).toEqual(
      await readFile(new URL("../assets/icon.icns", import.meta.url)),
    );
  }, 60_000);
});
