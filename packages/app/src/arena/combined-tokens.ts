import { isLanguageSupported, type HighlightToken } from "@getpaseo/highlight";
import type { ArenaFileContent } from "@getpaseo/protocol/arena/rpc-schemas";
import { extensionFromPath, tokenizeToLines } from "@/utils/highlight-cache";
import { fileLines, type CombinedLine, type CombinedRow } from "./combined-diff";

export type CombinedLineWithTokens = CombinedLine & { tokens?: HighlightToken[] };
export type CombinedRowWithTokens =
  | (Extract<CombinedRow, { kind: "shared" | "added" | "removed" }> & {
      line: CombinedLineWithTokens;
    })
  | (Extract<CombinedRow, { kind: "conflict" }> & {
      a: CombinedLineWithTokens[];
      base: CombinedLineWithTokens[];
      b: CombinedLineWithTokens[];
    });

/**
 * Tokens for a line, only if they spell it. A token run is looked up by line
 * number, and a wrong number would colour the row with another line's code
 * without anything noticing; the text is the check.
 */
export function tokensSpelling(
  tokens: readonly HighlightToken[] | undefined,
  content: string,
): HighlightToken[] | undefined {
  if (!tokens) return undefined;
  let length = 0;
  for (const token of tokens) length += token.text.length;
  if (length !== content.length) return undefined;
  return tokens.map((token) => token.text).join("") === content ? [...tokens] : undefined;
}

/** Whether the highlighter has a grammar for this path. */
export function syntaxExtension(path: string): string | null {
  const ext = extensionFromPath(path);
  return ext && isLanguageSupported(`x.${ext}`) ? ext : null;
}

/**
 * Attaches syntax tokens to every combined line. Each side's file is
 * tokenized whole, so multi-line strings and comments keep their context,
 * and a line takes its tokens from the side that has it. Base lines and
 * lines neither side has are tokenized on their own.
 */
export function attachCombinedTokens(
  rows: readonly CombinedRow[],
  input: { aText: string; bText: string; ext: string | null },
): CombinedRowWithTokens[] {
  if (!input.ext) return rows as CombinedRowWithTokens[];
  const ext = input.ext;
  const tokensA = tokenizeToLines(fileLines(input.aText).join("\n"), ext);
  const tokensB = tokenizeToLines(fileLines(input.bText).join("\n"), ext);
  const single = (content: string) => tokenizeToLines(content, ext)?.[0];
  const withTokens = (line: CombinedLine): CombinedLineWithTokens => {
    const tokens =
      tokensSpelling(line.lineA !== null ? tokensA?.[line.lineA - 1] : undefined, line.content) ??
      tokensSpelling(line.lineB !== null ? tokensB?.[line.lineB - 1] : undefined, line.content) ??
      single(line.content);
    return tokens ? { ...line, tokens } : line;
  };
  return rows.map((row) =>
    row.kind === "conflict"
      ? {
          ...row,
          a: row.a.map(withTokens),
          base: row.base.map(withTokens),
          b: row.b.map(withTokens),
        }
      : { ...row, line: withTokens(row.line) },
  );
}

export type LineTokenMap = ReadonlyMap<number, HighlightToken[]>;

/**
 * Tokens for one side of a file, keyed by line number. Windowed content is
 * the retained runs joined, so the regions say which number each line has.
 */
export function sideTokenMap(side: ArenaFileContent | undefined, ext: string | null): LineTokenMap {
  const map = new Map<number, HighlightToken[]>();
  if (!ext || !side || side.missing) return map;
  const lines = fileLines(side.content);
  const tokens = tokenizeToLines(lines.join("\n"), ext);
  if (!tokens) return map;
  if (!side.regions || side.regions.length === 0) {
    tokens.forEach((lineTokens, index) => map.set(index + 1, lineTokens));
    return map;
  }
  let offset = 0;
  for (const region of side.regions) {
    for (let index = 0; index < region.lines; index += 1) {
      const lineTokens = tokens[offset + index];
      if (lineTokens) map.set(region.start + index, lineTokens);
    }
    offset += region.lines;
  }
  return map;
}
