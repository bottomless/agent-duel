import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientHeaders,
  linuxOsName,
  macOsName,
  resolveArenaAccessConfig,
  windowsOsName,
} from "./config.js";

describe("resolveArenaAccessConfig", () => {
  it("leaves a daemon without Arena or a control plane alone", () => {
    expect(resolveArenaAccessConfig({ PASEO_NODE_ENV: "development" })).toEqual({ kind: "none" });
  });

  it("uses the configured development verification key and trims the control-plane URL", () => {
    expect(
      resolveArenaAccessConfig({
        PASEO_NODE_ENV: "development",
        PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8790/",
        PASEO_SESSION_PUBLIC_KEY: " development-public-key ",
      }),
    ).toEqual({
      kind: "accounts",
      accounts: {
        controlPlaneUrl: "http://127.0.0.1:8790",
        development: true,
        sessionPublicKey: "development-public-key",
      },
    });
  });

  it.each([
    {
      PASEO_NODE_ENV: "production",
      PASEO_CONTROL_PLANE_URL: "https://api.agentduel.test",
      PASEO_ARENA_BACKEND_EXECUTABLE: "/Applications/Agent Duel.app/Contents/Resources/arena",
    },
    {
      PASEO_NODE_ENV: "development",
      PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8790",
    },
  ])("requires a public verification key when a control plane is configured: %j", (env) => {
    expect(() => resolveArenaAccessConfig(env)).toThrow("PASEO_SESSION_PUBLIC_KEY is required");
  });

  it("signs in through the control plane of an official build", () => {
    expect(
      resolveArenaAccessConfig({
        PASEO_NODE_ENV: "production",
        PASEO_CONTROL_PLANE_URL: "https://api.agentduel.test",
        PASEO_SESSION_PUBLIC_KEY: "public-key",
        PASEO_ARENA_BACKEND_EXECUTABLE: "/Applications/Agent Duel.app/Contents/Resources/arena",
      }),
    ).toEqual({
      kind: "accounts",
      accounts: {
        controlPlaneUrl: "https://api.agentduel.test",
        development: false,
        sessionPublicKey: "public-key",
      },
    });
  });

  it("runs a production Arena without a control plane on the user's key", () => {
    expect(
      resolveArenaAccessConfig({
        PASEO_NODE_ENV: "production",
        PASEO_ARENA_BACKEND_EXECUTABLE: "/opt/agent-duel/arena",
      }),
    ).toEqual({ kind: "byok" });
  });

  it("runs a source checkout without a control plane on the user's key", () => {
    const backendRoot = mkdtempSync(path.join(os.tmpdir(), "agent-duel-byok-config-"));
    try {
      expect(
        resolveArenaAccessConfig({
          PASEO_NODE_ENV: "development",
          PASEO_ARENA_BACKEND_ROOT: backendRoot,
        }),
      ).toEqual({ kind: "byok" });
    } finally {
      rmSync(backendRoot, { recursive: true, force: true });
    }
  });

  it("signs in when the source checkout's backend env names a control plane", () => {
    const backendRoot = mkdtempSync(path.join(os.tmpdir(), "agent-duel-hosted-config-"));
    try {
      writeFileSync(
        path.join(backendRoot, ".env"),
        "PASEO_CONTROL_PLANE_URL=http://127.0.0.1:8790\n",
      );
      expect(
        resolveArenaAccessConfig({
          PASEO_NODE_ENV: "development",
          PASEO_ARENA_BACKEND_ROOT: backendRoot,
          PASEO_SESSION_PUBLIC_KEY: "development-public-key",
        }),
      ).toEqual({
        kind: "accounts",
        accounts: {
          controlPlaneUrl: "http://127.0.0.1:8790",
          development: true,
          sessionPublicKey: "development-public-key",
        },
      });
    } finally {
      rmSync(backendRoot, { recursive: true, force: true });
    }
  });

  it("lets an empty control-plane URL in the environment override the backend env file", () => {
    const backendRoot = mkdtempSync(path.join(os.tmpdir(), "agent-duel-byok-override-"));
    try {
      writeFileSync(
        path.join(backendRoot, ".env"),
        "PASEO_CONTROL_PLANE_URL=http://127.0.0.1:8790\n",
      );
      expect(
        resolveArenaAccessConfig({
          PASEO_NODE_ENV: "development",
          PASEO_ARENA_BACKEND_ROOT: backendRoot,
          PASEO_CONTROL_PLANE_URL: "",
        }),
      ).toEqual({ kind: "byok" });
    } finally {
      rmSync(backendRoot, { recursive: true, force: true });
    }
  });

  it("leaves an unrelated production daemon without Arena configuration", () => {
    expect(resolveArenaAccessConfig({ PASEO_NODE_ENV: "production" })).toEqual({ kind: "none" });
  });

  it("does not read the removed Arena store variable", () => {
    expect(
      resolveArenaAccessConfig({
        PASEO_NODE_ENV: "development",
        PASEO_ARENA_STORE_URL: "http://127.0.0.1:8790",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("clientHeaders", () => {
  const hostPlatform = process.platform;
  // The machine facts are read once per process, so each case that fakes them loads a fresh module.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: hostPlatform, writable: true });
  });

  it("sends the build and coarse machine facts", () => {
    const headers = clientHeaders("0.4.0-beta.14");
    expect(headers).toMatchObject({
      "X-Agent-Duel-Version": "0.4.0-beta.14",
      "X-Agent-Duel-OS": process.platform,
      "X-Agent-Duel-OS-Version": os.release(),
      "X-Agent-Duel-Arch": process.arch,
      "X-Agent-Duel-Memory-GB": String(Math.round(os.totalmem() / 1024 ** 3)),
      "X-Agent-Duel-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(Object.keys(headers).sort()).toEqual(
      [
        "X-Agent-Duel-Arch",
        "X-Agent-Duel-CPU",
        "X-Agent-Duel-CPU-Cores",
        "X-Agent-Duel-Memory-GB",
        "X-Agent-Duel-OS",
        "X-Agent-Duel-OS-Name",
        "X-Agent-Duel-OS-Version",
        "X-Agent-Duel-Timezone",
        "X-Agent-Duel-Version",
      ].sort(),
    );
  });

  it("names the Windows release from the build number", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    const fresh = await import("./config.js");
    expect(fresh.clientHeaders("0.4.0-beta.14")["X-Agent-Duel-OS-Name"]).toBe("Windows 11 26100");
  });

  it("leaves out the OS name when the release is not one it can read", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    vi.spyOn(os, "release").mockReturnValue("6.3.9600");
    const fresh = await import("./config.js");
    expect(fresh.clientHeaders("0.4.0-beta.14")).not.toHaveProperty("X-Agent-Duel-OS-Name");
  });

  it("keeps a CPU name to printable ASCII so fetch accepts it", async () => {
    const cpu = {
      model: "  Intel(R)\u00ae Core\u2122  i7   ",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    };
    vi.spyOn(os, "cpus").mockReturnValue([cpu, cpu]);
    const fresh = await import("./config.js");
    const headers = fresh.clientHeaders("0.4.0-beta.14");
    expect(headers["X-Agent-Duel-CPU"]).toBe("Intel(R) Core i7");
    expect(headers["X-Agent-Duel-CPU-Cores"]).toBe("2");
    expect(() => new Headers(headers)).not.toThrow();
  });

  it("leaves out the CPU when the OS reports none", async () => {
    vi.spyOn(os, "cpus").mockReturnValue([]);
    const fresh = await import("./config.js");
    const headers = fresh.clientHeaders("0.4.0-beta.14");
    expect(headers).not.toHaveProperty("X-Agent-Duel-CPU");
    expect(headers).not.toHaveProperty("X-Agent-Duel-CPU-Cores");
  });
});

describe("linuxOsName", () => {
  it("names the distribution and its version", () => {
    const osRelease = [
      'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
      'NAME="Ubuntu"',
      'VERSION_ID="24.04"',
      'VERSION="24.04.1 LTS (Noble Numbat)"',
      "ID=ubuntu",
      "ID_LIKE=debian",
      "",
    ].join("\n");
    expect(linuxOsName(osRelease)).toBe("ubuntu 24.04");
  });

  it("names a rolling release without a version", () => {
    expect(linuxOsName('NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n')).toBe("arch");
  });

  it("keeps the name to printable ASCII", () => {
    expect(linuxOsName("ID='caf\u00e9os'\nVERSION_ID=1\u2122\n")).toBe("cafos 1");
  });

  it("sends nothing without a distribution ID", () => {
    expect(linuxOsName('NAME="Linux"\nVERSION_ID=1\n')).toBeNull();
    expect(linuxOsName("")).toBeNull();
  });
});

describe("macOsName", () => {
  it("names the macOS version, which the Darwin release drops a digit of", () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "\t<key>ProductBuildVersion</key>",
      "\t<string>25G83</string>",
      "\t<key>ProductName</key>",
      "\t<string>macOS</string>",
      "\t<key>ProductVersion</key>",
      "\t<string>26.6.2</string>",
      "</dict>",
      "</plist>",
    ].join("\n");
    expect(macOsName(plist)).toBe("macOS 26.6.2");
  });

  it("sends nothing without a numeric ProductVersion", () => {
    expect(macOsName("<dict><key>ProductName</key><string>macOS</string></dict>")).toBeNull();
    expect(macOsName("<key>ProductVersion</key><string>26 beta</string>")).toBeNull();
  });
});

describe("windowsOsName", () => {
  it("tells Windows 11 from Windows 10 by the build number", () => {
    expect(windowsOsName("10.0.26100")).toBe("Windows 11 26100");
    expect(windowsOsName("10.0.22000")).toBe("Windows 11 22000");
    expect(windowsOsName("10.0.19045")).toBe("Windows 10 19045");
  });

  it("sends nothing for a release it cannot read", () => {
    expect(windowsOsName("6.3.9600")).toBeNull();
    expect(windowsOsName("")).toBeNull();
  });
});
