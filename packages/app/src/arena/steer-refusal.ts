import type { ArenaReplyTarget } from "@getpaseo/protocol/arena/rpc-schemas";
import { i18n } from "@/i18n/i18next";

/**
 * A steer the engine refused because a side was closing its turn, in the app's words: the client's
 * error text carries the request type and code, and the engine's text is English only. Any other
 * error unchanged.
 */
export function arenaSteerRefusalOr(error: unknown, target: ArenaReplyTarget): unknown {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code !== "arena_side_closing") return error;
  return new Error(
    target === "both"
      ? i18n.t("arenaSteer.sideClosingBoth")
      : i18n.t("arenaSteer.sideClosing", { side: target.toUpperCase() }),
  );
}
