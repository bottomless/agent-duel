import { useCallback, useEffect, useReducer } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getDesktopHost } from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";
import { useAccountSessionStore, type AccountSession } from "./session-store";
import type { AcceptTermsRequest } from "@getpaseo/protocol/accounts/schemas";
import {
  buildOAuthStartUrl,
  claimSignInFlow,
  currentSessionQueryKey,
  openSignInFlow,
  sendMagicLink,
  signOut,
  type AccountsEndpoint,
} from "./client";
import {
  initialSignInState,
  pendingFlow,
  signInReducer,
  type OAuthSignInMethod,
  type SignInState,
} from "./sign-in-state";

const CLAIM_POLL_INTERVAL_MS = 2_000;

export interface SignInController {
  state: SignInState;
  startEmail: (email: string) => void;
  startOAuth: (provider: OAuthSignInMethod) => void;
  goBack: () => void;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** The anonymous session a sign-in upgrades, so its battles stay with the account. */
function anonymousSessionToken(): string | null {
  const session = useAccountSessionStore.getState().session;
  return session?.method === "anonymous" ? session.token : null;
}

async function openAppSignInFlow(endpoint: AccountsEndpoint, acceptance: AcceptTermsRequest) {
  // Returning to the desktop is optional; a local listener failure must not
  // prevent signing in. Browser clients keep the manual return instruction.
  const desktopReturnUrl = await getDesktopHost()
    ?.accounts?.createReturnUrl?.()
    .catch(() => undefined);
  return openSignInFlow(endpoint, { desktopReturnUrl, acceptance }, anonymousSessionToken());
}

export function useSignIn(
  endpoint: AccountsEndpoint,
  acceptance: AcceptTermsRequest | null,
): SignInController {
  const [state, dispatch] = useReducer(signInReducer, initialSignInState);
  const storeSession = useAccountSessionStore((store) => store.setSession);
  const queryClient = useQueryClient();
  // The daemon verified the session it hands over, so the gate starts from it instead of checking it
  // first; that check would swap the app for a spinner and lose the chat an anonymous user was in.
  const setSession = useCallback(
    (session: AccountSession) => {
      queryClient.setQueryData(currentSessionQueryKey(endpoint.baseUrl, session.token), {
        user: session.user,
        method: session.method,
      });
      storeSession(session);
    },
    [endpoint.baseUrl, queryClient, storeSession],
  );

  const startEmail = useCallback(
    (email: string) => {
      if (!acceptance) return;
      dispatch({ type: "start", method: "email" });
      void (async () => {
        try {
          const flow = await openAppSignInFlow(endpoint, acceptance);
          await sendMagicLink(endpoint, { email, flowId: flow.flowId });
          dispatch({ type: "email-sent", email, flow });
        } catch (error) {
          dispatch({
            type: "failed",
            message: messageFor(error, "Could not send the sign-in link."),
          });
        }
      })();
    },
    [endpoint, acceptance],
  );

  const startOAuth = useCallback(
    (provider: OAuthSignInMethod) => {
      if (!acceptance) return;
      dispatch({ type: "start", method: provider });
      void (async () => {
        try {
          const flow = await openAppSignInFlow(endpoint, acceptance);
          await openExternalUrl(buildOAuthStartUrl(endpoint, { provider, flowId: flow.flowId }));
          dispatch({ type: "browser-opened", provider, flow });
        } catch (error) {
          dispatch({
            type: "failed",
            message: messageFor(error, "Could not open the sign-in page."),
          });
        }
      })();
    },
    [endpoint, acceptance],
  );

  const goBack = useCallback(() => {
    dispatch({ type: "back" });
  }, []);

  const flow = pendingFlow(state);
  useEffect(() => {
    if (!flow) {
      return;
    }

    let stopped = false;
    const poll = async () => {
      const result = await claimSignInFlow(endpoint, flow).catch(() => null);
      if (stopped || !result) {
        return;
      }
      if (result.status === "expired") {
        dispatch({ type: "flow-expired", message: "This sign-in expired. Start again." });
        return;
      }
      if (result.status === "signed-in") {
        const upgraded = anonymousSessionToken();
        setSession({ token: result.sessionToken, user: result.user, method: result.method });
        // The control plane already revoked the anonymous session; this makes the daemon forget it
        // too, so it never forwards it to Arena again.
        if (upgraded) void signOut(endpoint, upgraded).catch(() => undefined);
      }
    };

    const handle = setInterval(() => {
      void poll();
    }, CLAIM_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [endpoint, flow, setSession]);

  return { state, startEmail, startOAuth, goBack };
}
