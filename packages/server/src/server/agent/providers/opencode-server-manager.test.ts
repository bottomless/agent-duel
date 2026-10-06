import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "../../managed-processes/managed-processes.js";
import type { ProcessTerminator, TreeKillTarget } from "../../../utils/tree-kill.js";
import {
  OpenCodeServerManager,
  resolveOpenCodeServerLaunch,
  type OpenCodeCommandPrefixResolver,
  type OpenCodePortAllocator,
  type OpenCodeServerProcessSpawner,
} from "./opencode/server-manager.js";
import { createArenaByokService } from "../../accounts/byok.js";
import { clearArenaCredentials, installArenaCredentials } from "../../accounts/credentials.js";

afterEach(() => {
  vi.useRealTimers();
  clearArenaCredentials();
});

describe("Agent Arena OpenCode launch", () => {
  test("launches the Arena backend checkout with Bun", async () => {
    const arenaRoot = path.join(path.sep, "checkouts", "agent-arena");
    const launch = await resolveOpenCodeServerLaunch(undefined, {
      arenaBackendRoot: arenaRoot,
      findBunBinary: async () => path.join(path.sep, "tools", "bun"),
      fileExists: async (filePath) => !filePath.endsWith(".env"),
    });

    expect(launch).toEqual({
      command: path.join(path.sep, "tools", "bun"),
      args: [
        "--no-env-file",
        "--smol",
        "--cwd",
        path.join(arenaRoot, "packages", "opencode"),
        "--conditions=browser",
        "src/index.ts",
        "--hostname",
        "127.0.0.1",
      ],
      source: "default",
      kind: "arena-source",
      arenaBackendRoot: arenaRoot,
    });
  });

  test("disables backend env files and preserves appended arguments", async () => {
    const arenaRoot = path.join(path.sep, "checkouts", "agent-arena");
    const launch = await resolveOpenCodeServerLaunch(
      { command: { mode: "append", args: ["--mdns"] } },
      {
        arenaBackendRoot: arenaRoot,
        findBunBinary: async () => "bun",
        fileExists: async () => true,
      },
    );

    expect(launch.args).toEqual([
      "--no-env-file",
      "--smol",
      "--cwd",
      path.join(arenaRoot, "packages", "opencode"),
      "--conditions=browser",
      "src/index.ts",
      "--hostname",
      "127.0.0.1",
      "--mdns",
    ]);
    expect(launch.source).toBe("append");
  });

  test("an explicit provider command takes precedence over the source checkout", async () => {
    const launch = await resolveOpenCodeServerLaunch(
      { command: { mode: "replace", argv: ["arena-opencode", "--embedded"] } },
      {
        arenaBackendRoot: path.join(path.sep, "missing"),
        fileExists: async () => false,
      },
    );

    expect(launch).toEqual({
      command: "arena-opencode",
      args: ["--embedded"],
      source: "override",
      kind: "configured",
      arenaBackendRoot: null,
    });
  });

  test("rejects an invalid Arena backend checkout", async () => {
    await expect(
      resolveOpenCodeServerLaunch(undefined, {
        arenaBackendRoot: path.join(path.sep, "missing"),
        fileExists: async () => false,
      }),
    ).rejects.toThrow("does not point to an Agent Arena backend checkout");
  });
});

