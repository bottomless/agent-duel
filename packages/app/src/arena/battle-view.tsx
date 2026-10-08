import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ArrowDown, Maximize2, Minimize2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ArenaHistoryItem,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { ARENA_MAX_CONTENT_WIDTH, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { MessageOuterSpacingProvider, UserMessage } from "@/components/message";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ArenaRunThread } from "./run-thread";
import { ArenaRunTaskFooter } from "./task-progress-card";
import { openArenaWorktreeChanges } from "./explorer-selection";
import { ARENA_RUN_META_HEIGHT, ArenaRunMeta } from "./run-meta";
import type { ArenaTurnAction } from "./use-arena-session";
import { useArenaBattleActions } from "./use-battle-actions";
import { arenaChangesRows } from "./changes-rows";
import { BattleReview } from "./battle-review";
import { useArenaReviewTelemetry } from "./review-telemetry";
import { isStoppedByEarlyPick } from "./battle-result";
import { canRequestBattleDiff } from "./comparison-visibility";
import type { ArenaPendingQuestion } from "./question";
import type { ArenaPendingPermission, ArenaPermissionReply } from "./permission";
import { Button } from "@/components/ui/button";
import { useContainerWidth } from "@/hooks/use-container-width";
import { Alert } from "@/components/ui/alert";
import { ArenaServicesStrip } from "./services-strip";
import { ArenaTransitionRow, arenaTransitionRowVisible } from "./transition-row";
import { ArenaWorktreeMenuButton } from "./worktree-menu";
import { useArenaCardBleed } from "./content-column";
import { PaneIconAction } from "./pane-icon-action";
import { retainedProcessCount } from "./environment";
import { isArenaBattleOnScreen } from "./summary-anchor";
import { arenaPromptAttachmentPills } from "./prompt-attachment-pills";
import { arenaPromptImages } from "./prompt-images";
import type { StartingArenaBattle } from "./use-arena-session";

type ArenaPaneView = ArenaSide | "both";

// Keep both answers side by side until each pane would fall below roughly 30–35
// characters of readable content at the default interface size.
const STACKED_PANES_BREAKPOINT = 520;

const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedMinimize2 = withUnistyles(Minimize2);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function useArenaPaneView(turnIndex: number | undefined) {
  const [paneView, setPaneView] = useState<ArenaPaneView>("both");
  const lastTurnIndexRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (turnIndex === undefined) return;
    if (lastTurnIndexRef.current !== undefined && lastTurnIndexRef.current !== turnIndex) {
      setPaneView("both");
    }
    lastTurnIndexRef.current = turnIndex;
  }, [turnIndex]);
  return [paneView, setPaneView] as const;
}

// The composer stays available during a battle. Give the resting panes most of the chat viewport
// while leaving enough room to orient around the prompt and continue the conversation.
function useArenaPaneMaxHeight(): number {
  const { height } = useWindowDimensions();
  return Math.max(360, Math.round(height * 0.55));
}

/** The chat's reading column, for the prompt above the card. The card sets its own width. */
/** The card's frame. Edge to edge it keeps only its top and bottom edges; see `useArenaCardBleed`. */
function BattleCard({ children, testID }: { children: ReactNode; testID: string }) {
  const bleed = useArenaCardBleed();
  return (
    <View style={[styles.root, bleed && styles.rootBleed]} testID={testID}>
      {children}
    </View>
  );
}

function BattleReadingColumn({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.battleReadingColumn} testID={testID}>
      {children}
    </View>
  );
}

/**
 * A run's diff stats open the Changes tab on that run's worktree. The handler is
 * per side so the memoised status line keeps its identity between ticks.
 */
function useOpenRunChanges(input: {
  serverId: string;
  workspaceId: string;
  side: ArenaSide;
  run: ArenaRun | undefined;
}): (() => void) | undefined {
  const { serverId, workspaceId, side, run } = input;
  const browsable = Boolean(run?.worktree && run.worktreeActive);
  const open = useCallback(
    () => openArenaWorktreeChanges({ serverId, workspaceId, side }),
    [serverId, side, workspaceId],
  );
  return browsable ? open : undefined;
}

