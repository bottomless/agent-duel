import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  type StyleProp,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ChevronUp, Maximize2, Minimize2 } from "lucide-react-native";
import type { ArenaThreeWayFile } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { HighlightToken } from "@getpaseo/highlight";
import type { DiffSegment } from "@/utils/tool-call-parsers";
import {
  sideTokenMap,
  syntaxExtension,
  tokensSpelling,
  type LineTokenMap,
} from "./combined-tokens";
import { MAX_RENDERED_ROWS, diffRowHeight, diffTextHeight } from "./diff-metrics";
import { TokenText } from "./token-text";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import {
  buildThreeWayBlocks,
  buildWindowedThreeWayDiff,
  frameChangedRuns,
  isUnchangedRow,
  limitThreeWayBlocks,
  showsSide,
  visibleThreeWayView,
  THREE_WAY_CONTEXT_LINES,
  type ThreeWayBaseCell,
  type ThreeWayCell,
  type ThreeWayWindowedDiff,
  type ThreeWayGapBlock,
  type ThreeWayOmittedBlock,
  type ThreeWayMode,
  type ThreeWayRow,
  type ThreeWayRowFrame,
} from "./three-way-diff";

// How many rows each chevron reveals, and the point past which a gap is big enough
// that revealing it wholesale is unhelpful and the stepped chevrons earn their space.
const EXPAND_STEP = 20;
const STEPPED_GAP_MIN = EXPAND_STEP * 2;

// The viewer scrolls as a whole, so this bounds every file a battle touched rather
// than each file on its own.
const VIEWER_MAX_HEIGHT = 560;

const COLUMN_LABEL_LINE_HEIGHT = 20;

// Pins the column header to the top of the viewer's own scroller. Web-only, and RN's
// ViewStyle has no "sticky", hence the cast -- the same shape as review/surface.tsx.
const STICKY_HEADER_STYLE = isWeb
  ? ({ position: "sticky", top: 0, zIndex: 1 } as unknown as ViewStyle)
  : null;

const NO_FRAMES: ThreeWayRowFrame[] = [];
const NO_REVEALS: ReadonlySet<number> = new Set<number>();
const NO_DIFF: ThreeWayWindowedDiff = { rows: [], aligned: true, breaks: [] };

// Null in "both" mode: nothing is hidden, so there is no one agent to name.
function shownLabelFor(mode: ThreeWayMode, labelA: string, labelB: string): string | null {
  if (mode === "a") return labelA;
  if (mode === "b") return labelB;
  return null;
}

const SOLO_ICON_SIZE = 12;

// Quiet by default and brighter on the soloed column, so the affordance is always
// present without competing with the label it sits next to.
const ThemedMaximize = withUnistyles(Maximize2);
const ThemedMinimize = withUnistyles(Minimize2);
const soloIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const soloedIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const MARKER_WIDTH = 9;
const CHANGE_BAR_WIDTH = 2;

function FileHeader({
  file,
  mode,
  open,
  onToggle,
}: {
  file: ArenaThreeWayFile;
  mode: ThreeWayMode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} style={styles.fileHeader} accessibilityRole="button">
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      <Text numberOfLines={1} style={styles.fileName}>
        {file.file}
      </Text>
      {showsSide(mode, "a") ? (
        <>
          <Text style={styles.additions}>A +{file.additionsA}</Text>
          <Text style={styles.deletions}>−{file.deletionsA}</Text>
        </>
      ) : null}
      {showsSide(mode, "b") ? (
        <>
          <Text style={styles.additions}>B +{file.additionsB}</Text>
          <Text style={styles.deletions}>−{file.deletionsB}</Text>
        </>
      ) : null}
    </Pressable>
  );
}

// What a single cell is showing. "absent" is the side that has no line at all on
// this row -- the base has no counterpart for an insertion, or one agent left the
// row alone while the other rewrote it.
type CellTone = "context" | "add" | "remove" | "base" | "absent";

function toneOf(cell: ThreeWayCell | null): CellTone {
  return cell ? cell.type : "absent";
}

