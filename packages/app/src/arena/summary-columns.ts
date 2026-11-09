/**
 * The comparison report split along the battle's two columns, so each side's part sits under that
 * side's answer. The judge is asked for "one or two sentences for Agent A, then one or two for
 * Agent B" and a table with the columns Aspect, Agent A, Agent B (`arena/comparison.ts`); nothing
 * enforces that shape, so anything that does not split cleanly returns null and the report is
 * shown whole.
 */
export interface SummaryRow {
  aspect: string;
  a: string;
  b: string;
}

export interface SummaryColumns {
  /** What Agent A did, without the "Agent A" subject. */
  a: string;
  b: string;
  /** Sentences about both agents, such as a shared mistake. */
  shared: string | null;
  rows: SummaryRow[];
}

const DIFFER_HEADING = /(?:^|\n)[ \t]*(?:#+[ \t]*)?(?:\*\*)?where they differ(?:\*\*)?:?[ \t]*/i;
const DID_HEADING = /^\s*(?:#+[ \t]*)?(?:\*\*)?what each agent did(?:\*\*)?:?\s*/i;
const OPENING_QUOTES = new Set(['"', "“"]);
const CLOSING_QUOTES = new Set(['"', "”"]);

export function parseSummaryColumns(report: string): SummaryColumns | null {
  const differ = DIFFER_HEADING.exec(report);
  if (!differ) return null;
  const didText = report.slice(0, differ.index).replace(DID_HEADING, "");
  const rows = parseRows(report.slice(differ.index + differ[0].length));
  if (!rows) return null;

  const sides: Record<"a" | "b" | "shared", string[]> = { a: [], b: [], shared: [] };
  let owner: keyof typeof sides | null = null;
  for (const raw of splitSentences(didText.replace(/\s+/g, " ").trim())) {
    const sentence = raw.replace(/^\*\*(Agent [AB]|Both|Neither)\*\*/, "$1");
    const next = sentenceOwner(sentence);
    owner = next ?? owner;
    if (!owner) return null;
    sides[owner].push(owner === "shared" ? sentence : withoutSubject(sentence));
  }
  if (sides.a.length === 0 || sides.b.length === 0) return null;
  return {
    a: sides.a.join(" "),
    b: sides.b.join(" "),
    shared: sides.shared.length > 0 ? sides.shared.join(" ") : null,
    rows,
  };
}

function sentenceOwner(sentence: string): "a" | "b" | "shared" | null {
  if (/^(Both|Neither)\b/.test(sentence)) return "shared";
  if (/^Agent A\b/.test(sentence)) return /^Agent A and Agent B\b/.test(sentence) ? "shared" : "a";
  if (/^Agent B\b/.test(sentence)) return /^Agent B and Agent A\b/.test(sentence) ? "shared" : "b";
  return null;
}

/** "Agent A replaced it" reads "Replaced it" under the Agent A column; "Agent A's change" stays. */
function withoutSubject(sentence: string): string {
  const match = /^Agent [AB] ([a-z])/.exec(sentence);
  if (!match) return sentence;
  return match[1]!.toUpperCase() + sentence.slice(match[0].length);
}

/** Splits at sentence ends outside double quotes and inline code, so quoted copy stays whole. */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let inQuote = false;
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "`") inCode = !inCode;
    else if (!inCode && OPENING_QUOTES.has(char) && !inQuote) inQuote = true;
    else if (!inCode && CLOSING_QUOTES.has(char) && inQuote) inQuote = false;
    if (inQuote || inCode || !/[.!?]/.test(char)) continue;
    // A sentence may end on a closing quote: `... "Dream big. Brew bold." with` does not end here,
    // `... with "sleep".` does.
    const after = text.slice(index + 1);
    if (/^\s+(?:\*\*)?[A-Z]/.test(after)) {
      sentences.push(text.slice(start, index + 1).trim());
      start = index + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

function parseRows(text: string): SummaryRow[] | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const header = lines[0] ? cells(lines[0]) : null;
  if (!header || header.length !== 3) return null;
  if (!/agent a/i.test(header[1]!) || !/agent b/i.test(header[2]!)) return null;
  const rows: SummaryRow[] = [];
  for (const line of lines.slice(1)) {
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    const row = cells(line);
    if (row.length !== 3) return null;
    rows.push({ aspect: row[0]!, a: row[1]!, b: row[2]! });
  }
  return rows;
}

function cells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
