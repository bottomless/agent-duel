import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import { expect, onTestFinished, test } from "vitest";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { AgentManager } from "../../../agent-manager.js";
import { wrapSessionProvider } from "../../../provider-registry.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";

function turn(id: string, text: string, created: number): SessionMessageInfo[] {
  return [
    { id: `${id}-prompt`, type: "user", text: `Say ${text}`, time: { created } },
    {
      id: `${id}-answer`,
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { created: created + 1 },
      content: [{ type: "text", text }],
    },
  ];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(history: SessionMessageInfo[]) {
  const cwd = await mkdtemp(join(tmpdir(), "arena-history-replacement-"));
  const harness = new V2Harness();
  const logger = createTestLogger();
  const consumed: string[] = [];
  const subscribe = harness.api.event.subscribe;
  harness.api.event.subscribe = async function* (options) {
    for await (const event of subscribe(options)) {
      yield event;
      consumed.push(event.id);
    }
  };
  harness.history.push(...history);
  const client = new OpenCodeV2AgentClient({ logger, runtime: harness.runtime });
  const createSession = client.createSession.bind(client);
  client.createSession = async (...args) =>
    wrapSessionProvider("opencode", await createSession(...args));
  const manager = new AgentManager({ clients: { opencode: client }, logger });
  const agent = await manager.createAgent({ provider: "opencode", cwd }, undefined, {
    workspaceId: undefined,
  });
  onTestFinished(async () => {
    await manager.closeAgent(agent.id);
    await rm(cwd, { recursive: true, force: true });
  });
  async function reconcile(id: string) {
    harness.push({ id, created: 10_000, type: "server.connected", data: {} });
    await expect.poll(() => consumed).toContain(id);
  }
  return { harness, manager, agent, reconcile, consumed };
}

test.each(["before", "after"])(
  "a migrated waiting battle's winner is not replayed when native reconciliation runs %s hydration",
  async (order) => {
    const winner = turn("legacy", "MIGRATE_WAIT", 1_000);
    const { harness, manager, agent, reconcile } = await fixture([winner[0]]);
    // Arena grafts canonical rows without sending a normal provider turn completion.
    harness.history.push(winner[1]);
    if (order === "before") await reconcile("before-vote");
    await manager.hydrateArenaWinner(
      agent.id,
      ArenaSnapshotSchema.parse({
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
            id: "turn",
            index: 0,
            state: "complete",
            appliedSide: "a",
            createdAt: "date",
            updatedAt: "date",
          },
        ],
      }),
    );
    const before = manager.fetchTimeline(agent.id, { limit: 0 });
    await reconcile("after-vote");
    expect(manager.fetchTimeline(agent.id, { limit: 0 })).toEqual(before);
    expect(before.rows.map((row) => row.item)).toEqual([
      { type: "user_message", messageId: "legacy-prompt", text: "Say MIGRATE_WAIT" },
      { type: "assistant_message", messageId: "legacy-answer", text: "MIGRATE_WAIT" },
    ]);
  },
);

test.each(["before", "after", "overlapping"])(
  "rewind keeps each grafted reply once with %s native reconciliation and preserves the next response",
  async (order) => {
    const first = turn("first", "ALPHA", 1_000);
    const answer = first[1];
    if (answer.type !== "assistant") throw new Error("Expected an assistant fixture");
    answer.content.unshift(
      {
        type: "reasoning",
        text: "Think",
        state: { reasoningField: "reasoning_content" },
        time: { created: 1_001, completed: 1_001 },
      },
      {
        type: "tool",
        id: "read-marker",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "cat marker.txt" },
          content: [{ type: "text", text: "marker" }],
        },
        time: { created: 1_001, ran: 1_001, completed: 1_001 },
      },
    );
    const second = turn("second", "BRAVO", 2_000);
    const third = turn("third", "CHARLIE", 3_000);
    const { harness, manager, agent, reconcile } = await fixture([first[0]]);
    harness.history.push(first[1], ...second, ...third);
    const read = deferred();
    const release = deferred();
    let pending: Promise<void> = Promise.resolve();
    if (order === "before") await reconcile("before-rewind");
    if (order === "overlapping") {
      const list = harness.api.message.list;
      harness.api.message.list = async (input, options) => {
        harness.api.message.list = list;
        const snapshot = await list(input, options);
        read.resolve();
        await release.promise;
        return snapshot;
      };
      pending = reconcile("overlapping-rewind");
      await read.promise;
    }
    const committed = deferred();
    harness.api.session.revert.stage = async (input) => {
      expect(input).toEqual({ sessionID: "session", messageID: "third-prompt", files: true });
    };
    harness.api.session.revert.commit = async () => {
      harness.history.splice(4);
      committed.resolve();
    };
    const rewinding = manager.rewind(agent.id, "third-prompt", "both");
    await committed.promise;
    release.resolve();
    await pending;
    await rewinding;
    const before = manager.fetchTimeline(agent.id, { limit: 0 });
    await reconcile("after-rewind");
    expect(manager.fetchTimeline(agent.id, { limit: 0 })).toEqual(before);
    expect(before.rows.map((row) => row.item)).toMatchObject([
      { type: "user_message", messageId: "first-prompt", text: "Say ALPHA" },
      { type: "reasoning", text: "Think" },
      {
        type: "tool_call",
        callId: "read-marker",
        status: "completed",
        detail: { output: "marker" },
      },
      { type: "assistant_message", messageId: "first-answer", text: "ALPHA" },
      { type: "user_message", messageId: "second-prompt", text: "Say BRAVO" },
      { type: "assistant_message", messageId: "second-answer", text: "BRAVO" },
    ]);
    expect(before.rows.map((row) => row.timestamp)).toEqual(
      [1_000, 1_001, 1_001, 1_001, 2_000, 2_001].map((time) => new Date(time).toISOString()),
    );

    harness.prompt = async (input) => {
      harness.history.push(
        {
          id: "next-prompt",
          type: "user",
          text: input.text,
          metadata: input.metadata,
          time: { created: 4_000 },
        },
        ...turn("next", "ALPHA", 4_000).slice(1),
      );
      harness.push({
        id: "next-start",
        created: 4_001,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "next-answer", ordinal: 0 },
      });
      harness.push({
        id: "next-delta",
        created: 4_002,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "next-answer",
          ordinal: 0,
          delta: "ALPHA",
        },
      });
    };
    await manager.runAgent(agent.id, "Say ALPHA again");
    await reconcile("after-next-send");
    expect(
      manager
        .fetchTimeline(agent.id, { limit: 0 })
        .rows.flatMap((row) => (row.item.type === "assistant_message" ? [row.item.text] : [])),
    ).toEqual(["ALPHA", "BRAVO", "ALPHA"]);
  },
);

