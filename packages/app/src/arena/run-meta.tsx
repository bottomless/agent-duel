import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaRun, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { DiffStat } from "@/components/diff-stat";
import { LiveElapsed } from "@/components/message";
import { formatDuration } from "@/utils/time";
import { arenaRunElapsedMs, arenaRunFilesLabel, arenaRunStatusLabel } from "./run-stats";

// Stall detection only has to notice a run going quiet, not count seconds.
const STALL_CHECK_INTERVAL_MS = 10_000;

// DiffStat is a fixed 20px row, taller than a line of sm text. Every state of
// the line reserves that height so the pane header does not grow when one side
// finishes and its stat appears while the other side is still working.
export const ARENA_RUN_META_HEIGHT = 20;

/**
 * One contestant's status line: state, time worked, and the size of its
 * change once it has settled.
 *
 * Owns its own clock so the ticking stays in this leaf. The pane header and
 * the decision bar both render it, and neither re-renders on a tick.
 *
 * The size of the change is the way into the change itself: where the worktree
 * is still there to browse, `onOpenChanges` makes it the control that opens it.
 * Sites that report a finished battle leave it out -- those worktrees are gone.
 */
export const ArenaRunMeta = memo(function ArenaRunMeta({
  run,
  side,
  active,
  onOpenChanges,
}: {
  run: ArenaRun;
  side: ArenaSide;
  active: boolean;
  onOpenChanges?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const isPending = run.runState === "pending";
  useEffect(() => {
    if (!isPending || !active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, isPending]);
  const liveStartedAt = useMemo(() => {
    if (!isPending || typeof run.startedAt !== "string") return null;
    const parsed = Date.parse(run.startedAt);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }, [isPending, run.startedAt]);
  const settledElapsedMs = liveStartedAt ? null : arenaRunElapsedMs(run, now);
  const filesLabel = arenaRunFilesLabel(run.diff);
  return (
    <View style={styles.row} testID={`arena-run-meta-${side}`}>
      <Text style={styles.text}>{arenaRunStatusLabel(run, now)}</Text>
      {liveStartedAt ? (
        <>
          <Text style={styles.text}>·</Text>
          <LiveElapsed
            startedAt={liveStartedAt}
            active={active}
            style={styles.elapsed}
            testID={`arena-run-elapsed-${side}`}
          />
        </>
      ) : null}
      {settledElapsedMs !== null ? (
        <>
          <Text style={styles.text}>·</Text>
          <Text style={styles.elapsed} testID={`arena-run-elapsed-${side}`}>
            {formatDuration(settledElapsedMs)}
          </Text>
        </>
      ) : null}
      {run.diff && run.diff.files === 0 ? (
        <>
          <Text style={styles.text}>·</Text>
          <Text style={styles.text} testID={`arena-run-diff-${side}`}>
            No changes
          </Text>
        </>
      ) : null}
      {run.diff && run.diff.files > 0 ? (
        <>
          <Text style={styles.text}>·</Text>
          <RunDiffStat
            additions={run.diff.additions}
            deletions={run.diff.deletions}
            filesLabel={filesLabel}
            side={side}
            onOpenChanges={onOpenChanges}
          />
        </>
      ) : null}
    </View>
  );
});

/** The change's size, and where the worktree is live, the way into it. */
function RunDiffStat({
  additions,
  deletions,
  filesLabel,
  side,
  onOpenChanges,
}: {
  additions: number;
  deletions: number;
  filesLabel: string | null;
  side: ArenaSide;
  onOpenChanges?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const stat = (
    <>
      <DiffStat additions={additions} deletions={deletions} testID={`arena-run-diff-${side}`} />
      {filesLabel ? (
        <>
          <Text style={styles.text}>·</Text>
          <Text style={styles.text}>{filesLabel}</Text>
        </>
      ) : null}
    </>
  );
  if (!onOpenChanges) {
    return <View style={styles.stat}>{stat}</View>;
  }
  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        onPress={onOpenChanges}
        style={[styles.stat, styles.statPressable, hovered && styles.statHovered]}
        accessibilityRole="button"
        accessibilityLabel={`Show Agent ${side.toUpperCase()}'s changes`}
        testID={`arena-run-diff-open-${side}`}
      >
        {stat}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    minWidth: 0,
    minHeight: ARENA_RUN_META_HEIGHT,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // The padding is there whether or not the row is hovered, so the line does not
  // move under the cursor the moment the highlight appears.
  statPressable: {
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  statHovered: {
    backgroundColor: theme.colors.surface2,
  },
  elapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
