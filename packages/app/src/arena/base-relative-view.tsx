import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Maximize2, Minimize2 } from "lucide-react-native";
import type { HighlightToken } from "@getpaseo/highlight";
import type { ArenaFileContent, ArenaThreeWayFile } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { tint } from "@/styles/tint";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { tokenizeToLines } from "@/utils/highlight-cache";
import { bothChanged, buildBaseRelativeDiff, type BaseRelativeDiff } from "./base-relative-diff";
import { syntaxExtension, tokensSpelling } from "./combined-tokens";
import {
  CARD_DIFF_MAX_HEIGHT,
  MAX_RENDERED_ROWS,
  diffRowHeight,
  diffTextHeight,
} from "./diff-metrics";
import type { ArenaDiffLayout } from "./diff-layout";
import { PaneIconAction } from "./pane-icon-action";
import {
  buildThreeWayBlocks,
  limitThreeWayBlocks,
  type ThreeWayBlock,
  type ThreeWayRow,
  type ThreeWayWindowedDiff,
} from "./three-way-diff";
import { ExpandBand } from "./three-way-file-diff";
import { TokenText } from "./token-text";

type Side = "a" | "b";
type Tokens = Record<"base" | Side, Map<number, HighlightToken[]>>;
const SIDES: readonly Side[] = ["a", "b"];
const HEADER_DATA = { diffHeader: "true" };
const labelFor = (side: Side) => (side === "a" ? "Agent A" : "Agent B");
const STICKY_STYLE = isWeb
  ? ({ position: "sticky", top: 0, zIndex: 1 } as unknown as ViewStyle)
  : null;

function toneFor(type: string | undefined) {
  if (type === "add") return styles.add;
  if (type === "remove") return styles.remove;
  return null;
}

function signFor(type: string | undefined) {
  if (type === "add") return "+";
  if (type === "remove") return "−";
  return "";
}

function sideTokens(
  side: ArenaFileContent | undefined,
  path: string,
): Map<number, HighlightToken[]> {
  const result = new Map<number, HighlightToken[]>();
  const extension = syntaxExtension(path);
  if (!side || side.missing || !extension) return result;
  const lines = side.content.replace(/\r\n/g, "\n").split("\n");
  const regions = side.regions ?? [{ start: 1, lines: lines.length }];
  let offset = 0;
  for (const region of regions) {
    const text = lines.slice(offset, offset + region.lines).join("\n");
    const tokens = tokenizeToLines(text, extension);
    for (let index = 0; index < region.lines; index++) {
      const matched = tokensSpelling(tokens?.[index], lines[offset + index] ?? "");
      if (matched) result.set(region.start + index, matched);
    }
    offset += region.lines;
  }
  return result;
}

