import {
  createFinishSubscriptions,
  createFinishObservation,
  createJsonFinishSubscriptionStore,
} from "./agent/finish-subscriptions/index.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type { PluginRegistries } from "@getpaseo/protocol/plugin-registry";
import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open, rm, stat } from "fs/promises";
import { randomUUID } from "node:crypto";
import { getHostName } from "./host-name.js";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

export function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { formatAttachmentContentDisposition } from "./file-download/content-disposition.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import {
  createPaseoToolCatalog,
  createPaseoAgentToolManifest,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import type { PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { OpenCodeServerManager } from "./agent/providers/opencode/server-manager.js";
import {
  recoverInterruptedForkWorkspaces,
  recoverUnrecordedForkWorktrees,
} from "./fork-workspace-recovery.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import { resolveConfigFromPersisted, type CliConfigOverrides } from "./config.js";
import { resolvePaseoToolPolicy } from "./agent/paseo-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archivePersistedWorkspaceRecord,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import {
  DEFAULT_ARENA_ENVIRONMENT_RETENTION,
  DEFAULT_WORKTREE_RETENTION,
  type AgentProfile,
  type AgentSkillSelection,
  type FirstAgentContext,
  type PluginSource,
  type TerminalProfile,
} from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { loadPersistedConfig, type PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { SESSION_HEADER } from "@getpaseo/protocol/accounts/schemas";
import { deleteLocalCredential, writeLocalCredential } from "./local-credential.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { resolveArenaAccessConfig, type ArenaAccessConfig } from "./accounts/config.js";
import { createArenaByokService } from "./accounts/byok.js";
import { createAccountsService, type AccountsService } from "./accounts/service.js";
import { createAccountsRouter } from "./accounts/routes.js";
import { createRequireSessionMiddleware } from "./accounts/middleware.js";
import { createArenaRuntimeRouter } from "./accounts/arena-runtime-router.js";
import { FeedbackBackend } from "./feedback/backend.js";
import { createFeedbackContextCapture, type FeedbackContextCapture } from "./feedback/context.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { createFeedbackRouter } from "./feedback/routes.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMetadataGenerator } from "./session/checkout/git-metadata-generator.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { CreateAgentCommandDependencies } from "./agent/create-agent/create.js";
import { PluginService } from "./plugins/index.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  arenaEnvironmentRetention?: number | null;
  worktreeRetention?: number | null;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  agentProfiles?: AgentProfile[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  pluginRegistries?: PluginRegistries;
  pluginRegistryUrl?: string;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayRequireProtectedSecurity?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    relayEnabledFallback: boolean;
    startupPersisted: PersistedConfig;
  };
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
  getServerId(): string;
}

export interface PaseoDaemonDependencies {
  builtinPlugins?: BuiltinPluginLoader;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
    relayConfig?: boolean;
  };
}

function resolveBuiltinPluginLoader(dependencies: PaseoDaemonDependencies): BuiltinPluginLoader {
  return dependencies.builtinPlugins ?? new BuiltinPluginLoader();
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(app: express.Application, config: PaseoDaemonConfig, logger: Logger): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostName(),
      logger,
    }),
  );
}

interface MountAccountsOptions {
  arenaAccess: ArenaAccessConfig;
  logger: Logger;
  feedbackContext: FeedbackContextCapture;
}

/**
 * Accounts sit behind the daemon password but in front of every other API, so a signed-out
 * client can reach sign-in and nothing else. The browser-facing sign-in callbacks bypass the
 * daemon password (see BEARER_AUTH_BYPASS_PATHS) because a redirect cannot carry an
 * Authorization header.
 */
