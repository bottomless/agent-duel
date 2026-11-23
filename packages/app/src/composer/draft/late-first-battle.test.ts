import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { ArenaSnapshotSchema, type ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaStreamPacket } from "@getpaseo/protocol/arena/stream";
import type { ArenaStreamClient } from "@/arena/stream-subscription";
import { useLateFirstBattleStore, watchLateFirstBattleAdmission } from "./late-first-battle";

class FakeArenaStreamClient implements ArenaStreamClient {
  isConnected = true;
  subscriptions: string[] = [];
  unsubscriptions: string[] = [];
  private listener: ((packet: ArenaStreamPacket & { subscriptionId: string }) => void) | undefined;
  getLastServerInfoMessage() {
    return null;
  }
  on(_type: "status", _listener: () => void) {
    return () => {};
  }
  subscribeArenaUpdates(
    listener: (packet: ArenaStreamPacket & { subscriptionId: string }) => void,
  ) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  subscribeConnectionStatus(listener: (state: { status: string }) => void) {
    listener({ status: "connected" });
    return () => {};
  }
  async arenaStreamSubscribe(_agentId: string, id: string) {
    this.subscriptions.push(id);
  }
  async arenaStreamUnsubscribe(id: string) {
    this.unsubscriptions.push(id);
  }
  async arenaStreamAck() {}
  emit(packet: ArenaStreamPacket) {
    this.listener?.({ ...packet, subscriptionId: this.subscriptions.at(-1)! });
  }
}

function emptySnapshot(): ArenaSnapshot {
  return ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "ready",
      canonicalSessionID: "s",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    history: [],
    events: [],
    runs: [],
  });
}

function battleSnapshot(prompt: string): ArenaSnapshot {
  return ArenaSnapshotSchema.parse({
    ...emptySnapshot(),
    chat: {
      id: "chat",
      status: "battle_active",
      activeTurnID: "turn-1",
      canonicalSessionID: "s",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    turn: {
      id: "turn-1",
      index: 1,
      state: "running",
      prompt,
      baseSHA: "sha",
      comparisonState: "pending",
      canVote: false,
      canTie: false,
      canDiscardBattle: false,
      canResumeBattle: false,
      canRetryResolution: false,
      revealed: false,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
    },
  });
}

const queryKey = ["arena", "session", "srv", "agent-1"];

function watch(client: FakeArenaStreamClient, queryClient: QueryClient, prompt: string) {
  const admitted: ArenaSnapshot[] = [];
  const stop = watchLateFirstBattleAdmission({
    queryClient,
    client,
    agentId: "agent-1",
    queryKey,
    prompt,
    onAdmitted: (snapshot) => admitted.push(snapshot),
  });
  return { admitted, stop };
}

describe("watching a first battle whose start response was lost", () => {
  it("hands off once when the engine admits the turn after the timeout", async () => {
    const queryClient = new QueryClient();
    const client = new FakeArenaStreamClient();
    const { admitted, stop } = watch(client, queryClient, "build it");
    await Promise.resolve();
    client.emit({
      generation: "g",
      sequence: 1,
      frame: { kind: "snapshot", snapshot: emptySnapshot() },
    });
    expect(admitted).toEqual([]);

    const battle = battleSnapshot("build it");
    // Admission changes the chat's lifecycle, so the engine re-hydrates and sends a snapshot
    // frame; a state change cannot introduce a new turn.
    client.emit({ generation: "g", sequence: 2, frame: { kind: "snapshot", snapshot: battle } });
    expect(admitted).toEqual([battle]);
    expect(queryClient.getQueryData(queryKey)).toEqual(battle);

    client.emit({ generation: "g", sequence: 3, frame: { kind: "changes", changes: [] } });
    expect(admitted).toHaveLength(1);

    stop();
    await Promise.resolve();
    expect(client.unsubscriptions).toHaveLength(1);
  });

  it("waits for the draft's own prompt, not another battle", async () => {
    const queryClient = new QueryClient();
    const client = new FakeArenaStreamClient();
    const { admitted, stop } = watch(client, queryClient, "build it");
    await Promise.resolve();
    client.emit({
      generation: "g",
      sequence: 1,
      frame: { kind: "snapshot", snapshot: battleSnapshot("something else") },
    });
    expect(admitted).toEqual([]);

    const battle = battleSnapshot("build it");
    client.emit({ generation: "g", sequence: 2, frame: { kind: "snapshot", snapshot: battle } });
    expect(admitted).toEqual([battle]);
    stop();
    await Promise.resolve();
  });

  it("hands off at once when a remount finds the battle already in the cache", () => {
    const queryClient = new QueryClient();
    const client = new FakeArenaStreamClient();
    const battle = battleSnapshot("build it");
    queryClient.setQueryData(queryKey, battle);
    const { admitted, stop } = watch(client, queryClient, "build it");
    expect(admitted).toEqual([battle]);
    stop();
  });

  it("stops watching when the draft releases it", async () => {
    const queryClient = new QueryClient();
    const client = new FakeArenaStreamClient();
    const { admitted, stop } = watch(client, queryClient, "build it");
    await Promise.resolve();
    stop();
    await Promise.resolve();
    expect(client.unsubscriptions).toHaveLength(1);
    queryClient.setQueryData(queryKey, battleSnapshot("build it"));
    expect(admitted).toEqual([]);
  });
});

describe("the late first battle record", () => {
  afterEach(() => useLateFirstBattleStore.setState({ byDraftId: {} }));

  it("holds one record per draft and clears it without touching others", () => {
    const battle = {
      serverId: "srv",
      agentId: "agent-1",
      prompt: "build it",
      result: AgentSnapshotPayloadSchema.parse({
        id: "agent-1",
        provider: "opencode",
        cwd: "/tmp/project",
        model: null,
        createdAt: "2026-11-23T00:00:00Z",
        updatedAt: "2026-11-23T00:00:00Z",
        lastUserMessageAt: null,
        status: "idle",
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
        currentModeId: null,
        availableModes: [],
        pendingPermissions: [],
        persistence: null,
        title: null,
        labels: {},
      }),
    };
    useLateFirstBattleStore.getState().set("draft-1", battle);
    useLateFirstBattleStore.getState().set("draft-2", { ...battle, agentId: "agent-2" });
    expect(useLateFirstBattleStore.getState().byDraftId["draft-1"]).toEqual(battle);
    useLateFirstBattleStore.getState().clear("draft-1");
    expect(useLateFirstBattleStore.getState().byDraftId["draft-1"]).toBeUndefined();
    expect(useLateFirstBattleStore.getState().byDraftId["draft-2"]?.agentId).toBe("agent-2");
  });
});
