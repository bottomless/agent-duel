/**
 * The daemon listens off loopback, so hosted Arena cannot start its engine. Every request and
 * reconnect gets the same answer until the daemon listens on loopback or the account switches to an
 * OpenRouter key, so the chat shows the daemon's instruction instead of reconnecting.
 */
export class ArenaLoopbackRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaLoopbackRequiredError";
  }
}

/** The daemon's loopback refusal, in its own words without the request details; else undefined. */
export function arenaLoopbackRequired(error: unknown): ArenaLoopbackRequiredError | undefined {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "arena_loopback_required")
    return undefined;
  const text =
    "userMessage" in error && typeof error.userMessage === "string"
      ? error.userMessage
      : error.message;
  return new ArenaLoopbackRequiredError(text);
}
