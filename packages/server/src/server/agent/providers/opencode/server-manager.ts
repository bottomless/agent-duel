import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderLaunchSource,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";
import {
  isArenaCredentialsCurrent,
  issueArenaLaunchCredentials,
  revokeArenaRuntimeCredentials,
  type ArenaCredentials,
  type ArenaCredentialsSnapshot,
} from "../../../accounts/credentials.js";

const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const OPENCODE_CONTROL_TOKEN_ENV = "PASEO_OPENCODE_CONTROL_TOKEN";
export const ARENA_BACKEND_ROOT_ENV = "PASEO_ARENA_BACKEND_ROOT";
export const ARENA_BACKEND_EXECUTABLE_ENV = "PASEO_ARENA_BACKEND_EXECUTABLE";

function hashControlToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The engine's one-time stdin startup payload; `mode` tells it which credential follows. */
function arenaStdinPayload(credentials: ArenaCredentials, controlTokenHash: string): string {
  switch (credentials.mode) {
    case "hosted":
      return JSON.stringify({
        mode: "hosted",
        token: credentials.token,
        controlPlaneUrl: credentials.controlPlaneUrl,
        controlTokenHash,
      });
    case "byok":
      return JSON.stringify({
        mode: "byok",
        openRouterApiKey: credentials.openRouterApiKey,
        controlTokenHash,
      });
  }
}

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string; controlToken: string };
  release: () => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(): Promise<OpenCodeServerAcquisition>;
  acquireNew(): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  shutdown(): Promise<void>;
}

export interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  controlToken: string;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
  arenaRuntimeToken?: string;
}

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{
  command: string;
  args: string[];
  kind?: ResolvedOpenCodeServerLaunch["kind"];
}>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface ResolvedOpenCodeServerLaunch {
  command: string;
  args: string[];
  source: ProviderLaunchSource;
  kind: "arena-source" | "arena-binary" | "configured" | "stock";
  arenaBackendRoot: string | null;
}

interface ResolveOpenCodeServerLaunchOptions {
  arenaBackendRoot?: string | null;
  arenaBackendExecutable?: string | null;
  findBunBinary?: () => Promise<string | null>;
  fileExists?: (filePath: string) => Promise<boolean>;
  resolveStockBinary?: () => Promise<string>;
}

async function resolveArenaSourceLaunch(
  arenaBackendRoot: string,
  runtimeSettings: ProviderRuntimeSettings | undefined,
  options: ResolveOpenCodeServerLaunchOptions,
): Promise<ResolvedOpenCodeServerLaunch> {
  const packageDirectory = path.resolve(arenaBackendRoot, "packages", "opencode");
  const entrypoint = path.join(packageDirectory, "src", "index.ts");
  const fileExists = options.fileExists ?? pathExists;
  if (!(await fileExists(entrypoint))) {
    throw new Error(
      `${ARENA_BACKEND_ROOT_ENV} does not point to an Agent Arena backend checkout: ${entrypoint} was not found.`,
    );
  }

  const findBunBinary = options.findBunBinary ?? (() => findExecutable("bun"));
  const bunBinary = await findBunBinary();
  if (!bunBinary) {
    throw new Error(
      `Bun is required to launch the Agent Arena backend from ${ARENA_BACKEND_ROOT_ENV}.`,
    );
  }

  const appendedArgs =
    runtimeSettings?.command?.mode === "append" ? (runtimeSettings.command.args ?? []) : [];
  return {
    command: bunBinary,
    args: [
      "--no-env-file",
      // Same heap policy as the packaged runtime (`build-arena-runtime.mjs`): collect more often
      // and keep a smaller heap, which a long-lived engine otherwise never gives back.
      "--smol",
      "--cwd",
      packageDirectory,
      "--conditions=browser",
      "src/index.ts",
      "--hostname",
      "127.0.0.1",
      ...appendedArgs,
    ],
    source: runtimeSettings?.command?.mode === "append" ? "append" : "default",
    kind: "arena-source",
    arenaBackendRoot: path.resolve(arenaBackendRoot),
  };
}

async function resolveArenaExecutableLaunch(
  executable: string,
  runtimeSettings: ProviderRuntimeSettings | undefined,
  options: ResolveOpenCodeServerLaunchOptions,
): Promise<ResolvedOpenCodeServerLaunch> {
  const fileExists = options.fileExists ?? pathExists;
  if (!(await fileExists(executable))) {
    throw new Error(`${ARENA_BACKEND_EXECUTABLE_ENV} does not exist: ${executable}`);
  }
  const appendedArgs =
    runtimeSettings?.command?.mode === "append" ? (runtimeSettings.command.args ?? []) : [];
  return {
    command: executable,
    args: ["--hostname", "127.0.0.1", ...appendedArgs],
    source: runtimeSettings?.command?.mode === "append" ? "append" : "default",
    kind: "arena-binary",
    arenaBackendRoot: null,
  };
}

