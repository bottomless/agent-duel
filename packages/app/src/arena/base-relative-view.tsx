import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronsUpDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react-native";
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
import { CARD_DIFF_MAX_HEIGHT, MAX_RENDERED_ROWS, diffTextHeight } from "./diff-metrics";
import type { ArenaDiffLayout } from "./diff-layout";
import { PaneIconAction } from "./pane-icon-action";
import { unifiedSideRows } from "./side-rows";
import {
  buildThreeWayBlocks,
  limitThreeWayBlocks,
  type ThreeWayGapBlock,
  type ThreeWayRow,
  type ThreeWayWindowedDiff,
} from "./three-way-diff";
import { TokenText } from "./token-text";

type Side = "a" | "b";
type Tokens = Record<"base" | Side, Map<number, HighlightToken[]>>;
const SIDES: readonly Side[] = ["a", "b"];
const HEADER_DATA = { diffHeader: "true" };
const labelFor = (side: Side) => (side === "a" ? "Agent A" : "Agent B");
const STICKY_STYLE = isWeb
  ? ({ position: "sticky", top: 0, zIndex: 1 } as unknown as ViewStyle)
  : null;
const stickyAt = (top: number) =>
  isWeb ? ({ position: "sticky", top, zIndex: 1 } as unknown as ViewStyle) : null;

function toneFor(type: string | undefined) {
  if (type === "add") return styles.add;
  if (type === "remove") return styles.remove;
  return null;
}

/**
 * The diff's own header rows. In the panel the file's heading above already names what this is,
 * so the caption row only appears to lead back from one agent's full view, and a single agent's
 * diff needs no header at all.
 */
function headerChrome(
  flowTop: number | undefined,
  mode: Side | null,
  shown: Side | null,
  layout: ArenaDiffLayout,
) {
  return {
    headerSticky: flowTop === undefined ? STICKY_STYLE : stickyAt(flowTop),
    showToolbar: flowTop === undefined || mode !== null,
    showColumns: shown === null && layout === "split",
  };
}

