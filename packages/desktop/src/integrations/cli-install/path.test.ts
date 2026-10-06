import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Agent Duel.app/Contents/MacOS/Agent Duel",
        shimPath: "/Applications/Agent Duel.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Agent Duel.app/Contents/Resources/bin/paseo");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/paseo",
        appImagePath: "/home/user/Applications/Agent Duel.AppImage",
      }),
    ).toBe("/home/user/Applications/Agent Duel.AppImage");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Agent Duel\\Agent Duel.exe",
        shimPath:
          "C:\\Users\\user\\AppData\\Local\\Programs\\Agent Duel\\resources\\bin\\paseo.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Agent Duel\\resources\\bin\\paseo.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Agent Duel/paseo",
        shimPath: "/opt/Agent Duel/resources/bin/paseo",
      }),
    ).toBe("/opt/Agent Duel/resources/bin/paseo");
  });
});
