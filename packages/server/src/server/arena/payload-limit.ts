import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "../websocket/physical-socket.js";

/**
 * The largest Arena answer the daemon passes on to a window. Past 64 MiB waiting on a socket the
 * daemon drops it, and a long chat's snapshot did that on every open and every send, so the chat
 * could never load again and the window reconnected forever. Half the socket limit leaves room for
 * the other frames the socket carries.
 */
export const ARENA_PAYLOAD_LIMIT_BYTES = MAX_PHYSICAL_SOCKET_BUFFERED_BYTES / 2;

/** An Arena answer past `ARENA_PAYLOAD_LIMIT_BYTES`; the window gets its code and message as they are. */
export class ArenaPayloadTooLargeError extends Error {
  constructor(
    readonly code: "arena_chat_too_large" | "arena_diff_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ArenaPayloadTooLargeError";
  }
}

export class ArenaChatTooLargeError extends ArenaPayloadTooLargeError {
  constructor() {
    super("arena_chat_too_large", "This chat is too long to load");
    this.name = "ArenaChatTooLargeError";
  }
}

/**
 * The engine bounds a comparison by its own file and patch limits, so only an unusual one comes near
 * this. It is the comparison that cannot be shown; the chat still loads and takes the next prompt.
 */
export class ArenaDiffTooLargeError extends ArenaPayloadTooLargeError {
  constructor() {
    super("arena_diff_too_large", "This comparison is too large to show.");
    this.name = "ArenaDiffTooLargeError";
  }
}
