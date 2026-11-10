import { useTranslation } from "react-i18next";
import { Fragment, memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ArenaChangesRow } from "./changes-rows";
import { divergenceStatusLabel } from "./divergence";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useContainerWidth } from "@/hooks/use-container-width";
import { BATTLE_GUTTER } from "./battle-layout";
import { arenaChangesCountLabel } from "./changes-rows";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Rows shown before the rest wait behind "Show more". A battle that touched hundreds of files
 * otherwise grows the list past the screen and pushes both agents' messages away. The list does
 * not scroll inside itself, because the diffs it holds scroll inside themselves. An open row
 * past these, such as a default file deep in the list, shows after them on its own rather than
 * pulling in every row above it.
 */
const VISIBLE_ROWS = 8;

// The same width at which the battle stacks its two answers (`battle-view.tsx`). Narrower, a row
// keeps both sides' counts on one line, as in the side panel.
const SPLIT_MIN_WIDTH = 520;

/**
 * The files a battle touched, one row each, with what A and B did to them.
 *
 * Pressing a row opens that file's diff right under it, and pressing it again
 * closes it, the way a file header toggles its diff in a code review; several
 * can be open at once, and the chevron says which state each row is in. The
 * open row is the diff's header, so the diff carries no close control of its
 * own. git's verdict and the per-side counts are words, not pills, so nothing
 * on the row reads as a tab. Hover follows docs/hover.md: a plain View tracks
 * the pointer, the PressHighlight inside it takes the press.
 */
