import { deriveArenaToolCallDetail } from "./tool-call-detail";
import { isArenaQuestionPart } from "./question";

type UnknownRecord = Record<string, unknown>;

export interface ArenaWorkSummary {
  editedFileCount: number;
  readFileCount: number;
  commandCount: number;
  searchCount: number;
  otherToolCount: number;
  reasoningCount: number;
}

export interface ArenaActivityPart {
  messageId: string;
  partIndex: number;
  part: unknown;
}

export interface ArenaActivitySegment {
  key: string;
  content: ArenaActivityPart | null;
  trailing: ArenaActivityPart[];
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function partType(part: unknown): string | undefined {
  const type = asRecord(part)?.type;
  return typeof type === "string" ? type : undefined;
}

function partIsTextUpdate(part: unknown): boolean {
  const record = asRecord(part);
  return record?.type === "text" && typeof record.text === "string" && record.text.length > 0;
}

/**
 * Questions stay in conversation order, including work before the first question.
 * Other leading work moves beneath the first contestant text update.
 */
export function projectArenaActivitySegments(
  messageIds: readonly string[],
  partsByMessage: Readonly<Record<string, readonly unknown[] | undefined>>,
): ArenaActivitySegment[] {
  const segments: ArenaActivitySegment[] = [];
  const leading: ArenaActivityPart[] = [];
  let current: ArenaActivitySegment | null = null;

  for (const messageId of messageIds) {
    const parts = partsByMessage[messageId] ?? [];
    for (const [partIndex, part] of parts.entries()) {
      const entry = { messageId, partIndex, part };
      const question = isArenaQuestionPart(part);
      if (question && leading.length > 0) {
        segments.push({
          key: `${leading[0].messageId}:activity`,
          content: null,
          trailing: leading.splice(0),
        });
      }
      if (partIsTextUpdate(part) || question) {
        if (current) segments.push(current);
        current = {
          key: `${messageId}:${partIndex}`,
          content: entry,
          trailing: segments.length === 0 ? leading.splice(0) : [],
        };
      } else if (current) {
        current.trailing.push(entry);
      } else {
        leading.push(entry);
      }
    }
  }

  if (current) segments.push(current);
  if (segments.length === 0 && leading.length > 0) {
    segments.push({
      key: `${leading[0].messageId}:activity`,
      content: null,
      trailing: leading,
    });
  }
  return segments;
}

/** Tool calls and thinking — everything in a turn that is not the answer itself. */
export function arenaPartIsWork(part: unknown): boolean {
  const type = partType(part);
  return type === "tool" || type === "reasoning" || type === "thought";
}

function isSearchTool(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  return (
    normalized === "grep" ||
    normalized === "glob" ||
    normalized === "search" ||
    normalized === "web_search" ||
    normalized === "llm_context" ||
    /(?:^|[_.:/])(?:web_search|llm_context)$/.test(normalized)
  );
}

interface ArenaFileToolSummary {
  kind: "edited" | "read";
  filePath: string;
}

interface ArenaCountedToolSummary {
  kind: "command" | "search" | "other";
}

type ArenaToolSummary = ArenaFileToolSummary | ArenaCountedToolSummary;

function summarizeToolPart(part: UnknownRecord): ArenaToolSummary {
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const state = asRecord(part.state);
  const detail = deriveArenaToolCallDetail(tool, state?.input, state?.output);
  if (detail?.type === "edit" || detail?.type === "write") {
    return { kind: "edited", filePath: detail.filePath };
  }
  if (detail?.type === "read") return { kind: "read", filePath: detail.filePath };
  if (detail?.type === "shell") return { kind: "command" };
  if (detail?.type === "search" || isSearchTool(tool)) return { kind: "search" };
  return { kind: "other" };
}

export function summarizeArenaWork(parts: readonly unknown[]): ArenaWorkSummary {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  let reasoningCount = 0;

  for (const part of parts) {
    const record = asRecord(part);
    const type = partType(part);
    if (type === "reasoning" || type === "thought") {
      reasoningCount += 1;
      continue;
    }
    if (type !== "tool") continue;

    if (!record) continue;
    const toolSummary = summarizeToolPart(record);
    switch (toolSummary.kind) {
      case "edited":
        editedFiles.add(toolSummary.filePath);
        break;
      case "read":
        readFiles.add(toolSummary.filePath);
        break;
      case "command":
        commandCount += 1;
        break;
      case "search":
        searchCount += 1;
        break;
      case "other":
        otherToolCount += 1;
        break;
    }
  }

  return {
    editedFileCount: editedFiles.size,
    readFileCount: readFiles.size,
    commandCount,
    searchCount,
    otherToolCount,
    reasoningCount,
  };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hasWork(summary: ArenaWorkSummary): boolean {
  return (
    summary.editedFileCount > 0 ||
    summary.readFileCount > 0 ||
    summary.commandCount > 0 ||
    summary.searchCount > 0 ||
    summary.otherToolCount > 0 ||
    summary.reasoningCount > 0
  );
}

export function arenaWorkSummaryLabel(summary: ArenaWorkSummary, active: boolean): string {
  if (!hasWork(summary)) return active ? "Working…" : "Worked";

  const labels: string[] = [];
  if (summary.readFileCount > 0) {
    labels.push(
      `${active ? "Reading" : "Read"} ${countLabel(summary.readFileCount, "file", "files")}`,
    );
  }
  if (summary.commandCount > 0) {
    labels.push(
      `${active ? "Running" : "Ran"} ${countLabel(summary.commandCount, "command", "commands")}`,
    );
  }
  if (summary.editedFileCount > 0) {
    labels.push(
      `${active ? "Editing" : "Edited"} ${countLabel(summary.editedFileCount, "file", "files")}`,
    );
  }
  if (summary.searchCount > 0) {
    labels.push(
      `${active ? "Running" : "Ran"} ${countLabel(summary.searchCount, "search", "searches")}`,
    );
  }
  if (summary.otherToolCount > 0) {
    labels.push(
      `${active ? "Using" : "Used"} ${countLabel(summary.otherToolCount, "other tool", "other tools")}`,
    );
  }
  if (summary.reasoningCount > 0 && labels.length === 0) {
    labels.push(active ? "Reasoning…" : "Reasoned");
  }
  return labels.join(" · ");
}
