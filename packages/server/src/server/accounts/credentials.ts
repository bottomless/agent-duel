import { randomBytes, timingSafeEqual } from "node:crypto";

/** A signed-in account's session, forwarded to the control plane through the daemon. */
export interface HostedArenaCredentials {
  readonly mode: "hosted";
  readonly token: string;
  readonly controlPlaneUrl: string;
  readonly researchPartition: string;
  readonly researchAccountID: string;
  /** Anonymous accounts merged into this one at sign-in; the engine moves their local records over. */
  readonly adoptAccounts: readonly {
    readonly accountID: string;
    readonly researchPartition: string;
  }[];
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
      researchPartition: current.researchPartition,
      researchAccountID: current.researchAccountID,
      adoptAccounts: current.adoptAccounts,
      token,
      controlPlaneUrl: `${daemonBaseUrl.replace(/\/$/, "")}/api/arena-runtime`,
    },
    version,
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
