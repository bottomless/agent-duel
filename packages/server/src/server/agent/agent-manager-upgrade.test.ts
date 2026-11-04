import { afterEach, expect, test, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import type { AgentClient } from "./agent-sdk-types.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { setArenaDatabaseUpgrade } from "./providers/opencode/arena-upgrade.js";

const owner = {};
afterEach(() => {
  setArenaDatabaseUpgrade(owner, null);
  vi.useRealTimers();
});

test.each(["opencode", "codex"])(
  "importable history wait extends only for OpenCode: %s",
  async (provider) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client: AgentClient = {
      provider,
      capabilities: {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsSessionListing: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      isAvailable: async () => true,
      fetchCatalog: async () => ({ models: [], modes: [] }),
      createSession: async () => {
        throw new Error("unused");
      },
      resumeSession: async () => {
        throw new Error("unused");
      },
      listImportableSessions: async () => new Promise(() => {}),
    };
    const manager = new AgentManager({
      clients: { [provider]: client },
      logger: createTestLogger(),
    });
    const pending = manager.listImportableSessions();
    let settled = false;
    void pending.then(() => {
      settled = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    setArenaDatabaseUpgrade(owner, { startedAt: 0, deadline: 600_000 });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(settled).toBe(provider !== "opencode");
    if (provider === "opencode") {
      setArenaDatabaseUpgrade(owner, null);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect((await pending).providerErrors[0]?.message).toContain(
      "Timed out listing importable sessions",
    );
  },
);
