import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsFocused } from "expo-router/react-navigation";
import { createNameId } from "mnemonic-id";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Composer } from "@/composer";
import { ComposerDock } from "@/composer/dock";
import { useComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useForgeSearchQuery } from "@/git/use-forge-search-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { ensureCheckoutStatus, refreshCheckoutStatus } from "@/git/checkout-status-cache";
import {
  checkoutStatusRefreshQueryKey,
  invalidateCheckoutGitQueriesForClient,
} from "@/git/query-keys";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import {
  useWorkspaceDraftSubmissionStore,
  type PendingWorkspaceDraftSetup,
} from "@/stores/workspace-draft-submission-store";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { toErrorMessage } from "@/utils/error-messages";
import {
  getHostProjectId,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveHostProjectCandidate,
  useHostProjects,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useProjectIcons } from "@/projects/icons";
import type { ComposerAttachment } from "@/attachments/types";
import { useDraftWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import type { MessagePayload } from "@/composer/types";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } from "./new-workspace-empty";
import {
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
} from "./new-workspace-fork-context";
import {
  type BaseRefCheckoutStatus,
  buildPickerOptionData,
  defaultBasePickerItem,
  pickerItemLabel,
  pickerItemToCheckoutRequest,
  type BranchPickerDetail,
  type PickerCheckoutRequest,
  type PickerItem,
  type PickerOptionData,
} from "./new-workspace-picker-item";
import {
  clearPickerPrAttachmentForTargetChange,
  initialPickerSelectionState,
  reducePickerSelection,
  syncPickerPrAttachment,
} from "./new-workspace-picker-state";
import {
  newBranchBaseItem,
  newBranchBaseLabel,
  newBranchPickerItem,
  resolveNewBranchBase,
  newBranchNameErrorMessage,
} from "./new-workspace-new-branch";
import {
  MissingSelectedBranchError,
  prepareLocalCheckout,
  validateSelectedBranch,
} from "./new-workspace-local-checkout";
import {
  resolveNewWorkspaceAutomaticServerId,
  resolveNewWorkspaceInitialServerId,
} from "./new-workspace-initial-context";
import { buildNewWorkspaceProjectIconTargets } from "./new-workspace/project-icon-targets";
import { useNewWorkspaceProjectPicker } from "./new-workspace/project-picker";
import { useNewWorkspaceForm } from "./new-workspace/form";
import { useNewWorkspaceScreenPresence } from "./new-workspace/screen-presence";
import {
  ARENA_PROVIDER,
  ARENA_BOOTSTRAP_MODEL,
  ARENA_THINKING_OPTIONS,
  arenaDraftPreferenceKey,
  type ArenaThinkingLevel,
} from "@/arena/constants";
import { arenaComposerMaxImages } from "@/arena/composer-state";
import {
  copyArenaPreferences,
  getArenaPreferences,
  useArenaPreferences,
} from "@/arena/preferences";
import { type BattleRepositoryClient, ensureBattleRepository } from "@/arena/battle-repository";

function useIsNewWorkspaceDraftHandoffActive(input: {
  draftId: string | undefined;
  selectedServerId: string;
}): boolean {
  const normalizedDraftId = input.draftId?.trim() ?? "";
  return useCreateFlowStore((state) =>
    isActiveCreateFlowForDraft({
      draftId: normalizedDraftId,
      serverId: input.selectedServerId,
      pending: normalizedDraftId ? state.pendingByDraftId[normalizedDraftId] : null,
    }),
  );
}

function useIsCheckoutStatusRefreshing(serverId: string, cwd: string | null): boolean {
  return (
    useIsFetching({
      queryKey: checkoutStatusRefreshQueryKey(serverId, cwd ?? ""),
      exact: true,
    }) > 0
  );
}

function useNewWorkspaceCheckoutStatus(input: {
  serverId: string;
  cwd: string | null;
  isolation: "local" | "worktree";
  selectedItem: PickerItem | null;
  hasWorkspace: boolean;
}) {
  const isScreenFocused = useIsFocused();
  const isAppVisible = useAppVisible();
  return useCheckoutStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd ?? "",
    followCheckout:
      input.isolation === "local" &&
      !input.selectedItem &&
      isScreenFocused &&
      isAppVisible &&
      !input.hasWorkspace,
  });
}

function resolveVisibleDraftContextScopeKeys(input: {
  isDraftHandoffActive: boolean;
  draftContextScopeKey: string;
}): readonly string[] {
  if (input.isDraftHandoffActive || !input.draftContextScopeKey) {
    return [];
  }
  return [input.draftContextScopeKey];
}

function isNewWorkspacePending(input: {
  pendingAction: "chat" | "empty" | null;
  isDraftHandoffActive: boolean;
}): boolean {
  return input.pendingAction !== null || input.isDraftHandoffActive;
}

function buildFirstAgentContext(input: {
  prompt: string;
  attachments: AgentAttachment[];
}): { prompt?: string; attachments?: AgentAttachment[] } | undefined {
  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt && input.attachments.length === 0) {
    return undefined;
  }

  return {
    ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
    attachments: input.attachments,
  };
}

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
}

// Stable reference so the keyboard-action handler doesn't re-register each render.
const PROJECT_PICK_ACTIONS: readonly KeyboardActionId[] = ["workspace.project.pick"];

interface WorkspaceIsolationState {
  isolation: "local" | "worktree";
  setIsolation: (value: "local" | "worktree") => void;
  effectiveIsolation: "local" | "worktree";
  canCreateWorktree: boolean;
}

// Local runs in the checkout, switched to the picked branch; a worktree is cut detached at
// the picked ref. The choice is remembered with the other New Workspace preferences and
// defaults to Local, so nothing is created outside the project unless asked. Once the
// authoritative placement arrives, a project that cannot host a worktree falls back to local.
function useWorkspaceIsolation(input: {
  supportsMultiplicity: boolean;
  worktreeSupport: "supported" | "unsupported" | "unknown";
}): WorkspaceIsolationState {
  const { supportsMultiplicity, worktreeSupport } = input;
  const { preferences, updatePreferences } = useFormPreferences();
  const [manualIsolation, setManualIsolation] = useState<"local" | "worktree" | null>(null);
  const isolation = manualIsolation ?? preferences.isolation ?? "local";
  const canCreateWorktree = supportsMultiplicity && worktreeSupport !== "unsupported";
  const isWorktree = isolation === "worktree" && canCreateWorktree;

  const setIsolation = useCallback(
    (value: "local" | "worktree") => {
      setManualIsolation(value);
      void updatePreferences({ isolation: value });
    },
    [updatePreferences],
  );

  return {
    isolation,
    setIsolation,
    effectiveIsolation: isWorktree ? "worktree" : "local",
    canCreateWorktree,
  };
}

