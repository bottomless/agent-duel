import { memo, useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Check, CheckSquare, Circle, CircleDot, CircleSlash } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaRunTasks, type ArenaTask } from "./task-progress";

const ThemedCheck = withUnistyles(Check);
const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const completedIcon = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
} satisfies Record<ArenaTask["status"], string>;

interface TaskProgressProps {
  tasks: readonly ArenaTask[];
  state: "running" | "ended" | "snapshot";
  detailsMaxHeight?: number;
}

export function ArenaRunTaskFooter({
  run,
  paneMaxHeight,
}: {
  run: ArenaRun;
  paneMaxHeight: number;
}) {
  const tasks = useMemo(() => arenaRunTasks(run), [run]);
  if (tasks.length === 0) return null;
  return (
    <View style={styles.footer} testID="arena-task-footer">
      <ArenaTaskProgressCard
        key={run.id}
        tasks={tasks}
        state="running"
        detailsMaxHeight={Math.max(40, Math.min(200, paneMaxHeight - 260))}
      />
    </View>
  );
}

function TaskStatusIcon({ status, active }: { status: ArenaTask["status"]; active: boolean }) {
  switch (status) {
    case "completed":
      return <ThemedCheck size={ICON_SIZE.sm} uniProps={completedIcon} />;
    case "cancelled":
      return <ThemedCircleSlash size={ICON_SIZE.sm} uniProps={mutedIcon} />;
    case "in_progress":
      return <ThemedCircleDot size={ICON_SIZE.sm} uniProps={active ? activeIcon : mutedIcon} />;
    default:
      return <ThemedCircle size={ICON_SIZE.sm} uniProps={mutedIcon} />;
  }
}

function TaskRow({ task, active }: { task: ArenaTask; active: boolean }) {
  const settled = task.status === "completed" || task.status === "cancelled";
  const label = STATUS_LABELS[task.status];
  return (
    <View style={styles.row} accessibilityLabel={`${label}: ${task.content}`}>
      <View style={styles.icon}>
        <TaskStatusIcon status={task.status} active={active} />
      </View>
      <Text style={[styles.task, settled && styles.settledTask]}>{task.content}</Text>
      <Text style={styles.status}>{label}</Text>
    </View>
  );
}

export const ArenaTaskProgressCard = memo(function ArenaTaskProgressCard({
  tasks,
  state,
  detailsMaxHeight = 200,
}: TaskProgressProps) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const detailsStyle = useMemo(
    () => inlineUnistylesStyle({ maxHeight: detailsMaxHeight }),
    [detailsMaxHeight],
  );
  const completed = tasks.filter((task) => task.status === "completed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const hasUnfinishedTasks = completed + cancelled < tasks.length;
  const endedWithUnfinishedTasks = state === "ended" && hasUnfinishedTasks;
  const active = state === "running";
  const current = active ? tasks.find((task) => task.status === "in_progress") : undefined;
  const label = tasks.length === 0 ? "Tasks cleared" : `${completed}/${tasks.length} tasks`;
  const secondaryLabel = useMemo(() => {
    if (current) return current.content;
    if (endedWithUnfinishedTasks) return "Run ended";
    if (cancelled > 0) return `${cancelled} cancelled`;
    return undefined;
  }, [cancelled, current, endedWithUnfinishedTasks]);
  const renderDetails = useCallback(() => {
    const occurrences = new Map<string, number>();
    const rows = tasks.map((task) => {
      const occurrence = occurrences.get(task.content) ?? 0;
      occurrences.set(task.content, occurrence + 1);
      const key = JSON.stringify([task.content, occurrence]);
      return <TaskRow key={key} task={task} active={active} />;
    });
    const details = (
      <View style={styles.list}>
        {rows}
        {endedWithUnfinishedTasks ? (
          <Text style={styles.note}>The run ended with unfinished tasks.</Text>
        ) : null}
        {tasks.length === 0 ? <Text style={styles.note}>No tasks.</Text> : null}
      </View>
    );
    if (!active) return details;
    return (
      <ScrollView style={detailsStyle} nestedScrollEnabled>
        {details}
      </ScrollView>
    );
  }, [active, detailsStyle, endedWithUnfinishedTasks, tasks]);

  return (
    <ExpandableBadge
      testID={state === "snapshot" ? "arena-task-update" : "arena-task-progress"}
      label={label}
      secondaryLabel={secondaryLabel}
      icon={CheckSquare}
      isExpanded={expanded}
      onToggle={toggle}
      renderDetails={renderDetails}
      disableOuterSpacing
      compactLabel
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexShrink: 0,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  list: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  icon: {
    paddingTop: theme.spacing[0.5],
  },
  task: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  settledTask: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
