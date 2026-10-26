import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  SINGLE_AGENT_MODELS,
  singleAgentControlsLocked,
  singleAgentRatingOptional,
  singleAgentRatingRequired,
} from "@/arena/single-agent";
import { SingleAgentRatingDialog, SingleAgentComposerTooltip } from "@/arena/single-agent-rating";
import { usePendingArenaPrompt } from "@/arena/use-pending-arena-prompt";
import { ArenaStreamStatus } from "@/arena/stream-status";
import { ArenaPartSourceContext } from "@/arena/full-tool-part";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TFunction } from "i18next";
import { SquarePen } from "lucide-react-native";
import React, {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { shallow, useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { ComposerDock } from "@/composer/dock";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { ChatFeedbackCard } from "@/feedback/chat-feedback-card";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { RetainedChatContent } from "./retained-chat-content";
import { Composer } from "@/composer";
import {
  dispatchComposerAgentMessage,
  editQueuedComposerMessage,
  sendQueuedComposerMessageNow,
} from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { encodeImages } from "@/utils/encode-images";
import {
  useComposerEditingSession,
  useComposerFullscreen,
  type ComposerEditingSession,
} from "@/composer/editing-session";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import {
  resolveComposerTrackControlClearance,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import { RewindComposerRestoreProvider } from "@/components/rewind/composer-restore";
import { useAgentDescriptor } from "@/agent-presentation";
import { useToastHost, type ToastApi, type ToastState } from "@/components/toast-host";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { WorkspaceFilesRecoveryBanner } from "@/screens/workspace/workspace-route-state-views";
import { useWorkspaceRecovery } from "@/workspace-recovery/use-workspace-recovery";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAgentAttentionClear } from "@/hooks/use-agent-attention-clear";
import { useAgentInputDraft, type AgentInputDraft } from "@/composer/draft/input-draft";
import {
  type AgentScreenAgent,
  type AgentScreenContinuity,
  type AgentScreenMissingState,
  type AgentScreenViewState,
  useAgentScreenStateMachine,
  type AgentScreenReadySyncState,
} from "@/hooks/use-agent-screen-state-machine";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { selectForkBoundaryItemIdForAgent } from "@/hooks/fork-preview";
import { reconcileMissingAgentStateWithPresentAgent } from "@/panels/agent-panel-load-state";
import { TimelineSyncStatus } from "@/timeline/sync-status";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { PaneSubtitle } from "@/panels/pane-subtitle";
import { definePanel } from "@/panels/panel-registry";
import { RenderProfile } from "@/utils/render-profiler";
import { useHasPluginComposerPills } from "@/plugins";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
  useHostRuntimeLastError,
  useHosts,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import {
  deriveRouteBottomAnchorIntent,
  deriveRouteBottomAnchorRequest,
} from "@/screens/agent/agent-ready-screen-bottom-anchor";
import { ordinaryTaskListState, tasksAfterBattle } from "@/composer/task-list/tasks";
import { WorkspaceDraftAgentTab } from "@/composer/draft/workspace-tab";
import { AgentTracks, hasAgentTracks } from "@/panels/agent-tracks";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import {
  selectAgentTimelineState,
  selectAgentTurnPresentation,
  type Agent,
  useSessionStore,
} from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { Theme } from "@/styles/theme";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem, TodoEntry } from "@/types/stream";
import type { ViewedTimelineStatus, ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import { useArchiveFinishedSubagents, useSubagentsForParent } from "@/subagents";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { buildDraftAgentSetup, type ClientSlashCommand } from "@/client-slash-commands";
import { ArenaBattleView, ArenaQueuedBattleView } from "@/arena/battle-view";
import {
  activeTrunkConflicts,
  arenaParkedPromotion,
  conflictResolvePrompt,
  resolveConflictGuard,
  resolveBattlePause,
} from "@/arena/conflict-guard";
import { clearArenaBattleHandoff, useArenaBattleHandoff } from "@/arena/battle-handoff";
import { useReviewAnswer } from "@/arena/use-review-answer";
import { retainArenaPromptImages } from "@/arena/prompt-attachments";
import {
  clearPendingBattlePrompt,
  readPendingBattleAttachments,
  usePendingBattlePrompt,
} from "@/arena/pending-battle";
import {
  arenaComposerMaxImages,
  deriveArenaComposerQueueState,
  resolveArenaComposerSubmit,
} from "@/arena/composer-state";
import { ArenaDecisionBar } from "@/arena/decision-bar";
import { arenaSetupStatus } from "@/arena/transition-progress";
import { ArenaDecisionPill } from "@/arena/decision-pill";
import { useArenaBattleActions } from "@/arena/use-battle-actions";
import { showsArenaDecisionBar } from "@/arena/decision-state";
import { ArenaBattleSummary } from "@/arena/battle-summary";
import { ArenaChatCallouts, hasArenaChatCallouts } from "@/arena/readiness-strip";
import {
  ARENA_CONFLICT_RESOLUTION_PROMPT,
  arenaConflictResolutionTurnID,
  arenaSteeringQueuedMessage,
  canDrainArenaFollowUp,
  deriveArenaReplyState,
  type ArenaReplyAction,
} from "@/arena/reply-state";
import { useArenaReplyComposerControls } from "@/arena/reply-target-control";
import {
  arenaChatCanStartBattle,
  arenaSummaryAnchors,
  arenaTurnFollowedUp,
  isArenaBattleOnScreen,
  partitionArenaSummaries,
} from "@/arena/summary-anchor";
import { arenaAgentPreferenceKey } from "@/arena/constants";
import { applyArenaPreferencePatch, useArenaPreferences } from "@/arena/preferences";
import {
  useArenaSessionQuery,
  useArenaStartMutation,
  useArenaStatusError,
  useArenaTurnMutation,
  useStartingArenaBattle,
} from "@/arena/use-arena-session";
import type { MessagePayload } from "@/composer/types";
import { useToast } from "@/contexts/toast-context";
import { getForkSourceAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { openWorkspaceSidePanelTab } from "@/workspace/side-panel-command";

interface ChatAgentStateShape {
  serverId: string | null;
  id: string | null;
  title?: Agent["title"];
  provider?: Agent["provider"];
  status: Agent["status"] | null;
  cwd: string | null;
  workspaceId?: string;
  capabilities?: Agent["capabilities"];
  currentModeId?: Agent["currentModeId"];
  model?: Agent["model"];
  thinkingOptionId?: Agent["thinkingOptionId"];
  runtimeInfo?: Agent["runtimeInfo"];
  features?: Agent["features"];
  lastError?: Agent["lastError"] | null;
}

/** The placeholder names who the message goes to and what sending does. */
function arenaReplyPlaceholder(action: ArenaReplyAction | undefined, awaitingVote: boolean) {
  if (!action) return "Choose who to message";
  const who =
    action.target === "both" ? "both contestants" : `Agent ${action.target.toUpperCase()}`;
  if (action.label.startsWith("Steer")) return `Steer ${who}`;
  if (awaitingVote) {
    return action.target === "both"
      ? "Ask both a follow-up before choosing"
      : `Ask ${who} a follow-up before choosing`;
  }
  return `Message ${who}`;
}

function arenaReplyComposerPresentation({
  enabled,
  awaitingVote,
  reviewOpen,
  replyComposer,
  fallbackSubmit,
}: {
  enabled: boolean;
  /** A review waits on the callout's answers; the input is for anything else the user wants. */
  reviewOpen: boolean;
  awaitingVote: boolean;
  replyComposer: ReturnType<typeof useArenaReplyComposerControls>;
  fallbackSubmit: ((payload: MessagePayload) => Promise<void>) | undefined;
}) {
  if (!enabled) {
    return {
      onSubmitMessage: fallbackSubmit,
      submitButtonAccessibilityLabel: undefined,
      submitButtonTestID: undefined,
      submitLabel: undefined,
      placeholder: reviewOpen ? "Type your own instructions for the agent" : undefined,
    };
  }
  let submitLabel = "Send";
  if (replyComposer.selectedAction?.label.startsWith("Steer")) submitLabel = "Steer";
  else if (awaitingVote) submitLabel = "Send follow-up";
  return {
    onSubmitMessage: replyComposer.submit,
    submitButtonAccessibilityLabel:
      replyComposer.selectedAction?.label ?? "Choose a contestant before sending",
    submitButtonTestID: "arena-reply-send",
    submitLabel,
    placeholder: arenaReplyPlaceholder(replyComposer.selectedAction, awaitingVote),
  };
}

interface ChatAgentSelectedState extends ChatAgentStateShape {
  archivedAt: Date | null;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"] | null;
}

function resolveChatAgentFromSession(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): Agent | null {
  if (!agentId) return null;
  const session = state.sessions[serverId];
  return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null;
}

function readViewedTimelineError(input: {
  agentId: string | undefined;
  status: ViewedTimelineStatus;
  sync: ViewedTimelineUiBridge | null;
}): string | null {
  if (!input.agentId || input.status !== "error" || !input.sync) return null;
  return input.sync.getAgentTimelineError(input.agentId);
}

const EMPTY_CHAT_AGENT_STATE: ChatAgentSelectedState = {
  serverId: null,
  id: null,
  status: null,
  cwd: null,
  lastError: null,
  archivedAt: null,
  requiresAttention: false,
  attentionReason: null,
};

function selectChatAgentState(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): ChatAgentSelectedState {
  const agent = resolveChatAgentFromSession(state, serverId, agentId);
  if (!agent) return EMPTY_CHAT_AGENT_STATE;
  return {
    serverId: agent.serverId,
    id: agent.id,
    title: agent.title,
    provider: agent.provider,
    status: agent.status,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    runtimeInfo: agent.runtimeInfo,
    features: agent.features,
    lastError: agent.lastError ?? null,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
  };
}

function buildChatAgentFromState(
  state: ChatAgentStateShape,
  projectPlacement: Agent["projectPlacement"] | null,
): AgentScreenAgent | null {
  if (!state.serverId || !state.id || !state.status || !state.cwd) {
    return null;
  }
  return {
    serverId: state.serverId,
    id: state.id,
    title: state.title,
    provider: state.provider,
    status: state.status,
    cwd: state.cwd,
    workspaceId: state.workspaceId,
    capabilities: state.capabilities,
    currentModeId: state.currentModeId,
    model: state.model,
    thinkingOptionId: state.thinkingOptionId,
    runtimeInfo: state.runtimeInfo,
    features: state.features,
    lastError: state.lastError ?? null,
    projectPlacement,
  };
}

function AgentLoadErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="agent-load-error">
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
        <Text style={styles.statusText}>{message}</Text>
        <View style={styles.errorAction}>
          <Button size="sm" variant="secondary" onPress={onRetry} testID="agent-load-error-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

function renderChatAgentNonReadyView(args: {
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
  onRetryLoad: () => void;
}): React.ReactElement | null {
  const { viewState, effectiveAgent, t, onRetryLoad } = args;
  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }
  if (viewState.tag === "error") {
    return <AgentLoadErrorView message={viewState.message} onRetry={onRetryLoad} />;
  }
  if (viewState.tag === "boot" || !effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }
  return null;
}

function shouldStoreFetchedAgentInActiveDirectory(agent: Agent): boolean {
  return !agent.archivedAt && Boolean(agent.projectPlacement);
}

type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

function storeFetchedAgentDetail(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const hydrated: Agent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: {
      ...normalized,
      projectPlacement: input.result.project,
    },
  });
  const store = useSessionStore.getState();

  if (shouldStoreFetchedAgentInActiveDirectory(hydrated)) {
    getHostRuntimeStore().acceptAgentSnapshot(input.serverId, hydrated);
  } else {
    store.setAgentDetails(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  }

  store.setPendingPermissions(input.serverId, (previous) => {
    const next = new Map(previous);
    for (const [key, pending] of next.entries()) {
      if (pending.agentId === hydrated.id) {
        next.delete(key);
      }
    }
    for (const request of hydrated.pendingPermissions) {
      const key = derivePendingPermissionKey(hydrated.id, request);
      next.set(key, { key, agentId: hydrated.id, request });
    }
    return next;
  });

  return hydrated;
}

function AgentPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "agent", "AgentPanel requires agent target");

  return (
    <RetainedChatContent>
      <AgentPanelContent
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={target.agentId}
        isPaneFocused={isInteractive}
        onOpenWorkspaceFile={openFileInWorkspace}
      />
    </RetainedChatContent>
  );
}