interface CreateBranchDialogState {
  visible: boolean;
  /** Null when the source checkout offers no ref to cut from — a detached HEAD. */
  base: Extract<PickerItem, { kind: "branch" }> | null;
  title: string;
  /** Local mode moves the checkout, so the action says so. */
  submitLabel: string;
  open: () => void;
  close: () => void;
  validate: (value: string) => string | null;
  submit: (value: string) => Promise<void>;
}

/**
 * The picker's "New branch" row and the dialog behind it. In Worktree mode naming a branch
 * creates nothing — the name rides on the picked item until the worktree is cut. In Local mode
 * confirming the dialog runs git against the developer's own checkout there and then.
 */
function useCreateBranchDialog(input: {
  selectedItem: PickerItem | null;
  checkoutStatus: BaseRefCheckoutStatus | null | undefined;
  sourceDirectory: string | null;
  isolation: "local" | "worktree";
  serverId: string;
  withConnectedClient: () => DaemonClient;
  onNamed: (item: PickerItem) => void;
  closePicker: () => void;
}): CreateBranchDialogState {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    selectedItem,
    checkoutStatus,
    sourceDirectory,
    isolation,
    serverId,
    withConnectedClient,
    onNamed,
  } = input;
  const closePicker = input.closePicker;
  const [visible, setVisible] = useState(false);

  // A branch has to be cut from somewhere, and a pull request row carries no ref a branch can
  // sit on, so the checkout's default base stands in for it.
  const base = useMemo(
    () =>
      newBranchBaseItem(
        selectedItem,
        checkoutStatus ? defaultBasePickerItem(checkoutStatus) : null,
      ),
    [checkoutStatus, selectedItem],
  );

  const open = useCallback(() => {
    closePicker();
    setVisible(true);
  }, [closePicker]);
  const close = useCallback(() => setVisible(false), []);

  const validate = useCallback(
    (value: string): string | null => newBranchNameErrorMessage(value, t),
    [t],
  );

  const submit = useCallback(
    async (value: string) => {
      if (!base) throw new Error(t("newWorkspace.newBranch.errors.noBase"));
      if (!sourceDirectory) throw new Error("Choose a host for this project");
      const name = value.trim();
      // The suggestion list is search-filtered and capped, so the checkout itself decides
      // whether the name is free.
      const client = withConnectedClient();
      const validation = await client.validateBranch({
        cwd: sourceDirectory,
        branchName: name,
        refreshGit: true,
      });
      if (validation.error) throw new Error(validation.error);
      if (validation.exists) throw new Error(t("newWorkspace.newBranch.errors.exists"));
      // Same checkout, same question, for the base: is there a local branch of this name to
      // start from, and is the base still there at all?
      const probed = await client
        .validateBranch({
          cwd: sourceDirectory,
          branchName: newBranchBaseLabel(base.refName),
          refreshGit: true,
        })
        .catch(() => null);
      const resolvedBase = resolveNewBranchBase({ baseRefName: base.refName, probe: probed });
      if (resolvedBase.kind === "missing") {
        throw new Error(
          t("newWorkspace.newBranch.errors.baseMissing", { base: resolvedBase.branchName }),
        );
      }
      const baseRefName = resolvedBase.refName;

      // Local mode runs git here rather than at submit, because the branch is being made in the
      // checkout the developer is looking at: it should exist and be checked out the moment
      // they confirm, not once a whole workspace is created. A worktree cannot: it does not
      // exist yet, so there the name stays an argument to the create.
      if (isolation === "local") {
        // The base ref goes to git, so the branch starts where the dialog said it would no
        // matter where the checkout has moved to since — and fails if that ref is gone.
        const created = await client.createBranch({
          cwd: sourceDirectory,
          branch: name,
          baseRef: baseRefName,
        });
        if (!created.success) {
          throw new Error(
            created.error?.message ?? t("newWorkspace.newBranch.errors.createFailed"),
          );
        }
        // The checkout has moved; everything keyed to it is now describing the old branch.
        await invalidateCheckoutGitQueriesForClient(queryClient, {
          serverId,
          cwd: sourceDirectory,
        });
      }

      onNamed(
        isolation === "local"
          ? {
              kind: "branch",
              name,
              refName: `refs/heads/${name}`,
              accessibilityLabel: `${name}, local branch`,
            }
          : newBranchPickerItem({ name, baseRefName }),
      );
    },
    [base, isolation, onNamed, queryClient, serverId, sourceDirectory, t, withConnectedClient],
  );

  return {
    visible,
    base,
    title: t("newWorkspace.newBranch.title", {
      base: base ? newBranchBaseLabel(base.refName) : "",
    }),
    submitLabel: t(
      isolation === "local"
        ? "newWorkspace.newBranch.submitLocal"
        : "newWorkspace.newBranch.submit",
    ),
    open,
    close,
    validate,
    submit,
  };
}

/**
 * Picking a branch in Local mode moves the checkout there and then, the way the workspace branch
 * switcher does — the picker points at the developer's own working tree, so leaving it on one
 * branch while the form claims another is the confusing part, not the switch.
 *
 * Worktree mode never touches the source checkout: the picked ref is a starting point for a
 * worktree that does not exist yet.
 *
 * The selection is applied only once git agrees, so a refused switch leaves the picker showing
 * the branch the checkout is actually on rather than one nobody is standing on.
 */
function useLocalBranchSelection(input: {
  isolation: "local" | "worktree";
  sourceDirectory: string | null;
  serverId: string;
  withConnectedClient: () => DaemonClient;
  onSelected: (item: PickerItem) => void;
  onMissing: (item: PickerItem) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isolation, sourceDirectory, serverId, withConnectedClient, onSelected, onMissing } =
    input;
  const [isSelecting, setIsSelecting] = useState(false);

  const moveCheckout = useCallback(
    async (item: PickerItem): Promise<boolean> => {
      const cwd = sourceDirectory;
      if (isolation !== "local" || item.kind !== "branch" || !cwd) return true;
      try {
        const client = withConnectedClient();
        const status = await refreshCheckoutStatus({ queryClient, client, serverId, cwd });
        if (status.error) throw new Error(status.error.message);
        await prepareLocalCheckout({
          client,
          cwd,
          item,
          currentBranch: status.currentBranch,
          switchFailedMessage: t("newWorkspace.errors.switchBranchFailed"),
          createFailedMessage: t("newWorkspace.newBranch.errors.createFailed"),
          missingBranchMessage: t("newWorkspace.errors.branchMissing"),
        });
        await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
        return true;
      } catch (error) {
        if (error instanceof MissingSelectedBranchError) onMissing(item);
        toast.error(toErrorMessage(error));
        return false;
      }
    },
    [isolation, queryClient, serverId, sourceDirectory, t, toast, withConnectedClient, onMissing],
  );

  const select = useCallback(
    (item: PickerItem) => {
      setIsSelecting(true);
      void (async () => {
        try {
          const moved = await moveCheckout(item);
          if (moved) onSelected(item);
        } finally {
          setIsSelecting(false);
        }
      })();
    },
    [moveCheckout, onSelected],
  );
  return { select, isSelecting };
}

