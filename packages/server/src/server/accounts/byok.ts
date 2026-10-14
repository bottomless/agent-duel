import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import {
  clearArenaCredentials,
  expectArenaCredentials,
  expectNoArenaCredentials,
  installArenaCredentials,
  readArenaCredentials,
} from "./credentials.js";

/**
 * How long Arena starts wait for a client that announced a key handover and then neither handed a
 * key over nor said it has none. The app answers within a second of connecting.
 */
const ARENA_BYOK_KEY_HANDOVER_TIMEOUT_MS = 10_000;

/**
 * Holds the user's OpenRouter key for a daemon without a control plane. The renderer stores the
 * key and hands it over after connecting; the daemon keeps it only in memory and passes it to
 * Arena through the child's stdin, never an environment variable or file.
 */
export interface ArenaByokService {
  isConfigured(): boolean;
  /**
   * `client` just connected and hands over its stored key next if it has one. Until it does, or
   * says it has none, Arena starts wait for that key, so the chats the client reopens on
   * connecting do not fail for a key that is on its way.
   */
  expectKey(client: object): void;
  /** `client` has no key to hand over, so Arena starts stop waiting for one from it. */
  expectNoKey(client: object): void;
  /** Installs, replaces, or with `null` clears the key, restarting Arena when it changes. */
  setKey(key: string | null): Promise<void>;
}

export interface CreateArenaByokServiceOptions {
  readonly restartArena?: () => Promise<void>;
  readonly providerSnapshots?: Pick<ProviderSnapshotManager, "reloadSnapshots">;
  readonly keyHandoverTimeoutMs?: number;
}

function heldKey(): string | null {
  const credentials = readArenaCredentials()?.credentials;
  return credentials?.mode === "byok" ? credentials.openRouterApiKey : null;
}

export function createArenaByokService(
  options: CreateArenaByokServiceOptions = {},
): ArenaByokService {
  const restartArena = options.restartArena ?? (() => OpenCodeServerManager.restartInstance());
  const keyHandoverTimeoutMs = options.keyHandoverTimeoutMs ?? ARENA_BYOK_KEY_HANDOVER_TIMEOUT_MS;
  let transition = Promise.resolve();

  return {
    isConfigured: () => heldKey() !== null,
    expectKey(client) {
      if (heldKey() === null) expectArenaCredentials(client, keyHandoverTimeoutMs);
    },
    expectNoKey(client) {
      expectNoArenaCredentials(client);
    },
    setKey(key) {
      async function apply(): Promise<void> {
        // A reconnecting client hands over the key it already gave; that must not interrupt battles.
        const previous = heldKey();
        if (key === previous) return;
        if (key === null) clearArenaCredentials();
        else installArenaCredentials({ mode: "byok", openRouterApiKey: key });
        // Arena cannot start without a key, so the first one has nothing to restart. Restarting
        // anyway would stop the start that a chat reopened on connecting is waiting on.
        if (previous !== null) await restartArena();
        // The app runs before it has a key, so opening a project can cache the opencode provider
        // as failed. Reload it for every project now; the reload starts Arena, so it runs in the
        // background rather than holding up the save. It must not force the load: a forced
        // opencode load replaces the Arena server under every request waiting on its start.
        if (options.providerSnapshots) {
          void options.providerSnapshots.reloadSnapshots({ providers: ["opencode"] });
        }
      }
      const next = transition.then(apply);
      transition = next.catch(() => undefined);
      return next;
    },
  };
}
