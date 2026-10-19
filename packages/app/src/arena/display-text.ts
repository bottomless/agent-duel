/** Where the engine keeps a contestant's text for the reader (`DISPLAY_METADATA_KEY` in the engine). */
const DISPLAY_METADATA_KEY = "arenaDisplay";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The text to show for an assistant text part. A contestant can write `$ARENA_PREVIEW_URL` or
 * `$PASEO_PORT` as it read them in the history; when its run ends, the engine stores the same text
 * with that run's values for the reader.
 */
export function arenaPartDisplayText(part: Record<string, unknown>): string {
  const display = record(record(part.metadata)?.[DISPLAY_METADATA_KEY])?.text;
  if (typeof display === "string") return display;
  return typeof part.text === "string" ? part.text : "";
}
