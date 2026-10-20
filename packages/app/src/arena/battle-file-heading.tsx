import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { DiffStat } from "@/components/diff-stat";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ArenaChangesRow } from "./changes-rows";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * A file's heading in the Battle changes panel: its name and the shown agent's counts, on one
 * line however narrow the panel. The name leads and the folder gives way first. Pressing it folds
 * the file's diff. The other agent's counts and git's verdict on the pair are left out: the panel
 * shows one agent, and the reader compares by switching. Hover follows docs/hover.md: a plain View
 * tracks the pointer, the Pressable inside it takes the press.
 */
export function BattleFileHeading({
  row,
  side,
  expanded,
  onToggle,
  testID,
}: {
  row: ArenaChangesRow;
  side: ArenaSide;
  expanded: boolean;
  onToggle: (file: string) => void;
  testID: string;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onToggle(row.file), [onToggle, row.file]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const slash = row.file.lastIndexOf("/");
  const name = row.file.slice(slash + 1);
  const folder = slash > 0 ? row.file.slice(0, slash) : "";
  const additions = side === "a" ? row.additionsA : row.additionsB;
  const deletions = side === "a" ? row.deletionsA : row.deletionsB;
  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        onPress={handlePress}
        style={[styles.row, hovered && styles.rowHovered]}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`${expanded ? "Hide" : "Show"} the diff of ${row.file}`}
        testID={testID}
      >
        {expanded ? (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        )}
        <Text style={styles.path} numberOfLines={1}>
          <Text style={styles.name}>{name}</Text>
          {folder ? <Text style={styles.folder}>{`  ${folder}`}</Text> : null}
        </Text>
        {row.binary ? (
          <Text style={styles.muted}>binary</Text>
        ) : (
          <DiffStat additions={additions} deletions={deletions} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  path: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
  },
  name: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  folder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