function DraftPanel() {
  const { serverId, workspaceId, tabId, target, openFileInWorkspace, retargetCurrentTab } =
    usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "draft", "DraftPanel requires draft target");

  const handleCreated = useCallback(
    (agentSnapshot: Parameters<typeof normalizeAgentSnapshot>[0]) => {
      const normalized = normalizeAgentSnapshot(agentSnapshot, serverId);
      const agent = applyLegacyDaemonWorkspaceOwnership({ serverId, agent: normalized });
      getHostRuntimeStore().acceptAgentSnapshot(serverId, agent);
      retargetCurrentTab({ kind: "agent", agentId: agentSnapshot.id });
    },
    [retargetCurrentTab, serverId],
  );

  return (
    <WorkspaceDraftAgentTab
      serverId={serverId}
      workspaceId={workspaceId}
      tabId={tabId}
      draftId={target.draftId}
      initialSetup={target.setup}
      isPaneFocused={isInteractive}
      onOpenWorkspaceFile={openFileInWorkspace}
      onCreated={handleCreated}
    />
  );
}

export function AgentConversationPanel() {
  const { target } = usePaneContext();
  if (target.kind === "draft") {
    return <DraftPanel />;
  }
  if (target.kind === "agent") {
    return <AgentPanel />;
  }
  invariant(false, "AgentConversationPanel requires an agent or draft target");
}

export const agentPanelRegistration = definePanel("agent", {
  component: AgentConversationPanel,
  useDescriptor: useAgentDescriptor,
});

