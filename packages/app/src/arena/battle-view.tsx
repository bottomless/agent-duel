import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ArrowDown } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ArenaHistoryItem,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { ARENA_MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { MessageOuterSpacingProvider, UserMessage } from "@/components/message";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ArenaRunThread } from "./run-thread";
import { ArenaRunTaskFooter } from "./task-progress-card";
import { openArenaWorktreeChanges } from "./explorer-selection";
import { ARENA_RUN_META_HEIGHT, ArenaRunMeta } from "./run-meta";
import {
  ArenaMessageAnchorProvider,
  ArenaPauseFollowProvider,
  ArenaRunTurnsMenu,
} from "./run-turns";
import type { ArenaTurnAction } from "./use-arena-session";
import { useArenaBattleActions } from "./use-battle-actions";
import { ArenaBattleOutcome } from "./battle-summary";
import { useArenaReviewTelemetry } from "./review-telemetry";
import { ArenaLiveReview } from "./battle-judging";
import { isStoppedByEarlyPick } from "./battle-result";
import type { ArenaPendingQuestion } from "./question";
import type { ArenaPendingPermission, ArenaPermissionReply } from "./permission";
import { Button } from "@/components/ui/button";
import { useContainerWidth } from "@/hooks/use-container-width";
import { Alert } from "@/components/ui/alert";
import { ArenaQueuedSteers } from "./queued-steers";
import { ArenaRunRetry } from "./run-retry";
import { ArenaTransitionRow, arenaTransitionRowVisible } from "./transition-row";
import { ArenaTransitionTimeline } from "./transition-timeline";
import { arenaResolutionStatus, arenaSetupStatus } from "./transition-progress";
import { useArenaCardBleed } from "./content-column";
import { ArenaPaneActions } from "./pane-actions";
import { BATTLE_GUTTER, BATTLE_RAIL } from "./battle-layout";
import { isArenaBattleOnScreen } from "./summary-anchor";
import { arenaPromptAttachmentPills } from "./prompt-attachment-pills";
import { arenaPromptImages } from "./prompt-images";
import type { StartingArenaBattle } from "./use-arena-session";

type ArenaPaneView = ArenaSide | "both";

// Keep both answers side by side until each pane would fall below roughly 30–35
// characters of readable content at the default interface size.
const STACKED_PANES_BREAKPOINT = 520;

