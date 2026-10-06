import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { type ReactElement, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditorTargetIcon } from "@/components/icons/editor-target-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openExternalUrl } from "@/utils/open-external-url";
import { isAbsolutePath } from "@/utils/path";
import { isWeb } from "@/constants/platform";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";
import { planWorkspaceOpenTargets } from "@/workspace/open-target-planner";
import type { Theme } from "@/styles/theme";
import { ForgeBrandIcon } from "@/git/forge-icon";
import { getForgePresentation } from "@/git/forge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface WorkspaceOpenInEditorMenuItemsProps {
  serverId: string;
  cwd: string;
  activeFile?: WorkspaceFileLocation | null;
  additionalFiles?: readonly WorkspaceFileLocation[];
}

export interface WorkspaceOpenInEditorButtonProps extends WorkspaceOpenInEditorMenuItemsProps {
  buttonLabel?: string;
  hideLabels?: boolean;
}

export interface WorkspaceOpenInEditorSubTriggerProps extends WorkspaceOpenInEditorMenuItemsProps {
  id: string;
  testID?: string;
}

interface OpenTarget {
  id: string;
  label: string;
  icon: ReactElement;
  onOpen: () => Promise<void> | void;
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedEditorTargetIcon = withUnistyles(EditorTargetIcon);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCheckIcon = withUnistyles(Check);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function renderForgeOpenTargetIcon(icon: string): ReactElement {
  return <ForgeBrandIcon iconKind={icon} size={16} uniProps={mutedColorMapping} />;
}

interface OpenTargetMenuItemProps {
  target: OpenTarget;
  isPreferred: boolean;
  onOpen: (target: OpenTarget) => void;
  label?: string;
}

function OpenTargetMenuItem({ target, isPreferred, onOpen, label }: OpenTargetMenuItemProps) {
  const handleSelect = useCallback(() => onOpen(target), [onOpen, target]);
  const trailing = useMemo(
    () => (isPreferred ? <ThemedCheckIcon size={16} uniProps={mutedColorMapping} /> : undefined),
    [isPreferred],
  );
  return (
    <DropdownMenuItem
      testID={`workspace-open-in-editor-item-${target.id}`}
      leading={target.icon}
      trailing={trailing}
      onSelect={handleSelect}
    >
      {label ?? target.label}
    </DropdownMenuItem>
  );
}

function useWorkspaceOpenInEditor({
  serverId,
  cwd,
  activeFile,
  additionalFiles,
}: WorkspaceOpenInEditorMenuItemsProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { preferredEditorId, updatePreferredEditor } = usePreferredEditor();
  const { targets: desktopOpenTargets, isAvailable: isDesktopOpenAvailable } =
    useDesktopOpenTargets({
      isLocalExecution: isLocalDaemon,
    });

  const resolvedFile = useMemo(
    () =>
      activeFile ? resolveWorkspaceFilePaths({ path: activeFile.path, workspaceRoot: cwd }) : null,
    [activeFile, cwd],
  );
  const activeFileName = useMemo(
    () => resolvedFile?.absolutePath.split("/").findLast(Boolean) ?? null,
    [resolvedFile],
  );

  const canResolveWorkspace = isWeb && cwd.trim().length > 0 && isAbsolutePath(cwd);
  const shouldQueryCheckout = canResolveWorkspace && isConnected;

  const { status: checkoutStatus } = useCheckoutStatusQuery({
    serverId,
    cwd: shouldQueryCheckout ? cwd : "",
  });
  const { resolvedForge } = useCheckoutPrStatusQuery({
    serverId,
    cwd: shouldQueryCheckout ? cwd : "",
  });

  const targets = useMemo<OpenTarget[]>(
    () =>
      planWorkspaceOpenTargets({
        workspaceDirectory: cwd,
        activeFile,
        resolvedActiveFile: resolvedFile,
        desktopTargets: desktopOpenTargets,
        canUseDesktopBridge: isDesktopOpenAvailable,
        isLocalExecution: isLocalDaemon,
        checkoutStatus,
        forge: resolvedForge,
      }).map((target) => {
        if (target.source === "forge") {
          const presentation = getForgePresentation(target.forge);
          return {
            id: target.id,
            label: target.label,
            icon: renderForgeOpenTargetIcon(presentation.icon),
            onOpen: () => openExternalUrl(target.url),
          };
        }
        return {
          id: target.id,
          label: target.label,
          icon: (
            <ThemedEditorTargetIcon icon={target.icon} size={16} uniProps={mutedColorMapping} />
          ),
          onOpen: async () => {
            await openDesktopTarget(target.openInput);
            const editor = desktopOpenTargets.find((item) => item.id === target.id);
            if (editor?.kind !== "editor") return;
            for (const file of additionalFiles ?? []) {
              const resolved = resolveWorkspaceFilePaths({ path: file.path, workspaceRoot: cwd });
              if (!resolved) throw new Error(`Could not resolve file: ${file.path}`);
              await openDesktopTarget({
                editorId: target.id,
                workspacePath: cwd,
                filePath: resolved.absolutePath,
                ...(file.lineStart ? { line: file.lineStart } : {}),
              });
            }
          },
        };
      }),
    [
      activeFile,
      additionalFiles,
      checkoutStatus,
      cwd,
      desktopOpenTargets,
      resolvedForge,
      isDesktopOpenAvailable,
      isLocalDaemon,
      resolvedFile,
    ],
  );

  const targetIds = useMemo(() => targets.map((target) => target.id), [targets]);
  const effectivePreferredEditorId = useMemo(
    () => resolvePreferredEditorId(targetIds, preferredEditorId),
    [targetIds, preferredEditorId],
  );
  const primaryOption = targets.find((target) => target.id === effectivePreferredEditorId) ?? null;

  const openMutation = useMutation({
    mutationFn: (target: OpenTarget) => Promise.resolve(target.onOpen()),
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : t("workspace.git.openInEditor.failedOpen"),
      );
    },
  });

  const handleOpenTarget = useCallback(
    (target: OpenTarget) => {
      void updatePreferredEditor(target.id).catch(() => undefined);
      openMutation.mutate(target);
    },
    [openMutation, updatePreferredEditor],
  );

  return {
    activeFileName,
    canResolveWorkspace,
    effectivePreferredEditorId,
    handleOpenTarget,
    isPending: openMutation.isPending,
    primaryOption,
    targets,
  };
}

