import { createContext, useContext, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ARENA_MAX_CONTENT_WIDTH } from "@/constants/layout";
import { BATTLE_RAIL } from "@/arena/battle-layout";

/**
 * An Agent Duel chat lays its rows on the battle's rails, so the conversation after a battle starts
 * where the battle's answers did. Rows keep the chat's reading width from that left edge; a battle's
 * prompt, set as a heading, takes the battle's whole width.
 */
interface ArenaRowLayout {
  fullWidthIds: ReadonlySet<string> | undefined;
  /** Rows that start a new turn: a rule above them closes the turn before. */
  ruledIds: ReadonlySet<string> | undefined;
  /** What ends a turn's footer, at the battle's right edge, keyed by the footer's host row. */
  footerEnds: ReadonlyMap<string, ReactNode> | undefined;
}

const ArenaRowLayoutContext = createContext<ArenaRowLayout | null>(null);

export function ArenaRowLayoutProvider({
  enabled,
  fullWidthIds,
  ruledIds,
  footerEnds,
  children,
}: ArenaRowLayout & { enabled: boolean; children: ReactNode }) {
  const value = useMemo(
    () => (enabled ? { fullWidthIds, ruledIds, footerEnds } : null),
    [enabled, footerEnds, fullWidthIds, ruledIds],
  );
  return <ArenaRowLayoutContext.Provider value={value}>{children}</ArenaRowLayoutContext.Provider>;
}

export function useArenaRowLayout(): ArenaRowLayout | null {
  return useContext(ArenaRowLayoutContext);
}

/**
 * A row on the battle's rails. The stream list already insets by its gutter, so the row adds the
 * rest of the rail; its width stops where the battle's does, so the two left edges meet at any
 * window width. A ruled row draws its rule between the rails.
 */
export function ArenaRow({
  fullWidth,
  ruled = false,
  style,
  children,
}: {
  fullWidth: boolean;
  ruled?: boolean;
  style?: object;
  children: ReactNode;
}) {
  const content = fullWidth ? children : <View style={styles.reading}>{children}</View>;
  return (
    <View style={[styles.row, style]}>
      {ruled ? <View style={styles.rule}>{content}</View> : content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    width: "100%",
    maxWidth: ARENA_MAX_CONTENT_WIDTH - 2 * theme.spacing[4],
    alignSelf: "center",
    paddingHorizontal: {
      xs: BATTLE_RAIL - theme.spacing[3],
      md: BATTLE_RAIL - theme.spacing[4],
    },
  },
  reading: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  // The turn before ends with its footer's own space below; the rule adds a little more.
  rule: {
    marginTop: theme.spacing[1],
    paddingTop: theme.spacing[8],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));
