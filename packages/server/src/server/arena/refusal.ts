/** Engine refusals the app words itself, so its text can be translated and carries no request details. */
const ARENA_REFUSAL_CODES = new Set(["arena_side_closing"]);

/** A terminal engine error response, or a failure preparing the request before dispatch. */
export class SettledArenaRequestError extends Error {}

export function beforeArenaDispatch(cause: unknown): never {
  throw new SettledArenaRequestError(cause instanceof Error ? cause.message : String(cause), {
    cause,
  });
}

/** An engine refusal whose `code` the window gets as it is, with the engine's text unprefixed. */
export class ArenaRefusalError extends SettledArenaRequestError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArenaRefusalError";
  }
}

/** Only the engine's typed error body proves it finished handling this request. */
export function arenaResponseError(value: unknown, status: number): Error {
  if (value && typeof value === "object" && "data" in value) {
    const data = value.data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
      if (!("name" in value) || value.name !== "ArenaApiError") return new Error(data.message);
      if ("code" in data && typeof data.code === "string" && ARENA_REFUSAL_CODES.has(data.code)) {
        return new ArenaRefusalError(data.code, data.message);
      }
      return new SettledArenaRequestError(data.message);
    }
  }
  return new Error(`Arena request failed with status ${status}`);
}