export function WorkspaceOpenInEditorMenuItems({
  serverId,
  cwd,
  activeFile,
  additionalFiles,
}: WorkspaceOpenInEditorMenuItemsProps): ReactElement | null {
  const { t } = useTranslation();
  const {
    activeFileName,
    canResolveWorkspace,
    effectivePreferredEditorId,
    handleOpenTarget,
    targets,
  } = useWorkspaceOpenInEditor({ serverId, cwd, activeFile, additionalFiles });

  if (!canResolveWorkspace || targets.length === 0) {
    return null;
  }

  const label = activeFileName
    ? (target: OpenTarget) =>
        t("workspace.git.openInEditor.openFileIn", {
          fileName: activeFileName,
          target: target.label,
        })
    : (target: OpenTarget) =>
        t("workspace.git.openInEditor.openIn", {
          target: target.label,
        });

  return (
    <>
      {targets.map((target) => (
        <OpenTargetMenuItem
          key={target.id}
          target={target}
          isPreferred={target.id === effectivePreferredEditorId}
          onOpen={handleOpenTarget}
          label={label(target)}
        />
      ))}
    </>
  );
}

export function WorkspaceOpenInEditorSubTrigger({
  id,
  testID,
  serverId,
  cwd,
  activeFile,
  additionalFiles,
}: WorkspaceOpenInEditorSubTriggerProps): ReactElement | null {
  const { t } = useTranslation();
  const { canResolveWorkspace, targets } = useWorkspaceOpenInEditor({
    serverId,
    cwd,
    activeFile,
    additionalFiles,
  });

  if (!canResolveWorkspace || targets.length === 0) {
    return null;
  }

  return (
    <DropdownMenuSubTrigger id={id} testID={testID}>
      {t("workspace.git.openInEditor.chooseEditor")}
    </DropdownMenuSubTrigger>
  );
}