// The fill for one cell. Every cell of a changed row is filled -- tinted where that
// side changed, neutral where it did not -- so a change reads as one band running
// across all three columns. An absent cell is deliberately the only unfilled cell in
// such a band: a hole in the stripe says "nothing here" more plainly than any grey
// close enough to the neutral fill to be mistaken for it.
function toneStyle(tone: CellTone, frame: ThreeWayRowFrame) {
  if (tone === "add") return styles.addCell;
  if (tone === "remove") return styles.removeCell;
  if (tone === "absent") return styles.absentCell;
  if (tone === "base") return frame.changed ? styles.bandCell : styles.baseCell;
  return frame.changed ? styles.bandCell : styles.contextCell;
}

function gutterToneStyle(tone: CellTone, frame: ThreeWayRowFrame) {
  if (tone === "add") return styles.addGutter;
  if (tone === "remove") return styles.removeGutter;
  if (tone === "absent") return styles.absentCell;
  return frame.changed ? styles.bandCell : null;
}

// Frames are applied to the gutter and the content cell of every column alike, so
// the hairlines meet across the grid. Borders sit inside the cell's fixed height,
// so drawing one cannot push the three columns out of alignment.
function framed(frame: ThreeWayRowFrame) {
  if (frame.runStart && frame.runEnd) return styles.runSingle;
  if (frame.runStart) return styles.runStart;
  if (frame.runEnd) return styles.runEnd;
  return null;
}

function textStyleFor(tone: CellTone) {
  if (tone === "base") return styles.baseText;
  return styles.contextText;
}

// A sign in the gutter, so which side added and which side lost a line survives
// without color -- and so a removed line, which has no line number of its own, is
// not left with an empty gutter that reads like an absent row.
function markerFor(tone: CellTone): string {
  if (tone === "add") return "+";
  if (tone === "remove") return "\u2212";
  return "";
}

function markerStyleFor(tone: CellTone) {
  if (tone === "add") return [styles.marker, styles.addMarker];
  if (tone === "remove") return [styles.marker, styles.removeMarker];
  return styles.marker;
}

/**
 * An agent's column label, which is also the control for showing that agent alone.
 *
 * The label is the control because a diff has no room for a control bar: the header
 * is already the one row that names the columns, and it is already pinned. Soloing is
 * a toggle on the column you are left reading, so the way back is always on screen --
 * there is never a hidden column to go looking for.
 */
function ColumnLabel({
  label,
  model,
  soloed,
  onToggle,
}: {
  label: string;
  /** The contestant's model, once the vote has revealed it. Carries the vendor mark. */
  model: string | undefined;
  soloed: boolean;
  onToggle: () => void;
}) {
  const accessibilityState = useMemo(() => ({ selected: soloed }), [soloed]);
  // The render-prop form, so the cell styles itself on hover without any state
  // leaving it -- see docs/hover.md on why hover state never drives a sibling here.
  const cellStyle = useCallback(
    ({ hovered }: { hovered?: boolean }) => [
      styles.columnLabelCell,
      soloed ? styles.columnLabelCellSoloed : null,
      hovered ? styles.columnLabelCellHovered : null,
    ],
    [soloed],
  );
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={soloed ? "Show both agents" : `Show only ${label}, against base`}
      style={cellStyle}
    >
      {model ? <ArenaModelVendorIcon model={model} size={ICON_SIZE.xs} /> : null}
      <Text numberOfLines={1} style={styles.columnLabelText}>
        {label}
      </Text>
      {soloed ? (
        <ThemedMinimize size={SOLO_ICON_SIZE} uniProps={soloedIconMapping} />
      ) : (
        <ThemedMaximize size={SOLO_ICON_SIZE} uniProps={soloIconMapping} />
      )}
    </Pressable>
  );
}

function GutterCell({
  lineNumber,
  tone,
  frame,
  textStyle,
}: {
  lineNumber: number | null;
  tone: CellTone;
  frame: ThreeWayRowFrame;
  textStyle: StyleProp<TextStyle>;
}) {
  return (
    <View style={[styles.gutterCell, gutterToneStyle(tone, frame), framed(frame)]}>
      <Text style={[textStyle, tone === "add" && styles.addNumber]}>{lineNumber ?? ""}</Text>
      <Text style={markerStyleFor(tone)}>{markerFor(tone)}</Text>
    </View>
  );
}

/**
 * One line of code with its changed words highlighted. Shared with the combined
 * view, which stacks two versions of a region and highlights what differs
 * between them the same way.
 */