const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedMinimize2 = withUnistyles(Minimize2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const disabledColorMapping = (theme: Theme) => ({ color: theme.colors.surface4 });
const sideColorMappings: Record<Side, (theme: Theme) => { color: string }> = {
  a: (theme) => ({ color: theme.colors.statusDotRunning }),
  b: (theme) => ({ color: theme.colors.statusDotWarning }),
};

/**
 * Expand and Back are the pane header's icon action, so the diff and the panes share one
 * affordance. In the one-column layout the two Expand icons carry their side's colour, since
 * without a column heading beside them nothing else says which side each opens.
 */
function Action({
  label,
  onPress,
  back = false,
  side,
  testID,
}: {
  label: string;
  onPress: () => void;
  back?: boolean;
  side?: Side;
  testID: string;
}) {
  const mapping = side ? sideColorMappings[side] : foregroundColorMapping;
  return (
    <PaneIconAction accessibilityLabel={label} onPress={onPress} testID={testID}>
      {back ? (
        <ThemedMinimize2 size={ICON_SIZE.xs} uniProps={foregroundColorMapping} />
      ) : (
        <ThemedMaximize2 size={ICON_SIZE.xs} uniProps={mapping} />
      )}
    </PaneIconAction>
  );
}

/** Expand's place for a side that has no result yet: the glyph, dimmed, and no action. */
function WaitingAction({ side }: { side: Side }) {
  return (
    <View style={styles.actionDisabled} testID={`arena-diff-expand-${side}-waiting`}>
      <ThemedMaximize2 size={ICON_SIZE.xs} uniProps={disabledColorMapping} />
    </View>
  );
}

function Column({
  rows,
  side,
  tokens,
  aligned,
  hasBoth,
  numberWidth,
  stacked,
  showStatus,
}: {
  rows: ThreeWayRow[];
  side: Side;
  tokens: Tokens;
  aligned: boolean;
  hasBoth: boolean;
  numberWidth: number;
  stacked: boolean;
  showStatus: boolean;
}) {
  const changed = rows.some((row) => row[side] && row[side]?.type !== "context");
  const shownRows = useMemo(
    () =>
      (stacked ? rows.filter((row) => row[side] !== null) : rows).map((row) => {
        const cell = row[side];
        const both = bothChanged(row, aligned);
        const sharedLabel =
          cell?.type === "remove" ? "Removed by both agents" : "Added by both agents";
        return {
          row,
          cell,
          both,
          oldNumber: cell && cell.type !== "add" ? (row.base?.lineNumber ?? "") : "",
          sharedLabel: both ? sharedLabel : undefined,
          dataSet: { rowKey: row.key, change: cell?.type ?? "absent", both: String(both) },
        };
      }),
    [aligned, rows, side, stacked],
  );
  const columnData = useMemo(() => ({ comparisonSide: side }), [side]);
  const numberStyle = useMemo(() => inlineUnistylesStyle({ width: numberWidth }), [numberWidth]);
  return (
    <View style={styles.column} dataSet={columnData}>
      {showStatus ? (
        <Text numberOfLines={1} style={styles.regionStatus}>
          {changed ? " " : "No changes in this region"}
        </Text>
      ) : null}
      <View style={styles.columnBody}>
        <View style={styles.gutter}>
          {shownRows.map(({ row, cell, both, oldNumber, sharedLabel }) => {
            const tone = toneFor(cell?.type);
            return (
              <View key={row.key} style={[styles.gutterRow, tone]}>
                <Text style={[styles.number, numberStyle]}>{oldNumber}</Text>
                <Text style={[styles.number, numberStyle]}>{cell?.lineNumber ?? ""}</Text>
                <Text
                  style={[styles.sign, cell?.type === "add" ? styles.addText : styles.removeText]}
                >
                  {signFor(cell?.type)}
                </Text>
                {hasBoth ? (
                  <Text style={styles.both} numberOfLines={1} accessibilityLabel={sharedLabel}>
                    {both ? "Both" : ""}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
        <View style={styles.codeScroll}>
          {shownRows.map(({ row, cell, dataSet }) => {
            const removed = cell?.type === "remove";
            const source = removed ? tokens.base : tokens[side];
            const line = removed ? row.base?.lineNumber : cell?.lineNumber;
            const matched =
              cell && line != null ? tokensSpelling(source.get(line), cell.content) : undefined;
            const tone = toneFor(cell?.type);
            return (
              <View key={row.key} style={[styles.codeRow, tone]} dataSet={dataSet}>
                {cell && matched ? (
                  <TokenText
                    tokens={matched}
                    segments={cell.segments}
                    lineStyle={styles.codeText}
                    highlightStyle={removed ? styles.removeHighlight : styles.addHighlight}
                  />
                ) : (
                  <Text style={styles.codeText}>{cell?.content || " "}</Text>
                )}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function ReadyDiff({
  file,
  diff,
  truncated,
  layout,
  waitingFor,
  embedded,
}: {
  file: ArenaThreeWayFile;
  diff: ThreeWayWindowedDiff;
  truncated: boolean;
  layout: ArenaDiffLayout;
  /** The side still working. Its column is a placeholder and only the other side expands. */
  waitingFor: Side | undefined;
  embedded: boolean;
}) {
  const viewportRef = useRef<View>(null);
  const [mode, setMode] = useState<Side | null>(null);
  const [full, setFull] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [seenLayout, setSeenLayout] = useState(layout);
  const saved = useRef<{ scrollTop: number; anchor: string | null; side: Side } | null>(null);
  if (seenLayout !== layout) {
    setSeenLayout(layout);
    setMode(null);
  }
  const viewport = useCallback(() => {
    const node = viewportRef.current;
    return isWeb && node instanceof HTMLElement ? node : null;
  }, []);
  const expand = useCallback(
    (side: Side) => {
      const node = viewport();
      const header = node?.querySelector<HTMLElement>('[data-diff-header="true"]');
      const top = (node?.getBoundingClientRect().top ?? 0) + (header?.offsetHeight ?? 0);
      const firstVisible = node
        ? Array.from(node.querySelectorAll<HTMLElement>("[data-row-key]")).find(
            (row) => row.getBoundingClientRect().bottom > top,
          )
        : null;
      saved.current = {
        scrollTop: node?.scrollTop ?? 0,
        anchor: firstVisible?.dataset.rowKey ?? null,
        side,
      };
      setMode(side);
    },
    [viewport],
  );
  const expandA = useCallback(() => expand("a"), [expand]);
  const expandB = useCallback(() => expand("b"), [expand]);
  const back = useCallback(() => setMode(null), []);
  useLayoutEffect(() => {
    const node = viewport();
    const previous = saved.current;
    if (!node || !previous) return;
    if (mode) {
      const row = previous.anchor
        ? node.querySelector<HTMLElement>(`[data-row-key="${previous.anchor}"]`)
        : null;
      const header = node.querySelector<HTMLElement>('[data-diff-header="true"]');
      if (row)
        node.scrollTop +=
          row.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          (header?.offsetHeight ?? 0);
      node
        .querySelector<HTMLElement>('[aria-label="Back to comparison"]')
        ?.focus({ preventScroll: true });
    } else {
      node.scrollTop = previous.scrollTop;
      node
        .querySelector<HTMLElement>(`[aria-label="Expand ${labelFor(previous.side)}"]`)
        ?.focus({ preventScroll: true });
      saved.current = null;
    }
  }, [mode, layout, viewport]);
  useEffect(() => {
    const node = viewport();
    if (!node || !mode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      back();
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [back, mode, viewport]);
  const reveal = useCallback(
    (start: number, end: number) =>
      setRevealed((previous) => {
        const next = new Set(previous);
        for (let index = start; index < end; index++) next.add(index);
        return next;
      }),
    [],
  );
  const showAll = useCallback(() => setFull(true), []);
  const { blocks, truncated: previewLimited } = useMemo(() => {
    const all = buildThreeWayBlocks(diff.rows, revealed, "both", 3, diff.breaks);
    return full ? { blocks: all, truncated: false } : limitThreeWayBlocks(all, MAX_RENDERED_ROWS);
  }, [diff, full, revealed]);
  const tokens = useMemo<Tokens>(
    () => ({
      base: sideTokens(file.base, file.file),
      a: sideTokens(file.a, file.file),
      b: sideTokens(file.b, file.file),
    }),
    [file],
  );
  const hasBoth = useMemo(() => diff.rows.some((row) => bothChanged(row, diff.aligned)), [diff]);
  const numberWidth = useMemo(() => {
    let largest = 1;
    for (const row of diff.rows)
      largest = Math.max(
        largest,
        row.base?.lineNumber ?? 0,
        row.a?.lineNumber ?? 0,
        row.b?.lineNumber ?? 0,
      );
    return Math.max(20, String(largest).length * 8);
  }, [diff]);
  const stacked = layout === "single" || mode !== null;
  const sides = mode ? [mode] : SIDES;
  const renderBlock = (
    block: ThreeWayBlock,
    shown: readonly Side[],
    options: { stackedRows: boolean; labels?: boolean },
  ) => {
    if (block.kind === "gap") return <ExpandBand key={block.key} gap={block} onReveal={reveal} />;
    if (block.kind === "omitted")
      return (
        <Text key={block.key} style={styles.notice}>
          {truncated
            ? "Lines not sent. This comparison is incomplete; later changes may be missing."
            : `${block.lines.toLocaleString()} unchanged lines not sent with this file.`}
        </Text>
      );
    const showStatus = shown.some(
      (side) =>
        side !== waitingFor &&
        !block.rows.some((row) => row[side] && row[side]?.type !== "context"),
    );
    return (
      <View
        key={block.key}
        style={options.stackedRows ? styles.stackedRegion : styles.pair}
        testID={`arena-diff-region-${block.key}`}
      >
        {shown.map((side) =>
          side === waitingFor ? (
            // Stacked, the working side's slot is one line per region.
            <View key={side} style={styles.pendingLine} testID={`arena-diff-pending-${side}`}>
              <Text style={[styles.pendingWho, side === "a" ? styles.agentA : styles.agentB]}>
                {labelFor(side)}
              </Text>
              <Text style={styles.pendingText} numberOfLines={1}>
                is still working · its version of this region appears here
              </Text>
            </View>
          ) : (
            <View key={side} style={styles.column}>
              {options.labels ? (
                <Text style={[styles.regionLabel, side === "a" ? styles.agentA : styles.agentB]}>
                  {labelFor(side)}
                </Text>
              ) : null}
              <Column
                rows={block.rows}
                side={side}
                tokens={tokens}
                aligned={diff.aligned}
                hasBoth={hasBoth}
                numberWidth={numberWidth}
                stacked={options.stackedRows}
                showStatus={showStatus}
              />
            </View>
          ),
        )}
      </View>
    );
  };
  // Several diffs can be open at once, so each viewer names its file for review telemetry to
  // credit a scroll to the diff that scrolled.
  const viewportData = useMemo(
    () => ({ detailSide: mode ?? "both", pmono: "true", diffFile: file.file }),
    [file.file, mode],
  );

  return (
    <View
      ref={viewportRef}
      style={[styles.viewer, embedded && styles.viewerEmbedded]}
      testID="arena-inline-diff"
      dataSet={viewportData}
    >
      <View style={[styles.header, STICKY_STYLE]} dataSet={HEADER_DATA}>
        <View style={styles.toolbar}>
          <Text style={styles.caption}>
            {mode ? `${labelFor(mode)} · Changes from original` : "Changes from original"}
          </Text>
          {mode ? (
            <Action label="Back to comparison" onPress={back} back testID="arena-diff-back" />
          ) : null}
          {!mode && layout === "single" ? (
            <View style={styles.actions}>
              {SIDES.map((side) =>
                side === waitingFor ? (
                  <WaitingAction key={side} side={side} />
                ) : (
                  <Action
                    key={side}
                    label={`Expand ${labelFor(side)}`}
                    onPress={side === "a" ? expandA : expandB}
                    side={side}
                    testID={`arena-diff-expand-${side}`}
                  />
                ),
              )}
            </View>
          ) : null}
        </View>
        {!mode && layout === "split" ? (
          <View style={styles.pair}>
            {SIDES.map((side) => (
              <View key={side} style={styles.columnHeader}>
                <Text style={[styles.agentLabel, side === "a" ? styles.agentA : styles.agentB]}>
                  {labelFor(side)}
                </Text>
                {side === waitingFor ? (
                  <WaitingAction side={side} />
                ) : (
                  <Action
                    label={`Expand ${labelFor(side)}`}
                    onPress={side === "a" ? expandA : expandB}
                    testID={`arena-diff-expand-${side}`}
                  />
                )}
              </View>
            ))}
          </View>
        ) : null}
      </View>
      {!diff.aligned ? (
        <Text style={styles.warning}>
          Some regions were too large to align precisely. They are shown as replacements from the
          original; shared-change labels are unavailable.
        </Text>
      ) : null}
      {truncated ? (
        <Text style={styles.warning}>
          This file was not sent in full. Later changes may be missing.
        </Text>
      ) : null}
      {waitingFor && !stacked ? (
        // The working side's column is one placeholder for the whole file, the slot its diff
        // will fill, beside the finished side's regions.
        <View style={styles.pair}>
          {SIDES.map((side) =>
            side === waitingFor ? (
              <View
                key={side}
                style={[styles.column, styles.pendingColumn]}
                testID={`arena-diff-pending-${side}`}
              >
                <View style={styles.pendingMessage}>
                  <Text style={styles.pendingTitle}>{labelFor(side)} is still working</Text>
                  <Text style={styles.pendingHint}>
                    Its version of this file appears here when it finishes.
                  </Text>
                </View>
              </View>
            ) : (
              <View key={side} style={styles.column}>
                {blocks.map((block) => renderBlock(block, [side], { stackedRows: true }))}
              </View>
            ),
          )}
        </View>
      ) : (
        blocks.map((block) =>
          renderBlock(block, sides, { stackedRows: stacked, labels: stacked && !mode }),
        )
      )}
      {diff.rows.length === 0 ? (
        <Text style={styles.notice}>No textual changes from the original.</Text>
      ) : null}
      {previewLimited ? (
        <View style={styles.pad}>
          <Button size="xs" variant="ghost" onPress={showAll}>
            Show full diff
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export function BaseRelativeFileView({
  file,
  layout,
  waitingFor,
  embedded = false,
}: {
  file: ArenaThreeWayFile;
  layout: ArenaDiffLayout;
  /** The side still working: its column is a placeholder until its result lands. */
  waitingFor?: Side;
  /** Drawn under its row in the Changes list, which supplies the edges around it. */
  embedded?: boolean;
}) {
  const comparison = useMemo<BaseRelativeDiff>(() => buildBaseRelativeDiff(file), [file]);
  if (comparison.kind === "unavailable")
    return (
      <View style={styles.pad} testID="arena-inline-diff-note">
        <Text style={styles.caption}>{comparison.message}</Text>
      </View>
    );
  return (
    <ReadyDiff
      file={file}
      diff={comparison.diff}
      truncated={comparison.truncated}
      layout={layout}
      waitingFor={waitingFor}
      embedded={embedded}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  viewer: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    maxHeight: CARD_DIFF_MAX_HEIGHT,
    minWidth: 0,
    ...(isWeb
      ? { overflowY: "auto" as const, overflowX: "hidden" as const }
      : { overflow: "hidden" as const }),
  },
  // One band of the Changes list rather than a box of its own, so no card nests in the list.
  viewerEmbedded: {
    borderWidth: 0,
    borderRadius: 0,
  },
  header: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  actions: { flexDirection: "row", gap: theme.spacing[1] },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pair: { flexDirection: "row", minWidth: 0 },
  column: { flex: 1, minWidth: 0 },
  columnHeader: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  agentLabel: { fontSize: theme.fontSize.base, fontWeight: theme.fontWeight.medium },
  agentA: { color: theme.colors.statusDotRunning },
  agentB: { color: theme.colors.statusDotWarning },
  regionLabel: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    backgroundColor: theme.colors.surface1,
  },
  regionStatus: {
    minHeight: 24,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
  },
  stackedRegion: { minWidth: 0 },
  columnBody: {
    flexDirection: "row",
    minWidth: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  gutter: { backgroundColor: theme.colors.surface1 },
  gutterRow: {
    height: diffRowHeight(theme),
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  number: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    marginRight: theme.spacing[1],
    ...(isWeb ? { fontVariantNumeric: "tabular-nums" as const } : null),
  },
  sign: {
    width: 12,
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  both: {
    width: Math.ceil(theme.fontSize.sm * 3.5),
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  codeScroll: { flex: 1, minWidth: 0, ...(isWeb ? { overflowX: "auto" as const } : null) },
  codeRow: {
    height: diffRowHeight(theme),
    minWidth: "100%",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  codeText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foreground,
    ...(isWeb ? { whiteSpace: "pre" as const, overflowWrap: "normal" as const } : null),
  },
  add: { backgroundColor: tint(theme.colors.diffAddition, 13) },
  remove: { backgroundColor: tint(theme.colors.diffDeletion, 13) },
  addText: { color: theme.colors.diffAddition },
  removeText: { color: theme.colors.diffDeletion },
  addHighlight: { backgroundColor: tint(theme.colors.diffAddition, 28) },
  removeHighlight: { backgroundColor: tint(theme.colors.diffDeletion, 28) },
  notice: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
  },
  warning: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pad: { padding: theme.spacing[2] },
  // Expand's box without its action, so the header keeps its height and the pair its rhythm.
  actionDisabled: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  // The working side's slot: hatched, the size of the finished side's diff beside it.
  pendingColumn: {
    justifyContent: "center",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    _web: {
      backgroundImage: `repeating-linear-gradient(135deg, ${theme.colors.surface0} 0 10px, ${tint(theme.colors.surface2, 55)} 10px 11px)`,
    },
  },
  pendingMessage: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[4],
  },
  pendingTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  pendingHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 280,
  },
  pendingLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: 30,
    paddingHorizontal: theme.spacing[2],
    overflow: "hidden",
    _web: {
      backgroundImage: `repeating-linear-gradient(135deg, ${theme.colors.surface0} 0 10px, ${tint(theme.colors.surface2, 55)} 10px 11px)`,
    },
  },
  pendingWho: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  pendingText: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
