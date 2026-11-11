import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useContainerWidth } from "@/hooks/use-container-width";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ArenaComparisonDiff,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { IdenticalBattleResult, SummaryOmissionNotice } from "./battle-summary";
import { ArenaChangesList, ArenaNoChangesColumns } from "./changes-list";
import type { ArenaChangesRow } from "./changes-rows";
import { useArenaDiffLayout, type ArenaDiffLayout } from "./diff-layout";
import { DiffLayoutControl } from "./diff-layout-control";
import { comparisonRevision } from "./comparison-visibility";
import { useArenaFileDiff } from "./file-diff-query";
import { InlineFileDiff, openChangesFiles, toggleChangesFile } from "./inline-file-diff";
import { useArenaReviewState, useArenaReviewStore, type ArenaReviewTab } from "./review-state";
import { VerdictBody, VerdictFold } from "./verdict-body";
import { ArenaSegmentedSwitch } from "./segmented-switch";
import { parseSummaryColumns } from "./summary-columns";
import { SummaryColumnsView } from "./summary-columns-view";

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
  const { t } = useTranslation();
  const columns = useMemo(() => (output ? parseSummaryColumns(output) : null), [output]);
  return (
    <View style={styles.section}>
      {pending ? (
        <View style={styles.loading}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.status}>{t("arena.comparing")}</Text>
        </View>
      ) : null}
      {output ? (
        <>
          <SummaryOmissionNotice comparison={comparison} />
          {columns ? (
            <VerdictFold turnId={turnId}>
              <SummaryColumnsView columns={columns} />
            </VerdictFold>
          ) : (
            <VerdictBody turnId={turnId} output={output} />
          )}
        </>
      ) : null}
      {failed ? (
        <View style={styles.loading}>
          <Text style={styles.error}>{t("arena.summaryFailed")}</Text>
          <Button size="xs" variant="ghost" loading={retrying} onPress={onRetry}>
            {t("arena.retrySummary")}{" "}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const sideName = (side: ArenaSide) => i18n.t("arena.agentSide", { side: side.toUpperCase() });

/** The summary tab while one side still works: nothing to compare yet, and it says so. */
function WaitingSummary({ waitingFor }: { waitingFor: ArenaSide }) {
  const { t } = useTranslation();

  return (
    <View style={styles.section} testID="arena-summary-waiting">
      <Text style={styles.status}>
        {sideName(waitingFor)} {t("arena.waitingSummary")}{" "}
      </Text>
    </View>
  );
}

function ChangesTab({
  serverId,
  agentId,
  turnId,
  diff,
  error,
  rows,
  openFiles,
  layout,
  waitingFor,
  onToggleFile,
  onRetry,
  retrying,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  diff: ArenaComparisonDiff | undefined;
  error: Error | null;
  rows: readonly ArenaChangesRow[];
  openFiles: readonly string[];
  layout: ArenaDiffLayout;
  /** The side still working while the other's result is shown. */
  waitingFor: ArenaSide | null;
  onToggleFile: (file: string) => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const revision = diff ? comparisonRevision(diff) : undefined;
  const renderDiff = useCallback(
    (file: string, onColumns: boolean) => (
      <InlineFileDiff
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        file={file}
        layout={layout}
        waitingFor={waitingFor ?? undefined}
        revision={revision}
        embedded
        onColumns={onColumns}
      />
    ),
    [agentId, layout, revision, serverId, turnId, waitingFor],
  );
  if (diff === undefined && !error) {
    return (
      <View style={styles.loading}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.status}>{t("arena.loadingBaseChanges")}</Text>
      </View>
    );
  }
  if (error)
    return (
      <View style={styles.loading} accessibilityRole="alert">
        <Text style={styles.error}>{toErrorMessage(error)}</Text>
        <Button size="xs" variant="ghost" loading={retrying} onPress={onRetry}>
          {t("arena.retryChanges")}{" "}
        </Button>
      </View>
    );
  if (diff?.treesEqual && rows.length === 0) return <ArenaNoChangesColumns />;
  if (rows.length === 0 || !diff) {
    return <Text style={styles.status}>{t("arena.baseUnavailable")}</Text>;
  }
  return (
    <View style={styles.block}>
      {diff.treesEqual && !waitingFor ? <IdenticalBattleResult hasChanges /> : null}
      <ArenaChangesList
        rows={rows}
        openFiles={openFiles}
        waitingFor={waitingFor ?? undefined}
        onToggle={onToggleFile}
        renderDiff={renderDiff}
      />
    </View>
  );
}

/**
 * A small segmented switch on the left rail, one rank below the agents' headings: a pair of
 * underlined tabs over a rule across both answers read as a third heading at the agents' level.
 * Without a summary the switch holds Changes alone, so the review keeps the same head.
 */
function ReviewTabs({
  tabs,
  tab,
  changesLabel,
  onChange,
}: {
  /** Whether the summary has a tab; without one, Changes heads the review alone. */
  tabs: boolean;
  tab: ArenaReviewTab;
  changesLabel: string;
  onChange: (tab: ArenaReviewTab) => void;
}) {
  const { t } = useTranslation();
  const summaryOption = {
    value: "verdict" as const,
    label: t("arena.summary"),
    testID: "arena-review-tab-verdict",
  };
  const changesOption = {
    value: "changes" as const,
    label: changesLabel,
    testID: "arena-review-tab-changes",
  };
  return (
    <ArenaSegmentedSwitch
      options={tabs ? [summaryOption, changesOption] : [changesOption]}
      value={tabs ? tab : "changes"}
      onChange={onChange}
      role="tablist"
      testID="arena-review-tabs"
    />
  );
}

/** The section's heading row: its switch (or label), then the diff layout control. */
function ReviewHeader({
  tabs,
  tab,
  changesLabel,
  onTabChange,
  layoutControl,
  agentId,
  width,
}: {
  /** Whether there is a summary tab to show beside Changes; a stopped battle has only Changes. */
  tabs: boolean;
  tab: ArenaReviewTab;
  changesLabel: string;
  onTabChange: (tab: ArenaReviewTab) => void;
  /** Whether the diff layout control belongs in the row; it has nothing to lay out otherwise. */
  layoutControl: boolean;
  agentId: string;
  width: number | null;
}) {
  return (
    <View style={styles.header} testID="arena-review-header">
      <ReviewTabs tabs={tabs} tab={tab} changesLabel={changesLabel} onChange={onTabChange} />
      <View style={styles.spacer} />
      {layoutControl ? <DiffLayoutControl agentId={agentId} width={width} /> : null}
    </View>
  );
}

/**
 * Whether the review has nothing to show, so it stays out of the chat. While one side still works
 * and the other changed nothing, there is no summary yet and no file to open, so both tabs would only
 * say "nothing yet"; the decision row already says who is still working. Once both are in with no
 * file changed by either, the engine writes no summary (identical results), so a Changes tab over
 * "No changes" under each answer would be all there is. A failed read still shows, with its retry.
 */
function reviewHasNothingToShow(input: {
  waitingFor: ArenaSide | null;
  summaryAvailable: boolean;
  treesEqual: boolean;
  rowCount: number;
  failed: boolean;
}): boolean {
  if (input.failed || input.rowCount > 0) return false;
  if (input.waitingFor !== null) return true;
  return !input.summaryAvailable && input.treesEqual;
}

/**
 * The review region of the card once a result is in. Two tabs share it,
 * as they did in PR #46: the judge's verdict, and the changed files, each
 * opening its diff right under its row. While one side still works, its
 * column of every diff is a placeholder and the summary tab says who is
 * still at it.
 */
export function BattleReview({
  serverId,
  agentId,
  turnId,
  summaryAvailable,
  summaryPending,
  summaryFailed,
  waitingFor,
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
  agentId: string;
  turnId: string;
  summaryAvailable: boolean;
  summaryPending: boolean;
  summaryFailed: boolean;
  /** The side still working while the other's result is reviewed; null once both are in. */
  waitingFor: ArenaSide | null;
  comparison: ArenaSnapshot["comparison"];
  retrying: boolean;
  onRetry: () => void;
  diff: ArenaComparisonDiff | undefined;
  diffError: Error | null;
  rows: readonly ArenaChangesRow[];
  onRetryDiff: () => void;
  retryingDiff: boolean;
}) {
  const { t } = useTranslation();
  // The reader's choices live in the review store so review telemetry can
  // observe them without this component knowing telemetry exists. Absent means
  // no choice yet and the default below stands.
  const chosen = useArenaReviewState(turnId);
  const setStoreTab = useArenaReviewStore((state) => state.setTab);
  const setStoreFiles = useArenaReviewStore((state) => state.setFiles);
  const setShownFile = useArenaReviewStore((state) => state.setShownFile);
  const openStoreFile = useArenaReviewStore((state) => state.openFile);
  const setShownTab = useArenaReviewStore((state) => state.setShownTab);
  // The summary tab exists while one side works, so the voter knows the summary is coming.
  const tabs = summaryAvailable || waitingFor !== null;
  // The summary is the first tab whenever there is one; a reader's pick stands.
  const tab: ArenaReviewTab = chosen.tab ?? (tabs ? "verdict" : "changes");
  // Until the reader picks, the file the card already opened stays open: the default moves to the
  // first diverging file once both results are in, and that must not close the one being read.
  const openFiles = useMemo(
    () =>
      openChangesFiles(rows, chosen.files ?? (chosen.shownFile ? [chosen.shownFile] : undefined)),
    [rows, chosen.files, chosen.shownFile],
  );
  // Changes opens on this file, so its contents are read while the summary is still on screen.
  useArenaFileDiff({
    serverId,
    agentId,
    turnId,
    file: openFiles[0] ?? null,
    revision: diff ? comparisonRevision(diff) : undefined,
  });
  const setTab = useCallback(
    (next: ArenaReviewTab) => setStoreTab(turnId, next),
    [setStoreTab, turnId],
  );
  // A file the reader opens is the one they are reading now, even when they opened it before;
  // closing one records nothing.
  const onToggleFile = useCallback(
    (file: string) => {
      const opening = !openFiles.includes(file);
      setStoreFiles(turnId, toggleChangesFile(openFiles, file));
      if (opening) {
        openStoreFile(
          turnId,
          file,
          rows.findIndex((row) => row.file === file),
        );
      }
    },
    [openFiles, openStoreFile, rows, setStoreFiles, turnId],
  );
  const { onLayout, width } = useContainerWidth();
  const measured = width > 0 ? width : null;
  const layout = useArenaDiffLayout(agentId, measured);
  // What the card actually renders below, which on arrival is its own default
  // rather than anything the reader picked. Telemetry counts these, so a reader
  // who never touches a control is still recorded as having read something.
  const shownTab: ArenaReviewTab = tab === "verdict" && tabs ? "verdict" : "changes";
  const showChanges = shownTab === "changes";
  const showLayoutControl = showChanges;
  const hidden = reviewHasNothingToShow({
    waitingFor,
    summaryAvailable,
    treesEqual: diff?.treesEqual === true,
    rowCount: rows.length,
    failed: Boolean(diffError),
  });
  useEffect(() => {
    if (!hidden) setShownTab(turnId, shownTab);
  }, [hidden, setShownTab, shownTab, turnId]);
  // The default diff counts as read the first time Changes shows it. Files the reader opens
  // afterwards are recorded by the toggle above.
  const arrivalFile = chosen.shownFile === undefined ? openFiles[openFiles.length - 1] : undefined;
  useEffect(() => {
    if (showChanges && arrivalFile) {
      setShownFile(
        turnId,
        arrivalFile,
        rows.findIndex((row) => row.file === arrivalFile),
      );
    }
  }, [arrivalFile, rows, setShownFile, showChanges, turnId]);
  const changesLabel =
    rows.length > 0 ? t("arena.changesCount", { total: rows.length }) : t("arena.changes");
  let content;
  if (shownTab === "verdict" && waitingFor !== null) {
    content = <WaitingSummary waitingFor={waitingFor} />;
  } else if (shownTab === "verdict") {
    content = (
      <Verdict
        turnId={turnId}
        pending={summaryPending}
        output={comparison?.output ?? null}
        comparison={comparison}
        failed={summaryFailed}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  } else {
    content = (
      <ChangesTab
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        diff={diff}
        error={diffError}
        rows={rows}
        openFiles={openFiles}
        layout={layout}
        waitingFor={waitingFor}
        onToggleFile={onToggleFile}
        onRetry={onRetryDiff}
        retrying={retryingDiff}
      />
    );
  }

  if (hidden) return null;
  return (
    <ReviewFrame onLayout={onLayout} turnId={turnId}>
      <ReviewHeader
        tabs={tabs}
        tab={tab}
        changesLabel={changesLabel}
        onTabChange={setTab}
        layoutControl={showLayoutControl && rows.length > 0}
        agentId={agentId}
        width={measured}
      />
      <View style={styles.content}>{content}</View>
    </ReviewFrame>
  );
}

/** The review in the chat under the answers, on their text edge. */
function ReviewFrame({
  onLayout,
  turnId,
  children,
}: {
  onLayout: (event: LayoutChangeEvent) => void;
  turnId: string;
  children: ReactNode;
}) {
  // Review telemetry listens to scrolls on the whole document; this tells it which diffs are
  // this battle's.
  const reviewData = useMemo(() => ({ reviewTurn: turnId }), [turnId]);
  return (
    <View
      style={styles.review}
      onLayout={onLayout}
      testID="arena-battle-comparison"
      dataSet={reviewData}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // In the chat under the answers, on their text edge, with no rule across both of them.
  review: {
    paddingTop: theme.spacing[4] + theme.spacing[1],
    paddingBottom: theme.spacing[3],
  },
  block: {
    gap: theme.spacing[2],
  },
  // The switch, then the diff layout control at the end of the row.
  header: {
    flexDirection: "row",
    alignItems: "center",
    // The layout control drops to a second line when the battle narrows, rather than clipping.
    flexWrap: "wrap",
    columnGap: theme.spacing[6],
    rowGap: theme.spacing[2],
    minHeight: 32,
  },
  content: {
    paddingTop: theme.spacing[4],
  },
  spacer: {
    flex: 1,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.base,
  },
}));
