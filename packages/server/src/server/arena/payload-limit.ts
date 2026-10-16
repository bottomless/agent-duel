import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "../websocket/physical-socket.js";

/**
 * The largest Arena answer the daemon passes on to a window. Past 64 MiB waiting on a socket the
 * daemon drops it, and a long chat's snapshot did that on every open and every send, so the chat
 * could never load again and the window reconnected forever. Snapshots now carry one turn with its
 * large tool fields shortened, so only an extreme battle comes near this. Half the socket limit
 * leaves room for the other frames the socket carries.
 */
export const ARENA_PAYLOAD_LIMIT_BYTES = MAX_PHYSICAL_SOCKET_BUFFERED_BYTES / 2;

export class ArenaChatTooLargeError extends Error {
  readonly code = "arena_chat_too_large";

  constructor() {
    super("This battle is too large to load");
    this.name = "ArenaChatTooLargeError";
  }
}