export function SegmentText({
  segments,
  textStyle,
  highlightStyle,
}: {
  segments: readonly DiffSegment[];
  textStyle: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
}) {
  const keyedSegments = useMemo(
    () =>
      segments.map((segment, index) => ({
        key: `${index}-${segment.changed ? "c" : "u"}-${segment.text}`,
        segment,
      })),
    [segments],
  );
  return (
    <Text style={styles.lineText}>
      {keyedSegments.map(({ key, segment }) => (
        <Text key={key} style={[textStyle, segment.changed && highlightStyle]}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function CandidateCellText({ cell, tokens }: { cell: ThreeWayCell; tokens?: HighlightToken[] }) {
  const textStyle = textStyleFor(cell.type);
  if (tokens) {
    return (
      <TokenText
        tokens={tokens}
        segments={cell.segments}
        lineStyle={styles.lineText}
        highlightStyle={cell.type === "add" ? styles.addHighlight : styles.removeHighlight}
      />
    );
  }
  if (cell.segments) {
    return (
      <SegmentText
        segments={cell.segments}
        textStyle={textStyle}
        highlightStyle={cell.type === "add" ? styles.addHighlight : styles.removeHighlight}
      />
    );
  }
  return <Text style={[styles.lineText, textStyle]}>{cell.content}</Text>;
}

// A plain overflow-scrolling View, not RN's ScrollView: ScrollView attaches its own
// wheel handling for momentum/bounce, which on web consumes the whole wheel event
// -- including the vertical component -- so a vertical scroll gesture that starts
// over one of these horizontal-only columns never reaches the outer vertical
// scroller. A bare CSS overflow-x lets the browser's native scroll-chaining decide,
// which correctly passes an unhandled vertical delta up to the ancestor that wants it.
// Each hunk scrolls horizontally on its own, the same way separate hunks behave in
// any other diff view.
function CandidateColumn({
  rows,
  frames,
  which,
  gutterTextStyle,
  tokens,
  baseTokens,
}: {
  rows: ThreeWayRow[];
  frames: ThreeWayRowFrame[];
  which: "a" | "b";
  gutterTextStyle: StyleProp<TextStyle>;
  tokens?: LineTokenMap;
  baseTokens?: LineTokenMap;
}) {
  // A removed line is base text, so its colours come from the base file.
  const tokensFor = (row: ThreeWayRow, cell: ThreeWayCell): HighlightToken[] | undefined => {
    if (cell.lineNumber !== null) return tokensSpelling(tokens?.get(cell.lineNumber), cell.content);
    return row.base
      ? tokensSpelling(baseTokens?.get(row.base.lineNumber), cell.content)
      : undefined;
  };
  return (
    <View style={styles.column}>
      <View style={styles.gutterColumn}>
        {rows.map((row, index) => {
          const cell = which === "a" ? row.a : row.b;
          return (
            <GutterCell
              key={row.key}
              lineNumber={cell?.lineNumber ?? null}
              tone={toneOf(cell)}
              frame={frames[index]}
              textStyle={gutterTextStyle}
            />
          );
        })}
      </View>
      <View style={styles.columnScroll}>
        {rows.map((row, index) => {
          const cell = which === "a" ? row.a : row.b;
          const frame = frames[index];
          return (
            <View
              key={row.key}
              style={[styles.cell, toneStyle(toneOf(cell), frame), framed(frame)]}
            >
              {cell ? <CandidateCellText cell={cell} tokens={tokensFor(row, cell)} /> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function BaseCellText({ cell, tokens }: { cell: ThreeWayBaseCell; tokens?: HighlightToken[] }) {
  if (tokens) {
    return (
      <TokenText
        tokens={tokens}
        lineStyle={[styles.lineText, styles.baseText]}
        highlightStyle={null}
      />
    );
  }
  return <Text style={[styles.lineText, styles.baseText]}>{cell.content}</Text>;
}

function BaseColumn({
  rows,
  frames,
  gutterTextStyle,
  tokens,
}: {
  rows: ThreeWayRow[];
  frames: ThreeWayRowFrame[];
  gutterTextStyle: StyleProp<TextStyle>;
  tokens?: LineTokenMap;
}) {
  return (
    <View style={styles.column}>
      <View style={styles.gutterColumn}>
        {rows.map((row, index) => (
          <GutterCell
            key={row.key}
            lineNumber={row.base?.lineNumber ?? null}
            tone={row.base ? "base" : "absent"}
            frame={frames[index]}
            textStyle={gutterTextStyle}
          />
        ))}
      </View>
      <View style={styles.columnScroll}>
        {rows.map((row, index) => {
          const frame = frames[index];
          return (
            <View
              key={row.key}
              style={[styles.cell, toneStyle(row.base ? "base" : "absent", frame), framed(frame)]}
            >
              {row.base ? (
                <BaseCellText
                  cell={row.base}
                  tokens={tokensSpelling(tokens?.get(row.base.lineNumber), row.base.content)}
                />
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// A run of lines the daemon never sent, drawn where the missing content would have been
// rather than as a note under the file. This is the band the reader hits when they scroll
// looking for a change the summary named: it says the lines are not here and that nothing
// in them changed, instead of letting the two sides of the break read as neighbours.
function OmittedBand({ block }: { block: ThreeWayOmittedBlock }) {
  return (
    <View style={[styles.band, styles.omittedBand]}>
      <View style={styles.bandMain}>
        <Text style={styles.omittedBandText}>
          {block.lines > 0
            ? `⋯ ${block.lines.toLocaleString()} lines not sent — unchanged on both sides, and the file was too large to send whole`
            : "⋯ lines not sent — the file was too large to send whole"}
        </Text>
      </View>
    </View>
  );
}

export function ExpandBand({
  gap,
  onReveal,
}: {
  gap: ThreeWayGapBlock;
  onReveal: (start: number, end: number) => void;
}) {
  const { start, end, count } = gap;
  const revealAll = useCallback(() => onReveal(start, end), [end, onReveal, start]);
  const revealFromTop = useCallback(
    () => onReveal(start, Math.min(end, start + EXPAND_STEP)),
    [end, onReveal, start],
  );
  const revealFromBottom = useCallback(
    () => onReveal(Math.max(start, end - EXPAND_STEP), end),
    [end, onReveal, start],
  );
  const stepped = count >= STEPPED_GAP_MIN;

  return (
    <View style={styles.band}>
      {stepped ? (
        <Pressable
          onPress={revealFromTop}
          style={styles.bandStep}
          accessibilityRole="button"
          accessibilityLabel={`Show ${EXPAND_STEP} more lines after the change above`}
        >
          <ChevronDown size={13} />
        </Pressable>
      ) : null}
      <Pressable
        onPress={revealAll}
        style={styles.bandMain}
        accessibilityRole="button"
        accessibilityLabel={`Show all ${count} unchanged lines`}
      >
        <Text style={styles.bandText}>{`⋯ ${count} unchanged lines — show all`}</Text>
      </Pressable>
      {stepped ? (
        <Pressable
          onPress={revealFromBottom}
          style={styles.bandStep}
          accessibilityRole="button"
          accessibilityLabel={`Show ${EXPAND_STEP} more lines before the change below`}
        >
          <ChevronUp size={13} />
        </Pressable>
      ) : null}
    </View>
  );
}

// What the viewer had to give up on this file, if anything: the alignment, the
// content, or both. They stack under the rows rather than replacing them -- what did
// get through is still worth reading.
function FileLimitNotices({
  aligned,
  contentTruncated,
}: {
  aligned: boolean;
  contentTruncated: boolean;
}) {
  return (
    <>
      {aligned ? null : (
        <Text style={[styles.warning, styles.filePad]}>
          This file was too large to align line by line; it is shown as the base replaced in full.
        </Text>
      )}
      {contentTruncated ? (
        <Text style={[styles.warning, styles.filePad]}>
          This file was too large to send in full, and the windows above ran out of room before the
          end of it. Later changes are missing.
        </Text>
      ) : null}
    </>
  );
}

function ThreeWayFileSection({
  file,
  first,
  mode,
  shownAgentLabel,
  focusRequestId,
}: {
  file: ArenaThreeWayFile;
  first: boolean;
  mode: ThreeWayMode;
  // Only set when one agent is hidden, to name who left a file alone.
  shownAgentLabel: string | null;
  // Set when the viewer was opened at this file; a new id opens it again.
  focusRequestId: number | null;
}) {
  const sectionRef = useRef<View>(null);
  const [open, setOpen] = useState(focusRequestId !== null);
  const [full, setFull] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(NO_REVEALS);

  // Revealed rows are indices into the rows the current mode renders, and switching
  // mode renumbers them. Dropping them is the honest reset; carrying them over would
  // expand whichever rows happen to land on those indices next.
  const [revealedMode, setRevealedMode] = useState(mode);
  if (revealedMode !== mode) {
    setRevealedMode(mode);
    setRevealed(NO_REVEALS);
  }
  // Aligning a file is the expensive part of the viewer and a battle can touch 25 of
  // them, so nothing is aligned until its section is opened. The latch is one-way:
  // collapsing a section keeps the alignment rather than paying for it again on the
  // next open, and the memo below stays keyed on the file alone.
  const [aligned, setAligned] = useState(focusRequestId !== null);
  const handleToggle = useCallback(() => {
    setAligned(true);
    setOpen((value) => !value);
  }, []);
  useEffect(() => {
    if (focusRequestId === null) return;
    setAligned(true);
    setOpen(true);
    if (!isWeb) return;
    // The viewer's scroller is a plain overflow View, so the section scrolls
    // itself into view rather than asking a ScrollView to.
    const node = sectionRef.current as unknown as { scrollIntoView?: (o: object) => void } | null;
    node?.scrollIntoView?.({ block: "start" });
  }, [focusRequestId]);
  const handleFullToggle = useCallback(() => setFull((value) => !value), []);
  const handleReveal = useCallback((start: number, end: number) => {
    setRevealed((previous) => {
      const next = new Set(previous);
      for (let index = start; index < end; index += 1) next.add(index);
      return next;
    });
  }, []);

  const diff = useMemo(() => {
    if (!aligned || file.binary || !file.base || !file.a || !file.b) return NO_DIFF;
    return buildWindowedThreeWayDiff(file.base, file.a, file.b);
  }, [aligned, file]);
  const ext = syntaxExtension(file.file);
  const tokenMaps = useMemo(
    () =>
      open && !file.binary
        ? {
            base: sideTokenMap(file.base, ext),
            a: sideTokenMap(file.a, ext),
            b: sideTokenMap(file.b, ext),
          }
        : null,
    [ext, file, open],
  );
  const { rows, breaks } = useMemo(() => visibleThreeWayView(diff, mode), [diff, mode]);
  const unchangedForMode = useMemo(
    () => rows.length > 0 && rows.every((row) => isUnchangedRow(row, mode)),
    [mode, rows],
  );

  const { blocks, truncated } = useMemo(() => {
    const collapsed = buildThreeWayBlocks(rows, revealed, mode, THREE_WAY_CONTEXT_LINES, breaks);
    if (full) return { blocks: collapsed, truncated: false };
    return limitThreeWayBlocks(collapsed, MAX_RENDERED_ROWS);
  }, [breaks, full, mode, revealed, rows]);

  // A changed run never spans an expander band -- gaps hold unchanged rows only -- so
  // each block can be framed on its own.
  const framedBlocks = useMemo(
    () =>
      blocks.map((block) => ({
        block,
        frames: block.kind === "rows" ? frameChangedRuns(block.rows, mode) : NO_FRAMES,
      })),
    [blocks, mode],
  );

  // Every hunk shares one gutter width so the three columns stay aligned across the
  // expander bands that separate them.
  const gutterTextStyle = useMemo(() => {
    let maxLineNumber = 1;
    for (const row of rows) {
      if (row.base) maxLineNumber = Math.max(maxLineNumber, row.base.lineNumber);
      if (row.a?.lineNumber) maxLineNumber = Math.max(maxLineNumber, row.a.lineNumber);
      if (row.b?.lineNumber) maxLineNumber = Math.max(maxLineNumber, row.b.lineNumber);
    }
    const minWidth = Math.max(24, `${maxLineNumber}`.length * 8);
    return [styles.gutterText, inlineUnistylesStyle({ minWidth })];
  }, [rows]);

  const contentTruncated = Boolean(file.base?.truncated || file.a?.truncated || file.b?.truncated);

  return (
    <View ref={sectionRef} style={first ? null : styles.fileSectionDivider}>
      <FileHeader file={file} mode={mode} open={open} onToggle={handleToggle} />
      {open ? (
        <View>
          {file.binary ? (
            <Text style={[styles.muted, styles.filePad]}>Binary file changed.</Text>
          ) : null}
          {!file.binary && rows.length === 0 ? (
            <Text style={[styles.muted, styles.filePad]}>
              No textual content was retained for this file.
            </Text>
          ) : null}
          {!file.binary && rows.length > 0 ? (
            <>
              {unchangedForMode && shownAgentLabel ? (
                <Text style={[styles.muted, styles.filePad]}>
                  {`${shownAgentLabel} left this file alone — the changes here are the other agent's.`}
                </Text>
              ) : null}
              {/* No scroller and no frame of its own: the viewer owns both, so rows run
                  edge to edge and one file's hunks scroll into the next. */}
              <View>
                {framedBlocks.map(({ block, frames }) => {
                  if (block.kind === "omitted")
                    return <OmittedBand key={block.key} block={block} />;
                  if (block.kind === "gap") {
                    return <ExpandBand key={block.key} gap={block} onReveal={handleReveal} />;
                  }
                  return (
                    <View key={block.key} style={styles.gridRow}>
                      {showsSide(mode, "a") ? (
                        <CandidateColumn
                          rows={block.rows}
                          frames={frames}
                          which="a"
                          gutterTextStyle={gutterTextStyle}
                          tokens={tokenMaps?.a}
                          baseTokens={tokenMaps?.base}
                        />
                      ) : null}
                      <BaseColumn
                        rows={block.rows}
                        frames={frames}
                        gutterTextStyle={gutterTextStyle}
                        tokens={tokenMaps?.base}
                      />
                      {showsSide(mode, "b") ? (
                        <CandidateColumn
                          rows={block.rows}
                          frames={frames}
                          which="b"
                          gutterTextStyle={gutterTextStyle}
                          tokens={tokenMaps?.b}
                          baseTokens={tokenMaps?.base}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
              {truncated || full ? (
                <View style={styles.filePad}>
                  <Button size="xs" variant="ghost" onPress={handleFullToggle}>
                    {full
                      ? "Collapse to bounded preview"
                      : `This file changed too much to show at once — show all ${rows.length} rows`}
                  </Button>
                </View>
              ) : null}
              <FileLimitNotices aligned={diff.aligned} contentTruncated={contentTruncated} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One viewer for every file a battle touched.
 *
 * The three columns mean the same thing in every file, so the labels are the
 * viewer's own header rather than something each file repeats -- files read as
 * sections of one comparison instead of a stack of separate ones. The header is
 * sticky inside the viewer's scroller, which is also what keeps it exactly as wide
 * as the columns it names: a scrollbar takes its width out of the header and the
 * rows alike, so the two can never disagree.
 */
export function ThreeWayDiffViewer({
  files,
  labelA,
  labelB,
  modelA,
  modelB,
  fill = false,
  focusPath,
  focusRequestId,
}: {
  files: ArenaThreeWayFile[];
  labelA: string;
  labelB: string;
  /** The contestants' models. Absent until the vote reveals them. */
  modelA?: string;
  modelB?: string;
  /** Take the parent's height instead of capping at the in-card height. */
  fill?: boolean;
  /** Open this file's section on mount; a new request id opens it again. */
  focusPath?: string;
  focusRequestId?: number;
}) {
  const [mode, setMode] = useState<ThreeWayMode>("both");
  const showA = showsSide(mode, "a");
  const showB = showsSide(mode, "b");
  const shownAgentLabel = shownLabelFor(mode, labelA, labelB);
  const toggleA = useCallback(() => setMode((current) => (current === "a" ? "both" : "a")), []);
  const toggleB = useCallback(() => setMode((current) => (current === "b" ? "both" : "b")), []);

  return (
    <View style={[styles.viewer, fill ? styles.viewerFill : styles.viewerCapped]}>
      <View style={[styles.columnLabels, STICKY_HEADER_STYLE]}>
        {showA ? (
          <ColumnLabel label={labelA} model={modelA} soloed={mode === "a"} onToggle={toggleA} />
        ) : null}
        <Text numberOfLines={1} style={styles.baseColumnLabel}>
          Base
        </Text>
        {showB ? (
          <ColumnLabel label={labelB} model={modelB} soloed={mode === "b"} onToggle={toggleB} />
        ) : null}
      </View>
      {files.map((file, index) => (
        <ThreeWayFileSection
          key={file.file}
          file={file}
          first={index === 0}
          mode={mode}
          shownAgentLabel={shownAgentLabel}
          focusRequestId={focusPath === file.file ? (focusRequestId ?? 0) : null}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewer: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    // One scroller for every file, not one per file. A plain View with native
    // overflow rather than RN's ScrollView, for the wheel-chaining reason spelled out
    // on CandidateColumn below.
    ...(isWeb ? { overflowY: "auto" as const } : { overflow: "hidden" as const }),
  },
  viewerCapped: {
    maxHeight: VIEWER_MAX_HEIGHT,
  },
  viewerFill: {
    flex: 1,
    minHeight: 0,
  },
  fileSectionDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  filePad: {
    padding: theme.spacing[2],
  },
  fileHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  fileName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  additions: {
    color: theme.colors.success,
    fontSize: theme.fontSize.xs,
  },
  deletions: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  warning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  columnLabels: {
    flexDirection: "row",
    // A quieter surface than the file bars below it: this is the viewer's own chrome,
    // the bars are what you click.
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderAccent,
  },
  // Every header cell is one column wide and carries the same left rule the column
  // below it does, so the three dividers run unbroken from the header through every
  // file. Agent cells are pressable, base is not.
  columnLabelCell: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  columnLabelCellHovered: {
    backgroundColor: theme.colors.surface2,
  },
  // The soloed column reads as the selected tab of the header it sits in.
  columnLabelCellSoloed: {
    backgroundColor: theme.colors.surface2,
  },
  columnLabelText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: COLUMN_LABEL_LINE_HEIGHT,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  // The base column's own text is muted, and its label matches: the two agents are
  // what you are reading, base is what they are read against.
  baseColumnLabel: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: COLUMN_LABEL_LINE_HEIGHT,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  gridRow: {
    flexDirection: "row",
  },
  omittedBand: {
    backgroundColor: theme.colors.surface2,
  },
  omittedBandText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
  },
  band: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 24,
    backgroundColor: theme.colors.surface2,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  bandMain: {
    flex: 1,
    minHeight: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  bandStep: {
    minHeight: 24,
    paddingHorizontal: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  bandText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  column: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  columnScroll: {
    flex: 1,
    minWidth: 0,
    ...(isWeb ? { overflowX: "auto" as const } : null),
  },
  gutterColumn: {
    // No background of its own: each gutter cell paints the fill for its row, so the
    // band of a change carries through the gutter instead of stopping at it.
  },
  gutterCell: {
    minHeight: diffRowHeight(theme),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  gutterText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  addNumber: {
    color: theme.colors.diffAddition,
  },
  marker: {
    width: MARKER_WIDTH,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: diffTextHeight(theme),
    textAlign: "center",
    color: "transparent",
  },
  addMarker: {
    color: theme.colors.diffAddition,
  },
  removeMarker: {
    color: theme.colors.diffDeletion,
  },
  cell: {
    minHeight: diffRowHeight(theme),
    minWidth: "100%",
    justifyContent: "center",
    // A change bar between the gutter and the code, in the same saturated green and
    // red as the +/- markers. On a dark theme the row fills have to stay faint enough
    // to read code through, which leaves them too close to each other to carry the
    // signal alone; the bar is opaque and carries it at any tint strength.
    borderLeftWidth: CHANGE_BAR_WIDTH,
    borderLeftColor: "transparent",
    paddingLeft: theme.spacing[1] - CHANGE_BAR_WIDTH,
    paddingRight: theme.spacing[1],
  },
  absentCell: {
    backgroundColor: "transparent",
  },
  baseCell: {
    backgroundColor: theme.colors.surface1,
  },
  contextCell: {
    backgroundColor: theme.colors.surface0,
  },
  bandCell: {
    backgroundColor: theme.colors.surface2,
  },
  addCell: {
    backgroundColor: "rgba(46, 160, 67, 0.24)",
    borderLeftColor: theme.colors.diffAddition,
  },
  removeCell: {
    backgroundColor: "rgba(248, 81, 73, 0.2)",
    borderLeftColor: theme.colors.diffDeletion,
  },
  addGutter: {
    backgroundColor: "rgba(46, 160, 67, 0.34)",
  },
  removeGutter: {
    backgroundColor: "rgba(248, 81, 73, 0.3)",
  },
  runStart: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
  },
  runEnd: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderAccent,
  },
  runSingle: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderAccent,
  },
  lineText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: diffTextHeight(theme),
    ...(isWeb
      ? {
          whiteSpace: "pre" as const,
          overflowWrap: "normal" as const,
        }
      : null),
  },
  baseText: {
    color: theme.colors.foregroundMuted,
  },
  contextText: {
    color: theme.colors.foreground,
  },
  addHighlight: {
    backgroundColor: "rgba(46, 160, 67, 0.5)",
  },
  removeHighlight: {
    backgroundColor: "rgba(248, 81, 73, 0.45)",
  },
}));
