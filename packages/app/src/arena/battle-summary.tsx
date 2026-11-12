import { i18n } from "@/i18n/i18next";
import { useTranslation } from "react-i18next";
import { arenaSubscription } from "./stream-subscription";
import { arenaSizeErrorOr } from "./chat-too-large";
import { ArenaStreamStatus } from "./stream-status";
import { useArenaStream } from "./use-arena-stream";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, GitBranch, GitCompareArrows, Info } from "lucide-react-native";
import type {
  ArenaComparisonDiff,
  ArenaHistoryItem,
  ArenaRun,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { WorkspaceOpenInEditorButton } from "@/workspace/open-in-editor/button";
import { resolveContentMaxWidth, useAppSettings } from "@/hooks/use-settings";
import { toErrorMessage } from "@/utils/error-messages";
import { useFetchQuery } from "@/data/query";
import { ARENA_MAX_CONTENT_WIDTH, ARENA_PANE_BASIS_WIDTH } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  battleFailedToStart,
  battleKeptSide,
  battleWinnerSide,
  gitApplicationNotice,
  isStoppedByEarlyPick,
  settledHistoryRun,
} from "./battle-result";
import { ArenaPathList } from "./path-list";
import { useContainerWidth } from "@/hooks/use-container-width";
import { useArenaDiffLayout } from "./diff-layout";
import { noticeAccountSessionRejection } from "@/accounts/session-rejected";
import { DiffLayoutControl } from "./diff-layout-control";
import { InlineFileDiff, openChangesFiles, toggleChangesFile } from "./inline-file-diff";
import { VerdictBody } from "./verdict-body";
import { ArenaChangesList } from "./changes-list";
import { ArenaPastDecision, type ArenaPastChoice } from "./decision-bar";
import { arenaChangesCountLabel, arenaChangesRows } from "./changes-rows";
import { arenaDiffQueryKey, hasBattleDiff } from "./comparison-visibility";
import { arenaModelDisplayName } from "./side-label";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import { describeSummaryOmissions } from "./summary-omissions";
import { ArenaRunThread } from "./run-thread";
import { arenaSessionQueryKey, useArenaStartMutation } from "./use-arena-session";
import { ArenaTransitionRow } from "./transition-row";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useArenaCardBleed } from "./content-column";
import { formatDuration } from "@/utils/time";
import { BattleReview } from "./battle-review";
import { BATTLE_GUTTER, BATTLE_RAIL } from "./battle-layout";
import { useArenaShownBattle, useArenaShownBattleStore } from "./shown-battle";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedGitCompareArrows = withUnistyles(GitCompareArrows);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedInfo = withUnistyles(Info);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// The info accent shared with <Alert variant="info"> and info toasts.
const infoColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[300] });

function chosenLabel(item: ArenaHistoryItem): string {
  if (item.gitApplication?.state === "discarded") return i18n.t("arena.winningDiscarded");
  if (item.vote === "tie") {
    const applied = item.appliedSide?.toUpperCase() ?? "A";
    const model = item.appliedSide
      ? arenaModelDisplayName(item.identities?.[item.appliedSide].name)
      : "";
    if (item.gitApplication?.state === "applied") {
      return i18n.t(model ? "arena.tieAppliedModel" : "arena.tieApplied", { side: applied, model });
    }
    return i18n.t("arena.tieChosen", {
      defaultValue: model ? "Tie — {{side}} chosen ({{model}})" : "Tie — {{side}} chosen",
      side: applied,
      model,
    });
  }
  const side = item.appliedSide;
  if (!side) {
    if (item.resolution?.kind === "stopped") return i18n.t("arena.battleDiscarded");
    return i18n.t("arena.battleResolved");
  }
  return i18n.t(
    item.acceptedFailedSide === side ? "arena.acceptedFailedModel" : "arena.choseModel",
    {
      model: arenaModelDisplayName(item.identities?.[side].name),
      side: side.toUpperCase(),
    },
  );
}

/**
 * The files an archived battle touched, each opening its diff under its row.
 */
