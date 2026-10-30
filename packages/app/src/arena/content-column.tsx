import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Dimensions, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ARENA_MAX_CONTENT_WIDTH } from "@/constants/layout";

// The stream list's horizontal gutter at its widest breakpoint. A bleeding column cancels the
// gutter, so the gutter is part of the width the card would take.
const STREAM_GUTTER = 16;

const ArenaBleedContext = createContext<number | null>(null);

/**
 * Whether the battle card runs edge to edge. True while the host is no wider than the card's
 * max width: the card then drops its side borders and corners, since they would sit on the
 * panel's edges. Past the max width the card is a centered, bordered card.
 */
export function useArenaCardBleed(maxWidth = ARENA_MAX_CONTENT_WIDTH): boolean {
  const hostWidth = useContext(ArenaBleedContext);
  return hostWidth !== null && hostWidth <= maxWidth;
}

/**
 * The column every battle renders into.
 *
 * A battle appears in two places — the live stream and, while an agent is being
 * created, the composer's draft tab — and the two hosts contribute different
 * chrome. Owning the width in one component is what keeps a battle from
 * resizing at the moment it goes live. Callers outside the stream list must
 * still supply that list's own horizontal padding around this column; the
 * battle card sets its own width inside it.
 *
 * With `fullBleed`, the column measures its host and, while the host is no wider than
 * `ARENA_MAX_CONTENT_WIDTH`, cancels the host's gutter so the card fills the panel. The outer
 * view keeps the gutter and is what gets measured, so the decision never depends on itself.
 * The first frame guesses from the window: a window no wider than the max cannot host a
 * wider column, and the measurement corrects the rare case the other way.
 */
export function ArenaContentColumn({
  children,
  fullBleed = false,
}: {
  children: ReactNode;
  fullBleed?: boolean;
}) {
  const [hostWidth, setHostWidth] = useState(() => Dimensions.get("window").width);
  const bleed = fullBleed && hostWidth <= ARENA_MAX_CONTENT_WIDTH;
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) setHostWidth(width + 2 * STREAM_GUTTER);
  }, []);
  return (
    <ArenaBleedContext.Provider value={bleed ? hostWidth : null}>
      <View style={styles.column} onLayout={fullBleed ? handleLayout : undefined}>
        <View style={bleed ? styles.bleed : styles.inset}>{children}</View>
      </View>
    </ArenaBleedContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: "100%",
    alignSelf: "center",
  },
  inset: {
    paddingHorizontal: theme.spacing[2],
  },
  // The stream list's gutter, undone: the web stream's `contentContainerStyle`
  // (agent-stream/strategy-web.tsx) and the draft tab's `draftBattleListPadding` both inset by
  // these amounts, the smaller one below `md`, where the stream counts as compact.
  bleed: {
    marginHorizontal: {
      xs: -theme.spacing[2],
      md: -theme.spacing[4],
    },
  },
}));
