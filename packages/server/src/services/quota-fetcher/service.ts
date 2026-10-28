import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { key: string; fetchedAtMs: number; result: ProviderUsageListResult } | null =
    null;
  private readonly inFlight = new Map<string, Promise<ProviderUsageListResult>>();

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Fetchers read each tool's local credentials and call its vendor, so callers pass the enabled
   * provider ids; only those fetchers run. Omitting `providerIds` runs every fetcher.
   */
  async listUsage(options?: {
    forceRefresh?: boolean;
    providerIds?: readonly string[];
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    const providerIds = options?.providerIds;
    const fetchers = providerIds
      ? this.fetchers.filter((fetcher) => providerIds.includes(fetcher.providerId))
      : this.fetchers;
    const key = fetchers.map((fetcher) => fetcher.providerId).join("\0");
    if (
      !options?.forceRefresh &&
      this.cached?.key === key &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.fetchFreshUsage(fetchers, key, nowMs);
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    }
  }

  private async fetchFreshUsage(
    fetchers: readonly ProviderUsageFetcher[],
    key: string,
    nowMs: number,
  ): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { key, fetchedAtMs: nowMs, result };
    return result;
  }
}
