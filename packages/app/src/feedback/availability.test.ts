import { describe, expect, it } from "vitest";
import { resolveAccountGate, type ResolveAccountGateInput } from "@/accounts/gate";
import { isFeedbackAvailable } from "./availability";

const signedIn: ResolveAccountGateInput = {
  hasEndpoint: true,
  storeHydrated: true,
  methodsPhase: "success",
  accountsEnabled: true,
  methods: ["email", "google", "github"],
  hasStoredSession: true,
  sessionPhase: "success",
  sessionIsValid: true,
};

function feedbackAvailableFor(input: ResolveAccountGateInput): boolean {
  return isFeedbackAvailable(resolveAccountGate(input).kind);
}

describe("isFeedbackAvailable", () => {
  it("offers feedback to a signed-in account", () => {
    expect(feedbackAvailableFor(signedIn)).toBe(true);
  });

  it("hides feedback on a daemon without accounts, even with a stored session", () => {
    expect(feedbackAvailableFor({ ...signedIn, accountsEnabled: false })).toBe(false);
  });

  it("hides feedback until the daemon and session are known", () => {
    expect(feedbackAvailableFor({ ...signedIn, hasEndpoint: false })).toBe(false);
    expect(feedbackAvailableFor({ ...signedIn, methodsPhase: "pending" })).toBe(false);
  });
});
