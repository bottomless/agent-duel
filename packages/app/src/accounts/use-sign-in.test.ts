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
