/** Engine refusals the app words itself, so its text can be translated and carries no request details. */
const ARENA_REFUSAL_CODES = new Set(["arena_side_closing"]);

/** An engine refusal whose `code` the window gets as it is, with the engine's text unprefixed. */
export class ArenaRefusalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArenaRefusalError";
  }
}

/** The engine's error for a failed Arena request: coded when the app words that refusal itself. */
export function arenaEngineError(message: string, code: unknown): Error {
  return typeof code === "string" && ARENA_REFUSAL_CODES.has(code)
    ? new ArenaRefusalError(code, message)
    : new Error(message);
}
