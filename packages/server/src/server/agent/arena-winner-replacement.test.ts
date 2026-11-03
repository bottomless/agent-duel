import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { OpenCodeV2AgentClient } from "./providers/opencode/v2/agent.js";
import { V2Harness } from "./providers/opencode/test-utils/v2-harness.js";

function answer(id: string): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 1 },
    content: [{ type: "text", text: id }],
  };
}

function winner(index: number) {
  return ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "ready",
      canonicalSessionID: "session",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    runs: [],
    events: [],
    history: [
      {
        id: `turn-${index}`,
        index,
        state: "complete",
        appliedSide: "a",
        createdAt: "date",
        updatedAt: "date",
      },
    ],
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("V2 winner replacement releases callers and never publishes a superseded snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "arena-winner-replacement-"));
  const harness = new V2Harness();
  const logger = createTestLogger();
  const client = new OpenCodeV2AgentClient({ logger, runtime: harness.runtime });
  const manager = new AgentManager({
    clients: { opencode: client },
    logger,
    rescueTimeouts: { arenaWinnerHydrationMs: 20 },
  });
  const agent = await manager.createAgent({ provider: "opencode", cwd }, undefined, {
    workspaceId: undefined,
  });
  const read = deferred();
  const release = deferred();
  const list = harness.api.message.list;
  harness.history.push(answer("superseded"));
  harness.api.message.list = async (input, options) => {
    harness.api.message.list = list;
    const snapshot = structuredClone(await list(input, options));
    read.resolve();
    await release.promise;
    return snapshot;
  };
  const published: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (
        event.type === "agent_stream" &&
        event.event.type === "timeline" &&
        event.event.item.type === "assistant_message"
      ) {
        published.push(event.event.item.text);
      }
    },
    { agentId: agent.id, replayState: false },
  );
  try {
    vi.useFakeTimers();
    const first = manager.hydrateArenaWinner(agent.id, winner(1));
    await read.promise;
    await vi.advanceTimersByTimeAsync(21);
    await first;
    expect(published).toEqual([]);

    harness.history.splice(0, 1, answer("current"));
    const second = manager.hydrateArenaWinner(agent.id, winner(2));
    await vi.advanceTimersByTimeAsync(21);
    await second;
    // Native snapshot reads remain serialized, but neither caller waits indefinitely.
    expect(published).toEqual([]);
    vi.useRealTimers();
    release.resolve();
    await expect.poll(() => published).toEqual(["current"]);
    expect(manager.fetchTimeline(agent.id, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", messageId: "current", text: "current" },
    ]);
  } finally {
    vi.useRealTimers();
    release.resolve();
    unsubscribe();
    await manager.closeAgent(agent.id);
    await rm(cwd, { recursive: true, force: true });
  }
});
