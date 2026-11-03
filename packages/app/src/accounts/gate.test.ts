import { describe, expect, it } from "vitest";
import { resolveAccountGate, type ResolveAccountGateInput } from "./gate";

const base: ResolveAccountGateInput = {
  hasEndpoint: true,
  storeHydrated: true,
  methodsPhase: "success",
  updateRequired: false,
  accountsEnabled: true,
  methods: ["email", "google", "github"],
  hasStoredSession: true,
  sessionPhase: "success",
  sessionIsValid: true,
  legalDocumentsAvailable: true,
  hasAcceptedLegalDocuments: true,
};

describe("resolveAccountGate", () => {
  it("waits for a daemon before deciding anything", () => {
    expect(resolveAccountGate({ ...base, hasEndpoint: false })).toEqual({
      kind: "waiting-for-daemon",
    });
  });

  it("waits for the persisted session to rehydrate", () => {
    expect(resolveAccountGate({ ...base, storeHydrated: false })).toEqual({ kind: "checking" });
  });

  it("opens the app when the daemon has no accounts configured", () => {
    expect(resolveAccountGate({ ...base, accountsEnabled: false })).toEqual({ kind: "disabled" });
  });

  it("reports an unreachable daemon rather than opening the app", () => {
    expect(resolveAccountGate({ ...base, methodsPhase: "error", hasStoredSession: false })).toEqual(
      { kind: "unreachable" },
    );
  });

  it("keeps a stored session through a failed check instead of signing the user out", () => {
    expect(
      resolveAccountGate({ ...base, methodsPhase: "error", legalDocumentsAvailable: false }),
    ).toEqual({ kind: "signed-in" });
    expect(resolveAccountGate({ ...base, sessionPhase: "error" })).toEqual({ kind: "signed-in" });
  });

  it("asks for sign-in with no session and with a rejected one", () => {
    expect(resolveAccountGate({ ...base, hasStoredSession: false })).toEqual({
      kind: "signed-out",
      methods: base.methods,
    });
    expect(resolveAccountGate({ ...base, sessionIsValid: false })).toEqual({
      kind: "signed-out",
      methods: base.methods,
    });
  });

  it("lets a valid session through", () => {
    expect(resolveAccountGate(base)).toEqual({ kind: "signed-in" });
  });

  it("requires acceptance for a legacy or outdated account, including failed session revalidation", () => {
    expect(resolveAccountGate({ ...base, hasAcceptedLegalDocuments: false })).toEqual({
      kind: "acceptance-required",
    });
    expect(
      resolveAccountGate({ ...base, hasAcceptedLegalDocuments: false, sessionPhase: "error" }),
    ).toEqual({ kind: "acceptance-required" });
    expect(
      resolveAccountGate({
        ...base,
        hasAcceptedLegalDocuments: false,
        methodsPhase: "error",
        legalDocumentsAvailable: false,
      }),
    ).toEqual({ kind: "unreachable" });
  });

  it("asks a refused build to update before sign-in or terms", () => {
    const refused = { ...base, updateRequired: true };
    expect(resolveAccountGate(refused)).toEqual({ kind: "update-required" });
    expect(resolveAccountGate({ ...refused, hasStoredSession: false })).toEqual({
      kind: "update-required",
    });
    expect(resolveAccountGate({ ...refused, hasAcceptedLegalDocuments: false })).toEqual({
      kind: "update-required",
    });
  });

  it("does not ask for an update while the methods check is pending or failed", () => {
    expect(resolveAccountGate({ ...base, updateRequired: true, methodsPhase: "pending" })).toEqual({
      kind: "checking",
    });
    expect(resolveAccountGate({ ...base, updateRequired: true, methodsPhase: "error" })).toEqual({
      kind: "signed-in",
    });
  });
});
