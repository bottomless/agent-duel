import { useCallback, useEffect, useReducer } from "react";
import { getDesktopHost } from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";
import { useAccountSessionStore } from "./session-store";
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

async function openAppSignInFlow(endpoint: AccountsEndpoint) {
  // Returning to the desktop is optional; a local listener failure must not
  // prevent signing in. Browser clients keep the manual return instruction.
  const desktopReturnUrl = await getDesktopHost()
    ?.accounts?.createReturnUrl?.()
    .catch(() => undefined);
  return openSignInFlow(endpoint, { desktopReturnUrl });
}

export function useSignIn(endpoint: AccountsEndpoint): SignInController {
  const [state, dispatch] = useReducer(signInReducer, initialSignInState);
  const setSession = useAccountSessionStore((store) => store.setSession);

  const startEmail = useCallback(
    (email: string) => {
      dispatch({ type: "start", method: "email" });
      void (async () => {
        try {
          const flow = await openAppSignInFlow(endpoint);
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
    [endpoint],
  );

  const startOAuth = useCallback(
    (provider: OAuthSignInMethod) => {
      dispatch({ type: "start", method: provider });
      void (async () => {
        try {
          const flow = await openAppSignInFlow(endpoint);
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
    [endpoint],
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
        setSession({ token: result.sessionToken, user: result.user, method: result.method });
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
