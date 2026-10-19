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
