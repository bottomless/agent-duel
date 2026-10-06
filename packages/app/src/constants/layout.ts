import { useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

export const FOOTER_HEIGHT = 75;

// Shared header inner height (excluding safe area insets and border)
// Used by both agent header (ScreenHeader) and explorer sidebar header
// This ensures both headers have the same visual height
export const HEADER_INNER_HEIGHT = 48;
export const HEADER_INNER_HEIGHT_MOBILE = 56;
export const WORKSPACE_SECONDARY_HEADER_HEIGHT = 36;
export const HEADER_TOP_PADDING_MOBILE = 8;

// Max width for chat content (stream view, input area, new agent form)
export const MAX_CONTENT_WIDTH = 820;
export const COMPACT_FORM_FACTOR_WIDTH = 500;

// Floors for the workspace chat and its side panel, in the shape of the Codex app's panels. The
// split is stored as a fraction, so without them a wide window let a dragged panel squeeze the
// chat until the composer's controls overlapped, or squeeze the panel until its tabs read "T..".
// The chat floor, the 1px split handle and the panel floor fill the `md` breakpoint (720) exactly;
// below it the workspace shows one pane at a time, so both always fit. A panel that needs more
// room has focus mode.
const TWO_PANE_MIN_WORKSPACE_WIDTH = 720;
const SPLIT_HANDLE_WIDTH = 1;
export const WORKSPACE_CHAT_MIN_WIDTH = 400;
export const WORKSPACE_SIDE_PANEL_MIN_WIDTH =
  TWO_PANE_MIN_WORKSPACE_WIDTH - WORKSPACE_CHAT_MIN_WIDTH - SPLIT_HANDLE_WIDTH;
// Docked at the bottom, the panel keeps a usable height and never takes more than half.
export const WORKSPACE_BOTTOM_PANEL_MIN_HEIGHT = 160;
export const WORKSPACE_BOTTOM_PANEL_MAX_SHARE = 0.5;

// Wider column for arena battle content (side-by-side panes, battle summaries).
// Up to this width the live battle card fills the panel edge to edge, and each
// pane gets at most the chat's own reading column. Past it, a pane's lines
// would run longer than the chat ever lets prose run, so the card is centered
// at this width with its borders instead. A 14" MacBook Pro at full screen
// (1512 wide) never reaches it.
export const ARENA_MAX_CONTENT_WIDTH = 2 * MAX_CONTENT_WIDTH;

// Flex basis for one agent pane in a battle comparison. Panes are laid out as a
// wrapping row, so two of them share a line only while `2 * basis + gap` fits;
// below that the second pane wraps and both go full width. Expressing the
// breakpoint as a basis keeps it a single layout pass — measuring the row in JS
// costs a frame of wrong layout before the measurement lands.
export const ARENA_PANE_BASIS_WIDTH = 320;

// The gap between the two panes, and the chrome between the pane row and the
// panel edge: 12 + 1 card padding and border, 8 arena column, 16 list content
// padding, on each side.
const ARENA_PANE_ROW_GAP = 12;
const ARENA_PANE_ROW_CHROME_WIDTH = 74;

// Width the center panel needs before a battle's two panes stack. The desktop
// shell treats this as the center's minimum: rather than let a pinned sidebar
// or Explorer squeeze the panes into a column, both panels float over the
// content instead. See `resolveDesktopPanelPresentation`.
export const ARENA_TWO_PANE_MIN_CONTENT_WIDTH =
  2 * ARENA_PANE_BASIS_WIDTH + ARENA_PANE_ROW_GAP + ARENA_PANE_ROW_CHROME_WIDTH;

// Settings uses the canonical desktop list + detail layout. Its sidebar and
// detail target must fit together before it can share width with app navigation.
export const SETTINGS_DESKTOP_SIDEBAR_WIDTH = 320;
export const SETTINGS_DESKTOP_DETAIL_MIN_WIDTH = 400;
export const SETTINGS_DESKTOP_SPLIT_MIN_WIDTH =
  SETTINGS_DESKTOP_SIDEBAR_WIDTH + SETTINGS_DESKTOP_DETAIL_MIN_WIDTH;

// Desktop app constants for macOS traffic light buttons
// These buttons (close/minimize/maximize) overlay the top-left corner
export const DESKTOP_TRAFFIC_LIGHT_WIDTH = 78;
export const DESKTOP_TRAFFIC_LIGHT_HEIGHT = 45;

// Windows/Linux window controls (minimize/maximize/close) — top-right
export const DESKTOP_WINDOW_CONTROLS_WIDTH = 140;
export const DESKTOP_WINDOW_CONTROLS_HEIGHT = 48;

export {
  getIsElectron as getIsElectronRuntime,
  getIsElectronMac as getIsElectronRuntimeMac,
} from "./platform";

/**
 * Reactive hook — re-renders the component when the breakpoint changes.
 * Always use this instead of reading UnistylesRuntime.breakpoint directly.
 */
export function useIsCompactFormFactor(): boolean {
  const { rt } = useUnistyles();
  return rt.breakpoint === "xs" || rt.breakpoint === "sm";
}

// SplitContainer relies on dnd-kit and DOM-backed accessibility helpers.
// Keep that capability distinct from desktop-width layout so touch tablets
// can use the desktop shell without entering web-only code paths.
export function supportsDesktopPaneSplits(): boolean {
  return isWeb;
}
