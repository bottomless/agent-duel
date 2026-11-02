import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { OpenCodeV2AgentClient } from "./providers/opencode/v2/agent.js";
import { V2Harness } from "./providers/opencode/test-utils/v2-harness.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentTimelineStore } from "./agent-timeline-store-types.js";
import { wrapSessionProvider } from "./provider-registry.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000026";

class RecordingStorage extends AgentStorage {
  snapshots = 0;
  override async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ) {
    this.snapshots++;
    return super.applySnapshot(agent, options);
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "r26-transcript-"));
  const logger = createTestLogger();
  const storage = new RecordingStorage(join(directory, "agents"), logger);
  const harness = new V2Harness();
  harness.history.push({
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "arena", id: "medium" },
    time: { created: 2 },
    content: [{ type: "text", text: "saved answer" }],
  });
  const unavailable = async () => {
    throw new Error("No engine process in this test");
  };
  const client = new OpenCodeV2AgentClient({
    logger,
    runtime: harness.runtime,
    arenaMode: true,
    serverManager: {
      acquireCurrent: unavailable,
      acquireNew: unavailable,
      acquireDedicated: unavailable,
      acquireExisting: () => undefined,
      shutdown: async () => undefined,
    },
  });
  const timelineWrites: string[] = [];
  const write = (operation: string): never => {
    timelineWrites.push(operation);
    throw new Error(`Transcript wrote durable history: ${operation}`);
  };
  const durableTimelineStore: AgentTimelineStore = {
    appendCommitted: async () => write("append"),
    bulkInsert: async () => write("insert"),
    deleteAgent: async () => write("delete"),
    updateCommittedRow: async () => write("update"),
    getLatestCommittedSeq: async () => 200,
    getCommittedRows: async () => [],
    getLastItem: async () => null,
    getLastAssistantMessage: async () => null,
    fetchCommitted: async () => {
      throw new Error("Read the provider projection");
    },
  };
  const manager = new AgentManager({
    clients: {
      opencode: {
        provider: "opencode",
        capabilities: client.capabilities,
        isAvailable: () => client.isAvailable(),
        createSession: (config) => client.createSession(config),
        resumeSession: async (...args) =>
          wrapSessionProvider("opencode", await client.resumeSession(...args)),
      },
    },
    registry: storage,
    durableTimelineStore,
    logger,
  });
  onTestFinished(async () => {
    await manager.closeAgent(AGENT_ID);
    rmSync(directory, { recursive: true, force: true });
  });
  await storage.upsert({
    id: AGENT_ID,
    provider: "opencode",
    cwd: join(directory, "removed-worktree"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    archivedAt: "2026-01-02T00:00:00.000Z",
    persistence: { provider: "opencode", sessionId: "session", nativeHandle: "session" },
  });
  const agentDirectory = join(directory, "agents");
  const bytes = () =>
    readdirSync(agentDirectory, { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".json"))
      .map((file) => readFileSync(join(agentDirectory, file), "utf8"));
  const load = () =>
    ensureAgentLoaded(AGENT_ID, { agentManager: manager, agentStorage: storage, logger });
  return { manager, storage, harness, load, bytes, timelineWrites };
}

it("reads twice without writing lastStatus or any agent-record field (R26 issue 4)", async () => {
  const { manager, storage, load, bytes, timelineWrites } = await fixture();
  const before = bytes();
  expect(before).toHaveLength(1);
  for (let read = 0; read < 2; read++) {
    await load();
    expect(manager.fetchTimeline(AGENT_ID).rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "saved answer", messageId: "answer" },
    ]);
    await manager.hydrateTimelineFromProvider(AGENT_ID, { force: true });
    await manager.closeReadOnlyAgent(AGENT_ID);
  }
  await manager.flush();
  expect(storage.snapshots).toBe(0);
  expect(timelineWrites).toEqual([]);
  expect((await storage.get(AGENT_ID))?.lastStatus).toBe("closed");
  expect(bytes()).toEqual(before);
});

it("closes the read-only session and releases its engine lease (R26 issue 3)", async () => {
  const { manager, harness, load } = await fixture();
  await load();
  const releases = harness.releases;
  await manager.closeReadOnlyAgent(AGENT_ID);
  expect(manager.getAgent(AGENT_ID)).toBeNull();
  expect(harness.releases).toBe(releases + 1);
  await manager.closeReadOnlyAgent(AGENT_ID);
  expect(harness.releases).toBe(releases + 1);
  await load();
  expect(manager.fetchTimeline(AGENT_ID).rows).toHaveLength(1);
});

it("a delayed reader close leaves a replacement interactive session alone", async () => {
  const { manager, storage, harness, load } = await fixture();
  await load();
  await manager.closeAgent(AGENT_ID);
  const record = await storage.get(AGENT_ID);
  if (!record) throw new Error("Fixture record missing");
  mkdirSync(record.cwd);
  await storage.upsert({ ...record, archivedAt: null });
  await load();
  const session = manager.getAgent(AGENT_ID)?.session;
  expect(session?.readOnly).toBe(false);
  const releases = harness.releases;
  await manager.closeReadOnlyAgent(AGENT_ID);
  expect(manager.getAgent(AGENT_ID)?.session).toBe(session);
  expect(harness.releases).toBe(releases);
  expect(storage.snapshots).toBe(2);
});
