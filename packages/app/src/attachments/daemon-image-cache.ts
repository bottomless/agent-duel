/**
 * Images a page names instead of carrying (a chat's history, a battle's pasted photos) load from the
 * daemon as they are shown, and a long chat or a turn of photo follow-ups shows dozens at once.
 * Loaded together, their bytes reached the window's socket in one burst, as the inline pages they
 * replaced did, so a few load at a time, the latest asked first: a user who scrolls is looking at
 * those. A load that fails is asked again for about a minute, long enough for the daemon connection
 * to come back, and the latest images are kept up to a byte budget.
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

async function withRetries<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inTurn(load);
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (error instanceof MissingImageError || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Data URLs by key, loaded through `load` and kept, newest last, up to `budget` characters. */
export class DaemonImageCache {
  private readonly entries = new Map<string, Promise<string>>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly load: (key: string) => Promise<string>,
    private readonly budget: number,
  ) {}

  resolve(key: string): Promise<string> {
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

  clear(): void {
    this.entries.clear();
    this.sizes.clear();
    this.bytes = 0;
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
      if (size === undefined) continue;
      this.entries.delete(key);
      this.sizes.delete(key);
      this.bytes -= size;
    }
  }
}