// A changed line is marked at its left edge as well as by its tint, so it reads at a glance.
function edgeFor(type: string | undefined) {
  if (type === "add") return styles.addEdge;
  if (type === "remove") return styles.removeEdge;
  return styles.plainEdge;
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
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronsUpDown = withUnistyles(ChevronsUpDown);
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

/**
 * Unchanged lines folded away, as one quiet line on the gutter's rail: the count and the way it
 * opens, up at the top of the file, down at its end, either way between two changes. Pressing it
 * shows the whole run.
 */
function GapRow({
  gap,
  total,
  onReveal,
}: {
  gap: ThreeWayGapBlock;
  total: number;
  onReveal: (start: number, end: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const reveal = useCallback(() => onReveal(gap.start, gap.end), [gap.end, gap.start, onReveal]);
  let Icon = ThemedChevronsUpDown;
  if (gap.start === 0) Icon = ThemedChevronUp;
  else if (gap.end >= total) Icon = ThemedChevronDown;
  const label = `${gap.count} unmodified ${gap.count === 1 ? "line" : "lines"}`;
  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        onPress={reveal}
        style={[styles.gap, hovered && styles.gapHovered]}
        accessibilityRole="button"
        accessibilityLabel={`Show ${label}`}
        testID="arena-diff-gap"
      >
        <Icon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.gapText}>{label}</Text>
      </Pressable>
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
  unified,
  wrap,
}: {
  rows: ThreeWayRow[];
  side: Side;
  tokens: Tokens;
  aligned: boolean;
  hasBoth: boolean;
  numberWidth: number;
  stacked: boolean;
  showStatus: boolean;
  /** One agent's diff read alone, in unified-diff order rather than lined up with the other's. */
  unified: boolean;
  /** Long lines wrap inside the panel instead of scrolling sideways. */
  wrap: boolean;
}) {
  const changed = rows.some((row) => row[side] && row[side]?.type !== "context");
  const sideRows = useMemo(() => {
    if (unified) return unifiedSideRows(rows, side);
    return stacked ? rows.filter((row) => row[side] !== null) : rows;
  }, [rows, side, stacked, unified]);
  const shownRows = useMemo(
    () =>
      sideRows.map((row) => {
        const cell = row[side];
        const both = bothChanged(row, aligned);
        const sharedLabel =
          cell?.type === "remove" ? "Removed by both agents" : "Added by both agents";
        return {
          row,
          cell,
          both,
          // One number per row, the way a unified diff reads: the original's for a removed line,
          // this side's otherwise. A second column of base numbers took a third of a docked panel.
          number: (cell?.type === "remove" ? row.base?.lineNumber : cell?.lineNumber) ?? "",
          sharedLabel: both ? sharedLabel : undefined,
          dataSet: { rowKey: row.key, change: cell?.type ?? "absent", both: String(both) },
        };
      }),
    [aligned, side, sideRows],
  );
  const columnData = useMemo(() => ({ comparisonSide: side }), [side]);
  const numberStyle = useMemo(() => inlineUnistylesStyle({ width: numberWidth }), [numberWidth]);
  let body: ReactNode;
  if (wrap) {
    // Wrapped, a line can take several rows of text, so its number and its code share one row
    // and grow together.
    body = (
      <View style={styles.wrapBody}>
        {shownRows.map((shown) => (
          <View
            key={shown.row.key}
            style={[styles.wrapRow, toneFor(shown.cell?.type), edgeFor(shown.cell?.type)]}
            dataSet={shown.dataSet}
          >
            <View style={styles.wrapGutter}>
              <GutterCells {...shown} hasBoth={hasBoth} numberStyle={numberStyle} />
            </View>
            <View style={styles.wrapCode}>
              <CodeText row={shown.row} cell={shown.cell} side={side} tokens={tokens} wrap />
            </View>
          </View>
        ))}
      </View>
    );
  } else {
    body = (
      <>
        <View style={styles.gutter}>
          {shownRows.map((shown) => (
            <View
              key={shown.row.key}
              style={[styles.gutterRow, toneFor(shown.cell?.type), edgeFor(shown.cell?.type)]}
            >
              <GutterCells {...shown} hasBoth={hasBoth} numberStyle={numberStyle} />
            </View>
          ))}
        </View>
        <View style={styles.codeScroll}>
          {shownRows.map((shown) => (
            <View
              key={shown.row.key}
              style={[styles.codeRow, toneFor(shown.cell?.type)]}
              dataSet={shown.dataSet}
            >
              <CodeText
                row={shown.row}
                cell={shown.cell}
                side={side}
                tokens={tokens}
                wrap={false}
              />
            </View>
          ))}
        </View>
      </>
    );
  }
  return (
    <View style={styles.column} dataSet={columnData}>
      {/* Side by side, the blank status keeps both columns' rows level. Stacked, it is only a gap. */}
      {showStatus && (!stacked || !changed) ? (
        <Text numberOfLines={1} style={styles.regionStatus}>
          {changed ? " " : "No changes in this region"}
        </Text>
      ) : null}
      <View style={[styles.columnBody, !stacked && styles.columnDivider]}>{body}</View>
    </View>
  );
}

function GutterCells({
  cell,
  both,
  number,
  sharedLabel,
  hasBoth,
  numberStyle,
}: {
  cell: ThreeWayRow["a"];
  both: boolean;
  number: number | string;
  sharedLabel: string | undefined;
  hasBoth: boolean;
  numberStyle: { width: number };
}) {
  return (
    <>
      <Text style={[styles.number, numberStyle]}>{number}</Text>
      <Text style={[styles.sign, cell?.type === "add" ? styles.addText : styles.removeText]}>
        {signFor(cell?.type)}
      </Text>
      {hasBoth ? (
        <Text style={styles.both} numberOfLines={1} accessibilityLabel={sharedLabel}>
          {both ? "Both" : ""}
        </Text>
      ) : null}
    </>
  );
}

function CodeText({
  row,
  cell,
  side,
  tokens,
  wrap,
}: {
  row: ThreeWayRow;
  cell: ThreeWayRow["a"];
  side: Side;
  tokens: Tokens;
  wrap: boolean;
}) {
  const removed = cell?.type === "remove";
  const source = removed ? tokens.base : tokens[side];
  const line = removed ? row.base?.lineNumber : cell?.lineNumber;
  const matched = cell && line != null ? tokensSpelling(source.get(line), cell.content) : undefined;
  const lineStyle = wrap ? styles.codeTextWrap : styles.codeText;
  if (cell && matched)
    return (
      <TokenText
        tokens={matched}
        segments={cell.segments}
        lineStyle={lineStyle}
        highlightStyle={removed ? styles.removeHighlight : styles.addHighlight}
      />
    );
  return <Text style={lineStyle}>{cell?.content || " "}</Text>;
}

function ReadyDiff({
  file,
  diff,
  truncated,
  layout,
  embedded,
  flowTop,
  onlySide,
  wrap,
}: {
  file: ArenaThreeWayFile;
  diff: ThreeWayWindowedDiff;
  truncated: boolean;
  layout: ArenaDiffLayout;
  embedded: boolean;
  flowTop: number | undefined;
  onlySide: Side | null;
  wrap: boolean;
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
    // One side's view folds the context around the other side's changes too.
    const all = buildThreeWayBlocks(diff.rows, revealed, onlySide ?? "both", 3, diff.breaks);
    return full ? { blocks: all, truncated: false } : limitThreeWayBlocks(all, MAX_RENDERED_ROWS);
  }, [diff, full, onlySide, revealed]);
  const tokens = useMemo<Tokens>(
    () => ({
      base: sideTokens(file.base, file.file),
      a: sideTokens(file.a, file.file),
      b: sideTokens(file.b, file.file),
    }),
    [file],
  );
  // One agent's view leaves out what the other did, the shared changes included: the reader
  // compares by switching agents, and the label cost the code a column.
  const hasBoth = useMemo(
    () => onlySide === null && diff.rows.some((row) => bothChanged(row, diff.aligned)),
    [diff, onlySide],
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
  const shown = onlySide ?? mode;
  const stacked = layout === "single" || shown !== null;
  const sides = shown ? [shown] : SIDES;
  // Several diffs can be open at once, so each viewer names its file for review telemetry to
  // credit a scroll to the diff that scrolled.
  const viewportData = useMemo(
    () => ({ detailSide: mode ?? "both", pmono: "true", diffFile: file.file }),
    [file.file, mode],
  );

  const { headerSticky, showToolbar, showColumns } = useMemo(
    () => headerChrome(flowTop, mode, shown, layout),
    [flowTop, layout, mode, shown],
  );

  return (
    <View
      ref={viewportRef}
      style={[
        styles.viewer,
        embedded && styles.viewerEmbedded,
        flowTop !== undefined && styles.viewerFlow,
      ]}
      testID="arena-inline-diff"
      dataSet={viewportData}
    >
      {showToolbar || showColumns ? (
        <View style={[styles.header, headerSticky]} dataSet={HEADER_DATA}>
          {showToolbar ? (
            <View style={styles.toolbar}>
              <Text style={styles.caption}>
                {mode ? `${labelFor(mode)} · Changes from original` : "Changes from original"}
              </Text>
              {mode ? (
                <Action label="Back to comparison" onPress={back} back testID="arena-diff-back" />
              ) : null}
              {!mode && layout === "single" ? (
                <View style={styles.actions}>
                  <Action
                    label="Expand Agent A"
                    onPress={expandA}
                    side="a"
                    testID="arena-diff-expand-a"
                  />
                  <Action
                    label="Expand Agent B"
                    onPress={expandB}
                    side="b"
                    testID="arena-diff-expand-b"
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {showColumns ? (
            <View style={styles.pair}>
              {SIDES.map((side) => (
                <View key={side} style={styles.columnHeader}>
                  <Text style={[styles.agentLabel, side === "a" ? styles.agentA : styles.agentB]}>
                    {labelFor(side)}
                  </Text>
                  <Action
                    label={`Expand ${labelFor(side)}`}
                    onPress={side === "a" ? expandA : expandB}
                    testID={`arena-diff-expand-${side}`}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
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
      {blocks.map((block) => {
        if (block.kind === "gap")
          return <GapRow key={block.key} gap={block} total={diff.rows.length} onReveal={reveal} />;
        if (block.kind === "omitted")
          return (
            <Text key={block.key} style={styles.notice}>
              {truncated
                ? "Lines not sent. This comparison is incomplete; later changes may be missing."
                : `${block.lines.toLocaleString()} unchanged lines not sent with this file.`}
            </Text>
          );
        const showStatus = SIDES.some(
          (side) => !block.rows.some((row) => row[side] && row[side]?.type !== "context"),
        );
        return (
          <View
            key={block.key}
            style={stacked ? styles.stackedRegion : styles.pair}
            testID={`arena-diff-region-${block.key}`}
          >
            {sides.map((side) => (
              <View key={side} style={stacked ? styles.stackedColumn : styles.column}>
                {stacked && !shown ? (
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
                  stacked={stacked}
                  showStatus={showStatus && onlySide === null}
                  unified={onlySide !== null}
                  wrap={wrap}
                />
              </View>
            ))}
          </View>
        );
      })}
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
  embedded = false,
  flowTop,
  onlySide,
  wrap = false,
}: {
  file: ArenaThreeWayFile;
  layout: ArenaDiffLayout;
  /** Drawn under its row in the Changes list, which supplies the edges around it. */
  embedded?: boolean;
  /**
   * Set where the diff flows at its full height in a scroller of its own, the Battle changes
   * panel: no height cap and no scroll inside it, and its header sticks this far from the
   * scroller's top, under the file's own heading.
   */
  flowTop?: number;
  /** Show only this agent's changes from the original, as one unified diff. */
  onlySide?: Side;
  /** Long lines wrap instead of scrolling sideways. */
  wrap?: boolean;
}) {
  const comparison = useMemo<BaseRelativeDiff>(() => buildBaseRelativeDiff(file), [file]);
  const untouched = useMemo(
    () =>
      onlySide !== undefined &&
      comparison.kind !== "unavailable" &&
      !comparison.diff.rows.some((row) => row[onlySide] && row[onlySide]?.type !== "context"),
    [comparison, onlySide],
  );
  if (comparison.kind === "unavailable")
    return (
      <View style={styles.pad} testID="arena-inline-diff-note">
        <Text style={styles.caption}>{comparison.message}</Text>
      </View>
    );
  if (untouched && onlySide)
    return (
      <View style={styles.pad} testID="arena-inline-diff-untouched">
        <Text style={styles.caption}>{`${labelFor(onlySide)} didn't change this file.`}</Text>
      </View>
    );
  return (
    <ReadyDiff
      file={file}
      diff={comparison.diff}
      truncated={comparison.truncated}
      layout={layout}
      embedded={embedded}
      flowTop={flowTop}
      onlySide={onlySide ?? null}
      wrap={wrap}
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
  // Nested scrolling was the complaint: a capped diff scrolling inside a scrolling page. In the
  // panel the panel scrolls, and the diff is as tall as it is. Both axes go visible: hidden on
  // one makes the browser scroll the other, and a scroller here would also unstick the header.
  viewerFlow: {
    maxHeight: "none" as unknown as number,
    ...(isWeb ? { overflowY: "visible" as const, overflowX: "visible" as const } : {}),
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
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  pair: { flexDirection: "row", minWidth: 0 },
  column: { flex: 1, minWidth: 0 },
  // Stacked, each agent's rows take their own height. `flex: 1` here shared the region's height
  // equally, so the side with more rows lost its last one under the other's label.
  stackedColumn: { minWidth: 0 },
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
  agentLabel: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium },
  agentA: { color: theme.colors.statusDotRunning },
  agentB: { color: theme.colors.statusDotWarning },
  regionLabel: {
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  regionStatus: {
    minHeight: 24,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    backgroundColor: theme.colors.surface1,
  },
  stackedRegion: { minWidth: 0 },
  columnBody: {
    flexDirection: "row",
    minWidth: 0,
  },
  // Side by side, a hairline parts A from B. Stacked, the change edge is the only rule.
  columnDivider: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  gutter: {},
  // Rows are as tall as their text, the way a unified diff reads, so a docked panel shows more
  // of the file; the text height follows the code font size in Settings.
  gutterRow: {
    height: diffTextHeight(theme),
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    borderLeftWidth: 3,
  },
  gap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: diffTextHeight(theme) + theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  gapHovered: { backgroundColor: theme.colors.surface2 },
  gapText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  plainEdge: { borderLeftColor: "transparent" },
  addEdge: { borderLeftColor: theme.colors.diffAddition },
  removeEdge: { borderLeftColor: theme.colors.diffDeletion },
  number: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    marginRight: theme.spacing[1],
    ...(isWeb ? { fontVariantNumeric: "tabular-nums" as const } : null),
  },
  sign: {
    width: 12,
    textAlign: "center",
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  both: {
    width: Math.ceil(theme.fontSize.xs * 3.5),
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  codeScroll: { flex: 1, minWidth: 0, ...(isWeb ? { overflowX: "auto" as const } : null) },
  codeRow: {
    height: diffTextHeight(theme),
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
  codeTextWrap: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foreground,
    ...(isWeb ? { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const } : null),
  },
  wrapBody: { flex: 1, minWidth: 0 },
  wrapRow: {
    flexDirection: "row",
    minHeight: diffTextHeight(theme),
    borderLeftWidth: 3,
  },
  wrapGutter: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
  },
  wrapCode: { flex: 1, minWidth: 0, paddingHorizontal: theme.spacing[1] },
  add: { backgroundColor: tint(theme.colors.diffAddition, 13) },
  remove: { backgroundColor: tint(theme.colors.diffDeletion, 13) },
  addText: { color: theme.colors.diffAddition },
  removeText: { color: theme.colors.diffDeletion },
  addHighlight: { backgroundColor: tint(theme.colors.diffAddition, 28) },
  removeHighlight: { backgroundColor: tint(theme.colors.diffDeletion, 28) },
  notice: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    backgroundColor: theme.colors.surface1,
  },
  warning: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  pad: { padding: theme.spacing[2] },
}));
