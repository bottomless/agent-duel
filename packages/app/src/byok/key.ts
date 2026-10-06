import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ArenaByokStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import { queryClient } from "@/data/query-client";
import { getDesktopHost } from "@/desktop/host";
import { i18n } from "@/i18n/i18next";

export interface ArenaByokKeyStorage {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}

export type ArenaByokClient = Pick<DaemonClient, "arenaByokStatus" | "setArenaByokKey">;

export interface ArenaByokHost {
  serverId: string;
  client: ArenaByokClient;
}

export interface ArenaByokHostStatus {
  serverId: string;
  status: ArenaByokStatus;
}

export interface ArenaByokKey {
  /** Stores the key, or removes it with `null`, then hands the change to every host that takes one. */
  set(key: string | null, hosts: readonly ArenaByokHost[]): Promise<ArenaByokHostStatus[]>;
  /** Hands a host that just connected the stored key; the key it already holds changes nothing. */
  deliver(client: ArenaByokClient): Promise<ArenaByokStatus>;
  /** Resolves once the host has a key to run a battle on, and throws when there is none. */
  ensure(client: ArenaByokClient): Promise<void>;
}

export class ArenaByokKeyMissingError extends Error {
  constructor() {
    super(i18n.t("arenaByok.keyMissing"));
    this.name = "ArenaByokKeyMissingError";
  }
}

export function createArenaByokKey(storage: ArenaByokKeyStorage): ArenaByokKey {
  // Read once and then kept current by set(), so a delivery that started reading before a new key
  // was saved still sends the new one.
  let held: { key: string | null } | null = null;

  async function read(): Promise<string | null> {
    if (held) return held.key;
    const stored = await storage.load();
    held ??= { key: stored };
    return held.key;
  }

  async function handOver(client: ArenaByokClient, key: string | null): Promise<ArenaByokStatus> {
    const result = await client.setArenaByokKey(key);
    return { available: true, configured: result.configured };
  }

  return {
    async set(key, hosts) {
      if (key === null) await storage.clear();
      else await storage.save(key);
      held = { key };
      return Promise.all(
        hosts.map(async ({ serverId, client }) => {
          const status = await client.arenaByokStatus();
          if (!status.available) return { serverId, status };
          return { serverId, status: await handOver(client, key) };
        }),
      );
    },
    async deliver(client) {
      const status = await client.arenaByokStatus();
      if (!status.available) return status;
      const key = await read();
      if (key === null) return status;
      return handOver(client, key);
    },
    async ensure(client) {
      const status = await client.arenaByokStatus();
      // A host holding another client's key keeps it: replacing it restarts Arena under every
      // running battle.
      if (!status.available || status.configured) return;
      const key = await read();
      if (key === null) throw new ArenaByokKeyMissingError();
      await handOver(client, key);
    },
  };
}

const BROWSER_STORAGE_KEY = "agent-duel-openrouter-key";

/**
 * Electron encrypts the key in the main process and never leaves a copy in renderer storage. The
 * browser QA harness keeps it in AsyncStorage, which is not a protected boundary.
 */
function resolveKeyStorage(): ArenaByokKeyStorage {
  const desktop = getDesktopHost();
  if (!desktop) {
    return {
      load: () => AsyncStorage.getItem(BROWSER_STORAGE_KEY),
      save: (value) => AsyncStorage.setItem(BROWSER_STORAGE_KEY, value),
      clear: () => AsyncStorage.removeItem(BROWSER_STORAGE_KEY),
    };
  }
  const bridge = desktop.byok?.key;
  if (!bridge) throw new Error("Encrypted OpenRouter key storage is unavailable");
  return bridge;
}

export const platformArenaByokKeyStorage: ArenaByokKeyStorage = {
  load: async () => resolveKeyStorage().load(),
  save: async (value) => resolveKeyStorage().save(value),
  clear: async () => resolveKeyStorage().clear(),
};

export const arenaByokKey = createArenaByokKey(platformArenaByokKeyStorage);

export function arenaByokStatusQueryKey(serverId: string | null) {
  return ["arena-byok-status", serverId] as const;
}

/** A daemon forgets the key when it exits, so every connection hands it over again. */
export function deliverArenaByokKeyOnConnect({ serverId, client }: ArenaByokHost): void {
  void arenaByokKey.deliver(client).then(
    (status) => queryClient.setQueryData(arenaByokStatusQueryKey(serverId), status),
    (error: unknown) =>
      console.warn("[ArenaByok] could not hand the OpenRouter key to the daemon", {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
}
