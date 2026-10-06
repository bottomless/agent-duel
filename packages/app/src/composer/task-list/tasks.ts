import type { StreamItem, TodoEntry } from "@/types/stream";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

export function ordinaryTaskListState({
  arenaSupported,
  battleMode,
  battleIsActive,
  history,
}: {
  arenaSupported: boolean;
  battleMode: boolean;
  battleIsActive: boolean;
  history: readonly Pick<ArenaHistoryItem, "index" | "endedAt">[] | undefined;
}): { visible: false } | { visible: true; battleEndedAt: string | null } {
  if (battleIsActive) return { visible: false };
  if (!arenaSupported) return { visible: true, battleEndedAt: null };
  if (battleMode || history === undefined) return { visible: false };
  const latestBattle = history.reduce<(typeof history)[number] | undefined>(
    (latest, item) => (!latest || item.index > latest.index ? item : latest),
    undefined,
  );
  if (latestBattle && latestBattle.endedAt === undefined) return { visible: false };
  return { visible: true, battleEndedAt: latestBattle?.endedAt ?? null };
}

export function tasksAfterBattle(
  items: readonly StreamItem[],
  battleEndedAt: string | null,
): TodoEntry[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user_message") return [];
    if (item?.kind !== "todo_list") continue;
    // Winner tasks are replayed into the canonical chat with their original timestamps.
    if (battleEndedAt && item.timestamp.getTime() <= Date.parse(battleEndedAt)) return [];
    return item.items;
  }
  return [];
}
