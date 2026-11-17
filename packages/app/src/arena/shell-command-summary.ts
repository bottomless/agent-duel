import {
  CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE,
  CONTESTANT_TEMP_DIRECTORY_IN_QUOTED_COMMAND_SOURCE,
  isContestantTempDirectory,
  isUploadDirectory,
  mentionsContestantTempDirectory,
  mentionsUploadDirectory,
  UPLOAD_DIRECTORY_IN_COMMAND_SOURCE,
  UPLOAD_DIRECTORY_IN_QUOTED_COMMAND_SOURCE,
} from "./upload-path";

// A path in quotes runs to its closing quote, so a file name keeps its spaces. A bare path ends at
// whitespace or a shell operator.
const UPLOAD_PATH = new RegExp(
  `(["'\`])(?:${UPLOAD_DIRECTORY_IN_QUOTED_COMMAND_SOURCE})(?:[\\\\/]+([^"'\`\\\\/\\r\\n]*))?\\1` +
    `|(?:${UPLOAD_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+((?:\\\\ |[^\\s"'\`()<>|&;\\\\/])*))?`,
  "gi",
);
const CONTESTANT_TEMP_PATH = new RegExp(
  `(["'\`])(?:${CONTESTANT_TEMP_DIRECTORY_IN_QUOTED_COMMAND_SOURCE})(?:[\\\\/]+([^"'\`\\r\\n]*))?\\1` +
    // A bare `$TMPDIR` only starts an argument; inside a quoted string it is just text.
    `|(?<!["'\`=\\w])(?:${CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+((?:\\\\ |[^\\s"'\`()<>|&;])*))?`,
  "g",
);
const UPLOAD_DIRECTORY_LABEL = "uploads/";