function ArchivedChanges({
  serverId,
  agentId,
  turnId,
  diff,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  diff: ArenaComparisonDiff;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => arenaChangesRows(diff), [diff]);
  const { onLayout, width } = useContainerWidth();
  const measured = width > 0 ? width : null;
  const layout = useArenaDiffLayout(agentId, measured);
  // Undefined until the reader picks a row; empty once they close every diff.
  const [chosenFiles, setChosenFiles] = useState<readonly string[] | undefined>(undefined);
  const openFiles = useMemo(() => openChangesFiles(rows, chosenFiles), [rows, chosenFiles]);
  const toggleFile = useCallback(
    (file: string) => setChosenFiles(toggleChangesFile(openFiles, file)),
    [openFiles],
  );
  const renderDiff = useCallback(
    (file: string, onColumns: boolean) => (
      <InlineFileDiff
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        file={file}
        layout={layout}
        embedded
        onColumns={onColumns}
      />
    ),
    [agentId, layout, serverId, turnId],
  );
  return (
    <View style={styles.section} onLayout={onLayout}>
      <View style={styles.sectionHeader}>
        <ThemedGitCompareArrows size={16} uniProps={mutedColorMapping} />
        <Text style={styles.sectionTitle}>{t("arena.baseChanges")}</Text>
        <Text style={styles.muted}>{arenaChangesCountLabel(rows.length)}</Text>
        <View style={styles.sectionSpacer} />
        <DiffLayoutControl agentId={agentId} width={measured} />
      </View>
      <ArenaChangesList
        rows={rows}
        openFiles={openFiles}
        onToggle={toggleFile}
        renderDiff={renderDiff}
      />
    </View>
  );
}

// Keep evidence coverage visible above the verdict, including when its prose folds.
export function SummaryOmissionNotice({ comparison }: { comparison: ArenaSnapshot["comparison"] }) {
  useTranslation();
  const described = describeSummaryOmissions(comparison?.omittedArtifacts, comparison?.truncated);
  if (!described) return null;
  return (
    <View style={styles.omissionNotice} testID="arena-summary-omission-notice">
      <ThemedInfo size={14} uniProps={infoColorMapping} />
      <Text style={styles.omissionNoticeText}>{described}</Text>
    </View>
  );
}

export function IdenticalBattleResult({ hasChanges = false }: { hasChanges?: boolean }) {
  const { t } = useTranslation();
  if (hasChanges) {
    return (
      <Text style={styles.muted} testID="arena-identical-results">
        {t("arena.sameChanges")}{" "}
      </Text>
    );
  }
  // One quiet line, as the summary's shared sentence reads: there is nothing to compare.
  return (
    <Text style={styles.muted} testID="arena-identical-results">
      <Text style={styles.identicalTitle}>{t("arena.identicalFiles")}</Text>
      {` · ${t("arena.neitherChanged")}`}
    </Text>
  );
}

function runsAreFinal(runA: ArenaRun | undefined, runB: ArenaRun | undefined): boolean {
  return Boolean(runA && runB && runA.runState !== "pending" && runB.runState !== "pending");
}

/** One side's model, as revealed by the vote: its vendor's mark and its name. */
function winnerNote(counted: boolean, acceptedFailed: boolean): string {
  if (acceptedFailed) return i18n.t("arena.acceptedFailedNote");
  if (counted) return i18n.t("arena.winnerNote");
  return i18n.t("arena.chosenNote", { defaultValue: "(chosen)" });
}

function RevealedIdentity({
  side,
  model,
  winner,
  counted,
  acceptedFailed,
}: {
  side: "a" | "b";
  model: string | undefined;
  winner: boolean;
  /** False when a side failed: the chosen side applied, but nobody won the vote. */
  counted: boolean;
  /** This side had failed and the voter took its work anyway. */
  acceptedFailed: boolean;
}) {
  useTranslation();
  return (
    <View style={styles.identity}>
      <Text style={styles.identities}>{side.toUpperCase()}:</Text>
      <ArenaModelVendorIcon model={model} size={ICON_SIZE.xs} tone="muted" />
      <Text style={styles.identities}>{arenaModelDisplayName(model)}</Text>
      {winner ? <Text style={styles.identities}>{winnerNote(counted, acceptedFailed)}</Text> : null}
    </View>
  );
}

