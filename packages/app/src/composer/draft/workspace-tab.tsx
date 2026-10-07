import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Keyboard, ScrollView, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { AgentStreamView } from "@/agent-stream/view";
import { STREAM_CONTENT_TOP_INSET } from "@/agent-stream/spacing";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "@/composer/draft/create-flow";
import { resolveTurnPresentation, TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { markArenaBattleHandoff } from "@/arena/battle-handoff";
import { savePendingBattlePrompt } from "@/arena/pending-battle";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { Agent } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useAgentControlCommandCenterActions } from "@/command-center/agent-control-registration";
import { encodeImages } from "@/utils/encode-images";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import {
  isStartingArenaBattle,
  shouldAllowEmptyDraftText,
} from "@/composer/draft/workspace-tab-core";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { ArenaPromptAttachments, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import {
  ARENA_PROVIDER,
  ARENA_BOOTSTRAP_MODEL,
  ARENA_THINKING_OPTIONS,
  arenaAgentPreferenceKey,
  arenaDraftPreferenceKey,
  type ArenaThinkingLevel,
} from "@/arena/constants";
import { arenaComposerMaxImages } from "@/arena/composer-state";
import { canStartBattleOnChat } from "@/arena/conflict-guard";
import {
  copyArenaPreferences,
  getArenaPreferences,
  useArenaPreferences,
} from "@/arena/preferences";
import { useQueryClient } from "@tanstack/react-query";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { ArenaDraftBattleView } from "@/arena/battle-view";
import { arenaSessionQueryKey } from "@/arena/use-arena-session";
import { ArenaContentColumn } from "@/arena/content-column";
import { ensureBattleRepository } from "@/arena/battle-repository";
import { arenaByokKey } from "@/byok/key";
import { router } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import {
  FirstSendError,
  returnFailedFirstSendToNewChat,
  type FailedFirstSendDeps,
} from "@/composer/draft/failed-first-send";
import { openWorkspaceSidePanelTab } from "@/workspace/side-panel-command";

const EMPTY_PENDING_PERMISSIONS = new Map();
const EMPTY_ONLINE_SERVER_IDS: string[] = [];
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

// Before createAgent, so a folder that cannot battle leaves no agent behind.
async function checkBattleCanStart(input: { client: DaemonClient; cwd: string }): Promise<void> {
  await arenaByokKey.ensure(input.client);
  await ensureBattleRepository({ client: input.client, cwd: input.cwd });
}

async function submitDraftCreateRequest(input: {
  attempt: { clientMessageId: string };
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: unknown;
  cwd: string;
  client: DaemonClient | null;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  hostDisconnectedMessage: string;
  arenaPreferenceKey: string;
  featureValues?: Record<string, unknown>;
  createdPreferenceKey: (agentId: string) => string;
  /** Give the workspace this draft becomes the started battle, and the licence to paint it. */
  handOffStartedBattle: (agentId: string, snapshot: ArenaSnapshot) => void;
  /** Hold the typed prompt and its images as the agent's next battle when nothing will send it now. */
  queueBattlePrompt: (agentId: string, text: string, images: UserMessageImageAttachment[]) => void;
}): Promise<{
  agentId: string | null;
  result: AgentSnapshotPayload;
  handoffMessage?: boolean;
}> {
  const { attempt, text, images, attachments, cwd, client, workspaceDirectory, workspaceId } =
    input;

  invariant(workspaceDirectory, "Workspace directory is required");
  invariant(workspaceId, "Workspace id is required");
  if (!client) {
    throw new Error(input.hostDisconnectedMessage);
  }

  const arenaPreferences = getArenaPreferences(input.arenaPreferenceKey);
  const provider = ARENA_PROVIDER;
  const config = buildWorkspaceDraftAgentConfig({
    provider,
    cwd,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: arenaPreferences.thinking,
    featureValues: input.featureValues,
  });

  if (arenaPreferences.battleMode) {
    await checkBattleCanStart({ client, cwd });
  }
  const imagesData = await encodeImages(images);
  const attachmentsArray = Array.isArray(attachments) ? attachments : undefined;
  // A battle's prompt and its attachments ride on arenaStart below, never on the agent itself.
  const promptAttachments = {
    ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
    ...(attachmentsArray && attachmentsArray.length > 0 ? { attachments: attachmentsArray } : {}),
  };
  const result = await client.createAgent({
    config,
    workspaceId,
    ...(!arenaPreferences.battleMode && text ? { initialPrompt: text } : {}),
    ...(!arenaPreferences.battleMode ? { clientMessageId: attempt.clientMessageId } : {}),
    ...(!arenaPreferences.battleMode ? promptAttachments : {}),
  });

  if (result.id) {
    copyArenaPreferences(input.arenaPreferenceKey, input.createdPreferenceKey(result.id));
  }
  if (arenaPreferences.battleMode) {
    if (!result.id) throw new Error("Created OpenCode agent did not return an id");
    try {
      await startDraftBattle({ ...input, client, agentId: result.id, promptAttachments });
    } catch (error) {
      throw new FirstSendError(error, result.id);
    }
  }

  return {
    agentId: result.id,
    result,
    handoffMessage: !arenaPreferences.battleMode,
  };
}

async function startDraftBattle(input: {
  client: DaemonClient;
  agentId: string;
  text: string;
  images?: UserMessageImageAttachment[];
  promptAttachments: ArenaPromptAttachments;
  handOffStartedBattle: (agentId: string, snapshot: ArenaSnapshot) => void;
  queueBattlePrompt: (agentId: string, text: string, images: UserMessageImageAttachment[]) => void;
}): Promise<void> {
  const { client, agentId, text, images, promptAttachments } = input;
  const snapshot = await client.arenaResolve(agentId);
  if (!canStartBattleOnChat(snapshot.chat)) {
    // The daemon would refuse this start. The agent panel mounts the arena query and explains
    // the pause instead of burning the send on a toast.
    //
    // A battle prompt is withheld from createAgent above so arenaStart can carry it, so skipping
    // the start leaves nothing holding the text. It used to be dropped here and the guard then
    // prefilled the resolve prompt into the empty composer, which read as the app replacing what
    // you wrote.
    //
    // It becomes the queued next battle rather than composer text: resolving conflicts is a
    // conversation, and an agent that asks which side of a hunk to keep needs the composer the
    // parked prompt would have been sitting in. The queue drains itself once the trunk is clean.
    input.queueBattlePrompt(agentId, text, images ?? []);
    return;
  }
  const started = await client.arenaStart(agentId, snapshot.chat.id, text, promptAttachments);
  // Hand the started battle to the workspace this draft is about to become. Without it the
  // agent panel mounts with nothing, renders its empty state, and waits up to a poll for a
  // battle that has already begun — which is the blank chat between the draft's panes going
  // and the real ones arriving.
  input.handOffStartedBattle(agentId, started);
}

function failedFirstSendDeps(input: {
  client: DaemonClient;
  showError: (message: string) => void;
}): FailedFirstSendDeps {
  return {
    readWorkspaceAgentIds: (serverId, workspaceId) =>
      Array.from(useSessionStore.getState().sessions[serverId]?.agents.values() ?? []).flatMap(
        (agent) => (agent.workspaceId === workspaceId ? [agent.id] : []),
      ),
    resolveNewChatRoute: (serverId, workspaceId) =>
      buildWorkspaceArchiveRedirectRoute({
        serverId,
        archivedWorkspaceId: workspaceId,
        workspaces: useSessionStore.getState().sessions[serverId]?.workspaces.values() ?? [],
      }),
    saveNewChatDraft: (draft) =>
      useDraftStore.getState().saveDraftInput({ draftKey: buildNewWorkspaceDraftKey(), draft }),
    navigate: (route) => router.replace(route),
    showError: input.showError,
    archiveWorkspace: (serverId, workspaceId) =>
      archiveWorkspaceOptimistically({
        client: input.client,
        workspace: { serverId, workspaceId },
      }),
  };
}

function buildDraftAgentSnapshot(input: {
  attempt: { timestamp: Date };
  serverId: string;
  tabId: string;
  workspaceDirectory: string | null;
  arenaThinking: ArenaThinkingLevel;
}): Agent {
  const { attempt, serverId, tabId, workspaceDirectory } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  const now = attempt.timestamp;
  const model = ARENA_BOOTSTRAP_MODEL;
  const thinkingOptionId = input.arenaThinking;
  const modeId = null;
  const provider = ARENA_PROVIDER;
  return {
    serverId,
    id: tabId,
    provider,
    status: "running",
    activeTurn: null,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: DRAFT_CAPABILITIES,
    currentModeId: modeId,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider, sessionId: null, model, modeId },
    title: "Agent",
    cwd: workspaceDirectory,
    model,
    features: [],
    thinkingOptionId,
    parentAgentId: null,
    labels: {},
  };
}

