import { describe, expect, it } from "vitest";
import { ArenaStreamHub } from "./arena-stream-hub.js";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaStreamFrame, ArenaStreamPacket } from "@getpaseo/protocol/arena/stream";

function fixture() {
  return ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "ready",
      canonicalSessionID: "session",
      canonicalSHA: "sha",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    history: [],
    events: [],
    runs: [],
  });
}
function source() {
  const frames: ArenaStreamFrame[] = [];
  let wake: (() => void) | undefined;
  let opened = 0;
  let closed = 0;
  return {
    push(frame: ArenaStreamFrame) {
      frames.push(frame);
      wake?.();
    },
    counts: () => ({ opened, closed }),
    async *open(signal: AbortSignal): AsyncGenerator<ArenaStreamFrame> {
      opened++;
      const stop = () => wake?.();
      signal.addEventListener("abort", stop);
      try {
        while (!signal.aborted) {
          const frame = frames.shift();
          if (frame) yield frame;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        closed++;
        signal.removeEventListener("abort", stop);
      }
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("shared Arena upstream", () => {
  it("continues resetting other windows when a closed socket rejects reset delivery", async () => {
    const hub = new ArenaStreamHub();
    const upstream = source();
    const received: ArenaStreamPacket[] = [];
    hub.subscribe({
      key: "same",
      open: upstream.open,
      deliver: (packet) => {
        if (packet.frame.kind === "reset") throw new Error("socket closed");
      },
    });
    hub.subscribe({ key: "same", open: upstream.open, deliver: (packet) => received.push(packet) });
    upstream.push({ kind: "snapshot", snapshot: fixture() });
    await settle();
    expect(() => hub.invalidateBackend("same")).not.toThrow();
    await settle();
    expect(received.at(-1)?.frame.kind).toBe("reset");
    expect(hub.counts()).toEqual({ streams: 0, subscribers: 0, queued: 0, bytes: 0 });
    expect(upstream.counts().closed).toBe(1);
  });

  it("gives a late window the current snapshot and closes upstream only after the last window", async () => {
    const hub = new ArenaStreamHub();
    const upstream = source();
    const first: ArenaStreamPacket[] = [];
    const second: ArenaStreamPacket[] = [];
    const a = hub.subscribe({
      key: "same",
      open: upstream.open,
      deliver: (packet) => first.push(packet),
    });
    upstream.push({ kind: "snapshot", snapshot: fixture() });
    await settle();
    a.acknowledge(first[0].generation, first[0].sequence);
    const state = fixture();
    state.chat.canonicalSHA = "new";
    upstream.push({ kind: "changes", changes: [{ kind: "state", snapshot: state }] });
    await settle();
    const b = hub.subscribe({
      key: "same",
      open: upstream.open,
      deliver: (packet) => second.push(packet),
    });
    expect(upstream.counts().opened).toBe(1);
    expect(second[0].frame).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { canonicalSHA: "new" } },
    });
    a.close();
    expect(hub.counts().subscribers).toBe(1);
    b.close();
    await settle();
    expect(hub.counts()).toEqual({ streams: 0, subscribers: 0, queued: 0, bytes: 0 });
    expect(upstream.counts().closed).toBe(1);
  });
  it("isolates a receiver that does not acknowledge and ignores stale acknowledgements", async () => {
    const hub = new ArenaStreamHub();
    const upstream = source();
    const slow: ArenaStreamPacket[] = [];
    const fast: ArenaStreamPacket[] = [];
    hub.subscribe({ key: "same", open: upstream.open, deliver: (packet) => slow.push(packet) });
    const b = hub.subscribe({
      key: "same",
      open: upstream.open,
      deliver: (packet) => fast.push(packet),
    });
    upstream.push({ kind: "snapshot", snapshot: fixture() });
    await settle();
    for (let i = 0; i < 258; i++) {
      const last = fast.at(-1)!;
      b.acknowledge(last.generation, last.sequence);
      b.acknowledge("old", last.sequence + 1);
      upstream.push({ kind: "changes", changes: [] });
      await settle();
    }
    expect(slow).toHaveLength(2);
    expect(slow[1].frame.kind).toBe("reset");
    expect(fast).toHaveLength(259);
    expect(hub.counts().subscribers).toBe(1);
    b.close();
    await settle();
    expect(hub.counts().streams).toBe(0);
  });
  it("uses separate targets and resets subscribers when the backend closes", async () => {
    const hub = new ArenaStreamHub();
    const packets: ArenaStreamPacket[] = [];
    async function* closed() {
      yield { kind: "snapshot" as const, snapshot: fixture() };
    }
    hub.subscribe({ key: "current", open: closed, deliver: (packet) => packets.push(packet) });
    hub.subscribe({ key: "historical", open: closed, deliver: (packet) => packets.push(packet) });
    await settle();
    expect(packets.filter((packet) => packet.frame.kind === "reset")).toHaveLength(2);
    expect(hub.counts().streams).toBe(0);
  });
  it("keeps the initial snapshot outside the 4 MiB pending-change limit", async () => {
    const hub = new ArenaStreamHub();
    const upstream = source();
    const packets: ArenaStreamPacket[] = [];
    hub.subscribe({ key: "large", open: upstream.open, deliver: (packet) => packets.push(packet) });
    upstream.push({
      kind: "snapshot",
      snapshot: { ...fixture(), largeFixture: "x".repeat(5 * 1024 * 1024) },
    });
    await settle();
    expect(packets).toHaveLength(1);
    expect(packets[0].frame.kind).toBe("snapshot");
    upstream.push({
      kind: "changes",
      changes: [
        { kind: "state", snapshot: { ...fixture(), largeFixture: "x".repeat(4 * 1024 * 1024) } },
      ],
    });
    await settle();
    expect(packets[1].frame.kind).toBe("reset");
    expect(hub.counts()).toEqual({ streams: 0, subscribers: 0, queued: 0, bytes: 0 });
  });

  it("invalidates cached pre-action snapshots while another window remains open", async () => {
    const hub = new ArenaStreamHub();
    const old = source();
    const next = source();
    const received: ArenaStreamPacket[] = [];
    hub.subscribe({
      key: "current",
      backendKey: "backend",
      open: old.open,
      deliver: (packet) => received.push(packet),
    });
    old.push({ kind: "snapshot", snapshot: fixture() });
    await settle();
    hub.invalidateBackend("backend");
    const afterAction: ArenaStreamPacket[] = [];
    const handle = hub.subscribe({
      key: "current",
      backendKey: "backend",
      open: next.open,
      deliver: (packet) => afterAction.push(packet),
    });
    expect(afterAction).toEqual([]);
    const current = fixture();
    current.chat.canonicalSHA = "after-action";
    next.push({ kind: "snapshot", snapshot: current });
    await settle();
    expect(afterAction[0].frame).toMatchObject({
      snapshot: { chat: { canonicalSHA: "after-action" } },
    });
    expect(afterAction[0].generation).not.toBe(received[0].generation);
    handle.close();
  });
});
