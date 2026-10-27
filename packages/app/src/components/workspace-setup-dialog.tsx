import { SINGLE_AGENT_MODELS, type SingleAgentModelSize } from "@/arena/single-agent";
import { KeyboardTranslateView } from "@/keyboard/shift";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { Composer } from "@/composer";
import { ProjectIconView } from "@/components/project-icon-view";
import { ICON_SIZE } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useProjectIcon } from "@/projects/icons";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { encodeImages } from "@/utils/encode-images";
import { toErrorMessage } from "@/utils/error-messages";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { MessagePayload } from "@/composer/types";
import {
  ARENA_PROVIDER,
  ARENA_THINKING_OPTIONS,
  arenaAgentPreferenceKey,
  arenaDraftPreferenceKey,
  type ArenaThinkingLevel,
} from "@/arena/constants";
import { arenaComposerMaxImages } from "@/arena/composer-state";
import { copyArenaPreferences, useArenaPreferences } from "@/arena/preferences";
import { markArenaBattleHandoff } from "@/arena/battle-handoff";
import { arenaSessionQueryKey } from "@/arena/use-arena-session";
import { ensureBattleRepository } from "@/arena/battle-repository";
import { arenaByokKey } from "@/byok/key";

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null;
  }
  return `data:${icon.mimeType};base64,${icon.data}`;
}

const SNAP_POINTS: string[] = ["82%", "94%"];

function resolveWorkspaceTitle({
  workspace,
  displayName,
  sourceDirectory,
}: {
  workspace: { name?: string | null; projectDisplayName?: string | null } | null;
  displayName: string;
  sourceDirectory: string;
}): string {
  return (
    workspace?.name ||
    workspace?.projectDisplayName ||
    displayName ||
    sourceDirectory.split(/[\\/]/).findLast(Boolean) ||
    sourceDirectory
  );
}

function buildChatDraftComposerArgs({
  serverId,
  workspaceDirectory,
  sourceDirectory,
  pendingWorkspaceSetup,
}: {
  serverId: string;
  workspaceDirectory: string | undefined;
  sourceDirectory: string;
  pendingWorkspaceSetup: { creationMethod: string } | null;
}) {
  return {
    initialServerId: serverId || null,
    initialValues: {
      provider: ARENA_PROVIDER,
      model: SINGLE_AGENT_MODELS.medium.model,
      thinkingOptionId: "high",
    },
    isVisible: pendingWorkspaceSetup !== null,
    lockedWorkingDir: workspaceDirectory || sourceDirectory || undefined,
  };
}

async function callWorkspaceCreation({
  creationMethod,
  connectedClient,
  creationId,
  worktreeSlug,
  input,
}: {
  creationMethod: "create_worktree" | "open_project";
  connectedClient: DaemonClient;
  creationId: string;
  worktreeSlug: string;
  input: { cwd: string; agent?: CreateWorkspaceRequestOptions["agent"] };
}) {
  return connectedClient.createWorkspace({
    idempotencyKey: creationId,
    agent: input.agent,
    source:
      creationMethod === "create_worktree"
        ? { kind: "worktree", cwd: input.cwd, worktreeSlug }
        : { kind: "directory", path: input.cwd },
  });
}

function failureMessageForCreationMethod(
  method: "create_worktree" | "open_project",
  t: ReturnType<typeof useTranslation>["t"],
) {
  return method === "create_worktree"
    ? t("workspaceSetup.errors.failedCreateWorktree")
    : t("workspaceSetup.errors.failedOpenProject");
}

function buildCreateAgentOptions({
  text,
  attachments,
  encodedImages,
  workspaceDirectory,
  workspaceId,
  battleMode,
  modelSize,
}: {
  text: string;
  attachments: NonNullable<CreateAgentRequestOptions["attachments"]>;
  encodedImages: NonNullable<CreateAgentRequestOptions["images"]> | null;
  workspaceDirectory: string;
  workspaceId: string;
  battleMode: boolean;
  modelSize: SingleAgentModelSize;
}): CreateAgentRequestOptions {
  return {
    provider: ARENA_PROVIDER,
    cwd: workspaceDirectory,
    workspaceId,
    model: SINGLE_AGENT_MODELS[modelSize].model,
    thinkingOptionId: SINGLE_AGENT_MODELS[modelSize].thinking,
    ...(!battleMode && text.trim() ? { initialPrompt: text.trim() } : {}),
    ...(!battleMode && encodedImages && encodedImages.length > 0 ? { images: encodedImages } : {}),
    ...(!battleMode && attachments.length > 0 ? { attachments } : {}),
  };
}

