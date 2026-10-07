import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { deriveArenaToolCallDetail, normalizeArenaToolCallStatus } from "./tool-call-detail";
import { isArenaQuestionPart } from "./question";
import { arenaReasoningPartIsActive } from "./run-thread-selection";

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
  isSubagent: (part: unknown) => boolean = () => false,
): ArenaActivitySegment[] {
  const segments: ArenaActivitySegment[] = [];
  const leading: ArenaActivityPart[] = [];
  let current: ArenaActivitySegment | null = null;

  for (const messageId of messageIds) {
    const parts = partsByMessage[messageId] ?? [];
    for (const [partIndex, part] of parts.entries()) {
      const entry = { messageId, partIndex, part };
      const standalone = isArenaQuestionPart(part) || isSubagent(part);
      if (standalone && leading.length > 0) {
        segments.push({
          key: `${leading[0].messageId}:activity`,
          content: null,
          trailing: leading.splice(0),
        });
      }
      if (partIsTextUpdate(part) || standalone) {
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

function arenaWorkPartIsActive(part: unknown, runState: ArenaRun["runState"]): boolean {
  if (runState !== "pending") return false;
  if (arenaReasoningPartIsActive({ runState }, part)) return true;

  const record = asRecord(part);
  if (record?.type !== "tool") return false;
  const state = asRecord(record.state);
  return normalizeArenaToolCallStatus(state?.status, state?.error, state?.output) === "running";
}

export type ArenaWorkPresentation =
  | { kind: "summary" | "reasoning"; label: string; active: boolean }
  | {
      kind: "tool";
      label: string;
      secondaryLabel?: string;
      toolName: string;
      detail?: ToolCallDetail;
      active: boolean;
      failed: boolean;
    };

export function arenaRunIsAwaitingResponse(
  run: Pick<ArenaRun, "runState" | "messages" | "parts">,
): boolean {
  if (run.runState !== "pending") return false;
  const message = asRecord(run.messages?.at(-1));
  if (message?.role !== "assistant" || typeof message.id !== "string") return false;
  if (typeof asRecord(message.time)?.completed === "number") return false;
  const parts = run.parts?.[message.id] ?? [];
  return !parts.some((part) => arenaPartIsWork(part) || partIsTextUpdate(part));
}

interface ArenaWorkPresentationInput {
  parts: readonly unknown[];
  runState: ArenaRun["runState"];
  isLatest: boolean;
  awaitingResponse: boolean;
}

export function presentArenaWork({
  parts,
  runState,
  isLatest,
  awaitingResponse,
}: ArenaWorkPresentationInput): ArenaWorkPresentation {
  if (!isLatest) {
    return {
      kind: "summary",
      label: arenaWorkSummaryLabel(summarizeArenaWork(parts), false),
      active: false,
    };
  }

  const waitingForModel = awaitingResponse && runState === "pending";
  if (waitingForModel) return { kind: "reasoning", label: "Thinking…", active: true };

  // Completion can arrive out of order. It controls animation, never recency.
  const current = parts.at(-1);
  const active = arenaWorkPartIsActive(current, runState);
  const record = asRecord(current);
  if (record?.type !== "tool") {
    return { kind: "reasoning", label: active ? "Reasoning…" : "Reasoned", active };
  }
  const state = asRecord(record.state) ?? {};
  const toolName = typeof record.tool === "string" ? record.tool : "tool";
  const detail = deriveArenaToolCallDetail(toolName, state.input, state.output);
  const status = normalizeArenaToolCallStatus(state.status, state.error, state.output);
  const display = buildToolCallDisplayModel({
    name: toolName,
    status,
    metadata: { subAgentActivity: asRecord(state.input)?.description },
    error: state.error ?? null,
    detail: detail ?? {
      type: "unknown",
      input: state.input ?? null,
      output: state.output ?? null,
    },
  });
  return {
    kind: "tool",
    label: display.displayName,
    secondaryLabel: display.summary,
    toolName,
    detail,
    active,
    failed: status === "failed",
  };
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
