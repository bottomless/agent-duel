import { useMemo, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/**
 * Plugin items at the head of the sidebar, ordered and filtered by the user's
 * `sidebarNavItems` preference. Agent Duel's own head (Home, Chats and Archived)
 * is fixed, so the built-in Paseo rows are not rendered. Renders nothing — not
 * even the bordered group wrapper — when no item shows and there is no
 * `firstRowTrailing`.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(
    () => items.filter((item) => item.visible && item.kind === "plugin"),
    [items],
  );
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const [firstRow, ...restRows] = visibleItems.map((item) =>
    item.kind === "plugin" ? (
      <PluginSidebarItem
        key={item.key}
        group={item.group}
        section="header"
        fallbackAnchorRef={groupRef}
        onBeforeNavigate={onBeforeNavigate}
      />
    ) : null,
  );

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

const styles = StyleSheet.create({
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
});
