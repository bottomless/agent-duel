import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { AlertTriangle, ChevronDown, ChevronRight, Monitor } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import {
  environmentTransitionCounts,
  transitionListenerLabels,
  transitionSummaryLabel,
  type ArenaTransition,
} from "./environment";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedMonitor = withUnistyles(Monitor);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

/** Completed environment changes stay available as a report. */
export function arenaTransitionRowVisible(transition: ArenaTransition | undefined): boolean {
  return transition !== undefined && transitionSummaryLabel(transition) !== null;
}

function TransitionDetails({ transition }: { transition: ArenaTransition }) {
  const commands = transition.stoppedCommands;
  const omissions = transition.copyOmissions;
  return (
    <View style={styles.details}>
      {commands.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.title}>Stopped commands</Text>
          {commands.map((command) => {
            const listenerLabels = transitionListenerLabels(command);
            return (
              <View
                style={styles.row}
                key={`${command.relativeCwd}-${command.command}-${command.status}-${command.verified}-${command.error ?? ""}`}
              >
                <StatusBadge
                  label={command.status === "already_absent" ? "Already absent" : command.status}
                  variant={command.status === "failed" ? "error" : "muted"}
                />
                <View style={styles.copy}>
                  <Text style={styles.command} numberOfLines={2}>
                    {command.command}
                  </Text>
                  <Text style={styles.meta}>{command.relativeCwd}</Text>
                  {listenerLabels.length > 0 ? (
                    <Text style={styles.meta}>
                      Released listeners: {listenerLabels.join(" · ")}
                    </Text>
                  ) : null}
                  <Text style={styles.meta}>
                    {command.verified ? "Termination verified" : "Termination not verified"}
                  </Text>
                  {command.error ? <Text style={styles.failure}>{command.error}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {omissions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.title}>Paths skipped when copying</Text>
          {omissions.map((omission) => (
            <View
              style={styles.row}
              key={`${omission.relativePath}-${omission.omissionReason ?? ""}`}
            >
              <Text style={styles.path} numberOfLines={2}>
                {omission.relativePath}
              </Text>
              <Text style={styles.meta}>{omission.omissionReason ?? "omitted"}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * What Arena did to the previous winner's environment before this turn started. One muted
 * line, only when something actually happened; the details stay behind a toggle.
 */
export function ArenaTransitionRow({ transition }: { transition?: ArenaTransition }) {
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const label = transition ? transitionSummaryLabel(transition) : null;
  if (!transition || !label) return null;
  const failed = environmentTransitionCounts(transition).failures > 0;
  const Icon = failed ? ThemedAlertTriangle : ThemedMonitor;
  return (
    <View style={styles.root} testID="arena-environment-transition">
      <Pressable
        onPress={handleToggle}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} environment transition details`}
        testID="arena-environment-transition-toggle"
      >
        <Icon size={14} uniProps={failed ? dangerColorMapping : mutedColorMapping} />
        <Text style={styles.summary} numberOfLines={2}>
          {label}
        </Text>
        <View style={styles.toggle}>
          <Text style={styles.toggleText}>Details</Text>
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
          )}
        </View>
      </Pressable>
      {expanded ? <TransitionDetails transition={transition} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    width: "100%",
    gap: theme.spacing[1],
  },
  header: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  summary: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  details: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  section: {
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
  path: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.xs,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  failure: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));
