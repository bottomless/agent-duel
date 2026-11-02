import { ARENA_CONTROL_PLANE_FAILED_CODE } from "@getpaseo/protocol/accounts/schemas";
import { i18n } from "@/i18n/i18next";

/**
 * The error a failed battle start shows. Only a failure the daemon marks as a control-plane
 * failure is replaced: its text can name a contestant model or a provider (the contestant pool
 * check names an unavailable model), so the daemon already swapped it for fixed text and logged
 * the original. Every other error says what to do (terms, a trunk conflict, a chat that is too
 * large, a missing key, an expired session) and keeps its words, without the request details the
 * client appends for logs.
 */
export function neutralBattleStartError(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "DaemonRpcError") return error;
  const code = "code" in error ? error.code : undefined;
  if (code === ARENA_CONTROL_PLANE_FAILED_CODE) {
    return new Error(i18n.t("battleStart.failed"), { cause: error });
  }
  const userMessage =
    "userMessage" in error && typeof error.userMessage === "string" ? error.userMessage : null;
  return userMessage === null ? error : new Error(userMessage, { cause: error });
}