function buildDraftInitialValues(input: {
  workingDir: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (!input.workingDir) {
    return undefined;
  }
  if (!input.initialSetup) {
    return {
      workingDir: input.workingDir,
      provider: ARENA_PROVIDER,
      model: ARENA_BOOTSTRAP_MODEL,
      thinkingOptionId: "high",
    };
  }
  return {
    workingDir: input.workingDir,
    provider: ARENA_PROVIDER,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: "high",
  };
}

function resolveDraftWorkingDirectory(input: {
  workspaceDirectory: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): string | null {
  if (input.initialSetup) {
    return input.initialSetup.cwd;
  }
  return input.workspaceDirectory;
}

function resolveOnlineServerIds(input: { isConnected: boolean; serverId: string }): string[] {
  if (!input.isConnected) {
    return EMPTY_ONLINE_SERVER_IDS;
  }
  return [input.serverId];
}

interface WorkspaceDraftAgentTabProps {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  initialSetup?: WorkspaceDraftTabSetup;
  isPaneFocused: boolean;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
}

export function WorkspaceDraftAgentTab({
  serverId,
  workspaceId,
  tabId,
  draftId,
  initialSetup = undefined,
  isPaneFocused,
  onCreated,
  onOpenWorkspaceFile,
}: WorkspaceDraftAgentTabProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const arenaPreferenceKey = arenaDraftPreferenceKey(serverId, draftId);
  const arenaPreferences = useArenaPreferences(arenaPreferenceKey);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
    id: w.id,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const draftSetup = initialSetup ?? null;
  const draftWorkingDirectory = resolveDraftWorkingDirectory({
    workspaceDirectory,
    initialSetup: draftSetup,
  });
  const draftInitialValues = buildDraftInitialValues({
    workingDir: draftWorkingDirectory,
    initialSetup: draftSetup,
  });
  const onlineServerIds = resolveOnlineServerIds({ isConnected, serverId });
  const draftStoreKey = useMemo(
    () =>
      buildDraftStoreKey({
        serverId,
        agentId: tabId,
        draftId,
      }),
    [draftId, serverId, tabId],
  );
  const draftInput = useAgentInputDraft({
    draftKey: draftStoreKey,
    composer: {
      initialServerId: serverId,
      initialValues: draftInitialValues,
      initialFeatureValues: draftSetup?.featureValues,
      isVisible: true,
      onlineServerIds,
      lockedWorkingDir: draftWorkingDirectory ?? undefined,
    },
  });
  const composerState = draftInput.composerState;
  if (!composerState) {
    throw new Error("Workspace draft composer state is required");
  }

  const draftProvider = composerState.selectedProvider;
  const draftProviderDefinitions = composerState.providerDefinitions;
  const draftThinkingOptions = composerState.availableThinkingOptions;
  const draftSelectedThinkingId = composerState.selectedThinkingOptionId;
  const draftSetThinkingOption = composerState.setThinkingOptionFromUser;
  const draftModeOptions = composerState.modeOptions;
  const draftSelectedMode = composerState.selectedMode;
  const draftSetMode = composerState.setModeFromUser;
  const draftFeatures = composerState.agentControls.features;
  const draftOnSetFeature = composerState.agentControls.onSetFeature;

  const clearDraftInput = draftInput.clear;
  const setDraftText = draftInput.setText;
  const setDraftAttachments = draftInput.setAttachments;
  const pendingAutoSubmit = useWorkspaceDraftSubmissionStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.workspaceId === workspaceId ? pending : null;
  });
  const pendingCreateAttempt = useCreateFlowStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.lifecycle === "active" ? pending : null;
  });
  const consumePendingAutoSubmit = useWorkspaceDraftSubmissionStore(
    (state) => state.consumePending,
  );
  const initialCreateAttempt = useMemo<DraftCreateAttempt | null>(() => {
    if (!pendingAutoSubmit || !pendingCreateAttempt) {
      return null;
    }
    if (pendingAutoSubmit.clientMessageId !== pendingCreateAttempt.clientMessageId) {
      return null;
    }
    return {
      clientMessageId: pendingCreateAttempt.clientMessageId,
      text: pendingCreateAttempt.text,
      timestamp: new Date(pendingCreateAttempt.timestamp),
      ...(pendingCreateAttempt.images && pendingCreateAttempt.images.length > 0
        ? { images: pendingCreateAttempt.images }
        : {}),
      ...(pendingCreateAttempt.attachments && pendingCreateAttempt.attachments.length > 0
        ? { attachments: pendingCreateAttempt.attachments }
        : {}),
    };
  }, [pendingAutoSubmit, pendingCreateAttempt]);
  const allowsEmptyAutoSubmit = pendingAutoSubmit?.allowEmptyText === true;
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd: composerState.workingDir,
    workspaceId,
  });
  const draftAttachmentScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const attachmentScopeKeys = useMemo(
    () => [draftAttachmentScopeKey, workspaceAttachmentScopeKey].filter(Boolean),
    [draftAttachmentScopeKey, workspaceAttachmentScopeKey],
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
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

  const {
    machine,
    formErrorMessage,
    isSubmitting,
    submittedStreamItems,
    pendingMessageSubmissions,
    draftAgent,
    handleCreateFromInput,
    continueCreateFromAttempt,
  } = useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
    draftId,
    getPendingServerId: () => serverId,
    initialAttempt: initialCreateAttempt,
    allowEmptyText: allowsEmptyAutoSubmit,
    validateBeforeSubmit: ({ text, attachments }) => {
      if (!draftWorkingDirectory) return "Workspace directory is required.";
      if (!client) return t("workspace.terminal.hostDisconnected");
      if (arenaPreferences.battleMode && !text.trim()) {
        return "Enter a prompt to start the battle.";
      }
      if (!text && !shouldAllowEmptyDraftText({ allowsEmptyAutoSubmit, attachments })) {
        return "Enter a prompt to start the agent.";
      }
      return null;
    },
    onBeforeSubmit: async () => {
      await composerState.persistFormPreferences();
      if (isWeb) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: (attempt) =>
      buildDraftAgentSnapshot({
        attempt,
        serverId,
        tabId,
        workspaceDirectory: draftWorkingDirectory,
        arenaThinking: arenaPreferences.thinking,
      }),
    createRequest: async ({ attempt, text, images, attachments, cwd }) =>
      submitDraftCreateRequest({
        attempt,
        text,
        images,
        attachments,
        cwd,
        client,
        workspaceDirectory: draftWorkingDirectory,
        workspaceId: workspaceFields?.id ?? null,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
        arenaPreferenceKey,
        featureValues: composerState.featureValues,
        createdPreferenceKey: (agentId) => arenaAgentPreferenceKey(serverId, agentId),
        handOffStartedBattle: (agentId, snapshot) => {
          queryClient.setQueryData(arenaSessionQueryKey(serverId, agentId), snapshot);
          markArenaBattleHandoff({ serverId, agentId });
        },
        queueBattlePrompt: (agentId, promptText, promptImages) => {
          // Held, not sent. It never enters the in-memory queue, because that queue drains itself
          // and a battle must not start while the user is still talking through the conflict.
          savePendingBattlePrompt({ serverId, agentId, text: promptText, images: promptImages });
        },
      }),
    onCreateSuccess: ({ result }) => {
      clearDraftInput("sent");
      clearWorkspaceAttachments({ scopeKey: draftAttachmentScopeKey });
      useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
      onCreated(result);
    },
  });
  const turnPresentation = useMemo(
    () => resolveTurnPresentation(TURN_LIVENESS_IDLE, pendingMessageSubmissions.length > 0),
    [pendingMessageSubmissions],
  );
  useAgentControlCommandCenterActions({
    sourceId: `draft:${serverId}:${tabId}`,
    enabled: false,
    controls: {
      serverId,
      ownerKey: tabId,
      provider: draftProvider,
      providerDefinitions: draftProviderDefinitions,
      models: {
        providers: composerState.modelSelectorProviders,
        selectedProvider: draftProvider,
        selectedModelId: composerState.effectiveModelId,
        select: composerState.setProviderAndModelFromUser,
      },
      thinking: {
        options: draftThinkingOptions,
        selectedId: draftSelectedThinkingId,
        select: draftSetThinkingOption,
      },
      modes: {
        options: draftModeOptions,
        selectedId: draftSelectedMode,
        select: draftSetMode,
      },
      features: {
        list: draftFeatures,
        set: draftOnSetFeature,
      },
    },
  });
  const isReadyForPendingAutoSubmit = Boolean(
    pendingAutoSubmit &&
    draftInput.isHydrated &&
    draftWorkingDirectory &&
    client &&
    !composerState.isModelLoading,
  );
  const autoSubmitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReadyForPendingAutoSubmit) {
      return;
    }
    const submitKey = `${serverId}:${workspaceId}:${draftId}`;
    if (autoSubmitKeyRef.current === submitKey) {
      return;
    }
    const submission = consumePendingAutoSubmit({ serverId, workspaceId, draftId });
    if (!submission) {
      return;
    }
    autoSubmitKeyRef.current = submitKey;
    setDraftText("");
    setDraftAttachments([]);
    const preparedAttempt =
      initialCreateAttempt?.clientMessageId === submission.clientMessageId
        ? initialCreateAttempt
        : null;
    const createPromise = preparedAttempt
      ? continueCreateFromAttempt({
          attempt: preparedAttempt,
          cwd: submission.cwd,
        })
      : handleCreateFromInput({
          text: submission.text,
          attachments: submission.attachments,
          cwd: submission.cwd,
        });
    void createPromise.catch((error: unknown) => {
      const draft = {
        text: submission.text,
        attachments: composerWorkspaceAttachment.userAttachmentsOnly(submission.attachments),
      };
      if (
        client &&
        returnFailedFirstSendToNewChat(
          { serverId, workspaceId, error, draft },
          failedFirstSendDeps({ client, showError: toast.error }),
        )
      ) {
        return;
      }
      setDraftText(draft.text);
      setDraftAttachments(draft.attachments);
      autoSubmitKeyRef.current = null;
    });
  }, [
    continueCreateFromAttempt,
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    initialCreateAttempt,
    isReadyForPendingAutoSubmit,
    client,
    serverId,
    setDraftAttachments,
    setDraftText,
    toast.error,
    workspaceId,
  ]);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

  const { style: composerKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const inputAreaWrapperStyle = useMemo(
    () => [
      animatedStaticStyles.inputAreaWrapper,
      { paddingBottom: insets.bottom },
      composerKeyboardStyle,
    ],
    [insets.bottom, composerKeyboardStyle],
  );

  const handleDropdownCloseFocus = useCallback(() => {
    focusInputRef.current?.();
  }, []);
  const composerAgentControls = useMemo(
    () => ({
      ...composerState.agentControls,
      thinkingOptions: [...ARENA_THINKING_OPTIONS],
      selectedThinkingOptionId: arenaPreferences.thinking,
      onSelectThinkingOption: (thinking: string) => {
        if (!ARENA_THINKING_OPTIONS.some((option) => option.id === thinking)) return;
        arenaPreferences.setThinking(thinking as ArenaThinkingLevel);
      },
      battleMode: arenaPreferences.battleMode,
      onBattleModeChange: arenaPreferences.setBattleMode,
      battleModeDisabled: isSubmitting,
      onDropdownClose: handleDropdownCloseFocus,
      disabled: isSubmitting,
    }),
    [arenaPreferences, composerState.agentControls, handleDropdownCloseFocus, isSubmitting],
  );
  const isStartingBattle = isStartingArenaBattle({
    battleMode: arenaPreferences.battleMode,
    isCreating: machine.tag === "creating",
  });
  return (
    <FileDropZone style={styles.container}>
      <View style={styles.contentContainer}>
        {isSubmitting && draftAgent ? (
          <View style={styles.streamContainer}>
            {arenaPreferences.battleMode && machine.tag === "creating" ? (
              <View style={styles.draftBattleListPadding}>
                <ArenaContentColumn fullBleed>
                  <ArenaDraftBattleView
                    prompt={machine.attempt.text}
                    timestamp={machine.attempt.timestamp.getTime()}
                  />
                </ArenaContentColumn>
              </View>
            ) : (
              <AgentStreamView
                agentId={tabId}
                serverId={serverId}
                context={draftAgent}
                streamItems={submittedStreamItems}
                pendingMessageSubmissions={pendingMessageSubmissions}
                turnPresentation={turnPresentation}
                pendingPermissions={EMPTY_PENDING_PERMISSIONS}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            )}
          </View>
        ) : (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.configScrollContent}>
            <View style={styles.configSection}>
              {formErrorMessage ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>{formErrorMessage}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </View>

      <DraftInputSlot startingBattle={isStartingBattle}>
        <ReanimatedAnimated.View style={inputAreaWrapperStyle} onLayout={onInputAreaLayout}>
          <Composer
            agentId={tabId}
            serverId={serverId}
            workspaceId={workspaceId}
            externalKeyboardShift
            isPaneFocused={isPaneFocused}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isSubmitting}
            blurOnSubmit={true}
            value={draftInput.text}
            onChangeText={draftInput.setText}
            attachments={draftInput.attachments}
            attachmentScopeKeys={attachmentScopeKeys}
            onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
            onChangeAttachments={draftInput.setAttachments}
            cwd={composerState.workingDir}
            clearDraft={draftInput.clear}
            autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
            autoFocusKey={String(draftInput.attachmentFocusRequestId)}
            onFocusInput={handleFocusInputCallback}
            commandDraftConfig={composerState.commandDraftConfig}
            agentControls={composerAgentControls}
            isCompactLayout={isCompactComposerLayout}
            maxImages={arenaComposerMaxImages(arenaPreferences.battleMode)}
          />
        </ReanimatedAnimated.View>
      </DraftInputSlot>
    </FileDropZone>
  );
}

/** Setup progress lives in the stream; a failed start restores the draft composer. */
function DraftInputSlot({
  startingBattle,
  children,
}: {
  startingBattle: boolean;
  children: ReactNode;
}) {
  return startingBattle ? null : children;
}

const animatedStaticStyles = RNStyleSheet.create({
  inputAreaWrapper: {
    width: "100%",
  },
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
  },
  streamContainer: {
    flex: 1,
  },
  // Mirrors the stream list's own padding, so a draft battle sits exactly where it will once
  // it renders inside the stream: same width, and the same distance down. The top inset is the
  // scroll's own head — its padding plus the slot it keeps for the older-history spinner — and
  // without it the whole conversation dropped by that much when the real stream took over.
  draftBattleListPadding: {
    flex: 1,
    paddingTop: STREAM_CONTENT_TOP_INSET,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  scrollView: {
    flex: 1,
  },
  configScrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  configSection: {
    gap: theme.spacing[3],
  },
  errorContainer: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
