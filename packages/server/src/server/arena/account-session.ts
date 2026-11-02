import {
  ACCOUNT_SESSION_REJECTED_CODE,
  ACCOUNT_SESSION_REJECTED_MESSAGE,
  ACCOUNT_TERMS_REQUIRED_CODE,
  ACCOUNT_TERMS_REQUIRED_MESSAGE,
  APP_UPDATE_REQUIRED_CODE,
  APP_UPDATE_REQUIRED_MESSAGE,
  ARENA_CONTROL_PLANE_FAILED_CODE,
  ARENA_CONTROL_PLANE_FAILED_MESSAGE,
} from "@getpaseo/protocol/accounts/schemas";
import { arenaSessionRefusals, isArenaSessionRejected } from "../accounts/credentials.js";
import {
  arenaTermsRefusals,
  arenaUpdateRefusals,
  isControlPlaneFailure,
} from "../accounts/control-plane-outcomes.js";

/** The control plane refuses the account session, so this Arena request needs a new sign-in. */
export class ArenaSessionRejectedError extends Error {
  readonly code = ACCOUNT_SESSION_REJECTED_CODE;

  constructor() {
    super(ACCOUNT_SESSION_REJECTED_MESSAGE);
    this.name = "ArenaSessionRejectedError";
  }
}

/** The control plane refused this Arena request until the user accepts the current terms. */
export class ArenaTermsRequiredError extends Error {
  readonly code = ACCOUNT_TERMS_REQUIRED_CODE;

  constructor(cause: unknown) {
    super(ACCOUNT_TERMS_REQUIRED_MESSAGE, { cause });
    this.name = "ArenaTermsRequiredError";
  }
}

/**
 * The control plane refused this Arena request because this build is no longer supported. The
 * message is the control plane's own text, which the engine passed on and which carries the
 * download link; it names no model.
 */
export class ArenaUpdateRequiredError extends Error {
  readonly code = APP_UPDATE_REQUIRED_CODE;

  constructor(cause: unknown) {
    const text = cause instanceof Error ? cause.message.trim() : "";
    super(text.includes("://") ? text : APP_UPDATE_REQUIRED_MESSAGE, { cause });
    this.name = "ArenaUpdateRequiredError";
  }
}

/**
 * This Arena request failed on a control-plane answer that the runtime proxy replaced with fixed,
 * marked text (`accounts/control-plane-outcomes.ts`); the proxy logged the original. The app gets
 * the fixed text by code.
 */
export class ArenaControlPlaneError extends Error {
  readonly code = ARENA_CONTROL_PLANE_FAILED_CODE;

  constructor(cause: unknown) {
    super(ARENA_CONTROL_PLANE_FAILED_MESSAGE, { cause });
    this.name = "ArenaControlPlaneError";
  }
}

/** Arena failures that the app receives in these words and by code, without the generic prefix. */
export function isArenaAccountError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof ArenaSessionRejectedError ||
    error instanceof ArenaTermsRequiredError ||
    error instanceof ArenaUpdateRequiredError ||
    error instanceof ArenaControlPlaneError
  );
}

// Requests that start or resolve model work. That work reaches the control plane after the
// request has answered, so a rejected session would otherwise fail it with no sign-in prompt.
const MODEL_WORK_REQUESTS: ReadonlySet<string> = new Set([
  "arena.turn.start.request",
  "arena.turn.reply.request",
  "arena.turn.vote.request",
  "arena.turn.resume.request",
  "arena.turn.retry_comparison.request",
  "arena.turn.retry_resolution.request",
  "arena.single_agent.vote.request",
  "arena.run.retry.request",
  "arena.run.question.reply.request",
  "arena.run.permission.reply.request",
]);

/**
 * Runs an Arena mutation. Once the control plane has refused the forwarded session, model work
 * is refused before it starts. A failure is reported as that refusal only when the daemon refused
 * one of its control-plane requests while it ran: the engine words the refusal as its own error,
 * which the app cannot tell from any other. The counter is shared, so a parallel request's refusal
 * can label this failure; both happened on a refused session.
 */
export async function runWithArenaAccountSession(
  requestType: string,
  run: () => Promise<void>,
): Promise<void> {
  if (isArenaSessionRejected() && MODEL_WORK_REQUESTS.has(requestType)) {
    throw new ArenaSessionRejectedError();
  }
  const refusalsBefore = arenaSessionRefusals();
  const termsBefore = arenaTermsRefusals();
  const updatesBefore = arenaUpdateRefusals();
  try {
    await run();
  } catch (error) {
    // Not the flag: after a refusal the daemon can fall back to another session of the account,
    // and the request it refused still failed on the session.
    if (arenaSessionRefusals() > refusalsBefore) throw new ArenaSessionRejectedError();
    if (arenaUpdateRefusals() > updatesBefore) throw new ArenaUpdateRequiredError(error);
    if (arenaTermsRefusals() > termsBefore) throw new ArenaTermsRequiredError(error);
    // Only this request's own failed answer, which carries the failure mark in its text.
    if (isControlPlaneFailure(error)) throw new ArenaControlPlaneError(error);
    throw error;
  }
}