function BattlePane({
  serverId,
  workspaceId,
  agentId,
  turnId,
  side,
  run,
  stoppedByEarlyPick,
  maxHeight,
  respondingQuestionId,
  respondingPermissionId,
  onQuestionResponse,
  onPermissionResponse,
  hidden,
  showDivider,
  stacked = false,
  paneView,
  onPaneViewChange,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  /** Keys the preview-opened review event; empty while no turn exists yet. */
  turnId: string;
  side: ArenaSide;
  run: ArenaRun | undefined;
  stoppedByEarlyPick: boolean;
  maxHeight: number;
  respondingQuestionId: string | null;
  respondingPermissionId: string | null;
  onQuestionResponse: (
    run: ArenaRun,
    question: ArenaPendingQuestion,
    response: AgentPermissionResponse,
  ) => void;
  onPermissionResponse: (
    run: ArenaRun,
    permission: ArenaPendingPermission,
    response: ArenaPermissionReply,
  ) => void;
  hidden: boolean;
  showDivider: boolean;
  stacked?: boolean;
  paneView: ArenaPaneView;
  onPaneViewChange: (value: ArenaPaneView) => void;
}) {
  const active = useRetainedPanelActive();
  const threadScrollRef = useRef<ScrollView>(null);
  const autoScrollEnabledRef = useRef(true);
  const userScrollActiveRef = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const contentHeightRef = useRef(0);

  const scrollToLatest = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    threadScrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  useEffect(() => {
    autoScrollEnabledRef.current = true;
    userScrollActiveRef.current = false;
    contentHeightRef.current = 0;
    setAwayFromLatest(false);
    scrollToLatest();
  }, [run?.id, scrollToLatest]);
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      scrollToLatest();
    },
    [scrollToLatest],
  );
  const handleScrollBeginDrag = useCallback(() => {
    userScrollActiveRef.current = true;
  }, []);
  const handleScrollEndDrag = useCallback(() => {
    userScrollActiveRef.current = false;
  }, []);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const contentChangedBeforeCallback = contentSize.height !== contentHeightRef.current;
      if (
        contentChangedBeforeCallback &&
        autoScrollEnabledRef.current &&
        !userScrollActiveRef.current
      ) {
        contentHeightRef.current = contentSize.height;
        scrollToLatest();
        return;
      }

      const distanceFromBottom = Math.max(
        0,
        contentSize.height - layoutMeasurement.height - contentOffset.y,
      );
      const atLatest = distanceFromBottom <= 24;
      autoScrollEnabledRef.current = atLatest;
      setAwayFromLatest(!atLatest);
    },
    [scrollToLatest],
  );
  const jumpToLatest = useCallback(() => {
    autoScrollEnabledRef.current = true;
    setAwayFromLatest(false);
    scrollToLatest();
  }, [scrollToLatest]);
  const handleQuestionResponse = useCallback(
    (question: ArenaPendingQuestion, response: AgentPermissionResponse) => {
      if (run) onQuestionResponse(run, question, response);
    },
    [onQuestionResponse, run],
  );
  const handlePermissionResponse = useCallback(
    (permission: ArenaPendingPermission, response: ArenaPermissionReply) => {
      if (run) onPermissionResponse(run, permission, response);
    },
    [onPermissionResponse, run],
  );
  // The pane height follows the window, so it is an inline pixel value rather than a
  // registered style (docs/unistyles.md, dynamic pixel styles on web).
  const paneStyle = useMemo(
    () => [
      styles.pane,
      hidden && styles.paneHidden,
      stacked && styles.paneStacked,
      showDivider && (stacked ? styles.paneStackedDivider : styles.paneDivider),
      inlineUnistylesStyle({ height: maxHeight }),
    ],
    [hidden, maxHeight, showDivider, stacked],
  );
  // The run exists from the moment its session is forked, which is before the worktrees are
  // ready and well before its prompt is dispatched. Treating that as started swaps the pane to
  // "Working" over a thread it has to guess at, and the only thing there to guess from is the
  // conversation it inherited. `startedAt` is written with the prompt boundary, so it means
  // dispatched rather than merely existing.
  const dispatched = run?.startedAt ? run : undefined;
  const openChanges = useOpenRunChanges({ serverId, workspaceId, side, run });
  const expanded = paneView === side;
  const handleExpand = useCallback(() => {
    onPaneViewChange(side);
  }, [onPaneViewChange, side]);
  const handleRestore = useCallback(() => {
    onPaneViewChange("both");
  }, [onPaneViewChange]);
  return (
    <View style={paneStyle} testID={`arena-pane-${side}`}>
      <View style={styles.paneHeader}>
        <View style={styles.paneHeading}>
          <Text style={styles.agentName}>Agent {side.toUpperCase()}</Text>
          {dispatched ? (
            <ArenaRunMeta
              run={dispatched}
              side={side}
              active={active}
              onOpenChanges={openChanges}
            />
          ) : (
            <Text style={styles.status}>Preparing</Text>
          )}
        </View>
        <View style={styles.paneHeaderActions}>
          {run?.worktree && run.worktreeActive ? (
            <ArenaWorktreeMenuButton
              serverId={serverId}
              workspaceId={workspaceId}
              agentId={agentId}
              side={side}
              worktree={run.worktree}
              worktreeName={run.worktreeName}
            />
          ) : null}
          <PaneIconAction
            onPress={expanded ? handleRestore : handleExpand}
            accessibilityLabel={
              expanded ? "Restore split view" : `Expand Agent ${side.toUpperCase()}`
            }
            testID={`arena-pane-expand-${side}`}
          >
            {expanded ? (
              <ThemedMinimize2 size={ICON_SIZE.xs} uniProps={foregroundColorMapping} />
            ) : (
              <ThemedMaximize2 size={ICON_SIZE.xs} uniProps={foregroundColorMapping} />
            )}
          </PaneIconAction>
        </View>
      </View>
      <View style={styles.paneBody} testID={`arena-pane-body-${side}`}>
        {/* The jump button anchors to the thread, not the pane body, so it stays clear of the task
            footer and services strip below the thread. */}
        <View style={[styles.threadArea, run?.runState === "pending" && styles.runningThreadArea]}>
          <ScrollView
            ref={threadScrollRef}
            style={styles.threadScroll}
            contentContainerStyle={styles.threadContent}
            nestedScrollEnabled
            scrollEventThrottle={16}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onContentSizeChange={handleContentSizeChange}
            testID={`arena-thread-${side}`}
          >
            {dispatched ? (
              <ArenaRunThread
                run={dispatched}
                stoppedByEarlyPick={stoppedByEarlyPick}
                respondingQuestionId={respondingQuestionId}
                respondingPermissionId={respondingPermissionId}
                onQuestionResponse={handleQuestionResponse}
                onPermissionResponse={handlePermissionResponse}
              />
            ) : null}
          </ScrollView>
          {awayFromLatest ? (
            <View style={styles.latestOverlay} pointerEvents="box-none">
              <Button
                size="sm"
                variant="outline"
                style={styles.latestButton}
                leftIcon={ArrowDown}
                accessibilityLabel={`Jump to latest in Agent ${side.toUpperCase()}`}
                onPress={jumpToLatest}
                testID={`arena-latest-${side}`}
              />
            </View>
          ) : null}
        </View>
        {run?.runState === "pending" ? (
          <ArenaRunTaskFooter run={run} paneMaxHeight={maxHeight} />
        ) : null}
        {run ? <ArenaServicesStrip turnId={turnId} run={run} /> : null}
      </View>
    </View>
  );
}

