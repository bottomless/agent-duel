import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useCompactComposerToolbar } from "@/composer/toolbar-layout";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ShieldCheck, ShieldQuestion } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";

const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedShieldQuestion = withUnistyles(ShieldQuestion);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ArenaAutoAcceptControl({
  enabled,
  disabled,
  battleActive,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  battleActive: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const compact = useCompactComposerToolbar();
  const enable = useCallback(() => onChange(true), [onChange]);
  const disable = useCallback(() => onChange(false), [onChange]);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.trigger,
      compact && styles.iconOnly,
      (hovered || pressed || open) && styles.active,
      disabled && styles.disabled,
    ],
    [compact, disabled],
  );
  const label = enabled ? t("arena.autoAccept") : t("arena.askBeforeTools");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={triggerStyle}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={t("arena.toolPermissionsLabel", { label: label })}
              testID="arena-auto-accept-menu-trigger"
            >
              {enabled ? (
                <ThemedShieldCheck size={16} uniProps={mutedMapping} />
              ) : (
                <ThemedShieldQuestion size={16} uniProps={mutedMapping} />
              )}
              {!compact ? (
                <>
                  <Text style={styles.label}>{label}</Text>
                  <ThemedChevronDown size={12} uniProps={mutedMapping} />
                </>
              ) : null}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        width={300}
        testID="arena-auto-accept-menu"
      >
        <DropdownMenuLabel>{t("arena.toolPermissions")}</DropdownMenuLabel>
        <DropdownMenuItem
          selected={!enabled}
          onSelect={disable}
          testID="arena-auto-accept-off"
          description={t("arena.reviewPermissions")}
        >
          {t("arena.askBeforeTools")}{" "}
        </DropdownMenuItem>
        <DropdownMenuItem
          selected={enabled}
          onSelect={enable}
          testID="arena-auto-accept-on"
          description={t("arena.acceptPermissions")}
        >
          {t("arena.autoAccept")}{" "}
        </DropdownMenuItem>
        {/* Both composers also save the choice as the provider's default (useDraftAgentFeatures,
            AgentControls' handleSetFeature): new chats start with it, other chats keep theirs. */}
        <Text style={styles.hint}>
          {t(battleActive ? "arena.permissionsBoth" : "arena.permissionsChat")}
        </Text>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  iconOnly: {
    width: 28,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  // Tooltips read in the popover's own text color; the muted toolbar label read grey there.
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  active: { backgroundColor: theme.colors.surface2 },
  disabled: { opacity: 0.5 },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));