function BattleOutcome({ item }: { item: ArenaHistoryItem }) {
  const { t } = useTranslation();
  // A failed side kept after Stop has no vote, but it is named the way an accepted one is.
  const winner = battleWinnerSide(item) ?? item.acceptedFailedSide;
  const showOutcome = !winner || item.gitApplication?.state === "discarded";
  const gitNotice = gitApplicationNotice(item);
  return (
    <>
      <View style={styles.headerText}>
        {item.identities ? (
          <View style={styles.identityRow}>
            <RevealedIdentity
              side="a"
              model={item.identities.a.name}
              winner={winner === "a"}
              counted={!item.voteDiscardedReason}
              acceptedFailed={item.acceptedFailedSide === "a"}
            />
            <Text style={styles.identities}>·</Text>
            <RevealedIdentity
              side="b"
              model={item.identities.b.name}
              winner={winner === "b"}
              counted={!item.voteDiscardedReason}
              acceptedFailed={item.acceptedFailedSide === "b"}
            />
            {showOutcome ? <Text style={styles.identities}>· {chosenLabel(item)}</Text> : null}
          </View>
        ) : (
          // Discarded before either side showed anything, so the battle names nobody.
          <Text style={styles.identities}>{chosenLabel(item)}</Text>
        )}
      </View>
      {gitNotice && gitNotice.tone !== "info" ? (
        <Text style={styles.conflictBadge}>{gitNotice.title}</Text>
      ) : null}
      {item.selectedEarly ? (
        <Text style={styles.mutedBadge}>{t("arena.earlyDecision")}</Text>
      ) : null}
      {item.voteDiscardedReason ? (
        <Text style={styles.mutedBadge}>{t("arena.voteNotCounted")}</Text>
      ) : null}
    </>
  );
}

export function ArenaBattleOutcome({ item }: { item: ArenaHistoryItem }) {
  if (!item.resolution) return null;
  return (
    <View style={styles.cardHeader} testID={`arena-outcome-${item.id}`}>
      <BattleOutcome item={item} />
    </View>
  );
}

function BattleSummaryHeader({
  expanded,
  item,
  onToggle,
}: {
  expanded: boolean;
  item: ArenaHistoryItem;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <PressHighlight
      onPress={onToggle}
      style={styles.cardHeader}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={t(expanded ? "arena.collapseSummary" : "arena.expandSummary", {
        outcome: chosenLabel(item),
        reason: item.voteDiscardedReason ? t("arena.voteFailedReason") : "",
      })}
    >
      {expanded ? (
        <ThemedChevronDown size={17} uniProps={mutedColorMapping} />
      ) : (
        <ThemedChevronRight size={17} uniProps={mutedColorMapping} />
      )}
      <BattleOutcome item={item} />
    </PressHighlight>
  );
}

/**
 * The end of a kept answer's footer, at the battle's right edge: the model that wrote it, the time
 * it took, and the way back into the battle. The answer is the chat's history now, so only this
 * line says which of the two it was.
 */
export function ArenaKeptByline({ agentId, item }: { agentId: string; item: ArenaHistoryItem }) {
  const { t } = useTranslation();
  const show = useArenaShownBattleStore((state) => state.show);
  const handleShow = useCallback(() => show(agentId, item.id), [agentId, item.id, show]);
  const model = keptModel(item);
  if (!model) return null;
  const opponent = opponentModel(item);
  return (
    <View style={styles.byline} testID={`arena-winner-${item.id}`}>
      <Text style={styles.bylineName} numberOfLines={1}>
        {arenaModelDisplayName(model)}
      </Text>
      {opponent ? (
        <Text style={styles.bylineMeta} numberOfLines={1} testID={`arena-opponent-${item.id}`}>
          {t(item.vote === "tie" ? "arena.keptTied" : "arena.keptOver", {
            model: arenaModelDisplayName(opponent),
          })}
        </Text>
      ) : null}
      <BylineNotes item={item} />
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={t("arena.showBattle")}
        onPress={handleShow}
        style={showBattleStyle}
        testID={`arena-show-battle-${item.id}`}
      >
        {({ hovered, pressed }) => (
          <>
            {/* Text, not an icon, so the chevron takes the theme with its label. */}
            <Text style={[styles.showBattleText, (hovered || pressed) && styles.showBattleActive]}>
              {t("arena.showBattle")}
            </Text>
            <Text
              style={[styles.showBattleChevron, (hovered || pressed) && styles.showBattleActive]}
            >
              ›
            </Text>
          </>
        )}
      </PressHighlight>
    </View>
  );
}

/** The time, then anything that sets this result apart, each after a dot. */
function BylineNotes({ item }: { item: ArenaHistoryItem }) {
  const { t } = useTranslation();
  const gitNotice = gitApplicationNotice(item);
  const notes = [
    item.appliedDurationMs !== undefined ? formatDuration(item.appliedDurationMs) : null,
    item.selectedEarly ? t("arena.earlyDecision") : null,
    item.voteDiscardedReason ? t("arena.voteNotCounted") : null,
  ].filter((note): note is string => note !== null);
  return (
    <>
      {notes.map((note) => (
        <Text key={note} style={styles.bylineMeta}>
          · {note}
        </Text>
      ))}
      {gitNotice && gitNotice.tone !== "info" ? (
        <Text style={styles.conflictBadge}>{gitNotice.title}</Text>
      ) : null}
      <Text style={styles.bylineMeta}>·</Text>
    </>
  );
}

