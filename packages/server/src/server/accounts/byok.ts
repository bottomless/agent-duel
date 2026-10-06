import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import {
  clearArenaCredentials,
  installArenaCredentials,
  readArenaCredentials,
} from "./credentials.js";

/**
 * Holds the user's OpenRouter key for a daemon without a control plane. The renderer stores the
 * key and hands it over after connecting; the daemon keeps it only in memory and passes it to
 * Arena through the child's stdin, never an environment variable or file.
 */
export interface ArenaByokService {
  isConfigured(): boolean;
  /** Installs, replaces, or with `null` clears the key, restarting Arena when it changes. */
  setKey(key: string | null): Promise<void>;
}

export interface CreateArenaByokServiceOptions {
  readonly restartArena?: () => Promise<void>;
  readonly providerSnapshots?: Pick<ProviderSnapshotManager, "refreshSettingsSnapshot">;
}

function heldKey(): string | null {
  const credentials = readArenaCredentials()?.credentials;
  return credentials?.mode === "byok" ? credentials.openRouterApiKey : null;
}

export function createArenaByokService(
  options: CreateArenaByokServiceOptions = {},
): ArenaByokService {
  const restartArena = options.restartArena ?? (() => OpenCodeServerManager.restartInstance());
  let transition = Promise.resolve();

  return {
    isConfigured: () => heldKey() !== null,
    setKey(key) {
      async function apply(): Promise<void> {
        // A reconnecting client hands over the key it already gave; that must not interrupt battles.
        if (key === heldKey()) return;
        if (key === null) clearArenaCredentials();
        else installArenaCredentials({ mode: "byok", openRouterApiKey: key });
        await restartArena();
        // The app runs before it has a key, so opening a project can cache the opencode provider
        // as failed. Drop that for every project now; the reload starts Arena, so it runs in the
        // background rather than holding up the save.
        void options.providerSnapshots?.refreshSettingsSnapshot({ providers: ["opencode"] });
      }
      const next = transition.then(apply);
      transition = next.catch(() => undefined);
      return next;
    },
  };
}
