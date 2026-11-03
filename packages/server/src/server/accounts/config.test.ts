import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientHeaders, resolveArenaAccessConfig } from "./config.js";

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
  // The machine facts are read once per process, so each case that fakes them loads a fresh module.
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
        "X-Agent-Duel-OS-Version",
        "X-Agent-Duel-Timezone",
        "X-Agent-Duel-Version",
      ].sort(),
    );
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
