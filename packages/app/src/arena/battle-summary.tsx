import { arenaSubscription } from "./stream-subscription";
import { ArenaStreamStatus } from "./stream-status";
import { useArenaStream } from "./use-arena-stream";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCompareArrows,
  Info,
} from "lucide-react-native";
import type {
  ArenaComparisonDiff,
  ArenaHistoryItem,
  ArenaRun,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { WorkspaceOpenInEditorButton } from "@/screens/workspace/workspace-open-in-editor-button";
import { toErrorMessage } from "@/utils/error-messages";
import { useFetchQuery } from "@/data/query";
import {
  ARENA_MAX_CONTENT_WIDTH,
  ARENA_PANE_BASIS_WIDTH,
  MAX_CONTENT_WIDTH,
} from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { battleWinnerSide, gitApplicationNotice, isStoppedByEarlyPick } from "./battle-result";
import { ArenaPathList } from "./path-list";
import { useContainerWidth } from "@/hooks/use-container-width";
import { useArenaDiffLayout } from "./diff-layout";
import { DiffLayoutControl } from "./diff-layout-control";
import { InlineFileDiff, openChangesFile } from "./inline-file-diff";
import { VerdictBody } from "./verdict-body";
import { ArenaChangesList } from "./changes-list";
import { arenaChangesCountLabel, arenaChangesRows } from "./changes-rows";
import { hasBattleDiff } from "./comparison-visibility";
import { arenaModelDisplayName } from "./side-label";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import { describeSummaryOmissions } from "./summary-omissions";
import { ArenaRunMeta } from "./run-meta";
import { ArenaRunThread } from "./run-thread";
import { arenaSessionQueryKey } from "./use-arena-session";
import { ArenaTransitionRow } from "./transition-row";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedGitCompareArrows = withUnistyles(GitCompareArrows);
const ThemedCheckSquare = withUnistyles(CheckSquare);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedInfo = withUnistyles(Info);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.success });
// The info accent shared with <Alert variant="info"> and info toasts.
const infoColorMapping = (theme: Theme) => ({ color: theme.colors.palette.blue[300] });

function chosenLabel(item: ArenaHistoryItem): string {
  if (item.gitApplication?.state === "discarded") return "Winning changes discarded";
  if (item.vote === "tie") {
    const applied = item.appliedSide?.toUpperCase() ?? "A";
    const model = item.appliedSide
      ? arenaModelDisplayName(item.identities?.[item.appliedSide].name)
      : "";
    return `Tie — ${applied} applied${model ? ` (${model})` : ""}`;
  }
  const side = item.appliedSide;
  if (!side) {
    if (item.resolution?.kind === "stopped") return "Battle discarded";
    return "Battle resolved";
  }
  return `Chose ${arenaModelDisplayName(item.identities?.[side].name)} (Agent ${side.toUpperCase()})`;
}

/**
 * The files an archived battle touched, with the selected one's diff.
 */
function ArchivedChanges({ agentId, diff }: { agentId: string; diff: ArenaComparisonDiff }) {
  const rows = useMemo(() => arenaChangesRows(diff), [diff]);
  const { onLayout, width } = useContainerWidth();
  const measured = width > 0 ? width : null;
  const layout = useArenaDiffLayout(agentId, measured);
  // Undefined until the reader picks a row; null once they close the open diff.
  const [chosenFile, setChosenFile] = useState<string | null | undefined>(undefined);
  const selectedFile = openChangesFile(rows, chosenFile);
  const closeFile = useCallback(() => setChosenFile(null), []);
  return (
    <View style={styles.section} onLayout={onLayout}>
      <View style={styles.sectionHeader}>
        <ThemedGitCompareArrows size={16} uniProps={mutedColorMapping} />
        <Text style={styles.sectionTitle}>Changes from base</Text>
        <Text style={styles.muted}>{arenaChangesCountLabel(rows.length)}</Text>
        <View style={styles.sectionSpacer} />
        <DiffLayoutControl agentId={agentId} width={measured} />
      </View>
      <ArenaChangesList
        rows={rows}
        onSelect={setChosenFile}
        selectedFile={selectedFile ?? undefined}
      />
      {selectedFile ? (
        <InlineFileDiff diff={diff} file={selectedFile} layout={layout} onClose={closeFile} />
      ) : null}
      {diff.filesTruncated ? (
        <Text style={styles.warning}>
          This battle touched more files than the comparison view can show at once; the rest are
          omitted here.
        </Text>
      ) : null}
    </View>
  );
}

// Keep evidence coverage visible above the verdict, including when its prose folds.
export function SummaryOmissionNotice({ comparison }: { comparison: ArenaSnapshot["comparison"] }) {
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
  if (hasChanges) {
    return (
      <Text style={styles.muted} testID="arena-identical-results">
        Both agents made the same changes. Showing changes from the original.
      </Text>
    );
  }
  return (
    <View style={styles.identicalResult} testID="arena-identical-results">
      <ThemedGitCompareArrows size={16} uniProps={successColorMapping} />
      <View style={styles.identicalCopy}>
        <Text style={styles.sectionTitle}>File results are identical</Text>
        <Text style={styles.muted}>Neither agent changed any files from the original.</Text>
      </View>
    </View>
  );
}

