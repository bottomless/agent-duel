import { SIGN_IN_REQUIRED_CODE } from "@getpaseo/protocol/accounts/schemas";

/**
 * The engine refused a send because the anonymous account has used its messages. The window gets
 * its code and message as they are, and answers with the sign-in screen.
 */
export class ArenaSignInRequiredError extends Error {
  readonly code = SIGN_IN_REQUIRED_CODE;
  constructor(message: string) {
    super(message);
    this.name = "ArenaSignInRequiredError";
  }
}

/** The engine's refusal code (`ArenaApiError.data.code`), when it sent one. */
export function arenaErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = value.data;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code
    : null;
}