/** The model a decided battle kept, when one was kept and named. */
function keptModel(item: ArenaHistoryItem): string | undefined {
  const kept = battleKeptSide(item);
  return kept ? item.identities?.[kept].name : undefined;
}

/**
 * The model the kept one was chosen over. The kept answer becomes the chat's history, so without it
 * the reveal named only the winner and the other contestant left no trace in the chat.
 */
function opponentModel(item: ArenaHistoryItem): string | undefined {
  const kept = battleKeptSide(item);
  if (!kept) return undefined;
  return item.identities?.[kept === "a" ? "b" : "a"].name;
}

function showBattleStyle() {
  return styles.showBattle;
}

/** The row a decided battle's choice was made in, and which button it took. */
function pastChoice(item: ArenaHistoryItem): ArenaPastChoice | null {
  const resolution = item.resolution;
  if (resolution?.kind === "vote") {
    return { kind: "vote", chosen: resolution.vote === "tie" ? "middle" : resolution.vote };
  }
  if (resolution?.kind === "early") return { kind: "vote", chosen: resolution.vote };
  if (resolution?.kind === "stopped") {
    if (resolution.resolution === "apply_a") return { kind: "keep", chosen: "a" };
    if (resolution.resolution === "apply_b") return { kind: "keep", chosen: "b" };
    return { kind: "keep", chosen: "middle" };
  }
  return null;
}

/**
 * The end of a shown battle, in the chat under its review: the decision row as it was left, the
 * button taken marked, and Hide battle at the row's end.
 */
function ShownBattleEnd({ agentId, item }: { agentId: string; item: ArenaHistoryItem }) {
  const { t } = useTranslation();
  const choice = pastChoice(item);
  const hide = useArenaShownBattleStore((state) => state.hide);
  const onHideBattle = useCallback(() => hide(agentId), [agentId, hide]);
  return (
    <View style={styles.shownFooter} testID="arena-shown-battle-footer">
      <View style={styles.shownFooterEnd} />
      {choice ? (
        <ArenaPastDecision kind={choice.kind} chosen={choice.chosen} />
      ) : (
        <Text style={styles.shownFooterResult}>{chosenLabel(item)}</Text>
      )}
      <View style={[styles.shownFooterEnd, styles.shownFooterEndRight]}>
        <Button
          variant="outline"
          size="md"
          style={styles.hideBattle}
          textStyle={styles.hideBattleText}
          onPress={onHideBattle}
          testID={`arena-hide-battle-${item.id}`}
        >
          {t("arena.hideBattle")}
        </Button>
      </View>
    </View>
  );
}

function CollapsedGitConflicts({
  serverId,
  workspaceId,
  item,
}: {
  serverId: string;
  workspaceId: string;
  item: ArenaHistoryItem;
}) {
  useTranslation();
  const notice = gitApplicationNotice(item);
  if (!notice || notice.tone !== "danger") return null;
  return (
    <View style={styles.collapsedNotice}>
      <GitApplicationCallout serverId={serverId} workspaceId={workspaceId} item={item} />
    </View>
  );
}

function GitApplicationCallout({
  serverId,
  workspaceId,
  item,
}: {
  serverId: string;
  workspaceId: string;
  item: ArenaHistoryItem;
}) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const notice = gitApplicationNotice(item);
  const description = useMemo(
    () =>
      notice ? (
        <View style={styles.gitNoticeCopy}>
          <Text style={styles.gitNoticeDetail}>{notice.detail}</Text>
          {notice.conflicts.length > 0 ? (
            <ArenaPathList paths={notice.conflicts} label={notice.conflictsLabel} />
          ) : null}
        </View>
      ) : null,
    [notice],
  );
  const conflictFile = useMemo(
    () => (notice?.conflicts[0] ? { path: notice.conflicts[0] } : null),
    [notice],
  );
  if (!notice) return null;
  if (notice.tone === "info") {
    return (
      <View
        style={styles.gitInfo}
        accessibilityLiveRegion="polite"
        testID="arena-git-application-notice"
      >
        <ThemedGitBranch size={18} uniProps={mutedColorMapping} />
        <View style={styles.gitNoticeCopy}>
          <Text style={styles.gitNoticeTitle}>{notice.title}</Text>
          {description}
        </View>
      </View>
    );
  }
  return (
    <Alert
      variant={notice.tone === "danger" ? "error" : "warning"}
      title={notice.title}
      testID="arena-git-application-notice"
      description={description}
    >
      {cwd && conflictFile ? (
        <WorkspaceOpenInEditorButton
          serverId={serverId}
          cwd={cwd}
          activeFile={conflictFile}
          buttonLabel={t("arena.openEditor")}
        />
      ) : null}
    </Alert>
  );
}