export async function resolveOpenCodeServerLaunch(
  runtimeSettings?: ProviderRuntimeSettings,
  options: ResolveOpenCodeServerLaunchOptions = {},
): Promise<ResolvedOpenCodeServerLaunch> {
  if (runtimeSettings?.command?.mode === "replace") {
    const launch = await resolveProviderLaunch({ commandConfig: runtimeSettings.command });
    return {
      ...launch,
      kind: "configured",
      arenaBackendRoot: null,
    };
  }

  const configuredExecutable =
    options.arenaBackendExecutable === undefined
      ? process.env[ARENA_BACKEND_EXECUTABLE_ENV]
      : options.arenaBackendExecutable;
  const arenaBackendExecutable = configuredExecutable?.trim();
  if (arenaBackendExecutable) {
    return resolveArenaExecutableLaunch(arenaBackendExecutable, runtimeSettings, options);
  }

  const configuredRoot =
    options.arenaBackendRoot === undefined
      ? process.env[ARENA_BACKEND_ROOT_ENV]
      : options.arenaBackendRoot;
  const arenaBackendRoot = configuredRoot?.trim();
  if (arenaBackendRoot) {
    return resolveArenaSourceLaunch(arenaBackendRoot, runtimeSettings, options);
  }

  const resolveStockBinary = options.resolveStockBinary ?? resolveOpenCodeBinary;
  const stockBinary = await resolveStockBinary();
  const launch = await resolveProviderLaunch({
    commandConfig: runtimeSettings?.command,
    defaultBinary: stockBinary,
  });
  return {
    ...launch,
    kind: "stock",
    arenaBackendRoot: null,
  };
}

export interface OpenCodeServerManagerOptions {
  logger: Logger;
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
  getArenaPreviewBaseUrl?: () => string | null;
  controlToken?: string;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private allServers = new Set<OpenCodeServerGeneration>();
  private shutdownPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private readonly logger: Logger;
  private readonly baseEnv?: SpawnProcessOptions["baseEnv"];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodePortAllocator;
  private readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly spawnServerProcess: OpenCodeServerProcessSpawner;
  private readonly getArenaPreviewBaseUrl?: () => string | null;
  private readonly controlToken: string;

