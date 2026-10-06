import { describe, expect, it } from "vitest";
import {
  initialSignInState,
  isSignInBusy,
  pendingFlow,
  signInReducer,
  type SignInFlowHandle,
} from "./sign-in-state";

const flow: SignInFlowHandle = { flowId: "flow-1", secret: "secret-1" };

function afterEmailSent() {
  const opening = signInReducer(initialSignInState, { type: "start", method: "email" });
  return signInReducer(opening, { type: "email-sent", email: "dev@example.com", flow });
}

describe("signInReducer", () => {
  it("moves to awaiting-email once the link is sent", () => {
    expect(afterEmailSent()).toEqual({ kind: "awaiting-email", email: "dev@example.com", flow });
  });

  it("keeps polling the sent link after the user goes back", () => {
    const back = signInReducer(afterEmailSent(), { type: "back" });
    expect(back).toEqual({ kind: "idle", flow });
    // The link is already in the inbox; opening it must still sign the user in.
    expect(pendingFlow(back)).toEqual(flow);
  });

  it("leaves the form usable while a sent link is still pending", () => {
    expect(isSignInBusy(signInReducer(afterEmailSent(), { type: "back" }))).toBe(false);
  });

  it("keeps a browser sign-in alive after the user goes back", () => {
    const opening = signInReducer(initialSignInState, { type: "start", method: "github" });
    const waiting = signInReducer(opening, { type: "browser-opened", provider: "github", flow });
    expect(pendingFlow(signInReducer(waiting, { type: "back" }))).toEqual(flow);
  });

  it("ignores a link that arrives after the user left the attempt", () => {
    const opening = signInReducer(initialSignInState, { type: "start", method: "email" });
    const back = signInReducer(opening, { type: "back" });
    const state = signInReducer(back, { type: "email-sent", email: "dev@example.com", flow });
    expect(state).toEqual({ kind: "idle", flow: null });
  });

  it("ignores a browser flow for a provider the user is no longer signing in with", () => {
    const opening = signInReducer(initialSignInState, { type: "start", method: "google" });
    const state = signInReducer(opening, { type: "browser-opened", provider: "github", flow });
    expect(state).toEqual({ kind: "opening", method: "google" });
  });

  it("tells the waiting user their sign-in expired", () => {
    const state = signInReducer(afterEmailSent(), { type: "flow-expired", message: "gone" });
    expect(state).toEqual({ kind: "failed", message: "gone" });
  });

  it("drops an abandoned attempt quietly when it expires", () => {
    const back = signInReducer(afterEmailSent(), { type: "back" });
    const state = signInReducer(back, { type: "flow-expired", message: "gone" });
    expect(state).toEqual({ kind: "idle", flow: null });
    expect(pendingFlow(state)).toBeNull();
  });

  it("blocks the form only while a request is in flight", () => {
    const opening = signInReducer(initialSignInState, { type: "start", method: "github" });
    expect(isSignInBusy(opening)).toBe(true);
    expect(pendingFlow(opening)).toBeNull();
    expect(isSignInBusy(signInReducer(opening, { type: "failed", message: "nope" }))).toBe(false);
  });
});
