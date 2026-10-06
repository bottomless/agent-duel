import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createArenaByokService } from "./byok.js";
import {
  clearArenaCredentials,
  issueArenaLaunchCredentials,
  isArenaCredentialsCurrent,
  readArenaCredentials,
} from "./credentials.js";

/** Loads its catalog the way the real opencode client does: only once Arena has credentials. */
function createArenaClient(): AgentClient {
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
    async fetchCatalog() {
      if (!readArenaCredentials()) throw new Error("Arena credentials are unavailable");
      return { models: [], modes: [{ id: "build", label: "Build" }] };
    },
    async isAvailable() {
      return true;
    },
  };
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

  it("reloads the opencode provider that failed to load before the key arrived", async () => {
    const providerSnapshots = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { opencode: createArenaClient() },
    });
    const byok = createArenaByokService({ restartArena: async () => {}, providerSnapshots });
    const read = { cwd: process.cwd(), provider: "opencode", wait: true } as const;
    try {
      expect(await providerSnapshots.getProvider(read)).toMatchObject({
        status: "error",
        error: "Arena credentials are unavailable",
      });

      await byok.setKey("sk-or-v1-first");

      expect(await providerSnapshots.getProvider(read)).toMatchObject({ status: "ready" });
    } finally {
      providerSnapshots.destroy();
    }
  });
});
