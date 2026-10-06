import { randomUUID } from "node:crypto";
import {
  applyArenaChanges,
  type ArenaStreamFrame,
  type ArenaStreamPacket,
} from "@getpaseo/protocol/arena/stream";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

interface Subscriber {
  readonly deliver: (packet: ArenaStreamPacket) => void;
  pending: ArenaStreamPacket[];
  bytes: number;
  inFlight: ArenaStreamPacket | null;
  timeout: ReturnType<typeof setTimeout> | null;
}
interface Entry {
  backendKey: string;
  abort: AbortController;
  generation: string;
  sequence: number;
  snapshot: ArenaSnapshot | null;
  subscribers: Set<Subscriber>;
}
export interface ArenaStreamHandle {
  acknowledge(generation: string, sequence: number): void;
  close(): void;
}
interface Subscription {
  backendKey?: string;
  key: string;
  open: (signal: AbortSignal) => AsyncIterable<ArenaStreamFrame>;
  deliver: Subscriber["deliver"];
}

export class ArenaStreamHub {
  private readonly entries = new Map<string, Entry>();

  subscribe({ key, backendKey = key, open, deliver }: Subscription): ArenaStreamHandle {
    const subscriber: Subscriber = {
      deliver,
      pending: [],
      bytes: 0,
      inFlight: null,
      timeout: null,
    };
    let entry = this.entries.get(key);
    const fresh = !entry;
    if (!entry) {
      entry = {
        backendKey,
        abort: new AbortController(),
        generation: randomUUID(),
        sequence: 0,
        snapshot: null,
        subscribers: new Set(),
      };
      this.entries.set(key, entry);
    }
    const current = entry;
    current.subscribers.add(subscriber);
    if (current.snapshot)
      this.enqueue(key, current, subscriber, {
        generation: current.generation,
        sequence: current.sequence,
        frame: { kind: "snapshot", snapshot: current.snapshot },
      });
    if (fresh) void this.pump(key, current, open);
    return {
      acknowledge: (generation, sequence) => {
        const packet = subscriber.inFlight;
        if (!packet || generation !== packet.generation || sequence !== packet.sequence) return;
        if (subscriber.timeout) clearTimeout(subscriber.timeout);
        subscriber.timeout = null;
        subscriber.inFlight = null;
        const next = subscriber.pending.shift();
        if (next) {
          subscriber.bytes -= Buffer.byteLength(JSON.stringify(next));
          this.send(key, current, subscriber, next);
        }
      },
      close: () => this.remove(key, current, subscriber),
    };
  }

  invalidateBackend(backendKey: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.backendKey !== backendKey) continue;
      for (const subscriber of entry.subscribers)
        this.reset(key, entry, subscriber, "Arena state changed; resynchronize");
    }
  }

  counts() {
    let subscribers = 0;
    let queued = 0;
    let bytes = 0;
    for (const entry of this.entries.values())
      for (const subscriber of entry.subscribers) {
        subscribers += 1;
        queued += subscriber.pending.length;
        bytes += subscriber.bytes;
      }
    return { streams: this.entries.size, subscribers, queued, bytes };
  }

  private remove(key: string, entry: Entry, subscriber: Subscriber) {
    if (subscriber.timeout) clearTimeout(subscriber.timeout);
    subscriber.pending = [];
    subscriber.bytes = 0;
    subscriber.inFlight = null;
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size) return;
    entry.abort.abort();
    entry.snapshot = null;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private reset(key: string, entry: Entry, subscriber: Subscriber, reason: string) {
    try {
      subscriber.deliver({
        generation: entry.generation,
        sequence: entry.sequence + 1,
        frame: { kind: "reset", reason },
      });
    } catch {
      // A failed socket must not interrupt delivery to other subscribers.
    } finally {
      this.remove(key, entry, subscriber);
    }
  }

  private enqueue(key: string, entry: Entry, subscriber: Subscriber, packet: ArenaStreamPacket) {
    if (!subscriber.inFlight) {
      this.send(key, entry, subscriber, packet);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    if (subscriber.pending.length >= 256 || subscriber.bytes + bytes > 4 * 1024 * 1024) {
      this.reset(key, entry, subscriber, "Arena updates exceeded the receiver buffer");
      return;
    }
    subscriber.pending.push(packet);
    subscriber.bytes += bytes;
  }

  private send(key: string, entry: Entry, subscriber: Subscriber, packet: ArenaStreamPacket) {
    subscriber.inFlight = packet;
    subscriber.timeout = setTimeout(
      () => this.reset(key, entry, subscriber, "Arena receiver stopped acknowledging updates"),
      10_000,
    );
    subscriber.timeout.unref();
    try {
      subscriber.deliver(packet);
    } catch {
      this.remove(key, entry, subscriber);
    }
  }

  private async pump(key: string, entry: Entry, open: Subscription["open"]) {
    try {
      for await (const frame of open(entry.abort.signal)) {
        if (entry.abort.signal.aborted) return;
        if (frame.kind === "snapshot") entry.snapshot = frame.snapshot;
        else if (frame.kind === "changes") {
          if (!entry.snapshot) throw new Error("Arena updates arrived before their snapshot");
          entry.snapshot = applyArenaChanges(entry.snapshot, frame.changes);
        } else throw new Error(frame.reason);
        const packet = { generation: entry.generation, sequence: ++entry.sequence, frame };
        for (const subscriber of entry.subscribers) this.enqueue(key, entry, subscriber, packet);
      }
    } catch {
      // Recovery always starts from a new authoritative baseline; no durable-log replay.
    } finally {
      if (!entry.abort.signal.aborted)
        for (const subscriber of entry.subscribers)
          this.reset(key, entry, subscriber, "Arena stream disconnected");
    }
  }
}

const hubs = new WeakMap<object, ArenaStreamHub>();
export function arenaStreamHub(owner: object): ArenaStreamHub {
  const existing = hubs.get(owner);
  if (existing) return existing;
  const hub = new ArenaStreamHub();
  hubs.set(owner, hub);
  return hub;
}
