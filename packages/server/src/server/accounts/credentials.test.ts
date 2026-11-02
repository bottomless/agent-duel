import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ArenaSessionVerdict,
  clearArenaCredentials,
  confirmArenaSessionRejection,
  installArenaCredentials,
  isArenaSessionRejected,
  replaceArenaCredentialsToken,
  setArenaSessionVerifier,
} from "./credentials.js";

const TOKEN = "account-session-token";

beforeEach(() => {
  vi.useFakeTimers();
  clearArenaCredentials();
  installArenaCredentials({
    mode: "hosted",
    token: TOKEN,
    controlPlaneUrl: "https://control.agentduel.test",
  });
});

afterEach(() => {
  setArenaSessionVerifier(null);
  clearArenaCredentials();
  vi.useRealTimers();
});

describe("confirmArenaSessionRejection", () => {
  it("backs off a session check that got no answer and never rejects on it", async () => {
    const verdicts: ArenaSessionVerdict[] = ["unknown", "unknown", "rejected"];
    const verify = vi.fn(async () => verdicts.shift()!);
    setArenaSessionVerifier(verify);

    expect(await confirmArenaSessionRejection(TOKEN)).toBe("unknown");
    expect(await confirmArenaSessionRejection(TOKEN)).toBe("unknown");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(isArenaSessionRejected()).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(await confirmArenaSessionRejection(TOKEN)).toBe("unknown");
    expect(verify).toHaveBeenCalledTimes(2);

    // The wait doubles after a second failure.
    vi.advanceTimersByTime(2_000);
    expect(await confirmArenaSessionRejection(TOKEN)).toBe("unknown");
    expect(verify).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2_000);
    expect(await confirmArenaSessionRejection(TOKEN)).toBe("rejected");
    expect(verify).toHaveBeenCalledTimes(3);
    expect(isArenaSessionRejected()).toBe(true);
  });

  it("treats a check that throws as no answer", async () => {
    setArenaSessionVerifier(async () => {
      throw new Error("socket hang up");
    });

    expect(await confirmArenaSessionRejection(TOKEN)).toBe("unknown");
    expect(isArenaSessionRejected()).toBe(false);
  });

  it("answers replaced, not accepted, when a new sign-in took over during the check", async () => {
    setArenaSessionVerifier(async () => {
      replaceArenaCredentialsToken("fresh-session-token");
      return "rejected";
    });

    expect(await confirmArenaSessionRejection(TOKEN)).toBe("replaced");
    expect(isArenaSessionRejected()).toBe(false);
    // A 401 for a token that is no longer forwarded needs no check.
    expect(await confirmArenaSessionRejection(TOKEN)).toBe("replaced");
  });
});
