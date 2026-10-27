import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useCallback } from "react";
import type { MenuTriggerState } from "@/components/ui/menu";
import { Text, View } from "react-native";
import { ChevronDown, CircleHelp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SingleAgentModelSize } from "@/arena/single-agent";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SingleAgentSizeControl({
  value,
  disabled,
  onChange,
  singleAgent,
}: {
  value: SingleAgentModelSize;
  disabled: boolean;
  singleAgent?: ArenaSnapshot["singleAgent"];
  onChange?: (value: SingleAgentModelSize) => void;
}) {
  const selectMedium = useCallback(() => onChange?.("medium"), [onChange]);
  const selectFrontier = useCallback(() => onChange?.("frontier"), [onChange]);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.trigger,
      (hovered || pressed || open) && styles.active,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  const helpStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.help,
      (hovered || pressed || open) && styles.active,
    ],
    [],
  );
  const revealedFrontier = singleAgent?.modelSize === "frontier" && singleAgent.revealed;
  const frontierIdentity = revealedFrontier ? singleAgent.identity?.name : undefined;
  return (
    <View style={styles.controls}>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel="About model sizes and required ratings"
          testID="arena-single-agent-help"
          style={helpStyle}
        >
          <ThemedCircleHelp size={16} uniProps={mutedMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" offset={8} width={300}>
          <Text style={styles.explanation}>
            Medium uses GPT Luna 5.6 Xhigh and can be used unlimitedly without a rating.
          </Text>
          <Text style={styles.explanation}>
            With frontier, the model stays hidden until you rate it. After the agent finishes, you
            must give a thumbs up or thumbs down to continue. Chat controls stay disabled until your
            rating is saved.
          </Text>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          disabled={disabled}
          accessibilityLabel={`Model size: ${value}`}
          testID="arena-single-agent-size-trigger"
          style={triggerStyle}
        >
          <Text style={styles.label}>Model size: {value}</Text>
          <ThemedChevronDown size={12} uniProps={mutedMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" offset={8} width={260}>
          <DropdownMenuItem
            selected={value === "medium"}
            disabled={disabled}
            onSelect={selectMedium}
            description="GPT Luna 5.6 Xhigh · Unlimited use"
            testID="arena-single-agent-size-medium"
          >
            Medium
          </DropdownMenuItem>
          <DropdownMenuItem
            selected={value === "frontier"}
            disabled={disabled}
            onSelect={selectFrontier}
            description="Model hidden · Rating required"
            testID="arena-single-agent-size-frontier"
          >
            Frontier
          </DropdownMenuItem>
          {frontierIdentity ? (
            <Text style={styles.explanation}>Last rated model: {frontierIdentity}</Text>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  trigger: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  help: {
    height: 28,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  active: { backgroundColor: theme.colors.surface2 },
  disabled: { opacity: 0.5 },
  explanation: {
    padding: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
