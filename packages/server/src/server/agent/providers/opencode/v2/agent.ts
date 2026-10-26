import { OpenCodeV2Session } from "./session.js";
import { V2_CAPABILITIES } from "./capabilities.js";
import {
  features,
  permissionRules,
  applyResumeOverrides,
  requiresDedicatedV2Server,
  arenaModelRef,
} from "./configuration.js";
import { commands } from "./commands.js";

import { waitForLocationReady, awaitPaseoPlugin } from "./readiness.js";

import type { SessionInfo, ModelRef } from "@opencode/client";

import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentForkSessionInput,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  ArenaActivitySource,
  ArenaCheckoutCleanupSource,
  GitMetadataRequest,
  GitMetadataResult,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
  ListImportableSessionsOptions,
  ProviderRefreshContext,
} from "../../../agent-sdk-types.js";
import {
  createProviderEnv,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";

import { importSessionFromPersistence } from "../../../provider-session-import.js";

import type { OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, managedV2ProcessEvents, type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2, modelsFromV2 } from "./mapping.js";
import { ArenaEnvironmentTrimSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import { ArenaSessionActivitySchema } from "@getpaseo/protocol/arena/activity";
import { z } from "zod";
import { OpenCodeServerManager, type OpenCodeServerManagerLike } from "../server-manager.js";

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: Pick<V2Runtime, "acquire" | "shutdown">;
  arenaMode?: boolean;
  serverManager?: OpenCodeServerManagerLike;
  getArenaPreviewBaseUrl?: () => string | null;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities: AgentCapabilityFlags;
  private readonly runtime: Pick<V2Runtime, "acquire" | "shutdown">;
  private readonly connections = new Map<string, V2Connection>();
  private readonly arenaMode: boolean;
  private readonly serverManager?: OpenCodeServerManagerLike;
  constructor(private readonly options: V2AgentOptions) {
    this.arenaMode = options.arenaMode ?? false;
    this.serverManager =
      options.serverManager ??
      (this.arenaMode
        ? OpenCodeServerManager.getInstance(options.logger, options.settings, {
            managedProcesses: options.managedProcesses,
            getArenaPreviewBaseUrl: options.getArenaPreviewBaseUrl,
            createEventSource: managedV2ProcessEvents,
          })
        : undefined);
    this.capabilities = { ...V2_CAPABILITIES, supportsNativePaseoTools: Boolean(options.bridge) };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
        serverManager: this.serverManager,
        decorateEnv: options.bridge ? (env) => options.bridge!.decorateV2ServerEnv(env) : undefined,
      });
  }
  private requireArenaManager(): OpenCodeServerManagerLike {
    if (!this.arenaMode || !this.serverManager)
      throw new Error("OpenCode Arena runtime is unavailable");
    return this.serverManager;
  }
  private async arenaRequest(
    path: string,
    directory: string,
    options: { method?: "POST"; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const acquisition = await this.requireArenaManager().acquireCurrent(options.signal);
    try {
      const response = await fetch(new URL(path, `${acquisition.server.url.replace(/\/$/, "")}/`), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-opencode-directory": directory,
          "x-paseo-control-token": acquisition.server.controlToken,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal,
      });
      const body = await response.text();
      return new Response(body || null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      await acquisition.release();
    }
  }
  async openArenaActivitySource(cwd: string): Promise<ArenaActivitySource | null> {
    if (!this.arenaMode) return null;
    return {
      read: async (sessionIDs) => {
        const response = await this.arenaRequest("/arena/activity", cwd, {
          method: "POST",
          body: { sessionIDs },
        });
        if (!response.ok) throw new Error(`Arena activity request failed: ${response.status}`);
        return ArenaSessionActivitySchema.array().parse(await response.json());
      },
      close: async () => undefined,
    };
  }
  async openArenaCheckoutCleanupSource(
    sourceRepoRoot: string,
  ): Promise<ArenaCheckoutCleanupSource | null> {
    if (!this.arenaMode) return null;
    const request = async (operation: "inspect" | "prepare" | "release", root: string) => {
      const response = await this.arenaRequest(`/arena/checkout/${operation}`, sourceRepoRoot, {
        method: "POST",
        body: { root },
      });
      if (!response.ok) throw new Error(`Arena checkout ${operation} failed: ${response.status}`);
      if (operation !== "inspect") return undefined;
      const value: unknown = await response.json();
      return z
        .object({
          eligible: z.boolean(),
          lastActivityAt: z.string().nullable(),
          reason: z.string().optional(),
        })
        .parse(value);
    };
    return {
      inspect: async (root) => {
        const result = await request("inspect", root);
        if (!result) throw new Error("Arena checkout inspect returned no data");
        return result;
      },
      prepare: async (root) => void (await request("prepare", root)),
      release: async (root) => void (await request("release", root)),
      trimEnvironments: async (keep, volumeOf) => {
        const response = await this.arenaRequest("/arena/environments/trim", sourceRepoRoot, {
          method: "POST",
          body: { keep, volumeOf },
        });
        if (!response.ok) throw new Error(`Arena environment trim failed: ${response.status}`);
        return ArenaEnvironmentTrimSchema.parse(await response.json());
      },
      close: async () => undefined,
    };
  }
  async seedWorktreeIgnoredContent(input: { sourceCwd: string; worktreePath: string }) {
    if (!this.arenaMode) return;
    const response = await this.arenaRequest("/arena/worktrees/seed", input.sourceCwd, {
      method: "POST",
      body: { source: input.sourceCwd, target: input.worktreePath },
    });
    if (!response.ok) throw new Error(`Arena worktree seed failed: ${response.status}`);
  }
  async writeGitMetadata(
    cwd: string,
    request: GitMetadataRequest,
    signal: AbortSignal,
  ): Promise<GitMetadataResult | null> {
    if (!this.arenaMode) return null;
    const response = await this.arenaRequest("/arena/metadata", cwd, {
      method: "POST",
      body: request,
      signal,
    });
    if (!response.ok) throw new Error(`Arena metadata failed: ${response.status}`);
    return z
      .union([
        z.object({ message: z.string().min(1) }),
        z.object({ title: z.string().min(1), body: z.string() }),
        z.object({ branch: z.string().min(1) }),
        z.object({ title: z.string().min(1) }),
      ])
      .parse(await response.json());
  }
  async refreshProjectDirectory(cwd: string): Promise<void> {
    if (!this.arenaMode) return;
    const response = await this.arenaRequest("/api/location/reload", cwd, { method: "POST" });
    if (!response.ok) throw new Error(`OpenCode location reload failed: ${response.status}`);
  }
  async unarchiveArenaChat(handle: AgentPersistenceHandle): Promise<void> {
    if (!this.arenaMode) return;
    const cwd = handle.metadata?.cwd;
    if (typeof cwd !== "string" || !cwd)
      throw new Error("Arena chat unarchive requires the original working directory");
    const response = await this.arenaRequest(
      `/arena/sessions/${encodeURIComponent(handle.sessionId)}/unarchive`,
      cwd,
      { method: "POST" },
    );
    if (!response.ok) throw new Error(`Failed to unarchive Arena chat (${response.status})`);
  }
  async forkSession(input: AgentForkSessionInput): Promise<AgentSession> {
    if (!this.arenaMode) throw new Error("OpenCode fork requires the Arena runtime");
    if (input.source.provider !== "opencode")
      throw new Error(`OpenCode cannot fork a ${input.source.provider} session`);
    const connection = await this.runtime.acquire();
    const arena = connection.arena;
    if (!arena) {
      await connection.release();
      throw new Error("OpenCode Arena runtime is unavailable");
    }
    let forkedId: string | undefined;
    try {
      const response = await fetch(
        new URL(
          `/arena/sessions/${encodeURIComponent(input.source.sessionId)}/fork`,
          `${arena.serverUrl}/`,
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-opencode-directory": input.sourceCwd,
            "x-paseo-control-token": arena.controlToken,
          },
          body: JSON.stringify({
            destination: input.config.cwd,
            ...(input.throughMessageId ? { messageID: input.throughMessageId } : {}),
          }),
        },
      );
      const body = await response.text();
      if (!response.ok)
        throw new Error(`Failed to fork Arena session (${response.status}): ${body}`);
      const result = z.object({ sessionID: z.string().min(1) }).parse(JSON.parse(body));
      forkedId = result.sessionID;
      const info = await connection.client.session.get({ sessionID: forkedId });
      return await this.attach(
        connection,
        info,
        input.config,
        input.launchContext,
        input.options?.persistSession !== false,
      );
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  async isAvailable() {
    return true;
  }
  async shutdown() {
    await this.runtime.shutdown();
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    const connection = await this.runtime.acquire({
      fresh: options.force,
      signal: context?.signal,
    });
    const location = {
      directory: options.scope === "workspace" ? options.cwd : resolveOpenCodeHomeDir(),
    };
    const request = { signal: context?.signal };
    const activity = <T>(name: string, operation: () => Promise<T>) =>
      context ? context.runActivity(name, operation) : operation();
    try {
      await activity("plugin.list", () =>
        waitForLocationReady({ client: connection.client, location, signal: request.signal }),
      );
      const [models, agents, providers] = await Promise.all([
        activity("model.list", () => connection.client.model.list({ location }, request)),
        activity("agent.list", () => connection.client.agent.list({ location }, request)),
        activity("provider.list", () => connection.client.provider.list({ location }, request)),
      ]);
      if (!providers.data.length && this.arenaMode)
        return {
          models: ["medium", "contestant"].map((id) => {
            const ref = arenaModelRef(`arena/${id}`);
            return {
              provider: "opencode" as const,
              id: `arena/${id}`,
              label: id === "medium" ? "Medium" : "frontier",
              thinkingOptions: [{ id: ref.variant!, label: ref.variant!, isDefault: true }],
              defaultThinkingOptionId: ref.variant,
              metadata: {
                providerId: "arena",
                modelId: id,
                supportsReasoning: true,
                supportsToolCall: true,
              },
            };
          }),
          modes: modesFromV2(agents.data),
        };
      if (!providers.data.length)
        throw new Error(
          "OpenCode has no connected providers. Authenticate using opencode auth login.",
        );
      return { models: modelsFromV2(models.data), modes: modesFromV2(agents.data) };
    } finally {
      await connection.release();
    }
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const connection = await this.runtime.acquire(
      requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
    );
    try {
      let model: ModelRef | undefined;
      if (this.arenaMode) model = arenaModelRef(config.model);
      else if (config.model) model = modelRef(config.model, config.thinkingOptionId);
      const info = await connection.client.session.create({
        location: { directory: config.cwd },
        title: config.title,
        agent: config.modeId ?? "build",
        model,
        permissions: permissionRules(config),
      });
      return await this.attach(connection, info, config, launch, options?.persistSession !== false);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? handle.metadata?.cwd;
    if (typeof cwd !== "string")
      throw new Error("OpenCode resume requires the original working directory");
    const config: AgentSessionConfig = {
      ...handle.metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    const connection =
      this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain() ??
      (await this.runtime.acquire(
        requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
      ));
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      await applyResumeOverrides(connection.client, info, overrides, this.arenaMode);
      return await this.attach(connection, info, config, launch, true);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    persist: boolean,
  ) {
    const acquire = () =>
      this.runtime.acquire(
        requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
      );
    let ownedConnection = connection;
    const unbind = this.options.bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.paseoTools,
    });
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, ownedConnection);
      if (bound.has(childId)) return;
      const childUnbind = this.options.bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.paseoTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.delete(id);
    };
    const moved = (next: V2Connection) => {
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.set(id, next);
      ownedConnection = next;
    };
    const session = new OpenCodeV2Session(
      connection,
      info,
      config,
      this.options.logger,
      persist,
      Boolean(this.options.bridge),
      this.arenaMode,
      releaseBindings,
      bindChild,
      acquire,
      moved,
    );
    try {
      if (this.options.bridge) {
        const location = { directory: config.cwd };
        await awaitPaseoPlugin({ client: connection.client, location });
      }
      await session.initialize(
        launch?.env
          ? createProviderEnv({ runtimeSettings: this.options.settings, overlays: [launch.env] })
          : undefined,
      );
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return features(config);
  }
  async listCommands(config: AgentSessionConfig) {
    const connection = await this.runtime.acquire();
    try {
      return await commands(connection.client, config.cwd);
    } finally {
      await connection.release();
    }
  }
  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const connection = await this.runtime.acquire();
    try {
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      const scanLimit = Math.min(options.scanLimit ?? 100, 500);
      do {
        const page = await connection.client.session.list({
          ...(cursor ? { cursor } : { directory: options.cwd, search: options.query }),
          limit: Math.min(50, scanLimit - sessions.length),
        });
        sessions.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor && sessions.length < scanLimit);
      return sessions
        .filter((info) => !info.parentID && !info.time.archived)
        .slice(0, options.limit ?? 50)
        .map((info) => ({
          providerHandleId: info.id,
          cwd: info.location.directory,
          title: info.title ?? null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(info.time.updated),
        }));
    } finally {
      await connection.release();
    }
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const connection = await this.runtime.acquire();
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: this.resumeSession.bind(this),
        config: {
          title: info.title,
          modeId: info.agent,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        },
      });
    } finally {
      await connection.release();
    }
  }
}
