import type { ArenaDatabaseUpgrade } from "@getpaseo/protocol/arena-upgrade";
import { arenaUpgradeTimeout } from "@getpaseo/protocol/arena-upgrade";

const upgrades = new Map<object, ArenaDatabaseUpgrade>();
const listeners = new Set<() => void>();

export function getArenaDatabaseUpgrade(): ArenaDatabaseUpgrade | null {
  return [...upgrades.values()].sort((a, b) => b.deadline - a.deadline)[0] ?? null;
}

export function onArenaDatabaseUpgrade(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setArenaDatabaseUpgrade(owner: object, upgrade: ArenaDatabaseUpgrade | null): void {
  if (upgrade) upgrades.set(owner, upgrade);
  else if (!upgrades.delete(owner)) return;
  for (const listener of listeners) listener();
}

export async function withArenaUpgradeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  arena: boolean,
): Promise<T> {
  const startedAt = Date.now();
  let cancelTimeout = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancelTimeout = arenaUpgradeTimeout({
      timeoutMs,
      getUpgrade: () => (arena ? getArenaDatabaseUpgrade() : null),
      subscribe: onArenaDatabaseUpgrade,
      onTimeout: () => reject(new Error(`${label} after ${Date.now() - startedAt}ms`)),
    });
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    cancelTimeout();
  }
}
