import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  FetchCatalogOptions,
  ProviderSnapshotEntry,
} from "../agent/agent-sdk-types.js";
import { ProviderSnapshotManager, resolveSnapshotCwd } from "../agent/provider-snapshot-manager.js";
import { createArenaByokService } from "./byok.js";
import {
  clearArenaCredentials,
  installArenaCredentials,
  issueArenaLaunchCredentials,
  isArenaCredentialsCurrent,
  readArenaCredentials,
} from "./credentials.js";

/** Loads its catalog the way the real opencode client does: only once Arena has credentials. */
function createArenaClient(catalogLoads: FetchCatalogOptions[] = []): AgentClient {
  return {
    provider: "opencode",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async fetchCatalog(options) {
      catalogLoads.push(options);
      if (!readArenaCredentials()) throw new Error("Arena credentials are unavailable");
      return { models: [], modes: [{ id: "build", label: "Build" }] };
    },
    async isAvailable() {
      return true;
    },
  };
}

function openCodeStatus(entries: ProviderSnapshotEntry[]): string {
  return entries.find((entry) => entry.provider === "opencode")?.status ?? "missing";
}

/**
 * Follows a project's opencode status through pushed changes, as the app does. A read would
 * reload the provider and hide a project left loading.
 */
function recordOpenCodeStatus(providerSnapshots: ProviderSnapshotManager, cwd: string): string[] {
  const pushed: string[] = [];
  providerSnapshots.on("change", (entries, snapshotCwd) => {
    if (snapshotCwd === resolveSnapshotCwd(cwd)) pushed.push(openCodeStatus(entries));
  });
  return pushed;
}

let restarts = 0;

function createService() {
  return createArenaByokService({
    restartArena: async () => {
      restarts += 1;
    },
  });
}

beforeEach(() => {
  restarts = 0;
  clearArenaCredentials();
});

afterEach(() => {
  clearArenaCredentials();
});

describe("Arena BYOK key", () => {
  it("holds the key in memory and restarts Arena to hand it over", async () => {
    const byok = createService();
    expect(byok.isConfigured()).toBe(false);

    await byok.setKey("sk-or-v1-first");

    expect(byok.isConfigured()).toBe(true);
    expect(restarts).toBe(1);
    expect(readArenaCredentials()?.credentials).toEqual({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-first",
    });
  });

  it("restarts Arena when the key changes or is cleared", async () => {
    const byok = createService();
    await byok.setKey("sk-or-v1-first");
    const launch = issueArenaLaunchCredentials(null)!;

    await byok.setKey("sk-or-v1-second");

    expect(restarts).toBe(2);
    expect(isArenaCredentialsCurrent(launch)).toBe(false);
    expect(readArenaCredentials()?.credentials).toEqual({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-second",
    });

    await byok.setKey(null);

    expect(restarts).toBe(3);
    expect(byok.isConfigured()).toBe(false);
    expect(readArenaCredentials()).toBeNull();
  });

  it("keeps Arena running when a client hands over the key it already holds", async () => {
    const byok = createService();
    await byok.setKey("sk-or-v1-first");
    const launch = issueArenaLaunchCredentials(null)!;

    await byok.setKey("sk-or-v1-first");
    await byok.setKey(null);
    await byok.setKey(null);

    expect(restarts).toBe(2);
    expect(isArenaCredentialsCurrent(launch)).toBe(false);
  });

  it("applies concurrent changes in order", async () => {
    const byok = createService();

    await Promise.all([byok.setKey("sk-or-v1-first"), byok.setKey("sk-or-v1-second")]);

    expect(restarts).toBe(2);
    expect(readArenaCredentials()?.credentials).toEqual({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-second",
    });
  });

  it("reloads the opencode provider of a project opened before the key arrived", async () => {
    const catalogLoads: FetchCatalogOptions[] = [];
    const providerSnapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { opencode: createArenaClient(catalogLoads) },
    });
    const byok = createArenaByokService({ restartArena: async () => {}, providerSnapshots });
    const cwd = process.cwd();
    try {
      expect(
        await providerSnapshots.getProvider({ cwd, provider: "opencode", wait: true }),
      ).toMatchObject({ status: "error", error: "Arena credentials are unavailable" });

      const pushed = recordOpenCodeStatus(providerSnapshots, cwd);

      await byok.setKey("sk-or-v1-first");

      await vi.waitFor(() => expect(pushed.at(-1)).toBe("ready"));
      // A forced opencode load starts a new Arena server; only the global reload may force one.
      expect(catalogLoads.filter((load) => load.force).map((load) => load.scope)).toEqual([
        "global",
      ]);
    } finally {
      providerSnapshots.destroy();
    }
  });

  it("reloads a project that was still loading when the key arrived", async () => {
    // A restarted daemon has no key until the app connects and hands it over again, and the app
    // can read a project first. That load finishes after the key is in and must not be kept.
    const client = createArenaClient();
    const loadCatalog = client.fetchCatalog.bind(client);
    let catalogLoads = 0;
    let failLoadWithoutKey: (error: Error) => void = () => {};
    client.fetchCatalog = (options) => {
      catalogLoads += 1;
      if (catalogLoads > 1) return loadCatalog(options);
      return new Promise((_resolve, reject) => {
        failLoadWithoutKey = reject;
      });
    };
    const providerSnapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { opencode: client },
    });
    const byok = createArenaByokService({ restartArena: async () => {}, providerSnapshots });
    const cwd = process.cwd();
    const pushed = recordOpenCodeStatus(providerSnapshots, cwd);
    try {
      providerSnapshots.getSnapshot(cwd);
      await vi.waitFor(() => expect(catalogLoads).toBe(1));

      await byok.setKey("sk-or-v1-first");
      failLoadWithoutKey(new Error("Arena credentials are unavailable"));

      await vi.waitFor(() => expect(pushed.at(-1)).toBe("ready"));
      expect(pushed).not.toContain("error");
    } finally {
      providerSnapshots.destroy();
    }
  });

  it("reloads open projects when the key is replaced", async () => {
    installArenaCredentials({ mode: "byok", openRouterApiKey: "sk-or-v1-first" });
    const providerSnapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { opencode: createArenaClient() },
    });
    const byok = createArenaByokService({ restartArena: async () => {}, providerSnapshots });
    const cwd = process.cwd();
    try {
      expect(
        await providerSnapshots.getProvider({ cwd, provider: "opencode", wait: true }),
      ).toMatchObject({ status: "ready" });
      const pushed = recordOpenCodeStatus(providerSnapshots, cwd);

      await byok.setKey("sk-or-v1-second");

      await vi.waitFor(() => expect(pushed.at(-1)).toBe("ready"));
      expect(pushed).toContain("loading");
    } finally {
      providerSnapshots.destroy();
    }
  });

  it("fails open projects rather than leaving them loading when the key is removed", async () => {
    installArenaCredentials({ mode: "byok", openRouterApiKey: "sk-or-v1-first" });
    const providerSnapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { opencode: createArenaClient() },
    });
    const byok = createArenaByokService({ restartArena: async () => {}, providerSnapshots });
    const cwd = process.cwd();
    try {
      expect(
        await providerSnapshots.getProvider({ cwd, provider: "opencode", wait: true }),
      ).toMatchObject({ status: "ready" });
      const pushed = recordOpenCodeStatus(providerSnapshots, cwd);

      await byok.setKey(null);

      // A failed provider lets the draft send, and the send then asks for a key.
      await vi.waitFor(() => expect(pushed.at(-1)).toBe("error"));
    } finally {
      providerSnapshots.destroy();
    }
  });
});
