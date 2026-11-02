import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type { StreamItem } from "@/types/stream";

export function replaceShellRestartErrors(
  items: StreamItem[],
  stops: ArenaSnapshot["chat"]["shellStops"] = [],
  notice: string,
): StreamItem[] {
  let changed = false;
  const result = items.map((item) => {
    if (item.kind !== "assistant_message") return item;
    if (item.text !== "[System Error] OpenCode server exited with code null") return item;
    const at = item.timestamp.getTime();
    if (!stops.some((stop) => at >= stop.startedAt && at <= stop.stoppedAt)) return item;
    changed = true;
    return { ...item, text: notice };
  });
  return changed ? result : items;
}
