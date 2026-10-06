import { useCallback, useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaComparisonDiff, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { IdenticalBattleResult, SummaryOmissionNotice } from "./battle-summary";
import { ArenaChangesList } from "./changes-list";
import type { ArenaChangesRow } from "./changes-rows";
import { useArenaDiffLayout, type ArenaDiffLayout } from "./diff-layout";
import { DiffLayoutControl } from "./diff-layout-control";
import { defaultChangesFile, InlineFileDiff } from "./inline-file-diff";
import { useArenaReviewState, useArenaReviewStore, type ArenaReviewTab } from "./review-state";
import { VerdictBody } from "./verdict-body";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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

function ChangesTab({
  diff,
  error,
  rows,
  selectedFile,
  layout,
  onSelectFile,
  onRetry,
  retrying,
}: {
  diff: ArenaComparisonDiff | undefined;
  error: Error | null;
  rows: readonly ArenaChangesRow[];
  selectedFile: string | null;
  layout: ArenaDiffLayout;
  onSelectFile: (file: string) => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (diff === undefined && !error) {
    return (
      <View style={styles.loading}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.status}>Loading changes from base…</Text>
      </View>
    );
  }
  if (error)
    return (
      <View style={styles.loading} accessibilityRole="alert">
        <Text style={styles.error}>{toErrorMessage(error)}</Text>
        <Button size="xs" variant="ghost" loading={retrying} onPress={onRetry}>
          Retry changes
        </Button>
      </View>
    );
  if (diff?.treesEqual && rows.length === 0) return <IdenticalBattleResult />;
  if (rows.length === 0 || !diff) {
    return <Text style={styles.status}>Changes from base are unavailable</Text>;
  }
  return (
    <View style={styles.block}>
      {diff.treesEqual ? <IdenticalBattleResult hasChanges /> : null}
      <ArenaChangesList
        rows={rows}
        onSelect={onSelectFile}
        selectedFile={selectedFile ?? undefined}
      />
      {selectedFile ? <InlineFileDiff diff={diff} file={selectedFile} layout={layout} /> : null}
    </View>
  );
}

function ReviewTab({
  value,
  label,
  selected,
  onSelect,
  testID,
}: {
  value: ArenaReviewTab;
  label: string;
  selected: boolean;
  onSelect: (tab: ArenaReviewTab) => void;
  testID: string;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.tab}>
      <Button
        variant="ghost"
        size="sm"
        accessibilityRole="tab"
        accessibilityState={accessibilityState}
        aria-selected={selected}
        textStyle={selected ? styles.tabTextSelected : undefined}
        onPress={handlePress}
        testID={testID}
      >
        {label}
      </Button>
      <View
        style={[styles.tabIndicator, selected && styles.tabIndicatorSelected]}
        pointerEvents="none"
      />
    </View>
  );
}

/**
 * Two text tabs: the selected one in foreground at medium weight, the other muted, the same
 * reading as a selected sidebar item. A filled segmented control here outweighed the agent
 * headings above it, and the review is the complement, not the headline.
 */
function ReviewTabs({
  tab,
  changesLabel,
  onChange,
}: {
  tab: ArenaReviewTab;
  changesLabel: string;
  onChange: (tab: ArenaReviewTab) => void;
}) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist" testID="arena-review-tabs">
      <ReviewTab
        value="verdict"
        label="Difference summary"
        selected={tab === "verdict"}
        onSelect={onChange}
        testID="arena-review-tab-verdict"
      />
      <ReviewTab
        value="changes"
        label={changesLabel}
        selected={tab === "changes"}
        onSelect={onChange}
        testID="arena-review-tab-changes"
      />
    </View>
  );
}

/**
 * The review region of the card once both results are in. Two tabs share it,
 * as they did in PR #46: the judge's verdict, and the changed files with the
 * selected one's diff right here, beside or below.
 */
