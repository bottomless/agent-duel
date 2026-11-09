import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useContainerWidth } from "@/hooks/use-container-width";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import type {
  ArenaComparisonDiff,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { IdenticalBattleResult, SummaryOmissionNotice } from "./battle-summary";
import { ArenaChangesList } from "./changes-list";
import type { ArenaChangesRow } from "./changes-rows";
import { useArenaDiffLayout, type ArenaDiffLayout } from "./diff-layout";
import { DiffLayoutControl } from "./diff-layout-control";
import { comparisonRevision } from "./comparison-visibility";
import { useArenaFileDiff } from "./file-diff-query";
import { InlineFileDiff, openChangesFiles, toggleChangesFile } from "./inline-file-diff";
import { PaneIconAction } from "./pane-icon-action";
import { useArenaReviewState, useArenaReviewStore, type ArenaReviewTab } from "./review-state";
import { VerdictBody } from "./verdict-body";
import { BATTLE_RAIL } from "./battle-layout";
import { parseSummaryColumns } from "./summary-columns";
import { SummaryColumnsView } from "./summary-columns-view";
import { useArenaReviewDockStore } from "./review-dock";

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
            <SummaryColumnsView columns={columns} />
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
const otherSide = (side: ArenaSide): ArenaSide => (side === "a" ? "b" : "a");

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
    (file: string) => (
      <InlineFileDiff
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        file={file}
        layout={layout}
        waitingFor={waitingFor ?? undefined}
        revision={revision}
        embedded
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
  if (waitingFor && diff && rows.length === 0) {
    return (
      <Text style={styles.status} testID="arena-changes-none">
        {sideName(otherSide(waitingFor))} {t("arena.noChangesWhile")} {sideName(waitingFor)}{" "}
        {t("arena.workingStill")}{" "}
      </Text>
    );
  }
  if (diff?.treesEqual && rows.length === 0) return <IdenticalBattleResult />;
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
 * One tab: its label, and under the selected one a 2px rule the width of the label, sitting on
 * the bottom of the tab row. Exported so the folded review can draw the same tabs in the decision
 * row; there nothing is selected, since nothing is showing.
 */
export function ReviewTab({
  value,
  label,
  selected,
  onSelect,
  testID,
}: {
  value: ArenaReviewTab;
  label: string;
  selected: boolean | null;
  onSelect: (tab: ArenaReviewTab) => void;
  testID: string;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const accessibilityState = useMemo(() => ({ selected: selected === true }), [selected]);
  return (
    <PressHighlight
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      aria-selected={selected === true}
      onPress={handlePress}
      style={reviewTabStyle}
      testID={testID}
    >
      <Text
        style={[
          styles.tabText,
          selected === true && styles.tabTextSelected,
          selected === null && styles.tabTextFolded,
        ]}
      >
        {label}
      </Text>
      {selected === true ? <View style={styles.tabIndicator} pointerEvents="none" /> : null}
    </PressHighlight>
  );
}

function reviewTabStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.tab, (hovered || pressed) && styles.tabHovered];
}

/**
 * Two text tabs: the selected one in foreground at medium weight, the other muted, the same
 * reading as a selected sidebar item. A filled segmented control here outweighed the agent
 * headings above it, and the review is the complement, not the headline.
 */
function ReviewTabs({
  tabs,
  tab,
  folded,
  changesLabel,
  onChange,
}: {
  /** Whether the summary has a tab; without one, Changes heads the review alone. */
  tabs: boolean;
  tab: ArenaReviewTab;
  /** Folded, nothing shows, so neither tab reads as selected. */
  folded: boolean;
  changesLabel: string;
  onChange: (tab: ArenaReviewTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.tabs} accessibilityRole="tablist" testID="arena-review-tabs">
      {tabs ? (
        <ReviewTab
          value="verdict"
          label={t("arena.summary")}
          selected={folded ? null : tab === "verdict"}
          onSelect={onChange}
          testID="arena-review-tab-verdict"
        />
      ) : null}
      <ReviewTab
        value="changes"
        label={changesLabel}
        selected={folded ? null : !tabs || tab === "changes"}
        onSelect={onChange}
        testID="arena-review-tab-changes"
      />
    </View>
  );
}

/**
 * The section's heading row: its tabs, the diff layout control, and the fold. Folding hands the
 * screen back to both agents' messages without losing the tab.
 */
function ReviewHeader({
  tabs,
  tab,
  changesLabel,
  onTabChange,
  layoutControl,
  agentId,
  width,
  collapsed,
  onToggleCollapsed,
  inChat,
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
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** In the chat the section opens downward; pinned under it, it rises. */
  inChat: boolean;
}) {
  const { t } = useTranslation();
  const pointsUp = collapsed !== inChat;
  const sectionName = tabs ? t("arena.reviewSections") : t("arena.reviewChanges");
  return (
    <View style={styles.header} testID="arena-review-header">
      <ReviewTabs
        tabs={tabs}
        tab={tab}
        folded={collapsed}
        changesLabel={changesLabel}
        onChange={onTabChange}
      />
      <View style={styles.spacer} />
      {layoutControl ? <DiffLayoutControl agentId={agentId} width={width} /> : null}
      <PaneIconAction
        accessibilityLabel={t(collapsed ? "arena.showReview" : "arena.hideReview", {
          section: sectionName,
        })}
        onPress={onToggleCollapsed}
        testID="arena-review-collapse"
      >
        {pointsUp ? (
          <ThemedChevronUp size={ICON_SIZE.md} uniProps={foregroundColorMapping} />
        ) : (
          <ThemedChevronDown size={ICON_SIZE.md} uniProps={foregroundColorMapping} />
        )}
      </PaneIconAction>
    </View>
  );
}

/** The decision row draws a folded review's tabs; this tells it what they are. */
function usePublishDockTabs(turnId: string, summary: boolean, changesLabel: string) {
  const setDockTabs = useArenaReviewDockStore((state) => state.setTabs);
  useEffect(() => {
    setDockTabs(turnId, { summary, changesLabel });
  }, [changesLabel, setDockTabs, summary, turnId]);
}

/** A folded review whose tabs the decision row draws takes no room in the battle. */
function foldedAway(collapsed: boolean, foldsIntoDock: boolean): boolean {
  return collapsed && foldsIntoDock;
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
  foldsIntoDock,
  maxContentHeight,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  /**
   * Whether the decision row below the transcript draws this review's tabs while it is folded.
   * Then a folded review takes no room in the card; otherwise it keeps its tab row in place.
   */
  foldsIntoDock?: boolean;
  /**
   * Pinned under the chat, the tab row stays put and what is under it scrolls past this height,
   * so the answers above keep their room. Without it the review sits in the chat on the answers'
   * text edge, under a plain hairline: the fade only reads where the chat scrolls behind it.
   */
  maxContentHeight?: number;
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
  const setStoreCollapsed = useArenaReviewStore((state) => state.setCollapsed);
  const collapsed = chosen.collapsed === true;
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
  // Picking a tab on a folded section opens it on that tab.
  const setTab = useCallback(
    (next: ArenaReviewTab) => {
      setStoreTab(turnId, next);
      if (collapsed) setStoreCollapsed(turnId, false);
    },
    [collapsed, setStoreCollapsed, setStoreTab, turnId],
  );
  const toggleCollapsed = useCallback(
    () => setStoreCollapsed(turnId, !collapsed),
    [collapsed, setStoreCollapsed, turnId],
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
  // A folded section shows nothing, so telemetry records nothing as read while it is folded.
  const showChanges = shownTab === "changes" && !collapsed;
  const showLayoutControl = showChanges;
  useEffect(() => {
    if (!collapsed) setShownTab(turnId, shownTab);
  }, [collapsed, setShownTab, shownTab, turnId]);
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
  usePublishDockTabs(turnId, tabs, changesLabel);
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

  if (foldedAway(collapsed, foldsIntoDock === true)) return null;
  return (
    <ReviewFrame pinned={maxContentHeight !== undefined} onLayout={onLayout} turnId={turnId}>
      <ReviewHeader
        tabs={tabs}
        tab={tab}
        changesLabel={changesLabel}
        onTabChange={setTab}
        layoutControl={showLayoutControl && rows.length > 0}
        agentId={agentId}
        width={measured}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        inChat={maxContentHeight === undefined}
      />
      {collapsed ? null : <ReviewContent maxHeight={maxContentHeight}>{content}</ReviewContent>}
    </ReviewFrame>
  );
}

/**
 * The review's own edge: pinned under the chat, a hairline with a fade over what scrolls behind;
 * in the chat, a plain hairline on the answers' text edge.
 */
function ReviewFrame({
  pinned,
  onLayout,
  turnId,
  children,
}: {
  pinned: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  turnId: string;
  children: ReactNode;
}) {
  // Review telemetry listens to scrolls on the whole document; this tells it which diffs are
  // this battle's.
  const reviewData = useMemo(() => ({ reviewTurn: turnId }), [turnId]);
  return (
    <View
      style={[styles.review, !pinned && styles.reviewInChat]}
      onLayout={onLayout}
      testID="arena-battle-comparison"
      dataSet={reviewData}
    >
      {pinned ? <View style={styles.edgeFade} pointerEvents="none" /> : null}
      {children}
    </View>
  );
}

function ReviewContent({ maxHeight, children }: { maxHeight?: number; children: ReactNode }) {
  const scrollStyle = useMemo(() => ({ maxHeight }), [maxHeight]);
  if (maxHeight === undefined) return <View style={styles.content}>{children}</View>;
  return (
    <ScrollView style={scrollStyle} contentContainerStyle={styles.content}>
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A section that rises from the bottom of the battle: a hairline and a soft fade above it,
  // the answers' rails inside it.
  review: {
    position: "relative",
    paddingHorizontal: BATTLE_RAIL,
    paddingBottom: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
  },
  reviewInChat: {
    paddingHorizontal: 0,
    borderTopColor: theme.colors.border,
  },
  edgeFade: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -25,
    height: 24,
    _web: {
      backgroundImage: `linear-gradient(to top, ${theme.shadow.md.shadowColor}, transparent)`,
    },
  },
  block: {
    gap: theme.spacing[2],
  },
  // The tab row heads the section: its tabs, the diff layout control, and the fold.
  header: {
    flexDirection: "row",
    alignItems: "center",
    // The layout control drops to a second line when the battle narrows, rather than clipping.
    flexWrap: "wrap",
    columnGap: theme.spacing[6],
    minHeight: 52,
  },
  content: {
    paddingTop: theme.spacing[2] + theme.spacing[0.5],
  },
  tabs: {
    flexDirection: "row",
    alignItems: "stretch",
    columnGap: theme.spacing[6],
    alignSelf: "stretch",
  },
  tab: {
    justifyContent: "center",
    minHeight: 44,
    borderRadius: theme.borderRadius.base,
  },
  tabHovered: {
    opacity: 0.8,
  },
  tabText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
  },
  tabTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  // Folded, both tabs are ways to open the review; neither reads as selected.
  tabTextFolded: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: theme.colors.foreground,
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
