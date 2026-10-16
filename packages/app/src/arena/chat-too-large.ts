/**
 * A battle whose state is past what the daemon sends a window. Reconnecting gets the same answer, so
 * the stream stops retrying and the chat says what to do instead of failing quietly.
 */
export class ArenaChatTooLargeError extends Error {
  constructor() {
    super(
      "This battle is too large to show. Start a new chat to keep going. Your code changes are already in your project.",
    );
    this.name = "ArenaChatTooLargeError";
  }
}

/** The daemon's refusal (`arena_chat_too_large`) as the app words it; any other error unchanged. */
export function chatTooLargeOr(error: unknown): unknown {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "arena_chat_too_large" ? new ArenaChatTooLargeError() : error;
}