// A /dev/null redirect only hides noise, so a label drops it. `2>&1` stays: it changes where the
// command's output goes, and so does the /dev/null redirect written beside it, in either order:
// dropping half the pair leaves the other half reading as if that stream were shown. The
// lookbehinds keep the pattern out of the middle of a whitespace run, where rescanning every
// position would cost a long indent quadratically.
const NULL_REDIRECT_SOURCE = "[12&]?>>?[ \\t]*/dev/null";
const NULL_REDIRECT = new RegExp(
  `(?<![12]>&[12])(?<![ \\t])[ \\t]+${NULL_REDIRECT_SOURCE}(?=$|[\\s;&|)])(?![ \\t]+[12]>&[12])`,
  "g",
);
// A dropped `cd` takes its own redirects with it, `2>&1` included.
const LEADING_DIRECTORY_CHANGE = new RegExp(
  `^\\s*cd\\s+(?:"([^"]*)"|'([^']*)'|((?:\\\\.|[^\\s;&|])+))(?:[ \\t]+(?:${NULL_REDIRECT_SOURCE}|[12]>&[12]))*\\s*(?:&&|;)\\s*`,
);
// An `echo` that stands alone between `&&`, `;`, `||` or line breaks.
const ECHO_SEGMENT =
  /(^|&&|\|\||;|\n)[ \t]*echo(?:[ \t]+-[neE]+)*(?:[ \t]+("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>()]+))?[ \t]*(?=&&|\|\||;|\n|$)/g;
const DANGLING_OPERATORS = /^(?:\s*(?:&&|\|\||;))+|(?:(?:&&|\|\||;)\s*)+$/g;
const DOUBLED_OPERATORS = /(&&|\|\||;)(?:\s*(?:&&|\|\||;))+/g;
const HOME_DIRECTORY = /^(?:\/Users|\/home)\/[^\\/]+(?=\/)/;
// `ls -la .` names nothing: a directory argument that is the worktree itself is the default.
const REDUNDANT_DOT_ARGUMENT =
  /(^|&&|\|\||;|\n)([ \t]*ls(?:[ \t]+-[A-Za-z]+)*)[ \t]+(?:"\."|'\.'|\.)(?=[ \t]*(?:&&|\|\||;|\n|$))/g;

const INTERPRETER =
  "(?:env[ \\t]+)?(?:[^\\s\"'`]*[\\\\/])?(?:python[\\d.]*|node|deno|bun|ruby|perl|php|bash|sh|zsh)(?![A-Za-z0-9_.-])";
const HEREDOC_START = new RegExp(
  `(?:^|[\\n;&|])[ \\t]*${INTERPRETER}[^\\n]*<<-?[ \\t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1[^\\n]*\\r?\\n`,
  "i",
);
const WRITE_HEREDOC_START =
  /(?:^|&&|\|\||[\n;|])[ \t]*cat[ \t]+>[ \t]*("[^"\n]+"|'[^'\n]+'|(?:\\.|[^\s;&|<>])+)[ \t]+<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\r?\n/;
const WRITE_HEREDOC_SETUP = /^(?:mkdir[ \t]+[^;&|\n]+|cd[ \t]+[^;&|\n]+)$/;
const SHELL_ASSIGNMENT = /^(?:export[ \t]+)?([A-Za-z_]\w*)=([^;&|\n]+)$/;
// A value safe to substitute into the row: a path, never a command substitution.
const SUBSTITUTABLE_VALUE = /^[A-Za-z0-9_./${}-]+$/;
const SCRIPT_TARGET = /\.(?:[cm]?[jt]sx?|py|rb|php|pl|sh|bash|zsh)$/i;
const EVAL_START = new RegExp(
  `(?:^|[\\n;&|])[ \\t]*${INTERPRETER}(?:[ \\t]+-[^\\s"']*)*?[ \\t]+(?:-c|-e|--eval|-p|--print)[ \\t]+(["'])`,
  "i",
);

const SCRIPT_IMPORT =
  /^(?:import\s|from\s+\S+\s+import\b|(?:const|let|var)\s+[\w{},\s]+=\s*require\s*\(|require\s*\()/;
const SCRIPT_FILE_LOAD =
  /^(?:(?:const|let|var)\s+)?\w+\s*=\s*(?:await\s+)?(?:json\.loads?\s*\(|JSON\.parse\s*\(|yaml\.\w+\s*\(|open\s*\(|Path\s*\(|pathlib\.\w+\s*\(|(?:fs\.)?readFile(?:Sync)?\s*\(|fs\.|pd\.read_\w+\s*\(|csv\.\w+\s*\()/;
const SCRIPT_LITERAL_ASSIGNMENT =
  /^(?:(?:const|let|var)\s+)?\w+\s*=\s*(?:[rfb]?(['"`])[^'"`]*\1|-?\d[\d_.]*)\s*;?$/;
const SCRIPT_WITH_OPEN = /^with\s+open\s*\(/;
const SCRIPT_COMMENT = /^(?:#|\/\/)/;
const SCRIPT_SEPARATOR_PRINT =
  /^(?:print|console\.log)\s*\(\s*(?:(['"`])[^\w'"`]*\1(?:\s*\*\s*\d+|\.repeat\(\d+\))?)?\s*\)\s*;?$/;
const SCRIPT_PUNCTUATION = /^[)}\];,\s]+$/;
const SCRIPT_DEFINITION =
  /^(?:(?:async\s+)?(?:def|class|function)\s|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>))/;
// Rules such as "=====" or "---" that frame an `echo` heading. `echo -e` spells a line break
// `\n`, so an escape takes any run of backslashes.
const DECORATION_EDGE_TEST = /^(?:\\+[nrt]|\s)*[=\-#*_~<>.]{2,}|[=\-#*_~<>.]{2,}(?:\\+[nrt]|\s)*$/;
const PURE_RULE = /^(?:\\+[nrt]|\s|[=\-#*_~.]{2,})*$/;
// A word the shell reads the same with or without quotes.
const SIMPLE_SHELL_WORD = /^[\w.@%+:,/-]+$/;
// `F="<upload>/data.json"` ahead of the commands that read `"$F"`.
const FILE_VARIABLE_ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)[ \t]*(?:\r?\n|;|&&)\s*/;
const UPLOAD_DIRECTORY_TEST = new RegExp(UPLOAD_DIRECTORY_IN_COMMAND_SOURCE, "i");
// A line that hands on to the next one: a trailing `\`, pipe or `&&`/`||`.
const LINE_CONTINUES = /(?:\\|\||&&)[ \t]*$/;
const LINE_IS_CONTINUATION = /^\s*(?:\||&&)/;
const BARE_FILE_NAME = /(["'`])([^"'`\\/\s][^"'`\\/]*\.[A-Za-z0-9]{1,8})\1/g;

const MAX_SUMMARY_LENGTH = 200;
const SCRIPT_WORK_LINE_LIMIT = 2;

interface ScriptScan {
  /** Lines past the imports, file loading and helper definitions. */
  work: string[];
  /** Files the skipped setup lines open by bare name. */
  openedFileNames: string[];
}

interface ScriptLines {
  shown: string[];
  openedFileNames: string[];
  /** A file-writing heredoc leads with its target instead of the files it reads. */
  fileTarget?: string;
}

/**
 * A shell row's label when the command's own text buries what it does: paths into an upload, temp
 * folder or contestant worktree are shortened, a `cd` into any of them is dropped, and a multi-line
 * script is reduced to its first lines past the setup. Returns undefined when the command already
 * reads well. The full command stays on the call's detail, which opens one level below the row.
 */
export function summarizeShellCommand(command: string, cwd?: string): string | undefined {
  const rest = dropUploadVariables(dropLeadingDirectoryChange(command, cwd));
  const script = scriptLines(rest);
  const shellShown = script ? undefined : shellScriptLines(rest);
  const shown = script?.shown ?? shellShown ?? [];
  const body = shown.length > 0 ? shown.join(" · ") : withoutShellNoise(rest);
  // Quotes inside a script are part of its code; only a plain shell argument can lose them.
  const unquote = !script && !EVAL_START.test(rest);
  // The worktree goes first: it can sit inside a folder the later patterns would also match.
  const shortened = shortenHomePaths(
    shortenContestantTempPaths(
      shortenUploadPaths(shortenWorktreePaths(body, cwd), unquote),
      unquote,
    ),
    cwd,
  ).replace(REDUNDANT_DOT_ARGUMENT, "$1$2");
  const detail = collapse(shortened);
  if (!detail) return undefined;

  // The files the script opens name it when its own path line is skipped or the file is a copy.
  // A copy adds nothing once the upload it came from already leads the row.
  const fileNames = script?.fileTarget ? [] : uploadFileNames(command);
  if (script && !script.fileTarget && fileNames.length === 0) {
    for (const name of script.openedFileNames) {
      if (!fileNames.includes(name)) fileNames.push(name);
    }
  }
  // The file leads only when the detail no longer names it, as when a script's path line is skipped.
  const leading = fileNames.filter((name) => !detail.includes(name));
  const summary = leading.length > 0 ? `${leading.join(", ")} · ${detail}` : detail;
  return summary === collapse(command) ? undefined : clamp(summary);
}

function dropLeadingDirectoryChange(command: string, cwd: string | undefined): string {
  const worktree = cwd ? trimTrailingSeparators(cwd) : undefined;
  let rest = command;
  for (;;) {
    const match = LEADING_DIRECTORY_CHANGE.exec(rest);
    if (!match) break;
    const target = match[1] ?? match[2] ?? match[3]?.replace(/\\(.)/g, "$1") ?? "";
    const intoScratch = isUploadDirectory(target) || isContestantTempDirectory(target);
    if (!intoScratch && trimTrailingSeparators(target) !== worktree) break;
    rest = rest.slice(match[0].length);
  }
  return rest;
}

/**
 * An agent often names an upload once, `F="<upload>/data.json"`, and passes `"$F"` to each command
 * after it. The upload's file name already leads the row, so the assignment and every `$F` go.
 */
function dropUploadVariables(command: string): string {
  if (!mentionsUploadDirectory(command)) return command;
  let rest = command;
  const names: string[] = [];
  for (;;) {
    const match = FILE_VARIABLE_ASSIGNMENT.exec(rest);
    if (!match || !UPLOAD_DIRECTORY_TEST.test(match[2])) break;
    names.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  for (const name of names) {
    const reference = new RegExp(
      `[ \\t]+(?:"\\$\\{?${name}\\}?"|\\$\\{?${name}\\}?(?![\\w"]))(?=$|[\\s;&|)<>])`,
      "gm",
    );
    rest = rest.replace(reference, "");
  }
  return rest;
}

/**
 * A plain shell command written over several lines reads as its commands one after another: its
 * first two, with comments passed over. A heredoc or a quoted string that spans lines is left to
 * the caller.
 */
function shellScriptLines(command: string): string[] | undefined {
  const physical = withoutShellNoise(command).trim().split(/\r?\n/);
  if (physical.length < 2 || command.includes("<<")) return undefined;
  const lines: string[] = [];
  for (const raw of physical) {
    const line = raw.trim();
    if (!line) continue;
    const previous = lines.at(-1);
    if (
      previous !== undefined &&
      (LINE_CONTINUES.test(previous) || LINE_IS_CONTINUATION.test(line))
    ) {
      lines[lines.length - 1] = `${previous.replace(/\\$/, "").trimEnd()} ${line}`;
    } else {
      lines.push(line);
    }
  }
  if (lines.length < 2 || !lines.every(hasBalancedQuotes)) return undefined;
  return lines.filter((line) => !SCRIPT_COMMENT.test(line)).slice(0, SCRIPT_WORK_LINE_LIMIT);
}

function hasBalancedQuotes(line: string): boolean {
  const unescaped = line.replace(/\\./g, "");
  let open: string | undefined;
  for (const char of unescaped) {
    if (open === undefined && (char === '"' || char === "'")) open = char;
    else if (char === open) open = undefined;
  }
  return open === undefined;
}

/**
 * Drops what only frames a command's output: `echo` lines that print a rule or a `=== heading ===`
 * between the real commands, and redirects to /dev/null.
 */
function withoutShellNoise(command: string): string {
  const withoutBanners = command.replace(
    ECHO_SEGMENT,
    (segment, lead: string, argument?: string) => {
      const text = argument === undefined ? "" : echoText(argument);
      const banner = PURE_RULE.test(text) || DECORATION_EDGE_TEST.test(text);
      return banner ? lead : segment;
    },
  );
  return withoutBanners
    .replace(DOUBLED_OPERATORS, "$1")
    .replace(DANGLING_OPERATORS, "")
    .replace(NULL_REDIRECT, "");
}

function echoText(argument: string): string {
  if (argument.startsWith("'")) return argument.slice(1, -1);
  if (argument.startsWith('"')) return argument.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return argument;
}

function uploadFileNames(command: string): string[] {
  if (!mentionsUploadDirectory(command)) return [];
  const names: string[] = [];
  for (const match of command.matchAll(UPLOAD_PATH)) {
    const name = (match[2] ?? match[3]?.replace(/\\ /g, " "))?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function shortenUploadPaths(text: string, unquote: boolean): string {
  if (!mentionsUploadDirectory(text)) return text;
  return text.replace(
    UPLOAD_PATH,
    (
      match,
      quote: string | undefined,
      quotedName: string | undefined,
      bareName,
      offset: number,
    ) => {
      const name = (quote ? quotedName : bareName) || UPLOAD_DIRECTORY_LABEL;
      return quotedAsBefore(name, quote, unquote, text, offset, match.length);
    },
  );
}

function shortenContestantTempPaths(text: string, unquote: boolean): string {
  if (!mentionsContestantTempDirectory(text)) return text;
  return text.replace(
    CONTESTANT_TEMP_PATH,
    (
      match,
      quote: string | undefined,
      quotedName: string | undefined,
      bareName,
      offset: number,
    ) => {
      const name = (quote ? quotedName : bareName) || ".";
      return quotedAsBefore(name, quote, unquote, text, offset, match.length);
    },
  );
}

/**
 * A shortened path keeps the quotes it had, except as a shell argument that no longer needs them:
 * a long path is quoted for its spaces, and its bare file name often has none.
 */
function quotedAsBefore(
  name: string,
  quote: string | undefined,
  unquote: boolean,
  text: string,
  offset: number,
  length: number,
): string {
  if (!quote) return name;
  const before = text[offset - 1];
  const after = text[offset + length];
  const standsAlone =
    (before === undefined || /\s/.test(before)) && (after === undefined || /[\s;&|)]/.test(after));
  return unquote && standsAlone && SIMPLE_SHELL_WORD.test(name) ? name : `${quote}${name}${quote}`;
}

function shortenWorktreePaths(text: string, cwd: string | undefined): string {
  const worktree = cwd ? trimTrailingSeparators(cwd) : "";
  if (!worktree) return text;
  // The worktree has to start a path and end at a separator, so a sibling directory whose name
  // only begins the same way is left alone.
  const pattern = new RegExp(
    `(^|[\\s"'\`=(:,;|&<>])${escapeRegExp(worktree)}(?:([\\\\/]+)(?=[^\\s"'\`)|&;<>])|[\\\\/]*(?![\\w.-]))`,
    "g",
  );
  return text.replace(pattern, (_match, lead: string, separator?: string) =>
    separator ? lead : `${lead}.`,
  );
}

/** Shows paths under the home directory the worktree sits in, such as the main checkout, as `~/…`. */
export function shortenHomePaths(text: string, cwd: string | undefined): string {
  const home = cwd ? HOME_DIRECTORY.exec(cwd)?.[0] : undefined;
  if (!home) return text;
  const pattern = new RegExp(
    `(^|[\\s"'\`=(:,;|&<>])${escapeRegExp(home)}(?=[\\\\/]|$|[\\s"'\`)|&;<>])`,
    "g",
  );
  return text.replace(pattern, (_match, lead: string) => `${lead}~`);
}

/**
 * What to show for a heredoc or a multi-line `-c`/`-e` script. Scripts that probe one file share
 * their loading and looping, so the row shows what sets this one apart: its first lines past the
 * setup.
 */
function scriptLines(command: string): ScriptLines | undefined {
  const written = fileWritingHeredoc(command);
  if (written) {
    const scan = scanScript(written.body);
    return {
      shown: [written.target, ...scan.work.slice(0, SCRIPT_WORK_LINE_LIMIT)],
      openedFileNames: scan.openedFileNames,
      fileTarget: written.target,
    };
  }
  const body = heredocBody(command) ?? evalBody(command);
  if (body === undefined) return undefined;
  const scan = scanScript(body);
  return {
    shown: scan.work.slice(0, SCRIPT_WORK_LINE_LIMIT),
    openedFileNames: scan.openedFileNames,
  };
}

/** Sorts a script's lines into setup, helpers, and lines that do work. */
function scanScript(body: string): ScriptScan {
  const scan: ScriptScan = { work: [], openedFileNames: [] };
  let helperIndent: number | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const indent = raw.length - raw.trimStart().length;
    if (helperIndent !== undefined && indent > helperIndent) continue;
    helperIndent = undefined;
    if (SCRIPT_DEFINITION.test(line)) {
      helperIndent = indent;
      continue;
    }
    if (isScriptSetup(line)) {
      addOpenedFileNames(line, scan.openedFileNames);
      continue;
    }
    scan.work.push(line);
  }
  return scan;
}

function addOpenedFileNames(line: string, names: string[]): void {
  for (const match of line.matchAll(BARE_FILE_NAME)) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
}

function heredocBody(command: string): string | undefined {
  const start = HEREDOC_START.exec(command);
  const delimiter = start?.[2];
  if (!start || !delimiter) return undefined;
  return heredocBodyAt(command, start.index + start[0].length, delimiter);
}

/**
 * `cat > detail.mjs <<'EOF'` is a script too, but its target is the name the row needs. Only an
 * echoed scratch directory, `mkdir` and `cd` may precede it; real work before it stays whole.
 */
function fileWritingHeredoc(command: string): { body: string; target: string } | undefined {
  const start = WRITE_HEREDOC_START.exec(command);
  if (!start) return undefined;
  const variables = new Map<string, string>();
  for (const line of setupLines(command.slice(0, start.index))) {
    const assignment = SHELL_ASSIGNMENT.exec(line);
    if (assignment) variables.set(assignment[1], assignment[2].trim());
    else if (!isWriteHeredocSetup(line)) return undefined;
  }
  const target = resolveShellVariables(unquotedTarget(start[1]), variables);
  if (!SCRIPT_TARGET.test(target)) return undefined;
  return {
    body: heredocBodyAt(command, start.index + start[0].length, start[3]),
    target,
  };
}

function setupLines(prefix: string): string[] {
  return prefix
    .split(/&&|;|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unquotedTarget(token: string): string {
  if (token.startsWith('"') || token.startsWith("'")) return token.slice(1, -1);
  return token.replace(/\\(.)/g, "$1");
}

/** Replaces `$name` with the value the command assigned, so `$W/an/a1.py` reads `an/a1.py`. */
function resolveShellVariables(value: string, variables: Map<string, string>): string {
  if (variables.size === 0) return value;
  let resolved = value;
  for (let pass = 0; pass <= variables.size; pass += 1) {
    const next = resolved.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (match, name: string) => {
      const replacement = variables.get(name);
      return replacement !== undefined && SUBSTITUTABLE_VALUE.test(replacement)
        ? replacement
        : match;
    });
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

function isWriteHeredocSetup(line: string): boolean {
  if (WRITE_HEREDOC_SETUP.test(line)) return true;
  const argument = /^echo(?:[ \t]+-[neE]+)*[ \t]+("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)$/.exec(
    line,
  )?.[1];
  if (!argument) return false;
  const text = echoText(argument);
  return text === "." || isContestantTempDirectory(text);
}

function heredocBodyAt(command: string, bodyStart: number, delimiter: string): string {
  const body = command.slice(bodyStart);
  const closing = body.search(new RegExp(`^\\s*${escapeRegExp(delimiter)}\\s*$`, "m"));
  return closing === -1 ? body : body.slice(0, closing);
}

function evalBody(command: string): string | undefined {
  const start = EVAL_START.exec(command);
  const quote = start?.[1];
  if (!start || !quote) return undefined;
  const body = quotedText(command, start.index + start[0].length, quote);
  // A one-line script already reads as a command.
  return body.includes("\n") ? body : undefined;
}

function quotedText(text: string, start: number, quote: string): string {
  let body = "";
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === "\\" && '"\\$`'.includes(text[index + 1] ?? "")) {
      body += text[index + 1];
      index += 1;
      continue;
    }
    if (char === quote) {
      if (quote !== "'" || !text.startsWith("'\\''", index)) return body;
      body += "'";
      index += 3;
      continue;
    }
    body += char;
  }
  return body;
}

function isScriptSetup(line: string): boolean {
  return (
    SCRIPT_IMPORT.test(line) ||
    SCRIPT_FILE_LOAD.test(line) ||
    SCRIPT_LITERAL_ASSIGNMENT.test(line) ||
    SCRIPT_WITH_OPEN.test(line) ||
    SCRIPT_COMMENT.test(line) ||
    SCRIPT_SEPARATOR_PRINT.test(line) ||
    SCRIPT_PUNCTUATION.test(line)
  );
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(summary: string): string {
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
  return `${summary.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
}
