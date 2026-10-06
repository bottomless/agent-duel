import { useShallow } from "zustand/react/shallow";
import { tasksAfterBattle } from "./tasks";
import React, { memo, useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Check, ChevronDown, ChevronRight, Circle, CircleDot } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const ThemedCheck = withUnistyles(Check);
const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const completedIcon = (theme: Theme) => ({ color: theme.colors.statusSuccess });

export const AgentTaskList = memo(function AgentTaskList({
  serverId,
  agentId,
  battleEndedAt,
}: {
  serverId: string;
  agentId: string;
  battleEndedAt: string | null;
}) {
  const tasks = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return tasksAfterBattle(
        [
          ...(session?.agentStreamTail.get(agentId) ?? []),
          ...(session?.agentStreamHead.get(agentId) ?? []),
        ],
        battleEndedAt,
      );
    }),
  );
  const isTurnActive = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isActive,
  );
  if (tasks.length === 0) return null;
  return <TaskListCard tasks={tasks} isTurnActive={isTurnActive} />;
});

function TaskStatusIcon({ task, active }: { task: TodoEntry; active: boolean }) {
  if (task.completed || task.status === "completed") {
    return <ThemedCheck size={15} uniProps={completedIcon} />;
  }
  if (task.status === "in_progress") {
    return <ThemedCircleDot size={15} uniProps={active ? activeIcon : mutedIcon} />;
  }
  return <ThemedCircle size={15} uniProps={mutedIcon} />;
}

const TaskListCard = memo(function TaskListCard({
  tasks,
  isTurnActive,
}: {
  tasks: TodoEntry[];
  isTurnActive: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const completed = useMemo(
    () => tasks.filter((task) => task.completed || task.status === "completed").length,
    [tasks],
  );
  const currentTask = useMemo(
    () =>
      tasks.find((task) => task.status === "in_progress") ??
      tasks.find((task) => !task.completed && task.status !== "completed"),
    [tasks],
  );
  let currentTaskText: string | undefined;
  if (isTurnActive) {
    currentTaskText =
      currentTask?.status === "in_progress" && currentTask.activeForm
        ? currentTask.activeForm
        : currentTask?.text;
  }
  const label = currentTaskText
    ? t("message.todo.tasksProgressCurrent", {
        completed,
        total: tasks.length,
        task: currentTaskText,
      })
    : t("message.todo.tasksProgress", { completed, total: tasks.length });
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View style={styles.container} accessibilityLabel={t("message.todo.title")}>
      <View style={styles.track}>
        <View style={styles.card}>
          <Button
            variant="ghost"
            size="xs"
            onPress={toggle}
            accessibilityLabel={label}
            accessibilityState={accessibilityState}
            leftIcon={expanded ? ChevronDown : ChevronRight}
            style={styles.header}
            textStyle={styles.headerText}
          >
            {label}
          </Button>
          {expanded ? (
            <ScrollView style={styles.list} nestedScrollEnabled>
              {tasks.map((task, index) => {
                const isActive = isTurnActive && task.status === "in_progress";
                const text = isActive && task.activeForm ? task.activeForm : task.text;
                return (
                  <View
                    key={task.id ?? `${index}:${task.text}`}
                    style={styles.row}
                    accessibilityLabel={text}
                  >
                    <TaskStatusIcon task={task} active={isActive} />
                    <Text
                      numberOfLines={1}
                      style={[styles.taskText, task.completed && styles.completedText]}
                    >
                      {text}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
    paddingBottom: theme.spacing[4],
  },
  header: {
    width: "100%",
    justifyContent: "flex-start",
    borderRadius: 0,
    paddingHorizontal: theme.spacing[3],
  },
  headerText: {
    color: theme.colors.foregroundMuted,
  },
  list: {
    maxHeight: 200,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  taskText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  completedText: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
}));
