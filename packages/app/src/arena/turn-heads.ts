import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";
import type { StreamItem } from "@/types/stream";
import { isTurnBoundary } from "@/agent-stream/turn-membership";
import { battleKeptSide } from "./battle-result";
import { orderArenaChat } from "./chat-order";
import {
  isGroupableReasoning,
  isGroupableToolCall,
  isSubagentCall,
} from "@/tool-calls/detail-level/grouping";
import { arenaKeptAnswerRowIds, type ArenaPresentedStream } from "./summary-anchor";

/** Who answered a turn: a battle's kept side, or the chat's single agent. */
export type ArenaTurnAuthor = { kind: "battle"; item: ArenaHistoryItem } | { kind: "agent" };

export interface ArenaTurnHeads {
  /** The row that opens each answer, with who wrote it; the avatar and its name line go above it. */
  heads: ReadonlyMap<string, ArenaTurnAuthor>;
  /** Every row an answer is made of, which the avatar column indents. Prompts are not in it. */
  answerRowIds: ReadonlySet<string>;
  /**
   * The row whose footer closes each battle's kept answer, with its battle: that footer ends with
   * the battle's result (`ArenaBattleResult`). It is the answer's last text, or, in an answer with
   * none, such as one stopped before writing any, the row that draws its last run of work.
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
  const lastRow = new Map<ArenaHistoryItem, number>();
  // "unknown" until a prompt is seen: an answer cut off from its prompt by paging has no author yet.
  let opened: ArenaHistoryItem | "agent" | "unknown" | null = "unknown";
  for (const [index, row] of rows.entries()) {
    if (isPrompt(row)) {
      // A reply inside a battle continues that battle's answer rather than opening a new one.
      if (!battleOf.has(row.id)) opened = null;
      continue;
    }
    answerRowIds.add(row.id);
    const battle = battleOf.get(row.id);
    if (battle) lastRow.set(battle, index);
    if (battle && row.kind === "assistant_message") lastText.set(battle, row.id);
    if (opened === "unknown") continue;
    const author = battle ?? "agent";
    if (opened === author) continue;
    opened = author;
    // A run of work is drawn under its first row's id (`prepareGroupedHistory`), reasoning included.
    heads.set(row.id, battle ? { kind: "battle", item: battle } : { kind: "agent" });
  }
  const ends = new Map<string, ArenaHistoryItem>();
  for (const [battle, index] of lastRow) {
    const row = lastText.get(battle) ?? workRunRowId(rows, index);
    if (row) ends.set(row, battle);
  }
  return { heads, answerRowIds, ends };
}

/**
 * The row a battle chat draws for the run of work that ends at `rows[index]`: reasoning and the
 * calls around it are one run (`prepareGroupedHistory` with the arena rules), drawn under the id of
 * its first row. The footer of an answer with no text closes that row.
 */
function workRunRowId(rows: readonly StreamItem[], index: number): string | undefined {
  const last = rows[index]!;
  // A subagent call stands alone and is drawn as its own row.
  if (!isWork(last)) return last.kind === "tool_call" ? last.id : undefined;
  let first = index;
  while (first > 0 && isWork(rows[first - 1]!) && !isTurnBoundary(rows[first - 1]!, rows[first]!))
    first -= 1;
  return rows[first]!.id;
}

function isWork(row: StreamItem): boolean {
  return isGroupableReasoning(row) || (isGroupableToolCall(row) && !isSubagentCall(row));
}

function isPrompt(row: StreamItem): boolean {
  return row.kind === "user_message";
}
