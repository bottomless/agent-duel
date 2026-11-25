import { SettledArenaRequestError } from "./refusal.js";

export const ARENA_LOOPBACK_REQUIRED_CODE = "arena_loopback_required";

/**
 * Hosted Arena hands the engine a capability for the daemon's runtime proxy, which only a loopback
 * listener may receive. A daemon bound elsewhere cannot start the engine until it listens on
 * loopback again or the account switches to an OpenRouter key, so every window shows this text and
 * stops retrying instead of reading it as a dropped connection.
 */
export class ArenaLoopbackRequiredError extends SettledArenaRequestError {
  readonly code = ARENA_LOOPBACK_REQUIRED_CODE;

  constructor() {
    super(
      "Hosted Arena requires a loopback TCP connection to the daemon. Configure the daemon to listen on 127.0.0.1 or [::1].",
    );
    this.name = "ArenaLoopbackRequiredError";
  }
}

/** The loopback refusal behind an engine start failure, however the caller wrapped it. */
export function findArenaLoopbackRequired(error: unknown): ArenaLoopbackRequiredError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    if (current instanceof ArenaLoopbackRequiredError) return current;
    current = current.cause;
  }
  return undefined;
}
