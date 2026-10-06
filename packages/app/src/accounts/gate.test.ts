import { describe, expect, it } from "vitest";
import { resolveAccountGate, type ResolveAccountGateInput } from "./gate";

const base: ResolveAccountGateInput = {
  hasEndpoint: true,
  storeHydrated: true,
  methodsPhase: "success",
  accountsEnabled: true,
  methods: ["email", "google", "github"],
  hasStoredSession: true,
  sessionPhase: "success",
  sessionIsValid: true,
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
    expect(resolveAccountGate({ ...base, methodsPhase: "error" })).toEqual({ kind: "signed-in" });
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
});