// The same key the side panel and the summary fetch, so no view adds a request.
function useBattleDiff(serverId: string, agentId: string, turnId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return useFetchQuery({
    queryKey: ["arena", "diff", serverId, agentId, turnId],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      return client.arenaDiff(agentId, turnId);
    },
    enabled: Boolean(client),
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
  });
}

/**
 * The card once both results are in: the review region, fed from the same diff
 * query the summary uses.
 */
function BattleJudging({
  serverId,
  agentId,
  turnId,
  comparison,
  comparisonState,
  retrying,
  onRetry,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  comparison: ArenaSnapshot["comparison"];
  comparisonState: NonNullable<ArenaSnapshot["turn"]>["comparisonState"];
  retrying: boolean;
  onRetry: () => void;
}) {
  // A stopped battle never gets a judge's verdict; the changes stand alone.
  // Likewise a turn whose comparison never started has nothing to say yet.
  const summaryPending = comparison?.state === "pending" || comparison?.state === "running";
  const summaryFailed = comparison?.state === "failed";
  const summaryAvailable =
    comparisonState !== "skipped" &&
    (summaryPending || summaryFailed || Boolean(comparison?.output));
  const diffQuery = useBattleDiff(serverId, agentId, turnId);
  const refetchDiff = diffQuery.refetch;
  const retryDiff = useCallback(() => {
    void refetchDiff();
  }, [refetchDiff]);
  const diff = diffQuery.data;
  const rows = useMemo(() => arenaChangesRows(diff), [diff]);
  return (
    <BattleReview
      agentId={agentId}
      turnId={turnId}
      summaryAvailable={summaryAvailable}
      summaryPending={summaryPending}
      summaryFailed={summaryFailed}
      comparison={comparison}
      retrying={retrying}
      onRetry={onRetry}
      diff={diff}
      diffError={diffQuery.error}
      rows={rows}
      onRetryDiff={retryDiff}
      retryingDiff={diffQuery.isFetching}
    />
  );
}

