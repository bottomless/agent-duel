import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

// Mirrors packages/server/.../providers/tool-call-mapper-utils.ts#normalizeToolCallStatus,
// scoped to Arena's OpenCode-only raw tool parts (no other provider vocab to handle).
export type ArenaToolCallStatus = "running" | "completed" | "failed" | "canceled";

const FAILED_STATUS_VOCAB = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "rejected",
  "denied",
]);
const CANCELED_STATUS_VOCAB = new Set(["canceled", "cancelled", "interrupted", "aborted"]);
const COMPLETED_STATUS_VOCAB = new Set(["completed", "complete", "done", "success", "succeeded"]);

export function normalizeArenaToolCallStatus(
  rawStatus: unknown,
  error: unknown,
  output: unknown,
): ArenaToolCallStatus {
  if (error !== undefined && error !== null) return "failed";
  if (typeof rawStatus === "string") {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized.length > 0) {
      if (FAILED_STATUS_VOCAB.has(normalized)) return "failed";
      if (CANCELED_STATUS_VOCAB.has(normalized)) return "canceled";
      if (COMPLETED_STATUS_VOCAB.has(normalized)) return "completed";
      return "running";
    }
  }
  return output !== null && output !== undefined ? "completed" : "running";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g,
    (entity, decimal, hex) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      switch (entity) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default:
          return entity;
      }
    },
  );
}

// OpenCode's read tool wraps file content as `<path>...</path><type>file</type><content>...</content>`.
function extractXmlReadContent(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<path>") || !/<content>/i.test(trimmed)) return undefined;
  const match = trimmed.match(/<content>([\s\S]*?)<\/content>/i);
  if (!match) return undefined;
  const inner = match[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return decodeXmlEntities(inner);
}

const OPENCODE_READ_GUTTER_LINE = /^(\d+): ?(.*)$/;

// OpenCode's read tool bakes a "N: " line-number prefix into each line of
// content, on top of which HighlightedLines draws its own gutter — strip the
// baked-in prefix so the two don't stack. Only strips the leading run of
// sequentially-numbered lines, so trailing tool commentary (e.g. an
// "(End of file - total N lines)" footer) passes through unstripped.
function stripOpenCodeReadGutter(
  content: string,
): { content: string; startLine: number } | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const strippedLines: string[] = [];
  let startLine: number | undefined;
  let expected: number | undefined;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const match = lines[index].match(OPENCODE_READ_GUTTER_LINE);
    if (!match) break;
    const lineNumber = Number.parseInt(match[1], 10);
    if (expected !== undefined && lineNumber !== expected) break;
    if (startLine === undefined) startLine = lineNumber;
    expected = lineNumber + 1;
    strippedLines.push(match[2]);
  }
  if (startLine === undefined) return undefined;
  return { content: strippedLines.concat(lines.slice(index)).join("\n"), startLine };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function deriveShellDetail(
  inputRecord: UnknownRecord | undefined,
  output: unknown,
): ToolCallDetail | undefined {
  const command = nonEmptyString(inputRecord?.command);
  if (!command) return undefined;
  const commandOutput = nonEmptyString(output);
  return {
    type: "shell",
    command,
    ...(commandOutput ? { output: commandOutput } : {}),
  };
}

function deriveReadDetail(
  inputRecord: UnknownRecord | undefined,
  output: unknown,
): ToolCallDetail | undefined {
  const filePath = nonEmptyString(inputRecord?.filePath);
  if (!filePath) return undefined;
  const raw = nonEmptyString(output);
  const unwrapped = raw ? (extractXmlReadContent(raw) ?? raw) : undefined;
  const gutterStripped = unwrapped ? stripOpenCodeReadGutter(unwrapped) : undefined;
  const content = gutterStripped?.content ?? unwrapped;
  const offset =
    gutterStripped?.startLine ??
    (typeof inputRecord?.offset === "number" ? inputRecord.offset : undefined);
  return {
    type: "read",
    filePath,
    ...(content ? { content } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(typeof inputRecord?.limit === "number" ? { limit: inputRecord.limit } : {}),
  };
}

function deriveWriteDetail(inputRecord: UnknownRecord | undefined): ToolCallDetail | undefined {
  const filePath = nonEmptyString(inputRecord?.filePath);
  if (!filePath) return undefined;
  const content = nonEmptyString(inputRecord?.content);
  return {
    type: "write",
    filePath,
    ...(content ? { content } : {}),
  };
}

function deriveEditDetail(inputRecord: UnknownRecord | undefined): ToolCallDetail | undefined {
  const filePath = nonEmptyString(inputRecord?.filePath);
  if (!filePath) return undefined;
  const oldString = nonEmptyString(inputRecord?.oldString);
  const newString = nonEmptyString(inputRecord?.newString);
  return {
    type: "edit",
    filePath,
    ...(oldString ? { oldString } : {}),
    ...(newString ? { newString } : {}),
  };
}

// Converts a raw OpenCode tool part (`{ tool, state: { input, output } }`) into the
// same ToolCallDetail shape the main agent thread renders, for the tool types Arena
// battles actually exercise. Unrecognized tools return undefined and fall back to
// ToolCall's own generic input/output rendering.
export function deriveArenaToolCallDetail(
  tool: string,
  input: unknown,
  output: unknown,
): ToolCallDetail | undefined {
  const inputRecord = asRecord(input);
  switch (tool) {
    case "bash":
    case "shell":
      return deriveShellDetail(inputRecord, output);
    case "read":
      return deriveReadDetail(inputRecord, output);
    case "write":
      return deriveWriteDetail(inputRecord);
    case "edit":
      return deriveEditDetail(inputRecord);
    default:
      return undefined;
  }
}
