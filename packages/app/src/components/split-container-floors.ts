import type { ViewStyle } from "react-native";
import {
  WORKSPACE_BOTTOM_PANEL_MAX_SHARE,
  WORKSPACE_BOTTOM_PANEL_MIN_HEIGHT,
  WORKSPACE_CHAT_MIN_WIDTH,
  WORKSPACE_SIDE_PANEL_MIN_WIDTH,
} from "@/constants/layout";

export interface ResizeHandleFloors {
  leadingPx?: number;
  /** A share of the group, for a pane that must keep a proportion rather than a fixed size. */
  leadingShare?: number;
  trailingPx?: number;
}

export interface SplitFloors {
  /** The minimum each child renders at, so a stored split from before the floors still fits. */
  childStyles: readonly (ViewStyle | null)[];
  /** The same floors for the handle, so a drag stops where the layout already does. */
  handle: ResizeHandleFloors | undefined;
}

const NO_FLOORS: SplitFloors = { childStyles: [], handle: undefined };

const BESIDE_FLOORS: SplitFloors = {
  childStyles: [
    { minWidth: WORKSPACE_CHAT_MIN_WIDTH },
    { minWidth: WORKSPACE_SIDE_PANEL_MIN_WIDTH },
  ],
  handle: { leadingPx: WORKSPACE_CHAT_MIN_WIDTH, trailingPx: WORKSPACE_SIDE_PANEL_MIN_WIDTH },
};

const CHAT_MIN_SHARE_BELOW = 1 - WORKSPACE_BOTTOM_PANEL_MAX_SHARE;
const BELOW_FLOORS: SplitFloors = {
  childStyles: [
    { minHeight: `${CHAT_MIN_SHARE_BELOW * 100}%` },
    { minHeight: WORKSPACE_BOTTOM_PANEL_MIN_HEIGHT },
  ],
  handle: { leadingShare: CHAT_MIN_SHARE_BELOW, trailingPx: WORKSPACE_BOTTOM_PANEL_MIN_HEIGHT },
};

/**
 * Floors for the workspace's chat-and-panel group. They apply only to that shape, chat first and
 * the side pane second; any other group keeps the plain fractional minimum.
 */
export function resolveSplitFloors(input: {
  direction: "horizontal" | "vertical";
  childIsSidePane: readonly boolean[];
}): SplitFloors {
  const [chatIsSide, panelIsSide] = input.childIsSidePane;
  if (input.childIsSidePane.length !== 2 || chatIsSide || !panelIsSide) return NO_FLOORS;
  return input.direction === "horizontal" ? BESIDE_FLOORS : BELOW_FLOORS;
}
