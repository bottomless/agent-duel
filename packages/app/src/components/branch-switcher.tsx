import { forwardRef, useCallback, useMemo, useRef } from "react";
import { Text, View, type PressableProps } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch, Swords } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import {
  ToolbarLabelSelectTrigger,
  ToolbarLabelTriggerIcon,
  toolbarLabelTriggerStyle,
  type ToolbarLabelTriggerState,
} from "@/components/ui/toolbar-label-trigger";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PressHighlight } from "@/components/ui/press-highlight";

/**
 * A destination that is not a branch — an Arena contestant worktree, which lives
 * on a detached HEAD. Pinned options head the list and never reach git.
 */
export interface BranchSwitcherPinnedOption {
  id: string;
  label: string;
  description?: string;
}

interface BranchSwitcherProps {
  currentBranchName: string | null;
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  testID?: string;
  pinnedOptions?: BranchSwitcherPinnedOption[];
  pinnedSelectedId?: string | null;
  /** Receives a pinned id, or null when a real branch takes over. */
  onPinnedSelect?: (id: string | null) => void;
}

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const accentIconColorMapping = (theme: Theme) => ({
  color: theme.colors.accentBright,
});
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedSwords = withUnistyles(Swords);
const ThemedChevronDown = withUnistyles(ChevronDown);

const EMPTY_PINNED_OPTIONS: BranchSwitcherPinnedOption[] = [];

interface PinnedSelectTriggerProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  open?: boolean;
}

/** The branch trigger's geometry, marked as a contestant worktree rather than a branch. */
const PinnedSelectTrigger = forwardRef<View, PinnedSelectTriggerProps>(function PinnedSelectTrigger(
  { label, open = false, ...props },
  ref,
) {
  const triggerStyle = useCallback(
    (state: ToolbarLabelTriggerState) => toolbarLabelTriggerStyle({ ...state, open }),
    [open],
  );
  return (
    <PressHighlight {...props} ref={ref} style={triggerStyle}>
      <ToolbarLabelTriggerIcon>
        <ThemedSwords size={14} uniProps={accentIconColorMapping} />
      </ToolbarLabelTriggerIcon>
      <Text style={styles.pinnedLabel} numberOfLines={1}>
        {label}
      </Text>
      <ToolbarLabelTriggerIcon>
        <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
      </ToolbarLabelTriggerIcon>
    </PressHighlight>
  );
});

export function BranchSwitcher({
  currentBranchName,
  serverId,
  workspaceId,
  workspaceDirectory,
  isGitCheckout,
  testID = "workspace-header-branch-switcher",
  pinnedOptions = EMPTY_PINNED_OPTIONS,
  pinnedSelectedId = null,
  onPinnedSelect,
}: BranchSwitcherProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const queryClient = useQueryClient();

  const { branchOptions, isOpen, setIsOpen, handleBranchSelect } = useBranchSwitcher({
    client,
    normalizedServerId: serverId,
    normalizedWorkspaceId: workspaceId,
    workspaceDirectory,
    currentBranchName,
    isGitCheckout,
    isConnected,
    toast,
    queryClient,
  });

  const handleOpen = useCallback(() => setIsOpen(true), [setIsOpen]);

  const pinnedIds = useMemo(
    () => new Set(pinnedOptions.map((option) => option.id)),
    [pinnedOptions],
  );
  const pinnedSelected = useMemo(
    () => pinnedOptions.find((option) => option.id === pinnedSelectedId) ?? null,
    [pinnedOptions, pinnedSelectedId],
  );

  const options = useMemo(
    () => [...pinnedOptions, ...branchOptions],
    [branchOptions, pinnedOptions],
  );

  const handleSelect = useCallback(
    (id: string) => {
      if (pinnedIds.has(id)) {
        onPinnedSelect?.(id);
        setIsOpen(false);
        return;
      }
      // Leaving a contestant worktree behind before the checkout moves under it.
      onPinnedSelect?.(null);
      handleBranchSelect(id);
    },
    [handleBranchSelect, onPinnedSelect, pinnedIds, setIsOpen],
  );

  const branchLeadingSlot = useMemo(
    () => <ThemedGitBranch size={14} uniProps={foregroundMutedIconColorMapping} />,
    [],
  );
  const pinnedLeadingSlot = useMemo(
    () => <ThemedSwords size={14} uniProps={accentIconColorMapping} />,
    [],
  );

  const renderBranchOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        description={option.description}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={pinnedIds.has(option.id) ? pinnedLeadingSlot : branchLeadingSlot}
      />
    ),
    [branchLeadingSlot, pinnedIds, pinnedLeadingSlot],
  );

  if (!currentBranchName && !pinnedSelected && pinnedOptions.length === 0) {
    return null;
  }

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          {pinnedSelected ? (
            <PinnedSelectTrigger
              testID={testID}
              label={pinnedSelected.label}
              open={isOpen}
              onPress={handleOpen}
              accessibilityRole="button"
              accessibilityLabel={pinnedSelected.label}
            />
          ) : (
            <ToolbarLabelSelectTrigger
              testID={testID}
              label={currentBranchName ?? ""}
              open={isOpen}
              onPress={handleOpen}
              accessibilityRole="button"
              accessibilityLabel={t("branchSwitcher.currentBranch", {
                branchName: currentBranchName,
              })}
            />
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{t("branchSwitcher.triggerTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={pinnedSelected?.id ?? currentBranchName ?? ""}
        onSelect={handleSelect}
        searchable
        placeholder={t("branchSwitcher.placeholder")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={t("branchSwitcher.empty")}
        title={t("branchSwitcher.title")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderBranchOption}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 1,
    minWidth: 0,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  pinnedLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.accentBright,
    fontWeight: theme.fontWeight.normal,
  },
}));