function runsAreFinal(runA: ArenaRun | undefined, runB: ArenaRun | undefined): boolean {
  return Boolean(runA && runB && runA.runState !== "pending" && runB.runState !== "pending");
}

interface RespondingIds {
  questionId: string | null;
  permissionId: string | null;
}

const NOT_RESPONDING: RespondingIds = { questionId: null, permissionId: null };

/** Which of this run's prompts the in-flight action is answering, if any. */
function respondingIdsForRun(
  action: ArenaTurnAction | null,
  run: ArenaRun | undefined,
): RespondingIds {
  if (!action || !run) return NOT_RESPONDING;
  switch (action.kind) {
    case "reply_question":
    case "reject_question":
      return action.runId === run.id
        ? { questionId: action.questionRequestId, permissionId: null }
        : NOT_RESPONDING;
    case "reply_permission":
      return action.runId === run.id
        ? { questionId: null, permissionId: action.permissionRequestId }
        : NOT_RESPONDING;
    default:
      return NOT_RESPONDING;
  }
}

const ignoreQuestionResponse = (
  _run: ArenaRun,
  _question: ArenaPendingQuestion,
  _response: AgentPermissionResponse,
) => undefined;
const ignorePermissionResponse = (
  _run: ArenaRun,
  _permission: ArenaPendingPermission,
  _response: ArenaPermissionReply,
) => undefined;

/**
 * The two panes, in every state a battle can be in.
 *
 * One component so the starting view and the running view can put it at the same place in the
 * same skeleton. React reconciles by position and type: a different component here, or the
 * same one at a different index, and it discards both panes and builds new ones — which is
 * the blink this exists to prevent. A battle changes hands twice as it starts, and the panes
 * have to survive both.
 */
