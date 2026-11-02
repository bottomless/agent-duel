import {
  ARENA_CONTROL_PLANE_FAILED_CODE,
  ARENA_CONTROL_PLANE_FAILED_MESSAGE,
} from "@getpaseo/protocol/accounts/schemas";

/**
 * The control plane refused a request until the user accepts the current terms. Counted, as the
 * session refusal is (`credentials.ts`): terms are a fact about the account, so a refusal seen on
 * any request means the user's action needs the terms too.
 */
let termsRefusals = 0;

export function noteArenaTermsRefusal(): void {
  termsRefusals += 1;
}

export function arenaTermsRefusals(): number {
  return termsRefusals;
}

/**
 * The control plane refused a request because this build is no longer supported. Counted for the
 * same reason as terms: it holds for every request of this build.
 */
let updateRefusals = 0;

export function noteArenaUpdateRequired(): void {
  updateRefusals += 1;
}

export function arenaUpdateRefusals(): number {
  return updateRefusals;
}

// Marks a failed control-plane answer in the error text itself, so it travels with the request
// that failed: the engine words an assignment failure with the answer's `error`, and the daemon
// recognises its own failure by this mark (`arena/account-session.ts`), not by what else failed at
// the same time.
const failedMark = `[${ARENA_CONTROL_PLANE_FAILED_CODE}]`;

/**
 * The answer that replaces a failed assignment answer. Its text can name a contestant model or a
 * provider (the pool check names an unavailable model), so it never reaches the engine; the
 * router logs it.
 */
export const controlPlaneFailedBody = {
  error: `${ARENA_CONTROL_PLANE_FAILED_MESSAGE} ${failedMark}`,
  code: ARENA_CONTROL_PLANE_FAILED_CODE,
} as const;

/** Whether an error, or one of its causes, carries a failed control-plane answer. */
export function isControlPlaneFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (current.message.includes(failedMark)) return true;
    current = current.cause;
  }
  return false;
}
