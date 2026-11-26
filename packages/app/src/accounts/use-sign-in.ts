import { useCallback, useEffect, useReducer } from "react";
import { getDesktopHost } from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";
import { hasHeldSession } from "./app-opened";
import { useAccountSessionStore } from "./session-store";
import type { AcceptTermsRequest, SignInMethod } from "@getpaseo/protocol/accounts/schemas";
import {
  buildOAuthStartUrl,
  claimSignInFlow,
  openSignInFlow,
  sendMagicLink,
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

async function openAppSignInFlow(
  endpoint: AccountsEndpoint,
  acceptance: AcceptTermsRequest,
  method: SignInMethod,
) {
  // Returning to the desktop is optional; a local listener failure must not
  // prevent signing in. Browser clients keep the manual return instruction.
  // Whether the install held a session feeds the anonymous sign-in counts; it never throws.
  const [desktopReturnUrl, returning] = await Promise.all([
    getDesktopHost()
      ?.accounts?.createReturnUrl?.()
      .catch(() => undefined),
    hasHeldSession(),
  ]);
  return openSignInFlow(endpoint, { desktopReturnUrl, acceptance, method, returning });
}

export function useSignIn(
  endpoint: AccountsEndpoint,
  acceptance: AcceptTermsRequest | null,
): SignInController {
  const [state, dispatch] = useReducer(signInReducer, initialSignInState);
  const setSession = useAccountSessionStore((store) => store.setSession);

  const startEmail = useCallback(
    (email: string) => {
      if (!acceptance) return;
      dispatch({ type: "start", method: "email" });
      void (async () => {
        try {
          const flow = await openAppSignInFlow(endpoint, acceptance, "email");
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
          const flow = await openAppSignInFlow(endpoint, acceptance, provider);
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

    // One claim at a time, the next one 2 s after the last settles. The control plane hands the
    // session over once and answers any later claim with expired, so a poll that overlapped a slow
    // successful claim could fail a sign-in that had already succeeded. A claim that gets no answer
    // is given up after `CLAIM_TIMEOUT_MS` and rejects, so it cannot stop the polling.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await claimSignInFlow(endpoint, flow).catch(() => null);
      if (stopped) {
        return;
      }
      if (result?.status === "expired") {
        dispatch({ type: "flow-expired", message: "This sign-in expired. Start again." });
        return;
      }
      if (result?.status === "signed-in") {
        setSession({ token: result.sessionToken, user: result.user, method: result.method });
        return;
      }
      timer = setTimeout(() => void poll(), CLAIM_POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void poll(), CLAIM_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [endpoint, flow, setSession]);

  return { state, startEmail, startOAuth, goBack };
}