export function BattleReview({
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
  // observe them without this component knowing telemetry exists. Absent means
  // no choice yet and the default below stands.
  const chosen = useArenaReviewState(turnId);
  const setStoreTab = useArenaReviewStore((state) => state.setTab);
  const setStoreFile = useArenaReviewStore((state) => state.setFile);
  const setShownFile = useArenaReviewStore((state) => state.setShownFile);
  const setShownTab = useArenaReviewStore((state) => state.setShownTab);
  // Keep the view that was on screen when this turn's review mounted. A verdict that is already
  // available still opens first, but one that finishes later must not replace Changes mid-read.
  const initialTabRef = useRef({
    turnId,
    tab: summaryAvailable ? ("verdict" as const) : ("changes" as const),
  });
  if (initialTabRef.current.turnId !== turnId) {
    initialTabRef.current = {
      turnId,
      tab: summaryAvailable ? "verdict" : "changes",
    };
  }
  const tab: ArenaReviewTab = chosen.tab ?? initialTabRef.current.tab;
  const selectedFile = rows.some((row) => row.file === chosen.file)
    ? (chosen.file ?? null)
    : defaultChangesFile(rows);
  const setTab = useCallback(
    (next: ArenaReviewTab) => setStoreTab(turnId, next),
    [setStoreTab, turnId],
  );
  const onSelectFile = useCallback(
    (file: string) => setStoreFile(turnId, file),
    [setStoreFile, turnId],
  );
  const { onLayout, width } = useContainerWidth();
  const measured = width > 0 ? width : null;
  const layout = useArenaDiffLayout(agentId, measured);
  // What the card actually renders below, which on arrival is its own default
  // rather than anything the reader picked. Telemetry counts these, so a reader
  // who never touches a control is still recorded as having read something.
  const shownTab: ArenaReviewTab = tab === "verdict" && summaryAvailable ? "verdict" : "changes";
  const showLayoutControl = shownTab === "changes";
  useEffect(() => {
    setShownTab(turnId, shownTab);
  }, [setShownTab, shownTab, turnId]);
  useEffect(() => {
    if (showLayoutControl && selectedFile) {
      setShownFile(
        turnId,
        selectedFile,
        rows.findIndex((row) => row.file === selectedFile),
      );
    }
  }, [rows, selectedFile, setShownFile, showLayoutControl, turnId]);
  const changesLabel = rows.length > 0 ? `Changes (${rows.length})` : "Changes";

  return (
    <View style={styles.review} onLayout={onLayout} testID="arena-battle-comparison">
      <View style={styles.header} testID="arena-review-header">
        {summaryAvailable ? (
          <ReviewTabs tab={tab} changesLabel={changesLabel} onChange={setTab} />
        ) : (
          <Text style={styles.title}>{changesLabel}</Text>
        )}
        <View style={styles.spacer} />
        {showLayoutControl && rows.length > 0 ? (
          <DiffLayoutControl agentId={agentId} width={measured} />
        ) : null}
      </View>
      <View style={styles.content}>
        {tab === "verdict" && summaryAvailable ? (
          <Verdict
            turnId={turnId}
            pending={summaryPending}
            output={comparison?.output ?? null}
            comparison={comparison}
            failed={summaryFailed}
            retrying={retrying}
            onRetry={onRetry}
          />
        ) : (
          <ChangesTab
            diff={diff}
            error={diffError}
            rows={rows}
            selectedFile={selectedFile}
            layout={layout}
            onSelectFile={onSelectFile}
            onRetry={onRetryDiff}
            retrying={retryingDiff}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  review: {},
  block: {
    gap: theme.spacing[2],
  },
  // A tab strip across the whole section, with a baseline the selected tab's underline sits
  // on, so the tabs read as the heading of what follows rather than a control floating in it.
  header: {
    flexDirection: "row",
    alignItems: "center",
    // The layout control and the panel button drop to a second line when the
    // card narrows, rather than clipping.
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
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // The ghost button's padding is the hit area; pulling the row back by it puts the first
  // label's glyphs on the section's rail.
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: -theme.spacing[3],
  },
  tab: {
    alignItems: "stretch",
  },
  tabTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  // The underline spans the whole tab, padding included, so the first tab's line meets the
  // card's edge; it hangs below the button by the strip's bottom padding plus one pixel to sit
  // on the strip's baseline.
  tabIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -(theme.spacing[2] + 1),
    height: 2,
    backgroundColor: "transparent",
  },
  tabIndicatorSelected: {
    backgroundColor: theme.colors.foreground,
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
