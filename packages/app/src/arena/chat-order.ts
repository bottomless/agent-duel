import type { StreamItem } from "@/types/stream";
import {
  isGroupableReasoning,
  isGroupableToolCall,
  isSubagentCall,
} from "@/tool-calls/detail-level/grouping";
import { arenaTimelineQuestionResult } from "./question";

function isWork(item: StreamItem): boolean {
  return (isGroupableToolCall(item) && !isSubagentCall(item)) || isGroupableReasoning(item);
}

/** A row the pane gives its own segment: the work after it stays with it, before any later text. */
function standsAlone(item: StreamItem): boolean {
  if (item.kind !== "tool_call") return false;
  return isSubagentCall(item) || arenaTimelineQuestionResult(item) !== null;
}

/**
 * A battle chat reads the way its battle panes did (`projectArenaActivitySegments`), so a winner's
 * transcript keeps its shape after the vote. Work an agent does in a turn before its first text
 * (tool calls and reasoning) moves beneath that text, where it joins the work that follows it,
 * unless that text is the last thing the turn shows: a final answer is not followed by the work that
 * led to it. A subagent or a question before the first text stays where it is, after the work
 * before it, and the work after it stays with it, as the pane's own rows do. Anything else before
 * the first text (a task checklist, a call that is not grouped) keeps the work before it above it,
 * in conversation order. A turn that has ended moves reasoning written after its last text, with
 * nothing after it, above that text; `lastTurnOpen` says the last turn is still running, where the
 * text may not be the last yet. Returns `items` itself when nothing moves.
 */
export function orderArenaChat(
  items: StreamItem[],
  options: { lastTurnOpen?: boolean } = {},
): StreamItem[] {
  const output: StreamItem[] = [];
  let moved = false;
  let start = 0;
  const flush = (end: number) => {
    const turn = items.slice(start, end);
    const settled = end < items.length || options.lastTurnOpen !== true;
    const ordered = orderTurn(settled ? foldTrailingReasoning(turn) : turn);
    moved ||= ordered.some((item, index) => item !== turn[index]);
    output.push(...ordered);
  };
  for (const [index, item] of items.entries()) {
    if (item.kind !== "user_message") continue;
    flush(index);
    output.push(item);
    start = index + 1;
  }
  flush(items.length);
  return moved ? output : items;
}

/** Reasoning after a turn's last text, with nothing after it, goes above that text. */
function foldTrailingReasoning(turn: StreamItem[]): StreamItem[] {
  const last = turn.findLastIndex((item) => item.kind === "assistant_message");
  if (last < 0 || last === turn.length - 1) return turn;
  const after = turn.slice(last + 1);
  if (!after.every(isGroupableReasoning)) return turn;
  return [...turn.slice(0, last), ...after, turn[last]!];
}

/** One turn, without its prompt, in the pane's order. */
function orderTurn(turn: StreamItem[]): StreamItem[] {
  const output: StreamItem[] = [];
  let leading: StreamItem[] = [];
  let segmentStarted = false;
  for (const [index, item] of turn.entries()) {
    if (segmentStarted) {
      output.push(item);
      continue;
    }
    if (isWork(item)) {
      leading.push(item);
      continue;
    }
    if (item.kind === "assistant_message") {
      segmentStarted = true;
      // The turn's only row after its work is its answer: the work stays above it.
      if (index === turn.length - 1) output.push(...leading, item);
      else output.push(item, ...leading);
      leading = [];
      continue;
    }
    output.push(...leading, item);
    leading = [];
    if (standsAlone(item)) segmentStarted = true;
  }
  output.push(...leading);
  return output;
}

/**
 * Where the work a later text could still pull beneath it starts in an ordered tail: the work at its
 * end, when the current turn has written no text and shown no subagent or question yet.
 * `tail.length` when there is none.
 */
export function arenaChatPendingWorkStart(tail: StreamItem[]): number {
  let start = tail.length;
  while (start > 0 && isWork(tail[start - 1]!)) start -= 1;
  if (start === tail.length) return start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const item = tail[index]!;
    if (item.kind === "user_message") break;
    if (item.kind === "assistant_message" || standsAlone(item)) return tail.length;
  }
  return start;
}

/**
 * The live head, ordered with the tail's pending work (`arenaChatPendingWorkStart`) as
 * `orderArenaChat` orders a whole turn, or null when the head's text pulls nothing beneath it. The
 * text that ends a turn's leading work can still be in the head: an answer while it streams, or a
 * winner's answer copied in at the vote, which no turn completion commits. The caller then renders
 * the tail without that work, and this head after it.
 */
export function orderArenaChatHead(
  pending: StreamItem[],
  head: StreamItem[],
  options: { lastTurnOpen?: boolean } = {},
): StreamItem[] | null {
  if (pending.length === 0 || head.length === 0) return null;
  const joined = [...pending, ...head];
  const ordered = orderArenaChat(joined, options);
  return ordered === joined ? null : ordered;
}
