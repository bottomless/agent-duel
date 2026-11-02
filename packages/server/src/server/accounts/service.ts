import type { Logger } from "pino";
import type { AccountsConfig } from "./config.js";
import { AccountsBackend, AccountsRequestError } from "./backend.js";
import { SessionResolver } from "./session.js";
import { resolveSessionPublicKey, verifySessionToken } from "./token.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import {
  acceptArenaSession,
  clearArenaCredentials,
  installArenaCredentials,
  onArenaSessionRejected,
  rejectArenaSession,
  replaceArenaCredentialsToken,
  setArenaSessionVerifier,
  type ArenaSessionVerdict,
} from "./credentials.js";

const SESSION_CHECK_TIMEOUT_MS = 10_000;

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
  /** The control plane's session route answered for this token: forward it again, or stop. */
  sessionChecked(token: string, accepted: boolean): Promise<void>;
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
  // Sessions the control plane refused. Not forwarded again unless its session route accepts one.
  const rejected = new Set<string>();
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
        if (signedOut.has(token) || rejected.has(token)) return;
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

  // The control plane refused the forwarded session: stop forwarding it. Without another usable
  // session the credentials stay, marked rejected, rather than restarting Arena: a sign-in of the
  // same account then replaces the token in place, and a contestant waiting on it continues.
  const stopRejectedSessions = onArenaSessionRejected((token) => {
    options.logger.warn("The control plane rejected the account session; sign-in is required");
    void transitionCredentials(async () => {
      for (const candidate of rejected) {
        if (verifySessionToken(candidate, publicKey) === null) rejected.delete(candidate);
      }
      rejected.add(token);
      if (!account?.tokens.includes(token)) return;
      const isActive = account.tokens.at(-1) === token;
      const remaining = account.tokens.filter((candidate) => candidate !== token);
      if (!isActive) {
        account = { userId: account.userId, tokens: remaining };
        return;
      }
      // A fallback can be refused too: two sessions of the account revoked together, or an older
      // one that expired while the session route was down. Ask the control plane before forwarding
      // one, newest first; without an answer, none is used and the rejection stands until a
      // sign-in or a recheck.
      let fallback: string | null = null;
      for (const candidate of remaining.toReversed()) {
        if (verifySessionToken(candidate, publicKey) === null) continue;
        const verdict = await verifySession(candidate);
        if (verdict === "accepted") fallback = candidate;
        else if (verdict === "rejected") rejected.add(candidate);
        if (verdict !== "rejected") break;
      }
      const usable = fallback ? remaining.slice(0, remaining.indexOf(fallback) + 1) : [];
      account = {
        userId: account.userId,
        tokens: usable.filter((candidate) => !rejected.has(candidate)),
      };
      if (fallback) replaceArenaCredentialsToken(fallback);
    });
  });

  // Bounded: a contestant request and the credential queue wait on it.
  async function verifySession(token: string): Promise<ArenaSessionVerdict> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ArenaSessionVerdict>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), SESSION_CHECK_TIMEOUT_MS);
    });
    const checked = backend.currentSession(token).then(
      (): ArenaSessionVerdict => "accepted",
      (error: unknown): ArenaSessionVerdict =>
        error instanceof AccountsRequestError && error.status === 401 ? "rejected" : "unknown",
    );
    try {
      return await Promise.race([checked, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
  setArenaSessionVerifier(verifySession);

  async function sessionChecked(token: string, accepted: boolean): Promise<void> {
    if (!accepted) {
      rejectArenaSession(token);
      return;
    }
    acceptArenaSession(token);
    if (!rejected.delete(token)) return;
    // Forward it again, as when it was first presented.
    await sessions.resolve(token);
  }

  return {
    config: options.config,
    backend,
    sessions,
    logger: options.logger,
    availableMethods: () => backend.methods(),
    sessionChecked,
    close: () => {
      stopRejectedSessions();
      setArenaSessionVerifier(null);
      return backend.close();
    },
  };
}