describe("OpenCodeServerManager generations", () => {
  test("hands Arena credentials and only a control-token verifier through stdin", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "session-token",
      controlPlaneUrl: "https://control.test",
    });
    const { manager, runtime } = createTestManager([4081], { launchKind: "arena-source" });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.args).toContain("--arena-credentials-stdin");
    expect(runtime.spawnCalls[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(runtime.spawnCalls[0]?.options.envOverlay).toMatchObject({
      OPENROUTER_API_KEY: undefined,
      PASEO_ARENA_SESSION_TOKEN: undefined,
      PASEO_OPENROUTER_BASE_URL: undefined,
      PASEO_OPENCODE_CONTROL_TOKEN: undefined,
    });
    const payload = readStdinPayload(runtime, 4081);
    expect(Object.keys(payload).toSorted()).toEqual([
      "controlPlaneUrl",
      "controlTokenHash",
      "mode",
      "token",
    ]);
    expect(payload.mode).toBe("hosted");
    expect(payload.token).not.toBe("session-token");
    expect(payload.token).toHaveLength(43);
    expect(payload.controlPlaneUrl).toBe("http://localhost:6768/api/arena-runtime");
    expect(payload.controlTokenHash).toBe(
      createHash("sha256").update(acquisition.server.controlToken).digest("hex"),
    );
    expect(JSON.stringify(payload)).not.toContain(acquisition.server.controlToken);
    expect(JSON.stringify(runtime.spawnCalls[0]?.args)).not.toContain(
      acquisition.server.controlToken,
    );
    expect(JSON.stringify(runtime.spawnCalls[0]?.options.envOverlay)).not.toContain(
      acquisition.server.controlToken,
    );
    await acquisition.release();
  });

  test("refuses to start Arena without a signed-in account or an OpenRouter key", async () => {
    const { manager, runtime } = createTestManager([4082], { launchKind: "arena-binary" });

    await expect(manager.acquireCurrent()).rejects.toThrow("Arena credentials are unavailable");
    expect(runtime.spawnCalls).toHaveLength(0);
  });

  test("refuses to start a signed-in Arena without a TCP daemon for its runtime proxy", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "session-token",
      controlPlaneUrl: "https://control.test",
    });
    const { manager, runtime } = createTestManager([4089], {
      launchKind: "arena-binary",
      getArenaPreviewBaseUrl: () => null,
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("Arena credentials are unavailable");
    expect(runtime.spawnCalls).toHaveLength(0);
  });

  test("hands a BYOK key only through stdin, without a runtime proxy capability", async () => {
    installArenaCredentials({ mode: "byok", openRouterApiKey: "sk-or-v1-private" });
    const { manager, runtime } = createTestManager([4090], {
      launchKind: "arena-source",
      getArenaPreviewBaseUrl: () => null,
    });

    const acquisition = await manager.acquireCurrent();

    expect(readStdinPayload(runtime, 4090)).toEqual({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-private",
      controlTokenHash: createHash("sha256").update(acquisition.server.controlToken).digest("hex"),
    });
    expect(runtime.spawnCalls[0]?.args).toContain("--arena-credentials-stdin");
    expect(runtime.spawnCalls[0]?.options.envOverlay).toMatchObject({
      OPENROUTER_API_KEY: undefined,
      PASEO_ARENA_SESSION_TOKEN: undefined,
      PASEO_OPENROUTER_BASE_URL: undefined,
      PASEO_OPENCODE_CONTROL_TOKEN: undefined,
    });
    expect(JSON.stringify(runtime.spawnCalls[0])).not.toContain("sk-or-v1-private");
    await acquisition.release();
  });

  test("restarts Arena with the new key when the BYOK key changes", async () => {
    const { manager, runtime } = createTestManager([4094, 4095, 4096], {
      launchKind: "arena-binary",
    });
    const byok = createArenaByokService({ restartArena: () => manager.shutdown() });
    await byok.setKey("sk-or-v1-first");
    const first = await manager.acquireCurrent();
    expect(readStdinPayload(runtime, 4094).openRouterApiKey).toBe("sk-or-v1-first");

    await byok.setKey("sk-or-v1-first");
    expect(runtime.terminatedPorts).toEqual([]);
    await byok.setKey("sk-or-v1-second");
    expect(runtime.terminatedPorts).toEqual([4094]);

    const second = await manager.acquireCurrent();
    expect(second.server.port).toBe(4095);
    expect(readStdinPayload(runtime, 4095).openRouterApiKey).toBe("sk-or-v1-second");
    await byok.setKey(null);
    expect(runtime.terminatedPorts).toEqual([4094, 4095]);
    await expect(manager.acquireCurrent()).rejects.toThrow("Arena credentials are unavailable");
    await first.release();
    await second.release();
  });

  test("shuts down an Arena launch that becomes stale while starting", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "old-token",
      controlPlaneUrl: "https://control.test",
    });
    const { manager, runtime } = createTestManager([4083], {
      autoAnnounce: false,
      launchKind: "arena-source",
    });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();
    installArenaCredentials({
      mode: "hosted",
      token: "new-token",
      controlPlaneUrl: "https://control.test",
    });
    await manager.shutdown();

    await expect(acquisition).rejects.toThrow("OpenCode server exited");
    expect(runtime.terminatedPorts).toEqual([4083]);
  });

  test("does not leave an unhandled startup rejection when Arena stdin is unavailable", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "session-token",
      controlPlaneUrl: "https://control.test",
    });
    const { manager, runtime } = createTestManager([4084], {
      launchKind: "arena-binary",
      includeStdin: false,
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("Arena server stdin is unavailable");
    expect(runtime.terminatedPorts).toEqual([4084]);
  });

  test("fails a launch cleanly when its credential pipe reports EPIPE", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "session-token",
      controlPlaneUrl: "https://control.test",
    });
    const { manager, runtime } = createTestManager([4085], {
      autoAnnounce: false,
      launchKind: "arena-binary",
    });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4085).stdin?.emit("error", new Error("EPIPE"));

    await expect(acquisition).rejects.toThrow("EPIPE");
    expect(runtime.terminatedPorts).toEqual([4085]);
  });

  test("rejects a launch whose port allocation completes after shutdown starts", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "old-token",
      controlPlaneUrl: "https://control.test",
    });
    let resolvePort: ((port: number) => void) | undefined;
    const portReady = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const { manager, runtime } = createTestManager([4086], {
      launchKind: "arena-source",
      portAllocator: () => portReady,
    });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();
    await manager.shutdown();
    resolvePort?.(4086);

    await expect(acquisition).rejects.toThrow("startup was interrupted by shutdown");
    expect(runtime.spawnCalls).toHaveLength(0);
  });

  test("waits for in-flight shutdown before spawning a replacement", async () => {
    let resolveTermination: (() => void) | undefined;
    const terminationReady = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    const { manager, runtime } = createTestManager([4087, 4088], {
      terminationGate: terminationReady,
    });

    const first = await manager.acquireCurrent();
    const shutdown = manager.shutdown();
    await runtime.settle();
    expect(manager.acquireExisting(first.server.url)).toBeNull();
    const replacement = manager.acquireCurrent();
    await runtime.settle();
    expect(runtime.spawnCalls).toHaveLength(1);

    resolveTermination?.();
    await shutdown;
    const second = await replacement;

    expect(second.server.port).toBe(4088);
    await first.release();
    await second.release();
  });

  test("uses an explicit base environment for the server process", async () => {
    const baseEnv = { HOME: "/isolated/home", PATH: "/isolated/bin" };
    const { manager, runtime } = createTestManager([4091], { baseEnv });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.options.baseEnv).toEqual(baseEnv);
    await acquisition.release();
  });

  test("passes the Arena preview proxy base URL to the server process", async () => {
    const { manager, runtime } = createTestManager([4092], {
      getArenaPreviewBaseUrl: () => "http://localhost:6771",
    });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.options.envOverlay).toMatchObject({
      PASEO_ARENA_PREVIEW_BASE_URL: "http://localhost:6771",
    });
    await acquisition.release();
  });

  test("passes a private control token to the helper and its acquisitions", async () => {
    const { manager, runtime } = createTestManager([4093], {
      controlToken: "private-control-token",
    });

    const acquisition = await manager.acquireCurrent();

    expect(acquisition.server.controlToken).toBe("private-control-token");
    expect(runtime.spawnCalls[0]?.options.envOverlay).toMatchObject({
      PASEO_OPENCODE_CONTROL_TOKEN: "private-control-token",
    });
    await acquisition.release();
  });

  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4102, 4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquireCurrent();
    const rotatedAcquisition = await manager.acquireNew();
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    await rotatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);
    await nextAcquisition.release();
    await oldAcquisition.release();
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquireCurrent();
    await initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    await modesAcquisition.release();
    await modelsAcquisition.release();
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();
    await newAcquisition.release();

    await oldAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4302, 4301]);
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4401, 4402]);

    await manager.acquireCurrent();
    await manager.acquireNew();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4402, 4401]);
  });

  test("shutdown still signals a process after an earlier kill signal if it has not exited", async () => {
    const { manager, runtime } = createTestManager([4451]);

    await manager.acquireCurrent();
    runtime.processForPort(4451).markKillSignalSent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4451]);
  });

  test("startup timeout kills the spawned server and removes its managed-process record", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4471], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4471]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown kills a server that is still starting", async () => {
    const { manager, runtime } = createTestManager([4472], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();

    await manager.shutdown();

    await expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    expect(runtime.terminatedPorts).toEqual([4472]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("dedicated server startup is protected from retired cleanup", async () => {
    const { manager, runtime } = createTestManager([4473, 4474], { autoAnnounce: false });

    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4473).announceListening();
    const currentAcquisition = await currentStart;

    const dedicatedStart = manager.acquireDedicated({ TEST_ENV: "custom" });
    await runtime.settle();

    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473]);

    runtime.processForPort(4474).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4474");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473, 4474]);
  });

  test("acquireExisting keeps a retired dedicated server alive until every reference releases", async () => {
    const { manager, runtime } = createTestManager([4475]);

    const dedicatedAcquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const existingAcquisition = manager.acquireExisting(dedicatedAcquisition.server.url);

    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4475");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await existingAcquisition?.release();
    expect(runtime.terminatedPorts).toEqual([4475]);
  });

  test("acquireExisting returns null for unknown or dead server urls", async () => {
    const { manager, runtime } = createTestManager([4476]);

    const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const url = acquisition.server.url;

    expect(manager.acquireExisting("http://127.0.0.1:9999")).toBe(null);

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4476]);
    expect(manager.acquireExisting(url)).toBe(null);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquireCurrent();
    const secondAcquisition = await manager.acquireNew();
    await secondAcquisition.release();
    const thirdAcquisition = await manager.acquireNew();
    await thirdAcquisition.release();
    await firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4503, 4501]);
  });

  test("final release detaches the terminating generation before a concurrent acquire", async () => {
    const { manager, runtime } = createTestManager([4551, 4552]);

    const first = await manager.acquireCurrent();
    const release = first.release();
    const next = await manager.acquireCurrent();

    await release;
    expect(next.server.url).toBe("http://127.0.0.1:4552");
    expect(runtime.terminatedPorts).toEqual([4551]);

    await next.release();
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4601]);

    await manager.acquireCurrent();

    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 14601,
        command: "opencode",
        args: ["serve", "--port", "4601"],
        metadata: { port: 4601 },
        identity: { commandLine: null, startedAt: null },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4601).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4602]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("starts helper server from opencode-home", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-server-home-"));
    const opencodeHomeDir = path.join(tempDir, "opencode-home");
    try {
      const { manager, runtime } = createTestManager([4603], { opencodeHomeDir });

      const acquisition = await manager.acquireCurrent();

      expect(runtime.spawnCalls).toEqual([
        expect.objectContaining({
          command: "opencode",
          args: ["serve", "--port", "4603"],
          options: expect.objectContaining({ cwd: opencodeHomeDir }),
        }),
      ]);

      await acquisition.release();
      await manager.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")(
  "OpenCodeServerManager Windows OpenCode npm install",
  () => {
    test("starts the helper server from opencode.exe instead of the npm opencode.cmd shim", async () => {
      const detectedOpenCode = await findExecutable("opencode");
      expect(detectedOpenCode, "Windows CI must install opencode-ai before server tests").not.toBe(
        null,
      );
      expect(path.extname(detectedOpenCode!).toLowerCase()).toBe(".cmd");

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-real-windows-"));
      const opencodeHomeDir = path.join(tempDir, "opencode-home");
      const managedProcesses = new FakeManagedProcesses();
      const manager = new OpenCodeServerManager({
        logger: createTestLogger(),
        managedProcesses,
        resolveHomeDir: () => opencodeHomeDir,
      });
      let acquiredPort: number | null = null;

      try {
        const acquisition = await manager.acquireDedicated({
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_PURE: "1",
          OPENCODE_TEST_HOME: path.join(tempDir, "test-home"),
        });
        acquiredPort = acquisition.server.port;

        const records = await managedProcesses.list();
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(path.extname(record.command).toLowerCase()).toBe(".exe");
        expect(path.normalize(record.command).toLowerCase()).toContain(
          path.normalize("node_modules/opencode-ai/bin/opencode.exe").toLowerCase(),
        );
        expect(record.command.toLowerCase()).not.toBe(detectedOpenCode!.toLowerCase());
        expect(record.args).toEqual(["serve", "--port", String(acquiredPort)]);
      } finally {
        await manager.shutdown().catch(() => undefined);
        if (acquiredPort !== null) {
          await waitForClosedPort(acquiredPort, 5_000);
        }
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 60_000);
  },
);

function readStdinPayload(
  runtime: FakeOpenCodeServerRuntime,
  port: number,
): Record<string, unknown> {
  return JSON.parse(runtime.processForPort(port).stdin?.read()?.toString() ?? "null");
}

function createTestManager(
  ports: number[],
  options: {
    autoAnnounce?: boolean;
    baseEnv?: Record<string, string>;
    opencodeHomeDir?: string;
    getArenaPreviewBaseUrl?: () => string | null;
    controlToken?: string;
    launchKind?: "arena-source" | "arena-binary";
    includeStdin?: boolean;
    portAllocator?: () => Promise<number>;
    terminationGate?: Promise<void>;
  } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const { opencodeHomeDir } = options;
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
    launchKind: options.launchKind,
    includeStdin: options.includeStdin,
    terminationGate: options.terminationGate,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: createTestLogger(),
      baseEnv: options.baseEnv,
      managedProcesses: runtime.managedProcesses,
      portAllocator: options.portAllocator ?? runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      resolveHomeDir: () =>
        opencodeHomeDir ?? path.join(os.tmpdir(), "agent-duel-opencode-server-manager-test"),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: runtime.terminateProcess,
      getArenaPreviewBaseUrl: options.getArenaPreviewBaseUrl ?? (() => "http://localhost:6768"),
      controlToken: options.controlToken,
    }),
    runtime,
  };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses = new FakeManagedProcesses();
  readonly terminatedPorts: number[] = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private readonly includeStdin: boolean;
  private readonly terminationGate?: Promise<void>;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  private readonly launchKind?: "arena-source" | "arena-binary";

  constructor(
    ports: number[],
    options: {
      autoAnnounce: boolean;
      launchKind?: "arena-source" | "arena-binary";
      includeStdin?: boolean;
      terminationGate?: Promise<void>;
    },
  ) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
    this.launchKind = options.launchKind;
    this.includeStdin = options.includeStdin ?? true;
    this.terminationGate = options.terminationGate;
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake OpenCode port available");
    }
    return port;
  };

  readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver = async () => ({
    command: "opencode",
    args: [],
    ...(this.launchKind ? { kind: this.launchKind } : {}),
  });

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
    this.spawnCalls.push({ command, args, options });
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeProcess({
      port,
      pid: 10_000 + port,
      includeStdin: this.includeStdin,
    });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    if (this.autoAnnounce) {
      queueMicrotask(() => process.announceListening());
    }
    return process.child;
  };

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget) => {
    const process = this.processForChild(target as ChildProcess);
    this.terminatedPorts.push(process.port);
    await this.terminationGate;
    process.exitBySignal("SIGTERM");
    return "terminated";
  };

  processForPort(port: number): FakeOpenCodeProcess {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake OpenCode process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  private processForChild(child: ChildProcess): FakeOpenCodeProcess {
    const process = this.processesByChild.get(child);
    if (!process) {
      throw new Error("Unknown fake OpenCode process");
    }
    return process;
  }
}

class FakeOpenCodeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: PassThrough | null;
  readonly child: ChildProcess;
  readonly port: number;
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { port: number; pid: number; includeStdin?: boolean }) {
    super();
    this.port = options.port;
    this.pid = options.pid;
    this.stdin = options.includeStdin === false ? null : new PassThrough();
    this.child = this as unknown as ChildProcess;
  }

  announceListening(): void {
    this.stdout.emit("data", Buffer.from("listening on"));
  }

  exitNormally(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  exitBySignal(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }

  markKillSignalSent(): void {
    this.killed = true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exitBySignal(signal ?? "SIGTERM");
    return true;
  }
}

class FakeManagedProcesses implements ManagedProcessRegistry {
  private records: ManagedProcessRecord[] = [];

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const record: ManagedProcessRecord = {
      id: `managed-process-${this.records.length + 1}`,
      ...input,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: "test-created-at",
    };
    this.records.push(record);
    return record;
  }

  async remove(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }

  async list(): Promise<ManagedProcessRecord[]> {
    return this.records;
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    return {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };
  }
}

async function waitForClosedPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnectToPort(port))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`OpenCode helper server still accepts connections on port ${port}`);
}

function canConnectToPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
