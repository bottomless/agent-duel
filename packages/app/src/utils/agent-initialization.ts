import { arenaUpgradeTimeout } from "@getpaseo/protocol/arena-upgrade";

export interface DeferredInit {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  cancelTimeout: (() => void) | null;
  requestDirection: "tail" | "after";
}

const initPromises = new Map<string, DeferredInit>();
export const INIT_TIMEOUT_MS = 65_000;

export function getInitKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function getInitDeferred(key: string): DeferredInit | undefined {
  return initPromises.get(key);
}

export function createInitDeferred(key: string, requestDirection: "tail" | "after"): DeferredInit {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const deferred: DeferredInit = {
    promise,
    resolve,
    reject,
    cancelTimeout: null,
    requestDirection,
  };
  initPromises.set(key, deferred);
  return deferred;
}

export function refreshInitTimeout(input: {
  key: string;
  onTimeout: () => void;
  timeoutMs?: number;
  upgrade?: Pick<Parameters<typeof arenaUpgradeTimeout>[0], "getUpgrade" | "subscribe">;
}): void {
  const deferred = initPromises.get(input.key);
  if (!deferred) return;
  deferred.cancelTimeout?.();
  deferred.cancelTimeout = arenaUpgradeTimeout({
    timeoutMs: input.timeoutMs ?? INIT_TIMEOUT_MS,
    onTimeout: input.onTimeout,
    getUpgrade: input.upgrade?.getUpgrade ?? (() => null),
    subscribe: input.upgrade?.subscribe ?? (() => () => undefined),
  });
}

export function resolveInitDeferred(key: string): void {
  const deferred = initPromises.get(key);
  if (!deferred) {
    return;
  }
  deferred.cancelTimeout?.();
  initPromises.delete(key);
  deferred.resolve();
}

export function rejectInitDeferred(key: string, error: Error): void {
  const deferred = initPromises.get(key);
  if (!deferred) {
    return;
  }
  deferred.cancelTimeout?.();
  initPromises.delete(key);
  deferred.reject(error);
}