function ThreadPane({
  side,
  run,
  item,
  kept,
}: {
  side: "a" | "b";
  run: ArenaRun;
  item: ArenaHistoryItem;
  kept: boolean;
}) {
  const { t } = useTranslation();
  const model = item.identities?.[side].name;
  const appliedSide = item.gitApplication?.state === "discarded" ? undefined : item.appliedSide;
  const meta = [
    kept
      ? t("arena.keptAgent", { side: side.toUpperCase() })
      : `${t("arena.agent")} ${side.toUpperCase()}`,
    run.durationMs !== null ? formatDuration(run.durationMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.threadPane} testID={`arena-shown-pane-${side}`}>
      <View style={styles.threadHeader}>
        <View style={[styles.threadRule, side === "a" ? styles.threadRuleA : styles.threadRuleB]} />
        <View style={styles.threadTitleRow}>
          <Text style={styles.threadTitle}>
            {model ? arenaModelDisplayName(model) : `${t("arena.agent")} ${side.toUpperCase()}`}
          </Text>
          {model ? <Text style={styles.threadMeta}>{meta}</Text> : null}
        </View>
      </View>
      <ArenaRunThread
        run={run}
        applied={appliedSide === side}
        stoppedByEarlyPick={isStoppedByEarlyPick({ runState: run.runState, side, turn: item })}
      />
    </View>
  );
}

function BattleThreads({
  runA,
  runB,
  item,
}: {
  runA: ArenaRun | undefined;
  runB: ArenaRun | undefined;
  item: ArenaHistoryItem;
}) {
  if (!runA || !runB) return null;
  const winner = battleWinnerSide(item);
  return (
    <View style={styles.threads}>
      <ThreadPane side="a" run={runA} item={item} kept={winner === "a"} />
      <ThreadPane side="b" run={runB} item={item} kept={winner === "b"} />
    </View>
  );
}

const noop = () => {};

/**
 * A shown battle's review: the same section the battle had while it ran, once there is a summary
 * or a change to show. Until then, the archive's own loading and failure lines.
 */
function ShownBattleComparison(props: Parameters<typeof ArchivedBattleComparison>[0]) {
  const { comparison, diff, bothComplete } = props;
  const reviewable =
    bothComplete && !diff?.treesEqual && (comparison?.output || hasBattleDiff(diff));
  if (!reviewable) return <ArchivedBattleComparison {...props} />;
  return (
    <BattleReview
      serverId={props.serverId}
      agentId={props.agentId}
      turnId={props.turnId}
      summaryAvailable={Boolean(comparison?.output)}
      summaryPending={comparison?.state === "pending" || comparison?.state === "running"}
      summaryFailed={comparison?.state === "failed" && !props.decided}
      waitingFor={null}
      comparison={comparison}
      retrying={props.retrying}
      onRetry={props.onRetry}
      diff={diff}
      diffError={props.diffError}
      rows={arenaChangesRows(diff)}
      onRetryDiff={noop}
      retryingDiff={false}
    />
  );
}

