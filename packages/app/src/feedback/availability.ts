import { useAccountGateKind, type AccountGateKind } from "@/accounts/gate-context";

/**
 * Feedback is sent with the account session, and a daemon without accounts (a BYOK source build)
 * mounts no feedback routes, so feedback is offered only to a signed-in account.
 */
export function isFeedbackAvailable(gate: AccountGateKind): boolean {
  return gate === "signed-in";
}

export function useFeedbackAvailable(): boolean {
  return isFeedbackAvailable(useAccountGateKind());
}
