import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import type { ArenaDiffLayout } from "./diff-layout";
import { BaseRelativeFileView } from "./base-relative-view";
import { useArenaFileDiff } from "./file-diff-query";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * One file's diff, A beside B or as one column. A file both changed the same way
 * reads as the change both made, against the base. A file without retained
 * textual content says why it cannot be compared. Embedded, it sits under its
 * heading in the Battle changes panel, which draws the edges around it. The
 * battle's file list carries no contents, so the diff reads its file when it
 * mounts.
 */
export function InlineFileDiff({
  serverId,
  agentId,
  turnId,
  file,
  layout,
  embedded = false,
  flowTop,
  onlySide,
  wrap,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  file: string;
  layout: ArenaDiffLayout;
  embedded?: boolean;
  /** See `BaseRelativeFileView`: full height in the panel's scroller. */
  flowTop?: number;
  /** See `BaseRelativeFileView`: one agent's changes only. */
  onlySide?: "a" | "b";
  /** See `BaseRelativeFileView`: long lines wrap. */
  wrap?: boolean;
}) {
  const query = useArenaFileDiff({ serverId, agentId, turnId, file });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (query.data) {
    return (
      <BaseRelativeFileView
        key={`${turnId}:${file}`}
        file={query.data.file}
        layout={layout}
        embedded={embedded}
        flowTop={flowTop}
        onlySide={onlySide}
        wrap={wrap}
      />
    );
  }
  if (query.error) {
    return (
      <View style={styles.status} accessibilityRole="alert" testID="arena-inline-diff-error">
        <Text style={styles.error}>{toErrorMessage(query.error)}</Text>
        <Button size="xs" variant="ghost" loading={query.isFetching} onPress={retry}>
          Retry diff
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.status} testID="arena-inline-diff-loading">
      <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
      <Text style={styles.caption}>Loading diff…</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
