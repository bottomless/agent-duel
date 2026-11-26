import { afterEach, describe, expect, it, vi } from "vitest";
import { claimSignInFlow } from "./client";

const endpoint = { baseUrl: "http://127.0.0.1:6767", authHeader: null, daemonPassword: null };
const flow = { flowId: "flow-1", secret: "secret-1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A daemon that never answers: the request ends only when its signal aborts it.
function neverAnswers(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

describe("claimSignInFlow", () => {
  it("gives up on a claim the daemon does not answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(neverAnswers));

    let outcome = "waiting";
    void claimSignInFlow(endpoint, flow, { timeoutMs: 20_000 }).then(
      () => (outcome = "answered"),
      () => (outcome = "gave up"),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(outcome).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("gave up");
  });

  it("returns the answer of a claim that settles in time and leaves no timer behind", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "pending" })),
    );
    await expect(claimSignInFlow(endpoint, flow)).resolves.toEqual({ status: "pending" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
