import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Pressable, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
} from "lucide-react-native";
import { Composer } from "@/composer";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { ProjectIconView } from "@/components/project-icon-view";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import type { ComboboxOption as ComboboxOptionType, ComboboxProps } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { HEADER_INNER_HEIGHT, MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
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
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import {
  useWorkspaceDraftSubmissionStore,
  type PendingWorkspaceDraftSetup,
} from "@/stores/workspace-draft-submission-store";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { getWorktreeSupportForHostProject } from "@/projects/host-project-model";
import {
  getHostProjectSourceDirectory,
  getHostProjectId,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveHostProjectCandidate,
  useHostProjects,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useProjectIcons } from "@/projects/icons";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ComposerAttachment } from "@/attachments/types";
import { useDraftWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import type { MessagePayload } from "@/composer/types";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
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
import { useNewWorkspaceProjectPicker } from "./new-workspace/project-picker";
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

const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedGitBranchPlus = withUnistyles(GitBranchPlus);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const addProjectIcon = (
  <ThemedFolderPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const createBranchIcon = (
  <ThemedGitBranchPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

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

const PROJECT_ICON_FALLBACK_FONT_SIZE = 10;
const ThemedChevronDown = withUnistyles(ChevronDown);
const chevronExtraMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

// Every picker chip on this screen shares one chevron so they stay a single
// visual family. Extra-muted: the chevron is an affordance, not information,
// and it should sit behind the label it belongs to.
function MetaChevron(): ReactElement {
  return (
    <View style={styles.chevronContainer}>
      <ThemedChevronDown size={ICON_SIZE.sm} uniProps={chevronExtraMutedMapping} />
    </View>
  );
}

const metaChevron = <MetaChevron />;

// Stable reference so the keyboard-action handler doesn't re-register each render.
const PROJECT_PICK_ACTIONS: readonly KeyboardActionId[] = ["workspace.project.pick"];
// Height of a single picker-trigger badge. The Base-row spacer reserves exactly
// this so toggling Isolation to Local hides the row without shifting the form.
const BADGE_HEIGHT = 28;

function RefPickerBadgeContent({
  selectedItem,
  triggerLabel,
  iconColor,
  iconSize,
}: {
  selectedItem: PickerItem | null;
  triggerLabel: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <>
      <View style={styles.badgeIconBox}>
        {selectedItem?.kind === "github-pr" ? (
          <GitPullRequest size={iconSize} color={iconColor} />
        ) : (
          <GitBranch size={iconSize} color={iconColor} />
        )}
      </View>
      <Text style={styles.badgeText} numberOfLines={1}>
        {triggerLabel}
      </Text>
    </>
  );
}

function RefPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  selectedItem,
  triggerLabel,
  accessibilityLabel,
  tooltipLabel,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  selectedItem: PickerItem | null;
  triggerLabel: string;
  accessibilityLabel: string;
  tooltipLabel: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        <ComboboxTrigger
          chevron={metaChevron}
          ref={pickerAnchorRef}
          testID="new-workspace-ref-picker-trigger"
          onPress={onPress}
          disabled={disabled}
          style={badgePressableStyle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <RefPickerBadgeContent
            selectedItem={selectedItem}
            triggerLabel={triggerLabel}
            iconColor={iconColor}
            iconSize={iconSize}
          />
        </ComboboxTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ProjectPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  label,
  tooltipLabel,
  projectViewKey,
  iconDataUri,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  label: string;
  tooltipLabel: string;
  projectViewKey: string | null;
  iconDataUri: string | null;
  iconColor: string;
  iconSize: number;
}) {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(label);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase() || "?";
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        <ComboboxTrigger
          chevron={metaChevron}
          ref={pickerAnchorRef}
          testID="new-workspace-project-picker-trigger"
          onPress={onPress}
          disabled={disabled}
          style={badgePressableStyle}
          accessibilityRole="button"
          accessibilityLabel="Workspace project"
        >
          <View style={styles.badgeIconBox}>
            {projectViewKey ? (
              <ProjectIconView
                iconDataUri={iconDataUri}
                initial={placeholderInitial}
                projectViewKey={projectViewKey}
                size={ICON_SIZE.md}
                textStyle={styles.projectIconFallbackText}
              />
            ) : (
              <Folder size={iconSize} color={iconColor} />
            )}
          </View>
          <Text style={styles.badgeText} numberOfLines={1}>
            {label}
          </Text>
        </ComboboxTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function PickerRowIcon({
  itemKind,
  iconColor,
  iconSize,
}: {
  itemKind: PickerItem["kind"];
  iconColor: string;
  iconSize: number;
}) {
  switch (itemKind) {
    case "github-pr":
      return <GitPullRequest size={iconSize} color={iconColor} />;
    case "new-branch":
      return <GitBranchPlus size={iconSize} color={iconColor} />;
    case "branch":
      return <GitBranch size={iconSize} color={iconColor} />;
  }
}

function PickerOptionItem({
  testID,
  label,
  description,
  selected,
  active,
  disabled,
  onPress,
  itemKind,
  trailingLabel,
  accessibilityLabel,
  iconColor,
  iconSize,
}: {
  testID: string;
  label: string;
  description: string | undefined;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  itemKind: PickerItem["kind"];
  trailingLabel?: string;
  accessibilityLabel?: string;
  iconColor: string;
  iconSize: number;
}) {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        <PickerRowIcon itemKind={itemKind} iconColor={iconColor} iconSize={iconSize} />
      </View>
    ),
    [itemKind, iconSize, iconColor],
  );
  const trailingSlot = useMemo(
    () =>
      trailingLabel ? <Text style={styles.refDivergenceLabel}>{trailingLabel}</Text> : undefined,
    [trailingLabel],
  );
  return (
    <ComboboxItem
      testID={testID}
      label={label}
      description={description}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

function IsolationOptionItem({
  optionId,
  label,
  selected,
  active,
  disabled,
  onPress,
  iconColor,
  iconSize,
}: {
  optionId: string;
  label: string;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  iconColor: string;
  iconSize: number;
}) {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        {optionId === "worktree" ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <Folder size={iconSize} color={iconColor} />
        )}
      </View>
    ),
    [optionId, iconSize, iconColor],
  );
  return (
    <ComboboxItem
      testID={`workspace-create-isolation-${optionId}`}
      label={label}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  testID,
  projectViewKey,
  iconDataUri,
  label,
  description,
  selected,
  active,
  disabled,
  onPress,
}: {
  testID: string;
  projectViewKey: string;
  iconDataUri: string | null;
  label: string;
  description: string | undefined;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(label);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase() || "?";
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={placeholderInitial}
          projectViewKey={projectViewKey}
          size={ICON_SIZE.md}
          textStyle={styles.projectIconFallbackText}
        />
      </View>
    ),
    [iconDataUri, placeholderInitial, projectViewKey],
  );

  return (
    <ComboboxItem
      testID={testID}
      label={label}
      description={description}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function NewWorkspacePickerOption({
  option,
  selected,
  active,
  onPress,
  itemById,
  isPending,
}: {
  option: ComboboxOptionType;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  itemById: Map<string, PickerItem>;
  isPending: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const item = itemById.get(option.id);
  if (!item) return <View key={option.id} />;

  const isBranch = item.kind === "branch";
  const testID = pickerOptionTestID(item);
  let description: string | undefined;
  if (item.kind === "github-pr" && item.item.baseRefName) {
    description = t("newWorkspace.refPicker.intoBase", { baseRef: item.item.baseRefName });
  } else if (item.kind === "new-branch") {
    description = t("newWorkspace.newBranch.fromBase", {
      base: newBranchBaseLabel(item.baseRefName),
    });
  }

  return (
    <PickerOptionItem
      testID={testID}
      label={pickerItemLabel(item)}
      description={description}
      selected={selected}
      active={active}
      disabled={isPending}
      onPress={onPress}
      itemKind={item.kind}
      trailingLabel={isBranch ? item.divergenceLabel : undefined}
      accessibilityLabel={isBranch ? item.accessibilityLabel : undefined}
      iconColor={theme.colors.foregroundMuted}
      iconSize={theme.iconSize.sm}
    />
  );
}

function pickerOptionTestID(item: PickerItem): string {
  switch (item.kind) {
    case "branch":
      return `new-workspace-ref-picker-branch-${item.name}`;
    case "github-pr":
      return `new-workspace-ref-picker-pr-${item.item.number}`;
    case "new-branch":
      return `new-workspace-ref-picker-new-branch-${item.name}`;
  }
}

function NewWorkspaceProjectPickerOption({
  option,
  selected,
  active,
  onPress,
  projectByOptionId,
  projectIconDataByProjectViewKey,
  selectedServerId,
  isPending,
  supportsWorkspaceMultiplicity,
}: {
  option: ComboboxOptionType;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  projectByOptionId: Map<string, HostProjectListItem>;
  projectIconDataByProjectViewKey: Map<string, string | null>;
  selectedServerId: string;
  isPending: boolean;
  supportsWorkspaceMultiplicity: boolean;
}) {
  const project = projectByOptionId.get(option.id);
  if (!project) return <View key={option.id} />;
  const sourceDirectory =
    getHostProjectSourceDirectory(project, selectedServerId) ?? project.iconWorkingDir;

  return (
    <ProjectOptionItem
      testID={`new-workspace-project-picker-option-${project.viewKey}`}
      projectViewKey={project.viewKey}
      iconDataUri={projectIconDataByProjectViewKey.get(project.viewKey) ?? null}
      label={project.projectName}
      description={sourceDirectory}
      selected={selected}
      active={active}
      disabled={
        isPending ||
        (!supportsWorkspaceMultiplicity &&
          !project.hosts.some((host) => host.worktreeSupport !== "unsupported"))
      }
      onPress={onPress}
    />
  );
}

// The one row in the picker that is not a ref that already exists. It sits in the footer,
// below the separator, so the list above stays "refs you can start from" and this stays the
// action that makes one.
function CreateBranchPickerAction({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ComboboxItem
      testID="new-workspace-ref-picker-create-branch"
      label={t("newWorkspace.newBranch.action")}
      description={disabled ? t("newWorkspace.newBranch.errors.noBase") : undefined}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={createBranchIcon}
    />
  );
}

function AddProjectPickerAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const openProjectKeys = useShortcutKeys("new-agent");
  const shortcut = useMemo(
    () => (openProjectKeys ? <Shortcut chord={openProjectKeys} /> : null),
    [openProjectKeys],
  );

  return (
    <ComboboxItem
      testID="new-workspace-project-picker-add-project"
      label={t("sidebar.actions.addProject")}
      onPress={onPress}
      leadingSlot={addProjectIcon}
      trailingSlot={shortcut}
    />
  );
}

function IsolationPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  isolation,
  label,
  tooltipLabel,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  isolation: "local" | "worktree";
  label: string;
  tooltipLabel: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        <ComboboxTrigger
          chevron={metaChevron}
          ref={pickerAnchorRef}
          testID="workspace-create-isolation-trigger"
          onPress={onPress}
          disabled={disabled}
          style={badgePressableStyle}
          accessibilityRole="button"
          accessibilityLabel="Workspace isolation"
        >
          <View style={styles.badgeIconBox}>
            {isolation === "worktree" ? (
              <GitBranch size={iconSize} color={iconColor} />
            ) : (
              <Folder size={iconSize} color={iconColor} />
            )}
          </View>
          <Text style={styles.badgeText} numberOfLines={1}>
            {label}
          </Text>
        </ComboboxTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// Wraps a single argument control in the mobile vertical stack. On desktop the
// controls are laid out in one horizontal row, so no per-control wrapper is used.
function FormRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

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
  withConnectedClient: () => NonNullable<ReturnType<typeof useHostRuntimeClient>>;
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
  withConnectedClient: () => NonNullable<ReturnType<typeof useHostRuntimeClient>>;
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

function isolationLabel(t: TFunction, isolation: "local" | "worktree"): string {
  return isolation === "worktree"
    ? t("newWorkspace.isolation.worktree")
    : t("newWorkspace.isolation.local");
}

function getContentStyle(input: { isCompact: boolean; insetBottom: number }) {
  if (input.isCompact) {
    return [styles.content, styles.contentCompact, { paddingBottom: input.insetBottom }];
  }
  return [styles.content, styles.contentCentered];
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
  draftKey: string;
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

async function createAndMergeWorkspace(input: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  createInput: Parameters<
    NonNullable<ReturnType<typeof useHostRuntimeClient>>["createPaseoWorktree"]
  >[0];
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const payload = await input.client.createPaseoWorktree(input.createInput);
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? input.createFailedMessage);
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceForInitialMerge = input.createInput.firstAgentContext
    ? { ...normalizedWorkspace, status: "running" as const, statusEnteredAt: new Date() }
    : normalizedWorkspace;
  input.mergeWorkspaces(input.serverId, [workspaceForInitialMerge]);
  return normalizedWorkspace;
}

// Back the workspace with the checkout that is already there: no worktree, no branch. This
// is what "I picked the branch I am on" has to mean, since a second worktree cannot check
// out a branch the source checkout is holding.
async function createDirectoryWorkspace(input: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  project: HostProjectListItem;
  sourceDirectory: string;
  expectedBranch: string | null;
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
  const firstAgentContext = buildFirstAgentContext({
    prompt: input.prompt,
    attachments: input.attachments,
  });
  const payload = await input.client.createWorkspace({
    source: {
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

async function createMultiplicityWorkspace(input: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  project: HostProjectListItem;
  sourceDirectory: string;
  checkoutRequest: PickerCheckoutRequest | undefined;
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
  const firstAgentContext = buildFirstAgentContext({
    prompt: input.prompt,
    attachments: input.attachments,
  });
  const payload = await input.client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: input.sourceDirectory,
      projectId,
      ...input.checkoutRequest,
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
  if (input.initialSetup) {
    return {
      workingDir: input.workingDir ?? input.initialSetup.cwd,
      provider: ARENA_PROVIDER,
      model: ARENA_BOOTSTRAP_MODEL,
      thinkingOptionId: "high",
    };
  }
  if (input.workingDir) {
    return {
      workingDir: input.workingDir,
      provider: ARENA_PROVIDER,
      model: ARENA_BOOTSTRAP_MODEL,
      thinkingOptionId: "high",
    };
  }
  return undefined;
}

async function runCreateChatAgent(input: CreateChatAgentInput): Promise<void> {
  const { payload, composerState, ensureWorkspace, serverId, draftKey } = input;
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
    // The first Arena battle owns workspace naming: its two contestant titles
    // remain visible as A/B until the vote resolves the workspace title.
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
    draftKey,
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
  isConnected: boolean;
  workspaceDirectory: string | null;
  sourceDirectory: string | null;
  initialSetup?: WorkspaceDraftTabSetup | null;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, isConnected, workspaceDirectory, sourceDirectory, initialSetup } = input;
  const workingDir = workspaceDirectory || sourceDirectory || undefined;
  return {
    initialServerId: serverId || null,
    initialValues: buildComposerInitialValues({ workingDir, initialSetup }),
    initialFeatureValues: initialSetup?.featureValues,
    isVisible: true,
    onlineServerIds: isConnected && serverId ? [serverId] : [],
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
    draftKey,
    draftId: draftIdInput,
    workspaceId,
    workspaceDirectory,
    text,
    attachments,
    initialSetup,
  } = input;
  const draftId = draftIdInput?.trim() || generateDraftId();
  copyArenaPreferences(input.arenaPreferenceKey, arenaDraftPreferenceKey(serverId, draftId));
  const clientMessageId = generateMessageId();
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
  useCreateFlowStore.getState().setPending({
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
  navigateToWorkspace({
    serverId,
    workspaceId,
    target: submission.target,
  });
  useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "sent" });
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

type RefPickerRenderOption = NonNullable<ComboboxProps["renderOption"]>;

interface FormPickerControl {
  anchorRef: RefObject<View | null>;
  open: () => void;
  openState: boolean;
  onOpenChange: (open: boolean) => void;
}

interface NewWorkspaceFormStackInput {
  isCompact: boolean;
  isPending: boolean;
  project: FormPickerControl & {
    options: ComboboxOptionType[];
    triggerLabel: string;
    selectedProject: HostProjectListItem | null;
    iconDataByProjectViewKey: Map<string, string | null>;
    selectedOptionId: string;
    onSelect: (id: string) => void;
    onAddProject: () => void;
    renderOption: RefPickerRenderOption;
  };
  isolation: FormPickerControl & {
    effectiveIsolation: "local" | "worktree";
    options: ComboboxOptionType[];
    onSelect: (id: string) => void;
    renderOption: RefPickerRenderOption;
    canCreateWorktree: boolean;
  };
  base: FormPickerControl & {
    selectedSourceDirectory: string | null;
    selectedItem: PickerItem | null;
    triggerLabel: string;
    options: ComboboxOptionType[];
    selectedOptionId: string;
    onSelect: (id: string) => void;
    onCreateBranch: () => void;
    canCreateBranch: boolean;
    setSearchQuery: (query: string) => void;
    emptyText: string;
    renderOption: RefPickerRenderOption;
  };
}

function useNewWorkspaceFormStack(input: NewWorkspaceFormStackInput): ReactElement {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { isCompact, isPending, project, isolation, base } = input;

  const isolationTriggerLabel = isolationLabel(t, isolation.effectiveIsolation);
  const addProjectAction = useMemo(
    () => <AddProjectPickerAction onPress={project.onAddProject} />,
    [project.onAddProject],
  );
  const createBranchAction = useMemo(
    () => (
      <CreateBranchPickerAction onPress={base.onCreateBranch} disabled={!base.canCreateBranch} />
    ),
    [base.onCreateBranch, base.canCreateBranch],
  );

  const badgePressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.badge,
      Boolean(hovered) && !isPending && styles.badgeHovered,
      pressed && !isPending && styles.badgePressed,
      isPending && styles.badgeDisabled,
    ],
    [isPending],
  );

  const desktopControlStyle = isCompact ? undefined : styles.desktopControl;

  const projectControl = (
    <View style={desktopControlStyle}>
      <ProjectPickerTrigger
        pickerAnchorRef={project.anchorRef}
        onPress={project.open}
        disabled={isPending}
        badgePressableStyle={badgePressableStyle}
        label={project.triggerLabel}
        tooltipLabel={t("newWorkspace.tooltips.project")}
        projectViewKey={project.selectedProject?.viewKey ?? null}
        iconDataUri={
          project.selectedProject
            ? (project.iconDataByProjectViewKey.get(project.selectedProject.viewKey) ?? null)
            : null
        }
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={project.options}
        value={project.selectedOptionId}
        onSelect={project.onSelect}
        searchable
        searchPlaceholder="Search projects"
        title="Project"
        open={project.openState}
        onOpenChange={project.onOpenChange}
        desktopPlacement="bottom-start"
        desktopMinWidth={360}
        anchorRef={project.anchorRef}
        emptyText="No projects available."
        renderOption={project.renderOption}
        footer={addProjectAction}
      />
    </View>
  );

  const isolationControl = isolation.canCreateWorktree ? (
    <View style={desktopControlStyle}>
      <IsolationPickerTrigger
        pickerAnchorRef={isolation.anchorRef}
        onPress={isolation.open}
        disabled={isPending}
        badgePressableStyle={badgePressableStyle}
        isolation={isolation.effectiveIsolation}
        label={isolationTriggerLabel}
        tooltipLabel={t("newWorkspace.tooltips.isolation")}
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={isolation.options}
        value={isolation.effectiveIsolation}
        onSelect={isolation.onSelect}
        title={t("newWorkspace.isolation.label")}
        open={isolation.openState}
        onOpenChange={isolation.onOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={isolation.anchorRef}
        renderOption={isolation.renderOption}
      />
    </View>
  ) : null;

  const baseControl = (
    <View style={desktopControlStyle}>
      <RefPickerTrigger
        pickerAnchorRef={base.anchorRef}
        onPress={base.open}
        disabled={isPending || !base.selectedSourceDirectory}
        badgePressableStyle={badgePressableStyle}
        selectedItem={base.selectedItem}
        triggerLabel={base.triggerLabel}
        accessibilityLabel={t("newWorkspace.refPicker.startingRef")}
        tooltipLabel={t("newWorkspace.tooltips.startingRef")}
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={base.options}
        value={base.selectedOptionId}
        onSelect={base.onSelect}
        searchable
        searchPlaceholder={t("newWorkspace.refPicker.searchPlaceholder")}
        title={t("newWorkspace.refPicker.title")}
        open={base.openState}
        onOpenChange={base.onOpenChange}
        onSearchQueryChange={base.setSearchQuery}
        desktopPlacement="bottom-start"
        anchorRef={base.anchorRef}
        emptyText={base.emptyText}
        renderOption={base.renderOption}
        footer={createBranchAction}
      />
    </View>
  );

  return isCompact ? (
    <View testID="new-workspace-ref-picker-row" style={styles.formStack}>
      <FormRow>{projectControl}</FormRow>
      {isolationControl ? <FormRow>{isolationControl}</FormRow> : null}
      <FormRow>{baseControl}</FormRow>
      {/* Keep fixed stack height without separating the visible controls. */}
      {isolationControl ? null : <View style={styles.baseSpacer} />}
    </View>
  ) : (
    <View testID="new-workspace-ref-picker-row" style={styles.formStackDesktop}>
      {projectControl}
      {isolationControl}
      {baseControl}
    </View>
  );
}

export function NewWorkspaceScreen({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
  draftId,
}: NewWorkspaceScreenProps) {
  const queryClient = useQueryClient();
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
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
    () =>
      projects.flatMap((project) => {
        const iconWorkingDir = getHostProjectSourceDirectory(project, selectedServerId)?.trim();
        if (!iconWorkingDir) {
          return [];
        }
        const host = project.hosts.find((candidate) => candidate.serverId === selectedServerId);
        if (!host) return [];
        return [
          {
            projectViewKey: project.viewKey,
            projectId: host.projectId,
            serverId: selectedServerId,
            iconWorkingDir,
            customIconRevision: host.customIconRevision,
          },
        ];
      }),
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
      isConnected,
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

  const handleGithubPrDetected = useCallback(() => {
    dispatchPickerSelection({ type: "pr-detected" });
  }, []);

  const handleGithubPrAutoAttach = useCallback((item: ForgeSearchItem) => {
    dispatchPickerSelection({
      type: "pr-added",
      item: { kind: "github-pr", item },
    });
  }, []);

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error(t("newWorkspace.errors.hostDisconnected"));
    }
    return client;
  }, [client, isConnected, t]);

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

  // "New worktree" is omitted entirely (not disabled) when the project isn't a
  // git checkout, since worktree isolation is impossible there.
  const isolationOptions = useMemo<ComboboxOptionType[]>(() => {
    const localOption = { id: "local", label: isolationLabel(t, "local") };
    if (!canCreateWorktree) return [localOption];
    return [localOption, { id: "worktree", label: isolationLabel(t, "worktree") }];
  }, [canCreateWorktree, t]);

  const handleSelectIsolationOption = useCallback(
    (id: string) => {
      setIsolation(id === "worktree" ? "worktree" : "local");
      setIsolationPickerOpen(false);
    },
    [setIsolation],
  );

  const renderIsolationOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      return (
        <IsolationOptionItem
          optionId={option.id}
          label={option.label}
          selected={selected}
          active={active}
          disabled={isPending}
          onPress={onPress}
          iconColor={theme.colors.foregroundMuted}
          iconSize={theme.iconSize.sm}
        />
      );
    },
    [isPending, theme.colors.foregroundMuted, theme.iconSize.sm],
  );

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

  const buildCreateWorktreeInput = useCallback(
    (input: {
      cwd: string;
      prompt: string;
      attachments: AgentAttachment[];
      checkoutRequest: PickerCheckoutRequest | undefined;
    }): CreatePaseoWorktreeInput => {
      if (!selectedProject) {
        throw new Error("Choose a project");
      }
      if (!selectedSourceDirectory) {
        throw new Error("Choose a host for this project");
      }
      const firstAgentContext = buildFirstAgentContext(input);
      const hostProjectId = getHostProjectId(selectedProject, selectedServerId);
      if (!hostProjectId) {
        throw new Error("Project is not available on the selected host");
      }

      return {
        cwd: selectedSourceDirectory,
        projectId: hostProjectId,
        ...(firstAgentContext ? { firstAgentContext } : {}),
        ...input.checkoutRequest,
      };
    },
    [selectedProject, selectedServerId, selectedSourceDirectory],
  );

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
      if (supportsWorkspaceMultiplicity && effectiveIsolation === "local") {
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
        const expectedBranch = await prepareLocalCheckout({
          client: connectedClient,
          cwd: selectedSourceDirectory,
          item: selectedItem,
          currentBranch: localCheckoutStatus.currentBranch,
          switchFailedMessage: t("newWorkspace.errors.switchBranchFailed"),
          createFailedMessage: t("newWorkspace.newBranch.errors.createFailed"),
          missingBranchMessage: t("newWorkspace.errors.branchMissing"),
        });
        const directoryWorkspace = await createDirectoryWorkspace({
          client: connectedClient,
          project: selectedProject,
          sourceDirectory: selectedSourceDirectory,
          expectedBranch,
          withInitialAgent: input.withInitialAgent,
          prompt: input.prompt,
          attachments: input.attachments,
          mergeWorkspaces,
          serverId: selectedServerId,
          createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
        });
        setCreatedWorkspace(directoryWorkspace);
        return directoryWorkspace;
      }
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
      const checkoutRequest = pickerItemToCheckoutRequest(
        selectedItem ?? defaultBasePickerItem(checkoutStatusForCreate),
      );
      const normalizedWorkspace = supportsWorkspaceMultiplicity
        ? await createMultiplicityWorkspace({
            client: connectedClient,
            project: selectedProject,
            sourceDirectory: selectedSourceDirectory,
            checkoutRequest,
            withInitialAgent: input.withInitialAgent,
            prompt: input.prompt,
            attachments: input.attachments,
            mergeWorkspaces,
            serverId: selectedServerId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          })
        : await createAndMergeWorkspace({
            client: connectedClient,
            createInput: buildCreateWorktreeInput({ ...input, checkoutRequest }),
            mergeWorkspaces,
            serverId: selectedServerId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      buildCreateWorktreeInput,
      createdWorkspace,
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
          await runCreateEmptyWorkspace({
            payload,
            ensureWorkspace,
            serverId: selectedServerId,
            navigate: (targetServerId, workspaceId) =>
              navigateToWorkspace({ serverId: targetServerId, workspaceId }),
          });
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
          draftId,
          supportsForgeSearch,
          arenaPreferenceKey,
          labels: {
            composerStateRequired: t("newWorkspace.errors.composerStateRequired"),
          },
        });
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
      client,
      composerState,
      draftId,
      draftKey,
      arenaPreferenceKey,
      ensureWorkspace,
      discardMissingBranch,
      selectedItem,
      forkDraftSetup,
      selectedServerId,
      supportsForgeSearch,
      t,
      toast,
    ],
  );

  const renderPickerOption = useCallback(
    (props: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => <NewWorkspacePickerOption {...props} itemById={itemById} isPending={isPending} />,
    [isPending, itemById],
  );

  const renderProjectOption = useCallback(
    (props: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <NewWorkspaceProjectPickerOption
        {...props}
        projectByOptionId={projectByOptionId}
        projectIconDataByProjectViewKey={projectIconDataByProjectViewKey}
        selectedServerId={selectedServerId}
        isPending={isPending}
        supportsWorkspaceMultiplicity={supportsWorkspaceMultiplicity}
      />
    ),
    [
      isPending,
      projectByOptionId,
      projectIconDataByProjectViewKey,
      selectedServerId,
      supportsWorkspaceMultiplicity,
    ],
  );

  const contentStyle = useMemo(
    () => getContentStyle({ isCompact, insetBottom: insets.bottom }),
    [isCompact, insets.bottom],
  );

  const { style: composerKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const centeredStyle = useMemo(
    () => [animatedStaticStyles.centered, composerKeyboardStyle],
    [composerKeyboardStyle],
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

  const formStack = useNewWorkspaceFormStack({
    isCompact,
    isPending,
    project: {
      anchorRef: projectPickerAnchorRef,
      open: openProjectPicker,
      options: projectPickerOptions,
      triggerLabel: projectTriggerLabel,
      selectedProject,
      iconDataByProjectViewKey: projectIconDataByProjectViewKey,
      selectedOptionId: selectedProjectOptionId,
      onSelect: handleSelectProjectOption,
      onAddProject: handleAddProject,
      openState: projectPickerOpen,
      onOpenChange: handleProjectPickerOpenChange,
      renderOption: renderProjectOption,
    },
    isolation: {
      anchorRef: isolationPickerAnchorRef,
      open: openIsolationPicker,
      effectiveIsolation,
      options: isolationOptions,
      onSelect: handleSelectIsolationOption,
      openState: isolationPickerOpen,
      onOpenChange: handleIsolationPickerOpenChange,
      renderOption: renderIsolationOption,
      canCreateWorktree,
    },
    base: {
      anchorRef: pickerAnchorRef,
      open: openPicker,
      selectedSourceDirectory,
      selectedItem,
      triggerLabel,
      options,
      selectedOptionId,
      onSelect: handleSelectOption,
      onCreateBranch: createBranch.open,
      canCreateBranch: createBranch.base !== null,
      openState: pickerOpen,
      onOpenChange: handlePickerOpenChange,
      setSearchQuery: setPickerSearchQuery,
      emptyText: pickerEmptyText,
      renderOption: renderPickerOption,
    },
  });

  const screenHeaderLeft = useMemo(() => <SidebarMenuToggle />, []);

  return (
    <FileDropZone style={styles.container}>
      <ScreenHeader left={screenHeaderLeft} borderless />
      <View style={contentStyle}>
        <TitlebarDragRegion />
        <ReanimatedAnimated.View style={centeredStyle}>
          {formStack}
          <Composer
            externalKeyboardShift
            agentId={draftKey}
            serverId={selectedServerId}
            isPaneFocused={true}
            onSubmitMessage={handleSubmitNewWorkspace}
            allowEmptySubmit={true}
            submitButtonAccessibilityLabel={t("newWorkspace.create")}
            submitButtonTestID="workspace-create-submit"
            submitIcon="return"
            isSubmitLoading={isPending}
            waitForGithubAutoAttachOnSubmit
            submitBehavior="preserve-and-lock"
            blurOnSubmit={true}
            value={chatDraft.text}
            onChangeText={chatDraft.setText}
            attachments={chatDraft.attachments}
            attachmentScopeKeys={visibleDraftContextScopeKeys}
            onChangeAttachments={chatDraft.setAttachments}
            onGithubPrDetected={handleGithubPrDetected}
            onGithubPrAutoAttach={handleGithubPrAutoAttach}
            cwd={selectedSourceDirectory ?? ""}
            clearDraft={handleClearDraft}
            autoFocus
            commandDraftConfig={composerState?.commandDraftConfig}
            agentControls={agentControlsWithDisabled}
            maxImages={arenaComposerMaxImages(arenaPreferences.battleMode)}
          />
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        </ReanimatedAnimated.View>
      </View>
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

const animatedStaticStyles = RNStyleSheet.create({
  centered: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
    alignItems: "center",
  },
  contentCentered: {
    justifyContent: "center",
    paddingBottom: HEADER_INNER_HEIGHT + theme.spacing[6],
  },
  contentCompact: {
    justifyContent: "flex-end",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
  formStack: {
    marginBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  formStackDesktop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: theme.spacing[3],
    // The badge adds its own left padding; this inset aligns its icon with the
    // composer's inner content. The trailing inset mirrors that alignment.
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[4],
    gap: theme.spacing[2],
  },
  desktopControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  // The badge adds its own left padding, so this reduced inset aligns compact
  // controls with the composer's inner content.
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[4],
    gap: theme.spacing[1],
  },
  baseSpacer: {
    height: BADGE_HEIGHT,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: BADGE_HEIGHT,
    maxWidth: 240,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
  },
  badgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  badgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  badgeDisabled: {
    opacity: 0.6,
  },
  badgeText: {
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  refDivergenceLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  chevronContainer: {
    flexShrink: 0,
    transform: [{ translateY: 1 }],
  },
  badgeIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectIconFallbackText: {
    // Single uppercase initial inside an iconSize.md (16px) square — below the
    // smallest font-size token, so it stays a literal sized to the box.
    fontSize: PROJECT_ICON_FALLBACK_FONT_SIZE,
    fontWeight: "600",
  },
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  hostStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
}));