function mountAccounts(
  app: express.Application,
  options: MountAccountsOptions,
): AccountsService | null {
  const { arenaAccess, logger } = options;
  if (arenaAccess.kind !== "accounts") {
    // The app asks before it renders anything, so the answer has to exist even
    // when there is nothing to sign in to.
    app.get("/api/auth/methods", (_req, res) => {
      res.json({ enabled: false, methods: [], legal: null });
    });
    if (arenaAccess.kind === "byok") {
      logger.info(
        "No control plane configured (PASEO_CONTROL_PLANE_URL); Arena runs on the user's OpenRouter key",
      );
    } else {
      logger.warn(
        "No control plane configured (PASEO_CONTROL_PLANE_URL); the daemon is unauthenticated",
      );
    }
    return null;
  }
  const accountsConfig = arenaAccess.accounts;
  const accounts = createAccountsService({
    config: accountsConfig,
    logger,
  });
  app.use("/api/auth", createAccountsRouter(accounts));
  app.use(createRequireSessionMiddleware(accounts));
  app.use(
    "/api/feedback",
    createFeedbackRouter({
      backend: new FeedbackBackend(accountsConfig.controlPlaneUrl, { logger }),
      sessions: accounts.sessions,
      context: options.feedbackContext,
    }),
  );
  logger.info(
    { controlPlaneUrl: accountsConfig.controlPlaneUrl },
    "Accounts enabled through the control plane",
  );
  return accounts;
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialRelayConfig(config: PaseoDaemonConfig): MutableDaemonConfig["relay"] {
  return {
    enabled: config.relayEnabled ?? true,
    requireProtectedSecurity: config.relayRequireProtectedSecurity ?? false,
  };
}

function createInitialRetentionConfig(
  config: PaseoDaemonConfig,
): Pick<MutableDaemonConfig, "arenaEnvironmentRetention" | "worktreeRetention"> {
  return {
    arenaEnvironmentRetention:
      config.arenaEnvironmentRetention === undefined
        ? DEFAULT_ARENA_ENVIRONMENT_RETENTION
        : config.arenaEnvironmentRetention,
    worktreeRetention:
      config.worktreeRetention === undefined
        ? DEFAULT_WORKTREE_RETENTION
        : config.worktreeRetention,
  };
}

function createInitialMutableDaemonConfig(config: PaseoDaemonConfig): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: createInitialRelayConfig(config),
    mcp: {
      enabled: config.mcpEnabled ?? true,
      injectIntoAgents: config.mcpInjectIntoAgents ?? true,
    },
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? "https://app.paseo.sh" },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: {
      providers: config.metadataGeneration?.providers ?? [],
    },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    ...createInitialRetentionConfig(config),
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  return initialConfig;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  const obsoleteTimelineDirectory = path.join(config.paseoHome, "agent-timelines");
  await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
    logger.warn(
      { err: error, path: obsoleteTimelineDirectory },
      "Failed to remove obsolete agent timeline data",
    );
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const initialMutableConfig = createInitialMutableDaemonConfig(config);
  const daemonConfigStore = new DaemonConfigStore(config.paseoHome, initialMutableConfig, logger, {
    relayEnabledMutable: config.relayEnabledMutable ?? true,
    startupPersisted: config.configReload?.startupPersisted,
    reloadSource: {
      resolve: (persisted) => {
        const reloaded = resolveConfigFromPersisted(config.paseoHome, persisted, {
          env: config.configReload?.env ?? process.env,
          cli: config.configReload?.cli,
          relayEnabledFallback: config.configReload?.relayEnabledFallback,
        });
        return {
          mutable: createInitialMutableDaemonConfig(reloaded),
          overrideControlledPaths: reloaded.configReload?.overrideControlledPaths ?? [],
        };
      },
    },
  });
  const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
  void orchestrationSkills.autoUpdate().catch((error) => {
    logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
  });
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});
  const pluginRuntime: PluginService = new PluginService(logger, daemonConfigStore, daemonVersion, {
    usageAgents: {
      hasAgent: (id) => agentManager.getAgent(id) !== null,
      usageSession: (id) => agentManager.usageSession(id),
    },
    managedSources: new ManagedPluginSources(config.paseoHome, {
      registries: config.pluginRegistries,
      defaultUrl: config.pluginRegistryUrl,
    }),
    builtinPlugins: resolveBuiltinPluginLoader(dependencies),
    settingsDirectory: path.join(config.paseoHome, "plugin-settings"),
  });

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayRuntime: RelayRuntime | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  daemonConfigStore.onFieldChange("trustedProxies", (value) => {
    app.set("trust proxy", value ?? ["loopback"]);
  });
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  let feedbackContextCapture: FeedbackContextCapture | null = null;
  const terminalManager = createConfiguredTerminalManager({
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const workspaceSetupRuntime = new WorkspaceSetupRuntime();
  let configuredHostnames = config.hostnames ?? config.allowedHosts;
  let appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";
  daemonConfigStore.onFieldChange("hostnames", (value) => {
    configuredHostnames = value as HostnamesConfig | undefined;
  });
  daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
    appBaseUrl = typeof value === "string" ? value : "https://app.paseo.sh";
  });
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const fixedAllowedOrigins = [
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ];
  const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
  daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
    allowedOrigins.clear();
    for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
      allowedOrigins.add(origin);
    }
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        `Content-Type, Authorization, ${SESSION_HEADER}`,
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Arena receives only this loopback capability. The account session stays in
  // daemon memory, and this router can reach only the Arena control-plane APIs.
  app.use(
    "/api/arena-runtime",
    createArenaRuntimeRouter({ logger: logger.child({ module: "arena-runtime-proxy" }) }),
  );

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Serve the bundled browser web UI when enabled. Mounted after service-proxy
  // classification and host/CORS handling, but before daemon bearer auth, so
  // static app files load without the daemon password while API/WebSocket calls
  // remain protected.
  mountWebUi(app, config, logger);

  let localCredential: string | null = null;
  const daemonAuth = { ...config.auth, localCredential: () => localCredential };
  app.use(
    createRequireBearerMiddleware(daemonAuth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  app.use(express.json());

  const arenaAccess = resolveArenaAccessConfig(process.env);
  const arenaByok =
    arenaAccess.kind === "byok"
      ? createArenaByokService({
          // Assigned further down; the key only arrives once a client connects.
          providerSnapshots: {
            reloadSnapshots: (options) => providerSnapshotManager.reloadSnapshots(options),
          },
        })
      : null;
  const accounts = mountAccounts(app, {
    arenaAccess,
    logger,
    feedbackContext: {
      capture: (feedback) => {
        if (!feedbackContextCapture) {
          throw new Error("Feedback context is not ready");
        }
        return feedbackContextCapture.capture(feedback);
      },
    },
  });

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostName(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (res.destroyed) {
        return;
      }
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", formatAttachmentContentDisposition(entry.fileName));
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      res.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const workspaceLabelService = createWorkspaceLabelService({
    paseoHome: config.paseoHome,
    workspaceRegistry,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  workspaceGitService.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "remove" && mutation.workspace) {
      const cwd = path.resolve(mutation.workspace.cwd);
      const workspaces = await workspaceRegistry.list();
      const hasActiveWorkspace = workspaces.some(
        (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === cwd,
      );
      if (!hasActiveWorkspace) workspaceRuntimeStore.remove(cwd);
    }
    if (mutation.kind === "archive" && mutation.workspace) {
      pluginRuntime.emit("workspace.archived", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async (target) => (await stat(target).catch(() => null))?.isDirectory() ?? false,
    logger,
  });
  const agentProviderRuntime = await createAgentProviderRuntime({
    paseoHome: config.paseoHome,
    logger,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      getArenaPreviewBaseUrl: () =>
        boundListenTarget?.type === "tcp" ? `http://localhost:${boundListenTarget.port}` : null,
      uploadsRoot: path.join(config.paseoHome, "uploads"),
      isDev: config.isDev === true,
      extraClients: config.agentClients,
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  daemonConfigStore.onFieldChange("catalogRefreshTimeoutMs", (value) => {
    providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
  });
  daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  daemonConfigStore.onFieldChange("git.maxProcessConcurrency", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const agentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    mcpAuthToken: agentMcpAuthToken,
    resolvePaseoToolPolicy: (provider) =>
      resolvePaseoToolPolicy(provider, daemonConfigStore.get().providers),
    logger,
  });
  feedbackContextCapture = createFeedbackContextCapture({
    agents: agentManager,
    storage: agentStorage,
    loadAgent: (agentId) => ensureAgentLoaded(agentId, { agentManager, agentStorage, logger }),
    git: workspaceGitService,
  });
  const syncPluginProviders = () => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  };
  const unsubscribePluginProviders =
    pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  await closeStaleAgentRecords(agentStorage);
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await bootstrapWorkspaceRegistries({
    serverId,
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  await workspaceLabelService.initialize();
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  await recoverInterruptedForkWorkspaces({ agentStorage, workspaceRegistry, logger });
  await recoverUnrecordedForkWorktrees({
    agentStorage,
    workspaceRegistry,
    workspaceProvisioning,
    paseoHome: config.paseoHome,
    logger,
  });
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
    workspaceRuntimeStore,
  });
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
  ) => {
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
    });
    if (!existingWorkspace || existingWorkspace.archivedAt) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      context,
    );
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext, context);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const chatTitles = createGitMetadataGenerator({
    workspaceGitService,
    writer: {
      write: (cwd, request, signal) => agentManager.writeGitMetadata(cwd, request, signal),
    },
    logger,
  });
  const workspaceAutoName = new WorkspaceAutoName({
    workspaceRegistry,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    suggestChatTitle: (cwd, prompt) => chatTitles.suggestChatTitle(cwd, prompt),
    logger,
  });

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createPaseoWorktreeForTools = async (
    input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
  ) => {
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        createPaseoWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredPaseoWorktree(workflowInput, {
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        startWorkspaceSetup: (workspaceId, operation) =>
          workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createPaseoWorktree: createPaseoWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  };
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const finishSubscriptions = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(config.paseoHome),
    serverId,
    logger,
    messages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    callerIsActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    ...createFinishObservation({
      agentManager,
      agentStorage,
      serverId,
      logger,
      messages: () => {
        if (!wsServer) throw new Error("Daemon is not accepting agent messages");
        return wsServer.agentMessages;
      },
      hosts: () => {
        if (!wsServer) throw new Error("Daemon is not accepting host operations");
        return wsServer.toolHosts();
      },
    }),
  });

  const createAgentToolHostDependencies = (
    runtime: PaseoToolRuntimeContext,
  ): PaseoToolHostDependencies => ({
    finishSubscriptions: () => finishSubscriptions,
    agentMessages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    serverId,
    hosts: () => {
      if (!wsServer) throw new Error("Daemon is not accepting host operations");
      return wsServer.toolHosts();
    },
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    providerSnapshotManager,
    daemonConfigStore,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    projectRegistry,
    createDirectoryWorkspace: async (cwd, title, projectId, context) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        context,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceRuntimeStore,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      publishStatusUpdate: (message) => wsServer?.publishScriptStatusUpdate(message),
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
      globalServicePorts: loadPersistedConfig(config.paseoHome).worktrees?.servicePorts,
    }),
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    paseoToolPolicy:
      runtime.paseoToolPolicy ??
      (runtime.callerAgentId ? agentManager.getPaseoToolPolicy(runtime.callerAgentId) : undefined),
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
    createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setPaseoToolCatalog(
      enabled ? createPaseoAgentToolManifest(createAgentToolHostDependencies({})) : null,
    );
  };
  agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
  agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  let mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({
          callerAgentId,
          paseoToolPolicy: callerAgentId
            ? agentManager.getPaseoToolPolicy(callerAgentId)
            : undefined,
        }),
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Agent MCP endpoint disabled" });
        return;
      }
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
            body: describeMcpDebugPayload(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      localCredential = await writeLocalCredential(config.paseoHome);
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
            agentMcpBaseUrl =
              !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            agentManager.setPaseoToolsEnabled(mcpEnabled && config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
              mcpEnabled = value !== false;
              const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
              agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && inject);
              setAgentProviderToolsEnabled(mcpEnabled && inject);
            });
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && value !== false);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                getAllowedOrigins: () => allowedOrigins,
                getHostnames: () => configuredHostnames,
                daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                startPaused: true,
                accounts,
                arenaByok,
              },
              workspaceAutoName,
              workspaceRuntimeStore,
              daemonAuth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                get appBaseUrl() {
                  return appBaseUrl;
                },
                desktopManaged: config.desktopManaged === true,
                getRelayConfig: () => ({
                  ...(relayRuntime?.getConfig() ?? {
                    enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                    endpoint: relayEndpoint,
                    publicEndpoint: relayPublicEndpoint,
                    useTls: relayUseTls,
                    publicUseTls: relayPublicUseTls,
                  }),
                  requireProtectedSecurity:
                    daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                }),
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              workspaceSetupRuntime,
              pluginRuntime,
              orchestrationSkills,
              workspaceLabelService,
            );
            pluginRuntime.bindPaseoSessionHost(wsServer);
            await pluginRuntime.start();
            providerSnapshotManager.settlePluginProviders();
            await finishSubscriptions.start();
            wsServer.beginAcceptingConnections();
            const relaySecurityLogger = logger.child({ module: "relay-security" });
            relayRuntime = createRelayRuntime({
              config: {
                enabled: relayEnabled,
                endpoint: relayEndpoint,
                publicEndpoint: relayPublicEndpoint,
                useTls: relayUseTls,
                publicUseTls: relayPublicUseTls,
              },
              logger,
              attachSocket: (ws, metadata) =>
                admitSecuredRelaySocket(
                  ws,
                  {
                    daemonKeyPair: daemonKeyPair.keyPair,
                    logger: relaySecurityLogger,
                    requireProtectedMode: () =>
                      daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                  },
                  async (secured) => {
                    if (!wsServer) throw new Error("WebSocket server is not ready");
                    await wsServer.attachExternalSocket(secured.socket, {
                      ...metadata,
                      transport: "relay",
                      securityMode: secured.securityMode,
                    });
                  },
                ),
              serverId,
            });
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              relayRuntime?.setEnabled(value === true);
            });
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      localCredential = null;
      await deleteLocalCredential(config.paseoHome);
      unsubscribePluginProviders();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async () => {
    localCredential = null;
    await deleteLocalCredential(config.paseoHome);
    // Stop tracking plugin provider registrations before anything tears plugins
    // down, so plugin shutdown cannot withdraw a provider from under an agent
    // that is still open. Plugins themselves are stopped once every session
    // they serve has been closed, further down.
    unsubscribePluginProviders();
    workspaceReconciliation.dispose();
    scriptHealthMonitor.stop();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    await finishSubscriptions.close();
    await wsServer?.agentMessages.close();
    agentManager.prepareForShutdown();
    await closeAllAgents(logger, agentManager);
    await withTimeout({
      promise: pluginRuntime.drainEvents(),
      timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
      label: "drain plugin lifecycle events",
    }).catch((error) => logger.warn({ err: error }, "Plugin lifecycle events did not finish"));
    await agentManager.flushForShutdown().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await agentProviderRuntime.shutdown();
    await OpenCodeServerManager.shutdownInstance();
    await pluginRuntime.stopAllPlugins();
    terminalManager.killAll();
    await speechService.stop();
    await relayRuntime?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    await accounts?.close().catch(() => undefined);
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
    getServerId: () => serverId,
  };
}

async function closeStaleAgentRecords(agentStorage: AgentStorage): Promise<void> {
  // No provider runtimes are loaded at startup. Repair interrupted
  // shutdowns before any status consumer sees the persisted active states.
  for (const record of await agentStorage.list()) {
    if (record.lastStatus === "running" || record.lastStatus === "initializing") {
      await agentStorage.upsert({ ...record, lastStatus: "closed" });
    }
  }
}

/**
 * Closing an agent asks its provider to close the session and waits for the
 * answer. A provider that never answers must not hold the daemon open, so a
 * close that outlives this deadline is abandoned; `agentProviderRuntime`
 * shutdown runs next and rejects the request that was still pending.
 */
const AGENT_CLOSE_TIMEOUT_MS = 5_000;

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents({ includeInternal: true });
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await withTimeout({
          promise: agentManager.closeAgent(agent.id),
          timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
          label: `close agent ${agent.id}`,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}