function normalizeBranchDetails(
  data: { branchDetails?: BranchPickerDetail[]; branches?: string[] } | undefined,
): BranchPickerDetail[] {
  const details = data?.branchDetails;
  if (details && details.length > 0) return details;
  const names = data?.branches ?? [];
  return names.map((name) => ({ name, committerDate: 0 }));
}

interface SubmitDraftInput {
  serverId: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  initialSetup?: WorkspaceDraftTabSetup;
  workspaceId: string;
  workspaceDirectory: string;
  text: string;
  attachments: ComposerAttachment[];
  supportsForgeSearch: boolean;
  arenaPreferenceKey: string;
  featureValues?: Record<string, unknown>;
}

interface WorkspaceDraftSubmissionConfig {
  cwd: string;
  provider: AgentProvider;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
  target: WorkspaceTabTarget;
}

/**
 * Local backs the workspace with the checkout that is already there: no worktree, no branch.
 * That is what "I picked the branch I am on" has to mean, since a second worktree cannot check
 * out a branch the source checkout is holding. Worktree cuts a new checkout at the picked ref.
 */
async function createMultiplicityWorkspace(input: {
  idempotencyKey: string;
  worktreeSlug: string;
  client: DaemonClient;
  isolation: "local" | "worktree";
  project: HostProjectListItem;
  sourceDirectory: string;
  checkoutRequest: PickerCheckoutRequest | undefined;
  /** Local only: the branch the checkout was switched to, so the daemon can refuse a stale one. */
  expectedBranch?: string | null;
  withInitialAgent: boolean;
  prompt: string;
  attachments: AgentAttachment[];
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const projectId = getHostProjectId(input.project, input.serverId);
  if (!projectId) throw new Error("Project is not available on the selected host");
  const isWorktree = input.isolation === "worktree";
  const firstAgentContext = buildFirstAgentContext({
    prompt: input.prompt,
    attachments: input.attachments,
  });
  const payload = await input.client.createWorkspace({
    idempotencyKey: input.idempotencyKey,
    source: isWorktree
      ? {
          kind: "worktree",
          cwd: input.sourceDirectory,
          projectId,
          worktreeSlug: input.worktreeSlug,
          ...input.checkoutRequest,
        }
      : {
          kind: "directory",
          path: input.sourceDirectory,
          projectId,
          ...(input.expectedBranch ? { expectedBranch: input.expectedBranch } : {}),
        },
    ...(firstAgentContext ? { firstAgentContext } : {}),
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? input.createFailedMessage);
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceForInitialMerge = input.withInitialAgent
    ? { ...normalizedWorkspace, status: "running" as const, statusEnteredAt: new Date() }
    : normalizedWorkspace;
  input.mergeWorkspaces(input.serverId, [workspaceForInitialMerge]);
  return normalizedWorkspace;
}

interface CreateChatAgentInput {
  payload: MessagePayload;
  composerState: ReturnType<typeof useAgentInputDraft>["composerState"];
  forkDraftSetup?: PendingWorkspaceDraftSetup | null;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  serverId: string;
  client: BattleRepositoryClient | null;
  draftKey: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  supportsForgeSearch: boolean;
  arenaPreferenceKey: string;
  labels: {
    composerStateRequired: string;
  };
}

function buildArenaWorkspaceDraftSetup(
  cwd: string,
  featureValues: Record<string, unknown> | undefined,
): WorkspaceDraftTabSetup {
  return {
    provider: ARENA_PROVIDER,
    cwd,
    modeId: null,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: null,
    featureValues: featureValues ?? {},
  };
}

function buildWorkspaceDraftSetupForCreatedWorkspace(input: {
  forkDraftSetup: PendingWorkspaceDraftSetup | null | undefined;
  workspaceDirectory: string;
  featureValues?: Record<string, unknown>;
}): WorkspaceDraftTabSetup | undefined {
  if (!input.forkDraftSetup) {
    return undefined;
  }
  return buildArenaWorkspaceDraftSetup(
    remapDraftCwdToWorkspace({
      cwd: input.forkDraftSetup.setup.cwd,
      sourceDirectory: input.forkDraftSetup.sourceDirectory,
      workspaceDirectory: input.workspaceDirectory,
    }),
    input.featureValues,
  );
}

function buildComposerInitialValues(input: {
  workingDir: string | undefined;
  initialSetup?: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (!input.initialSetup && !input.workingDir) {
    return undefined;
  }
  return {
    provider: ARENA_PROVIDER,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: "high",
  };
}

const pendingWorkspaceSubmissions = new Map<string, Promise<void>>();
function runCreateChatAgent(input: CreateChatAgentInput): Promise<void> {
  const key = JSON.stringify([input.serverId, input.draftId]);
  const pending = pendingWorkspaceSubmissions.get(key);
  if (pending) return pending;
  const submission = Promise.resolve().then(() => createWorkspaceChatAgent(input));
  pendingWorkspaceSubmissions.set(key, submission);
  void submission.finally(() => pendingWorkspaceSubmissions.delete(key)).catch(() => undefined);
  return submission;
}

// The chat's first message is not sent from here: the workspace is created empty and the draft
// tab it opens on sends the message, as a battle when Battle mode is on.
async function createWorkspaceChatAgent(input: CreateChatAgentInput): Promise<void> {
  const { payload, composerState, ensureWorkspace, serverId } = input;
  const { text, attachments, cwd } = payload;
  if (!composerState) {
    throw new Error(input.labels.composerStateRequired);
  }
  const arenaPreferences = getArenaPreferences(input.arenaPreferenceKey);
  const attachmentSubmitFormat = resolveComposerAttachmentSubmitFormat({
    supportsForgeAttachments: input.supportsForgeSearch,
  });
  const { attachments: reviewAttachments } = splitComposerAttachmentsForSubmit(attachments, {
    format: attachmentSubmitFormat,
  });
  const workspaceNamingAttachments = getWorkspaceNamingAttachments(reviewAttachments);
  if (arenaPreferences.battleMode && input.client) {
    // Before the workspace exists, so a folder that cannot battle leaves no empty chat behind.
    await ensureBattleRepository({ client: input.client, cwd });
  }
  const ensuredWorkspace = await ensureWorkspace({
    cwd,
    // The first Arena battle owns workspace naming: the prompt's first line,
    // then the title its comparison writes.
    prompt: arenaPreferences.battleMode ? "" : text,
    attachments: arenaPreferences.battleMode ? [] : workspaceNamingAttachments,
    withInitialAgent: true,
  });
  const initialSetup = buildWorkspaceDraftSetupForCreatedWorkspace({
    forkDraftSetup: input.forkDraftSetup,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    featureValues: composerState.featureValues,
  });
  submitWorkspaceDraft({
    serverId,
    clearDraft: input.clearDraft,
    draftId: input.draftId,
    initialSetup,
    workspaceId: ensuredWorkspace.id,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    text,
    attachments,
    supportsForgeSearch: input.supportsForgeSearch,
    arenaPreferenceKey: input.arenaPreferenceKey,
    featureValues: composerState.featureValues,
  });
}

function buildComposerConfig(input: {
  serverId: string;
  workspaceDirectory: string | null;
  sourceDirectory: string | null;
  initialSetup?: WorkspaceDraftTabSetup | null;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, workspaceDirectory, sourceDirectory, initialSetup } = input;
  const workingDir = workspaceDirectory || sourceDirectory || undefined;
  return {
    initialServerId: serverId || null,
    initialValues: buildComposerInitialValues({ workingDir, initialSetup }),
    initialFeatureValues: initialSetup?.featureValues,
    isVisible: true,
    lockedWorkingDir: workingDir,
  };
}

function usePendingWorkspaceDraftSetup(
  draftId: string | undefined,
): PendingWorkspaceDraftSetup | null {
  const normalizedDraftId = draftId?.trim() ?? "";
  return useWorkspaceDraftSubmissionStore((state) => {
    if (!normalizedDraftId) {
      return null;
    }
    return state.setupByDraftId[normalizedDraftId] ?? null;
  });
}

function resolveWorkspaceDraftSubmissionConfig(input: {
  draftId: string;
  workspaceDirectory: string;
  initialSetup?: WorkspaceDraftTabSetup;
  featureValues?: Record<string, unknown>;
}): WorkspaceDraftSubmissionConfig {
  const { draftId, workspaceDirectory, initialSetup } = input;
  if (initialSetup) {
    return {
      cwd: initialSetup.cwd,
      provider: ARENA_PROVIDER,
      modeId: null,
      model: ARENA_BOOTSTRAP_MODEL,
      thinkingOptionId: null,
      featureValues: input.featureValues ?? initialSetup.featureValues,
      target: { kind: "draft", draftId, setup: initialSetup },
    };
  }
  return {
    cwd: workspaceDirectory,
    provider: ARENA_PROVIDER,
    modeId: null,
    model: ARENA_BOOTSTRAP_MODEL,
    thinkingOptionId: null,
    featureValues: input.featureValues ?? {},
    target: { kind: "draft", draftId },
  };
}

function submitWorkspaceDraft(input: SubmitDraftInput): void {
  const {
    serverId,
    draftId: draftIdInput,
    workspaceId,
    workspaceDirectory,
    text,
    attachments,
    initialSetup,
  } = input;
  const draftId = draftIdInput?.trim() || generateDraftId();
  copyArenaPreferences(input.arenaPreferenceKey, arenaDraftPreferenceKey(serverId, draftId));
  const clientMessageId = `${draftId}:initial-message`;
  const timestamp = Date.now();
  const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
    format: resolveComposerAttachmentSubmitFormat({
      supportsForgeAttachments: input.supportsForgeSearch,
    }),
  });
  const submission = resolveWorkspaceDraftSubmissionConfig({
    draftId,
    workspaceDirectory,
    initialSetup,
    featureValues: input.featureValues,
  });
  const started = useCreateFlowStore.getState().trySetPending({
    serverId,
    draftId,
    workspaceId,
    agentId: null,
    clientMessageId,
    text: text.trim(),
    timestamp,
    ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
    ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
  });
  if (!started) return;
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId,
    workspaceId,
    draftId,
    text: text.trim(),
    attachments,
    cwd: submission.cwd,
    provider: submission.provider,
    clientMessageId,
    timestamp,
    ...(submission.modeId ? { modeId: submission.modeId } : {}),
    ...(submission.model ? { model: submission.model } : {}),
    ...(submission.thinkingOptionId ? { thinkingOptionId: submission.thinkingOptionId } : {}),
    ...(submission.featureValues ? { featureValues: submission.featureValues } : {}),
    allowEmptyText: true,
  });
  input.clearDraft("sent");
  navigateToWorkspace({
    serverId,
    workspaceId,
    target: submission.target,
  });
}

