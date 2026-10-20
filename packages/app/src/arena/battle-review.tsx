import { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, PanelRight } from "lucide-react-native";
import type { ArenaComparisonDiff, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { openBattleChanges } from "./battle-changes-store";
import { IdenticalBattleResult, SummaryOmissionNotice } from "./battle-summary";
import type { ArenaChangesRow } from "./changes-rows";
import { useArenaFileDiff } from "./file-diff-query";
import { PaneIconAction } from "./pane-icon-action";
import { useArenaReviewState, useArenaReviewStore } from "./review-state";
import { VerdictBody } from "./verdict-body";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function Verdict({
  turnId,
  pending,
  output,
  comparison,
  failed,
  retrying,
  onRetry,
}: {
  turnId: string;
  pending: boolean;
  output: string | null;
  comparison: ArenaSnapshot["comparison"];
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.section}>
      {pending ? (
        <View style={styles.loading}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.status}>Comparing results…</Text>
        </View>
      ) : null}
      {output ? (
        <>
          <SummaryOmissionNotice comparison={comparison} />
          <VerdictBody turnId={turnId} output={output} />
        </>
      ) : null}
      {failed ? (
        <View style={styles.loading}>
          <Text style={styles.error}>The difference summary failed to generate.</Text>
          <Button size="xs" variant="ghost" loading={retrying} onPress={onRetry}>
            Retry summary
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/**
 * What the card says about the files under the summary: only what the panel cannot, that both
 * agents left the same files, or that the file list failed to load.
 */
function ChangesNote({
  error,
  rows,
  onRetry,
  retrying,
}: {
  error: Error | null;
  rows: readonly ArenaChangesRow[];
  onRetry: () => void;
  retrying: boolean;
}) {
  if (error)
    return (
      <View style={styles.loading} accessibilityRole="alert">
        <Text style={styles.error}>{toErrorMessage(error)}</Text>
        <Button size="xs" variant="ghost" loading={retrying} onPress={onRetry}>
          Retry changes
        </Button>
      </View>
    );
  return <IdenticalBattleResult hasChanges={rows.length > 0} />;
}

/**
 * The section's heading row: what it holds, the way to the files in the side panel, and the fold
 * that hands the screen back to both agents' messages.
 */
function ReviewHeader({
  summaryAvailable,
  fileCount,
  loadingFiles,
  collapsed,
  onOpenPanel,
  onToggleCollapsed,
}: {
  summaryAvailable: boolean;
  fileCount: number;
  loadingFiles: boolean;
  collapsed: boolean;
  onOpenPanel: () => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <View style={styles.header} testID="arena-review-header">
      <Text style={styles.title}>{summaryAvailable ? "Difference summary" : "Changes"}</Text>
      <View style={styles.spacer} />
      {loadingFiles || fileCount > 0 ? (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={PanelRight}
          loading={loadingFiles}
          onPress={onOpenPanel}
          accessibilityLabel="Show the changes in the side panel"
          testID="arena-review-open-panel"
        >
          {fileCount > 0 ? `Changes (${fileCount})` : "Changes"}
        </Button>
      ) : null}
      {summaryAvailable ? (
        <PaneIconAction
          accessibilityLabel={`${collapsed ? "Show" : "Hide"} the difference summary`}
          onPress={onToggleCollapsed}
          testID="arena-review-collapse"
        >
          {collapsed ? (
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          ) : (
            <ThemedChevronUp size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          )}
        </PaneIconAction>
      ) : null}
    </View>
  );
}

/**
 * The review region of the card once both results are in: the judge's difference summary, and
 * the way to the files. The diffs are read in the Battle changes side panel, beside the chat, so
 * the card names the count and opens the panel rather than listing the files a second time.
 */
export function BattleReview({
  serverId,
  workspaceId,
  agentId,
  turnId,
  summaryAvailable,
  summaryPending,
  summaryFailed,
  comparison,
  retrying,
  onRetry,
  diff,
  diffError,
  rows,
  onRetryDiff,
  retryingDiff,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  turnId: string;
  summaryAvailable: boolean;
  summaryPending: boolean;
  summaryFailed: boolean;
  comparison: ArenaSnapshot["comparison"];
  retrying: boolean;
  onRetry: () => void;
  diff: ArenaComparisonDiff | undefined;
  diffError: Error | null;
  rows: readonly ArenaChangesRow[];
  onRetryDiff: () => void;
  retryingDiff: boolean;
}) {
  // The reader's choices live in the review store so review telemetry can
  // observe them without this component knowing telemetry exists.
  const chosen = useArenaReviewState(turnId);
  const setShownTab = useArenaReviewStore((state) => state.setShownTab);
  const setStoreCollapsed = useArenaReviewStore((state) => state.setCollapsed);
  const collapsed = chosen.collapsed === true;
  // The file the panel shows first, read while the summary is still on screen.
  useArenaFileDiff({ serverId, agentId, turnId, file: rows[0]?.file ?? null });
  const toggleCollapsed = useCallback(
    () => setStoreCollapsed(turnId, !collapsed),
    [collapsed, setStoreCollapsed, turnId],
  );
  const openPanel = useCallback(
    () => openBattleChanges({ serverId, workspaceId, agentId, turnId }),
    [agentId, serverId, turnId, workspaceId],
  );
  // Telemetry counts the summary as read while it is on screen, unfolded.
  const summaryShown = summaryAvailable && !collapsed;
  useEffect(() => {
    if (summaryShown) setShownTab(turnId, "verdict");
  }, [setShownTab, summaryShown, turnId]);
  // Review telemetry listens to scrolls on the whole document; this tells it which diffs are
  // this battle's.
  const reviewData = useMemo(() => ({ reviewTurn: turnId }), [turnId]);
  const loadingFiles = diff === undefined && !diffError;
  // Folding hides the whole region, the note under the summary included.
  const showNote = Boolean(diffError || diff?.treesEqual) && !(summaryAvailable && collapsed);

  return (
    <View style={styles.review} testID="arena-battle-comparison" dataSet={reviewData}>
      <ReviewHeader
        summaryAvailable={summaryAvailable}
        fileCount={rows.length}
        loadingFiles={loadingFiles}
        collapsed={collapsed}
        onOpenPanel={openPanel}
        onToggleCollapsed={toggleCollapsed}
      />
      {summaryShown || showNote ? (
        <View style={styles.content}>
          {summaryShown ? (
            <Verdict
              turnId={turnId}
              pending={summaryPending}
              output={comparison?.output ?? null}
              comparison={comparison}
              failed={summaryFailed}
              retrying={retrying}
              onRetry={onRetry}
            />
          ) : null}
          {showNote ? (
            <ChangesNote
              error={diffError}
              rows={rows}
              onRetry={onRetryDiff}
              retrying={retryingDiff}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  review: {},
  header: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    // Tall enough for the ghost button, so a header without one sits at the
    // same height as one with it.
    minHeight: 32,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  content: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  spacer: {
    flex: 1,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loading: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
