import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import { fetchCheckoutStatus } from "./checkout-status-cache";

export type { CheckoutStatusPayload } from "./checkout-status-cache";

export const CHECKOUT_STATUS_STALE_TIME = 15_000;

interface UseCheckoutStatusQueryOptions {
  serverId: string;
  cwd: string;
  followCheckout?: boolean;
}

export function useCheckoutStatusQuery({
  serverId,
  cwd,
  followCheckout = false,
}: UseCheckoutStatusQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await fetchCheckoutStatus({ client, serverId, cwd, refreshGit: followCheckout });
    },
    enabled: !!client && isConnected && !!cwd,
    staleTime: Infinity,
    // Freshness is push-driven (checkout_status_update applied globally); with
    // staleTime: Infinity, refetchOnMount only fires after an explicit invalidation
    // (e.g. reconnect), which is exactly when the push stream may have been missed.
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: followCheckout ? 2_000 : false,
  });

  const { refetch } = query;
  useEffect(() => {
    // A project without workspaces has no daemon observer yet. Read local Git on
    // entry/resume as well as on the interval; keep this off the foreground refresh key.
    if (followCheckout && client && isConnected && cwd) void refetch();
  }, [followCheckout, client, isConnected, serverId, cwd, refetch]);

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}

/**
 * Subscribe to checkout status updates from the React Query cache without
 * initiating a fetch. Useful for list rows where a parent component prefetches
 * only the visible agents.
 */
export function useCheckoutStatusCacheOnly({ serverId, cwd }: UseCheckoutStatusQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);

  return useQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await fetchCheckoutStatus({ client, serverId, cwd });
    },
    enabled: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
  });
}
