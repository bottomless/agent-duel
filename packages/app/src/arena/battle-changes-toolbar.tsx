import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MoreHorizontal } from "lucide-react-native";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { DiffStat } from "@/components/diff-stat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useBattleChangesStore } from "./battle-changes-store";
import { arenaChangesCountLabel, type ArenaChangesRow } from "./changes-rows";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const SIDE_OPTIONS: Array<{ value: ArenaSide; label: string; testID: string }> = [
  { value: "a", label: "Agent A", testID: "arena-battle-changes-side-a" },
  { value: "b", label: "Agent B", testID: "arena-battle-changes-side-b" },
];

export function sideCounts(row: ArenaChangesRow, side: ArenaSide) {
  return side === "a"
    ? { additions: row.additionsA, deletions: row.deletionsA }
    : { additions: row.additionsB, deletions: row.deletionsB };
}

/**
 * The panel's one row of controls: whose changes it shows, how many files and lines that is, and
 * a menu for the view, in the shape of Claude's diff menu. The view options hold across chats.
 */
export function BattleChangesToolbar({
  side,
  onPickSide,
  rows,
  onCollapseAll,
  onExpandAll,
}: {
  side: ArenaSide;
  onPickSide: (side: ArenaSide) => void;
  rows: readonly ArenaChangesRow[];
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  const wrapLines = useBattleChangesStore((state) => state.wrapLines);
  const showFileList = useBattleChangesStore((state) => state.showFileList);
  const setWrapLines = useBattleChangesStore((state) => state.setWrapLines);
  const setShowFileList = useBattleChangesStore((state) => state.setShowFileList);
  const toggleWrap = useCallback(() => setWrapLines(!wrapLines), [setWrapLines, wrapLines]);
  const toggleFileList = useCallback(
    () => setShowFileList(!showFileList),
    [setShowFileList, showFileList],
  );
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    const counts = sideCounts(row, side);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return (
    <View style={styles.toolbar} testID="arena-battle-changes-toolbar">
      <SegmentedControl
        options={SIDE_OPTIONS}
        value={side}
        onValueChange={onPickSide}
        size="xs"
        testID="arena-battle-changes-side"
      />
      <View style={styles.spacer} />
      <Text style={styles.count}>{arenaChangesCountLabel(rows.length)}</Text>
      {rows.length > 0 ? <DiffStat additions={additions} deletions={deletions} /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          testID="arena-battle-changes-menu"
          accessibilityRole="button"
          accessibilityLabel="Change how the changes are shown"
          style={styles.menuTrigger}
        >
          <ThemedMoreHorizontal size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" offset={4} minWidth={220}>
          <DropdownMenuItem
            selected={showFileList}
            onSelect={toggleFileList}
            testID="arena-battle-changes-menu-files"
          >
            Show files
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onCollapseAll} testID="arena-battle-changes-menu-collapse">
            Collapse all files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExpandAll} testID="arena-battle-changes-menu-expand">
            Expand all files
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            selected={wrapLines}
            onSelect={toggleWrap}
            testID="arena-battle-changes-menu-wrap"
          >
            Word wrap
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

/**
 * The shown agent's files as a short list above the diffs, for jumping to one in a battle that
 * touched many. It scrolls on its own past a few rows, so it never pushes the diffs away.
 */
export function BattleFileList({
  rows,
  side,
  onJump,
}: {
  rows: readonly ArenaChangesRow[];
  side: ArenaSide;
  onJump: (file: string) => void;
}) {
  return (
    <ScrollView style={styles.fileList} testID="arena-battle-changes-file-list">
      {rows.map((row) => (
        <FileListRow key={row.file} row={row} side={side} onJump={onJump} />
      ))}
    </ScrollView>
  );
}

function FileListRow({
  row,
  side,
  onJump,
}: {
  row: ArenaChangesRow;
  side: ArenaSide;
  onJump: (file: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const jump = useCallback(() => onJump(row.file), [onJump, row.file]);
  const slash = row.file.lastIndexOf("/");
  const counts = sideCounts(row, side);
  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        onPress={jump}
        style={[styles.fileRow, hovered && styles.fileRowHovered]}
        accessibilityRole="button"
        accessibilityLabel={`Go to ${row.file}`}
        testID={`arena-battle-changes-file-link-${row.file}`}
      >
        <Text style={styles.filePath} numberOfLines={1}>
          <Text style={styles.fileName}>{row.file.slice(slash + 1)}</Text>
          {slash > 0 ? (
            <Text style={styles.fileFolder}>{`  ${row.file.slice(0, slash)}`}</Text>
          ) : null}
        </Text>
        {row.binary ? (
          <Text style={styles.fileFolder}>binary</Text>
        ) : (
          <DiffStat additions={counts.additions} deletions={counts.deletions} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 40,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  spacer: {
    flex: 1,
  },
  count: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  menuTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  // A few rows tall, then it scrolls on its own; the diffs below keep most of the panel.
  fileList: {
    maxHeight: 6 * 30,
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileRow: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  fileRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filePath: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
  },
  fileName: {
    color: theme.colors.foreground,
  },
  fileFolder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
