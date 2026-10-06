import { Text, View } from "react-native";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { ArenaPathList } from "./path-list";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

/** Icon width (16) plus the heading gap (spacing[2] = 8): the rail the title starts on. */
const CALLOUT_TITLE_RAIL = 24;

export interface ArenaCalloutAction {
  label: string;
  onPress: () => void;
  loading: boolean;
  disabled?: boolean;
  /**
   * The callout's own emphasis. `secondary` is the filled default — `outline` is borderAccent on
   * transparent, which is invisible on the callout's light surface, so a second action takes
   * `ghost` rather than an outline it cannot draw.
   */
  variant?: "secondary" | "ghost";
  testID?: string;
}

/**
 * Why something is paused, and the way out of it.
 *
 * Layout follows docs/design.md. One action or two sit on the title's row, centred with the icon
 * so the icon lands on the title's line rather than 6px above it — an action button is 32px tall
 * and was stretching the row while the icon stayed pinned to a 20px box at the top. Everything
 * below is indented to the title's rail.
 *
 * Actions drop below the copy once they would crowd that row: a third choice, a footer control,
 * or a labeled file list, whose rows put real distance between the title and the buttons that act
 * on them. The held prompt is separated by a divider rather than a fill ("rows do not need their
 * own background to feel separated") and reads as content through colour at the prose's size,
 * since hierarchy here is weight and colour, not size.
 */
export function ArenaCallout({
  title,
  tone = "danger",
  detail,
  testID,
  actions,
  paths,
  pathsLabel,
  list,
  footer,
  pendingPrompt,
}: {
  title: string;
  tone?: "danger" | "warning";
  detail: string;
  testID: string;
  /** Rendered in order; the first is the emphasised one. */
  actions?: readonly ArenaCalloutAction[];
  /** Repo-relative paths the detail counted. Listed as rows, never comma-joined into the prose. */
  paths?: readonly string[];
  pathsLabel?: string;
  /** A second labeled list under the paths, for rows that are not files. */
  list?: ReactNode;
  footer?: ReactNode;
  /** A battle prompt held until the pause lifts. One truncated line: information, not a task. */
  pendingPrompt?: string;
}) {
  const hasPaths = (paths?.length ?? 0) > 0;
  const actionsBelow =
    Boolean(footer) || (actions?.length ?? 0) > 2 || Boolean(pathsLabel) || Boolean(list);
  const actionButtons = actions?.length ? (
    <View style={styles.calloutActions}>
      {actions.map((action) => (
        <Button
          key={action.label}
          // `outline` is borderAccent on transparent — #ececf1 on the callout's white
          // surface0, which is invisible on light. These are the callout's actions, not
          // low-emphasis row controls, so they take filled or ghost surfaces instead.
          variant={action.variant ?? "secondary"}
          size="sm"
          style={styles.calloutAction}
          onPress={action.onPress}
          loading={action.loading}
          disabled={action.disabled ?? action.loading}
          {...(action.testID ? { testID: action.testID } : {})}
        >
          {action.label}
        </Button>
      ))}
    </View>
  ) : null;
  return (
    <View
      style={[styles.callout, tone === "warning" ? styles.warning : undefined]}
      accessibilityRole="alert"
      testID={testID}
    >
      <View style={styles.calloutTopRow}>
        <View style={styles.calloutHeading}>
          <ThemedAlertTriangle
            size={16}
            uniProps={tone === "warning" ? warningColorMapping : dangerColorMapping}
          />
          <Text style={styles.calloutTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {!actionsBelow ? actionButtons : null}
      </View>
      <Text style={styles.calloutDetail}>{detail}</Text>
      {hasPaths && paths ? (
        <View style={styles.calloutPaths}>
          <ArenaPathList paths={paths} label={pathsLabel} />
        </View>
      ) : null}
      {list ? <View style={styles.calloutPaths}>{list}</View> : null}
      {actionsBelow ? (
        <View style={styles.calloutActionFooter}>
          {footer}
          {actionButtons}
        </View>
      ) : null}
      {pendingPrompt ? (
        <View style={styles.calloutPending} testID="arena-pending-battle">
          <Text style={styles.calloutPendingLabel}>Waiting to send</Text>
          <Text style={styles.calloutPendingPrompt} numberOfLines={1} ellipsizeMode="tail">
            {pendingPrompt}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  callout: {
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.statusDanger,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
  },
  warning: {
    borderColor: theme.colors.palette.amber[500],
  },
  calloutTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  calloutHeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  calloutTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  calloutActionFooter: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
    marginLeft: CALLOUT_TITLE_RAIL,
  },
  calloutActions: {
    flexShrink: 0,
    flexWrap: "wrap",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // The label is what it is; letting the row squeeze it is what clipped it before.
  calloutAction: {
    flexShrink: 0,
  },
  calloutPaths: {
    marginTop: theme.spacing[2],
    marginLeft: CALLOUT_TITLE_RAIL,
    gap: theme.spacing[1],
  },
  calloutPending: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    marginLeft: CALLOUT_TITLE_RAIL,
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  calloutPendingLabel: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  calloutPendingPrompt: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  calloutDetail: {
    // Measured from the top row, which the 32px button makes taller than the title — so this is
    // the clearance under the button, and the title gets the row's slack on top of it.
    marginTop: theme.spacing[3],
    marginLeft: CALLOUT_TITLE_RAIL,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
