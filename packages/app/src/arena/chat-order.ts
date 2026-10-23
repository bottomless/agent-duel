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
 * (tool calls and reasoning) moves beneath that text, where it joins the work that follows it.
 * A subagent or a question before the first text stays where it is, after the work before it,
 * and the work after it stays with it, as the pane's own rows do. Anything else before the first
 * text (a task checklist, a call that is not grouped) keeps the work before it above it, in
 * conversation order. Returns `items` itself when nothing moves.
 */
export function orderArenaChat(items: StreamItem[]): StreamItem[] {
  const output: StreamItem[] = [];
  let leading: StreamItem[] = [];
  let segmentStarted = false;
  let moved = false;

  for (const item of items) {
    if (item.kind === "user_message") {
      // A turn that never wrote text keeps its work where it was.
      output.push(...leading, item);
      leading = [];
      segmentStarted = false;
      continue;
    }
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
      moved ||= leading.length > 0;
      output.push(item, ...leading);
      leading = [];
      continue;
    }
    output.push(...leading, item);
    leading = [];
    if (standsAlone(item)) segmentStarted = true;
  }
  output.push(...leading);
  return moved ? output : items;
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
export function orderArenaChatHead(pending: StreamItem[], head: StreamItem[]): StreamItem[] | null {
  if (pending.length === 0 || head.length === 0) return null;
  const joined = [...pending, ...head];
  const ordered = orderArenaChat(joined);
  return ordered === joined ? null : ordered;
}
