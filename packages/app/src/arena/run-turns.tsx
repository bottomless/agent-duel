import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaRun, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import { arenaRunRequestTimes } from "./run-segments";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The menu scrolls past five and a half 28pt rows (docs/menus.md) below its 4pt top inset, so it
// covers little of the thread and the cut-off row shows there is more.
const TURNS_MENU_MAX_HEIGHT = 4 + 28 * 5.5;

type RegisterMessageAnchor = (messageId: string, node: View | null) => void;

const ArenaMessageAnchorContext = createContext<RegisterMessageAnchor | null>(null);

export const ArenaMessageAnchorProvider = ArenaMessageAnchorContext.Provider;

/** Marks where a user message sits in its pane's thread, so the turns menu can scroll to it. */
export function ArenaMessageAnchor({
  messageId,
  children,
}: {
  messageId: string;
  children: ReactNode;
}) {
  const register = useContext(ArenaMessageAnchorContext);
  const ref = useCallback(
    (node: View | null) => {
      register?.(messageId, node);
    },
    [messageId, register],
  );
  if (!register) return children;
  return (
    <View ref={ref} collapsable={false}>
      {children}
    </View>
  );
}

interface TurnRow {
  key: string;
  /** The follow-up that began the turn; null for the first, whose prompt is above the panes. */
  messageId: string | null;
  label: string;
  duration: string;
}

function runTurnRows(run: ArenaRun): TurnRow[] | null {
  const times = arenaRunRequestTimes(run);
  if (!times) return null;
  return times.map(({ durationMs, messageId }, index) => ({
    key: messageId ?? String(index),
    messageId: index === 0 ? null : messageId,
    label: `Turn ${index + 1}`,
    duration: durationMs === null ? "Working" : formatDuration(durationMs),
  }));
}

/**
 * Beside the contestant's name once it has answered a follow-up: how many turns its run has, and
 * a menu of each one's time that scrolls the pane to the message that began it. The header's time
 * stays the run's total, which these add up to.
 */
export function ArenaRunTurnsMenu({
  run,
  side,
  onJumpToMessage,
}: {
  run: ArenaRun;
  side: ArenaSide;
  onJumpToMessage: (messageId: string | null) => void;
}) {
  const rows = useMemo(() => runTurnRows(run), [run]);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.trigger,
      (hovered || pressed || open) && styles.triggerActive,
    ],
    [],
  );
  if (!rows) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={`Agent ${side.toUpperCase()}'s ${rows.length} turns`}
        testID={`arena-run-turns-${side}`}
      >
        <Text style={styles.label}>{rows.length} turns</Text>
        <ThemedChevronDown size={12} uniProps={mutedMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        width={160}
        minWidth={160}
        maxHeight={TURNS_MENU_MAX_HEIGHT}
        scrollable
        testID={`arena-run-turns-${side}-content`}
      >
        {rows.map((row) => (
          <TurnItem key={row.key} row={row} onJumpToMessage={onJumpToMessage} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TurnItem({
  row,
  onJumpToMessage,
}: {
  row: TurnRow;
  onJumpToMessage: (messageId: string | null) => void;
}) {
  const { messageId } = row;
  const jump = useCallback(() => onJumpToMessage(messageId), [messageId, onJumpToMessage]);
  const duration = useMemo(() => <Text style={styles.duration}>{row.duration}</Text>, [row]);
  return (
    <DropdownMenuItem onSelect={jump} trailing={duration} testID={`arena-run-turn-${row.key}`}>
      {row.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Taller than the name beside it for a comfortable hover fill, so it gives the extra back:
  // the header keeps its height when a follow-up adds the menu to one pane and not the other.
  trigger: {
    height: 24,
    marginVertical: -2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  duration: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
