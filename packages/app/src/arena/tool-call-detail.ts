import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { stripCwdPrefix } from "@getpaseo/protocol/path-utils";
import { shortenHomePaths, summarizeShellCommand } from "./shell-command-summary";
import { contestantTempDirectoryOf, isUploadDirectory, uploadDirectoryOf } from "./upload-path";

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

// Arena's v2 Core tool inputs use `path`; keep the legacy `filePath` fallback
// because stored Arena runs from the previous engine still use that shape.
function inputFilePath(inputRecord: UnknownRecord | undefined): string | undefined {
  return nonEmptyString(inputRecord?.path) ?? nonEmptyString(inputRecord?.filePath);
}

function deriveShellDetail(
  inputRecord: UnknownRecord | undefined,
  output: unknown,
  cwd: string | undefined,
): ToolCallDetail | undefined {
  const command = nonEmptyString(inputRecord?.command);
  if (!command) return undefined;
  const commandOutput = nonEmptyString(output);
  const summary = summarizeShellCommand(command, cwd);
  return {
    type: "shell",
    command,
    ...(summary ? { summary } : {}),
    ...(commandOutput ? { output: commandOutput } : {}),
  };
}

function deriveReadDetail(
  inputRecord: UnknownRecord | undefined,
  output: unknown,
  cwd: string | undefined,
): ToolCallDetail | undefined {
  const filePath = inputFilePath(inputRecord);
  if (!filePath) return undefined;
  const raw = nonEmptyString(output);
  const unwrapped = raw ? (extractXmlReadContent(raw) ?? raw) : undefined;
  const gutterStripped = unwrapped ? stripOpenCodeReadGutter(unwrapped) : undefined;
  const content = gutterStripped?.content ?? unwrapped;
  const offset =
    gutterStripped?.startLine ??
    (typeof inputRecord?.offset === "number" ? inputRecord.offset : undefined);
  const limit = typeof inputRecord?.limit === "number" ? inputRecord.limit : undefined;
  const summary =
    readRootSummary(filePath, cwd) ?? readRangeSummary(filePath, inputRecord?.offset, limit, cwd);
  return {
    type: "read",
    filePath,
    ...(summary ? { summary } : {}),
    ...(content ? { content } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function deriveWriteDetail(inputRecord: UnknownRecord | undefined): ToolCallDetail | undefined {
  const filePath = inputFilePath(inputRecord);
  if (!filePath) return undefined;
  const content = nonEmptyString(inputRecord?.content);
  return {
    type: "write",
    filePath,
    ...(content ? { content } : {}),
  };
}

function deriveEditDetail(inputRecord: UnknownRecord | undefined): ToolCallDetail | undefined {
  const filePath = inputFilePath(inputRecord);
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

/**
 * A read of the worktree root lists the whole project, and a path relative to the worktree would
 * be a bare `.`, so the row names the project: the checkout the battle copied the worktree from.
 */
function readRootSummary(filePath: string, cwd: string | undefined): string | undefined {
  const root = cwd ? trimTrailingSeparators(cwd) : undefined;
  if (!root || trimTrailingSeparators(filePath) !== root) return undefined;
  const checkout = /^(.*)[\\/]\.agent-duel(?:[\\/]|$)/.exec(root)?.[1];
  const base = (checkout ?? root).split(/[\\/]/).pop();
  return base && base !== "." ? base : undefined;
}

/**
 * An agent pages through a long file, and every page would otherwise be the same row. A read that
 * starts past the top carries its lines the way an editor link does: `notes.md:120-199`.
 */
function readRangeSummary(
  filePath: string,
  offset: unknown,
  limit: number | undefined,
  cwd: string | undefined,
): string | undefined {
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset <= 1) return undefined;
  const shown = stripCwdPrefix(filePath, displayDirectoryOf(filePath, cwd));
  const pageEnd = limit !== undefined && limit > 0 ? offset + limit - 1 : undefined;
  return pageEnd === undefined ? `${shown}:${offset}+` : `${shown}:${offset}-${pageEnd}`;
}

/**
 * The directory a file's row is shown relative to. An uploaded file or a scratch file lives
 * outside the worktree, under a long daemon or temp path, so it is shown relative to that folder
 * and reads by its short name.
 */
function displayDirectoryOf(filePath: string, cwd: string | undefined): string | undefined {
  const worktree = cwd ? trimTrailingSeparators(cwd) : undefined;
  if (worktree && filePath.startsWith(`${worktree}/`)) return cwd;
  return uploadDirectoryOf(filePath) ?? contestantTempDirectoryOf(filePath) ?? cwd;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

// Mirrors the daemon's OpenCode mapping: a loaded skill reads as its name, and opens to its text.
function deriveSkillDetail(
  inputRecord: UnknownRecord | undefined,
  output: unknown,
): ToolCallDetail | undefined {
  const name = (nonEmptyString(inputRecord?.id) ?? nonEmptyString(inputRecord?.name))?.trim();
  if (!name) return undefined;
  const text = nonEmptyString(output);
  return { type: "plain_text", label: name, icon: "sparkles", ...(text ? { text } : {}) };
}

/**
 * Glob and Grep rows read as `pattern include in folder`, with the folder relative to the worktree
 * and left out when it is the worktree itself. Their output lists worktree files the same way.
 */
function deriveSearchDetail(
  toolName: "glob" | "grep",
  inputRecord: UnknownRecord | undefined,
  output: unknown,
  cwd: string | undefined,
): ToolCallDetail | undefined {
  const pattern = nonEmptyString(inputRecord?.pattern);
  if (!pattern) return undefined;
  const include = nonEmptyString(inputRecord?.include);
  const folder = searchFolderLabel(nonEmptyString(inputRecord?.path), cwd);
  const query = [pattern, include, folder && `in ${folder}`].filter(Boolean).join(" ");
  const raw = nonEmptyString(output);
  const worktree = cwd?.replace(/[\\/]+$/, "");
  const content = raw && worktree ? raw.split(`${worktree}/`).join("") : raw;
  return { type: "search", query, toolName, ...(content ? { content } : {}) };
}

function searchFolderLabel(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.replace(/[\\/]+$/, "");
  const worktree = cwd?.replace(/[\\/]+$/, "");
  if (trimmed === "." || trimmed === worktree) return undefined;
  if (worktree && trimmed.startsWith(`${worktree}/`)) return trimmed.slice(worktree.length + 1);
  if (isUploadDirectory(trimmed)) return "uploads/";
  const upload = uploadDirectoryOf(trimmed);
  return upload ? trimmed.slice(upload.length + 1) : shortenHomePaths(trimmed, cwd);
}

// Converts a raw OpenCode tool part (`{ tool, state: { input, output } }`) into the
// same ToolCallDetail shape the main agent thread renders, for the tool types Arena
// battles actually exercise. Unrecognized tools return undefined and fall back to
// ToolCall's own generic input/output rendering. `cwd` is the contestant's worktree; a shell
// row's summary shows paths inside it relative to it.
export function deriveArenaToolCallDetail(
  tool: string,
  input: unknown,
  output: unknown,
  cwd?: string,
): ToolCallDetail | undefined {
  const inputRecord = asRecord(input);
  switch (tool) {
    case "bash":
    case "shell":
      return deriveShellDetail(inputRecord, output, cwd);
    case "read":
      return deriveReadDetail(inputRecord, output, cwd);
    case "write":
      return deriveWriteDetail(inputRecord);
    case "edit":
      return deriveEditDetail(inputRecord);
    case "glob":
    case "grep":
      return deriveSearchDetail(tool, inputRecord, output, cwd);
    case "skill":
      return deriveSkillDetail(inputRecord, output);
    default:
      return undefined;
  }
}

/** The directory a call's row shows its file path relative to. */
export function arenaToolCallDisplayCwd(
  detail: ToolCallDetail | undefined,
  cwd: string | undefined,
): string | undefined {
  if (detail?.type !== "read" && detail?.type !== "edit" && detail?.type !== "write") return cwd;
  return displayDirectoryOf(detail.filePath, cwd);
}
