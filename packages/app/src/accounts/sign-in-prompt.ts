import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { SIGN_IN_REQUIRED_CODE } from "@getpaseo/protocol/accounts/schemas";
import { useAccountSessionStore } from "./session-store";

/**
 * Why the sign-in screen is showing over an anonymous session: `requested` from Settings, which the
 * user can back out of, or `required` once the session has used its messages, which they cannot.
 */
export type SignInPrompt = "requested" | "required";

interface SignInPromptState {
  prompt: SignInPrompt | null;
  /**
   * The anonymous session has used its messages. Read from the control plane after each send, so
   * the send that used the last one still goes out and only the next one asks for an account.
   */
  messagesUsed: boolean;
  request: (prompt: SignInPrompt) => void;
  dismiss: () => void;
  setMessagesUsed: (used: boolean) => void;
}

export const useSignInPromptStore = create<SignInPromptState>()((set) => ({
  prompt: null,
  messagesUsed: false,
  // A required prompt is never downgraded to one the user can leave.
  request: (prompt) => set((state) => (state.prompt === "required" ? state : { prompt })),
  dismiss: () => set((state) => (state.prompt === "required" ? state : { prompt: null })),
  setMessagesUsed: (messagesUsed) => set({ messagesUsed }),
}));

/** Signing in replaces the anonymous session, which ends any prompt for it. */
useAccountSessionStore.subscribe((state, previous) => {
  if (state.session?.method !== "anonymous" && previous.session?.method === "anonymous") {
    useSignInPromptStore.setState({ prompt: null, messagesUsed: false });
  }
});

export function isSignInRequiredError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === SIGN_IN_REQUIRED_CODE;
}

const SECOND_LOOK_MS = 3_000;

function isAnonymous(): boolean {
  return useAccountSessionStore.getState().session?.method === "anonymous";
}

/**
 * The composer's check around a send. An anonymous session that has used its messages gets the
 * sign-in screen instead of sending, and the draft stays where it is. The control plane refuses the
 * send on its own too (`sign_in_required`), for a session whose last message this window missed.
 */
export function useAnonymousSendGuard() {
  const queryClient = useQueryClient();

  const holdForSignIn = useCallback((): boolean => {
    if (!isAnonymous() || !useSignInPromptStore.getState().messagesUsed) return false;
    useSignInPromptStore.getState().request("required");
    return true;
  }, []);

  const sendSettled = useCallback(
    (error?: unknown) => {
      if (isSignInRequiredError(error)) {
        useSignInPromptStore.getState().request("required");
        return;
      }
      if (!isAnonymous()) return;
      const refresh = () =>
        void queryClient.invalidateQueries({ queryKey: ["accounts", "session"] });
      refresh();
      // A single-agent message is counted after the daemon accepts it, so look once more.
      setTimeout(refresh, SECOND_LOOK_MS);
    },
    [queryClient],
  );

  return { holdForSignIn, sendSettled };
}