export function useDraftPanelDescriptor(
  target: { kind: "draft"; draftId: string },
  context: { serverId: string },
) {
  const createDescriptorState = useCreateFlowStore(
    useShallow((state) => {
      const pending = state.pendingByDraftId[target.draftId];
      if (pending?.serverId !== context.serverId || pending.lifecycle !== "active") {
        return {
          isCreating: false,
          pendingPrompt: null,
        };
      }
      return {
        isCreating: true,
        pendingPrompt: pending.text,
      };
    }),
  );

  return buildDraftPanelDescriptor({
    ...createDescriptorState,
    icon: SquarePen,
  });
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_MESSAGE_SUBMISSIONS = [] as const;
const EMPTY_PENDING_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_PENDING_PERMISSION_LIST: PendingPermission[] = [];

type RouteBottomAnchorRequest = ReturnType<typeof deriveRouteBottomAnchorRequest>;

function findActiveCreateHandoff(input: {
  pendingByDraftId: ReturnType<typeof useCreateFlowStore.getState>["pendingByDraftId"];
  serverId: string;
  agentId?: string;
}): boolean {
  if (!input.agentId) {
    return false;
  }
  return Object.values(input.pendingByDraftId).some(
    (pending) =>
      pending.lifecycle === "sent" &&
      pending.serverId === input.serverId &&
      pending.agentId === input.agentId,
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

type AgentLookupState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "not_found"; message: string }
  | { tag: "error"; message: string };

function AgentPanelContent({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const resolvedAgentId = agentId.trim() || undefined;
  const resolvedServerId = serverId.trim() || undefined;
  const daemons = useHosts();
  const runtimeServerId = resolvedServerId ?? "";
  const runtimeClient = useHostRuntimeClient(runtimeServerId);
  const runtimeIsConnected = useHostRuntimeIsConnected(runtimeServerId);
  const runtimeConnectionStatus = useHostRuntimeConnectionStatus(runtimeServerId);
  const runtimeLastError = useHostRuntimeLastError(runtimeServerId);
  const hasCachedAgent = useSessionStore((state) => {
    if (!resolvedServerId || !resolvedAgentId) return false;
    const session = state.sessions[resolvedServerId];
    return Boolean(
      session?.agents.has(resolvedAgentId) || session?.agentDetails.has(resolvedAgentId),
    );
  });

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? (daemons.find((entry) => entry.serverId === connectionServerId) ?? null)
    : null;
  const serverLabel =
    daemon?.label ?? connectionServerId ?? t("agentPanel.unavailable.selectedHost");
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    isUnknownDaemon && runtimeConnectionStatus === "connecting"
      ? "offline"
      : runtimeConnectionStatus;
  const lastConnectionError = runtimeLastError;

  if (!resolvedServerId || (!runtimeClient && !hasCachedAgent)) {
    return (
      <AgentSessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
        t={t}
      />
    );
  }

  return (
    <AgentPanelBody
      serverId={resolvedServerId}
      workspaceId={workspaceId}
      agentId={resolvedAgentId}
      isPaneFocused={isPaneFocused}
      client={runtimeClient}
      isConnected={runtimeIsConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function AgentPanelBody({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const { isArchivingAgent: _isArchivingAgent } = useArchiveAgent();
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const [lookupState, setLookupState] = useState<AgentLookupState>({
    tag: "idle",
  });
  const lookupAttemptTokenRef = useRef(0);
  const retryAgentLookup = useCallback(() => setLookupState({ tag: "idle" }), []);

  useEffect(() => {
    lookupAttemptTokenRef.current += 1;
    setLookupState({ tag: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.id) {
      if (lookupState.tag !== "idle") {
        setLookupState({ tag: "idle" });
      }
      return;
    }
    if (!client || !isConnected || !hasSession) {
      return;
    }
    if (lookupState.tag === "loading" || lookupState.tag === "not_found") {
      return;
    }

    setLookupState({ tag: "loading" });
    const attemptToken = ++lookupAttemptTokenRef.current;

    client
      .fetchAgent({ agentId })
      .then((result) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        if (!result) {
          setLookupState({
            tag: "not_found",
            message: `Agent not found: ${agentId}`,
          });
          return;
        }

        storeFetchedAgentDetail({ serverId, result });
        setLookupState({ tag: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setLookupState({ tag: "not_found", message });
          return;
        }
        setLookupState({ tag: "error", message });
      });
  }, [agentId, agentState.id, client, hasSession, isConnected, lookupState.tag, serverId]);

  if (lookupState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }

  if (lookupState.tag === "error") {
    return <AgentLoadErrorView message={lookupState.message} onRetry={retryAgentLookup} />;
  }

  const agent: AgentScreenAgent | null =
    agentState.serverId && agentState.id && agentState.status && agentState.cwd
      ? {
          serverId: agentState.serverId,
          id: agentState.id,
          title: agentState.title,
          provider: agentState.provider,
          status: agentState.status,
          cwd: agentState.cwd,
          workspaceId: agentState.workspaceId,
          capabilities: agentState.capabilities,
          currentModeId: agentState.currentModeId,
          model: agentState.model,
          thinkingOptionId: agentState.thinkingOptionId,
          runtimeInfo: agentState.runtimeInfo,
          features: agentState.features,
          lastError: agentState.lastError ?? null,
          projectPlacement,
        }
      : null;

  if (!agent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }

  return (
    <ChatAgentContent
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      isPaneFocused={isPaneFocused}
      client={client}
      isConnected={isConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function ChatAgentContent({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const isPaneVisible = useRetainedPanelActive();
  const { api: toastApi, toast: toastState, dismiss: dismissToast } = useToastHost();
  const { isArchivingAgent } = useArchiveAgent();
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const clearOnAgentBlurRef = useRef<() => void>(() => {});
  const wasPaneFocusedRef = useRef(isPaneFocused);
  const initAttemptTokenRef = useRef(0);
  const routeBottomAnchorRequestRef = useRef<{
    routeKey: string;
    reason: "initial-entry" | "resume";
  } | null>(null);
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const isInitializingFromMap = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.initializingAgents?.get(agentId) ?? false) : false,
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0,
  );
  const replicaTimelineStatus = useSessionStore((state) =>
    agentId
      ? selectAgentTimelineState(state.sessions[serverId], agentId).status
      : ("cold" as const),
  );
  const hasAppliedAuthoritativeHistory = replicaTimelineStatus === "synced";
  const agentHistorySyncGeneration = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.agentHistorySyncGeneration?.get(agentId) ?? -1) : -1,
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const subscribeToVisibilityCatchUp = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTimelineStatus = useCallback(
    () =>
      !agentId || !viewedTimelineSync
        ? ("ready" as const)
        : viewedTimelineSync.getAgentTimelineStatus(agentId),
    [agentId, viewedTimelineSync],
  );
  const timelineStatus = useSyncExternalStore(
    subscribeToVisibilityCatchUp,
    readTimelineStatus,
    readTimelineStatus,
  );
  const visibilityCatchUpStatus = isPaneVisible ? timelineStatus : "ready";
  const visibilityCatchUpError = readViewedTimelineError({
    agentId,
    status: visibilityCatchUpStatus,
    sync: viewedTimelineSync,
  });
  const hasActiveCreateHandoff = useCreateFlowStore((state) =>
    findActiveCreateHandoff({
      pendingByDraftId: state.pendingByDraftId,
      serverId,
      agentId,
    }),
  );
  const hasSeededBattle = useArenaBattleHandoff(serverId, agentId);
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });

  const hasHydratedHistoryBefore =
    hasAppliedAuthoritativeHistory || replicaTimelineStatus === "painted";

  const attentionController = useAgentAttentionClear({
    agentId,
    client,
    isConnected,
    requiresAttention: agentState.requiresAttention,
    attentionReason: agentState.attentionReason,
    isScreenFocused: isPaneFocused,
  });
  useEffect(() => {
    clearOnAgentBlurRef.current = attentionController.clearOnAgentBlur;
  }, [attentionController.clearOnAgentBlur]);

  const isArchivingCurrentAgent = Boolean(agentId && isArchivingAgent({ serverId, agentId }));

  useEffect(() => {
    if (wasPaneFocusedRef.current && !isPaneFocused) {
      clearOnAgentBlurRef.current();
    }
    wasPaneFocusedRef.current = isPaneFocused;
  }, [isPaneFocused]);

  useEffect(() => {
    return () => {
      if (wasPaneFocusedRef.current) {
        clearOnAgentBlurRef.current();
      }
    };
  }, []);

  const isInitializing = agentId ? isInitializingFromMap : false;
  const isHistorySyncing = useMemo(() => {
    if (!agentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, agentId);
    return Boolean(getInitDeferred(initKey));
  }, [agentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!agentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, agentId, historySyncGeneration]);

  const agent = useMemo<AgentScreenAgent | null>(
    () => buildChatAgentFromState(agentState, projectPlacement),
    [agentState, projectPlacement],
  );
  const continuity = useMemo<AgentScreenContinuity>(() => {
    if (!agentId) {
      return { kind: "none" };
    }
    if (hasActiveCreateHandoff) {
      return {
        kind: "optimistic-create",
        agent: {
          serverId,
          id: agentId,
          status: "running",
          cwd: agent?.cwd ?? ".",
          projectPlacement: agent?.projectPlacement ?? null,
        },
      };
    }
    if (hasSeededBattle) {
      return { kind: "seeded-battle" };
    }
    return { kind: "none" };
  }, [agent, agentId, hasActiveCreateHandoff, hasSeededBattle, serverId]);
  useEffect(() => {
    if (!agentId || !hasSeededBattle || !hasHydratedHistoryBefore) {
      return;
    }
    clearArenaBattleHandoff({ serverId, agentId });
  }, [agentId, hasHydratedHistoryBefore, hasSeededBattle, serverId]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${agentId ?? ""}`,
    input: {
      agent: agent ?? null,
      isArchived: agentState.archivedAt !== null,
      missingAgentState,
      isConnected,
      isArchivingCurrentAgent,
      isHistorySyncing,
      needsAuthoritativeSync,
      visibilityCatchUpStatus,
      visibilityCatchUpError,
      continuity,
      hasHydratedHistoryBefore,
    },
  });

  const effectiveAgent = viewState.tag === "ready" ? viewState.agent : null;
  const routeEntryKey = agentId ? `${serverId}:${agentId}` : null;
  routeBottomAnchorRequestRef.current = deriveRouteBottomAnchorIntent({
    cachedIntent: routeBottomAnchorRequestRef.current,
    routeKey: routeEntryKey,
    hasAppliedAuthoritativeHistoryAtEntry: hasAppliedAuthoritativeHistory,
  });
  const routeBottomAnchorRequest = useMemo(
    () =>
      deriveRouteBottomAnchorRequest({
        intent: routeBottomAnchorRequestRef.current,
        effectiveAgentId: effectiveAgent?.id ?? null,
      }),
    [effectiveAgent?.id],
  );

  const handleComposerHeightChange = useCallback(
    (_height: number) => {
      if (!agentId) {
        return;
      }
      streamViewRef.current?.prepareForViewportChange();
    },
    [agentId],
  );

  const handleMessageSent = useCallback(() => {
    if (!agentId) {
      return;
    }
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [agentId]);

  const handleRewindComplete = useCallback(() => {
    streamViewRef.current?.scrollToBottom("rewind");
  }, []);

  const retryAgentLoad = useCallback(() => {
    setMissingAgentState({ kind: "idle" });
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  const retryTimelineSync = useCallback(() => {
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  useEffect(() => {
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.archivedAt) {
      return;
    }
    if (agentState.id && hasAppliedAuthoritativeHistory) {
      if (
        missingAgentState.kind === "resolving" ||
        missingAgentState.kind === "not_found" ||
        missingAgentState.kind === "error"
      ) {
        setMissingAgentState(reconcileMissingAgentStateWithPresentAgent);
      }
      return;
    }
    if (
      !client ||
      !viewedTimelineSync ||
      !isPaneVisible ||
      !isConnected ||
      !hasSession ||
      visibilityCatchUpStatus !== "ready"
    ) {
      return;
    }
    if (
      missingAgentState.kind === "resolving" ||
      missingAgentState.kind === "not_found" ||
      missingAgentState.kind === "error"
    ) {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    Promise.resolve()
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentSession = useSessionStore.getState().sessions[serverId];
        const currentAgent =
          currentSession?.agents.get(agentId) ?? currentSession?.agentDetails.get(agentId);
        if (!currentAgent) {
          const result = await client.fetchAgent({ agentId });
          if (attemptToken !== initAttemptTokenRef.current) {
            return;
          }
          if (!result) {
            setMissingAgentState({
              kind: "not_found",
              message: `Agent not found: ${agentId}`,
            });
            return;
          }
          storeFetchedAgentDetail({ serverId, result });
        }
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setMissingAgentState({ kind: "not_found", message });
          return;
        }
        setMissingAgentState({ kind: "error", message });
      });
  }, [
    agentState.id,
    agentState.archivedAt,
    hasAppliedAuthoritativeHistory,
    agentId,
    client,
    hasSession,
    isConnected,
    isPaneVisible,
    missingAgentState.kind,
    serverId,
    viewedTimelineSync,
    visibilityCatchUpStatus,
  ]);

  const nonReadyView = renderChatAgentNonReadyView({
    viewState,
    effectiveAgent,
    t,
    onRetryLoad: retryAgentLoad,
  });
  if (nonReadyView) return nonReadyView;
  invariant(agentId, "agent id is defined when agent content is ready");
  invariant(effectiveAgent, "effectiveAgent is defined when the non-ready view is absent");
  const agentCwd = agentState.cwd;
  invariant(agentCwd, "agent cwd is defined when agent content is ready");
  const showHistorySyncOverlay =
    viewState.tag === "ready" &&
    viewState.sync.status === "catching_up" &&
    viewState.sync.ui === "overlay";
  const showHistorySyncError = viewState.tag === "ready" && viewState.sync.status === "sync_error";
  const isRetryingHistorySync =
    viewState.tag === "ready" &&
    viewState.sync.status === "sync_error" &&
    viewState.sync.isRetrying;

  return (
    <ChatAgentReadyContent
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      isPaneFocused={isPaneFocused}
      isPaneVisible={isPaneVisible}
      isArchivingCurrentAgent={isArchivingCurrentAgent}
      agentState={agentState}
      effectiveAgent={effectiveAgent}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
      toastApi={toastApi}
      toast={toastState}
      dismiss={dismissToast}
      streamViewRef={streamViewRef}
      handleComposerHeightChange={handleComposerHeightChange}
      handleMessageSent={handleMessageSent}
      handleRewindComplete={handleRewindComplete}
      timelineSync={isPaneVisible && viewState.tag === "ready" ? viewState.sync : null}
      showHistorySyncOverlay={showHistorySyncOverlay}
      showHistorySyncError={showHistorySyncError}
      isRetryingHistorySync={isRetryingHistorySync}
      cwd={agentCwd}
      retryTimelineSync={retryTimelineSync}
      onAttentionInputFocus={attentionController.clearOnInputFocus}
      onAttentionPromptSend={attentionController.clearOnPromptSend}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

const ChatAgentReadyContent = memo(function ChatAgentReadyContent({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused,
  isPaneVisible,
  isArchivingCurrentAgent,
  agentState,
  effectiveAgent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  toastApi,
  toast,
  dismiss,
  streamViewRef,
  handleComposerHeightChange,
  handleMessageSent,
  handleRewindComplete,
  timelineSync,
  showHistorySyncOverlay,
  showHistorySyncError,
  isRetryingHistorySync,
  retryTimelineSync,
  cwd,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  isPaneFocused: boolean;
  isPaneVisible: boolean;
  isArchivingCurrentAgent: boolean;
  agentState: ChatAgentSelectedState;
  effectiveAgent: AgentScreenAgent;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  toastApi: ToastApi;
  toast: ToastState | null;
  dismiss: () => void;
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  handleComposerHeightChange: (height: number) => void;
  handleMessageSent: () => void;
  handleRewindComplete: () => void;
  timelineSync: AgentScreenReadySyncState | null;
  showHistorySyncOverlay: boolean;
  showHistorySyncError: boolean;
  isRetryingHistorySync: boolean;
  retryTimelineSync: () => void;
  cwd: string;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const workspaceFilesUnavailable =
    useWorkspaceFields(
      serverId,
      workspaceId,
      (workspace) => workspace.filesState !== undefined && workspace.filesState !== "available",
    ) ?? false;
  const [decisionPillHeight, setDecisionPillHeight] = useState(0);
  // The workspace sheet is for looking; Open as tab brings the agent back with its composer.
  const showsComposer = usePaneContext().host !== "sheet";
  // The dock lays out fullscreen for the same session the composer edits in.
  const composerEditingSession = useComposerEditingSession("chat");
  const isComposerFullscreen = useComposerFullscreen(composerEditingSession);
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const tasks = useChatTasks({ serverId, agentId });
  const archiveFinishedSubagents = useArchiveFinishedSubagents({
    serverId,
    parentAgentId: agentId,
    rows: subagentRows,
  });
  const hasPluginComposerPills = useHasPluginComposerPills(serverId, workspaceId, agentId);
  const hasActiveComposer = !agentState.archivedAt && !isArchivingCurrentAgent;
  const hasVisibleAgentTracks = hasAgentTracks({
    subagentRows,
    tasks,
    archiveFinishedStatus: archiveFinishedSubagents.status,
    hasPluginComposerPills,
  });
  const rawAgentInputDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId,
    }),
  });
  // Stabilize the agentInputDraft object identity so that memo(AgentComposerSection) can bail out
  // when only toast state changes (which does not affect any draft field).
  const {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  } = rawAgentInputDraft;
  const agentInputDraft = useMemo(
    (): AgentInputDraft => ({
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    }),
    [
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    ],
  );
  const composerSection =
    showsComposer && !workspaceFilesUnavailable ? (
      <RenderProfile id={`AgentComposerSection:${agentId}`}>
        <AgentComposerSection
          agentId={agentId}
          serverId={serverId}
          isPaneFocused={isPaneFocused}
          isArchivingCurrentAgent={isArchivingCurrentAgent}
          archivedAt={agentState.archivedAt}
          cwd={cwd}
          isSubmitLoading={false}
          agentInputDraft={agentInputDraft}
          editingSession={composerEditingSession}
          onAttentionInputFocus={onAttentionInputFocus}
          onAttentionPromptSend={onAttentionPromptSend}
          onComposerHeightChange={handleComposerHeightChange}
          onDecisionPillHeightChange={setDecisionPillHeight}
          onMessageSent={handleMessageSent}
        />
      </RenderProfile>
    ) : null;
  const streamContent = (
    <View style={animatedStaticStyles.content}>
      {showsComposer ? null : <SheetAgentFacts serverId={serverId} agentId={agentId} />}
      <RenderProfile id={`AgentStreamSection:${agentId}`}>
        <AgentStreamSection
          streamViewRef={streamViewRef}
          bottomOverlayHeight={decisionPillHeight}
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          agent={effectiveAgent}
          routeBottomAnchorRequest={routeBottomAnchorRequest}
          hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
          feedbackPromptEligible={isPaneVisible && isPaneFocused}
          hasActiveComposer={hasActiveComposer}
          hasVisibleAgentTracks={hasVisibleAgentTracks}
          toast={toastApi}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </RenderProfile>
      {hasActiveComposer ? (
        <AgentTracks
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          subagentRows={subagentRows}
          tasks={tasks}
          archiveFinishedStatus={archiveFinishedSubagents.status}
          onArchiveFinished={archiveFinishedSubagents.archiveFinished}
          hasPluginComposerPills={hasPluginComposerPills}
        />
      ) : null}
    </View>
  );

  const dockContent = (
    <View style={styles.contentContainer}>
      {streamContent}

      {showHistorySyncError ? (
        <TimelineSyncErrorCallout isRetrying={isRetryingHistorySync} onRetry={retryTimelineSync} />
      ) : null}
    </View>
  );

  const dockOverlay = (
    <>
      {showHistorySyncOverlay ? (
        <View style={styles.historySyncOverlay} testID="agent-history-overlay">
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      ) : null}

      <TimelineSyncStatus sync={timelineSync} toast={toast} onDismiss={dismiss} />
    </>
  );

  const dock = (
    <ChatSurface disabled={isArchivingCurrentAgent} fullscreen={isComposerFullscreen}>
      {dockContent}
      {composerSection}
      {dockOverlay}
    </ChatSurface>
  );

  return (
    <RewindComposerRestoreProvider
      textSource={agentInputDraft.textSource}
      setText={agentInputDraft.replaceText}
      onRewindComplete={handleRewindComplete}
    >
      <View style={styles.root}>
        {dock}

        {isArchivingCurrentAgent ? (
          <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
            <ThemedLoadingSpinner size="large" uniProps={foregroundColorMapping} />
            <Text style={styles.archivingTitle}>{t("agentPanel.states.archivingTitle")}</Text>
            <Text style={styles.archivingSubtitle}>{t("agentPanel.states.archivingSubtitle")}</Text>
          </View>
        ) : null}
      </View>
    </RewindComposerRestoreProvider>
  );
});

function ChatSurface({
  children,
  disabled,
  fullscreen,
}: {
  children: [ReactNode, ReactNode, ReactNode];
  disabled: boolean;
  fullscreen: boolean;
}) {
  return (
    <FileDropZone style={styles.container} disabled={disabled}>
      <ComposerDock fullscreen={fullscreen}>{children}</ComposerDock>
    </FileDropZone>
  );
}

function TimelineSyncErrorCallout({
  isRetrying,
  onRetry,
}: {
  isRetrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.timelineSyncCalloutRail}>
      <View style={styles.timelineSyncCalloutContent}>
        <View style={styles.timelineSyncCallout} testID="agent-timeline-sync-error">
          <Text style={styles.timelineSyncCalloutText}>
            {t("agentPanel.states.timelineSyncFailed")}
          </Text>
          <Button
            size="sm"
            variant="secondary"
            onPress={onRetry}
            disabled={isRetrying}
            testID="agent-timeline-sync-retry"
          >
            {isRetrying ? t("agentPanel.states.timelineSyncRetrying") : t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/**
 * What the composer's controls and context meter would show, as one line, for an agent shown
 * without its composer.
 */
function SheetAgentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return text ? <PaneSubtitle text={text} testID="agent-pane-subtitle" /> : null;
}

interface ArenaChatCalloutsInput {
  serverId: string;
  agentId: string | undefined;
  agent: AgentScreenAgent;
  snapshot: ArenaSnapshot | undefined;
  toast: ReturnType<typeof useToastHost>["api"];
}

/**
 * Send the resolve prompt as a single-agent turn, leaving the composer and the Battle switch
 * alone. Battle stays on through a conflict now, so this cannot lean on the toggle's cascade to
 * configure the agent — it issues the same model and thinking calls itself before sending.
 */
function useArenaChatCallouts({
  serverId,
  agentId,
  agent,
  snapshot,
  toast,
}: ArenaChatCalloutsInput): React.ReactNode {
  const calloutClient = useHostRuntimeClient(serverId);
  // The section renders before an agent exists; the resolve action is gated on agentId below, so
  // an empty key here just reads the defaults until the real one arrives.
  const calloutArenaPreferences = useArenaPreferences(
    arenaAgentPreferenceKey(serverId, agentId ?? ""),
  );
  const calloutModel = SINGLE_AGENT_MODELS[calloutArenaPreferences.modelSize];
  const calloutPendingPrompt = usePendingBattlePrompt(serverId, agentId ?? "");
  const [resolvingConflicts, setResolvingConflicts] = useState(false);
  // The send resolves in milliseconds while the agent works for much longer, so releasing the
  // button on the send alone let the prompt be fired again and again into the same conversation.
  const agentIsWorking = agent.status === "running";
  // Only a parked promotion needs the staging asked for; a conflicted trunk ends in the user's own
  // commit. Computed as a string so the callback stays stable across the 750ms snapshot polls.
  const resolvePromptText = conflictResolvePrompt(arenaParkedPromotion(snapshot));
  const askCalloutAgent = useCallback(
    (text: string) => {
      if (!calloutClient || !agentId) return;
      setResolvingConflicts(true);
      void (async () => {
        try {
          await Promise.all([
            calloutClient.setAgentModel(agentId, calloutModel.model),
            calloutClient.setAgentThinkingOption(agentId, calloutModel.thinking),
          ]);
          await dispatchComposerAgentMessage({
            client: calloutClient,
            agentId,
            text,
            attachments: [],
            encodeImages,
            submission: createMessageSubmissionWriter(serverId),
          });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setResolvingConflicts(false);
        }
      })();
    },
    [agentId, calloutClient, calloutModel, serverId, toast],
  );
  const resolveTrunkConflicts = useCallback(
    () => askCalloutAgent(resolvePromptText),
    [askCalloutAgent, resolvePromptText],
  );

  // The review's answers are battle actions like any other, so they come from the shared hook the
  // card and the bar use; only their surface is the callout.
  const calloutBattleActions = useArenaBattleActions(serverId, agentId ?? "", snapshot?.turn);
  const {
    answerReview: calloutAnswerReview,
    discardWinner: calloutDiscardWinner,
    restoreWorkspace: calloutRestoreWorkspace,
    retryResolution: calloutRetryResolution,
    pendingAction: calloutPendingAction,
  } = calloutBattleActions;
  let reviewPending: "apply" | "discard" | null = null;
  if (calloutPendingAction?.kind === "retry_resolution") {
    reviewPending = calloutPendingAction.mode === "discard_winner" ? "discard" : "apply";
  }
  const answerCalloutReview = useReviewAnswer({
    snapshot,
    answerReview: calloutAnswerReview,
    askAgent: askCalloutAgent,
  });
  const calloutReview = useMemo(
    () => ({
      onApply: answerCalloutReview,
      onRetry: calloutRetryResolution,
      onDiscard: () => void calloutDiscardWinner(),
      onRestore: calloutRestoreWorkspace,
      onAskAgent: askCalloutAgent,
      pending: reviewPending,
    }),
    [
      answerCalloutReview,
      askCalloutAgent,
      calloutDiscardWinner,
      calloutRestoreWorkspace,
      calloutRetryResolution,
      reviewPending,
    ],
  );

  return useMemo(() => {
    if (!snapshot || !hasArenaChatCallouts(snapshot)) return null;
    return (
      <ArenaChatCallouts
        serverId={serverId}
        cwd={agent.cwd}
        snapshot={snapshot}
        onResolveConflicts={resolveTrunkConflicts}
        resolvingConflicts={resolvingConflicts || agentIsWorking}
        review={calloutReview}
        {...(calloutPendingPrompt ? { pendingPrompt: calloutPendingPrompt } : {})}
      />
    );
  }, [
    agentIsWorking,
    snapshot,
    serverId,
    agent.cwd,
    calloutPendingPrompt,
    calloutReview,
    resolveTrunkConflicts,
    resolvingConflicts,
  ]);
}

const AgentStreamSection = memo(function AgentStreamSection({
  streamViewRef,
  bottomOverlayHeight,
  serverId,
  workspaceId,
  agentId,
  agent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  feedbackPromptEligible,
  hasActiveComposer,
  hasVisibleAgentTracks,
  toast,
  onOpenWorkspaceFile,
}: {
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  bottomOverlayHeight: number;
  serverId: string;
  workspaceId: string;
  agentId?: string;
  agent: AgentScreenAgent;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  feedbackPromptEligible: boolean;
  hasActiveComposer: boolean;
  hasVisibleAgentTracks: boolean;
  toast: ReturnType<typeof useToastHost>["api"];
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const isCompactFormFactor = useIsCompactFormFactor();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
  const hasVisibleComposerTracks =
    hasActiveComposer && (hasVisibleAgentTracks || hasWorkspaceDiffStat);
  const bottomOverlayTailClearance = hasVisibleComposerTracks
    ? resolveComposerTrackTailClearance(isCompactFormFactor)
    : 0;
  const bottomOverlayControlClearance = hasVisibleComposerTracks
    ? resolveComposerTrackControlClearance(isCompactFormFactor)
    : 0;
  const streamItemsRaw = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamTail?.get(agentId) : undefined,
  );
  const pendingMessageSubmissions = useSessionStore(
    useShallow((state) =>
      agentId
        ? getActiveMessageSubmissions(state.sessions[serverId]?.messageSubmissions.get(agentId))
        : EMPTY_MESSAGE_SUBMISSIONS,
    ),
  );
  const turnPresentation = useSessionStore(
    useShallow((state) =>
      agentId
        ? selectAgentTurnPresentation(state.sessions[serverId], agentId)
        : {
            isActive: false,
            isCancelling: false,
            startedAt: null,
            turnId: null,
          },
    ),
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const forkMetadata = useSessionStore(
    useShallow((state) => {
      const storedAgent = resolveChatAgentFromSession(state, serverId, agentId);
      const forkSourceAgentId = getForkSourceAgentIdFromLabels(storedAgent?.labels);
      return storedAgent && forkSourceAgentId
        ? { agentId: storedAgent.id, forkSourceAgentId, forkedAt: storedAgent.createdAt }
        : null;
    }),
  );
  const forkBoundaryAfterItemId = useMemo(
    () =>
      forkMetadata
        ? selectForkBoundaryItemIdForAgent({
            ...forkMetadata,
            tail: streamItems,
          })
        : undefined,
    [forkMetadata, streamItems],
  );
  const queuedBattleFollowUp = useSessionStore((state) =>
    agentId
      ? (state.sessions[serverId]?.queuedMessages
          .get(agentId)
          ?.find((message) => message.arenaFollowUp === "battle") ?? null)
      : null,
  );
  const arenaSession = useArenaSessionQuery(serverId, agentId ?? "");
  const arenaStatusError = useArenaStatusError(serverId, agentId, arenaSession.error);
  const arenaPartSource = useMemo(() => ({ serverId, agentId: agent.id }), [agent.id, serverId]);
  const startingBattle = useStartingArenaBattle(serverId, agentId ?? "");
  // The collapsed summary arrives in the same frame the panes leave in.
  // A battle that has been sent counts as on screen from the moment it is sent.
  const arenaBattleOnScreen = isArenaBattleOnScreen(arenaSession.data) || startingBattle !== null;
  const pendingPermissionList = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const allPendingPermissions = state.sessions[serverId]?.pendingPermissions;
      if (!allPendingPermissions) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const filtered: PendingPermission[] = [];
      for (const permission of allPendingPermissions.values()) {
        if (permission.agentId === agentId) {
          filtered.push(permission);
        }
      }
      return filtered.length > 0 ? filtered : EMPTY_PENDING_PERMISSION_LIST;
    },
    shallow,
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) {
      return EMPTY_PENDING_PERMISSIONS;
    }
    return new Map(pendingPermissionList.map((permission) => [permission.key, permission]));
  }, [pendingPermissionList]);

  const streamHead = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamHead.get(agentId) : undefined,
  );
  const presentedStream = usePendingArenaPrompt({
    serverId,
    agentId: agentId ?? "",
    snapshot: arenaSession.data,
    streamItems,
    streamHead: streamHead ?? EMPTY_STREAM_ITEMS,
    hasAppliedAuthoritativeHistory,
  });
  // The newest summary sits at the end of the chat, above the next battle while that one runs,
  // until a later prompt follows its turn; then it stays under its own turn. Placed inline any
  // earlier, it lands above that turn's footer, which the stream draws after its last row.
  const latestSummary = useMemo(
    () => partitionArenaSummaries(arenaSession.data?.history ?? [], false).live,
    [arenaSession.data?.history],
  );
  const latestSummaryFollowedUp = useMemo(
    () => latestSummary !== null && arenaTurnFollowedUp(latestSummary, presentedStream),
    [latestSummary, presentedStream],
  );
  // The feedback prompt stays at the end of the chat even after the summary moves up.
  const feedbackBattle = arenaBattleOnScreen ? null : latestSummary;
  const summaryPlacement = useMemo(
    () => partitionArenaSummaries(arenaSession.data?.history ?? [], latestSummaryFollowedUp),
    [arenaSession.data?.history, latestSummaryFollowedUp],
  );
  // Keyed by the anchors themselves, so a streaming head does not rebuild every row.
  const summaryAnchorKey = useMemo(
    () => JSON.stringify(arenaSummaryAnchors(summaryPlacement.inline, presentedStream)),
    [presentedStream, summaryPlacement.inline],
  );

  const arenaAfterItems = useMemo(() => {
    const anchors: (string | null)[] = JSON.parse(summaryAnchorKey);
    const groups = new Map<string, React.ReactNode[]>();
    for (const [index, historyItem] of summaryPlacement.inline.entries()) {
      const anchor = anchors[index];
      if (!anchor) continue;
      const nodes = groups.get(anchor) ?? [];
      nodes.push(
        <ArenaBattleSummary
          key={historyItem.id}
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agent.id}
          item={historyItem}
        />,
      );
      groups.set(anchor, nodes);
    }
    return new Map(
      Array.from(groups, ([anchor, nodes]) => [
        anchor,
        <View key={`arena-summaries-${anchor}`}>{nodes}</View>,
      ]),
    );
  }, [agent.id, serverId, summaryAnchorKey, summaryPlacement.inline, workspaceId]);

  // The active battle owns setup progress and the contestant panes in the stream.
  const activeBattle = useMemo(() => {
    const snapshot = arenaSession.data;
    if (!snapshot || !arenaBattleOnScreen) return null;
    return (
      <View style={styles.activeBattleContent}>
        <ArenaBattleView
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agent.id}
          snapshot={snapshot}
          {...(startingBattle ? { startingPrompt: startingBattle } : {})}
        />
      </View>
    );
  }, [agent.id, arenaBattleOnScreen, arenaSession.data, serverId, startingBattle, workspaceId]);

  const canStartAgain = arenaChatCanStartBattle(arenaSession.data, arenaBattleOnScreen);
  const latestBattleSummary = useMemo(
    () =>
      summaryPlacement.live ? (
        <ArenaBattleSummary
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agent.id}
          item={summaryPlacement.live}
          canStartAgain={canStartAgain}
        />
      ) : null,
    [agent.id, canStartAgain, serverId, summaryPlacement.live, workspaceId],
  );

  const chatCallouts = useArenaChatCallouts({
    serverId,
    agentId,
    agent,
    snapshot: arenaSession.data,
    toast,
  });
  const queuedBattlePreview = useMemo(
    () =>
      queuedBattleFollowUp ? (
        <ArenaQueuedBattleView
          prompt={queuedBattleFollowUp.text}
          timestamp={queuedBattleFollowUp.arenaFollowUpQueuedAt ?? 0}
        />
      ) : null,
    [queuedBattleFollowUp],
  );
  // Lands where the conversation ends, in reading order, the way the arena's
  // own callouts do — not pinned above history it does not describe.
  const filesState =
    useWorkspaceFields(serverId, workspaceId, (workspace) => workspace.filesState) ?? undefined;
  const filesRecovery = useWorkspaceRecovery({
    serverId,
    workspaceId,
    agentId,
    enabled: filesState === "cleaned" || filesState === "restoring",
  });
  const { state: filesRecoveryState, restore: restoreFiles, retryInspection } = filesRecovery;
  const filesRecoveryBanner = useMemo(
    () =>
      filesState && filesState !== "available" ? (
        <View style={styles.filesRecoveryBanner}>
          <WorkspaceFilesRecoveryBanner
            filesState={filesState}
            recovery={filesRecoveryState}
            onRecover={restoreFiles}
            onRetryInspection={retryInspection}
          />
        </View>
      ) : null,
    [filesState, filesRecoveryState, restoreFiles, retryInspection],
  );
  const singleAgentRating = useSingleAgentRatingDialog({
    serverId,
    agentId: agent.id,
    singleAgent: arenaSession.data?.singleAgent,
  });
  // The summary keeps its slot when the next battle starts, so it stays mounted above the panes.
  const liveContent = useMemo(
    () =>
      latestBattleSummary ||
      activeBattle ||
      chatCallouts ||
      filesRecoveryBanner ||
      queuedBattlePreview ||
      feedbackBattle ||
      singleAgentRating ? (
        <View style={styles.arenaReadyContent}>
          {latestBattleSummary}
          {activeBattle ?? (
            <>
              {chatCallouts}
              {filesRecoveryBanner}
              {queuedBattlePreview}
              {feedbackBattle && !queuedBattlePreview ? (
                <ChatFeedbackCard
                  key={`battle-feedback-${feedbackBattle.id}`}
                  battleId={feedbackBattle.id}
                  agentId={agent.id}
                  workspaceId={workspaceId}
                  promptEligible={feedbackPromptEligible}
                />
              ) : null}
              {singleAgentRating}
            </>
          )}
        </View>
      ) : null,
    [
      activeBattle,
      agent.id,
      chatCallouts,
      feedbackBattle,
      feedbackPromptEligible,
      filesRecoveryBanner,
      latestBattleSummary,
      queuedBattlePreview,
      singleAgentRating,
      workspaceId,
    ],
  );

  const liveContentWithConnection = useMemo(
    () =>
      arenaStatusError ? (
        <View>
          <ArenaStreamStatus error={arenaStatusError} retry={arenaSession.refetch} />
          {liveContent}
        </View>
      ) : (
        liveContent
      ),
    [arenaStatusError, arenaSession.refetch, liveContent],
  );

  return (
    <ArenaPartSourceContext.Provider value={arenaPartSource}>
      <AgentStreamView
        ref={streamViewRef}
        agentId={agent.id}
        serverId={serverId}
        context={agent}
        streamItems={presentedStream.tail}
        streamHead={presentedStream.head}
        pendingPermissions={pendingPermissions}
        routeBottomAnchorRequest={routeBottomAnchorRequest}
        isAuthoritativeHistoryReady={hasAppliedAuthoritativeHistory}
        toast={toast}
        pendingMessageSubmissions={pendingMessageSubmissions}
        turnPresentation={turnPresentation}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        afterItems={arenaAfterItems}
        forkBoundaryAfterItemId={forkBoundaryAfterItemId}
        liveContent={liveContentWithConnection}
        bottomOverlayHeight={bottomOverlayHeight}
        bottomOverlayTailClearance={bottomOverlayTailClearance}
        bottomOverlayControlClearance={bottomOverlayControlClearance}
        arenaChat={arenaSession.data !== undefined}
      />
    </ArenaPartSourceContext.Provider>
  );
});

const AgentComposerSection = memo(function AgentComposerSection({
  agentId,
  serverId,
  isPaneFocused,
  isArchivingCurrentAgent,
  archivedAt,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onDecisionPillHeightChange,
  onMessageSent,
}: {
  agentId?: string;
  serverId: string;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  archivedAt: Date | null;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onDecisionPillHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  const arenaSession = useArenaSessionQuery(serverId, agentId ?? "");
  const startingBattle = useStartingArenaBattle(serverId, agentId ?? "");
  const supportsArenaBattleReplies = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.arenaBattleReplies === true,
  );
  const battleReplyAvailable = useMemo(() => {
    const replyState = deriveArenaReplyState(arenaSession.data);
    return Boolean(
      supportsArenaBattleReplies &&
      arenaSetupStatus(arenaSession.data?.turn) === null &&
      replyState.replyableBattleTurn &&
      replyState.replyActions.length > 0,
    );
  }, [arenaSession.data, supportsArenaBattleReplies]);
  useEffect(() => {
    if (!startingBattle) return;
    onComposerHeightChange(0);
    onDecisionPillHeightChange(0);
  }, [onComposerHeightChange, onDecisionPillHeightChange, startingBattle]);
  if (!agentId) {
    return null;
  }
  if (archivedAt) {
    return <ArchivedAgentCallout serverId={serverId} agentId={agentId} />;
  }
  if (isArchivingCurrentAgent) {
    return null;
  }
  // Setup progress is in the stream; there is no reply target until setup finishes.
  if (startingBattle) {
    return null;
  }
  // A replyable battle keeps the composer. Battle actions float above the slot;
  // transitions and recovery use the fallback bar.
  const composer =
    arenaSession.data && showsArenaDecisionBar(arenaSession.data) && !battleReplyAvailable ? (
      <ArenaDecisionBar
        serverId={serverId}
        agentId={agentId}
        snapshot={arenaSession.data}
        onHeightChange={onComposerHeightChange}
      />
    ) : (
      <ActiveAgentComposer
        agentId={agentId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        cwd={cwd}
        isSubmitLoading={isSubmitLoading}
        agentInputDraft={agentInputDraft}
        editingSession={editingSession}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={onComposerHeightChange}
        onMessageSent={onMessageSent}
      />
    );
  return (
    <View style={styles.composerSlot}>
      {arenaSession.data ? (
        <ArenaDecisionPill
          serverId={serverId}
          agentId={agentId}
          snapshot={arenaSession.data}
          onHeightChange={onDecisionPillHeightChange}
        />
      ) : null}
      {composer}
    </View>
  );
});

function useSingleAgentRatingDialog({
  serverId,
  agentId,
  singleAgent,
}: {
  serverId: string;
  agentId: string;
  singleAgent: ArenaSnapshot["singleAgent"];
}) {
  // A skipped optional rating stays hidden; the next turn replaces it in the snapshot anyway.
  const [skippedRatingId, setSkippedRatingId] = useState<string | null>(null);
  const skip = useCallback(() => {
    if (singleAgent) setSkippedRatingId(singleAgent.id);
  }, [singleAgent]);
  const offered =
    singleAgent?.completed === true &&
    (singleAgentRatingRequired(singleAgent) ||
      (singleAgentRatingOptional(singleAgent) && skippedRatingId !== singleAgent.id));
  return useMemo(
    () =>
      singleAgent && offered ? (
        <SingleAgentRatingDialog
          key={singleAgent.id}
          serverId={serverId}
          agentId={agentId}
          ratingId={singleAgent.id}
          onSkip={singleAgent.ratingRequired ? undefined : skip}
        />
      ) : null,
    [singleAgent, offered, serverId, agentId, skip],
  );
}

/**
 * The chat's pinned task list: the current turn's latest list, scoped to work the canonical chat
 * owns. A battle's contestants report their own progress in their panes, so the list hides while
 * battles run, and once a battle ends it skips the winner's replayed task lists, which keep their
 * original timestamps.
 */
function useChatTasks({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): TodoEntry[] | undefined {
  const arenaSession = useArenaSessionQuery(serverId, agentId);
  const arenaPreferences = useArenaPreferences(arenaAgentPreferenceKey(serverId, agentId));
  const { battleIsActive } = useMemo(
    () => deriveArenaReplyState(arenaSession.data),
    [arenaSession.data],
  );
  const taskList = ordinaryTaskListState({
    arenaSupported: arenaSession.supported,
    battleMode: arenaPreferences.battleMode,
    battleIsActive,
    history: arenaSession.data?.history,
  });
  const battleEndedAt = taskList.visible ? taskList.battleEndedAt : null;
  const tasks = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return tasksAfterBattle(
        [
          ...(session?.agentStreamTail.get(agentId) ?? []),
          ...(session?.agentStreamHead.get(agentId) ?? []),
        ],
        battleEndedAt,
      );
    }),
  );
  return taskList.visible ? tasks : undefined;
}

function useSingleAgentComposerState({
  serverId,
  agentId,
  active,
}: {
  serverId: string;
  agentId: string;
  active: boolean;
}) {
  const arenaPreferences = useArenaPreferences(arenaAgentPreferenceKey(serverId, agentId));
  const arenaSession = useArenaSessionQuery(serverId, agentId);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const singleAgentRunning = useSessionStore((state) => {
    const status = state.sessions[serverId]?.agents?.get(agentId)?.status;
    return status === "running" || status === "initializing";
  });
  const singleAgentLocked = singleAgentControlsLocked({
    singleAgent: arenaSession.data?.singleAgent,
    modelSize: arenaPreferences.modelSize,
    running: singleAgentRunning,
  });
  const selectedSingleAgentModel = SINGLE_AGENT_MODELS[arenaPreferences.modelSize];
  const configuredModel = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.model,
  );

  useEffect(() => {
    if (!active || !client) return;
    void Promise.all([
      client.setAgentModel(agentId, selectedSingleAgentModel.model),
      client.setAgentThinkingOption(agentId, selectedSingleAgentModel.thinking),
    ]).catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  }, [agentId, selectedSingleAgentModel, client, active, toast]);

  const disabled =
    singleAgentLocked || (active && configuredModel !== selectedSingleAgentModel.model);
  return {
    locked: singleAgentLocked,
    disabled,
    completed: arenaSession.data?.singleAgent?.completed === true,
  };
}

function ActiveAgentComposer({
  agentId,
  serverId,
  isPaneFocused,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
}: {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
}) {
  const toast = useToast();
  const arenaPreferenceKey = arenaAgentPreferenceKey(serverId, agentId);
  const arenaPreferences = useArenaPreferences(arenaPreferenceKey);
  const arenaSession = useArenaSessionQuery(serverId, agentId);
  const arenaStart = useArenaStartMutation(serverId, agentId);
  const arenaReplyMutation = useArenaTurnMutation(serverId, agentId);
  const offeredConflictResolutionTurnID = useRef<string | null>(null);
  const supportsArenaBattleReplies = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.arenaBattleReplies === true,
  );
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    {
      initialIsBelow: isCompactFormFactor,
    },
  );
  const paneContext = usePaneContext();
  const { workspaceId, tabId, retargetCurrentTab } = paneContext;
  const { archiveAgent } = useArchiveAgent();
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd,
    workspaceId,
  });
  const attachmentScopeKeys = useMemo(
    () => [workspaceAttachmentScopeKey],
    [workspaceAttachmentScopeKey],
  );
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceSidePanelTab({ serverId, workspaceId, target: { kind: "changes" } });
    },
    [serverId, workspaceId],
  );

  const handleClientSlashCommand = useCallback(
    async (command: ClientSlashCommand) => {
      const agent = resolveChatAgentFromSession(useSessionStore.getState(), serverId, agentId);
      if (!agent) {
        throw new Error("Agent not found");
      }

      const workspaceKey = buildWorkspaceTabPersistenceKey({
        serverId,
        workspaceId,
      });
      if (workspaceKey) {
        unpinWorkspaceAgent(workspaceKey, agentId);
        hideWorkspaceAgent(workspaceKey, agentId);
      }

      if (command.kind === "replace-agent-with-draft") {
        retargetCurrentTab({
          kind: "draft",
          draftId: generateDraftId(),
          setup: buildDraftAgentSetup(agent),
        });
      } else if (workspaceKey) {
        closeWorkspaceTab(workspaceKey, tabId);
      }

      await archiveAgent({ serverId, agentId });
    },
    [
      agentId,
      archiveAgent,
      closeWorkspaceTab,
      hideWorkspaceAgent,
      retargetCurrentTab,
      serverId,
      tabId,
      unpinWorkspaceAgent,
      workspaceId,
    ],
  );

  const { setBattleMode } = arenaPreferences;
  const trunkConflicts = arenaSession.data ? activeTrunkConflicts(arenaSession.data.chat) : null;
  const chatIsBlocked = Boolean(arenaSession.data?.chat.blockedReason);
  /**
   * The held battle prompt comes back to the composer when the trunk is clean, and the user sends
   * it. It is never started automatically: the resolving agent often stops to ask which side of a
   * hunk to keep, and a battle firing the moment that conversation lands a clean tree is a battle
   * nobody asked for at that moment.
   */
  const pendingBattlePrompt = usePendingBattlePrompt(serverId, agentId);
  const composerTextSource = agentInputDraft.textSource;
  const composerIsEmpty = useSyncExternalStore(
    composerTextSource.subscribe,
    () => composerTextSource.getSnapshot().trim().length === 0,
    () => composerTextSource.getSnapshot().trim().length === 0,
  );
  const draftHydrated = agentInputDraft.isHydrated;
  const setComposerText = agentInputDraft.replaceText;
  const setComposerAttachments = agentInputDraft.setAttachments;
  // `trunkConflicts` is null both for a clean trunk and for a snapshot that has not arrived, and
  // treating the second as the first restored the prompt before the conflict was ever known — the
  // chip never appeared. Only a loaded snapshot can say the trunk is clean.
  const arenaSnapshotLoaded = arenaSession.data !== undefined;
  useEffect(() => {
    if (!pendingBattlePrompt || !arenaSnapshotLoaded || trunkConflicts !== null) return;
    // Waiting for hydration keeps this from overwriting a persisted draft that has not loaded yet.
    if (!draftHydrated || !composerIsEmpty) return;
    const heldAttachments = readPendingBattleAttachments({ serverId, agentId });
    setComposerText(pendingBattlePrompt);
    if (heldAttachments.length > 0) setComposerAttachments(heldAttachments);
    clearPendingBattlePrompt({ serverId, agentId });
  }, [
    agentId,
    arenaSnapshotLoaded,
    composerIsEmpty,
    draftHydrated,
    pendingBattlePrompt,
    serverId,
    setComposerAttachments,
    setComposerText,
    trunkConflicts,
  ]);

  const singleAgentTurnsActive = !arenaPreferences.battleMode || trunkConflicts !== null;
  const singleAgentComposer = useSingleAgentComposerState({
    serverId,
    agentId,
    active: singleAgentTurnsActive,
  });

  useEffect(() => {
    const guard = resolveConflictGuard({
      trunkConflicts,
      blocked: chatIsBlocked,
      battleMode: arenaPreferences.battleMode,
      // A parked promotion pauses battles exactly like a conflicted trunk: the switch goes off
      // while it stands, the composer sends single-agent turns, and the switch comes back where
      // it was once the promotion finishes.
      parkedPromotion: arenaParkedPromotion(arenaSession.data) !== null,
    });
    // A blocked chat does not clear on its own, so its switch goes off and stays off.
    if (guard.forceBattleOff) {
      setBattleMode(false);
      return;
    }
    // A conflict is a pause: the switch goes off while it stands and returns to where the user
    // left it once the trunk is clean. Waiting for the snapshot keeps a chat that has not loaded
    // from reading as "no conflicts" and restoring before the pause has even been applied.
    if (!arenaSnapshotLoaded) return;
    const pause = resolveBattlePause({
      conflictsActive: guard.active,
      battleMode: arenaPreferences.battleMode,
      battleModeBeforeConflict: arenaPreferences.battleModeBeforeConflict,
    });
    if (pause) applyArenaPreferencePatch(arenaPreferenceKey, pause);
  }, [
    arenaPreferenceKey,
    arenaPreferences.battleMode,
    arenaPreferences.battleModeBeforeConflict,
    arenaSession.data,
    arenaSnapshotLoaded,
    chatIsBlocked,
    setBattleMode,
    trunkConflicts,
  ]);

  const submitBattle = useCallback(
    async (payload: MessagePayload) => {
      if (!payload.text.trim()) {
        throw new Error("Enter a prompt to start the battle.");
      }
      const release = retainArenaPromptImages(payload.attachments);
      try {
        await arenaStart.mutateAsync({
          prompt: payload.text,
          attachments: payload.attachments,
        });
      } finally {
        release();
      }
    },
    [arenaStart],
  );

  const { battleIsActive, canQueueNextTurn, replyableBattleTurn, replyActions } = useMemo(
    () => deriveArenaReplyState(arenaSession.data),
    [arenaSession.data],
  );
  const conflictResolutionTurnID = useMemo(
    () => arenaConflictResolutionTurnID(arenaSession.data),
    [arenaSession.data],
  );
  useEffect(() => {
    if (
      !conflictResolutionTurnID ||
      !agentInputDraft.isHydrated ||
      offeredConflictResolutionTurnID.current === conflictResolutionTurnID
    ) {
      return;
    }
    offeredConflictResolutionTurnID.current = conflictResolutionTurnID;
    if (
      agentInputDraft.textSource.getSnapshot().length > 0 ||
      agentInputDraft.attachments.length > 0
    ) {
      return;
    }
    agentInputDraft.replaceText(ARENA_CONFLICT_RESOLUTION_PROMPT);
  }, [agentInputDraft, conflictResolutionTurnID]);
  const queuedArenaFollowUp = useSessionStore(
    (state) =>
      state.sessions[serverId]?.queuedMessages
        .get(agentId)
        ?.find((message) => message.arenaFollowUp !== undefined) ?? null,
  );

  const attemptedArenaFollowUps = useRef(new Set<string>());
  const submitBattleReply = useCallback(
    async (actionId: string, payload: MessagePayload) => {
      if (!replyableBattleTurn) {
        throw new Error("The battle is no longer accepting replies.");
      }
      const action = replyActions.find((candidate) => candidate.target === actionId);
      if (!action) {
        throw new Error("That battle action is no longer available.");
      }
      const prompt = payload.text.trim();
      if (!prompt) {
        throw new Error("Enter a reply for the battle.");
      }
      const release = retainArenaPromptImages(payload.attachments);
      try {
        await arenaReplyMutation.mutateAsync({
          kind: "reply",
          turnId: replyableBattleTurn.id,
          prompt,
          target: action.target,
          attachments: payload.attachments,
        });
      } finally {
        release();
      }
      const queuedMessage = arenaSteeringQueuedMessage(action);
      if (queuedMessage) {
        toast.show(queuedMessage, {
          variant: "success",
          testID: "arena-steering-queued-toast",
        });
      }
    },
    [arenaReplyMutation, replyActions, replyableBattleTurn, toast],
  );
  useEffect(() => {
    const snapshot = arenaSession.data;
    if (
      !snapshot ||
      !canDrainArenaFollowUp(snapshot) ||
      singleAgentRatingRequired(snapshot.singleAgent) ||
      arenaStart.isPending ||
      !queuedArenaFollowUp
    ) {
      return;
    }
    const attemptKey = `${snapshot.chat.canonicalSHA}:${queuedArenaFollowUp.id}`;
    if (attemptedArenaFollowUps.current.has(attemptKey)) return;
    attemptedArenaFollowUps.current.add(attemptKey);
    if (queuedArenaFollowUp.arenaFollowUp === "single_agent") {
      getHostRuntimeStore().drainQueuedAgentMessage(serverId, agentId, {
        allowArenaFollowUp: true,
      });
      return;
    }
    void sendQueuedComposerMessageNow({
      agentId,
      messageId: queuedArenaFollowUp.id,
      queue: {
        read: (queuedAgentId) =>
          useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ?? [],
        write: (update) => useSessionStore.getState().setQueuedMessages(serverId, update),
      },
      submitMessage: ({ text, attachments }) => submitBattle({ text, attachments, cwd }),
      retainWhileSubmitting: true,
    }).then((result) => {
      if (result.status === "failed") {
        const restored = editQueuedComposerMessage({
          agentId,
          messageId: queuedArenaFollowUp.id,
          queue: {
            read: (queuedAgentId) =>
              useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ??
              [],
            write: (update) => useSessionStore.getState().setQueuedMessages(serverId, update),
          },
        });
        if (restored) {
          agentInputDraft.replaceText(restored.text);
          agentInputDraft.setAttachments(restored.attachments);
        }
        toast.error(result.errorMessage);
      }
      return result;
    });
  }, [
    agentId,
    arenaStart.isPending,
    arenaSession.data?.chat.canonicalSHA,
    arenaSession.data,
    agentInputDraft,
    cwd,
    queuedArenaFollowUp,
    serverId,
    submitBattle,
    toast,
  ]);
  const battleReplyEnabled = Boolean(
    replyableBattleTurn && supportsArenaBattleReplies && replyActions.length > 0,
  );
  const battleReplyComposer = useArenaReplyComposerControls({
    enabled: battleReplyEnabled,
    turnId: replyableBattleTurn?.id ?? null,
    actions: replyActions,
    onSubmit: submitBattleReply,
  });
  const useLegacyBattleLoading = battleIsActive && !canQueueNextTurn && !supportsArenaBattleReplies;
  const composerParkedPromotion = arenaParkedPromotion(arenaSession.data);
  const arenaComposerSubmit = resolveArenaComposerSubmit({
    battleReplyEnabled,
    battleMode: arenaPreferences.battleMode,
    trunkConflicted: trunkConflicts !== null,
    submitBattle,
  });
  const arenaComposerQueueState = deriveArenaComposerQueueState({
    battleIsActive,
    battleMode: arenaPreferences.battleMode,
    battleReplyEnabled,
    canQueueNextTurn,
    hasQueuedFollowUp: queuedArenaFollowUp !== null,
    hasReplyableTurn: replyableBattleTurn !== null,
    hasReplyActions: replyActions.length > 0,
    parkedPromotion: composerParkedPromotion !== null,
    useLegacyBattleLoading,
  });
  const composerPresentation = arenaReplyComposerPresentation({
    enabled: battleReplyEnabled,
    awaitingVote: replyableBattleTurn?.state === "awaiting_vote",
    reviewOpen: composerParkedPromotion?.kind === "review",
    replyComposer: battleReplyComposer,
    fallbackSubmit: arenaComposerSubmit,
  });
  // Every submit the panel supplies goes to the battle engine; without one, the chat's agent sends.
  const composerMaxImages = arenaComposerMaxImages(
    composerPresentation.onSubmitMessage !== undefined,
  );

  return (
    <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
      <SingleAgentComposerTooltip
        locked={singleAgentComposer.locked}
        completed={singleAgentComposer.completed}
      >
        <Composer
          agentId={agentId}
          serverId={serverId}
          workspaceId={workspaceId}
          blurOnSubmit={isNative}
          isPaneFocused={isPaneFocused}
          textSource={agentInputDraft.textSource}
          onChangeText={agentInputDraft.editText}
          textReplacement={agentInputDraft.textReplacement}
          attachments={agentInputDraft.attachments}
          attachmentScopeKeys={attachmentScopeKeys}
          onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
          onChangeAttachments={agentInputDraft.setAttachments}
          cwd={cwd}
          clearDraft={agentInputDraft.clear}
          editingSession={editingSession}
          autoFocus
          autoFocusKey={String(agentInputDraft.attachmentFocusRequestId)}
          onSubmitMessage={composerPresentation.onSubmitMessage}
          queueWhileBusy={canQueueNextTurn}
          arenaFollowUp={arenaComposerQueueState.arenaFollowUp}
          submitButtonAccessibilityLabel={composerPresentation.submitButtonAccessibilityLabel}
          submitButtonTestID={composerPresentation.submitButtonTestID}
          submitLabel={composerPresentation.submitLabel}
          placeholder={composerPresentation.placeholder}
          maxImages={composerMaxImages}
          leftContent={battleReplyComposer.leftContent}
          isSubmitLoading={
            isSubmitLoading ||
            arenaStart.isPending ||
            arenaReplyMutation.isPending ||
            useLegacyBattleLoading
          }
          disabled={arenaComposerQueueState.disabled || singleAgentComposer.disabled}
          defaultSendBehavior={arenaComposerQueueState.defaultSendBehavior}
          onAttentionInputFocus={onAttentionInputFocus}
          onAttentionPromptSend={onAttentionPromptSend}
          onComposerHeightChange={onComposerHeightChange}
          onMessageSent={onMessageSent}
          onClientSlashCommand={handleClientSlashCommand}
          isCompactLayout={isCompactComposerLayout}
        />
      </SingleAgentComposerTooltip>
    </View>
  );
}

function AgentSessionUnavailableState({
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
  t,
}: {
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
  t: TFunction;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            {t("agentPanel.unavailable.unknownHost", { serverLabel })}
          </Text>
          <Text style={styles.statusText}>{t("agentPanel.unavailable.addHost")}</Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";
  const isPreparingSession = connectionStatus === "online";

  return (
    <View style={styles.container}>
      <View style={styles.centerState}>
        {isConnecting || isPreparingSession ? (
          <>
            <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
            <Text style={styles.loadingText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.preparingSession", { serverLabel })
                : t("agentPanel.unavailable.connecting", { serverLabel })}
            </Text>
            <Text style={styles.statusText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.showSoon")
                : t("agentPanel.unavailable.showWhenOnline")}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              {t("agentPanel.unavailable.reconnectingTo", { serverLabel })}
            </Text>
            <Text style={styles.offlineDescription}>
              {t("agentPanel.unavailable.showAgainWhenReachable")}
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const animatedStaticStyles = RNStyleSheet.create({
  content: {
    flex: 1,
  },
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  composerSlot: {
    position: "relative",
    zIndex: 1,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
    ...(isWeb ? { userSelect: "none" as const } : {}),
  },
  timelineSyncCalloutRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  timelineSyncCalloutContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  timelineSyncCallout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  timelineSyncCalloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  historySyncOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
  },
  archivingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 10, 14, 0.86)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    gap: theme.spacing[3],
    zIndex: 50,
  },
  archivingTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  archivingSubtitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorAction: {
    marginTop: theme.spacing[4],
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  // Scroll the last review lines above the floating vote, including its stopped-battle hint.
  activeBattleContent: {
    paddingBottom: theme.spacing[20],
  },
  arenaReadyContent: {
    gap: theme.spacing[3],
  },
  // The conversation's own measure, so the notice lines up with the battle
  // summary above it rather than breaking out of the column.
  filesRecoveryBanner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
  },
  offlineTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  offlineDescription: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  offlineDetails: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