function useNewWorkspaceHostSelector(input: {
  initialServerId: string;
  allServerIds: string[];
  projects: HostProjectListItem[];
  lastActiveProject: HostProjectListItem | null;
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  const routeServerId = input.initialServerId.trim();
  const defaultServerId = useMemo(
    () =>
      resolveNewWorkspaceInitialServerId({
        allServerIds: input.allServerIds,
        routeServerId: input.initialServerId,
        lastActiveProject: input.lastActiveProject,
        projects: input.projects,
        hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
        workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
      }),
    [
      input.allServerIds,
      input.hostConnectionStatusByServerId,
      input.initialServerId,
      input.lastActiveProject,
      input.projects,
      input.workspaceMultiplicityByServerId,
    ],
  );
  const [automaticSelection, setAutomaticSelection] = useState(() => ({
    routeServerId,
    serverId: defaultServerId,
  }));

  useEffect(() => {
    setAutomaticSelection((current) => {
      const nextServerId =
        current.routeServerId === routeServerId
          ? resolveNewWorkspaceAutomaticServerId({
              allServerIds: input.allServerIds,
              routeServerId: input.initialServerId,
              lastActiveProject: input.lastActiveProject,
              projects: input.projects,
              hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
              workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
              currentServerId: current.serverId,
              nextServerId: defaultServerId,
            })
          : defaultServerId;

      if (current.routeServerId === routeServerId && current.serverId === nextServerId) {
        return current;
      }

      return { routeServerId, serverId: nextServerId };
    });
  }, [
    defaultServerId,
    input.allServerIds,
    input.hostConnectionStatusByServerId,
    input.initialServerId,
    input.lastActiveProject,
    input.projects,
    input.workspaceMultiplicityByServerId,
    routeServerId,
  ]);

  const automaticServerId =
    automaticSelection.routeServerId === routeServerId &&
    input.allServerIds.includes(automaticSelection.serverId)
      ? automaticSelection.serverId
      : defaultServerId;
  return { selectedServerId: automaticServerId };
}

interface NewWorkspaceInitialContextState {
  selectedServerId: string;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  routeProjectContextViewKey: string | null;
  lastActiveProject: HostProjectListItem | null;
}

function useNewWorkspaceInitialContext({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
}: NewWorkspaceScreenProps): NewWorkspaceInitialContextState {
  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);
  const routeDisplayName = displayNameProp?.trim() ?? "";
  const routePlacement = useMemo(
    () =>
      hostProjectFromRoute({
        serverId,
        projectId,
        displayName: routeDisplayName,
        sourceDirectory: sourceDirectoryProp,
      }),
    [projectId, routeDisplayName, serverId, sourceDirectoryProp],
  );
  const routeProject = useMemo(() => {
    if (!routePlacement) return null;
    return (
      resolveHostProjectCandidate({
        candidate: routePlacement,
        projects,
        serverId,
      }) ?? routePlacement
    );
  }, [projects, routePlacement, serverId]);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const lastWorkspaceServerId = useMemo(
    () =>
      lastWorkspaceSelection && allServerIds.includes(lastWorkspaceSelection.serverId)
        ? lastWorkspaceSelection.serverId
        : null,
    [allServerIds, lastWorkspaceSelection],
  );
  const lastWorkspaceId = lastWorkspaceServerId ? lastWorkspaceSelection!.workspaceId : null;
  const lastWorkspace = useWorkspace(lastWorkspaceServerId, lastWorkspaceId);
  const lastActiveProject = useMemo(
    () =>
      lastWorkspaceServerId
        ? hostProjectFromWorkspace({ serverId: lastWorkspaceServerId, workspace: lastWorkspace })
        : null,
    [lastWorkspace, lastWorkspaceServerId],
  );
  const hostConnectionStatusByServerId = useHostRuntimeConnectionStatuses(allServerIds);
  const workspaceMultiplicityByServerId = useHostFeatureMap(allServerIds, "workspaceMultiplicity");
  const { selectedServerId } = useNewWorkspaceHostSelector({
    initialServerId: serverId,
    allServerIds,
    projects,
    lastActiveProject,
    hostConnectionStatusByServerId,
    workspaceMultiplicityByServerId,
  });

  return {
    selectedServerId,
    projects,
    routeProject,
    routeProjectContextViewKey: routePlacement?.viewKey ?? null,
    lastActiveProject,
  };
}

