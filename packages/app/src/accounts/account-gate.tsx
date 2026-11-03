import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import {
  hasAcceptedLegalDocuments,
  legalAcceptanceSchema,
  type AuthMethodsResponse,
  type LegalDocuments,
} from "@getpaseo/protocol/accounts/schemas";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  currentSessionQueryKey,
  fetchAuthMethods,
  fetchCurrentSession,
  type AccountsEndpoint,
} from "./client";
import { useAccountsEndpoint } from "./endpoint";
import { resolveAccountGate, type QueryPhase, type AccountGate as AccountGateState } from "./gate";
import { AccountGateKindContext } from "./gate-context";
import {
  useAccountSessionHydrated,
  useAccountSessionStore,
  type AccountSession,
} from "./session-store";
import { SignInScreen } from "./sign-in-screen";
import { useSignInPromptStore } from "./sign-in-prompt";
import { DaemonUnreachable } from "./daemon-unreachable";
import { TermsAcceptanceModal } from "./terms-acceptance-modal";
import { UpdateRequired } from "./update-required";
import { WelcomeModal } from "./welcome-modal";

const STALE_TIME_MS = 5 * 60 * 1000;

function phaseOf(status: "pending" | "success" | "error"): QueryPhase {
  return status;
}

function methodsGateInput(methods: AuthMethodsResponse | undefined) {
  return {
    updateRequired: methods?.updateRequired ?? false,
    accountsEnabled: methods?.enabled ?? false,
    methods: methods?.methods ?? [],
    anonymousAllowed: methods?.anonymous ?? false,
  };
}

function requireEndpoint(endpoint: AccountsEndpoint | null): AccountsEndpoint {
  if (!endpoint) {
    throw new Error("No daemon endpoint for accounts");
  }
  return endpoint;
}

/**
 * Renders the welcome modal or the sign-in screen in place of the app until a session, anonymous
 * or signed in, is established. This is presentation only — the daemon refuses unauthenticated
 * WebSocket and API traffic on its own, so a gate that fails open never exposes
 * anything.
 */
export function AccountGate({ children }: { children: ReactNode }): ReactNode {
  const endpoint = useAccountsEndpoint();
  const hydrated = useAccountSessionHydrated();
  const session = useAccountSessionStore((store) => store.session);
  const clearSession = useAccountSessionStore((store) => store.clearSession);
  const updateUser = useAccountSessionStore((store) => store.updateUser);
  const prompt = useSignInPromptStore((store) => store.prompt);
  const dismissPrompt = useSignInPromptStore((store) => store.dismiss);

  const methodsQuery = useFetchQuery({
    queryKey: ["accounts", "methods", endpoint?.baseUrl ?? null],
    dataShape: "value",
    enabled: endpoint !== null,
    staleTimeMs: STALE_TIME_MS,
    queryFn: () => fetchAuthMethods(requireEndpoint(endpoint)),
  });

  const sessionToken = session?.token ?? null;
  const sessionQuery = useFetchQuery({
    queryKey: currentSessionQueryKey(endpoint?.baseUrl ?? null, sessionToken),
    dataShape: "value",
    enabled: endpoint !== null && sessionToken !== null,
    staleTimeMs: STALE_TIME_MS,
    queryFn: () => fetchCurrentSession(requireEndpoint(endpoint), sessionToken ?? ""),
  });

  const resolvedSession = sessionQuery.data;
  const documents = methodsQuery.data?.legal;
  const accountUser = resolvedSession?.user ?? session?.user;
  const accepted = documents
    ? hasAcceptedLegalDocuments(accountUser?.legalAcceptance, documents)
    : legalAcceptanceSchema.safeParse(accountUser?.legalAcceptance).success;
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

  // An anonymous session that has used its messages may still finish what it sent, so this only
  // marks the next send for sign-in; the sidebar says so in the meantime.
  useEffect(() => {
    if (!resolvedSession) return;
    useSignInPromptStore
      .getState()
      .setMessagesUsed(
        resolvedSession.method === "anonymous" && resolvedSession.signInRequired === true,
      );
  }, [resolvedSession]);

  // Every connection made while signed out is refused, so the host never comes online and there
  // is no client to reconnect — the probe closes the one it opened. All three of these are
  // needed the moment an account exists: the bootstrap registers a host that was never
  // registered, the forced probe brings one online past a cooldown that has settled at 30s
  // while it was being refused, and ensureConnectedAll wakes a client that did connect once and
  // is now sitting out its own backoff.
  useEffect(() => {
    if (!sessionToken || !accepted) {
      return;
    }
    const store = getHostRuntimeStore();
    void store.bootstrapConfiguredConnection();
    store.ensureConnectedAll();
    void store.runProbeCycleNow(undefined, { force: true });
  }, [sessionToken, accepted]);

  const retryMethods = useCallback(() => {
    void methodsQuery.refetch();
  }, [methodsQuery]);

  const gate = resolveAccountGate({
    hasEndpoint: endpoint !== null,
    storeHydrated: hydrated,
    methodsPhase: phaseOf(methodsQuery.status),
    ...methodsGateInput(methodsQuery.data),
    hasStoredSession: sessionToken !== null,
    signInPrompt: session?.method === "anonymous" ? prompt : null,
    sessionPhase: phaseOf(sessionQuery.status),
    sessionIsValid: resolvedSession != null,
    legalDocumentsAvailable: documents != null,
    hasAcceptedLegalDocuments: accepted,
  });

  return (
    <AccountGateContent
      gate={gate}
      endpoint={endpoint}
      session={session}
      documents={documents}
      onRetry={retryMethods}
      onDismissPrompt={dismissPrompt}
    >
      {children}
    </AccountGateContent>
  );
}