// Room above a message the turns menu scrolls to, so it does not sit against the pane header.
const JUMP_TO_MESSAGE_INSET = 12;

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
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const threadScrollRef = useRef<ScrollView>(null);
  const autoScrollEnabledRef = useRef(true);
  const userScrollActiveRef = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const contentHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const threadAreaRef = useRef<View>(null);
  const messageAnchorsRef = useRef(new Map<string, View>());
  const registerMessageAnchor = useCallback((messageId: string, node: View | null) => {
    if (node) messageAnchorsRef.current.set(messageId, node);
    else messageAnchorsRef.current.delete(messageId);
  }, []);

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
  // Content or a pane that resizes while following is paused does not scroll, so no scroll event
  // says where the reader now is. Closing history again can leave them at the bottom.
  const resyncPausedFollow = useCallback(() => {
    if (autoScrollEnabledRef.current) return;
    const distanceFromBottom =
      contentHeightRef.current - viewportHeightRef.current - scrollOffsetRef.current;
    const atLatest = distanceFromBottom <= 24;
    autoScrollEnabledRef.current = atLatest;
    setAwayFromLatest(!atLatest);
  }, []);
  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      if (autoScrollEnabledRef.current) scrollToLatest();
      else resyncPausedFollow();
    },
    [resyncPausedFollow, scrollToLatest],
  );
  const pauseFollow = useCallback(() => {
    autoScrollEnabledRef.current = false;
  }, []);
  const handleThreadLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      resyncPausedFollow();
    },
    [resyncPausedFollow],
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
      scrollOffsetRef.current = contentOffset.y;
      viewportHeightRef.current = layoutMeasurement.height;
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
  // Scrolls the thread so the message sits just below its top, and stops following the latest
  // output. A null message is the turn's prompt, which shows above both panes rather than in the
  // thread, so the first turn starts at the top of the thread.
  const jumpToMessage = useCallback((messageId: string | null) => {
    const scrollTo = (y: number) => {
      autoScrollEnabledRef.current = false;
      setAwayFromLatest(true);
      threadScrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
    };
    if (messageId === null) {
      scrollTo(0);
      return;
    }
    const anchor = messageAnchorsRef.current.get(messageId);
    const threadArea = threadAreaRef.current;
    if (!anchor || !threadArea) return;
    threadArea.measureInWindow((_areaX, areaY) => {
      anchor.measureInWindow((_x, y) => {
        scrollTo(scrollOffsetRef.current + y - areaY - JUMP_TO_MESSAGE_INSET);
      });
    });
  }, []);
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
  // registered style (docs/unistyles.md, dynamic pixel styles on web). A settled run folds its
  // work above the answer, so its pane shrinks to fit: at the resting height the answer would
  // sit high in an empty pane, out of view when the chat follows the review below it.
  const settled = runIsFinal(run);
  const paneStyle = useMemo(
    () => [
      styles.pane,
      hidden && styles.paneHidden,
      stacked && styles.paneStacked,
      showDivider && (stacked ? styles.paneStackedDivider : styles.paneDivider),
      inlineUnistylesStyle(settled ? { maxHeight } : { height: maxHeight }),
    ],
    [hidden, maxHeight, settled, showDivider, stacked],
  );
  // The run exists from the moment its session is forked, which is before the worktrees are
  // ready and well before its prompt is dispatched. Treating that as started swaps the pane to
  // "Working" over a thread it has to guess at, and the only thing there to guess from is the
  // conversation it inherited. `startedAt` is written with the prompt boundary, so it means
  // dispatched rather than merely existing.
  const dispatched = run?.startedAt ? run : undefined;
  const queuedSteers = useMemo(
    () =>
      dispatched ? (
        <ArenaQueuedSteers run={dispatched} serverId={serverId} agentId={agentId} />
      ) : null,
    [dispatched, serverId, agentId],
  );
  const retry = useMemo(
    () =>
      dispatched ? <ArenaRunRetry run={dispatched} serverId={serverId} agentId={agentId} /> : null,
    [dispatched, serverId, agentId],
  );
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
        <View style={[styles.paneRule, side === "a" ? styles.paneRuleA : styles.paneRuleB]} />
        <View style={styles.paneHeaderRow}>
          <View style={styles.paneHeading}>
            <Text style={styles.agentName}>
              {t("arena.agent")} {side.toUpperCase()}
            </Text>
            {dispatched ? (
              <ArenaRunMeta
                run={dispatched}
                side={side}
                active={active}
                onOpenChanges={openChanges}
                showChangeSize={false}
              />
            ) : (
              <Text style={styles.status}>{t("arena.preparing")}</Text>
            )}
            {dispatched ? (
              <ArenaRunTurnsMenu run={dispatched} side={side} onJumpToMessage={jumpToMessage} />
            ) : null}
          </View>
          <ArenaPaneActions
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            turnId={turnId}
            side={side}
            run={run}
            expanded={expanded}
            onToggleExpanded={expanded ? handleRestore : handleExpand}
          />
        </View>
      </View>
      <View style={styles.paneBody} testID={`arena-pane-body-${side}`}>
        {/* The jump button anchors to the thread, not the pane body, so it stays clear of the task
            footer and services strip below the thread. */}
        <View
          ref={threadAreaRef}
          collapsable={false}
          style={[styles.threadArea, run?.runState === "pending" && styles.runningThreadArea]}
        >
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
            onLayout={handleThreadLayout}
            testID={`arena-thread-${side}`}
          >
            {dispatched ? (
              <ArenaMessageAnchorProvider value={registerMessageAnchor}>
                <ArenaPauseFollowProvider value={pauseFollow}>
                  <ArenaRunThread
                    run={dispatched}
                    stoppedByEarlyPick={stoppedByEarlyPick}
                    queuedSteers={queuedSteers}
                    retry={retry}
                    respondingQuestionId={respondingQuestionId}
                    respondingPermissionId={respondingPermissionId}
                    onQuestionResponse={handleQuestionResponse}
                    onPermissionResponse={handlePermissionResponse}
                  />
                </ArenaPauseFollowProvider>
              </ArenaMessageAnchorProvider>
            ) : null}
          </ScrollView>
          {awayFromLatest ? (
            <View style={styles.latestOverlay} pointerEvents="box-none">
              <Button
                size="sm"
                variant="outline"
                style={styles.latestButton}
                leftIcon={ArrowDown}
                accessibilityLabel={t("arena.latestAgent", { side: side.toUpperCase() })}
                onPress={jumpToLatest}
                testID={`arena-latest-${side}`}
              />
            </View>
          ) : null}
        </View>
        {run?.runState === "pending" ? (
          <ArenaRunTaskFooter run={run} paneMaxHeight={maxHeight} />
        ) : null}
      </View>
    </View>
  );
}