export function WorkspaceSetupDialog() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const pendingWorkspaceSetup = useWorkspaceSetupStore((state) => state.pendingWorkspaceSetup);
  const clearWorkspaceSetup = useWorkspaceSetupStore((state) => state.clearWorkspaceSetup);
  const mergeWorkspaces = useCallback(
    (targetServerId: string, workspaces: Iterable<WorkspaceDescriptor>) => {
      getHostRuntimeStore().acceptWorkspaceSnapshots(targetServerId, Array.from(workspaces));
    },
    [],
  );
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | null>(null);

  const serverId = pendingWorkspaceSetup?.serverId ?? "";
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeSearch === true,
  );
  const sourceDirectory = pendingWorkspaceSetup?.sourceDirectory ?? "";
  const draftKey = `workspace-setup:${serverId}:${sourceDirectory}`;
  const arenaPreferenceKey = arenaDraftPreferenceKey(serverId, draftKey);
  const arenaPreferences = useArenaPreferences(arenaPreferenceKey);
  const displayName = pendingWorkspaceSetup?.displayName?.trim() ?? "";
  const workspace = createdWorkspace;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: buildChatDraftComposerArgs({
      serverId,
      workspaceDirectory: workspace?.workspaceDirectory,
      sourceDirectory,
      pendingWorkspaceSetup,
    }),
  });
  const composerState = chatDraft.composerState;
  if (!composerState && pendingWorkspaceSetup) {
    throw new Error(t("workspaceSetup.errors.composerStateRequired"));
  }

  const { icon: projectIcon } = useProjectIcon({
    serverId,
    cwd: sourceDirectory,
  });
  const iconDataUri = toProjectIconDataUri(projectIcon);

  useEffect(() => {
    setErrorMessage(null);
    setCreatedWorkspace(null);
    setPendingAction(null);
  }, [pendingWorkspaceSetup?.creationId]);

  const handleClose = useCallback(() => {
    clearWorkspaceSetup();
  }, [clearWorkspaceSetup]);

  const navigateAfterCreation = useCallback(
    (
      workspaceId: string,
      target: { kind: "agent"; agentId: string } | { kind: "terminal"; terminalId: string },
    ) => {
      if (!pendingWorkspaceSetup) {
        return;
      }

      clearWorkspaceSetup();
      if (target.kind === "agent") {
        navigateToAgent({
          serverId: pendingWorkspaceSetup.serverId,
          agentId: target.agentId,
        });
        return;
      }

      navigateToWorkspace({
        serverId: pendingWorkspaceSetup.serverId,
        workspaceId,
        target,
      });
    },
    [clearWorkspaceSetup, pendingWorkspaceSetup],
  );

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error(t("workspaceSetup.errors.hostDisconnected"));
    }
    return client;
  }, [client, isConnected, t]);

  const ensureWorkspace = useCallback(
    async (input: {
      cwd: string;
      attachments: MessagePayload["attachments"];
      agent?: CreateWorkspaceRequestOptions["agent"];
      onAgentCreated?: (agent: AgentSnapshotPayload) => void;
    }) => {
      if (!pendingWorkspaceSetup) {
        throw new Error(t("workspaceSetup.errors.pendingRequired"));
      }

      if (createdWorkspace && !input.agent) {
        return createdWorkspace;
      }

      const connectedClient = withConnectedClient();
      const payload = await callWorkspaceCreation({
        creationMethod: pendingWorkspaceSetup.creationMethod,
        creationId: pendingWorkspaceSetup.creationId,
        worktreeSlug: pendingWorkspaceSetup.worktreeSlug,
        connectedClient,
        input,
      });

      if (payload.error || !payload.workspace) {
        throw new Error(
          payload.error ?? failureMessageForCreationMethod(pendingWorkspaceSetup.creationMethod, t),
        );
      }

      if (payload.agent) input.onAgentCreated?.(payload.agent);
      const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
      mergeWorkspaces(pendingWorkspaceSetup.serverId, [normalizedWorkspace]);
      if (pendingWorkspaceSetup.creationMethod === "open_project") {
        setHasHydratedWorkspaces(pendingWorkspaceSetup.serverId, true);
      }
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      createdWorkspace,
      mergeWorkspaces,
      pendingWorkspaceSetup,
      setHasHydratedWorkspaces,
      t,
      withConnectedClient,
    ],
  );

  const getIsStillActive = useCallback(() => {
    const current = useWorkspaceSetupStore.getState().pendingWorkspaceSetup;
    return (
      current?.serverId === pendingWorkspaceSetup?.serverId &&
      current?.sourceDirectory === pendingWorkspaceSetup?.sourceDirectory &&
      current?.creationMethod === pendingWorkspaceSetup?.creationMethod
    );
  }, [
    pendingWorkspaceSetup?.creationMethod,
    pendingWorkspaceSetup?.serverId,
    pendingWorkspaceSetup?.sourceDirectory,
  ]);

  const handleCreateChatAgent = useCallback(
    async ({ text, attachments, cwd }: MessagePayload) => {
      try {
        setPendingAction("chat");
        setErrorMessage(null);
        if (arenaPreferences.battleMode) {
          await arenaByokKey.ensure(withConnectedClient());
          await ensureBattleRepository({ client: withConnectedClient(), cwd });
        }

        if (!composerState) {
          throw new Error(t("workspaceSetup.errors.composerStateRequired"));
        }
        const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
          format: resolveComposerAttachmentSubmitFormat({
            supportsForgeAttachments: supportsForgeSearch,
          }),
        });
        const encodedImages = await encodeImages(wirePayload.images);
        if (!pendingWorkspaceSetup) throw new Error(t("workspaceSetup.errors.pendingRequired"));
        let createdAgent: AgentSnapshotPayload | undefined;
        const { workspaceId: _workspaceId, ...agentInput } = buildCreateAgentOptions({
          text,
          attachments: wirePayload.attachments,
          encodedImages: encodedImages ?? null,
          workspaceDirectory: cwd,
          workspaceId: "",
          modelSize: arenaPreferences.modelSize,
          battleMode: arenaPreferences.battleMode,
        });
        const ensuredWorkspace = await ensureWorkspace({
          cwd,
          attachments,
          agent: {
            ...agentInput,
            clientMessageId: `${pendingWorkspaceSetup.creationId}:initial-message`,
          },
          onAgentCreated: (value) => {
            createdAgent = value;
          },
        });
        if (!createdAgent) throw new Error("The daemon did not create the requested agent");
        const agent = createdAgent;
        copyArenaPreferences(arenaPreferenceKey, arenaAgentPreferenceKey(serverId, agent.id));
        if (arenaPreferences.battleMode) {
          const connectedClient = withConnectedClient();
          const snapshot = await connectedClient.arenaResolve(agent.id);
          const started = await connectedClient.arenaStart(agent.id, snapshot.chat.id, text, {
            ...(encodedImages && encodedImages.length > 0 ? { images: encodedImages } : {}),
            ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
          });
          // The panel this navigates to paints the started battle from here, rather than
          // spinning over a new agent until the daemon's history for it lands.
          queryClient.setQueryData(arenaSessionQueryKey(serverId, agent.id), started);
          markArenaBattleHandoff({ serverId, agentId: agent.id });
        }

        if (!getIsStillActive()) {
          return;
        }

        getHostRuntimeStore().acceptAgentSnapshot(
          serverId,
          applyLegacyDaemonWorkspaceOwnership({
            serverId,
            agent: normalizeAgentSnapshot(agent, serverId),
          }),
        );
        navigateAfterCreation(ensuredWorkspace.id, { kind: "agent", agentId: agent.id });
      } catch (error) {
        const message = toErrorMessage(error);
        setErrorMessage(message);
        toast.error(message);
      } finally {
        if (getIsStillActive()) {
          setPendingAction(null);
        }
      }
    },
    [
      composerState,
      arenaPreferenceKey,
      arenaPreferences,
      pendingWorkspaceSetup,
      getIsStillActive,
      navigateAfterCreation,
      queryClient,
      serverId,
      ensureWorkspace,
      t,
      toast,
      withConnectedClient,
      supportsForgeSearch,
    ],
  );

  const workspaceTitle = resolveWorkspaceTitle({ workspace, displayName, sourceDirectory });

  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(workspaceTitle);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();

  const agentControlsWithDisabled = useMemo(
    () =>
      composerState
        ? {
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
            battleModeDisabled: pendingAction !== null,
            disabled: pendingAction !== null,
          }
        : undefined,
    [arenaPreferences, composerState, pendingAction],
  );

  const subtitleContent = useMemo(
    () => (
      <View style={styles.subtitleRow}>
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={placeholderInitial}
          projectViewKey={sourceDirectory}
          size={ICON_SIZE.md}
          textStyle={styles.projectIconFallbackText}
        />
        <Text style={styles.projectTitle} numberOfLines={1}>
          {workspaceTitle}
        </Text>
      </View>
    ),
    [iconDataUri, placeholderInitial, sourceDirectory, workspaceTitle],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("workspaceSetup.title"), subtitle: subtitleContent }),
    [subtitleContent, t],
  );

  if (!pendingWorkspaceSetup || !sourceDirectory) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={sheetHeader}
      visible={true}
      onClose={handleClose}
      snapPoints={SNAP_POINTS}
      testID="workspace-setup-dialog"
      desktopMaxWidth={640}
    >
      <FileDropZone style={styles.section}>
        <KeyboardTranslateView>
          <Composer
            agentId={`workspace-setup:${serverId}:${sourceDirectory}`}
            serverId={serverId}
            isPaneFocused={true}
            onSubmitMessage={handleCreateChatAgent}
            isSubmitLoading={pendingAction === "chat"}
            blurOnSubmit={true}
            textSource={chatDraft.textSource}
            onChangeText={chatDraft.editText}
            textReplacement={chatDraft.textReplacement}
            attachments={chatDraft.attachments}
            onChangeAttachments={chatDraft.setAttachments}
            cwd={sourceDirectory}
            clearDraft={chatDraft.clear}
            autoFocus
            commandDraft={composerState?.commandDraft}
            agentControls={agentControlsWithDisabled}
            inputWrapperStyle={styles.composerInputWrapper}
            maxImages={arenaComposerMaxImages(arenaPreferences.battleMode)}
          />
        </KeyboardTranslateView>
      </FileDropZone>

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectIconFallbackText: {
    fontSize: 9,
  },
  projectTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[3],
    marginHorizontal: -theme.spacing[6],
    marginVertical: -theme.spacing[2],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
  composerInputWrapper: {
    backgroundColor: theme.colors.surface2,
  },
}));
