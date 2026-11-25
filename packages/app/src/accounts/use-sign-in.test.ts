/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptTermsRequest,
  ClaimSignInFlowResponse,
} from "@getpaseo/protocol/accounts/schemas";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  failReads: false,
  openSignInFlow: vi.fn(async (..._args: unknown[]) => ({
    flowId: "flow-1",
    secret: "secret-1",
    expiresAt: "2026-11-25T12:00:00.000Z",
  })),
  claimSignInFlow: vi.fn(
    async (..._args: unknown[]): Promise<ClaimSignInFlowResponse> => ({ status: "pending" }),
  ),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => {
      if (mocks.failReads) throw new Error("storage unavailable");
      return mocks.storage.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      mocks.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      mocks.storage.delete(key);
    },
  },
}));
vi.mock("./client", () => ({
  openSignInFlow: (...args: unknown[]) => mocks.openSignInFlow(...args),
  sendMagicLink: async () => {},
  claimSignInFlow: (...args: unknown[]) => mocks.claimSignInFlow(...args),
  buildOAuthStartUrl: () => "https://example.com/oauth",
}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: async () => {} }));

import { forgetAppOpenedReportForTests } from "./app-opened";
import { useAccountSessionStore } from "./session-store";
import { useSignIn } from "./use-sign-in";

const endpoint = { baseUrl: "http://127.0.0.1:6767", authHeader: null, daemonPassword: null };
const acceptance: AcceptTermsRequest = {
  accepted: true,
  termsVersion: "1",
  privacyPolicyVersion: "1",
};

async function startEmailFlow() {
  const { result } = renderHook(() => useSignIn(endpoint, acceptance));
  act(() => result.current.startEmail("dev@example.com"));
  await waitFor(() => expect(mocks.openSignInFlow).toHaveBeenCalledTimes(1));
  return mocks.openSignInFlow.mock.calls[0]?.[1];
}

beforeEach(() => {
  mocks.storage.clear();
  mocks.failReads = false;
  mocks.openSignInFlow.mockClear();
  mocks.claimSignInFlow.mockReset();
  mocks.claimSignInFlow.mockResolvedValue({ status: "pending" });
  useAccountSessionStore.setState({ session: null });
  forgetAppOpenedReportForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSignIn flow counts", () => {
  it("names the button and says the install has not held a session", async () => {
    expect(await startEmailFlow()).toEqual({
      desktopReturnUrl: undefined,
      acceptance,
      method: "email",
      returning: false,
    });
  });

  it("says the install has held a session once one was stored", async () => {
    mocks.storage.set("agent-duel.held-session", "1");
    expect(await startEmailFlow()).toMatchObject({ method: "email", returning: true });
  });

  it("still opens the flow when the mark cannot be read", async () => {
    mocks.failReads = true;
    expect(await startEmailFlow()).toMatchObject({ method: "email", returning: false });
  });
});

describe("useSignIn claim polling", () => {
  const user = { id: "user-1", email: "dev@example.com", name: null, image: null };

  // Counts claims in flight; each takes `delayMs` on the fake clock before it answers.
  function slowClaims(answers: ClaimSignInFlowResponse[], delayMs: number) {
    const inFlight = { now: 0, max: 0 };
    mocks.claimSignInFlow.mockImplementation(async () => {
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      const answer = answers.shift() ?? { status: "expired" };
      // The control plane hands a session over once; a claim after it answers expired at once.
      if (answer.status !== "expired") await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight.now -= 1;
      return answer;
    });
    return inFlight;
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function waitingForEmail() {
    vi.useFakeTimers();
    const hook = renderHook(() => useSignIn(endpoint, acceptance));
    act(() => hook.result.current.startEmail("dev@example.com"));
    await advance(0);
    expect(hook.result.current.state.kind).toBe("awaiting-email");
    return hook;
  }

  it("keeps a slow signed-in claim when a later poll would have read expired", async () => {
    const inFlight = slowClaims(
      [{ status: "signed-in", sessionToken: "token-1", method: "email", user }],
      3_000,
    );
    const { result } = await waitingForEmail();

    await advance(2_000 + 3_000);
    expect(inFlight.max).toBe(1);
    expect(useAccountSessionStore.getState().session).toEqual({
      token: "token-1",
      user,
      method: "email",
    });
    expect(result.current.state.kind).toBe("awaiting-email");

    await advance(10_000);
    expect(mocks.claimSignInFlow).toHaveBeenCalledTimes(1);
  });

  it("claims again 2 s after a pending answer settles", async () => {
    const inFlight = slowClaims([{ status: "pending" }, { status: "pending" }], 3_000);
    await waitingForEmail();

    await advance(2_000 + 3_000 + 2_000 - 1);
    expect(mocks.claimSignInFlow).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.claimSignInFlow).toHaveBeenCalledTimes(2);
    expect(inFlight.max).toBe(1);
  });
});