export const ArenaChangesList = memo(function ArenaChangesList({
  rows,
  openFiles,
  waitingFor,
  onToggle,
  renderDiff,
}: {
  rows: readonly ArenaChangesRow[];
  /** The rows whose diffs are open. */
  openFiles: readonly string[];
  /** The side still working: its counts say so, and no verdict on a pair that is not in yet. */
  waitingFor?: ArenaSide;
  /** Opens a closed row's diff or closes an open one. */
  onToggle: (file: string) => void;
  /** The diff that opens under a row; `onColumns` when the rows sit on the answers' columns. */
  renderDiff: (file: string, onColumns: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  // Rows past the first ones that have been open while the rest were hidden. Closing one leaves
  // it where it is, so the row the reader just pressed does not vanish from under the pointer.
  const [kept, setKept] = useState<readonly string[]>([]);
  const toggleShowAll = useCallback(() => {
    setShowAll((shown) => !shown);
    setKept([]);
  }, []);
  const beyond = showAll ? [] : rows.slice(VISIBLE_ROWS);
  const newlyOpen = beyond
    .filter((row) => openFiles.includes(row.file) && !kept.includes(row.file))
    .map((row) => row.file);
  if (newlyOpen.length > 0) setKept([...kept, ...newlyOpen]);
  const pinned = beyond.filter((row) => openFiles.includes(row.file) || kept.includes(row.file));
  const visible = showAll ? rows : [...rows.slice(0, VISIBLE_ROWS), ...pinned];
  const hidden = rows.length - visible.length;
  const footer = hidden > 0 || (showAll && rows.length > VISIBLE_ROWS);
  const { width, onLayout } = useContainerWidth();
  const split = width >= SPLIT_MIN_WIDTH;
  return (
    <View
      style={split ? styles.splitList : styles.list}
      onLayout={onLayout}
      testID="arena-changes-list"
    >
      {split ? (
        <View style={styles.columns}>
          <SideTotals side="a" rows={rows} waiting={waitingFor === "a"} />
          <SideTotals side="b" rows={rows} waiting={waitingFor === "b"} />
        </View>
      ) : null}
      {visible.map((row, index) => {
        const open = openFiles.includes(row.file);
        const lastItem = index === visible.length - 1 && !footer;
        return (
          <Fragment key={row.file}>
            {split ? (
              <SplitChangesRow row={row} waitingFor={waitingFor} onToggle={onToggle} open={open} />
            ) : (
              <ChangesRow row={row} waitingFor={waitingFor} onToggle={onToggle} open={open} />
            )}
            {open ? (
              <View
                style={[
                  split ? styles.splitDiffBand : styles.diffBand,
                  lastItem && styles.diffBandLast,
                ]}
                testID={`arena-changes-diff-${row.file}`}
              >
                {renderDiff(row.file, split)}
              </View>
            ) : null}
          </Fragment>
        );
      })}
      {footer ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={hidden > 0 ? ChevronDown : ChevronUp}
          onPress={toggleShowAll}
          style={styles.more}
          testID="arena-changes-more"
        >
          {hidden > 0
            ? t(hidden === 1 ? "arena.moreFile" : "arena.moreFiles", { total: hidden })
            : t("arena.fewerFiles")}
        </Button>
      ) : null}
    </View>
  );
});

function statusStyle(status: ArenaChangesRow["status"]) {
  if (status === "identical") return styles.statusSame;
  if (status === "diverging") return styles.statusDiverging;
  return styles.statusMuted;
}

function ChangesRow({
  row,
  waitingFor,
  onToggle,
  open,
}: {
  row: ArenaChangesRow;
  waitingFor: ArenaSide | undefined;
  onToggle: (file: string) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onToggle(row.file), [onToggle, row.file]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        onPress={handlePress}
        style={[styles.row, hovered && styles.rowHovered, open && styles.rowOpen]}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={t(open ? "arena.hideDiff" : "arena.showDiff", { file: row.file })}
        testID={`arena-changes-row-${row.file}`}
      >
        {open ? (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        )}
        <Text style={styles.file} numberOfLines={1}>
          {row.file}
        </Text>
        {waitingFor ? null : (
          <Text style={[styles.status, statusStyle(row.status)]}>
            {divergenceStatusLabel(row.status, t)}
          </Text>
        )}
        <View style={styles.stats}>
          <SideStat side="a" row={row} waiting={waitingFor === "a"} />
          <SideStat side="b" row={row} waiting={waitingFor === "b"} />
        </View>
      </PressHighlight>
    </View>
  );
}

/** Each side's total, at the head of its column: how many files it changed and by how much. */
function SideTotals({
  side,
  rows,
  waiting,
}: {
  side: ArenaSide;
  rows: readonly ArenaChangesRow[];
  waiting: boolean;
}) {
  const { t } = useTranslation();
  const changed = rows.filter((row) => row.changedBy === "both" || row.changedBy === side);
  const additions = changed.reduce(
    (total, row) => total + (side === "a" ? row.additionsA : row.additionsB),
    0,
  );
  const deletions = changed.reduce(
    (total, row) => total + (side === "a" ? row.deletionsA : row.deletionsB),
    0,
  );
  let content: ReactNode;
  if (waiting) content = <Text style={styles.waiting}>{t("arena.working")}</Text>;
  else if (changed.length === 0)
    content = <Text style={styles.headText}>{t("arena.noChanges")}</Text>;
  else {
    content = (
      <>
        <Text style={styles.headText}>{arenaChangesCountLabel(changed.length)}</Text>
        <DiffStat additions={additions} deletions={deletions} />
      </>
    );
  }
  return (
    <View style={styles.column} testID={`arena-changes-head-${side}`}>
      <View style={styles.head}>{content}</View>
    </View>
  );
}

/**
 * Neither side changed a file: each answer says so under itself, rather than one sentence that
 * starts under A and reads as A's.
 */
export function ArenaNoChangesColumns() {
  const { t } = useTranslation();
  const { width, onLayout } = useContainerWidth();
  const split = width === 0 || width >= SPLIT_MIN_WIDTH;
  return (
    <View
      style={[styles.columns, !split && styles.columnsStacked]}
      onLayout={onLayout}
      testID="arena-identical-results"
    >
      {(["a", "b"] as const).map((side) => (
        <View key={side} style={styles.column} testID={`arena-changes-head-${side}`}>
          <View style={styles.head}>
            <Text style={styles.headText}>{t("arena.noChanges")}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A file on the answers' columns: what A did to it under A, what B did under B. The row is one
 * press target, and its diff opens under it, A's side on the left as the columns are.
 */
function SplitChangesRow({
  row,
  waitingFor,
  onToggle,
  open,
}: {
  row: ArenaChangesRow;
  waitingFor: ArenaSide | undefined;
  onToggle: (file: string) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onToggle(row.file), [onToggle, row.file]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        onPress={handlePress}
        style={[styles.splitRow, hovered && styles.rowHovered, open && styles.rowOpen]}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={t(open ? "arena.hideDiff" : "arena.showDiff", { file: row.file })}
        testID={`arena-changes-row-${row.file}`}
      >
        <SideCell side="a" row={row} waiting={waitingFor === "a"} open={open} />
        <SideCell side="b" row={row} waiting={waitingFor === "b"} />
      </PressHighlight>
    </View>
  );
}

function SideCell({
  side,
  row,
  waiting,
  open,
}: {
  side: ArenaSide;
  row: ArenaChangesRow;
  waiting: boolean;
  /** Set on A's cell only: the row's chevron sits at its start. */
  open?: boolean;
}) {
  const changed = row.changedBy === "both" || row.changedBy === side;
  const quiet = !waiting && !changed;
  return (
    <View style={styles.cell}>
      {open === undefined ? null : <RowChevron open={open} />}
      <Text style={[styles.file, quiet && styles.fileQuiet]} numberOfLines={1}>
        {row.file}
      </Text>
      <SideStat side={side} row={row} waiting={waiting} labelled={false} />
      {row.status === "identical" && !waiting ? <SameResult /> : null}
    </View>
  );
}

function RowChevron({ open }: { open: boolean }) {
  return open ? (
    <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
  ) : (
    <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
  );
}

function SameResult() {
  const { t } = useTranslation();
  return <Text style={styles.untouched}>· {t("arena.sameResult")}</Text>;
}

function SideStat({
  side,
  row,
  waiting,
  labelled = true,
}: {
  side: "a" | "b";
  row: ArenaChangesRow;
  /** The side is still working, so it has no counts yet. */
  waiting: boolean;
  /** On the answers' columns the column says whose count it is, so the letter goes. */
  labelled?: boolean;
}) {
  const { t } = useTranslation();
  const changed = row.changedBy === "both" || row.changedBy === side;
  const additions = side === "a" ? row.additionsA : row.additionsB;
  const deletions = side === "a" ? row.deletionsA : row.deletionsB;
  let stat: ReactNode;
  if (waiting) {
    stat = <Text style={styles.waiting}>{t("arena.working")}</Text>;
  } else if (!changed) {
    stat = <Text style={styles.untouched}>{t("arena.unchanged")}</Text>;
  } else if (row.binary) {
    stat = <Text style={styles.untouched}>{t("arena.binary")}</Text>;
  } else {
    stat = <DiffStat additions={additions} deletions={deletions} />;
  }
  if (!labelled) return <View style={styles.cellStat}>{stat}</View>;
  return (
    <View style={styles.sideStat}>
      <Text style={styles.sideLabel}>{side.toUpperCase()}</Text>
      {stat}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  // On the answers' columns there is no box: the columns' heads open it, hairlines part the rows.
  splitList: {},
  columns: {
    flexDirection: "row",
    columnGap: BATTLE_GUTTER,
  },
  columnsStacked: {
    flexDirection: "column",
    rowGap: theme.spacing[3],
  },
  column: {
    flex: 1,
    minWidth: 0,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  headText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
  },
  splitRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    columnGap: BATTLE_GUTTER,
    paddingVertical: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  cell: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cellStat: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  fileQuiet: {
    color: theme.colors.foregroundMuted,
  },
  splitDiffBand: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[3],
  },
  // An open diff is a band between its row and the next, one hairline above and below.
  diffBand: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  // The list's own border already closes the last band.
  diffBandLast: {
    borderBottomWidth: 0,
  },
  // The button's padding matches the rows', so its chevron sits on the rows' chevron rail.
  more: {
    alignSelf: "flex-start",
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    minHeight: 36,
    flexDirection: "row",
    // In a narrow side panel the stats drop under the name rather than
    // squeezing it out; the name is what the row is for.
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowOpen: {
    backgroundColor: theme.colors.surface2,
  },
  file: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 120,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  status: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  statusSame: {
    color: theme.colors.statusSuccess,
  },
  statusDiverging: {
    color: theme.colors.statusDanger,
  },
  statusMuted: {
    color: theme.colors.foregroundMuted,
  },
  stats: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 0,
  },
  sideStat: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Both columns hold the widest stat so the rows line up on one rail.
    minWidth: 92,
  },
  sideLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 12,
  },
  untouched: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  waiting: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
