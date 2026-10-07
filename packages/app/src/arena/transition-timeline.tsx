import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Check, Circle, CircleSlash, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  transitionDuration,
  transitionTimelineRows,
  type TimelineTurn,
  type TransitionPhase,
  type TransitionTimelineRow,
} from "./transition-timeline-state";

const ThemedCheck = withUnistyles(Check);
const ThemedCircle = withUnistyles(Circle);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const ThemedX = withUnistyles(X);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeIcon = (theme: Theme) => ({ color: theme.colors.foreground });
const completedIcon = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const failedIcon = (theme: Theme) => ({ color: theme.colors.statusDanger });

function TimelineMarker({
  state,
  active,
}: {
  state: TransitionTimelineRow["state"];
  active: boolean;
}) {
  switch (state) {
    case "completed":
      return <ThemedCheck size={ICON_SIZE.sm} uniProps={completedIcon} />;
    case "running":
      if (!active) return <ThemedCircle size={ICON_SIZE.sm} uniProps={mutedIcon} />;
      return <ThemedSpinner size={ICON_SIZE.sm} uniProps={activeIcon} />;
    case "failed":
      return <ThemedX size={ICON_SIZE.sm} uniProps={failedIcon} />;
    case "interrupted":
      return <ThemedCircleSlash size={ICON_SIZE.sm} uniProps={mutedIcon} />;
    case "waiting":
      return <ThemedCircle size={ICON_SIZE.sm} uniProps={mutedIcon} />;
  }
}

function rowStatus(row: TransitionTimelineRow, now: number): string {
  if (row.state === "waiting") return "";
  if (row.state === "failed") return "Failed";
  if (row.state === "interrupted") return "Interrupted";
  const duration =
    row.startedAt === null ? "" : transitionDuration((row.finishedAt ?? now) - row.startedAt);
  if (row.state === "running") return duration ? `In progress · ${duration}` : "In progress";
  return duration;
}

function TimelineRow({
  row,
  last,
  now,
  panelActive,
}: {
  row: TransitionTimelineRow;
  last: boolean;
  now: number;
  panelActive: boolean;
}) {
  const active = row.state === "running";
  const status = rowStatus(row, now);
  return (
    <View style={styles.row} accessibilityLabel={`${row.label}. ${row.state}. ${status}`}>
      <View style={styles.rail}>
        <View style={styles.marker}>
          <TimelineMarker state={row.state} active={panelActive} />
        </View>
        {!last ? <View style={styles.connector} /> : null}
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.label, active && styles.activeLabel]} numberOfLines={1}>
          {row.label}
        </Text>
        <Text style={[styles.duration, active && styles.activeLabel]}>{status}</Text>
      </View>
    </View>
  );
}

export function ArenaTransitionTimeline({
  phase,
  turn,
}: {
  phase: TransitionPhase;
  turn?: TimelineTurn;
}) {
  const panelActive = useRetainedPanelActive();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!panelActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [panelActive]);
  const rows = transitionTimelineRows({ phase, turn });
  const setup = phase === "setup";
  return (
    <View style={styles.panel} testID={`arena-transition-timeline-${phase}`}>
      <View style={styles.header}>
        <Text style={styles.title}>{setup ? "Setting up battle" : "Applying selected result"}</Text>
        <Text style={styles.caption}>In progress</Text>
      </View>
      <View style={[styles.timeline, setup ? styles.setupTimeline : styles.resolutionTimeline]}>
        {rows.map((row, index) => (
          <TimelineRow
            key={row.id}
            row={row}
            last={index === rows.length - 1}
            now={now}
            panelActive={panelActive}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    width: "100%",
    alignSelf: "center",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  caption: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  // Reserve space for this transition's operations so new rows do not move the chat above it.
  timeline: { justifyContent: "flex-start" },
  setupTimeline: { minHeight: theme.spacing[8] * 4 },
  resolutionTimeline: { minHeight: theme.spacing[8] * 6 },
  row: { flexDirection: "row", gap: theme.spacing[3], minHeight: theme.spacing[8] },
  rail: { width: theme.iconSize.sm, alignItems: "center" },
  marker: { height: theme.spacing[6], alignItems: "center", justifyContent: "center" },
  connector: {
    position: "absolute",
    top: theme.spacing[6],
    bottom: -theme.spacing[1],
    width: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  label: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  activeLabel: { color: theme.colors.foreground },
  duration: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));
