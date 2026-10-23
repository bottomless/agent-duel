import { describeToolCall, type ToolCallRun } from "@/tool-calls/detail-level/grouping";
import { arenaWorkSummaryLabel, isSearchTool, type ArenaWorkSummary } from "./work-summary";

/**
 * A battle chat's work row reads as the battle pane's does (`summarizeArenaWork`), from the same
 * counts in the same order, so a winner's transcript keeps its words after the vote.
 */
export function arenaChatWorkLabel(run: ToolCallRun, active: boolean): string {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  const summary: ArenaWorkSummary = {
    editedFileCount: 0,
    readFileCount: 0,
    commandCount: 0,
    searchCount: 0,
    otherToolCount: 0,
    reasoningCount: 0,
  };
  for (const item of run.items) {
    if (item.kind === "thought") {
      summary.reasoningCount += 1;
      continue;
    }
    const { detail, name } = describeToolCall(item);
    if (detail.type === "edit" || detail.type === "write") editedFiles.add(detail.filePath);
    else if (detail.type === "read") readFiles.add(detail.filePath);
    else if (detail.type === "shell") summary.commandCount += 1;
    else if (detail.type === "search" || isSearchTool(name)) summary.searchCount += 1;
    else summary.otherToolCount += 1;
  }
  summary.editedFileCount = editedFiles.size;
  summary.readFileCount = readFiles.size;
  return arenaWorkSummaryLabel(summary, active);
}