function ArchivedBattleComparison({
  serverId,
  agentId,
  turnId,
  selectedEarly,
  bothComplete,
  comparison,
  decided,
  retrying,
  onRetry,
  diffLoading,
  diff,
  diffError,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  selectedEarly: boolean;
  bothComplete: boolean;
  comparison: ArenaSnapshot["comparison"];
  /** The turn has a resolution, which closes its summary's scope. */
  decided: boolean;
  retrying: boolean;
  onRetry: () => void;
  diffLoading: boolean;
  diff: ArenaComparisonDiff | undefined;
  diffError: Error | null;
}) {
  const { t } = useTranslation();
  if (!bothComplete) {
    return (
      <Text style={styles.muted}>
        {selectedEarly ? t("arena.earlyUnavailable") : t("arena.failedUnavailable")}
      </Text>
    );
  }
  if (diff?.treesEqual) {
    return (
      <View style={styles.section}>
        <IdenticalBattleResult hasChanges={hasBattleDiff(diff)} />
        {hasBattleDiff(diff) ? (
          <ArchivedChanges serverId={serverId} agentId={agentId} turnId={turnId} diff={diff} />
        ) : null}
      </View>
    );
  }
  if (diffLoading) {
    return (
      <View style={styles.loadingRow}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.muted}>{t("arena.loadingBaseChanges")}</Text>
      </View>
    );
  }
  const summaryPending = comparison?.state === "pending" || comparison?.state === "running";
  return (
    <>
      {summaryPending ? (
        <View style={styles.loadingRow}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.muted}>{t("arena.generatingSummary")}</Text>
        </View>
      ) : null}
      {comparison?.output ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("arena.summary")}</Text>
          <SummaryOmissionNotice comparison={comparison} />
          <VerdictBody turnId={turnId} output={comparison.output} />
        </View>
      ) : null}
      {/* A decided turn's failed summary can't be generated again; see battleSummaryStatus. */}
      {comparison?.state === "failed" && !decided ? (
        <View style={styles.loadingRow}>
          <Text style={styles.warning}>{t("arena.summaryFailed")}</Text>
          <Button size="xs" variant="outline" loading={retrying} onPress={onRetry}>
            {t("arena.retrySummary")}{" "}
          </Button>
        </View>
      ) : null}
      {hasBattleDiff(diff) ? (
        <ArchivedChanges serverId={serverId} agentId={agentId} turnId={turnId} diff={diff} />
      ) : null}
      {diffError ? <Text style={styles.warning}>{toErrorMessage(diffError)}</Text> : null}
    </>
  );
}

function ExpandedBattleSummary({
  serverId,
  workspaceId,
  agentId,
  item,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  item: ArenaHistoryItem;
}) {
  const { t } = useTranslation();
  const turnQuery = useArenaStream(serverId, agentId, item.id);
  const snapshot = turnQuery.data;
  const runA = snapshot?.runs.find((run) => run.side === "a");
  const runB = snapshot?.runs.find((run) => run.side === "b");
  return (
    <View style={styles.expanded}>
      {turnQuery.isLoading ? (
        <View style={styles.loadingRow}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.muted}>{t("arena.loadingArchive")}</Text>
        </View>
      ) : null}
      <ArenaStreamStatus error={turnQuery.error} retry={turnQuery.refetch} />
      <View style={styles.expandedNotices}>
        <ArenaTransitionRow transition={snapshot?.turn?.transition ?? item.transition} />
        <GitApplicationCallout
          serverId={serverId}
          workspaceId={workspaceId}
          item={snapshot?.turn ?? item}
        />
      </View>
      <BattleThreads runA={settledHistoryRun(runA)} runB={settledHistoryRun(runB)} item={item} />
      <View style={styles.shownReview}>
        <ShownBattleReview serverId={serverId} agentId={agentId} item={item} />
      </View>
      <ShownBattleEnd agentId={agentId} item={item} />
    </View>
  );
}

/**
 * A shown battle's review, in the chat under its answers. Only a battle waiting for a vote pins its
 * review under the chat: once decided, the review is part of the record and scrolls with its turn.
 */
function ShownBattleReview({
  serverId,
  agentId,
  item,
}: {
  serverId: string;
  agentId: string;
  item: ArenaHistoryItem;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const turnQueryKey = ["arena", "turn", serverId, agentId, item.id] as const;
  const turnQuery = useArenaStream(serverId, agentId, item.id);
  const retryComparison = useMutation({
    onMutate: () => {
      const resumeTurn = turnQuery.subscription?.pause();
      const resumeCurrent = client
        ? arenaSubscription(
            queryClient,
            client,
            agentId,
            { kind: "current" },
            arenaSessionQueryKey(serverId, agentId),
          ).pause()
        : undefined;
      return () => {
        resumeTurn?.();
        resumeCurrent?.();
      };
    },
    onSettled: (_data, _error, _variables, resume) => resume?.(),
    mutationFn: async () => {
      if (!client) throw new Error(t("arena.connectionUnavailable"));
      return client
        .arenaRetryComparison(agentId, item.id)
        .catch((error: unknown) => Promise.reject(noticeAccountSessionRejection(error)));
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(turnQueryKey, snapshot);
      if (snapshot.history.at(-1)?.id === item.id) {
        queryClient.setQueryData(arenaSessionQueryKey(serverId, agentId), snapshot);
      }
    },
  });
  const snapshot = turnQuery.data;
  const runA = snapshot?.runs.find((run) => run.side === "a");
  const runB = snapshot?.runs.find((run) => run.side === "b");
  const bothFinal = runsAreFinal(runA, runB);
  const diffQuery = useFetchQuery({
    queryKey: arenaDiffQueryKey(serverId, agentId, item.id, runA, runB),
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error(t("arena.connectionUnavailable"));
      try {
        return await client.arenaDiff(agentId, item.id);
      } catch (error) {
        throw arenaSizeErrorOr(error);
      }
    },
    enabled: Boolean(client) && bothFinal,
    retry: false,
  });
  const retryComparisonRequest = retryComparison.mutateAsync;
  const handleRetry = useCallback(() => {
    void retryComparisonRequest().catch((error) => toast.error(toErrorMessage(error)));
  }, [retryComparisonRequest, toast]);
  return (
    <ShownBattleComparison
      serverId={serverId}
      agentId={agentId}
      turnId={item.id}
      selectedEarly={item.selectedEarly === true}
      bothComplete={bothFinal}
      comparison={snapshot?.comparison}
      decided={(snapshot?.turn ?? item).resolution !== undefined}
      retrying={retryComparison.isPending}
      onRetry={handleRetry}
      diffLoading={diffQuery.isLoading}
      diff={diffQuery.data}
      diffError={diffQuery.error}
    />
  );
}