export function NewWorkspaceScreen({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
  draftId,
}: NewWorkspaceScreenProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const composerEditing = useNewWorkspaceComposerEditing();
  const { leaveFullscreen } = composerEditing;
  const mergeWorkspaces = useCallback(
    (targetServerId: string, workspaces: Iterable<WorkspaceDescriptor>) => {
      getHostRuntimeStore().acceptWorkspaceSnapshots(targetServerId, Array.from(workspaces));
    },
    [],
  );
  const {
    selectedServerId,
    projects,
    routeProject,
    routeProjectContextViewKey,
    lastActiveProject,
  } = useNewWorkspaceInitialContext({
    serverId,
    sourceDirectory: sourceDirectoryProp,
    projectId,
    displayName: displayNameProp,
  });
  // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
  const supportsWorkspaceMultiplicity = useHostFeature(selectedServerId, "workspaceMultiplicity");
  const supportsForgeSearch = useHostFeature(selectedServerId, "forgeSearch");
  const [creationIdentity] = useState(() => ({
    draftId: draftId ?? generateDraftId(),
    worktreeSlug: createNameId(),
  }));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isRefreshingPicker, setIsRefreshingPicker] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const openAddProjectPicker = useOpenAddProject();
  const [isolationPickerOpen, setIsolationPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const pickerAnchorRef = useRef<View>(null);
  const projectPickerAnchorRef = useRef<View>(null);
  const isolationPickerAnchorRef = useRef<View>(null);
  const isDraftHandoffActive = useIsNewWorkspaceDraftHandoffActive({ draftId, selectedServerId });
  const isStillOnCreateScreen = useNewWorkspaceScreenPresence();

  useEffect(() => {
    const trimmed = pickerSearchQuery.trim();
    const timer = setTimeout(() => setDebouncedPickerSearchQuery(trimmed), 180);
    return () => clearTimeout(timer);
  }, [pickerSearchQuery]);

  const workspace = createdWorkspace;
  const client = useHostRuntimeClient(selectedServerId);
  const isConnected = useHostRuntimeIsConnected(selectedServerId);
  const {
    selectedProject,
    selectedSourceDirectory,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId,
    projectTriggerLabel,
    handleSelectProjectOption: selectProjectOption,
  } = useNewWorkspaceProjectPicker({
    selectedServerId,
    projects,
    routeProject,
    routeProjectContextViewKey,
    lastActiveProject,
    allowAllProjects: supportsWorkspaceMultiplicity,
  });
  const projectIconTargets = useMemo(
    () => buildNewWorkspaceProjectIconTargets(projects, selectedServerId),
    [projects, selectedServerId],
  );

  const projectIconDataByProjectViewKey = useProjectIcons({
    projects: projectIconTargets,
  });
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const arenaPreferenceKey = arenaDraftPreferenceKey(selectedServerId, draftKey);
  const arenaPreferences = useArenaPreferences(arenaPreferenceKey);
  const forkDraftSetup = usePendingWorkspaceDraftSetup(draftId);
  const draftContextScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const visibleDraftContextScopeKeys = useMemo(
    () => resolveVisibleDraftContextScopeKeys({ isDraftHandoffActive, draftContextScopeKey }),
    [draftContextScopeKey, isDraftHandoffActive],
  );
  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: buildComposerConfig({
      serverId: selectedServerId,
      workspaceDirectory: workspace?.workspaceDirectory ?? null,
      sourceDirectory: selectedSourceDirectory,
      initialSetup: forkDraftSetup?.setup,
    }),
  });
  const composerState = chatDraft.composerState;
  const [pickerSelection, dispatchPickerSelection] = useReducer(
    reducePickerSelection,
    initialPickerSelectionState,
  );
  const selectedItem = pickerSelection.selectedItem;

  const handleForgeChangeRequestDetected = useCallback(() => {
    dispatchPickerSelection({ type: "pr-detected" });
  }, []);

  const handleForgeChangeRequestAutoAttach = useCallback((item: ForgeSearchItem) => {
    dispatchPickerSelection({
      type: "pr-added",
      item: { kind: "github-pr", item },
    });
  }, []);

  const withConnectedClient = useCallback(() => {
    const connectedClient = getHostRuntimeStore().getClient(selectedServerId);
    if (!connectedClient?.isConnected) {
      throw new Error(t("newWorkspace.errors.hostDisconnected"));
    }
    return connectedClient;
  }, [selectedServerId, t]);

  const clientReady = isConnected && Boolean(client);
  const hasSelectedSourceDirectory = selectedSourceDirectory !== null;
  const pickerQueryEnabled = pickerOpen && clientReady && hasSelectedSourceDirectory;

  const isCheckoutStatusRefreshing = useIsCheckoutStatusRefreshing(
    selectedServerId,
    selectedSourceDirectory,
  );

  const worktreeSupport = selectedProject
    ? getWorktreeSupportForHostProject({ project: selectedProject, serverId: selectedServerId })
    : "unsupported";
  const { effectiveIsolation, setIsolation, canCreateWorktree } = useWorkspaceIsolation({
    supportsMultiplicity: supportsWorkspaceMultiplicity,
    worktreeSupport,
  });
  const { status: checkoutStatus, isLoading: isCheckoutStatusLoading } =
    useNewWorkspaceCheckoutStatus({
      serverId: selectedServerId,
      cwd: selectedSourceDirectory,
      isolation: effectiveIsolation,
      selectedItem,
      hasWorkspace: Boolean(createdWorkspace),
    });

  const branchSuggestionsQuery = useQuery({
    queryKey: [
      "branch-suggestions",
      selectedServerId,
      selectedSourceDirectory,
      debouncedPickerSearchQuery,
    ],
    queryFn: async () => {
      if (!selectedSourceDirectory) {
        throw new Error("Choose a project");
      }
      const connectedClient = withConnectedClient();
      return connectedClient.getBranchSuggestions({
        cwd: selectedSourceDirectory,
        query: debouncedPickerSearchQuery || undefined,
        limit: 20,
        refreshGit: true,
      });
    },
    enabled: pickerQueryEnabled,
    staleTime: 0,
  });

  const githubPrSearchQuery = useForgeSearchQuery({
    client,
    serverId: selectedServerId,
    cwd: selectedSourceDirectory ?? "",
    query: debouncedPickerSearchQuery,
    kinds: ["change_request"],
    supportsForgeSearch,
    enabled: pickerQueryEnabled,
  });

  const branchDetails = useMemo(
    () => normalizeBranchDetails(branchSuggestionsQuery.data),
    [branchSuggestionsQuery.data],
  );
  const forgeSearchAuthenticated =
    !githubPrSearchQuery.data || githubPrSearchQuery.data.authState === "authenticated";
  // A pull request is checked out into a worktree of its own. Local mode switches the
  // checkout between branches it already knows, so it lists branches only.
  const prItems: ForgeSearchItem[] = useMemo(() => {
    if (!forgeSearchAuthenticated || effectiveIsolation === "local") return [];
    return githubPrSearchQuery.data?.items ?? [];
  }, [effectiveIsolation, forgeSearchAuthenticated, githubPrSearchQuery.data?.items]);

  const baseItem = useMemo(
    () =>
      selectedItem ??
      (checkoutStatus
        ? defaultBasePickerItem({
            ...checkoutStatus,
            upstreamRef: effectiveIsolation === "local" ? null : checkoutStatus.upstreamRef,
          })
        : null),
    [checkoutStatus, selectedItem, effectiveIsolation],
  );
  const { options, itemById, selectedOptionId }: PickerOptionData = useMemo(
    () =>
      buildPickerOptionData({
        branchDetails,
        prItems,
        baseItem,
      }),
    [baseItem, branchDetails, prItems],
  );
  const triggerLabel = useMemo(() => {
    const displayItem = itemById.get(selectedOptionId);
    return displayItem ? pickerItemLabel(displayItem) : "main";
  }, [itemById, selectedOptionId]);
  const applyPickerSelection = useCallback(
    (item: PickerItem) => {
      const nextAttachments = syncPickerPrAttachment({
        attachments: chatDraft.attachments,
        item,
      });

      dispatchPickerSelection({ type: "picker-selected", item });
      chatDraft.setAttachments(nextAttachments);
    },
    [chatDraft],
  );

  const discardMissingBranch = useCallback(
    (item: PickerItem) => {
      if (
        selectedItem?.kind === "branch" &&
        item.kind === "branch" &&
        selectedItem.refName === item.refName
      ) {
        dispatchPickerSelection({ type: "branch-missing", item: selectedItem });
      }
      // Drop cached rows as well as the selection, otherwise the picker can reinsert
      // the deleted branch. Each request/cache entry remains scoped to its project.
      void queryClient.resetQueries({
        queryKey: ["branch-suggestions", selectedServerId, selectedSourceDirectory],
      });
    },
    [queryClient, selectedServerId, selectedSourceDirectory, selectedItem],
  );

  const { select: runPickerSelection, isSelecting: isSelectingBranch } = useLocalBranchSelection({
    isolation: effectiveIsolation,
    sourceDirectory: selectedSourceDirectory,
    serverId: selectedServerId,
    withConnectedClient,
    onSelected: applyPickerSelection,
    onMissing: discardMissingBranch,
  });
  const isPending =
    isNewWorkspacePending({ pendingAction, isDraftHandoffActive }) ||
    isCheckoutStatusLoading ||
    isCheckoutStatusRefreshing ||
    isRefreshingPicker ||
    isSelectingBranch;

  // The picker closes on the click; the checkout catches up behind it.
  const selectPickerItem = useCallback(
    (item: PickerItem) => {
      setPickerOpen(false);
      runPickerSelection(item);
    },
    [runPickerSelection],
  );

  const handleSelectOption = useCallback(
    (id: string) => {
      const item = itemById.get(id);
      if (!item) return;
      selectPickerItem(item);
    },
    [itemById, selectPickerItem],
  );

  const handleClosePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerSearchQuery("");
  }, []);

  const createBranch = useCreateBranchDialog({
    selectedItem,
    checkoutStatus,
    sourceDirectory: selectedSourceDirectory,
    isolation: effectiveIsolation,
    serverId: selectedServerId,
    withConnectedClient,
    onNamed: selectPickerItem,
    closePicker: handleClosePicker,
  });

  const clearPickerSelectionForTargetChange = useCallback(
    (currentTargetId: string, nextTargetId: string) => {
      const nextAttachments = clearPickerPrAttachmentForTargetChange({
        attachments: chatDraft.attachments,
        currentTargetId,
        nextTargetId,
      });
      if (nextAttachments === chatDraft.attachments) return;
      chatDraft.setAttachments(nextAttachments);
      dispatchPickerSelection({ type: "target-changed" });
    },
    [chatDraft],
  );

  const handleSelectProjectOption = useCallback(
    (id: string) => {
      // selectProjectOption enforces selectability (worktree-only when
      // multiplicity is off, any project when it's on); don't re-gate here on
      // canCreateWorktree or non-git projects become unselectable.
      selectProjectOption(id);
      setProjectPickerOpen(false);
      clearPickerSelectionForTargetChange(selectedProjectOptionId, id);
    },
    [clearPickerSelectionForTargetChange, selectProjectOption, selectedProjectOptionId],
  );

  const handleAddProject = useCallback(() => {
    setProjectPickerOpen(false);
    openAddProjectPicker(selectedServerId);
  }, [openAddProjectPicker, selectedServerId]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    if (!selectedSourceDirectory) return;
    setIsRefreshingPicker(true);
    void (async () => {
      try {
        const status = await refreshCheckoutStatus({
          queryClient,
          client: withConnectedClient(),
          serverId: selectedServerId,
          cwd: selectedSourceDirectory,
        });
        if (status.error) throw new Error(status.error.message);
        await validateSelectedBranch({
          client: withConnectedClient(),
          cwd: selectedSourceDirectory,
          item: selectedItem,
          missingBranchMessage: t("newWorkspace.errors.branchMissing"),
        });
      } catch (error) {
        if (error instanceof MissingSelectedBranchError && selectedItem)
          discardMissingBranch(selectedItem);
        toast.error(toErrorMessage(error));
      } finally {
        setIsRefreshingPicker(false);
      }
    })();
  }, [
    queryClient,
    selectedServerId,
    selectedSourceDirectory,
    selectedItem,
    discardMissingBranch,
    t,
    toast,
    withConnectedClient,
  ]);

  const openProjectPicker = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  // Cmd/Ctrl+P opens the project picker with its search focused so the user can
  // switch projects from the keyboard. Registered only while this screen is
  // mounted, so the shortcut doesn't swallow the browser's native print
  // elsewhere; gated on having projects to pick.
  const handleProjectPick = useCallback(() => {
    openProjectPicker();
    return true;
  }, [openProjectPicker]);
  useKeyboardActionHandler({
    handlerId: "new-workspace-project-pick",
    actions: PROJECT_PICK_ACTIONS,
    enabled: projectPickerOptions.length > 0,
    priority: 0,
    handle: handleProjectPick,
  });

  const openIsolationPicker = useCallback(() => {
    setIsolationPickerOpen(true);
  }, []);

  const handleIsolationPickerOpenChange = useCallback((nextOpen: boolean) => {
    setIsolationPickerOpen(nextOpen);
  }, []);

  const handleClearDraft = useCallback(() => {
    // No-op: screen navigates away on success, text should stay for retry on error
  }, []);

  const handlePickerOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleClosePicker();
        return;
      }
      openPicker();
    },
    [handleClosePicker, openPicker],
  );

  const handleProjectPickerOpenChange = useCallback((nextOpen: boolean) => {
    setProjectPickerOpen(nextOpen);
  }, []);

  const ensureWorkspace = useCallback(
    async (input: {
      cwd: string;
      prompt: string;
      attachments: AgentAttachment[];
      withInitialAgent: boolean;
    }) => {
      if (createdWorkspace) {
        return createdWorkspace;
      }
      if (!selectedProject) {
        throw new Error("Choose a project");
      }
      if (!selectedSourceDirectory) {
        throw new Error("Choose a host for this project");
      }
      const connectedClient = withConnectedClient();
      const createsWorktree = !supportsWorkspaceMultiplicity || effectiveIsolation === "worktree";
      let checkoutRequest: PickerCheckoutRequest | undefined;
      let expectedBranch: string | null = null;
      if (createsWorktree) {
        const checkoutStatusForCreate = await ensureCheckoutStatus({
          queryClient,
          client: connectedClient,
          serverId: selectedServerId,
          cwd: selectedSourceDirectory,
        });
        await validateSelectedBranch({
          client: connectedClient,
          cwd: selectedSourceDirectory,
          item: selectedItem,
          missingBranchMessage: t("newWorkspace.errors.branchMissing"),
        });
        checkoutRequest = pickerItemToCheckoutRequest(
          selectedItem ?? defaultBasePickerItem(checkoutStatusForCreate),
        );
      } else {
        // Unselected Local forms follow the checkout; explicit picks are reapplied.
        // Refresh the shared label before either path, and fail without creating a
        // workspace if Git refuses the selected branch.
        const localCheckoutStatus = await refreshCheckoutStatus({
          queryClient,
          client: connectedClient,
          serverId: selectedServerId,
          cwd: selectedSourceDirectory,
        });
        if (localCheckoutStatus.error) throw new Error(localCheckoutStatus.error.message);
        expectedBranch = await prepareLocalCheckout({
          client: connectedClient,
          cwd: selectedSourceDirectory,
          item: selectedItem,
          currentBranch: localCheckoutStatus.currentBranch,
          switchFailedMessage: t("newWorkspace.errors.switchBranchFailed"),
          createFailedMessage: t("newWorkspace.newBranch.errors.createFailed"),
          missingBranchMessage: t("newWorkspace.errors.branchMissing"),
        });
      }
      const normalizedWorkspace = await createMultiplicityWorkspace({
        idempotencyKey: creationIdentity.draftId,
        worktreeSlug: creationIdentity.worktreeSlug,
        client: connectedClient,
        isolation: createsWorktree ? "worktree" : "local",
        project: selectedProject,
        sourceDirectory: selectedSourceDirectory,
        checkoutRequest,
        expectedBranch,
        withInitialAgent: input.withInitialAgent,
        prompt: input.prompt,
        attachments: input.attachments,
        mergeWorkspaces,
        serverId: selectedServerId,
        createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
      });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      createdWorkspace,
      creationIdentity,
      effectiveIsolation,
      mergeWorkspaces,
      queryClient,
      selectedItem,
      selectedProject,
      selectedServerId,
      selectedSourceDirectory,
      supportsWorkspaceMultiplicity,
      t,
      withConnectedClient,
    ],
  );

  const handleSubmitNewWorkspace = useCallback(
    async (payload: MessagePayload) => {
      try {
        setErrorMessage(null);
        await composerState?.persistFormPreferences();
        if (isEmptyWorkspaceSubmission(payload)) {
          setPendingAction("empty");
          let navigated = false;
          await runCreateEmptyWorkspace({
            payload,
            ensureWorkspace,
            serverId: selectedServerId,
            navigate: (targetServerId, workspaceId) => {
              if (!isStillOnCreateScreen()) {
                return;
              }
              navigated = true;
              leaveFullscreen();
              navigateToWorkspace({ serverId: targetServerId, workspaceId });
            },
          });
          // Nothing navigated, so this screen may still be mounted under another route. Release
          // the pending lock it would otherwise keep forever.
          if (!navigated) {
            setPendingAction(null);
          }
          return;
        }

        setPendingAction("chat");
        await runCreateChatAgent({
          payload,
          composerState,
          forkDraftSetup,
          ensureWorkspace,
          serverId: selectedServerId,
          client,
          draftKey,
          clearDraft: chatDraft.clear,
          draftId: creationIdentity.draftId,
          supportsForgeSearch,
          arenaPreferenceKey,
          labels: {
            composerStateRequired: t("newWorkspace.errors.composerStateRequired"),
          },
        });
        leaveFullscreen();
      } catch (error) {
        if (error instanceof MissingSelectedBranchError && selectedItem)
          discardMissingBranch(selectedItem);
        const message = toErrorMessage(error);
        setPendingAction(null);
        setErrorMessage(message);
        toast.error(message);
      }
    },
    [
      arenaPreferenceKey,
      chatDraft.clear,
      client,
      composerState,
      creationIdentity,
      discardMissingBranch,
      draftKey,
      ensureWorkspace,
      forkDraftSetup,
      isStillOnCreateScreen,
      leaveFullscreen,
      selectedItem,
      selectedServerId,
      supportsForgeSearch,
      t,
      toast,
    ],
  );

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
            battleModeDisabled: isPending,
            disabled: isPending,
          }
        : undefined,
    [arenaPreferences, composerState, isPending],
  );

  const pickerEmptyText =
    branchSuggestionsQuery.isFetching || githubPrSearchQuery.isFetching
      ? t("newWorkspace.refPicker.searching")
      : t("newWorkspace.refPicker.noMatchingRefs");

  const formStack = useNewWorkspaceForm({
    isCompact,
    isPending,
    project: {
      anchorRef: projectPickerAnchorRef,
      open: openProjectPicker,
      openState: projectPickerOpen,
      onOpenChange: handleProjectPickerOpenChange,
      options: projectPickerOptions,
      projectByOptionId,
      iconDataByProjectViewKey: projectIconDataByProjectViewKey,
      selectedProject,
      selectedOptionId: selectedProjectOptionId,
      triggerLabel: projectTriggerLabel,
      selectedServerId,
      supportsWorkspaceMultiplicity,
      onSelect: handleSelectProjectOption,
      onAddProject: handleAddProject,
    },
    isolation: {
      anchorRef: isolationPickerAnchorRef,
      open: openIsolationPicker,
      openState: isolationPickerOpen,
      onOpenChange: handleIsolationPickerOpenChange,
      effectiveIsolation,
      canCreateWorktree,
      onSelect: setIsolation,
    },
    base: {
      anchorRef: pickerAnchorRef,
      open: openPicker,
      openState: pickerOpen,
      onOpenChange: handlePickerOpenChange,
      selectedSourceDirectory,
      selectedItem,
      triggerLabel,
      options,
      itemById,
      selectedOptionId,
      onSelect: handleSelectOption,
      setSearchQuery: setPickerSearchQuery,
      emptyText: pickerEmptyText,
      // Local mode switches the checkout through the same picker, so it always shows.
      showRefPicker: true,
      onCreateBranch: createBranch.open,
      canCreateBranch: createBranch.base !== null,
    },
  });

  const isComposerFullscreen = composerEditing.isFullscreen;
  return (
    <FileDropZone style={styles.container}>
      <NewWorkspaceLayout
        isCompact={isCompact}
        fullscreen={isComposerFullscreen}
        formStack={formStack}
      >
        <Composer
          editingSession={composerEditing.chat}
          agentId={draftKey}
          serverId={selectedServerId}
          isPaneFocused={true}
          onSubmitMessage={handleSubmitNewWorkspace}
          allowEmptySubmit={true}
          submitButtonAccessibilityLabel={t("newWorkspace.create")}
          submitButtonTestID="workspace-create-submit"
          submitIcon="return"
          isSubmitLoading={isPending}
          waitForForgeAutoAttachOnSubmit
          submitBehavior="preserve-and-lock"
          blurOnSubmit={true}
          textSource={chatDraft.textSource}
          onChangeText={chatDraft.editText}
          textReplacement={chatDraft.textReplacement}
          attachments={chatDraft.attachments}
          attachmentScopeKeys={visibleDraftContextScopeKeys}
          onChangeAttachments={chatDraft.setAttachments}
          onForgeChangeRequestDetected={handleForgeChangeRequestDetected}
          onForgeChangeRequestAutoAttach={handleForgeChangeRequestAutoAttach}
          cwd={selectedSourceDirectory ?? ""}
          clearDraft={handleClearDraft}
          autoFocus
          commandDraft={composerState?.commandDraft}
          agentControls={agentControlsWithDisabled}
          maxImages={arenaComposerMaxImages(arenaPreferences.battleMode)}
        />
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      </NewWorkspaceLayout>
      <AdaptiveRenameModal
        visible={createBranch.visible}
        title={createBranch.title}
        initialValue=""
        placeholder={t("newWorkspace.newBranch.placeholder")}
        submitLabel={createBranch.submitLabel}
        validate={createBranch.validate}
        onClose={createBranch.close}
        onSubmit={createBranch.submit}
        testID="new-workspace-create-branch-modal"
      />
    </FileDropZone>
  );
}

