import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaComparisonFileDiff, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import type { ArenaChangesRow } from "./changes-rows";
import type { ArenaDiffLayout } from "./diff-layout";
import { BaseRelativeFileView } from "./base-relative-view";
import { useArenaFileDiff } from "./file-diff-query";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The row to open first: the first file the two sides disagree on, else the first. */
export function defaultChangesFile(rows: readonly ArenaChangesRow[]): string | null {
  return (rows.find((row) => row.status === "diverging") ?? rows[0])?.file ?? null;
}

/**
 * The files whose diffs are open, in the order the reader opened them. Undefined means the reader
 * has not chosen, so the default opens; empty means they closed every diff and nothing opens until
 * they pick a row. Chosen files the rows no longer hold drop out, and when none are left the
 * default opens again.
 */
export function openChangesFiles(
  rows: readonly ArenaChangesRow[],
  chosen: readonly string[] | undefined,
): readonly string[] {
  if (chosen?.length === 0) return chosen;
  const kept = chosen?.filter((file) => rows.some((row) => row.file === file)) ?? [];
  if (kept.length > 0) return kept;
  const fallback = defaultChangesFile(rows);
  return fallback ? [fallback] : [];
}

/** Opens a closed file's diff after the others, or closes an open one. */
export function toggleChangesFile(open: readonly string[], file: string): readonly string[] {
  return open.includes(file) ? open.filter((other) => other !== file) : [...open, file];
}

interface ShownFileDiff {
  data: ArenaComparisonFileDiff;
  /** The side still working when this file was read; its column is a placeholder. */
  waitingFor: ArenaSide | undefined;
}

/**
 * One file's diff inside the card, A beside B or as one column. A file both
 * changed the same way reads as the change both made, against the base. A file
 * without retained textual content says why it cannot be compared. Embedded, it
 * sits under its row in the Changes list, which draws the edges around it. The
 * list carries no contents, so the diff reads its file when it opens.
 */
export function InlineFileDiff({
  serverId,
  agentId,
  turnId,
  file,
  layout,
  waitingFor,
  revision,
  embedded = false,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  file: string;
  layout: ArenaDiffLayout;
  /** The side still working: its column is a placeholder until its result lands. */
  waitingFor?: ArenaSide;
  /** The commits of the comparison listing this file; see `useArenaFileDiff`. */
  revision?: string;
  embedded?: boolean;
}) {
  const query = useArenaFileDiff({ serverId, agentId, turnId, file, revision });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  // When the other side lands, the file is read again under a new key and arrives a moment later.
  // Until it does, the diff keeps the version it was showing, with the placeholder column it was
  // read with, rather than turning into a spinner.
  const live: ShownFileDiff | null = query.data ? { data: query.data, waitingFor } : null;
  const [held, setHeld] = useState<ShownFileDiff | null>(null);
  if (live && (live.data !== held?.data || live.waitingFor !== held.waitingFor)) setHeld(live);
  const kept = held?.data.turnID === turnId && held.data.file.file === file ? held : null;
  const shown = live ?? (query.error ? null : kept);
  if (shown) {
    return (
      <BaseRelativeFileView
        key={`${turnId}:${file}`}
        file={shown.data.file}
        layout={layout}
        waitingFor={shown.waitingFor}
        embedded={embedded}
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