function BattlePanes({
  serverId,
  workspaceId,
  agentId,
  turnId,
  runA,
  runB,
  turn,
  maxHeight,
  respondingA,
  respondingB,
  onQuestionResponse,
  onPermissionResponse,
  paneView,
  onPaneViewChange,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  turnId: string;
  runA: ArenaRun | undefined;
  runB: ArenaRun | undefined;
  turn: Pick<ArenaHistoryItem, "selectedEarly" | "appliedSide"> | undefined;
  maxHeight: number;
  respondingA: RespondingIds;
  respondingB: RespondingIds;
  onQuestionResponse: (
    run: ArenaRun,
    question: ArenaPendingQuestion,
    response: AgentPermissionResponse,
  ) => void;
  onPermissionResponse: (
    run: ArenaRun,
    permission: ArenaPendingPermission,
    response: ArenaPermissionReply,
  ) => void;
  paneView: ArenaPaneView;
  onPaneViewChange: (value: ArenaPaneView) => void;
}) {
  const { width, onLayout } = useContainerWidth();
  const stacked = width > 0 && width < STACKED_PANES_BREAKPOINT;
  return (
    <View onLayout={onLayout} style={[styles.panes, stacked && styles.panesNarrow]}>
      <BattlePane
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        turnId={turnId}
        side="a"
        run={runA}
        stoppedByEarlyPick={isStoppedByEarlyPick({ runState: runA?.runState, side: "a", turn })}
        maxHeight={maxHeight}
        stacked={stacked}
        respondingQuestionId={respondingA.questionId}
        respondingPermissionId={respondingA.permissionId}
        onQuestionResponse={onQuestionResponse}
        onPermissionResponse={onPermissionResponse}
        hidden={paneView === "b"}
        showDivider={false}
        paneView={paneView}
        onPaneViewChange={onPaneViewChange}
      />
      <BattlePane
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        turnId={turnId}
        side="b"
        run={runB}
        stoppedByEarlyPick={isStoppedByEarlyPick({ runState: runB?.runState, side: "b", turn })}
        maxHeight={maxHeight}
        stacked={stacked}
        respondingQuestionId={respondingB.questionId}
        respondingPermissionId={respondingB.permissionId}
        onQuestionResponse={onQuestionResponse}
        onPermissionResponse={onPermissionResponse}
        hidden={paneView === "a"}
        showDivider={paneView === "both"}
        paneView={paneView}
        onPaneViewChange={onPaneViewChange}
      />
    </View>
  );
}

/** Both panes before either side has a run yet. */
function BattlePanesPlaceholder({
  paneView,
  onPaneViewChange,
}: {
  paneView: ArenaPaneView;
  onPaneViewChange: (value: ArenaPaneView) => void;
}) {
  const maxHeight = useArenaPaneMaxHeight();
  return (
    <View style={styles.panes}>
      <BattlePane
        serverId=""
        workspaceId=""
        agentId=""
        turnId=""
        side="a"
        run={undefined}
        stoppedByEarlyPick={false}
        maxHeight={maxHeight}
        respondingQuestionId={null}
        respondingPermissionId={null}
        onQuestionResponse={ignoreQuestionResponse}
        onPermissionResponse={ignorePermissionResponse}
        hidden={paneView === "b"}
        showDivider={false}
        paneView={paneView}
        onPaneViewChange={onPaneViewChange}
      />
      <BattlePane
        serverId=""
        workspaceId=""
        agentId=""
        turnId=""
        side="b"
        run={undefined}
        stoppedByEarlyPick={false}
        maxHeight={maxHeight}
        respondingQuestionId={null}
        respondingPermissionId={null}
        onQuestionResponse={ignoreQuestionResponse}
        onPermissionResponse={ignorePermissionResponse}
        hidden={paneView === "a"}
        showDivider={paneView === "both"}
        paneView={paneView}
        onPaneViewChange={onPaneViewChange}
      />
    </View>
  );
}

/** Keep the pane controls in place while the workspace is created. */
function ArenaPreparingBattleView({
  prompt,
  timestamp,
  testID,
}: {
  prompt: string;
  timestamp: number;
  testID: string;
}) {
  const [paneView, setPaneView] = useState<ArenaPaneView>("both");
  // The prompt and the card are one block here, the way the stream holds them once the chat
  // exists: its row gap between the two, and the message's own outer margins off, because the
  // gap is the host's to set. Matching it is what keeps the pair from moving at the handoff.
  return (
    <MessageOuterSpacingProvider disableOuterSpacing>
      <View style={styles.preparingBattle}>
        <BattleReadingColumn testID="arena-battle-prompt-column">
          <UserMessage message={prompt} timestamp={timestamp} isPending />
        </BattleReadingColumn>
        <BattleCard testID={testID}>
          <BattlePanesPlaceholder paneView={paneView} onPaneViewChange={setPaneView} />
        </BattleCard>
      </View>
    </MessageOuterSpacingProvider>
  );
}

