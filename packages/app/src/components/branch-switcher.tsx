import { useCallback, useMemo, useRef } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch, Swords } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";

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

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      (Boolean(hovered) || pressed) && styles.triggerHovered,
    ],
    [],
  );

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

  const triggerLabel = pinnedSelected?.label ?? currentBranchName ?? "";

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Pressable
        testID={testID}
        onPress={handleOpen}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={
          pinnedSelected
            ? pinnedSelected.label
            : t("branchSwitcher.currentBranch", { branchName: currentBranchName })
        }
      >
        {pinnedSelected ? (
          <ThemedSwords size={14} uniProps={accentIconColorMapping} />
        ) : (
          <ThemedGitBranch size={14} uniProps={foregroundMutedIconColorMapping} />
        )}
        <Text
          style={[styles.branchLabel, pinnedSelected ? styles.pinnedLabel : null]}
          numberOfLines={1}
        >
          {triggerLabel}
        </Text>
        <ThemedChevronDown size={12} uniProps={foregroundMutedIconColorMapping} />
      </Pressable>
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
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginLeft: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexShrink: 1,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
  branchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  pinnedLabel: {
    color: theme.colors.accentBright,
  },
}));