function runIsFinal(run: ArenaRun | undefined): boolean {
  return run !== undefined && run.runState !== "pending";
}

function runsAreFinal(runA: ArenaRun | undefined, runB: ArenaRun | undefined): boolean {
  return Boolean(runA && runB && runA.runState !== "pending" && runB.runState !== "pending");
}

function runHasSettled(runA: ArenaRun | undefined, runB: ArenaRun | undefined): boolean {
  return (
    (runA !== undefined && runA.runState !== "pending") ||
    (runB !== undefined && runB.runState !== "pending")
  );
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

/** Keep both contestant panes mounted while the reader switches between them. */
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

/** Setup occupies the stream before contestant panes are ready to appear. */
function ArenaPreparingBattleView({
  prompt,
  timestamp,
  testID,
}: {
  prompt: string;
  timestamp: number;
  testID: string;
}) {
  return (
    <MessageOuterSpacingProvider disableOuterSpacing>
      <View style={styles.preparingBattle} testID={testID}>
        <BattleReadingColumn testID="arena-battle-prompt-column">
          <UserMessage message={prompt} timestamp={timestamp} isPending />
        </BattleReadingColumn>
        <BattleReadingColumn>
          <ArenaTransitionTimeline phase="setup" />
        </BattleReadingColumn>
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
  ruled = false,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  /** Keeps the submitted prompt visible until its turn arrives. */
  startingPrompt?: StartingArenaBattle;
  /** The chat has turns above, so the battle starts a new one under a rule, as the chat's do. */
  ruled?: boolean;
}) {
  const { t } = useTranslation();
  // Only the battle this view owns. A ready chat still carries the last resolved turn; while
  // the next battle is starting, rendering that turn would bring the previous battle back.
  const turn = isArenaBattleOnScreen(snapshot) ? snapshot.turn : undefined;
  const actions = useArenaBattleActions(serverId, agentId, turn);
  const paneMaxHeight = useArenaPaneMaxHeight();
  const runA = snapshot.runs.find((run) => run.side === "a");
  const runB = snapshot.runs.find((run) => run.side === "b");
  const promptImages = useMemo(
    () => arenaPromptImages(snapshot.runs, { serverId, agentId }),
    [snapshot.runs, serverId, agentId],
  );
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
  const [paneView, setPaneView] = useArenaPaneView(turn?.index);
  const bothFinal = runsAreFinal(runA, runB);
  // Observes the review stores and the window; emits nothing into React state,
  // so the card renders exactly as it did without it. It starts with the first
  // result, while the early pick is on offer, and stays on until the vote: the
  // turn passes through `finalizing` between the two, and a gap there would
  // split one review into two timelines.
  useArenaReviewTelemetry({
    serverId,
    agentId,
    turnId: turn?.id ?? "",
    focused: false,
    settled: bothFinal,
    enabled:
      runHasSettled(runA, runB) &&
      turn !== undefined &&
      arenaSetupStatus(turn) === null &&
      !turn.resolution,
  });
  const { pendingAction } = actions;
  const respondingA = respondingIdsForRun(pendingAction, runA);
  const respondingB = respondingIdsForRun(pendingAction, runB);

  // Keep the previous turn's runs out of the next battle's setup.
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
        <BattleReadingColumn>
          <ArenaTransitionTimeline phase="setup" />
        </BattleReadingColumn>
      </>
    );
  }

  const settingUp = arenaSetupStatus(turn) !== null;
  const resolving = arenaResolutionStatus(turn) !== null;
  return (
    <>
      <View style={styles.prompt} testID="arena-battle-prompt-column">
        <View style={ruled ? styles.promptRule : undefined}>
          <MessageOuterSpacingProvider disableOuterSpacing>
            <UserMessage
              message={turn.prompt}
              images={promptImages}
              attachmentPills={promptAttachmentPills}
              timestamp={new Date(turn.createdAt).getTime()}
              variant="headline"
              withoutTrailingRow
            />
          </MessageOuterSpacingProvider>
        </View>
      </View>
      {settingUp ? (
        <BattleReadingColumn>
          <ArenaTransitionTimeline phase="setup" turn={turn} />
        </BattleReadingColumn>
      ) : null}
      {!settingUp ? (
        <BattleCard testID="arena-battle-view">
          {actions.actionError ? (
            <View style={styles.rootSection} accessibilityRole="alert">
              <Alert
                variant="error"
                title={t("arena.actionFailed")}
                description={actions.actionError}
              />
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
                title={t("arena.trunkUnavailable")}
                description={snapshot.chat.blockedReason}
                testID="arena-environment-problem"
              />
            </View>
          ) : null}
          {arenaTransitionRowVisible(turn.transition) ? (
            <View style={styles.rootSection}>
              <ArenaTransitionRow transition={turn.transition} />
            </View>
          ) : null}
          <View style={styles.reviewSection}>
            <ArenaLiveReview
              serverId={serverId}
              agentId={agentId}
              snapshot={snapshot}
              actions={actions}
            />
          </View>
          <View accessible accessibilityLiveRegion="polite">
            {turn.resolution ? (
              <View style={styles.reviewSection}>
                <ArenaBattleOutcome item={turn} />
              </View>
            ) : null}
          </View>
        </BattleCard>
      ) : null}
      {resolving ? (
        <BattleReadingColumn>
          <ArenaTransitionTimeline phase="resolution" turn={turn} />
        </BattleReadingColumn>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The gap the stream's own row puts between a prompt and what answers it.
  preparingBattle: {
    gap: theme.spacing[3],
  },
  // The whole battle, on one pair of rails: no frame, the answers side by side, the review
  // rising from below them.
  root: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    alignSelf: "center",
  },
  rootBleed: {},
  prompt: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: BATTLE_RAIL,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[6],
  },
  // The rule the chat draws above each turn's prompt (`ArenaRow`).
  promptRule: {
    paddingTop: theme.spacing[8],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  panesNarrow: { flexDirection: "column", rowGap: theme.spacing[6] },
  // Each pane keeps the thread's own 12px inset, so the rails sit that much inside the panes.
  panes: {
    flexDirection: "row",
    alignItems: "stretch",
    width: "100%",
    overflow: "hidden",
    paddingHorizontal: BATTLE_RAIL - theme.spacing[3],
    columnGap: BATTLE_GUTTER - 2 * theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  rootSection: {
    paddingHorizontal: BATTLE_RAIL,
    paddingVertical: theme.spacing[3],
  },
  // The review draws its own edge, on the answers' text edge.
  reviewSection: {
    paddingHorizontal: BATTLE_RAIL,
  },
  battleReadingColumn: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
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
  paneStackedDivider: {},
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
  paneDivider: {},
  paneHidden: {
    display: "none",
  },
  paneHeader: {
    paddingHorizontal: theme.spacing[3],
  },
  // A rule in the side's colour heads each answer, the colour of its Choose button below.
  paneRule: {
    height: 2,
  },
  paneRuleA: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  paneRuleB: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  paneHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    marginTop: theme.spacing[4],
  },
  paneHeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: theme.spacing[2] + theme.spacing[0.5],
  },
  // The contestants are the headline of the battle, so their names are the largest type in it.
  agentName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: -0.4,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