/**
 * A battle that failed while it was being created. Neither side ran, so there is nothing to expand
 * and nobody to name. Try again sends the same prompt as a new battle, which draws a new pair.
 */
function FailedBattleStart({
  serverId,
  agentId,
  item,
  canStartAgain,
}: {
  serverId: string;
  agentId: string;
  item: ArenaHistoryItem;
  canStartAgain: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const { mutateAsync: startArena } = useArenaStartMutation(serverId, agentId);
  // Held from the press, through the prompt lookup, until the start settles: a second press in
  // between would send the prompt twice.
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const handleStartAgain = useCallback(() => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const run = async () => {
      if (!client) throw new Error(t("arena.connectionUnavailable"));
      const turn = (await client.arenaTurn(agentId, item.id)).turn;
      if (!turn?.prompt) throw new Error(t("arena.promptUnavailable"));
      // The turn keeps attachment labels, not their bytes, so only the composer can send them again.
      if (turn.attachments?.length) {
        throw new Error(t("arena.promptAttachments"));
      }
      await startArena({ prompt: turn.prompt });
    };
    void run()
      .catch((error) => toast.error(toErrorMessage(error)))
      .finally(() => {
        startingRef.current = false;
        setStarting(false);
      });
  }, [agentId, client, item.id, startArena, toast, t]);
  return (
    <View style={[styles.card, styles.failedStart]} testID={`arena-summary-${item.id}`}>
      <View style={styles.headerText}>
        <Text style={styles.gitNoticeTitle}>{t("arena.couldntStart")}</Text>
        <Text style={styles.gitNoticeDetail}>{t("arena.neitherRan")} </Text>
      </View>
      {canStartAgain ? (
        <Button
          size="xs"
          variant="outline"
          loading={starting}
          onPress={handleStartAgain}
          testID="arena-failed-start-retry"
        >
          {t("arena.tryAgain")}{" "}
        </Button>
      ) : null}
    </View>
  );
}

export function ArenaBattleSummary({
  serverId,
  workspaceId,
  agentId,
  item,
  canStartAgain = false,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  item: ArenaHistoryItem;
  /** Whether a battle that failed to start can be sent again now: nothing else is running. */
  canStartAgain?: boolean;
}) {
  if (battleFailedToStart(item)) {
    return (
      <FailedBattleStart
        serverId={serverId}
        agentId={agentId}
        item={item}
        canStartAgain={canStartAgain}
      />
    );
  }
  return (
    <DecidedBattleSummary
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      item={item}
    />
  );
}

