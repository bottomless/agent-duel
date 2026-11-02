import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSessionRejectedError,
  AccountTermsRequiredError,
  noticeAccountSessionRejection,
  recheckAccountSession,
} from "./session-rejected";
import { useAccountSessionStore } from "./session-store";

function rpcError(code: string) {
  return Object.assign(
    new Error(`Request refused requestType=arena.turn.start.request code=${code}`),
    { code },
  );
}

describe("noticeAccountSessionRejection", () => {
  beforeEach(() => {
    useAccountSessionStore.setState({ checkRequest: 0 });
  });

  it("asks the account gate to recheck the session and words the refusal for the app", () => {
    const error = noticeAccountSessionRejection(rpcError("account_session_rejected"));

    expect(error).toBeInstanceOf(AccountSessionRejectedError);
    expect((error as Error).message).toBe("Your session expired. Sign in again to continue.");
    expect(useAccountSessionStore.getState().checkRequest).toBe(1);
  });

  it("reloads the account on a terms refusal so the terms can show", () => {
    const before = useAccountSessionStore.getState().checkRequest;
    const refused = Object.assign(new Error("Request failed"), { code: "account_terms_required" });

    const shown = noticeAccountSessionRejection(refused);

    expect(shown).toBeInstanceOf(AccountTermsRequiredError);
    expect(useAccountSessionStore.getState().checkRequest).toBe(before + 1);
    // A terms refusal never signs out.
    expect(useAccountSessionStore.getState().expired).toBe(false);
  });

  it("returns any other error unchanged without a recheck", () => {
    const other = rpcError("handler_error");

    expect(noticeAccountSessionRejection(other)).toBe(other);
    expect(noticeAccountSessionRejection("offline")).toBe("offline");
    expect(useAccountSessionStore.getState().checkRequest).toBe(0);
  });

  it("marks a refused session expired until the next sign-in", () => {
    const store = useAccountSessionStore.getState();
    store.expireSession();
    expect(useAccountSessionStore.getState()).toMatchObject({ session: null, expired: true });

    store.setSession({
      token: "fresh-session",
      method: "email",
      user: { id: "user-1", email: "dev@example.com", name: null, image: null },
    });
    expect(useAccountSessionStore.getState().expired).toBe(false);
  });
});

describe("recheckAccountSession", () => {
  function run(answers: Array<boolean | Error>, isCurrent: () => boolean = () => true) {
    const waits: number[] = [];
    const expire = vi.fn();
    const check = vi.fn(async () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const done = recheckAccountSession({
      check,
      isCurrent,
      expire,
      signal: new AbortController().signal,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    return { done, waits, expire, check };
  }

  it("asks again with backoff until the control plane answers, then shows sign-in on a refusal", async () => {
    const outage = new Error("Service unavailable");
    const { done, waits, expire, check } = run([outage, outage, outage, false]);
    await done;
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(check).toHaveBeenCalledTimes(4);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("never signs out on a failed check, and stops once the session is accepted", async () => {
    const { done, expire, check } = run([new Error("timeout"), true]);
    await done;
    expect(check).toHaveBeenCalledTimes(2);
    expect(expire).not.toHaveBeenCalled();
  });

  it("stops when another session replaced the one it checks", async () => {
    let current = true;
    const { done, expire, check } = run([new Error("timeout"), false], () => {
      const value = current;
      current = false;
      return value;
    });
    await done;
    expect(check).toHaveBeenCalledOnce();
    expect(expire).not.toHaveBeenCalled();
  });
});

describe("recheckAccountSession waits", () => {
  it("removes its abort listener after each wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const answers: Array<boolean | Error> = [new Error("down"), new Error("down"), true];
      const done = recheckAccountSession({
        check: async () => {
          const answer = answers.shift()!;
          if (answer instanceof Error) throw answer;
          return answer;
        },
        isCurrent: () => true,
        expire: () => {},
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await done;
      expect(add).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
