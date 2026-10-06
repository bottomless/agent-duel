import type { SignInMethod } from "@getpaseo/protocol/accounts/schemas";

export type OAuthSignInMethod = Exclude<SignInMethod, "email">;

export interface SignInFlowHandle {
  flowId: string;
  secret: string;
}

/**
 * `idle` carries a flow because leaving the waiting screen is navigation, not
 * cancellation: the link is already in the user's inbox and opening it has to
 * sign them in whether or not they went back to the form first.
 */
export type SignInState =
  | { kind: "idle"; flow: SignInFlowHandle | null }
  | { kind: "opening"; method: SignInMethod }
  | { kind: "awaiting-email"; email: string; flow: SignInFlowHandle }
  | { kind: "awaiting-browser"; provider: OAuthSignInMethod; flow: SignInFlowHandle }
  | { kind: "failed"; message: string };

export type SignInAction =
  | { type: "start"; method: SignInMethod }
  | { type: "email-sent"; email: string; flow: SignInFlowHandle }
  | { type: "browser-opened"; provider: OAuthSignInMethod; flow: SignInFlowHandle }
  | { type: "failed"; message: string }
  | { type: "flow-expired"; message: string }
  | { type: "back" };

export const initialSignInState: SignInState = { kind: "idle", flow: null };

function waitingFlow(state: SignInState): SignInFlowHandle | null {
  if (state.kind === "awaiting-email" || state.kind === "awaiting-browser") {
    return state.flow;
  }
  if (state.kind === "idle") {
    return state.flow;
  }
  return null;
}

export function signInReducer(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case "start":
      return { kind: "opening", method: action.method };
    case "email-sent":
      // A stale response from an attempt the user already left must not reopen
      // the waiting screen.
      if (state.kind !== "opening" || state.method !== "email") {
        return state;
      }
      return { kind: "awaiting-email", email: action.email, flow: action.flow };
    case "browser-opened":
      if (state.kind !== "opening" || state.method !== action.provider) {
        return state;
      }
      return { kind: "awaiting-browser", provider: action.provider, flow: action.flow };
    case "failed":
      return { kind: "failed", message: action.message };
    case "flow-expired":
      // Only the user still watching that screen needs telling. An attempt
      // abandoned in the background expires quietly.
      if (state.kind === "idle") {
        return { kind: "idle", flow: null };
      }
      return { kind: "failed", message: action.message };
    case "back":
      return { kind: "idle", flow: waitingFlow(state) };
  }
}

export function pendingFlow(state: SignInState): SignInFlowHandle | null {
  return waitingFlow(state);
}

/** Only an in-flight request blocks the form; a link already sent does not. */
export function isSignInBusy(state: SignInState): boolean {
  return state.kind === "opening";
}