export function ArenaDraftBattleView({ prompt, timestamp }: { prompt: string; timestamp: number }) {
  return (
    <ArenaPreparingBattleView
      prompt={prompt}
      timestamp={timestamp}
      testID="arena-draft-battle-view"
    />
  );
}

export function ArenaQueuedBattleView({
  prompt,
  timestamp,
}: {
  prompt: string;
  timestamp: number;
}) {
  return (
    <ArenaPreparingBattleView
      prompt={prompt}
      timestamp={timestamp}
      testID="arena-queued-battle-view"
    />
  );
}

export function ArenaBattleView({
  serverId,
  workspaceId,
  agentId,
  snapshot,
  startingPrompt,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  /**
   * Set while a battle has been sent and its turn has not arrived. This view renders that
   * state itself rather than yielding to a separate one: a different component in the same
   * slot is a different element type, so React tears the panes down and builds them again,
   * and the panes blink at exactly the moment they are supposed to be reassuring.
   */
  startingPrompt?: StartingArenaBattle;
}) {
  // Only the battle this view owns. A ready chat still carries the last resolved turn; while
  // the next battle is starting, rendering that turn would bring the previous battle back.
  const turn = isArenaBattleOnScreen(snapshot) ? snapshot.turn : undefined;
  const actions = useArenaBattleActions(serverId, agentId, turn);
  const paneMaxHeight = useArenaPaneMaxHeight();
  // The retained winner is still on the chat until its processes are stopped, so this is what
  // the transition row reports in the present tense until the real transition replaces it.
  const retainedWinner = snapshot.environment.retainedWinner;
  const pendingStops = retainedProcessCount(
    retainedWinner ? snapshot.runs.find((run) => run.id === retainedWinner.runID) : undefined,
  );
  const runA = snapshot.runs.find((run) => run.side === "a");
  const runB = snapshot.runs.find((run) => run.side === "b");
  const promptImages = useMemo(() => arenaPromptImages(snapshot.runs), [snapshot.runs]);
  const promptAttachments = turn?.attachments;
  // An image shows as its thumbnail when the runs still hold it, and as a labelled pill otherwise.
  const promptAttachmentPills = useMemo(
    () =>
      arenaPromptAttachmentPills(
        promptImages.length > 0
          ? promptAttachments?.filter((attachment) => attachment.kind !== "image")
          : promptAttachments,
      ),
    [promptAttachments, promptImages.length],
  );
  const bothFinal = runsAreFinal(runA, runB);
  const reviewAvailable = bothFinal && Boolean(turn && canRequestBattleDiff(turn.state));
  const [paneView, setPaneView] = useArenaPaneView(turn?.index);
  // Observes the review stores and the window; emits nothing into React state,
  // so the card renders exactly as it did without it.
  useArenaReviewTelemetry({
    serverId,
    agentId,
    turnId: turn?.id ?? "",
    focused: false,
    enabled: reviewAvailable && !turn?.resolution,
  });
  const { pendingAction } = actions;
  const respondingA = respondingIdsForRun(pendingAction, runA);
  const respondingB = respondingIdsForRun(pendingAction, runB);

  // Keep the panes on screen while the first turn is still arriving — swapping
  // them for a spinner here is what made them blink out just after the draft
  // handed over.
  //
  // Until the new turn arrives, keep the previous turn's runs out of the placeholders.
  if (!turn) {
    return (
      <>
        {startingPrompt ? (
          <BattleReadingColumn testID="arena-battle-prompt-column">
            <UserMessage
              message={startingPrompt.prompt}
              images={startingPrompt.images}
              timestamp={startingPrompt.submittedAt}
              isPending
            />
          </BattleReadingColumn>
        ) : null}
        <BattleCard testID="arena-battle-view">
          <BattlePanes
            key="battle-panes"
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            turnId=""
            runA={undefined}
            runB={undefined}
            turn={undefined}
            maxHeight={paneMaxHeight}
            respondingA={NOT_RESPONDING}
            respondingB={NOT_RESPONDING}
            onQuestionResponse={actions.replyQuestion}
            onPermissionResponse={actions.replyPermission}
            paneView={paneView}
            onPaneViewChange={setPaneView}
          />
          {arenaTransitionRowVisible(undefined, pendingStops) ? (
            <View style={styles.rootSection}>
              <ArenaTransitionRow transition={undefined} pendingProcessCount={pendingStops} />
            </View>
          ) : null}
        </BattleCard>
      </>
    );
  }

  return (
    <>
      <BattleReadingColumn testID="arena-battle-prompt-column">
        <UserMessage
          message={turn.prompt}
          images={promptImages}
          attachmentPills={promptAttachmentPills}
          timestamp={new Date(turn.createdAt).getTime()}
        />
      </BattleReadingColumn>
      <BattleCard testID="arena-battle-view">
        {actions.actionError ? (
          <View style={styles.rootSection} accessibilityRole="alert">
            <Alert variant="error" title="Battle action failed" description={actions.actionError} />
          </View>
        ) : null}
        <BattlePanes
          key="battle-panes"
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          turnId={turn.id}
          runA={runA}
          runB={runB}
          turn={turn}
          maxHeight={paneMaxHeight}
          respondingA={respondingA}
          respondingB={respondingB}
          onQuestionResponse={actions.replyQuestion}
          onPermissionResponse={actions.replyPermission}
          paneView={paneView}
          onPaneViewChange={setPaneView}
        />
        {snapshot.chat.blockedReason ? (
          <View style={styles.rootSection}>
            <Alert
              variant="warning"
              title="Trunk unavailable"
              description={snapshot.chat.blockedReason}
              testID="arena-environment-problem"
            />
          </View>
        ) : null}
        {arenaTransitionRowVisible(turn.transition, pendingStops) ? (
          <View style={styles.rootSection}>
            <ArenaTransitionRow transition={turn.transition} pendingProcessCount={pendingStops} />
          </View>
        ) : null}
        {reviewAvailable ? (
          <View style={styles.reviewSection}>
            <BattleJudging
              serverId={serverId}
              agentId={agentId}
              turnId={turn.id}
              comparison={snapshot.comparison}
              comparisonState={turn.comparisonState}
              retrying={pendingAction?.kind === "retry_comparison"}
              onRetry={actions.retryComparison}
            />
          </View>
        ) : null}
      </BattleCard>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The gap the stream's own row puts between a prompt and what answers it.
  preparingBattle: {
    gap: theme.spacing[3],
  },
  // One card for the whole battle. Everything inside shares its width; only the prompt above
  // and the composer below keep the chat's reading column. Sections inside separate with a
  // single top border, the way rows in a card do.
  root: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    alignSelf: "center",
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  rootBleed: {
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderRadius: 0,
  },
  panesNarrow: { flexDirection: "column" },
  panes: {
    flexDirection: "row",
    alignItems: "stretch",
    width: "100%",
    overflow: "hidden",
  },
  rootSection: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  // The review owns its own inset: its tab strip runs the card's width.
  reviewSection: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  battleReadingColumn: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  pane: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "50%",
    minWidth: 0,
    minHeight: 220,
  },
  paneStacked: { flexBasis: "auto" },
  paneStackedDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  latestOverlay: {
    position: "absolute",
    bottom: theme.spacing[2],
    right: theme.spacing[3],
    zIndex: 1,
  },
  latestButton: {
    width: 32,
    paddingHorizontal: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
  },
  paneBody: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 180,
    overflow: "hidden",
  },
  paneDivider: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  paneHidden: {
    display: "none",
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  paneHeading: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  paneHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  // The contestants are the headline of the card, so their names are the largest type on it.
  agentName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: ARENA_RUN_META_HEIGHT,
  },
  threadArea: {
    position: "relative",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 120,
  },
  runningThreadArea: {
    minHeight: 80,
  },
  threadScroll: {
    flex: 1,
  },
  threadContent: {
    flexGrow: 1,
    minHeight: 120,
  },
}));
