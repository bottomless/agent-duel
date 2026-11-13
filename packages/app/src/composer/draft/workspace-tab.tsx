import { SINGLE_AGENT_MODELS } from "@/arena/single-agent";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { Keyboard, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import type { ComposerEditingSession } from "@/composer/editing-session";
import { STREAM_CONTENT_TOP_INSET } from "@/agent-stream/spacing";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "@/composer/draft/create-flow";
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
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import {
  isReadyForPendingAutoSubmit,
  isStartingArenaBattle,
  resolveDraftCreateFeatureValues,
  resolveDraftWorkingDirectory,
  shouldAllowEmptyDraftText,
} from "@/composer/draft/workspace-tab-core";
import { DRAFT_CAPABILITIES } from "@/composer/draft/timeline";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { ArenaPromptAttachments, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
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
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";
import { archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import {
  FirstSendError,
  returnFailedFirstSendToNewChat,
  useFailedFirstSendNotice,
  type FailedFirstSendDeps,
} from "@/composer/draft/failed-first-send";
import { openWorkspaceSidePanelTab } from "@/workspace/side-panel-command";
import { noticeAccountSessionRejection } from "@/accounts/session-rejected";
import { neutralBattleStartError } from "@/arena/battle-start-error";
import { forgetLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

// Before createAgent, so a folder that cannot battle leaves no agent behind.
async function checkBattleCanStart(input: { client: DaemonClient; cwd: string }): Promise<void> {
  await arenaByokKey.ensure(input.client);
  await ensureBattleRepository({ client: input.client, cwd: input.cwd });
}

async function submitDraftCreateRequest(input: {
  draftId: string;
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
  providerOptions?: Record<string, unknown>;
  /** What plugins set on the agent this draft creates. */
  metadata: Record<string, JsonValue>;
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
    model: SINGLE_AGENT_MODELS[arenaPreferences.modelSize].model,
    thinkingOptionId: SINGLE_AGENT_MODELS[arenaPreferences.modelSize].thinking,
    providerOptions: input.providerOptions,
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
  const options = {
    idempotencyKey: input.draftId,
    config,
    workspaceId,
    ...(!arenaPreferences.battleMode && text ? { initialPrompt: text } : {}),
    ...(!arenaPreferences.battleMode ? { clientMessageId: attempt.clientMessageId } : {}),
    ...(Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
    ...(!arenaPreferences.battleMode ? promptAttachments : {}),
  };
  const creation = useWorkspaceDraftSubmissionStore.getState().creationByDraftId[input.draftId];
  const result = creation ? await creation.retry(options) : await client.createAgent(options);

  if (result.id) {
    copyArenaPreferences(input.arenaPreferenceKey, input.createdPreferenceKey(result.id));
  }
  if (arenaPreferences.battleMode) {
    if (!result.id) throw new Error("Created OpenCode agent did not return an id");
    try {
      await startDraftBattle({ ...input, client, agentId: result.id, promptAttachments });
    } catch (error) {
      throw new FirstSendError(
        neutralBattleStartError(noticeAccountSessionRejection(error)),
        result.id,
      );
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
  showError: FailedFirstSendDeps["showError"];
  retryMessage: string;
  diskFullMessage: string;
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
    forgetWorkspace: (serverId, workspaceId) =>
      forgetLastWorkspaceSelection({ serverId, workspaceId }),
    navigate: (route) => router.replace(route),
    showError: input.showError,
    retryMessage: input.retryMessage,
    diskFullMessage: input.diskFullMessage,
    archiveWorkspace: async (serverId, workspaceId) => {
      await archiveWorkspaceOptimistically({
        client: input.client,
        workspace: { serverId, workspaceId },
      });
    },
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
    turn: { phase: "idle", cancellationRequestId: null },
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
    thinkingOptionId,
    parentAgentId: null,
    labels: {},
  };
}

/** Every draft starts on the arena provider; the battle setup picks the real models. */
function buildDraftInitialValues(): CreateAgentInitialValues {
  return {
    provider: ARENA_PROVIDER,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: "high",
  };
}

interface WorkspaceDraftComposerProps {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  initialSetup?: WorkspaceDraftTabSetup;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
}

/**
 * Creates the agent from the draft's first prompt. The conversation panel shows that prompt in
 * the timeline from the create-flow store while the agent is created; a battle draft shows its
 * setup through `useDraftBattleStart` instead, and this composer stays hidden until a start fails.
 */
export function WorkspaceDraftComposer({
  serverId,
  workspaceId,
  tabId,
  draftId,
  initialSetup = undefined,
  isPaneFocused,
  editingSession,
  onCreated,
}: WorkspaceDraftComposerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
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
  const draftInitialValues = buildDraftInitialValues();
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
      initialProviderOptions: draftSetup?.providerOptions,
      isVisible: true,
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
  const draftOptionControls = composerState.agentControls.optionControls;

  const clearDraftInput = draftInput.clear;
  const replaceDraftText = draftInput.replaceText;
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
    if (!pendingCreateAttempt) {
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
  }, [pendingCreateAttempt]);
  const allowsEmptyAutoSubmit = pendingAutoSubmit?.allowEmptyText === true;
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_CONTENT_WIDTH,
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
    handleCreateFromInput,
    continueCreateFromAttempt,
  } = useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
    draftId,
    getPendingServerId: () => serverId,
    initialAttempt: initialCreateAttempt,
    allowEmptyText: allowsEmptyAutoSubmit,
    validateBeforeSubmit: ({ text, attachments }) => {
      if (!draftWorkingDirectory) return "Workspace directory is required.";
      if (!client || !isConnected) return t("workspace.terminal.hostDisconnected");
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
    createRequest: async ({ attempt, text, images, attachments, cwd }) => {
      if (pendingAutoSubmit?.agentCreation) {
        const result = await pendingAutoSubmit.agentCreation.result;
        return { agentId: result.id, result };
      }
      return submitDraftCreateRequest({
        draftId,
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
        providerOptions: resolveDraftCreateFeatureValues({
          submitted: pendingAutoSubmit?.providerOptions,
          draft: composerState.providerOptions,
        }),
        metadata: composerState.metadata,
        createdPreferenceKey: (agentId) => arenaAgentPreferenceKey(serverId, agentId),
        handOffStartedBattle: (agentId, snapshot) => {
          queryClient.setQueryData(arenaSessionQueryKey(serverId, agentId), snapshot);
          markArenaBattleHandoff({ serverId, agentId });
        },
        queueBattlePrompt: (agentId, promptText, promptImages) => {
          // Held, not sent. It never enters the in-memory queue, because that queue drains
          // itself and a battle must not start while the user is still talking through the
          // conflict.
          savePendingBattlePrompt({ serverId, agentId, text: promptText, images: promptImages });
        },
      });
    },
    onCreateSuccess: ({ result }) => {
      clearDraftInput("sent");
      clearWorkspaceAttachments({ scopeKey: draftAttachmentScopeKey });
      useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
      onCreated(result);
    },
  });
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
        select: (provider, modelId) => {
          composerState.setProviderAndModelFromUser(provider, modelId);
        },
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
      optionControls: draftOptionControls ?? null,
    },
  });
  const isReadyForAutoSubmit = isReadyForPendingAutoSubmit({
    hasPendingSubmission: pendingAutoSubmit !== null,
    isHydrated: draftInput.isHydrated,
    workingDirectory: draftWorkingDirectory,
    hasClient: client !== null,
  });
  const autoSubmitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReadyForAutoSubmit) {
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
    replaceDraftText("");
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
          failedFirstSendDeps({
            client,
            showError: useFailedFirstSendNotice.getState().show,
            retryMessage: t("common.errors.firstSendRetry"),
            diskFullMessage: t("common.errors.firstSendDiskFull"),
          }),
        )
      ) {
        return;
      }
      replaceDraftText(draft.text);
      setDraftAttachments(draft.attachments);
      autoSubmitKeyRef.current = null;
    });
  }, [
    continueCreateFromAttempt,
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    initialCreateAttempt,
    isReadyForAutoSubmit,
    client,
    serverId,
    setDraftAttachments,
    replaceDraftText,
    t,
    workspaceId,
  ]);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

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
      modelSize: arenaPreferences.modelSize,
      onModelSizeChange: arenaPreferences.setModelSize,
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
    <DraftInputSlot startingBattle={isStartingBattle}>
      <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
        {formErrorMessage ? (
          <View style={styles.formErrorRow}>
            <View style={styles.formError}>
              <Text style={styles.errorText}>{formErrorMessage}</Text>
            </View>
          </View>
        ) : null}
        <Composer
          agentId={tabId}
          serverId={serverId}
          workspaceId={workspaceId}
          isPaneFocused={isPaneFocused}
          onSubmitMessage={handleCreateFromInput}
          isSubmitLoading={isSubmitting}
          blurOnSubmit={true}
          textSource={draftInput.textSource}
          onChangeText={draftInput.editText}
          textReplacement={draftInput.textReplacement}
          attachments={draftInput.attachments}
          attachmentScopeKeys={attachmentScopeKeys}
          onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
          onChangeAttachments={draftInput.setAttachments}
          cwd={composerState.workingDir}
          clearDraft={draftInput.clear}
          editingSession={editingSession}
          autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
          autoFocusKey={String(draftInput.attachmentFocusRequestId)}
          onFocusInput={handleFocusInputCallback}
          commandDraft={composerState.commandDraft}
          agentControls={composerAgentControls}
          isCompactLayout={isCompactComposerLayout}
          maxImages={arenaComposerMaxImages(arenaPreferences.battleMode)}
        />
      </View>
    </DraftInputSlot>
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