export function WorkspaceOpenInEditorButton({
  serverId,
  cwd,
  activeFile,
  additionalFiles,
  buttonLabel,
  hideLabels,
}: WorkspaceOpenInEditorButtonProps) {
  const { t } = useTranslation();
  const {
    activeFileName,
    canResolveWorkspace,
    effectivePreferredEditorId,
    handleOpenTarget,
    isPending,
    primaryOption,
    targets,
  } = useWorkspaceOpenInEditor({ serverId, cwd, activeFile, additionalFiles });

  const primaryPressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.splitButtonPrimary,
      (Boolean(hovered) || pressed) && styles.splitButtonPrimaryHovered,
      isPending && styles.splitButtonPrimaryDisabled,
    ],
    [isPending],
  );

  const caretTriggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      styles.splitButtonCaret,
      (hovered || pressed || open) && styles.splitButtonCaretHovered,
    ],
    [],
  );

  const handlePrimaryPress = useCallback(() => {
    if (primaryOption) {
      handleOpenTarget(primaryOption);
    }
  }, [primaryOption, handleOpenTarget]);

  if (!canResolveWorkspace || !primaryOption || targets.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      <View style={styles.splitButton}>
        <Pressable
          testID="workspace-open-in-editor-primary"
          style={primaryPressableStyle}
          onPress={handlePrimaryPress}
          disabled={isPending}
          accessibilityRole="button"
          accessibilityLabel={
            buttonLabel ??
            (activeFileName
              ? t("workspace.git.openInEditor.openFileIn", {
                  fileName: activeFileName,
                  target: primaryOption.label,
                })
              : t("workspace.git.openInEditor.openIn", {
                  target: primaryOption.label,
                }))
          }
        >
          {isPending ? (
            <ThemedLoadingSpinner
              size="small"
              uniProps={foregroundColorMapping}
              style={styles.splitButtonSpinnerOnly}
            />
          ) : (
            <View style={styles.splitButtonContent}>
              {primaryOption.icon}
              {!hideLabels && (
                <Text style={styles.splitButtonText}>
                  {buttonLabel ?? t("workspace.git.openInEditor.open")}
                </Text>
              )}
            </View>
          )}
        </Pressable>
        {targets.length > 1 ? (
          <DropdownMenu>
            <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger
                  testID="workspace-open-in-editor-caret"
                  style={caretTriggerStyle}
                  accessibilityRole="button"
                  accessibilityLabel={t("workspace.git.openInEditor.chooseEditor")}
                >
                  <ThemedChevronDown size={16} uniProps={mutedColorMapping} />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" offset={8}>
                <Text style={styles.tooltipText}>
                  {t("workspace.git.openInEditor.chooseEditor")}
                </Text>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              minWidth={148}
              maxWidth={176}
              testID="workspace-open-in-editor-menu"
            >
              {targets.map((target) => (
                <OpenTargetMenuItem
                  key={target.id}
                  target={target}
                  isPreferred={target.id === effectivePreferredEditorId}
                  onOpen={handleOpenTarget}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  splitButton: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  splitButtonPrimary: {
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryIconOnly: {
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    minHeight: theme.fontSize.sm * 1.5,
  },
  splitButtonSpinnerOnly: {
    transform: [{ scale: 0.8 }],
  },
  splitButtonCaret: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  splitButtonCaretHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