  constructor(options: OpenCodeServerManagerOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv;
    this.runtimeSettings = options.runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(this.runtimeSettings ?? {});
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (async () => {
        const launch = await resolveOpenCodeServerLaunch(this.runtimeSettings);
        return launch;
      });
    this.resolveHomeDir = options.resolveHomeDir ?? resolveOpenCodeHomeDir;
    this.spawnServerProcess = options.spawnServerProcess ?? spawnProcess;
    this.getArenaPreviewBaseUrl = options.getArenaPreviewBaseUrl;
    this.controlToken = options.controlToken ?? randomUUID();
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
      OpenCodeServerManager.registerExitHandler();
    } else if (OpenCodeServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode server manager already initialized with different runtime settings",
      );
    }
    return OpenCodeServerManager.instance;
  }

  static async shutdownInstance(): Promise<void> {
    const instance = OpenCodeServerManager.instance;
    OpenCodeServerManager.instance = null;
    await instance?.shutdown();
  }

  /** Stops Arena with its current credential while keeping manager identity stable. */
  static async restartInstance(): Promise<void> {
    await OpenCodeServerManager.instance?.shutdown();
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      void OpenCodeServerManager.shutdownInstance();
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(): Promise<OpenCodeServerAcquisition> {
    const server = await this.getCurrentServer();
    return this.acquireServer(server);
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    const server = await this.getNewServer();
    return this.acquireServer(server);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    const server = await this.startServer(env);
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    if (this.shutdownPromise) {
      return null;
    }
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private findLiveServerByUrl(url: string): OpenCodeServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return servers.find((server) => server.url === url && this.isServerLive(server)) ?? null;
  }

  private isServerLive(server: OpenCodeServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeServerGeneration): OpenCodeServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: { port: server.port, url: server.url, controlToken: server.controlToken },
      release: async () => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.releaseServer(server);
        return releasePromise;
      },
    };
  }

  private async releaseServer(server: OpenCodeServerGeneration): Promise<void> {
    server.refCount = Math.max(0, server.refCount - 1);
    if (server.refCount > 0) {
      return;
    }

    if (this.currentServer === server) {
      this.currentServer = null;
      server.retired = true;
    }
    if (!server.retired) {
      return;
    }

    this.retiredServers.delete(server);
    await this.killServer(server);
  }

  private async getNewServer(): Promise<OpenCodeServerGeneration> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        const server = await this.startServer();
        if (!server.retired) {
          this.currentServer = server;
        }
        await server.ready;
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    if (this.startPromise) {
      const server = await this.startPromise;
      await server.ready;
      return server;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      await this.currentServer.ready;
      return this.currentServer;
    }

    this.startPromise = this.startServer().then((server) => {
      if (!server.retired) {
        this.currentServer = server;
      }
      return server;
    });
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    await result.ready;
    return result;
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      await this.cleanupRetiredServers();
    }
  }

  private async startServer(launchEnv?: Record<string, string>): Promise<OpenCodeServerGeneration> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const ensureCurrentGeneration = () => {
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        throw new Error("OpenCode server startup was interrupted by shutdown");
      }
    };
    const port = await this.portAllocator();
    ensureCurrentGeneration();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    ensureCurrentGeneration();
    const isArenaLaunch =
      launchPrefix.kind === "arena-source" || launchPrefix.kind === "arena-binary";
    const serverArgs = [
      ...launchPrefix.args,
      ...(isArenaLaunch ? ["--arena-credentials-stdin"] : []),
      "serve",
      "--port",
      String(port),
    ];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    ensureCurrentGeneration();
    const arenaCredentials = isArenaLaunch
      ? issueArenaLaunchCredentials(this.getArenaPreviewBaseUrl?.() ?? null)
      : null;
    if (isArenaLaunch && !arenaCredentials) {
      throw new Error(
        "Arena credentials are unavailable; sign in on a TCP daemon, or add an OpenRouter API key, before starting Arena",
      );
    }
    if (arenaCredentials && !isArenaCredentialsCurrent(arenaCredentials)) {
      throw new Error("Arena credentials changed while starting the server");
    }

    const arenaRuntimeToken =
      arenaCredentials?.credentials.mode === "hosted"
        ? arenaCredentials.credentials.token
        : undefined;

    const serverProcess = this.spawnServer({
      launchPrefix,
      serverArgs,
      serverCwd,
      isArenaLaunch,
      launchEnv,
      arenaCredentials,
    });
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
    });
    const server: OpenCodeServerGeneration = {
      process: serverProcess,
      port,
      url,
      controlToken: this.controlToken,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      managedProcessRecord,
      arenaRuntimeToken,
    };
    this.allServers.add(server);
    void managedProcessRecord.then((record) => {
      if (record && server.managedProcessRecord === managedProcessRecord) {
        server.managedProcessId = record.id;
      }
      return undefined;
    });

    let started = false;
    let settled = false;
    let stderrBuffer = "";
    let stdoutBuffer = "";
    const STARTUP_BUFFER_CAP = 8192;
    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= STARTUP_BUFFER_CAP) {
        return current;
      }
      const remaining = STARTUP_BUFFER_CAP - current.length;
      return current + chunk.slice(0, remaining);
    };
    const buildStartupErrorMessage = (headline: string): string => {
      const sections = [headline];
      const stderrTrimmed = stderrBuffer.trim();
      if (stderrTrimmed.length > 0) {
        sections.push(`stderr: ${stderrTrimmed}`);
      }
      const stdoutTrimmed = stdoutBuffer.trim();
      if (stdoutTrimmed.length > 0) {
        sections.push(`stdout: ${stdoutTrimmed}`);
      }
      return sections.join("\n");
    };

    const ready = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      timeout = setTimeout(() => {
        if (!started) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !settled) {
          started = true;
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.stdin?.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        if (server.arenaRuntimeToken) {
          revokeArenaRuntimeCredentials(server.arenaRuntimeToken);
          server.arenaRuntimeToken = undefined;
        }
        this.allServers.delete(server);
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });
    });

    server.ready = ready.catch(async (error) => {
      await this.killServer(server);
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      this.retiredServers.delete(server);
      throw error;
    });

    if (arenaCredentials) {
      if (!isArenaCredentialsCurrent(arenaCredentials)) {
        await this.killServer(server);
        await server.ready.catch(() => undefined);
        throw new Error("Arena credentials changed while starting the server");
      }
      if (!serverProcess.stdin) {
        await this.killServer(server);
        await server.ready.catch(() => undefined);
        throw new Error("Arena server stdin is unavailable");
      }
      serverProcess.stdin.end(
        arenaStdinPayload(arenaCredentials.credentials, hashControlToken(this.controlToken)),
      );
    }

    return server;
  }

  private spawnServer(input: {
    launchPrefix: Awaited<ReturnType<OpenCodeCommandPrefixResolver>>;
    serverArgs: string[];
    serverCwd: string;
    isArenaLaunch: boolean;
    launchEnv?: Record<string, string>;
    arenaCredentials: ArenaCredentialsSnapshot | null;
  }): ChildProcess {
    try {
      return this.spawnServerProcess(input.launchPrefix.command, input.serverArgs, {
        cwd: input.serverCwd,
        detached: process.platform !== "win32",
        stdio: [input.isArenaLaunch ? "pipe" : "ignore", "pipe", "pipe"],
        ...createProviderEnvSpec({
          baseEnv: this.baseEnv,
          runtimeSettings: this.runtimeSettings,
          overlays: [
            this.getArenaPreviewBaseUrl
              ? {
                  PASEO_ARENA_PREVIEW_BASE_URL: this.getArenaPreviewBaseUrl() ?? undefined,
                }
              : undefined,
            input.launchEnv,
            ...(input.isArenaLaunch
              ? [
                  {
                    OPENROUTER_API_KEY: undefined,
                    PASEO_ARENA_SESSION_TOKEN: undefined,
                    PASEO_OPENROUTER_BASE_URL: undefined,
                  },
                ]
              : []),
            {
              [OPENCODE_CONTROL_TOKEN_ENV]: input.isArenaLaunch ? undefined : this.controlToken,
            },
          ],
        }),
      });
    } catch (error) {
      if (input.arenaCredentials?.credentials.mode === "hosted") {
        revokeArenaRuntimeCredentials(input.arenaCredentials.credentials.token);
      }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.lifecycleGeneration += 1;
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
      ...Array.from(this.allServers).filter(
        (server) => server !== this.currentServer && !this.retiredServers.has(server),
      ),
    ];
    const shutdown = Promise.all(servers.map((server) => this.killServer(server))).then(() => {
      this.currentServer = null;
      this.retiredServers.clear();
      this.allServers.clear();
      return undefined;
    });
    let barrier: Promise<void>;
    barrier = shutdown.finally(() => {
      if (this.shutdownPromise === barrier) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = barrier;
    return barrier;
  }

  private async cleanupRetiredServers(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        this.retiredServers.delete(server);
        cleanup.push(this.killServer(server));
      }
    }
    await Promise.all(cleanup);
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.arenaRuntimeToken) {
      revokeArenaRuntimeCredentials(server.arenaRuntimeToken);
      server.arenaRuntimeToken = undefined;
    }
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      return;
    }
    const result = await this.terminateProcess(server.process, {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
    }
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
  }): Promise<{ id: string } | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) {
      return null;
    }

    try {
      return await this.managedProcesses.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pid, port: options.port },
        "Failed to record OpenCode helper process",
      );
      return null;
    }
  }

  private removeManagedProcessRecordWhenResolved(record: Promise<{ id: string } | null>): void {
    void record.then((resolved) => {
      if (resolved) {
        return this.removeManagedProcessId(resolved.id);
      }
      return undefined;
    });
  }

  private removeManagedServerRecord(server: OpenCodeServerGeneration): void {
    const record = server.managedProcessRecord;
    server.managedProcessRecord = undefined;
    if (server.managedProcessId) {
      void this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      return;
    }
    if (record) {
      this.removeManagedProcessRecordWhenResolved(record);
    }
  }

  private async removeManagedProcessId(id: string): Promise<void> {
    try {
      await this.managedProcesses?.remove(id);
    } catch (error) {
      this.logger.warn({ err: error, id }, "Failed to remove OpenCode helper process record");
    }
  }
}

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (!found) {
    throw new Error(
      "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
    );
  }

  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    // Global npm: <prefix>/opencode.cmd → <prefix>/node_modules/opencode-ai/bin/opencode.exe
    const globalCandidate = path.join(
      path.dirname(found),
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(globalCandidate)) return globalCandidate;

    // Local/pnpm: <project>/node_modules/.bin/opencode.cmd → <project>/node_modules/opencode-ai/bin/opencode.exe
    const localCandidate = path.join(
      path.dirname(found),
      "..",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (await pathExists(localCandidate)) return localCandidate;

    console.warn(
      "[opencode-server] Found opencode.cmd but could not resolve the real opencode.exe. " +
        "The process may not be properly terminated on exit. Path: %s",
      found,
    );
  }

  return found;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}