function DecidedBattleSummary({
  serverId,
  workspaceId,
  agentId,
  item,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  item: ArenaHistoryItem;
}) {
  const shownTurnId = useArenaShownBattle(agentId);
  const showBattle = useArenaShownBattleStore((state) => state.show);
  const hideBattle = useArenaShownBattleStore((state) => state.hide);
  const expanded = shownTurnId === item.id;
  const contentMaxWidth = resolveContentMaxWidth(useAppSettings().settings);
  const cardMaxWidth = useSharedValue(contentMaxWidth);
  const bleed = useArenaCardBleed(expanded ? ARENA_MAX_CONTENT_WIDTH : contentMaxWidth);
  const handleToggle = useCallback(() => {
    const next = !expanded;
    cardMaxWidth.value = withTiming(next ? ARENA_MAX_CONTENT_WIDTH : contentMaxWidth, {
      duration: 260,
      easing: Easing.bezier(0.2, 0.7, 0.3, 1),
    });
    if (next) showBattle(agentId, item.id);
    else hideBattle(agentId);
  }, [agentId, cardMaxWidth, contentMaxWidth, expanded, hideBattle, item.id, showBattle]);
  const cardAnimatedStyle = useAnimatedStyle(() => ({ maxWidth: cardMaxWidth.value }));

  // A kept answer names its model in its own footer (`ArenaKeptByline`), so here it leaves only
  // what the chat must still be told, or the battle while it is shown.
  if (keptModel(item) && !expanded) {
    return (
      <View style={styles.keptNotice} testID={`arena-summary-${item.id}`}>
        <CollapsedGitConflicts serverId={serverId} workspaceId={workspaceId} item={item} />
      </View>
    );
  }
  const kept = keptModel(item) !== undefined;
  return (
    <Animated.View
      style={[styles.card, bleed && styles.cardBleed, kept ? styles.cardOpen : cardAnimatedStyle]}
      testID={`arena-summary-${item.id}`}
    >
      {kept ? null : (
        <BattleSummaryHeader expanded={expanded} item={item} onToggle={handleToggle} />
      )}
      {expanded ? (
        <ExpandedBattleSummary
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          item={item}
        />
      ) : (
        <CollapsedGitConflicts serverId={serverId} workspaceId={workspaceId} item={item} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    marginVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  cardBleed: {
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderRadius: 0,
  },
  // A decided battle with a kept answer has no frame: its heading and, when shown, the battle.
  // On the battle's rails at the battle's width, as the chat after a battle is.
  cardOpen: {
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    marginVertical: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    overflow: "visible",
  },
  // The kept model and Show battle, at the battle's right edge in the answer's footer.
  byline: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    columnGap: theme.spacing[1.5],
    minHeight: 24,
  },
  bylineName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  bylineMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  showBattle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 24,
  },
  showBattleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  showBattleChevron: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    lineHeight: theme.fontSize.lg,
    marginTop: -2,
  },
  showBattleActive: {
    color: theme.colors.foreground,
  },
  keptNotice: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: BATTLE_RAIL - theme.spacing[3],
  },
  // A shown battle's review and end sit on the answers' text edge, as the notices above do.
  shownReview: {
    paddingHorizontal: theme.spacing[3],
  },
  shownFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
  },
  shownFooterEnd: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    flexDirection: "row",
  },
  shownFooterEndRight: {
    justifyContent: "flex-end",
  },
  shownFooterResult: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.semibold,
  },
  hideBattle: {
    borderRadius: theme.borderRadius.lg,
  },
  hideBattleText: {
    fontWeight: theme.fontWeight.semibold,
  },
  failedStart: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  cardHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  identities: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  mutedBadge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  conflictBadge: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  // A completed discard, and a branch the winner carried, are information rather than a
  // warning: the callout's shape with the plain border.
  gitInfo: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
  },
  // Evidence coverage is a known limit of the verdict, not a failure: the info callout,
  // sized to its sentence.
  omissionNotice: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.palette.blue[300],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface1,
  },
  omissionNoticeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  gitNoticeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  gitNoticeCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  gitNoticeDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  collapsedNotice: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  sectionSpacer: {
    flex: 1,
  },
  // A shown battle, laid out as it was while it ran: both answers on the battle's rails.
  // The bottom matches a kept answer's footer, so the next turn's rule sits as far below.
  expanded: {
    gap: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[8],
    paddingHorizontal: BATTLE_RAIL - theme.spacing[3],
  },
  // Notices above the answers sit on the answers' own text edge.
  expandedNotices: {
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[3],
  },
  threads: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "flex-start",
    alignItems: "flex-start",
    columnGap: BATTLE_GUTTER - 2 * theme.spacing[3],
    rowGap: theme.spacing[6],
  },
  threadPane: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: ARENA_PANE_BASIS_WIDTH,
    minWidth: 0,
  },
  // Sits on the thread's own rail so the title and the answer share a left edge.
  threadHeader: {
    paddingHorizontal: theme.spacing[3],
  },
  threadRule: {
    height: 2,
  },
  threadRuleA: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  threadRuleB: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  threadTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: -0.4,
  },
  threadMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  threadTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: theme.spacing[2] + theme.spacing[0.5],
    minHeight: 32,
    marginTop: theme.spacing[4],
  },
  threadTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  identicalTitle: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  warning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
  },
}));
