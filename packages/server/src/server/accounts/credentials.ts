import { randomBytes, timingSafeEqual } from "node:crypto";

/** A signed-in account's session, forwarded to the control plane through the daemon. */
export interface HostedArenaCredentials {
  readonly mode: "hosted";
  readonly token: string;
  readonly controlPlaneUrl: string;
}

/** The user's own OpenRouter key, in a build without a control plane. */
export interface ByokArenaCredentials {
  readonly mode: "byok";
  readonly openRouterApiKey: string;
}

export type ArenaCredentials = HostedArenaCredentials | ByokArenaCredentials;

export interface ArenaCredentialsSnapshot {
  readonly credentials: ArenaCredentials;
  readonly version: number;
}

let current: ArenaCredentials | null = null;
let version = 0;
const runtimeCredentials = new Map<string, number>();
/** The forwarded account session the control plane refused; see `rejectArenaSession`. */
let rejectedToken: string | null = null;
const rejectionListeners = new Set<(token: string) => void>();
/** Asks the control plane whether a session is still live; installed by the accounts service. */
let sessionVerifier: ((token: string) => Promise<ArenaSessionVerdict>) | null = null;
const pendingVerifications = new Map<string, Promise<ArenaSessionVerdict>>();
/** A session check that got no answer; the next check of that token waits until `retryAt`. */
let failedVerification: { token: string; retryAt: number; delayMs: number } | null = null;
const FIRST_CHECK_RETRY_MS = 2_000;
const MAX_CHECK_RETRY_MS = 60_000;
/** Arena requests answered as a refused session; see `arenaSessionRefusals`. */
let refusals = 0;

export type ArenaSessionVerdict = "rejected" | "accepted" | "unknown";

interface CredentialsHandover {
  readonly arrived: Promise<void>;
  readonly end: () => void;
  /** Clients that may still hand credentials over. */
  readonly clients: Set<object>;
  timer?: ReturnType<typeof setTimeout>;
}

let handover: CredentialsHandover | null = null;

export function installArenaCredentials(credentials: ArenaCredentials): void {
  current = credentials;
  version += 1;
  rejectedToken = null;
  failedVerification = null;
  runtimeCredentials.clear();
  endArenaCredentialsHandover();
}

/**
 * Holds Arena starts that find no credentials until they are installed or cleared, or until every
 * expected client reports it has none. `timeoutMs` bounds the wait for a client that never answers;
 * another call restarts it.
 */
export function expectArenaCredentials(client: object, timeoutMs: number): void {
  if (current) return;
  handover ??= startArenaCredentialsHandover();
  handover.clients.add(client);
  clearTimeout(handover.timer);
  handover.timer = setTimeout(endArenaCredentialsHandover, timeoutMs);
  handover.timer.unref?.();
}

/** `client` has no credentials to hand over, so starts stop waiting for it. */
export function expectNoArenaCredentials(client: object): void {
  if (!handover) return;
  handover.clients.delete(client);
  if (handover.clients.size === 0) endArenaCredentialsHandover();
}

/** Settles when a pending handover ends, or is `null` when none is pending. */
export function pendingArenaCredentialsHandover(): Promise<void> | null {
  return handover?.arrived ?? null;
}

function startArenaCredentialsHandover(): CredentialsHandover {
  let end = () => {};
  const arrived = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { arrived, end, clients: new Set() };
}

function endArenaCredentialsHandover(): void {
  if (!handover) return;
  clearTimeout(handover.timer);
  handover.end();
  handover = null;
}

/**
 * Forwards another session of the installed account. The version and issued runtime capabilities
 * stay valid, so the running Arena child picks up the new session without a restart.
 */
export function replaceArenaCredentialsToken(token: string): void {
  if (current?.mode !== "hosted") throw new Error("Arena account credentials are not installed");
  current = { ...current, token };
}

export function clearArenaCredentials(): void {
  current = null;
  version += 1;
  rejectedToken = null;
  failedVerification = null;
  runtimeCredentials.clear();
  endArenaCredentialsHandover();
}

export function readArenaCredentials(): ArenaCredentialsSnapshot | null {
  if (!current) return null;
  return { credentials: current, version };
}

/**
 * What one Arena launch receives on its stdin. A hosted launch gets a revocable loopback
 * capability for the daemon's runtime proxy instead of the account session, so it needs the
 * daemon's TCP origin. A BYOK launch calls OpenRouter itself and gets the key.
 */
export function issueArenaLaunchCredentials(
  daemonBaseUrl: string | null,
): ArenaCredentialsSnapshot | null {
  if (!current) return null;
  if (current.mode === "byok") return { credentials: current, version };
  if (!daemonBaseUrl) return null;
  const token = randomBytes(32).toString("base64url");
  runtimeCredentials.set(token, version);
  return {
    credentials: {
      mode: "hosted",
      token,
      controlPlaneUrl: `${daemonBaseUrl.replace(/\/$/, "")}/api/arena-runtime`,
    },
    version,
  };
}

