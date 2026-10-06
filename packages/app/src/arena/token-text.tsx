import { useMemo } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import type { HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { DiffSegment } from "@/utils/tool-call-parsers";

export interface TokenRun {
  key: string;
  text: string;
  style: HighlightToken["style"];
  changed: boolean;
}

/**
 * Cuts a line into runs that carry both a syntax style and a "changed" flag:
 * tokens colour the code, segments mark the words that differ, and neither
 * boundary respects the other, so every boundary of either becomes a cut.
 * Falls back to the tokens alone when the two do not spell the same line.
 */
export function mergeTokenRuns(
  tokens: readonly HighlightToken[],
  segments: readonly DiffSegment[] | undefined,
): TokenRun[] {
  if (!segments || segments.length === 0) {
    return tokens.map((token, index) => ({
      key: `t${index}`,
      text: token.text,
      style: token.style,
      changed: false,
    }));
  }
  const tokenText = tokens.map((token) => token.text).join("");
  const segmentText = segments.map((segment) => segment.text).join("");
  if (tokenText !== segmentText) {
    return tokens.map((token, index) => ({
      key: `t${index}`,
      text: token.text,
      style: token.style,
      changed: false,
    }));
  }
  const runs: TokenRun[] = [];
  let ti = 0;
  let tokenOffset = 0;
  let si = 0;
  let segmentOffset = 0;
  let position = 0;
  while (position < tokenText.length) {
    const token = tokens[ti]!;
    const segment = segments[si]!;
    const tokenEnd = tokenOffset + token.text.length;
    const segmentEnd = segmentOffset + segment.text.length;
    const end = Math.min(tokenEnd, segmentEnd);
    if (end > position) {
      runs.push({
        key: `r${runs.length}`,
        text: tokenText.slice(position, end),
        style: token.style,
        changed: segment.changed,
      });
      position = end;
    }
    if (position >= tokenEnd) {
      ti += 1;
      tokenOffset = tokenEnd;
    }
    if (position >= segmentEnd) {
      si += 1;
      segmentOffset = segmentEnd;
    }
    if (ti >= tokens.length || si >= segments.length) break;
  }
  return runs;
}

/**
 * One line of code, syntax-coloured, with its changed words marked. The line
 * style sets the font; token colours and the mark sit on top of it.
 */
export function TokenText({
  tokens,
  segments,
  lineStyle,
  highlightStyle,
}: {
  tokens: readonly HighlightToken[];
  segments?: readonly DiffSegment[];
  lineStyle: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
}) {
  const runs = useMemo(() => mergeTokenRuns(tokens, segments), [segments, tokens]);
  return (
    <Text style={lineStyle}>
      {runs.map((run) => (
        <Text key={run.key} style={[syntaxTokenStyleFor(run.style), run.changed && highlightStyle]}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}