interface AccountGateContentProps {
  gate: AccountGateState;
  endpoint: AccountsEndpoint | null;
  session: AccountSession | null;
  documents: LegalDocuments | null | undefined;
  onRetry: () => void;
  onDismissPrompt: () => void;
  children: ReactNode;
}

const checkingStyle: ViewStyle = { flex: 1, alignItems: "center", justifyContent: "center" };
const overlayStyle: ViewStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 1000,
};

function AccountGateContent({
  gate,
  endpoint,
  session,
  documents,
  onRetry,
  onDismissPrompt,
  children,
}: AccountGateContentProps) {
  const [signInFromWelcome, setSignInFromWelcome] = useState(false);
  const showSignInFromWelcome = useCallback(() => setSignInFromWelcome(true), []);
  const backToWelcome = useCallback(() => setSignInFromWelcome(false), []);
  const app = (
    <AccountGateKindContext.Provider value={gate.kind}>{children}</AccountGateKindContext.Provider>
  );
  if (!endpoint) {
    return app;
  }
  if (gate.kind === "welcome" && documents) {
    return signInFromWelcome ? (
      <SignInScreen
        key={`${documents.termsVersion}:${documents.privacyPolicyVersion}`}
        endpoint={endpoint}
        methods={gate.methods}
        documents={documents}
        onBack={backToWelcome}
      />
    ) : (
      <WelcomeModal
        key={`${documents.termsVersion}:${documents.privacyPolicyVersion}`}
        endpoint={endpoint}
        documents={documents}
        onSignIn={showSignInFromWelcome}
      />
    );
  }
  if (gate.kind === "signed-out" && documents) {
    return (
      <SignInScreen
        key={`${documents.termsVersion}:${documents.privacyPolicyVersion}`}
        endpoint={endpoint}
        methods={gate.methods}
        documents={documents}
      />
    );
  }
  if (gate.kind === "update-required") {
    return <UpdateRequired />;
  }
  if (gate.kind === "unreachable") {
    return <DaemonUnreachable endpoint={endpoint.baseUrl} onRetry={onRetry} />;
  }
  if (gate.kind === "checking") {
    return (
      <View style={checkingStyle}>
        <ActivityIndicator accessibilityLabel="Checking your account" />
      </View>
    );
  }
  if (gate.kind === "acceptance-required" && session && documents) {
    return (
      <TermsAcceptanceModal
        key={`${session.user.id}:${documents.termsVersion}:${documents.privacyPolicyVersion}`}
        endpoint={endpoint}
        session={session}
        documents={documents}
      />
    );
  }

  // An anonymous session signs in over the app rather than in place of it, so the chat, its route
  // and the draft that asked for an account are still there once it has. The app's position in the
  // tree is the same either way, so showing the screen does not remount it.
  return (
    <>
      {app}
      {gate.kind === "upgrade" && documents ? (
        <View style={overlayStyle}>
          <SignInScreen
            key={`upgrade:${documents.termsVersion}:${documents.privacyPolicyVersion}`}
            endpoint={endpoint}
            methods={gate.methods}
            documents={documents}
            variant={gate.prompt}
            onBack={onDismissPrompt}
          />
        </View>
      ) : null}
    </>
  );
}
