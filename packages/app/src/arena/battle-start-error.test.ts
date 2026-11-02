import { describe, expect, it } from "vitest";
import { AccountSessionRejectedError } from "@/accounts/session-rejected";
import { neutralBattleStartError } from "./battle-start-error";

// The client's RPC error, as the app receives it (the class is not exported).
function daemonError(userMessage: string, code: string) {
  return Object.assign(
    new Error(`${userMessage} requestType=arena.turn.start.request code=${code}`),
    { name: "DaemonRpcError", code, userMessage },
  );
}

describe("neutralBattleStartError", () => {
  it("shows fixed, localized text for a failed control-plane request", () => {
    const failed = daemonError(
      "Agent Duel could not complete this request. Try again.",
      "arena_control_plane_failed",
    );

    const shown = neutralBattleStartError(failed) as Error;

    expect(shown.message).toBe("The battle could not start. Try again.");
    expect(shown.cause).toBe(failed);
  });

  it("keeps the words of every other refusal, without the request details", () => {
    const conflict = daemonError(
      "Request failed: Resolve the conflicts in src/app.ts first",
      "handler_error",
    );
    expect((neutralBattleStartError(conflict) as Error).message).toBe(
      "Request failed: Resolve the conflicts in src/app.ts first",
    );
    const terms = daemonError(
      "Accept the current Terms of Service and Privacy Policy to continue.",
      "account_terms_required",
    );
    expect((neutralBattleStartError(terms) as Error).message).toBe(
      "Accept the current Terms of Service and Privacy Policy to continue.",
    );
    const update =
      "This version of Agent Duel is no longer supported. Download the latest version: https://example.test/releases/latest";
    expect(
      (neutralBattleStartError(daemonError(update, "app_update_required")) as Error).message,
    ).toBe(update);
  });

  it("passes the errors the app words itself through", () => {
    const expired = new AccountSessionRejectedError();
    const local = new Error("Add your OpenRouter key in Settings to start a battle.");
    expect(neutralBattleStartError(expired)).toBe(expired);
    expect(neutralBattleStartError(local)).toBe(local);
  });
});
