import {
  ACCOUNT_SESSION_REJECTED_CODE,
  ACCOUNT_SESSION_REJECTED_MESSAGE,
  ACCOUNT_TERMS_REQUIRED_CODE,
  ACCOUNT_TERMS_REQUIRED_MESSAGE,
} from "@getpaseo/protocol/accounts/schemas";
import { useAccountSessionStore } from "./session-store";

/** An Arena request the daemon refused because the control plane rejected the account session. */
export class AccountSessionRejectedError extends Error {
  constructor() {
    super(ACCOUNT_SESSION_REJECTED_MESSAGE);
    this.name = "AccountSessionRejectedError";
  }
}

/** An Arena request the control plane refused until the user accepts the current terms. */
export class AccountTermsRequiredError extends Error {
  constructor() {
    super(ACCOUNT_TERMS_REQUIRED_MESSAGE);
    this.name = "AccountTermsRequiredError";
  }
}

/**
 * A token the control plane revoked or expired still verifies on the daemon, so nothing else
 * signs the app out; and the app's copy of the account can predate a terms update. On either
 * refusal this asks the account gate to recheck the session, which shows sign-in when the control
 * plane confirms it is gone, or the terms when the reloaded account has not accepted them. It
 * returns the refusal without the request details the client adds. Any other error comes back
 * unchanged.
 */
export function noticeAccountSessionRejection(error: unknown): unknown {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === ACCOUNT_SESSION_REJECTED_CODE) {
    requestAccountSessionCheck();
    return new AccountSessionRejectedError();
  }
  if (code === ACCOUNT_TERMS_REQUIRED_CODE) {
    requestAccountSessionCheck();
    return new AccountTermsRequiredError();
  }
  return error;
}

/** Asks the account gate to recheck the session with the control plane, in place. */
export function requestAccountSessionCheck(): void {
  useAccountSessionStore.getState().requestCheck();
}

const FIRST_RECHECK_RETRY_MS = 2_000;
const MAX_RECHECK_RETRY_MS = 10_000;

/**
 * Rechecks the session until the control plane answers. `check` resolves true while the session
 * is live and false once it is refused, and throws when there is no answer (a 5xx, a timeout, no
 * network); then it asks again after 2 s, doubling to 10 s. Only a refusal calls `expire`, and
 * only while the session checked is still the current one. `signal` ends the loop when a newer
 * check takes over or the gate unmounts.
 */
export async function recheckAccountSession(input: {
  readonly check: () => Promise<boolean>;
  readonly isCurrent: () => boolean;
  readonly expire: () => void;
  readonly signal: AbortSignal;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const wait = input.wait ?? waitFor;
  let delayMs = FIRST_RECHECK_RETRY_MS;
  while (!input.signal.aborted && input.isCurrent()) {
    let live: boolean;
    try {
      live = await input.check();
    } catch {
      await wait(delayMs, input.signal);
      delayMs = Math.min(delayMs * 2, MAX_RECHECK_RETRY_MS);
      continue;
    }
    if (!live && !input.signal.aborted && input.isCurrent()) input.expire();
    return;
  }
}

async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  await Promise.race([elapsed, aborted]);
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
}
