import type { QueryClient } from "@tanstack/react-query";
import type { CheckoutStatusResponse, CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal/es6";
import {
  checkoutCommitsQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusRefreshQueryKey,
  checkoutStatusQueryKey,
  invalidatePrPaneTimelineForCheckout,
} from "@/git/query-keys";
import { type CheckoutPrStatusPayload, normalizeCheckoutPrStatusPayload } from "@/git/pr-status";
import { resetDraftAgentCommandsForCheckout } from "@/hooks/agent-commands-query";

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
export type { CheckoutPrStatusPayload } from "@/git/pr-status";

export interface CheckoutStatusClient {
  getCheckoutStatus: (
    cwd: string,
    options?: { refreshGit?: boolean },
  ) => Promise<CheckoutStatusPayload>;
}

export async function fetchCheckoutStatus({
  client,
  cwd,
  refreshGit = false,
}: {
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
  refreshGit?: boolean;
}): Promise<CheckoutStatusPayload> {
  const payload = await client.getCheckoutStatus(cwd, { refreshGit });
  return payload;
}

export async function ensureCheckoutStatus({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  return await queryClient.fetchQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd),
    queryFn: () => fetchCheckoutStatus({ client, serverId, cwd }),
    staleTime: Infinity,
  });
}

/**
 * The checkout as git has it now, rather than as the push stream last described it.
 *
 * `ensureCheckoutStatus` trusts the cache forever because freshness is push-driven — but the
 * daemon pushes `checkout_status_update` only for a cwd some workspace has registered with the
 * git observer, so a project with no chats in it yet never receives one and its cached branch
 * can be arbitrarily old. Anything about to run git off the answer fetches instead of trusting;
 * the result is written to the same key, so mounted readers pick it up too.
 */
export async function refreshCheckoutStatus({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  const queryKey = checkoutStatusQueryKey(serverId, cwd);
  const inFlightRead = queryClient.getQueryCache().find({ queryKey, exact: true })?.promise;
  const payload = await queryClient.fetchQuery({
    queryKey: checkoutStatusRefreshQueryKey(serverId, cwd),
    queryFn: async () => {
      if (inFlightRead) {
        await inFlightRead.catch(() => undefined);
      }
      return await fetchCheckoutStatus({ client, serverId, cwd, refreshGit: true });
    },
    staleTime: 0,
    gcTime: 0,
  });
  queryClient.setQueryData(queryKey, payload);
  return payload;
}

export function applyCheckoutStatusUpdateFromEvent({
  queryClient,
  serverId,
  message,
}: {
  queryClient: QueryClient;
  serverId: string;
  message: CheckoutStatusUpdate;
}): void {
  const { payload } = message;
  const prStatus = payload.prStatus
    ? normalizeCheckoutPrStatusPayload(payload.prStatus)
    : undefined;
  const cachePayload = prStatus ? { ...payload, prStatus } : payload;
  const previousStatus = queryClient.getQueryData<CheckoutStatusPayload>(
    checkoutStatusQueryKey(serverId, payload.cwd),
  );
  queryClient.setQueryData(checkoutStatusQueryKey(serverId, payload.cwd), cachePayload);
  if (previousStatus?.currentBranch !== payload.currentBranch) {
    void resetDraftAgentCommandsForCheckout(queryClient, { serverId, cwd: payload.cwd });
  }
  void queryClient.invalidateQueries({
    queryKey: checkoutCommitsQueryKey(serverId, payload.cwd),
  });

  if (!prStatus) {
    return;
  }

  const previous = queryClient.getQueryData<CheckoutPrStatusPayload>(
    checkoutPrStatusQueryKey(serverId, prStatus.cwd),
  );
  queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, prStatus.cwd), prStatus);

  // The PR activity timeline has no push channel; mark it stale when the pushed PR status
  // meaningfully changed. Active panes refetch immediately, evicted ones on next mount.
  if (hasPrStatusChanged(previous, prStatus)) {
    void invalidatePrPaneTimelineForCheckout(queryClient, { serverId, cwd: prStatus.cwd });
  }
}

// requestId changes on every emission and carries no PR state.
function prStatusWithoutVolatileFields(
  prStatus: CheckoutPrStatusPayload,
): Omit<CheckoutPrStatusPayload, "requestId"> {
  const { requestId: _requestId, ...rest } = prStatus;
  return rest;
}

function hasPrStatusChanged(
  previous: CheckoutPrStatusPayload | undefined,
  next: CheckoutPrStatusPayload,
): boolean {
  if (!previous) {
    return true;
  }
  return !equal(prStatusWithoutVolatileFields(previous), prStatusWithoutVolatileFields(next));
}
