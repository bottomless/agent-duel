import {
  applyArenaChanges,
  type ArenaStreamPacket,
  type ArenaStreamTarget,
} from "@getpaseo/protocol/arena/stream";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export interface ArenaStreamClient {
  readonly isConnected: boolean;
  subscribeArenaUpdates(
    listener: (packet: ArenaStreamPacket & { subscriptionId: string }) => void,
  ): () => void;
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
  arenaStreamSubscribe(
    agentId: string,
    subscriptionId: string,
    target: ArenaStreamTarget,
  ): Promise<void>;
  arenaStreamUnsubscribe(subscriptionId: string): Promise<void>;
  arenaStreamAck(subscriptionId: string, generation: string, sequence: number): Promise<void>;
}

export class ArenaSubscription {
  private consumers = 0;
  private ownershipScheduled = false;
  private pauses = 0;
  private id: string | null = null;
  private generation: string | null = null;
  private sequence = -1;
  private snapshot: ArenaSnapshot | undefined;
  private baselineTimeout: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offUpdates: (() => void) | undefined;
  private offConnection: (() => void) | undefined;
  private failures = 0;
  private error: Error | null = null;
  private readonly waiters = new Set<
    (result: { isError: boolean; data?: ArenaSnapshot }) => void
  >();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly client: ArenaStreamClient,
    private readonly agentId: string,
    private readonly target: ArenaStreamTarget,
    private readonly publish: (snapshot: ArenaSnapshot) => void,
    private readonly idle?: () => void,
  ) {}

  getError = () => this.error;
  listen = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private setError(error: Error | null) {
    this.error = error;
    for (const listener of this.listeners) listener();
  }

  private reconcileOwnership() {
    if (this.ownershipScheduled) return;
    this.ownershipScheduled = true;
    queueMicrotask(() => {
      this.ownershipScheduled = false;
      if (this.consumers) {
        if (this.offUpdates) return;
        this.offUpdates = this.client.subscribeArenaUpdates((packet) => {
          if (packet.subscriptionId === this.id) this.receive(packet);
        });
        this.offConnection = this.client.subscribeConnectionStatus((state) => {
          if (state.status === "connected") {
            if (!this.id && !this.timer) this.connect();
          } else if (!this.timer) this.recover(new Error("Arena connection interrupted"));
        });
        return;
      }
      this.disconnect();
      for (const finish of this.waiters) finish({ isError: true, data: this.snapshot });
      this.snapshot = undefined;
      this.offUpdates?.();
      this.offConnection?.();
      this.offUpdates = undefined;
      this.offConnection = undefined;
      this.idle?.();
    });
  }

  retain(): () => void {
    this.consumers += 1;
    // Retained panels can exchange ownership several times in one React commit.
    this.reconcileOwnership();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.consumers -= 1;
      this.reconcileOwnership();
    };
  }

  pause(): () => void {
    this.pauses += 1;
    this.disconnect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauses -= 1;
      if (!this.pauses) this.connect();
    };
  }

  refresh = (): Promise<{ isError: boolean; data?: ArenaSnapshot }> =>
    new Promise((resolve) => {
      // Both timeout and delivery converge here; deleting the waiter makes delivery one-shot.
      let finished = false;
      const finish = (result: { isError: boolean; data?: ArenaSnapshot }) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.waiters.delete(finish);
        // oxlint-disable-next-line promise/no-multiple-resolved -- finished guards timeout and delivery.
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ isError: true, data: this.snapshot }), 30_000);
      this.waiters.add(finish);
      this.retry();
    });

  retry = () => {
    this.disconnect();
    this.failures = 0;
    this.setError(null);
    this.connect();
  };

  private disconnect() {
    if (this.baselineTimeout) clearTimeout(this.baselineTimeout);
    this.baselineTimeout = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const id = this.id;
    this.id = null;
    this.generation = null;
    this.sequence = -1;
    if (id && this.client.isConnected) void this.client.arenaStreamUnsubscribe(id).catch(() => {});
  }

  private connect() {
    if (!this.consumers || this.pauses || this.id) return;
    if (!this.offUpdates) {
      this.reconcileOwnership();
      return;
    }
    if (!this.client.isConnected) {
      this.recover(new Error("Arena daemon connection is unavailable"));
      return;
    }
    const id = globalThis.crypto.randomUUID();
    this.id = id;
    this.baselineTimeout = setTimeout(() => {
      if (this.id === id) this.recover(new Error("Arena snapshot timed out"));
    }, 30_000);
    void this.client.arenaStreamSubscribe(this.agentId, id, this.target).catch((error: unknown) => {
      if (this.id === id) this.recover(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private recover(error: Error) {
    this.disconnect();
    if (!this.consumers || this.pauses) return;
    this.failures += 1;
    if (this.failures >= 3) this.setError(error);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.failures - 1, 5));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  private receive(packet: ArenaStreamPacket) {
    const id = this.id;
    if (!id) return;
    if (this.generation === packet.generation && packet.sequence <= this.sequence) {
      void this.client.arenaStreamAck(id, packet.generation, packet.sequence).catch(() => {});
      return;
    }
    if (packet.frame.kind === "reset") {
      if (this.generation !== null && packet.generation !== this.generation) return;
      this.recover(new Error(packet.frame.reason));
      return;
    }
    try {
      if (
        this.generation !== null &&
        (packet.generation !== this.generation || packet.sequence !== this.sequence + 1)
      )
        throw new Error("Arena update sequence changed");
      if (packet.frame.kind === "snapshot") this.snapshot = packet.frame.snapshot;
      else {
        if (!this.snapshot || this.generation === null)
          throw new Error("Arena update arrived before its snapshot");
        this.snapshot = applyArenaChanges(this.snapshot, packet.frame.changes);
      }
      if (this.baselineTimeout) clearTimeout(this.baselineTimeout);
      this.baselineTimeout = undefined;
      this.generation = packet.generation;
      this.sequence = packet.sequence;
      this.publish(this.snapshot);
      for (const finish of this.waiters) finish({ isError: false, data: this.snapshot });
      this.failures = 0;
      if (this.error) this.setError(null);
      void this.client
        .arenaStreamAck(id, packet.generation, packet.sequence)
        .catch((error: unknown) => {
          if (this.id === id)
            this.recover(error instanceof Error ? error : new Error(String(error)));
        });
    } catch (error) {
      this.recover(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const registries = new WeakMap<
  QueryClient,
  WeakMap<ArenaStreamClient, Map<string, ArenaSubscription>>
>();
export function arenaSubscription(
  queryClient: QueryClient,
  client: ArenaStreamClient,
  agentId: string,
  target: ArenaStreamTarget,
  queryKey: QueryKey,
): ArenaSubscription {
  let clients = registries.get(queryClient);
  if (!clients) {
    clients = new WeakMap();
    registries.set(queryClient, clients);
  }
  let subscriptions = clients.get(client);
  if (!subscriptions) {
    subscriptions = new Map();
    clients.set(client, subscriptions);
  }
  const key = JSON.stringify([agentId, target]);
  const existing = subscriptions.get(key);
  if (existing) return existing;
  const registry = subscriptions;
  const subscription = new ArenaSubscription(
    client,
    agentId,
    target,
    (snapshot) => queryClient.setQueryData(queryKey, snapshot),
    () => {
      if (registry.get(key) === subscription) registry.delete(key);
    },
  );
  subscriptions.set(key, subscription);
  return subscription;
}
