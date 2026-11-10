import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent, type TextStyle, type ViewStyle } from "react-native";
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
  diffRowInset,
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
import { BATTLE_GUTTER } from "./battle-layout";
import { TokenText } from "./token-text";

type Side = "a" | "b";
type Tokens = Record<"base" | Side, Map<number, HighlightToken[]>>;
const SIDES: readonly Side[] = ["a", "b"];
const HEADER_DATA = { diffHeader: "true" };
const labelFor = (side: Side) => i18n.t("arena.agentSide", { side: side.toUpperCase() });
const STICKY_STYLE = isWeb
  ? ({ position: "sticky", top: 0, zIndex: 2 } as unknown as ViewStyle)
  : null;
// Stacked, a side's label pins under the header for as long as its rows are in view, so a tall
// region scrolled inside the viewer still says whose version it is.
const stickyLabelStyle = (top: number) =>
  isWeb ? ({ position: "sticky", top, zIndex: 1 } as unknown as TextStyle) : null;

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

const SIDE_DATA = { a: { comparisonSide: "a" }, b: { comparisonSide: "b" } };

function sideChanged(rows: readonly ThreeWayRow[], side: Side) {
  return rows.some((row) => row[side] && row[side]?.type !== "context");
}

function describeRow(row: ThreeWayRow, side: Side, aligned: boolean, t: TFunction) {
  const cell = row[side];
  const both = bothChanged(row, aligned);
  const sharedLabel = cell?.type === "remove" ? t("arena.removedBoth") : t("arena.addedBoth");
  return {
    row,
    cell,
    both,
    oldNumber: cell && cell.type !== "add" ? (row.base?.lineNumber ?? "") : "",
    sharedLabel: both ? sharedLabel : undefined,
    dataSet: { rowKey: row.key, change: cell?.type ?? "absent", both: String(both) },
  };
}

type ShownRow = ReturnType<typeof describeRow>;
type NumberStyle = ReturnType<typeof inlineUnistylesStyle>;

