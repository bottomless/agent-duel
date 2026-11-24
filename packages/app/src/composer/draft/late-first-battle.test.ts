import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { ArenaSnapshotSchema, type ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaStreamPacket } from "@getpaseo/protocol/arena/stream";
import { readPendingBattlePrompt } from "@/arena/pending-battle";
import type { ArenaStreamClient } from "@/arena/stream-subscription";
import type { UserComposerAttachment } from "@/attachments/types";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore, type DraftInput } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import {
  carryDraftIntoLateFirstBattle,
  draftBeyondLateFirstBattle,
  useLateFirstBattleStore,
  watchLateFirstBattleAdmission,
  type LateFirstBattle,
} from "./late-first-battle";

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

function image(id: string): UserComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: `${id}.png`,
      createdAt: 1,
    },
  };
}

function lateBattle(attachments: UserComposerAttachment[] = []): LateFirstBattle {
  return {
    serverId: "srv",
    agentId: "agent-1",
    prompt: "build it",
    attachments,
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
}

describe("the late first battle record", () => {
  afterEach(() => useLateFirstBattleStore.setState({ byDraftId: {} }));

  it("holds one record per draft and clears it without touching others", () => {
    const battle = lateBattle();
    useLateFirstBattleStore.getState().set("draft-1", battle);
    useLateFirstBattleStore.getState().set("draft-2", { ...battle, agentId: "agent-2" });
    expect(useLateFirstBattleStore.getState().byDraftId["draft-1"]).toEqual(battle);
    useLateFirstBattleStore.getState().clear("draft-1");
    expect(useLateFirstBattleStore.getState().byDraftId["draft-1"]).toBeUndefined();
    expect(useLateFirstBattleStore.getState().byDraftId["draft-2"]?.agentId).toBe("agent-2");
  });
});

describe("what the draft holds beyond the admitted battle", () => {
  const sent = image("sent");
  const battle = { prompt: "build it", attachments: [sent] };

  function beyond(draft: DraftInput) {
    return draftBeyondLateFirstBattle({ battle, draft });
  }

  it("is nothing while the draft is the restored send", () => {
    expect(beyond({ text: "build it", attachments: [sent] })).toBeNull();
  });

  it("is nothing when only whitespace was added around the restored prompt", () => {
    expect(beyond({ text: "build it\n", attachments: [sent] })).toBeNull();
  });

  it("is nothing when the restored draft was emptied", () => {
    expect(beyond({ text: "  ", attachments: [] })).toBeNull();
  });

  it("is the edited prompt, without the attachments the battle already has", () => {
    expect(beyond({ text: "build it with tests", attachments: [sent] })).toEqual({
      text: "build it with tests",
      attachments: [],
    });
  });

  it("is the text typed in place of the restored prompt", () => {
    expect(beyond({ text: "and then deploy it ", attachments: [] })).toEqual({
      text: "and then deploy it ",
      attachments: [],
    });
  });

  it("is the added attachment, without the prompt the battle already has", () => {
    const added = image("added");
    expect(beyond({ text: "build it", attachments: [sent, added] })).toEqual({
      text: "",
      attachments: [added],
    });
  });

  it("is both new text and added attachments", () => {
    const added: UserComposerAttachment = {
      kind: "workspace_file",
      path: "src/app.ts",
      selection: { kind: "whole_file" },
    };
    expect(beyond({ text: "use this file", attachments: [added, sent] })).toEqual({
      text: "use this file",
      attachments: [added],
    });
  });
});

describe("handing the draft to the chat a late battle opens", () => {
  const draftKey = buildDraftStoreKey({ serverId: "srv", agentId: "tab-1", draftId: "draft-1" });
  const agentDraftKey = buildDraftStoreKey({ serverId: "srv", agentId: "agent-1" });
  const sent = image("sent");

  function typeInDraft(draft: DraftInput) {
    useDraftStore.getState().saveDraftInput({ draftKey, draft });
  }

  function handOff() {
    carryDraftIntoLateFirstBattle({ battle: lateBattle([sent]), draftKey });
  }

  function agentComposerDraft() {
    return useDraftStore.getState().getDraftInput(agentDraftKey);
  }

  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, textReplacementRequestByDraftKey: {} });
    useCreateFlowStore.setState({ pendingByDraftId: {} });
  });

  it("leaves the chat's composer empty when the draft is the restored send", () => {
    typeInDraft({ text: "build it", attachments: [sent] });
    handOff();
    expect(agentComposerDraft()).toBeUndefined();
  });

  it("leaves the chat's composer empty when the draft holds nothing", () => {
    handOff();
    expect(agentComposerDraft()).toBeUndefined();
  });

  it("opens the chat's composer with the text typed while waiting", () => {
    typeInDraft({ text: "build it with tests", attachments: [sent] });
    handOff();
    expect(agentComposerDraft()).toEqual({ text: "build it with tests", attachments: [] });
  });

  it("opens the chat's composer with the attachments added while waiting", () => {
    const added = image("added");
    typeInDraft({ text: "build it", attachments: [sent, added] });
    handOff();
    expect(agentComposerDraft()).toEqual({ text: "", attachments: [added] });
  });

  it("tells a composer that is already open to show the carried text", () => {
    typeInDraft({ text: "and then deploy it", attachments: [] });
    handOff();
    expect(useDraftStore.getState().textReplacementRequestByDraftKey[agentDraftKey]).toBe(1);
  });

  it("keeps what an open agent tab's composer already holds", () => {
    const held = image("held");
    const added = image("added");
    useDraftStore.getState().saveDraftInput({
      draftKey: agentDraftKey,
      draft: { text: "already here", attachments: [held] },
    });
    typeInDraft({ text: "and then deploy it", attachments: [added] });
    handOff();
    expect(agentComposerDraft()).toEqual({
      text: "already here\n\nand then deploy it",
      attachments: [held, added],
    });
  });

  it("leaves the carried content unsent, as a draft the user can still edit", () => {
    typeInDraft({ text: "and then deploy it", attachments: [image("added")] });
    handOff();
    expect(useDraftStore.getState().drafts[agentDraftKey]?.lifecycle).toBe("active");
    expect(useCreateFlowStore.getState().pendingByDraftId).toEqual({});
    expect(readPendingBattlePrompt({ serverId: "srv", agentId: "agent-1" })).toBeNull();
    expect(useSessionStore.getState().sessions).toEqual({});
  });
});