function useNewWorkspaceComposerEditing() {
  const chat = useComposerEditingSession("chat");
  const isFullscreen = useComposerFullscreen(chat);
  // The session outlives the screen (its draft keeps it), so a launch that leaves the
  // screen also leaves fullscreen; the next draft starts inline.
  const leaveFullscreen = useCallback(() => {
    chat.setFullscreen(false);
  }, [chat]);
  return { chat, leaveFullscreen, isFullscreen };
}

function NewWorkspaceLayout({
  isCompact,
  fullscreen,
  formStack,
  children,
}: {
  isCompact: boolean;
  /** The composer covers the screen; the header leaves and the dock fills the content. */
  fullscreen: boolean;
  formStack: ReactNode;
  children: ReactNode;
}) {
  // No title: the fields name themselves and sit against the composer they set up. On compact
  // the free space above pushes them down onto the composer, where the thumb is.
  const setupFields = isCompact ? (
    <>
      <View style={styles.compactSetupSpace} pointerEvents="none" />
      {formStack}
    </>
  ) : (
    formStack
  );
  return (
    <>
      {fullscreen ? null : <MenuHeader borderless />}
      <View style={styles.content}>
        <TitlebarDragRegion />
        <ComposerDock centered={!isCompact} fullscreen={fullscreen}>
          {setupFields}
          {children}
        </ComposerDock>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
  },
  compactSetupSpace: {
    flex: 1,
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
}));
