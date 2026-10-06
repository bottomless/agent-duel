import { describe, expect, it, vi } from "vitest";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaStreamPacket } from "@getpaseo/protocol/arena/stream";
import { ArenaSubscription, type ArenaStreamClient } from "./stream-subscription";
import { arenaRunStatusLabel } from "./run-stats";

class Client implements ArenaStreamClient {
  isConnected = true;
  subscriptions: string[] = [];
  unsubscriptions: string[] = [];
  acknowledgements: number[] = [];
  listener: Parameters<ArenaStreamClient["subscribeArenaUpdates"]>[0] | undefined;
  connection: Parameters<ArenaStreamClient["subscribeConnectionStatus"]>[0] | undefined;
  subscribeArenaUpdates(listener: Parameters<ArenaStreamClient["subscribeArenaUpdates"]>[0]) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  subscribeConnectionStatus(
    listener: Parameters<ArenaStreamClient["subscribeConnectionStatus"]>[0],
  ) {
    this.connection = listener;
    listener({ status: this.isConnected ? "connected" : "disconnected" });
    return () => {
      this.connection = undefined;
    };
  }
  async arenaStreamSubscribe(_agent: string, id: string) {
    this.subscriptions.push(id);
  }
  async arenaStreamUnsubscribe(id: string) {
    this.unsubscriptions.push(id);
  }
  async arenaStreamAck(_id: string, _generation: string, sequence: number) {
    this.acknowledgements.push(sequence);
  }
  emit(packet: ArenaStreamPacket, subscriptionId = this.subscriptions.at(-1)!) {
    this.listener?.({ ...packet, subscriptionId });
  }
}
function snapshot() {
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
const baseline = (): ArenaStreamPacket => ({
  generation: "g",
  sequence: 1,
  frame: { kind: "snapshot", snapshot: snapshot() },
});

describe("Arena UI subscription", () => {
  it("publishes renewed activity and ignores old packets after reconnect and chat return", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:02:00Z"));
    const client = new Client();
    const states: ReturnType<typeof snapshot>[] = [];
    const old = snapshot();
    old.runs = [
      {
        id: "run",
        side: "a",
        sessionID: "session",
        descendantSessionIDs: [],
        worktree: "/tmp/run",
        worktreeName: "run",
        worktreeActive: true,
        runState: "pending",
        durationMs: null,
        selectable: false,
        applicable: false,
        startedAt: "2026-09-25T10:00:00Z",
        lastEventAt: "2026-09-25T10:00:00Z",
        messages: [],
        parts: {},
      },
    ];
    const fresh = { ...old, runs: [{ ...old.runs[0]!, lastEventAt: new Date().toISOString() }] };
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, (state) =>
      states.push(state),
    );
    let off = stream.retain();
    try {
      await Promise.resolve();
      const oldId = client.subscriptions.at(-1)!;
      client.emit({ generation: "old", sequence: 1, frame: { kind: "snapshot", snapshot: old } });
      expect(arenaRunStatusLabel(states.at(-1)!.runs[0]!, Date.now())).toBe("No recent activity");
      client.emit({
        generation: "old",
        sequence: 2,
        frame: { kind: "changes", changes: [{ kind: "state", snapshot: fresh }] },
      });
      expect(arenaRunStatusLabel(states.at(-1)!.runs[0]!, Date.now())).toBe("Working");
      client.isConnected = false;
      client.connection?.({ status: "disconnected" });
      client.isConnected = true;
      client.connection?.({ status: "connected" });
      await vi.advanceTimersByTimeAsync(1000);
      client.emit({ generation: "new", sequence: 1, frame: { kind: "snapshot", snapshot: fresh } });
      client.emit(
        { generation: "old", sequence: 3, frame: { kind: "snapshot", snapshot: old } },
        oldId,
      );
      expect(states.at(-1)!.runs[0]!.lastEventAt).toBe(fresh.runs[0]!.lastEventAt);
      off();
      await Promise.resolve();
      off = stream.retain();
      await Promise.resolve();
      const complete = { ...fresh, runs: [{ ...fresh.runs[0]!, runState: "complete" as const }] };
      client.emit({
        generation: "returned",
        sequence: 1,
        frame: { kind: "snapshot", snapshot: complete },
      });
      expect(arenaRunStatusLabel(states.at(-1)!.runs[0]!, Date.now())).toBe("Finished");
    } finally {
      off();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("coalesces transient ownership changes without another snapshot subscription", async () => {
    const client = new Client();
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, () => {});
    const first = stream.retain();
    await Promise.resolve();
    client.emit(baseline());
    first();
    const second = stream.retain();
    second();
    const final = stream.retain();
    await Promise.resolve();
    expect(client.subscriptions).toHaveLength(1);
    expect(client.unsubscriptions).toHaveLength(0);
    final();
    await Promise.resolve();
    expect(client.unsubscriptions).toHaveLength(1);
  });

  it("shows retry state when opened offline and resumes after the daemon connects", async () => {
    vi.useFakeTimers();
    try {
      const client = new Client();
      client.isConnected = false;
      const stream = new ArenaSubscription(client, "agent", { kind: "current" }, () => {});
      const off = stream.retain();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(stream.getError()?.message).toContain("unavailable");
      expect(client.subscriptions).toHaveLength(0);
      client.isConnected = true;
      client.connection?.({ status: "connected" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(client.subscriptions).toHaveLength(1);
      client.emit(baseline());
      expect(stream.getError()).toBeNull();
      off();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds first-snapshot waits, exposes persistent failure, and clears retry timers on release", async () => {
    vi.useFakeTimers();
    try {
      const client = new Client();
      const stream = new ArenaSubscription(client, "agent", { kind: "current" }, () => {});
      const off = stream.retain();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.unsubscriptions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.subscriptions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000 + 2_000 + 30_000);
      expect(stream.getError()?.message).toContain("timed out");
      stream.retry();
      expect(stream.getError()).toBeNull();
      client.emit(baseline());
      expect(vi.getTimerCount()).toBe(0);
      off();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale reset from an old sequence or generation", async () => {
    const client = new Client();
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, () => {});
    const off = stream.retain();
    await Promise.resolve();
    client.emit(baseline());
    client.emit({ generation: "g", sequence: 1, frame: { kind: "reset", reason: "old" } });
    client.emit({ generation: "previous", sequence: 99, frame: { kind: "reset", reason: "old" } });
    expect(client.unsubscriptions).toHaveLength(0);
    client.emit({ generation: "g", sequence: 3, frame: { kind: "reset", reason: "overflow" } });
    expect(client.unsubscriptions).toHaveLength(1);
    off();
    await Promise.resolve();
  });

  it("shares ownership and keeps the connection until the last consumer leaves", async () => {
    const client = new Client();
    const received: unknown[] = [];
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, (state) =>
      received.push(state),
    );
    const a = stream.retain();
    const b = stream.retain();
    await Promise.resolve();
    expect(client.subscriptions).toHaveLength(1);
    client.emit(baseline());
    a();
    expect(client.unsubscriptions).toHaveLength(0);
    client.emit({ generation: "g", sequence: 2, frame: { kind: "changes", changes: [] } });
    expect(received).toHaveLength(2);
    b();
    await Promise.resolve();
    expect(client.unsubscriptions).toHaveLength(1);
    expect(client.listener).toBeUndefined();
    expect(client.connection).toBeUndefined();
  });
  it("ignores duplicates and reopens after a gap without clearing content", async () => {
    const client = new Client();
    const received: unknown[] = [];
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, (state) =>
      received.push(state),
    );
    const off = stream.retain();
    await Promise.resolve();
    client.emit(baseline());
    client.emit(baseline());
    expect(received).toHaveLength(1);
    client.emit({ generation: "g", sequence: 3, frame: { kind: "changes", changes: [] } });
    expect(client.unsubscriptions).toHaveLength(1);
    expect(received).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(client.subscriptions).toHaveLength(2);
    client.emit({ ...baseline(), generation: "new" });
    expect(received).toHaveLength(2);
    off();
    await Promise.resolve();
  });
  it("invalidates the old generation during an action and resumes even after failure", async () => {
    const client = new Client();
    const received: unknown[] = [];
    const stream = new ArenaSubscription(client, "agent", { kind: "current" }, (state) =>
      received.push(state),
    );
    const off = stream.retain();
    await Promise.resolve();
    const old = client.subscriptions[0];
    client.emit(baseline());
    const resume = stream.pause();
    client.emit({ ...baseline(), sequence: 2 }, old);
    expect(received).toHaveLength(1);
    resume();
    resume();
    expect(client.subscriptions).toHaveLength(2);
    client.emit({ ...baseline(), sequence: 3 }, old);
    expect(received).toHaveLength(1);
    client.emit({ ...baseline(), generation: "new" });
    expect(received).toHaveLength(2);
    off();
    await Promise.resolve();
  });
});