export interface DraftBattleStart {
  prompt: string;
  timestamp: number;
}

/**
 * The battle a draft is starting while its agent is created, or null when the draft is not
 * starting one. A battle draft's conversation shows `DraftBattleTimeline` for it in place of the
 * pending prompt row the draft timeline holds.
 */
export function useDraftBattleStart(input: {
  serverId: string;
  draftId: string | null;
}): DraftBattleStart | null {
  const { serverId, draftId } = input;
  const { battleMode } = useArenaPreferences(arenaDraftPreferenceKey(serverId, draftId ?? ""));
  const pending = useCreateFlowStore((state) =>
    draftId ? state.pendingByDraftId[draftId] : undefined,
  );
  const starting =
    pending?.serverId === serverId &&
    isStartingArenaBattle({ battleMode, isCreating: pending.lifecycle === "active" })
      ? pending
      : null;
  const prompt = starting?.text ?? null;
  const timestamp = starting?.timestamp ?? null;
  return useMemo(
    () => (prompt !== null && timestamp !== null ? { prompt, timestamp } : null),
    [prompt, timestamp],
  );
}

export function DraftBattleTimeline({ prompt, timestamp }: DraftBattleStart) {
  return (
    <View style={styles.draftBattleListPadding}>
      <ArenaContentColumn fullBleed>
        <ArenaDraftBattleView prompt={prompt} timestamp={timestamp} />
      </ArenaContentColumn>
    </View>
  );
}

const animatedStaticStyles = RNStyleSheet.create({
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  formErrorRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
  },
  // Mirrors the stream list's own padding, so a draft battle sits exactly where it will once
  // it renders inside the stream: same width, and the same distance down. The top inset is the
  // scroll's own head — its padding plus the slot it keeps for the older-history spinner — and
  // without it the whole conversation dropped by that much when the real stream took over.
  draftBattleListPadding: {
    flex: 1,
    paddingTop: STREAM_CONTENT_TOP_INSET,
    // The web stream's gutter, so the battle does not shift when the stream takes over.
    paddingHorizontal: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
  },
  formError: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    marginBottom: theme.spacing[2],
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
