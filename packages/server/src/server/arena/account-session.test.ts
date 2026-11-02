import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearArenaCredentials,
  installArenaCredentials,
  noteArenaSessionRefusal,
  rejectArenaSession,
} from "../accounts/credentials.js";
import {
  controlPlaneFailedBody,
  noteArenaTermsRefusal,
  noteArenaUpdateRequired,
} from "../accounts/control-plane-outcomes.js";
import {
  ArenaControlPlaneError,
  ArenaSessionRejectedError,
  ArenaTermsRequiredError,
  ArenaUpdateRequiredError,
  runWithArenaAccountSession,
} from "./account-session.js";

function signIn(token: string) {
  installArenaCredentials({
    mode: "hosted",
    token,
    controlPlaneUrl: "https://control.agentduel.test",
  });
}

afterEach(() => {
  clearArenaCredentials();
});

describe("runWithArenaAccountSession", () => {
  it("reports a failure as the session refusal once the control plane rejected the session", async () => {
    signIn("account-session-token");
    const start = runWithArenaAccountSession("arena.turn.start.request", async () => {
      // The engine's assignment request is refused while the turn starts.
      rejectArenaSession("account-session-token");
      noteArenaSessionRefusal();
      throw new Error("Unauthorized");
    });

    await expect(start).rejects.toBeInstanceOf(ArenaSessionRejectedError);
    await expect(start).rejects.toMatchObject({
      code: "account_session_rejected",
      message: "Your session expired. Sign in again to continue.",
    });
  });

  it("refuses model work before it starts, but lets a battle stop", async () => {
    signIn("account-session-token");
    rejectArenaSession("account-session-token");
    const run = vi.fn(async () => {});

    await expect(runWithArenaAccountSession("arena.run.retry.request", run)).rejects.toBeInstanceOf(
      ArenaSessionRejectedError,
    );
    expect(run).not.toHaveBeenCalled();

    await runWithArenaAccountSession("arena.turn.stop.request", run);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports the refusal after the daemon fell back to another session", async () => {
    signIn("account-session-token");

    await expect(
      runWithArenaAccountSession("arena.turn.start.request", async () => {
        rejectArenaSession("account-session-token");
        noteArenaSessionRefusal();
        // Another session of the account took over, so the flag is clear again.
        signIn("other-session-token");
        throw new Error("Unauthorized");
      }),
    ).rejects.toBeInstanceOf(ArenaSessionRejectedError);
  });

  it("names a terms refusal, and hides a failed control-plane request's text", async () => {
    signIn("account-session-token");
    const terms = runWithArenaAccountSession("arena.turn.start.request", async () => {
      noteArenaTermsRefusal();
      throw new Error("Accept the current Terms of Service");
    });
    await expect(terms).rejects.toBeInstanceOf(ArenaTermsRequiredError);
    await expect(terms).rejects.toMatchObject({ code: "account_terms_required" });

    // The engine words a failed assignment with the answer's text, which the proxy marked.
    const engine = new Error(controlPlaneFailedBody.error);
    const failed = runWithArenaAccountSession("arena.turn.start.request", async () => {
      throw engine;
    });
    await expect(failed).rejects.toBeInstanceOf(ArenaControlPlaneError);
    await expect(failed).rejects.toMatchObject({
      code: "arena_control_plane_failed",
      message: "Agent Duel could not complete this request. Try again.",
      cause: engine,
    });
  });

  it("names a refused build in the control plane's words, with the download link", async () => {
    signIn("account-session-token");
    const text =
      "This version of Agent Duel is no longer supported. Download the latest version: https://example.test/releases/latest";

    const refused = runWithArenaAccountSession("arena.turn.start.request", async () => {
      noteArenaUpdateRequired();
      throw new Error(text);
    });

    await expect(refused).rejects.toBeInstanceOf(ArenaUpdateRequiredError);
    await expect(refused).rejects.toMatchObject({ code: "app_update_required", message: text });
  });

  it("keeps a refusal's own words while another request's control-plane call fails", async () => {
    signIn("account-session-token");
    const conflict = new Error("Resolve the conflicts in src/app.ts first");
    // A chat title request failing at the same moment carries its mark in its own error only.
    const background = runWithArenaAccountSession("arena.turn.vote.request", async () => {
      throw new Error(controlPlaneFailedBody.error);
    });

    await expect(
      runWithArenaAccountSession("arena.turn.start.request", async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    await expect(background).rejects.toBeInstanceOf(ArenaControlPlaneError);
  });

  it("leaves a failure alone that no session refusal caused, even while rejected", async () => {
    signIn("account-session-token");
    rejectArenaSession("account-session-token");
    const failure = new Error("Nothing to stop");

    await expect(
      runWithArenaAccountSession("arena.turn.stop.request", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("leaves other failures alone while the session is accepted", async () => {
    signIn("account-session-token");
    const failure = new Error("Chat is busy");

    await expect(
      runWithArenaAccountSession("arena.turn.start.request", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
