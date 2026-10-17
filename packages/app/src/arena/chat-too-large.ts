/**
 * A chat whose battle state is past what the daemon sends a window. Reconnecting gets the same
 * answer, so the stream stops retrying and the composer says what to do instead of failing quietly.
 */
export class ArenaChatTooLargeError extends Error {
  constructor() {
    super(
      "This chat is too long to load. Start a new chat to keep going. Your code changes are already in your project.",
    );
    this.name = "ArenaChatTooLargeError";
  }
}

/** Something other than the battle's state too large to send; the battle itself still loads. */
export class ArenaItemTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaItemTooLargeError";
  }
}

/**
 * The daemon's size refusals as the app words them, without the request details the client adds to
 * an error's message; any other error unchanged.
 */
export function arenaSizeErrorOr(error: unknown): unknown {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "arena_chat_too_large") return new ArenaChatTooLargeError();
  if (code === "arena_diff_too_large") {
    return new ArenaItemTooLargeError("This comparison is too large to show.");
  }
  return error;
}

/** A size refusal answers the same every time, so asking again cannot help. */
export function isArenaSizeError(error: unknown): boolean {
  return error instanceof ArenaChatTooLargeError || error instanceof ArenaItemTooLargeError;
}
