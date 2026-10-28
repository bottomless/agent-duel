import { useCallback } from "react";
import { View } from "react-native";
import { EllipsisVertical, WrapText } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  DIFF_LAYOUT_OPTIONS,
  useArenaDiffLayout,
  useArenaDiffLayoutStore,
  type ArenaDiffLayout,
} from "./diff-layout";
import { useArenaDiffWrap } from "./diff-wrap";
import { paneIconMenuTriggerStyle } from "./pane-icon-action";

const ThemedEllipsis = withUnistyles(EllipsisVertical);
const ThemedWrapText = withUnistyles(WrapText);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const WRAP_ICON = <ThemedWrapText size={14} uniProps={mutedColorMapping} />;

/**
 * The controls over how a chat's diffs are laid out: A beside B, or one column; and, behind the
 * options menu, whether long lines wrap. The width picks the layout until the reader does; the
 * choice holds for the chat. Wrapping is the Changes panel's setting, so it holds everywhere.
 */
export function DiffLayoutControl({ agentId, width }: { agentId: string; width: number | null }) {
  const layout = useArenaDiffLayout(agentId, width);
  const setLayout = useArenaDiffLayoutStore((state) => state.setLayout);
  const onChange = useCallback(
    (next: ArenaDiffLayout) => setLayout(agentId, next),
    [agentId, setLayout],
  );
  return (
    <View style={styles.row}>
      <SegmentedControl
        options={DIFF_LAYOUT_OPTIONS}
        value={layout}
        onValueChange={onChange}
        size="xs"
        testID="arena-diff-layout"
      />
      <DiffOptionsMenu />
    </View>
  );
}

function DiffOptionsMenu() {
  const { wrapLines, toggle } = useArenaDiffWrap();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        accessibilityLabel="Diff options"
        accessibilityRole="button"
        style={paneIconMenuTriggerStyle}
        testID="arena-diff-options"
      >
        <ThemedEllipsis size={ICON_SIZE.xs} uniProps={foregroundColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        <DropdownMenuItem
          leading={WRAP_ICON}
          selected={wrapLines}
          onSelect={toggle}
          testID="arena-diff-wrap"
        >
          Wrap long lines
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