/**
 * The control plane refused the forwarded account session. The token still verifies locally until
 * its own expiry, so only the control plane can say it was revoked or expired there. Holds until
 * another session replaces the forwarded one, or the control plane accepts this one again.
 */
export function rejectArenaSession(token: string): void {
  if (current?.mode !== "hosted" || current.token !== token || rejectedToken === token) return;
  rejectedToken = token;
  for (const listener of rejectionListeners) listener(token);
}

/** The control plane accepted this session, so an earlier refusal of it no longer holds. */
export function acceptArenaSession(token: string): void {
  if (rejectedToken === token) rejectedToken = null;
}

export function setArenaSessionVerifier(
  verifier: ((token: string) => Promise<ArenaSessionVerdict>) | null,
): void {
  sessionVerifier = verifier;
}

/** A session check's outcome for a forwarded 401; "replaced" means a newer session took over. */
export type ArenaUnauthorizedVerdict = ArenaSessionVerdict | "replaced";

function isCurrentHostedToken(token: string): boolean {
  return current?.mode === "hosted" && current.token === token;
}

/**
 * A forwarded request came back 401. The control plane passes an upstream model's 401 through
 * unchanged, so a 401 alone does not mean the session is gone: ask the control plane's session
 * route, and reject the session only when that refuses it too. Concurrent checks of one token
 * share one request. A check that gets no answer is "unknown" and is not repeated for that token
 * until a backoff (2 s, doubling to 60 s) passes; it never rejects the session. A token that a
 * newer session replaced, before or during the check, is "replaced": the request can go again
 * with the new one.
 */
export async function confirmArenaSessionRejection(
  token: string,
): Promise<ArenaUnauthorizedVerdict> {
  if (current?.mode === "hosted" && current.token !== token) return "replaced";
  if (isArenaSessionRejected() && isCurrentHostedToken(token)) return "rejected";
  const verdict = await checkArenaSession(token);
  if (verdict !== "accepted" && current?.mode === "hosted" && current.token !== token) {
    return "replaced";
  }
  return verdict;
}

function checkArenaSession(token: string): Promise<ArenaSessionVerdict> {
  const pending = pendingVerifications.get(token);
  if (pending) return pending;
  const verify = sessionVerifier;
  if (!verify) return Promise.resolve("unknown");
  if (failedVerification?.token === token && Date.now() < failedVerification.retryAt) {
    return Promise.resolve("unknown");
  }
  const check = verify(token)
    .catch((): ArenaSessionVerdict => "unknown")
    .then((verdict): ArenaSessionVerdict => {
      if (verdict === "unknown") {
        const delayMs =
          failedVerification?.token === token
            ? Math.min(failedVerification.delayMs * 2, MAX_CHECK_RETRY_MS)
            : FIRST_CHECK_RETRY_MS;
        failedVerification = { token, retryAt: Date.now() + delayMs, delayMs };
        return "unknown";
      }
      if (failedVerification?.token === token) failedVerification = null;
      if (verdict === "rejected") rejectArenaSession(token);
      return verdict;
    })
    .finally(() => pendingVerifications.delete(token));
  pendingVerifications.set(token, check);
  return check;
}

/** Counts an Arena request answered as a refused session. */
export function noteArenaSessionRefusal(): void {
  refusals += 1;
}

/**
 * How many Arena requests have been answered as a refused session. A failure is that refusal only
 * when this moved while it ran.
 */
export function arenaSessionRefusals(): number {
  return refusals;
}

/** Whether the control plane refuses the forwarded account session, so Arena work needs sign-in. */
export function isArenaSessionRejected(): boolean {
  return current?.mode === "hosted" && current.token === rejectedToken;
}

export function onArenaSessionRejected(listener: (token: string) => void): () => void {
  rejectionListeners.add(listener);
  return () => {
    rejectionListeners.delete(listener);
  };
}

export function revokeArenaRuntimeCredentials(token: string): void {
  runtimeCredentials.delete(token);
}

export function resolveArenaRuntimeCredentials(token: string): HostedArenaCredentials | null {
  if (current?.mode !== "hosted") return null;
  for (const [candidate, credentialVersion] of runtimeCredentials) {
    const left = Buffer.from(candidate);
    const right = Buffer.from(token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) continue;
    return credentialVersion === version ? current : null;
  }
  return null;
}

export function isArenaCredentialsCurrent(snapshot: ArenaCredentialsSnapshot): boolean {
  if (snapshot.version !== version) return false;
  if (snapshot.credentials.mode === "byok") return true;
  return runtimeCredentials.get(snapshot.credentials.token) === snapshot.version;
}
