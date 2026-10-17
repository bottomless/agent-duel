/**
 * Images a page names instead of carrying (a chat's history, a battle's pasted photos) load from the
 * daemon as they are shown, and a long chat or a turn of photo follow-ups shows dozens at once.
 * Loaded together, their bytes reached the window's socket in one burst, as the inline pages they
 * replaced did, so a few load at a time, the latest asked first: a user who scrolls is looking at
 * those. A load that fails is asked again for about a minute, and once more whenever the daemon
 * connection comes back (`watchDaemonConnection`). Images on screen stay; the latest of the rest are
 * kept up to a byte budget.
 */

/** The daemon answered and the image is not there; asking again cannot help. */
export class MissingImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingImageError";
  }
}

const MAX_LOADS = 4;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
let active = 0;
const waiting: Array<() => void> = [];

async function inTurn<T>(load: () => Promise<T>): Promise<T> {
  if (active >= MAX_LOADS) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await load();
  } finally {
    active -= 1;
    waiting.pop()?.();
  }
}

// Each image waiting out a retry, to wake when a daemon is reachable again.
const sleepers = new Set<() => void>();

/** Waits `ms`; true when a reconnect cut the wait short. */
async function pause(ms: number): Promise<boolean> {
  let onReconnect = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const woken = await Promise.race([
    new Promise<boolean>((resolve) => {
      onReconnect = () => resolve(true);
      sleepers.add(onReconnect);
    }),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  sleepers.delete(onReconnect);
  return woken;
}

async function withRetries<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inTurn(load);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (error instanceof MissingImageError || delay === undefined) throw error;
      // Woken by a reconnect, the image is asked at once and gets a fresh round of retries.
      if (await pause(delay)) attempt = -1;
    }
  }
}

interface DaemonConnection {
  isConnected: boolean;
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
}

const retryListeners = new Set<() => void>();
const watchedClients = new WeakSet<object>();

/** Calls `listener` whenever a daemon is reachable again, so a failed image can be asked again. */
export function onDaemonReconnect(listener: () => void): () => void {
  retryListeners.add(listener);
  return () => {
    retryListeners.delete(listener);
  };
}

function daemonReachable(): void {
  for (const wake of sleepers) wake();
  for (const listener of retryListeners) listener();
}

/**
 * Counts a daemon as reachable again each time `client` connects after a drop. A client that takes
 * over a session from another one counts as coming back once it is connected.
 */
export function watchDaemonConnection(client: DaemonConnection, replacing = false): void {
  // A stand-in client (a test's, or one torn down) may not report its connection; skip it.
  if (watchedClients.has(client) || typeof client.subscribeConnectionStatus !== "function") return;
  watchedClients.add(client);
  let connected = replacing ? false : client.isConnected;
  client.subscribeConnectionStatus((state) => {
    const now = state.status === "connected";
    if (now && !connected) daemonReachable();
    connected = now;
  });
}

/** Watches each session's daemon client as `sessions` lists them, and each one that replaces it. */
export function watchDaemonClients(
  sessions: () => Iterable<readonly [string, DaemonConnection | null | undefined]>,
  onChange: (listener: () => void) => void,
): void {
  const current = new Map<string, DaemonConnection>();
  const sync = () => {
    for (const [serverId, client] of sessions()) {
      if (!client || current.get(serverId) === client) continue;
      watchDaemonConnection(client, current.has(serverId));
      current.set(serverId, client);
    }
  };
  sync();
  onChange(sync);
}

/**
 * Data URLs by key, loaded through `load`. An image resolved to be shown stays until it is hidden;
 * the rest are kept, newest last, up to `budget` characters.
 */
export class DaemonImageCache {
  private readonly entries = new Map<string, Promise<string>>();
  private readonly sizes = new Map<string, number>();
  private readonly shown = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly load: (key: string) => Promise<string>,
    private readonly budget: number,
  ) {}

  /**
   * The image as a data URL; `show` keeps it until `hide`, as a thumbnail on screen needs. It is kept
   * from before it loads, so the eviction its own arrival starts cannot take it.
   */
  async resolve(key: string, show = false): Promise<string> {
    if (show) this.shown.set(key, (this.shown.get(key) ?? 0) + 1);
    try {
      return await this.lookup(key);
    } catch (error) {
      if (show) this.hide(key);
      throw error;
    }
  }

  hide(key: string): void {
    const count = (this.shown.get(key) ?? 0) - 1;
    if (count > 0) this.shown.set(key, count);
    else this.shown.delete(key);
    this.evict();
  }

  clear(): void {
    this.entries.clear();
    this.sizes.clear();
    this.shown.clear();
    this.bytes = 0;
  }

  private lookup(key: string): Promise<string> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const pending = withRetries(() => this.load(key));
    this.entries.set(key, pending);
    void this.settle(key, pending);
    return pending;
  }

  /** Counts a loaded image toward the budget, or forgets a failed one so it is asked again. */
  private async settle(key: string, pending: Promise<string>): Promise<void> {
    try {
      const url = await pending;
      if (this.entries.get(key) !== pending) return;
      this.sizes.set(key, url.length);
      this.bytes += url.length;
      this.evict();
    } catch {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    }
  }

  private evict(): void {
    for (const key of this.entries.keys()) {
      if (this.bytes <= this.budget) return;
      const size = this.sizes.get(key);
      if (size === undefined || this.shown.has(key)) continue;
      this.entries.delete(key);
      this.sizes.delete(key);
      this.bytes -= size;
    }
  }
}