function runsAreFinal(runA: ArenaRun | undefined, runB: ArenaRun | undefined): boolean {
  return Boolean(runA && runB && runA.runState !== "pending" && runB.runState !== "pending");
}

/** One side's model, as revealed by the vote: its vendor's mark and its name. */
function RevealedIdentity({
  side,
  model,
  winner,
}: {
  side: "a" | "b";
  model: string | undefined;
  winner: boolean;
}) {
  return (
    <View style={styles.identity}>
      <Text style={styles.identities}>{side.toUpperCase()}:</Text>
      <ArenaModelVendorIcon model={model} size={ICON_SIZE.xs} tone="muted" />
      <Text style={styles.identities}>{arenaModelDisplayName(model)}</Text>
      {winner ? <Text style={styles.identities}>(winner)</Text> : null}
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
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const winner = battleWinnerSide(item);
  const showOutcome = !winner || item.gitApplication?.state === "discarded";
  const gitNotice = gitApplicationNotice(item);
  return (
    <Pressable
      onPress={onToggle}
      style={styles.cardHeader}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${expanded ? "Collapse" : "Expand"} battle summary. ${chosenLabel(item)}`}
    >
      {expanded ? (
        <ThemedChevronDown size={17} uniProps={mutedColorMapping} />
      ) : (
        <ThemedChevronRight size={17} uniProps={mutedColorMapping} />
      )}
      <View style={styles.headerText}>
        <View style={styles.identityRow}>
          <RevealedIdentity side="a" model={item.identities?.a.name} winner={winner === "a"} />
          <Text style={styles.identities}>·</Text>
          <RevealedIdentity side="b" model={item.identities?.b.name} winner={winner === "b"} />
          {showOutcome ? <Text style={styles.identities}>· {chosenLabel(item)}</Text> : null}
        </View>
      </View>
      {gitNotice && gitNotice.tone !== "info" ? (
        <Text style={styles.conflictBadge}>{gitNotice.title}</Text>
      ) : null}
      {item.selectedEarly ? <Text style={styles.earlyBadge}>Early decision</Text> : null}
    </Pressable>
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
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const notice = useMemo(() => gitApplicationNotice(item), [item]);
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
          buttonLabel="Open in editor"
        />
      ) : null}
    </Alert>
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
  const active = useRetainedPanelActive();
  if (!runA || !runB) return null;
  const winner = battleWinnerSide(item);
  return (
    <View style={styles.threads}>
      <View style={styles.threadPane}>
        <View style={styles.threadHeader}>
          <View style={styles.threadTitleRow}>
            <View style={styles.threadTitleGroup}>
              <Text style={styles.threadTitle}>Agent A ·</Text>
              <ArenaModelVendorIcon model={item.identities?.a.name} size={ICON_SIZE.sm} />
              <Text style={styles.threadTitle}>
                {arenaModelDisplayName(item.identities?.a.name)}
              </Text>
            </View>
            {winner === "a" ? (
              <View accessible accessibilityLabel="Agent A winner">
                <ThemedCheckSquare size={16} uniProps={successColorMapping} />
              </View>
            ) : null}
          </View>
          <ArenaRunMeta run={runA} side="a" active={active} />
        </View>
        <ArenaRunThread
          run={runA}
          stoppedByEarlyPick={isStoppedByEarlyPick({
            runState: runA?.runState,
            side: "a",
            turn: item,
          })}
        />
      </View>
      <View style={styles.threadPane}>
        <View style={styles.threadHeader}>
          <View style={styles.threadTitleRow}>
            <View style={styles.threadTitleGroup}>
              <Text style={styles.threadTitle}>Agent B ·</Text>
              <ArenaModelVendorIcon model={item.identities?.b.name} size={ICON_SIZE.sm} />
              <Text style={styles.threadTitle}>
                {arenaModelDisplayName(item.identities?.b.name)}
              </Text>
            </View>
            {winner === "b" ? (
              <View accessible accessibilityLabel="Agent B winner">
                <ThemedCheckSquare size={16} uniProps={successColorMapping} />
              </View>
            ) : null}
          </View>
          <ArenaRunMeta run={runB} side="b" active={active} />
        </View>
        <ArenaRunThread
          run={runB}
          stoppedByEarlyPick={isStoppedByEarlyPick({
            runState: runB?.runState,
            side: "b",
            turn: item,
          })}
        />
      </View>
    </View>
  );
}

function ArchivedBattleComparison({
  agentId,
  turnId,
  selectedEarly,
  bothComplete,
  comparison,
  retrying,
  onRetry,
  diffLoading,
  diff,
  diffError,
}: {
  agentId: string;
  turnId: string;
  selectedEarly: boolean;
  bothComplete: boolean;
  comparison: ArenaSnapshot["comparison"];
  retrying: boolean;
  onRetry: () => void;
  diffLoading: boolean;
  diff: ArenaComparisonDiff | undefined;
  diffError: Error | null;
}) {
  if (!bothComplete) {
    return (
      <Text style={styles.muted}>
        {selectedEarly
          ? "Comparison unavailable because this battle was decided early."
          : "Comparison unavailable because both agents did not finish successfully."}
      </Text>
    );
  }
  if (diff?.treesEqual) {
    return (
      <View style={styles.section}>
        <IdenticalBattleResult hasChanges={hasBattleDiff(diff)} />
        {hasBattleDiff(diff) ? <ArchivedChanges agentId={agentId} diff={diff} /> : null}
      </View>
    );
  }
  if (diffLoading) {
    return (
      <View style={styles.loadingRow}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.muted}>Loading changes from base…</Text>
      </View>
    );
  }
  const summaryPending = comparison?.state === "pending" || comparison?.state === "running";
  return (
    <>
      {summaryPending ? (
        <View style={styles.loadingRow}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.muted}>Generating difference summary…</Text>
        </View>
      ) : null}
      {comparison?.output ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Difference summary</Text>
          <SummaryOmissionNotice comparison={comparison} />
          <VerdictBody turnId={turnId} output={comparison.output} />
        </View>
      ) : null}
      {comparison?.state === "failed" ? (
        <View style={styles.loadingRow}>
          <Text style={styles.warning}>The difference summary failed to generate.</Text>
          <Button size="xs" variant="outline" loading={retrying} onPress={onRetry}>
            Retry summary
          </Button>
        </View>
      ) : null}
      {hasBattleDiff(diff) ? <ArchivedChanges agentId={agentId} diff={diff} /> : null}
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
      if (!client) throw new Error("Arena daemon connection is unavailable");
      return client.arenaRetryComparison(agentId, item.id);
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
    queryKey: ["arena", "diff", serverId, agentId, item.id],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      return client.arenaDiff(agentId, item.id);
    },
    enabled: Boolean(client) && bothFinal,
    retry: false,
  });
  const retryComparisonRequest = retryComparison.mutateAsync;
  const handleRetry = useCallback(() => {
    void retryComparisonRequest().catch((error) => toast.error(toErrorMessage(error)));
  }, [retryComparisonRequest, toast]);
  return (
    <View style={styles.expanded}>
      {turnQuery.isLoading ? (
        <View style={styles.loadingRow}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.muted}>Loading archived battle…</Text>
        </View>
      ) : null}
      <ArenaStreamStatus error={turnQuery.error} retry={turnQuery.refetch} />
      <ArenaTransitionRow transition={snapshot?.turn?.transition ?? item.transition} />
      <GitApplicationCallout
        serverId={serverId}
        workspaceId={workspaceId}
        item={snapshot?.turn ?? item}
      />
      <BattleThreads runA={runA} runB={runB} item={item} />
      <ArchivedBattleComparison
        agentId={agentId}
        turnId={item.id}
        selectedEarly={item.selectedEarly === true}
        bothComplete={bothFinal}
        comparison={snapshot?.comparison}
        retrying={retryComparison.isPending}
        onRetry={handleRetry}
        diffLoading={diffQuery.isLoading}
        diff={diffQuery.data}
        diffError={diffQuery.error}
      />
    </View>
  );
}

export function ArenaBattleSummary({
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
  const [expanded, setExpanded] = useState(false);
  const cardMaxWidth = useSharedValue(MAX_CONTENT_WIDTH);
  const handleToggle = useCallback(() => {
    setExpanded((value) => {
      const next = !value;
      cardMaxWidth.value = withTiming(next ? ARENA_MAX_CONTENT_WIDTH : MAX_CONTENT_WIDTH, {
        duration: 260,
        easing: Easing.bezier(0.2, 0.7, 0.3, 1),
      });
      return next;
    });
  }, [cardMaxWidth]);
  const cardAnimatedStyle = useAnimatedStyle(() => ({ maxWidth: cardMaxWidth.value }));

  return (
    <Animated.View style={[styles.card, cardAnimatedStyle]} testID={`arena-summary-${item.id}`}>
      <BattleSummaryHeader expanded={expanded} item={item} onToggle={handleToggle} />
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
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    marginVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
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
    fontSize: theme.fontSize.xs,
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
  earlyBadge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  conflictBadge: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
  },
  gitNoticeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  gitNoticeCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  gitNoticeDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  collapsedNotice: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  sectionSpacer: {
    flex: 1,
  },
  expanded: {
    gap: theme.spacing[4],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  threads: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "flex-start",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  threadPane: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: ARENA_PANE_BASIS_WIDTH,
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingTop: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  // Sits on the thread's own rail so the title and the answer share a left edge.
  threadHeader: {
    paddingHorizontal: theme.spacing[3],
    gap: 2,
  },
  threadTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  threadTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  identicalResult: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface0,
  },
  identicalCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  warning: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
