import {
  CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE,
  isContestantTempDirectory,
  isUploadDirectory,
  UPLOAD_DIRECTORY_IN_COMMAND_SOURCE,
} from "./upload-path";

// A path in quotes runs to its closing quote, so a file name keeps its spaces. A bare path ends at
// whitespace or a shell operator.
const UPLOAD_PATH = new RegExp(
  `(["'\`])(?:${UPLOAD_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+([^"'\`\\\\/\\r\\n]*))?\\1` +
    `|(?:${UPLOAD_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+((?:\\\\ |[^\\s"'\`()<>|&;\\\\/])*))?`,
  "gi",
);
const CONTESTANT_TEMP_PATH = new RegExp(
  `(["'\`])(?:${CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+([^"'\`\\r\\n]*))?\\1` +
    // A bare `$TMPDIR` only starts an argument; inside a quoted string it is just text.
    `|(?<!["'\`=\\w])(?:${CONTESTANT_TEMP_DIRECTORY_IN_COMMAND_SOURCE})(?:[\\\\/]+((?:\\\\ |[^\\s"'\`()<>|&;])*))?`,
  "g",
);
const UPLOAD_DIRECTORY_LABEL = "uploads/";

// A redirect such as `2>/dev/null` only hides noise, so a label drops it.
const NULL_REDIRECT_SOURCE = "(?:[12&]?>>?[ \\t]*/dev/null|[12]>&[12])";
const NULL_REDIRECT = new RegExp(`[ \\t]+${NULL_REDIRECT_SOURCE}(?=$|[\\s;&|)])`, "g");
const LEADING_DIRECTORY_CHANGE = new RegExp(
  `^\\s*cd\\s+(?:"([^"]*)"|'([^']*)'|((?:\\\\.|[^\\s;&|])+))(?:[ \\t]+${NULL_REDIRECT_SOURCE})*\\s*(?:&&|;)\\s*`,
);
// An `echo` that stands alone between `&&`, `;`, `||` or line breaks.
const ECHO_SEGMENT =
  /(^|&&|\|\||;|\n)[ \t]*echo(?:[ \t]+-[neE]+)*(?:[ \t]+("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>()]+))?[ \t]*(?=&&|\|\||;|\n|$)/g;
const LEADING_ECHO = /^\s*echo(?:[ \t]+-[neE]+)*[ \t]+("(?:\\.|[^"\\])*"|'[^']*')[ \t]*(?:&&|;)/;
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
const SCRIPT_OUTPUT_NAME =
  "(?:print|pprint(?:\\.pprint)?|console\\.(?:log|table|dir|info|error)|process\\.stdout\\.write|sys\\.stdout\\.write|puts|printf)";
// An output call anywhere on a line, so `if found: print(...)` counts. A method such as
// `page.print(` does not.
const SCRIPT_OUTPUT_CALL = new RegExp(`(?:^|[^\\w.])${SCRIPT_OUTPUT_NAME}\\s*\\(`);
const SCRIPT_OUTPUT_STATEMENT = new RegExp(`^${SCRIPT_OUTPUT_NAME}\\s*\\(`);
const SCRIPT_DIRECTIVE_COMMENT =
  /^(?:#!|(?:#|\/\/)\s*(?:-\*-|coding[:=]|type:|noqa|pylint|eslint|@ts-|shellcheck|prettier))/i;
// Rules such as "=====" or "---" that frame a heading.
// A script inside shell quotes can spell a line break `\\n`, so an escape takes any run of backslashes.
const DECORATION_EDGE_TEST = /^(?:\\+[nrt]|\s)*[=\-#*_~<>.]{2,}|[=\-#*_~<>.]{2,}(?:\\+[nrt]|\s)*$/;
const DECORATION_EDGES = /^(?:\s+|[=\-#*_~<>.]{2,})+|(?:\s+|[=\-#*_~<>.]{2,})+$/g;
const PURE_RULE = /^(?:\\+[nrt]|\s|[=\-#*_~.]{2,})*$/;
const ESCAPED_WHITESPACE = /\\+[nrt]/g;
// `created={...}` or `total: ${...}` inside an f-string or template: the words naming a field.
const TEMPLATE_FIELD_LABEL = /([\p{L}\p{N}_][\p{L}\p{N}_ ./-]*?)\s*[=:]\s*\$?\{/gu;
const LABEL_EDGE_PUNCTUATION = /^[\s|,;:>-]+|[\s:=([{#$|>-]+$/g;
// A word the shell reads the same with or without quotes.
const SIMPLE_SHELL_WORD = /^[\w.@%+:,/-]+$/;
const REPEATED_RULE_EXPRESSION = /^(['"`])[^\p{L}\p{N}"'`]*\1\s*(?:\*\s*\d+|\.repeat\(\d+\))$/u;
const PRINT_KEYWORD_ARGUMENT = /^(?:sep|end|file|flush)\s*=/;
const OBJECT_ENTRY_KEY = /^(?:(["'])([A-Za-z_$][\w$-]*)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/;
const COMPREHENSION_CLAUSE = /\bfor\s+[A-Za-z_(][\w\s,()]*\s+in\b/;
const HAS_WORD = /[\p{L}\p{N}]/u;
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
const MULTILINE_OUTPUT_LIMIT = 80;
const OBJECT_KEY_LIMIT = 4;
const PRINTED_LABEL_LIMIT = 6;

interface ScriptOutput {
  kind: "labeled" | "value" | "indented" | "heading" | "partial";
  text: string;
  /** What the line names: its heading, or the words in front of its values. */
  labels?: string[];
}
const SCRIPT_OUTPUT_PREFERENCE: ScriptOutput["kind"][] = [
  "labeled",
  "value",
  "indented",
  "heading",
  "partial",
];

type OutputToken =
  | { kind: "str"; text: string; framed: boolean; indented: boolean }
  | { kind: "connector"; text: string }
  | { kind: "rule" }
  | { kind: "expr"; text: string };

interface ScriptScan {
  /** The comment that opens the script, when it says what the script is for. */
  description: string | undefined;
  /** Lines past the imports, file loading and helper definitions. */
  work: string[];
  outputs: ScriptOutput[];
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
 * script is reduced to the comment that opens it or the names of what it prints. Returns undefined
 * when the command already reads well. The full command stays on the call's detail, which opens one
 * level below the row.
 */
export function summarizeShellCommand(command: string, cwd?: string): string | undefined {
  const rest = dropUploadVariables(dropLeadingDirectoryChange(command, cwd));
  const script = scriptLines(rest);
  // An `echo` heading ahead of a script names it the way an opening comment would.
  const banner = script ? leadingBanner(rest) : undefined;
  const shellShown = script ? undefined : shellScriptLines(rest);
  const shown = banner ? [banner] : (script?.shown ?? shellShown ?? []);
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
 * A plain shell command written over several lines reads as its commands one after another, the
 * way a script's lines do: the comment that opens it, or else its first two commands. A heredoc or
 * a quoted string that spans lines is left to the caller.
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
  const description = commentDescription(lines[0]);
  if (description !== undefined) return [description];
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

/** The words of an `echo` that opens a command, past any `cd`, when it reads as a description. */
function leadingBanner(command: string): string | undefined {
  let rest = command;
  for (let match = LEADING_DIRECTORY_CHANGE.exec(rest); match; ) {
    rest = rest.slice(match[0].length);
    match = LEADING_DIRECTORY_CHANGE.exec(rest);
  }
  const quoted = LEADING_ECHO.exec(rest)?.[1];
  if (!quoted) return undefined;
  const text = stripDecoration(echoText(quoted));
  return HAS_WORD.test(text) && text.includes(" ") && !text.includes("$") ? text : undefined;
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
  const names: string[] = [];
  for (const match of command.matchAll(UPLOAD_PATH)) {
    const name = (match[2] ?? match[3]?.replace(/\\ /g, " "))?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function shortenUploadPaths(text: string, unquote: boolean): string {
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
 * their loading and looping, so the row shows what sets this one apart: the comment that opens the
 * script when the agent wrote one, otherwise the names of what it prints, otherwise its first lines
 * past the setup.
 */
function scriptLines(command: string): ScriptLines | undefined {
  const written = fileWritingHeredoc(command);
  if (written) {
    const scan = scanScript(written.body);
    return {
      shown: [written.target, ...shownScriptLines(scan)],
      openedFileNames: scan.openedFileNames,
      fileTarget: written.target,
    };
  }
  const body = heredocBody(command) ?? evalBody(command);
  if (body === undefined) return undefined;
  const scan = scanScript(body);
  return { shown: shownScriptLines(scan), openedFileNames: scan.openedFileNames };
}

function shownScriptLines({ description, work, outputs }: ScriptScan): string[] {
  if (description !== undefined) return [description];
  // A script of one line that does more than print reads best whole.
  const readsWhole = work.length === 1 && !SCRIPT_OUTPUT_STATEMENT.test(work[0]);
  const output = readsWhole ? undefined : (printedLabels(outputs) ?? representativeOutput(outputs));
  return output === undefined ? work.slice(0, SCRIPT_WORK_LINE_LIMIT) : [output];
}

/**
 * A script that prints several named things is described by those names, in order: its headings
 * and the labels in front of its values. One name alone says too little, so that case falls back
 * to the single best output line.
 */
function printedLabels(outputs: ScriptOutput[]): string | undefined {
  const collect = (includeIndented: boolean): string[] => {
    const labels: string[] = [];
    for (const output of outputs) {
      if (output.kind === "partial") continue;
      if (output.kind === "indented" && !includeIndented) continue;
      for (const label of output.labels ?? []) {
        const seen = labels.some((known) => known.toLowerCase() === label.toLowerCase());
        if (!seen) labels.push(label);
      }
    }
    return labels;
  };
  // Indented prints are sub-lines under a label, so they name the row only when the script has
  // fewer than two labels of its own — as when every label is printed with a leading indent.
  const own = collect(false);
  const labels = own.length >= 2 ? own : collect(true);
  if (labels.length < 2) return undefined;
  const shown = labels.slice(0, PRINTED_LABEL_LIMIT).join(", ");
  return labels.length > PRINTED_LABEL_LIMIT ? `${shown}, …` : shown;
}

/** Sorts a script's lines into the comment that opens it, setup, helpers, and lines that do work. */
function scanScript(body: string): ScriptScan {
  const scan: ScriptScan = { description: undefined, work: [], outputs: [], openedFileNames: [] };
  let previousWasDescription = false;
  let helperIndent: number | undefined;
  let pendingOutput: { text: string; lines: number } | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (pendingOutput !== undefined) {
      pendingOutput = consumeOutputContinuation(pendingOutput, line, scan.outputs);
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (helperIndent !== undefined && indent > helperIndent) continue;
    helperIndent = undefined;
    const followsDescription = previousWasDescription;
    previousWasDescription = false;
    if (SCRIPT_DEFINITION.test(line)) {
      // The comment described this helper, not the script.
      if (followsDescription) scan.description = undefined;
      helperIndent = indent;
      continue;
    }
    if (scan.description === undefined && scan.work.length === 0) {
      scan.description = commentDescription(line);
      previousWasDescription = scan.description !== undefined;
      if (previousWasDescription) continue;
    }
    if (isScriptSetup(line)) {
      addOpenedFileNames(line, scan.openedFileNames);
      continue;
    }
    scan.work.push(line);
    pendingOutput = startOutputCall(line, scan.outputs);
  }
  if (pendingOutput !== undefined) {
    outputsPushPartial(pendingOutput.text, scan.outputs);
  }
  return scan;
}

function outputsPushPartial(text: string, outputs: ScriptOutput[]): void {
  if (!pushClosedOutputCalls(text, outputs)) outputs.push({ kind: "partial", text });
}

function startOutputCall(
  line: string,
  outputs: ScriptOutput[],
): { text: string; lines: number } | undefined {
  if (!SCRIPT_OUTPUT_CALL.test(line)) return undefined;
  return pushClosedOutputCalls(line, outputs) ? undefined : { text: line, lines: 1 };
}

function consumeOutputContinuation(
  pending: { text: string; lines: number },
  line: string,
  outputs: ScriptOutput[],
): { text: string; lines: number } | undefined {
  const next = { text: `${pending.text} ${line}`, lines: pending.lines + 1 };
  if (pushClosedOutputCalls(next.text, outputs)) return undefined;
  if (next.lines < MULTILINE_OUTPUT_LIMIT) return next;
  outputs.push({ kind: "partial", text: next.text });
  return undefined;
}

/**
 * Parses every output call on `text` (so `print('='*80); print('rows', n)` reaches the second
 * call). Returns false when the last call continues onto the next line.
 */
function pushClosedOutputCalls(text: string, outputs: ScriptOutput[]): boolean {
  let rest = text;
  while (SCRIPT_OUTPUT_CALL.test(rest)) {
    const call = firstOutputCall(rest);
    if (!call) return false;
    const output = parseOutputArguments(call.args);
    if (output) outputs.push(output);
    rest = rest.slice(call.end);
  }
  return true;
}

function addOpenedFileNames(line: string, names: string[]): void {
  for (const match of line.matchAll(BARE_FILE_NAME)) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
}

/** A comment that opens a script says what it is for. A lone word or a tool directive does not. */
function commentDescription(line: string): string | undefined {
  if (!SCRIPT_COMMENT.test(line) || SCRIPT_DIRECTIVE_COMMENT.test(line)) return undefined;
  const text = stripDecoration(line.replace(/^(?:#+|\/\/+)/, "")).replace(/[:.]$/, "");
  return HAS_WORD.test(text) && text.includes(" ") ? text : undefined;
}

/**
 * The output line that best stands for a script, without its logging call: a labeled value first,
 * then a bare value, then an indented sub-line, then a heading. A heading directly above a dumped
 * object is joined to that object's keys; above any other value the heading stands alone, since
 * the value is the code that fetches what the heading already names.
 */
function representativeOutput(outputs: ScriptOutput[]): string | undefined {
  const merged: ScriptOutput[] = [];
  let heading: string | undefined;
  for (const output of outputs) {
    if (heading !== undefined) {
      const labeled = output.kind === "value";
      const text =
        labeled && output.text.startsWith("{ ")
          ? joinLabel(heading, output.text)
          : withoutTrailingColon(heading);
      merged.push({ kind: labeled ? "labeled" : "heading", text });
      heading = undefined;
      if (labeled) continue;
    }
    if (output.kind === "heading") heading = output.text;
    else merged.push(output);
  }
  if (heading !== undefined) merged.push({ kind: "heading", text: withoutTrailingColon(heading) });

  for (const kind of SCRIPT_OUTPUT_PREFERENCE) {
    const found = merged.find((output) => output.kind === kind);
    if (found) return found.text;
  }
  return undefined;
}

function parseOutputArguments(args: string): ScriptOutput | undefined {
  const tokens = splitTopLevel(args, ",")
    .filter((arg) => !PRINT_KEYWORD_ARGUMENT.test(arg))
    .map(parseOutputArgument);
  const hadRule = tokens.some((token) => token.kind === "rule");
  const kept = tokens.filter(
    (token): token is Exclude<OutputToken, { kind: "rule" }> => token.kind !== "rule",
  );
  if (kept.length === 0) return undefined;

  const first = kept[0];
  const rest = kept.slice(1);
  // Past the first argument only a string that ends like a label names a value: `'| vendor:'`.
  const named = rest.filter(
    (token) => token.kind === "str" && (token.text.endsWith(":") || token.text.endsWith("=")),
  );
  if (first.kind !== "str") {
    return { kind: "value", text: joinOutputTokens(kept), labels: labelsOf(named) };
  }

  const framed = hadRule || first.framed;
  if (framed) {
    const text = rest.length > 0 ? `${first.text} ${joinOutputTokens(rest)}` : first.text;
    return HAS_WORD.test(text) ? { kind: "heading", text, labels: labelsOf([first]) } : undefined;
  }
  if (rest.length > 0) {
    return {
      kind: first.indented ? "indented" : "labeled",
      text: joinLabel(first.text, joinOutputTokens(rest)),
      labels: labelsOf([first, ...named]),
    };
  }
  // An f-string or template carries its values inside the label, unless it ends as a heading.
  if (!first.text.includes("{") || first.text.endsWith(":")) {
    return { kind: "heading", text: first.text, labels: labelsOf([first]) };
  }
  return {
    kind: first.indented ? "indented" : "labeled",
    text: first.text,
    labels: labelsOf([first]),
  };
}

function labelsOf(tokens: OutputToken[]): string[] {
  const labels: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "str") continue;
    const found = token.text.includes("{") ? templateLabels(token.text) : [token.text];
    for (const label of found) {
      const clean = label.replace(LABEL_EDGE_PUNCTUATION, "");
      // A bracketed marker like `[middle]` separates printed sections; it names none of them.
      if (clean.startsWith("[") && clean.endsWith("]")) continue;
      if (HAS_WORD.test(clean)) labels.push(clean);
    }
  }
  return labels;
}

/** The field names in an f-string or template, or else the words ahead of its first value. */
function templateLabels(text: string): string[] {
  const fields = Array.from(text.matchAll(TEMPLATE_FIELD_LABEL), (match) => match[1]);
  return fields.length > 0 ? fields : [text.slice(0, text.indexOf("{"))];
}

function parseOutputArgument(arg: string): OutputToken {
  if (REPEATED_RULE_EXPRESSION.test(arg)) return { kind: "rule" };
  const raw = wholeStringLiteral(arg);
  if (raw !== undefined) {
    if (PURE_RULE.test(raw)) return { kind: "rule" };
    const framed = DECORATION_EDGE_TEST.test(raw);
    const indented = /^(?:\\+[nr])* {2,}/.test(raw);
    const text = stripDecoration(raw);
    if (!HAS_WORD.test(text)) {
      const symbol = raw.replace(ESCAPED_WHITESPACE, " ").trim();
      return symbol ? { kind: "connector", text: symbol } : { kind: "rule" };
    }
    return { kind: "str", text, framed, indented };
  }
  return { kind: "expr", text: summarizeObjectKeys(arg) ?? collapse(arg) };
}

function joinOutputTokens(tokens: Exclude<OutputToken, { kind: "rule" }>[]): string {
  let result = tokens[0]?.text ?? "";
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (previous.kind === "str" && (previous.text.endsWith(":") || previous.text.endsWith("="))) {
      result = joinLabel(result, current.text);
    } else if (previous.kind === "expr" && current.kind === "expr") {
      result = `${result}, ${current.text}`;
    } else {
      result = `${result} ${current.text}`;
    }
  }
  return result;
}

/** Summarizes an object literal or `JSON.stringify({ ... })` dump by its top-level keys. */
function summarizeObjectKeys(expression: string): string | undefined {
  const target = unwrapJsonStringify(expression.trim());
  if (!target.startsWith("{") || !target.endsWith("}")) return undefined;
  const inner = target.slice(1, -1).trim();
  if (!inner || COMPREHENSION_CLAUSE.test(inner)) return undefined;

  const keys: string[] = [];
  for (const entry of splitTopLevel(inner, ",")) {
    if (!entry || entry.startsWith("...")) continue;
    const match = OBJECT_ENTRY_KEY.exec(entry);
    const key = match?.[2] ?? match?.[3];
    if (!key) return undefined;
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length < 2) return undefined;
  const shown = keys.slice(0, OBJECT_KEY_LIMIT).join(", ");
  return keys.length > OBJECT_KEY_LIMIT ? `{ ${shown}, … }` : `{ ${shown} }`;
}

function unwrapJsonStringify(expression: string): string {
  const match = /^JSON\.stringify\s*\(([\s\S]*)\)$/.exec(expression);
  if (!match) return expression;
  return splitTopLevel(match[1], ",")[0] ?? expression;
}

/** Splits `text` on `delimiter` outside quotes and nested brackets. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === delimiter && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** Unquotes `arg` when the entire argument is one string literal. */
function wholeStringLiteral(arg: string): string | undefined {
  const opening = /^(?:[rfb]{1,2})?(["'`])/.exec(arg);
  const quote = opening?.[1];
  if (!opening || !quote || !arg.endsWith(quote)) return undefined;
  const contentStart = opening[0].length;
  for (let index = contentStart; index < arg.length; index += 1) {
    if (arg[index] === "\\") {
      index += 1;
      continue;
    }
    if (arg[index] === quote) {
      return index === arg.length - 1 ? arg.slice(contentStart, index) : undefined;
    }
  }
  return undefined;
}

/** The arguments and closing offset of the first output call on `text`, or undefined if unclosed. */
function firstOutputCall(text: string): { args: string; end: number } | undefined {
  const call = SCRIPT_OUTPUT_CALL.exec(text);
  if (!call) return undefined;
  const start = call.index + call[0].length;
  let depth = 1;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { args: text.slice(start, index).trim(), end: index + 1 };
    }
  }
  return undefined;
}

function joinLabel(label: string, value: string): string {
  if (label.endsWith("=")) return `${label}${value}`;
  return label.endsWith(":") ? `${label} ${value}` : `${label}: ${value}`;
}

function withoutTrailingColon(text: string): string {
  return text.replace(/\s*:$/, "");
}

function stripDecoration(text: string): string {
  return text
    .replace(ESCAPED_WHITESPACE, " ")
    .replace(DECORATION_EDGES, "")
    .replace(/\s+/g, " ")
    .trim();
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
