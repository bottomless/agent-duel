import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";
import type { StreamItem } from "@/types/stream";
import { battleKeptSide } from "./battle-result";
import { orderArenaChat } from "./chat-order";
import { arenaKeptAnswerRowIds, type ArenaPresentedStream } from "./summary-anchor";

/** Who answered a turn: a battle's kept side, or the chat's single agent. */
export type ArenaTurnAuthor = { kind: "battle"; item: ArenaHistoryItem } | { kind: "agent" };

export interface ArenaTurnHeads {
  /** The row that opens each answer, with who wrote it; the avatar and its name line go above it. */
  heads: ReadonlyMap<string, ArenaTurnAuthor>;
  /** Every row an answer is made of, which the avatar column indents. Prompts are not in it. */
  answerRowIds: ReadonlySet<string>;
  /**
   * The last text of each battle's kept answer, with its battle: the footer that closes that row
   * ends with the battle's result (`ArenaBattleResult`).
   */
  ends: ReadonlyMap<string, ArenaHistoryItem>;
}

/**
 * Each answer in an Agent Duel chat, opened by its author. An answer is the run of rows after a
 * prompt up to the next prompt. A battle's kept answer, which can hold replies sent inside the
 * battle, is the battle's (`arenaKeptAnswerRowIds`); any other run is the single agent's. Hidden
 * rows, such as a kept answer a shown battle stands in for, are simply absent from `stream`.
 * Rows before the first loaded prompt get no head: the chat loads its history a page at a time,
 * and until the page with their prompt arrives nothing says whose answer they are.
 */
export function arenaTurnHeads(
  history: readonly ArenaHistoryItem[],
  stream: ArenaPresentedStream,
  /** The chat's last turn is still running; the chat orders it as the stream view does. */
  lastTurnOpen = false,
): ArenaTurnHeads {
  const rows = orderArenaChat([...stream.tail, ...stream.head], { lastTurnOpen });
  const battleOf = new Map<string, ArenaHistoryItem>();
  for (const item of history) {
    if (!battleKeptSide(item)) continue;
    for (const id of arenaKeptAnswerRowIds(item, stream)) battleOf.set(id, item);
  }
  const heads = new Map<string, ArenaTurnAuthor>();
  const answerRowIds = new Set<string>();
  const lastText = new Map<ArenaHistoryItem, string>();
  // "unknown" until a prompt is seen: an answer cut off from its prompt by paging has no author yet.
  let opened: ArenaHistoryItem | "agent" | "unknown" | null = "unknown";
  for (const row of rows) {
    if (isPrompt(row)) {
      // A reply inside a battle continues that battle's answer rather than opening a new one.
      if (!battleOf.has(row.id)) opened = null;
      continue;
    }
    answerRowIds.add(row.id);
    const battle = battleOf.get(row.id);
    if (battle && row.kind === "assistant_message") lastText.set(battle, row.id);
    if (opened === "unknown") continue;
    const author = battle ?? "agent";
    if (opened === author) continue;
    opened = author;
    heads.set(row.id, battle ? { kind: "battle", item: battle } : { kind: "agent" });
  }
  const ends = new Map([...lastText].map(([battle, row]) => [row, battle]));
  return { heads, answerRowIds, ends };
}

function isPrompt(row: StreamItem): boolean {
  return row.kind === "user_message";
}