function WrappedCode({
  row,
  side,
  tokens,
  dataSet,
}: {
  row: ThreeWayRow;
  side: Side;
  tokens: Tokens;
  dataSet: ShownRow["dataSet"];
}) {
  const cell = row[side];
  const removed = cell?.type === "remove";
  const source = removed ? tokens.base : tokens[side];
  const line = removed ? row.base?.lineNumber : cell?.lineNumber;
  const matched = cell && line != null ? tokensSpelling(source.get(line), cell.content) : undefined;
  return (
    <View style={styles.wrappedCode} dataSet={dataSet}>
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
}

/**
 * One row: it grows with its wrapped line, so it carries its own gutter. The number width comes
 * from the region rather than each row, since a region can hold hundreds of rows on each side.
 */
function WrappedLine({
  shown,
  side,
  tokens,
  numberStyle,
}: {
  shown: ShownRow;
  side: Side;
  tokens: Tokens;
  numberStyle: NumberStyle;
}) {
  const { row, cell, oldNumber, sharedLabel, dataSet } = shown;
  const tone = toneFor(cell?.type);
  return (
    <View style={[styles.wrappedRow, tone]} accessibilityLabel={sharedLabel}>
      <View style={styles.wrappedGutterBg}>
        <View style={[styles.gutterRow, styles.wrappedGutter, tone]}>
          <Text style={[styles.number, numberStyle]}>{oldNumber}</Text>
          <Text style={[styles.number, numberStyle]}>{cell?.lineNumber ?? ""}</Text>
          <Text style={[styles.sign, cell?.type === "add" ? styles.addText : styles.removeText]}>
            {signFor(cell?.type)}
          </Text>
        </View>
      </View>
      <WrappedCode row={row} side={side} tokens={tokens} dataSet={dataSet} />
    </View>
  );
}

/**
 * A and B side by side. Each row is drawn across both columns at once, so a line
 * that wraps further on one side grows the row on both and the sides stay level.
 */
function PairedRegion({
  rows,
  sides,
  tokens,
  aligned,
  numberWidth,
  showStatus,
  gutter,
}: {
  rows: ThreeWayRow[];
  sides: readonly Side[];
  tokens: Tokens;
  aligned: boolean;
  numberWidth: number;
  showStatus: boolean;
  /** On the answers' columns: A and B part by the battle's gutter. */
  gutter: boolean;
}) {
  const { t } = useTranslation();
  const pairStyle = gutter ? styles.pairGutter : styles.pair;
  const numberStyle = useMemo(() => inlineUnistylesStyle({ width: numberWidth }), [numberWidth]);
  return (
    <>
      {showStatus ? (
        <View style={pairStyle}>
          {sides.map((side) => (
            <Text key={side} numberOfLines={1} style={[styles.column, styles.regionStatus]}>
              {sideChanged(rows, side) ? " " : t("arena.noRegionChanges")}
            </Text>
          ))}
        </View>
      ) : null}
      {rows.map((row) => (
        <View key={row.key} style={pairStyle}>
          {sides.map((side) => (
            <View key={side} style={[styles.column, styles.wrappedBody]} dataSet={SIDE_DATA[side]}>
              <WrappedLine
                shown={describeRow(row, side, aligned, t)}
                side={side}
                tokens={tokens}
                numberStyle={numberStyle}
              />
            </View>
          ))}
        </View>
      ))}
    </>
  );
}

function Column({
  rows,
  side,
  tokens,
  aligned,
  numberWidth,
  stacked,
  showStatus,
}: {
  rows: ThreeWayRow[];
  side: Side;
  tokens: Tokens;
  aligned: boolean;
  numberWidth: number;
  stacked: boolean;
  showStatus: boolean;
}) {
  const { t } = useTranslation();
  const changed = sideChanged(rows, side);
  const shownRows = useMemo(
    () =>
      (stacked ? rows.filter((row) => row[side] !== null) : rows).map((row) =>
        describeRow(row, side, aligned, t),
      ),
    [aligned, rows, side, stacked, t],
  );
  const columnData = SIDE_DATA[side];
  const numberStyle = useMemo(() => inlineUnistylesStyle({ width: numberWidth }), [numberWidth]);
  return (
    <View style={styles.column} dataSet={columnData}>
      {showStatus ? (
        <Text numberOfLines={1} style={styles.regionStatus}>
          {changed ? " " : t("arena.noRegionChanges")}
        </Text>
      ) : null}
      <View style={styles.wrappedBody}>
        {shownRows.map((shown) => (
          <WrappedLine
            key={shown.row.key}
            shown={shown}
            side={side}
            tokens={tokens}
            numberStyle={numberStyle}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * The viewer's sticky head. On the answers' columns it holds only each side's expand, at the end
 * of its column; elsewhere the caption, then the side labels when A sits beside B.
 */
function DiffHeader({
  columns,
  mode,
  layout,
  waitingFor,
  onExpandA,
  onExpandB,
  onBack,
  onLayout,
}: {
  columns: boolean;
  mode: Side | null;
  layout: ArenaDiffLayout;
  waitingFor: Side | undefined;
  onExpandA: () => void;
  onExpandB: () => void;
  onBack: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <View
      style={[styles.header, columns && styles.headerOnColumns, STICKY_STYLE]}
      dataSet={HEADER_DATA}
      onLayout={onLayout}
    >
      {columns ? (
        <View style={styles.pairGutter}>
          {SIDES.map((side) => (
            <View key={side} style={styles.columnActions}>
              {side === waitingFor ? (
                <WaitingAction side={side} />
              ) : (
                <Action
                  label={t("arena.expandLabel", { agent: labelFor(side) })}
                  onPress={side === "a" ? onExpandA : onExpandB}
                  testID={`arena-diff-expand-${side}`}
                />
              )}
            </View>
          ))}
        </View>
      ) : null}
      <View style={[styles.toolbar, columns && styles.hidden]}>
        <Text style={styles.caption}>
          {mode
            ? t("arena.sideOriginalChanges", { agent: labelFor(mode) })
            : t("arena.originalChanges")}
        </Text>
        {mode ? (
          <Action
            label={t("arena.backComparison")}
            onPress={onBack}
            back
            testID="arena-diff-back"
          />
        ) : null}
        {!mode && layout === "single" ? (
          <View style={styles.actions}>
            {SIDES.map((side) =>
              side === waitingFor ? (
                <WaitingAction key={side} side={side} />
              ) : (
                <Action
                  key={side}
                  label={t("arena.expandLabel", { agent: labelFor(side) })}
                  onPress={side === "a" ? onExpandA : onExpandB}
                  side={side}
                  testID={`arena-diff-expand-${side}`}
                />
              ),
            )}
          </View>
        ) : null}
      </View>
      {!mode && layout === "split" && !columns ? (
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
                  label={t("arena.expandLabel", { agent: labelFor(side) })}
                  onPress={side === "a" ? onExpandA : onExpandB}
                  testID={`arena-diff-expand-${side}`}
                />
              )}
            </View>
          ))}
        </View>
      ) : null}
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
  onColumns,
}: {
  file: ArenaThreeWayFile;
  diff: ThreeWayWindowedDiff;
  truncated: boolean;
  layout: ArenaDiffLayout;
  /** The side still working. Its column is a placeholder and only the other side expands. */
  waitingFor: Side | undefined;
  embedded: boolean;
  onColumns: boolean;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<View>(null);
  const [mode, setMode] = useState<Side | null>(null);
  const [full, setFull] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [seenLayout, setSeenLayout] = useState(layout);
  const [headerHeight, setHeaderHeight] = useState(0);
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
        .querySelector<HTMLElement>('[data-testid="arena-diff-back"]')
        ?.focus({ preventScroll: true });
    } else {
      node.scrollTop = previous.scrollTop;
      node
        .querySelector<HTMLElement>(`[data-testid="arena-diff-expand-${previous.side}"]`)
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
  const measureHeader = useCallback(
    (event: LayoutChangeEvent) => setHeaderHeight(event.nativeEvent.layout.height),
    [],
  );
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
  const labelSticky = stickyLabelStyle(headerHeight);
  const stacked = layout === "single" || mode !== null;
  const sides = mode ? [mode] : SIDES;
  // Side by side under the battle's answers: A's code under A, B's under B, each in its own box,
  // with nothing to name them; the columns already do.
  const columns = onColumns && !stacked;
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
            ? t("arena.incompleteLines")
            : t("arena.omittedLines", { total: block.lines.toLocaleString() })}
        </Text>
      );
    const showStatus = shown.some(
      (side) =>
        side !== waitingFor &&
        !block.rows.some((row) => row[side] && row[side]?.type !== "context"),
    );
    const paired =
      !options.stackedRows && !options.labels && !shown.some((side) => side === waitingFor);
    return (
      <View
        key={block.key}
        style={options.stackedRows || paired ? styles.stackedRegion : styles.pair}
        testID={`arena-diff-region-${block.key}`}
      >
        {paired ? (
          <PairedRegion
            rows={block.rows}
            sides={shown}
            tokens={tokens}
            aligned={diff.aligned}
            numberWidth={numberWidth}
            showStatus={showStatus}
            gutter={columns}
          />
        ) : null}
        {paired
          ? null
          : shown.map((side) =>
              side === waitingFor ? (
                // Stacked, the working side's slot is one line per region.
                <View key={side} style={styles.pendingLine} testID={`arena-diff-pending-${side}`}>
                  <Text style={[styles.pendingWho, side === "a" ? styles.agentA : styles.agentB]}>
                    {labelFor(side)}
                  </Text>
                  <Text style={styles.pendingText} numberOfLines={1}>
                    {t("arena.workingRegion")}
                  </Text>
                </View>
              ) : (
                <View key={side} style={styles.column}>
                  {options.labels ? (
                    <Text
                      style={[
                        styles.regionLabel,
                        side === "a" ? styles.agentA : styles.agentB,
                        labelSticky,
                      ]}
                    >
                      {labelFor(side)}
                    </Text>
                  ) : null}
                  <Column
                    rows={block.rows}
                    side={side}
                    tokens={tokens}
                    aligned={diff.aligned}
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
      style={[styles.viewer, embedded && styles.viewerEmbedded, columns && styles.viewerOnColumns]}
      testID="arena-inline-diff"
      dataSet={viewportData}
    >
      <DiffHeader
        columns={columns}
        mode={mode}
        layout={layout}
        waitingFor={waitingFor}
        onExpandA={expandA}
        onExpandB={expandB}
        onBack={back}
        onLayout={measureHeader}
      />
      {!diff.aligned ? <Text style={styles.warning}>{t("arena.regionsReplaced")} </Text> : null}
      {truncated ? <Text style={styles.warning}>{t("arena.notFullFile")} </Text> : null}
      {waitingFor && !stacked ? (
        // The working side's column is one placeholder for the whole file, the slot its diff
        // will fill, beside the finished side's regions.
        <View style={columns ? styles.pairGutter : styles.pair}>
          {SIDES.map((side) =>
            side === waitingFor ? (
              <View
                key={side}
                style={[styles.column, styles.pendingColumn]}
                testID={`arena-diff-pending-${side}`}
              >
                <View style={styles.pendingMessage}>
                  <Text style={styles.pendingTitle}>
                    {labelFor(side)} {t("arena.workingStill")}
                  </Text>
                  <Text style={styles.pendingHint}>{t("arena.workingVersion")} </Text>
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
        <View style={styles.blocks}>
          {blocks.map((block) =>
            renderBlock(block, sides, { stackedRows: stacked, labels: stacked && !mode }),
          )}
          {columns ? (
            <View style={styles.boxes} pointerEvents="none">
              <View style={styles.box} />
              <View style={styles.box} />
            </View>
          ) : null}
        </View>
      )}
      {diff.rows.length === 0 ? (
        <Text style={styles.notice}>{t("arena.noOriginalChanges")}</Text>
      ) : null}
      {previewLimited ? (
        <View style={styles.pad}>
          <Button size="xs" variant="ghost" onPress={showAll}>
            {t("arena.fullDiff")}{" "}
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
  onColumns = false,
}: {
  file: ArenaThreeWayFile;
  layout: ArenaDiffLayout;
  /** The side still working: its column is a placeholder until its result lands. */
  waitingFor?: Side;
  /** Drawn under its row in the Changes list, which supplies the edges around it. */
  embedded?: boolean;
  /** Under a row on the battle's answers' columns (`SplitChangesRow`). */
  onColumns?: boolean;
}) {
  const { t } = useTranslation();
  const comparison = useMemo<BaseRelativeDiff>(() => buildBaseRelativeDiff(file, t), [file, t]);
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
      onColumns={onColumns}
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
  pairGutter: { flexDirection: "row", minWidth: 0, columnGap: BATTLE_GUTTER },
  viewerOnColumns: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
  },
  headerOnColumns: {
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 0,
  },
  columnActions: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  hidden: { display: "none" },
  blocks: { position: "relative", minWidth: 0 },
  // Each side's box, drawn over its column so the code's tints run to its edge.
  boxes: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    columnGap: BATTLE_GUTTER,
  },
  box: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
  },
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
  wrappedBody: { minWidth: 0, borderLeftWidth: 1, borderLeftColor: theme.colors.border },
  wrappedRow: { flexDirection: "row", flexGrow: 1, minHeight: diffRowHeight(theme) },
  wrappedGutter: {
    height: "auto",
    minHeight: diffRowHeight(theme),
    alignItems: "flex-start",
    paddingVertical: diffRowInset(theme),
    flexGrow: 1,
  },
  wrappedGutterBg: { backgroundColor: theme.colors.surface1 },
  wrappedCode: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: diffRowInset(theme),
  },
  codeText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foreground,
    // Lines always wrap, so nothing hides past the edge of a narrow column.
    ...(isWeb ? { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const } : null),
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
