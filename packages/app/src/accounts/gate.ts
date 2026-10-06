import type { SignInMethod } from "@getpaseo/protocol/accounts/schemas";

export type QueryPhase = "pending" | "success" | "error";

export type AccountGate =
  | { kind: "waiting-for-daemon" }
  | { kind: "checking" }
  | { kind: "unreachable" }
  | { kind: "disabled" }
  | { kind: "signed-out"; methods: readonly SignInMethod[] }
  | { kind: "signed-in" };

export interface ResolveAccountGateInput {
  hasEndpoint: boolean;
  storeHydrated: boolean;
  methodsPhase: QueryPhase;
  accountsEnabled: boolean;
  methods: readonly SignInMethod[];
  hasStoredSession: boolean;
  sessionPhase: QueryPhase;
  sessionIsValid: boolean;
}

/**
 * An unreachable daemon is not evidence that it has no accounts, so the app
 * says so rather than opening. A stored session survives a failed revalidation:
 * the daemon rejects a bad one on its own, and dropping the user to sign-in
 * every time the network blinks is worse than trusting it until it is refused.
 */
export function resolveAccountGate(input: ResolveAccountGateInput): AccountGate {
  if (!input.hasEndpoint) {
    return { kind: "waiting-for-daemon" };
  }
  if (!input.storeHydrated || input.methodsPhase === "pending") {
    return { kind: "checking" };
  }
  if (input.methodsPhase === "error") {
    return input.hasStoredSession ? { kind: "signed-in" } : { kind: "unreachable" };
  }
  if (!input.accountsEnabled) {
    return { kind: "disabled" };
  }
  if (!input.hasStoredSession) {
    return { kind: "signed-out", methods: input.methods };
  }
  if (input.sessionPhase === "pending") {
    return { kind: "checking" };
  }
  if (input.sessionPhase === "error") {
    return { kind: "signed-in" };
  }
  if (!input.sessionIsValid) {
    return { kind: "signed-out", methods: input.methods };
  }
  return { kind: "signed-in" };
}
