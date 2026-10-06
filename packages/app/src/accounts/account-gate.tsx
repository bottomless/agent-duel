import { useCallback, useEffect, type ReactNode } from "react";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { fetchAuthMethods, fetchCurrentSession, type AccountsEndpoint } from "./client";
import { useAccountsEndpoint } from "./endpoint";
import { resolveAccountGate, type QueryPhase } from "./gate";
import { AccountGateKindContext } from "./gate-context";
import { useAccountSessionHydrated, useAccountSessionStore } from "./session-store";
import { SignInScreen } from "./sign-in-screen";
import { DaemonUnreachable } from "./daemon-unreachable";

const STALE_TIME_MS = 5 * 60 * 1000;

function phaseOf(status: "pending" | "success" | "error"): QueryPhase {
  return status;
}

function requireEndpoint(endpoint: AccountsEndpoint | null): AccountsEndpoint {
  if (!endpoint) {
    throw new Error("No daemon endpoint for accounts");
  }
  return endpoint;
}

/**
 * Renders the sign-in screen in place of the app until an account is
 * established. This is presentation only — the daemon refuses unauthenticated
 * WebSocket and API traffic on its own, so a gate that fails open never exposes
 * anything.
 */
export function AccountGate({ children }: { children: ReactNode }): ReactNode {
  const endpoint = useAccountsEndpoint();
  const hydrated = useAccountSessionHydrated();
  const session = useAccountSessionStore((store) => store.session);
  const clearSession = useAccountSessionStore((store) => store.clearSession);
  const updateUser = useAccountSessionStore((store) => store.updateUser);

  const methodsQuery = useFetchQuery({
    queryKey: ["accounts", "methods", endpoint?.baseUrl ?? null],
    dataShape: "value",
    enabled: endpoint !== null,
    staleTimeMs: STALE_TIME_MS,
    queryFn: () => fetchAuthMethods(requireEndpoint(endpoint)),
  });

  const sessionToken = session?.token ?? null;
  const sessionQuery = useFetchQuery({
    queryKey: ["accounts", "session", endpoint?.baseUrl ?? null, sessionToken],
    dataShape: "value",
    enabled: endpoint !== null && sessionToken !== null,
    staleTimeMs: STALE_TIME_MS,
    queryFn: () => fetchCurrentSession(requireEndpoint(endpoint), sessionToken ?? ""),
  });

  const resolvedSession = sessionQuery.data;
  useEffect(() => {
    if (resolvedSession === undefined) {
      return;
    }
    if (resolvedSession === null) {
      clearSession();
      return;
    }
    updateUser(resolvedSession.user);
  }, [clearSession, resolvedSession, updateUser]);

  // Every connection made while signed out is refused, so the host never comes online and there
  // is no client to reconnect — the probe closes the one it opened. All three of these are
  // needed the moment an account exists: the bootstrap registers a host that was never
  // registered, the forced probe brings one online past a cooldown that has settled at 30s
  // while it was being refused, and ensureConnectedAll wakes a client that did connect once and
  // is now sitting out its own backoff.
  useEffect(() => {
    if (!sessionToken) {
      return;
    }
    const store = getHostRuntimeStore();
    void store.bootstrapConfiguredConnection();
    store.ensureConnectedAll();
    void store.runProbeCycleNow(undefined, { force: true });
  }, [sessionToken]);

  const retryMethods = useCallback(() => {
    void methodsQuery.refetch();
  }, [methodsQuery]);

  const gate = resolveAccountGate({
    hasEndpoint: endpoint !== null,
    storeHydrated: hydrated,
    methodsPhase: phaseOf(methodsQuery.status),
    accountsEnabled: methodsQuery.data?.enabled ?? false,
    methods: methodsQuery.data?.methods ?? [],
    hasStoredSession: sessionToken !== null,
    sessionPhase: phaseOf(sessionQuery.status),
    sessionIsValid: resolvedSession != null,
  });

  const app = (
    <AccountGateKindContext.Provider value={gate.kind}>{children}</AccountGateKindContext.Provider>
  );
  if (!endpoint) {
    return app;
  }
  if (gate.kind === "signed-out") {
    return <SignInScreen endpoint={endpoint} methods={gate.methods} />;
  }
  if (gate.kind === "unreachable") {
    return <DaemonUnreachable endpoint={endpoint.baseUrl} onRetry={retryMethods} />;
  }

  return app;
}