test.each(["reading", "installing"])(
  "replacement recovers output received while %s its snapshot",
  async (phase) => {
    const winner = turn("winner", "ALPHA", 1_000);
    const { harness, manager, agent, reconcile, consumed } = await fixture([winner[0]]);
    harness.history.push(winner[1]);
    const read = deferred();
    const release = deferred();
    if (phase === "reading") {
      const list = harness.api.message.list;
      harness.api.message.list = async (input, options) => {
        harness.api.message.list = list;
        const snapshot = structuredClone(await list(input, options));
        read.resolve();
        await release.promise;
        return snapshot;
      };
    } else {
      const remove = manager.deleteCommittedTimeline.bind(manager);
      manager.deleteCommittedTimeline = async (id) => {
        read.resolve();
        await release.promise;
        await remove(id);
      };
    }
    const replacing = manager.hydrateTimelineFromProvider(agent.id, { force: true });
    await read.promise;
    const answer = harness.history[1];
    if (answer.type !== "assistant") throw new Error("Expected an assistant fixture");
    answer.content = [{ type: "text", text: "ALPHA continued" }];
    harness.push({
      id: "started-during-read",
      created: 1_001,
      type: "session.text.started",
      data: { sessionID: "session", assistantMessageID: "winner-answer", ordinal: 0 },
    });
    harness.push({
      id: "delta-during-read",
      created: 1_002,
      type: "session.text.delta",
      data: {
        sessionID: "session",
        assistantMessageID: "winner-answer",
        ordinal: 0,
        delta: "ALPHA continued",
      },
    });
    try {
      await expect.poll(() => consumed).toContain("delta-during-read");
    } finally {
      release.resolve();
    }
    await replacing;
    await reconcile("after-overlapping-output");
    await expect
      .poll(() => manager.fetchTimeline(agent.id, { limit: 0 }).rows.map((row) => row.item))
      .toEqual([
        { type: "user_message", messageId: "winner-prompt", text: "Say ALPHA" },
        { type: "assistant_message", messageId: "winner-answer", text: "ALPHA continued" },
      ]);
  },
);

test("a failed snapshot read leaves history intact and permits replacement retry", async () => {
  const first = turn("first", "ALPHA", 1_000);
  const { harness, manager, agent, reconcile } = await fixture(first);
  const before = manager.fetchTimeline(agent.id, { limit: 0 });
  const list = harness.api.message.list;
  harness.api.message.list = async () => {
    throw new Error("history unavailable");
  };
  await expect(manager.hydrateTimelineFromProvider(agent.id, { force: true })).rejects.toThrow(
    "history unavailable",
  );
  expect(manager.fetchTimeline(agent.id, { limit: 0 })).toEqual(before);
  harness.api.message.list = list;
  harness.history.push(...turn("second", "BRAVO", 2_000));
  await manager.hydrateTimelineFromProvider(agent.id, { force: true });
  const replaced = manager.fetchTimeline(agent.id, { limit: 0 });
  await reconcile("after-retry");
  expect(manager.fetchTimeline(agent.id, { limit: 0 })).toEqual(replaced);
});

test("a configured provider forwards replacement history under its own identity", async () => {
  const { manager, agent } = await fixture(turn("first", "ALPHA", 1_000));
  const session = manager.getAgent(agent.id)?.session;
  if (!session) throw new Error("Expected an active provider session");
  const wrapped = wrapSessionProvider("configured-opencode", session);
  if (!wrapped.replaceHistory) throw new Error("Expected history replacement support");
  await wrapped.replaceHistory(async (history) => {
    expect(Array.from(history)).toMatchObject([
      {
        type: "timeline",
        provider: "configured-opencode",
        item: { type: "user_message", text: "Say ALPHA" },
      },
      {
        type: "timeline",
        provider: "configured-opencode",
        item: { type: "assistant_message", text: "ALPHA" },
      },
    ]);
  });
});
