import type { Logger } from "pino";
import type { AccountsConfig } from "./config.js";
import { AccountsBackend } from "./backend.js";
import { SessionResolver } from "./session.js";
import { resolveSessionPublicKey, verifySessionToken } from "./token.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import {
  clearArenaCredentials,
  installArenaCredentials,
  replaceArenaCredentialsToken,
} from "./credentials.js";

/** Enough for the desktop app, the browser QA harness, and a re-signed-in client. */
const REMEMBERED_SESSIONS = 4;

interface ActiveAccount {
  readonly userId: string;
  /** Verified and not forgotten, oldest first. The last one is forwarded to Arena. */
  readonly tokens: readonly string[];
}

export interface AccountsService {
  readonly config: AccountsConfig;
  readonly backend: AccountsBackend;
  readonly sessions: SessionResolver;
  readonly logger: Logger;
  availableMethods(): ReturnType<AccountsBackend["methods"]>;
  close(): Promise<void>;
}

export interface CreateAccountsServiceOptions {
  readonly config: AccountsConfig;
  readonly logger: Logger;
  readonly backend?: AccountsBackend;
  readonly shutdownArena?: () => Promise<void>;
}

/**
 * Synchronous by design. The store lives in the Arena backend and is acquired
 * on first use, so a daemon starts and serves sign-in as soon as that backend
 * is up rather than blocking its own boot on it.
 */
export function createAccountsService(options: CreateAccountsServiceOptions): AccountsService {
  const backend =
    options.backend ?? new AccountsBackend(options.config.controlPlaneUrl, options.logger);
  const publicKey = resolveSessionPublicKey({
    PASEO_SESSION_PUBLIC_KEY: options.config.sessionPublicKey,
  });
  // Electron and the browser QA harness hold different sessions for one account. Arena restarts
  // only when the account changes, so a client switching sessions does not interrupt battles.
  let account: ActiveAccount | null = null;
  // A signed-out session is revoked at the control plane, but it still verifies here until it
  // expires, and another tab or window can still hold it. Forwarded again, it would fail every
  // Arena call. Kept until expiry, which bounds it.
  const signedOut = new Set<string>();
  let credentialTransition = Promise.resolve();
  const shutdownArena = options.shutdownArena ?? (() => OpenCodeServerManager.restartInstance());
  function transitionCredentials(action: () => Promise<void>): Promise<void> {
    const next = credentialTransition.then(action, action);
    credentialTransition = next.catch(() => undefined);
    return next;
  }
  const sessions = new SessionResolver(publicKey, {
    async onAuthenticated(token, user) {
      await transitionCredentials(async () => {
        if (signedOut.has(token)) return;
        if (account?.userId === user.id) {
          if (account.tokens.at(-1) === token) return;
          const others = account.tokens.filter((candidate) => candidate !== token);
          account = { userId: user.id, tokens: [...others, token].slice(-REMEMBERED_SESSIONS) };
          replaceArenaCredentialsToken(token);
          return;
        }
        account = { userId: user.id, tokens: [token] };
        installArenaCredentials({
          mode: "hosted",
          token,
          controlPlaneUrl: options.config.controlPlaneUrl,
        });
        await shutdownArena();
      });
    },
    async onForget(token) {
      await transitionCredentials(async () => {
        for (const candidate of signedOut) {
          if (verifySessionToken(candidate, publicKey) === null) signedOut.delete(candidate);
        }
        signedOut.add(token);
        if (!account?.tokens.includes(token)) return;
        const isActive = account.tokens.at(-1) === token;
        const remaining = account.tokens.filter((candidate) => candidate !== token);
        if (!isActive) {
          account = { userId: account.userId, tokens: remaining };
          return;
        }
        // A remembered session can expire while another one is active.
        const fallback = remaining.findLastIndex(
          (candidate) => verifySessionToken(candidate, publicKey) !== null,
        );
        if (fallback >= 0) {
          account = { userId: account.userId, tokens: remaining.slice(0, fallback + 1) };
          replaceArenaCredentialsToken(remaining[fallback]);
          return;
        }
        account = null;
        clearArenaCredentials();
        await shutdownArena();
      });
    },
  });

  return {
    config: options.config,
    backend,
    sessions,
    logger: options.logger,
    availableMethods: () => backend.methods(),
    close: () => backend.close(),
  };
}
