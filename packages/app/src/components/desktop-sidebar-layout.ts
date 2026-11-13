import {
  ARENA_TWO_PANE_MIN_CONTENT_WIDTH,
  SETTINGS_DESKTOP_SPLIT_MIN_WIDTH,
} from "@/constants/layout";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  type LeftSidebarPresentation,
} from "@/stores/panel-store";
import type { DesktopDivisionLayout } from "@/window-layout";

const MIN_DESKTOP_CENTER_WIDTH = 400;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
  divisionLayout?: DesktopDivisionLayout | null;
}): boolean {
  // A division layout reveals navigation without changing the saved open state. Narrow windows
  // float the sidebar (resolveDesktopPanelPresentation) instead of hiding it.
  return (
    input.chromeEnabled &&
    !input.isCompactLayout &&
    input.isMounted &&
    (input.divisionLayout != null || input.isOpen)
  );
}

/**
 * Compact layouts always present navigation as a drawer overlay. Wide layouts dock it when it is
 * visible and fall back to an overlay when the dock is collapsed or yields its width.
 */
export function resolveLeftSidebarPresentation(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isFocusModeEnabled: boolean;
  desktopSidebarVisible: boolean;
}): LeftSidebarPresentation {
  if (!input.chromeEnabled) return "hidden";
  if (input.isCompactLayout) return "overlay";
  if (input.isFocusModeEnabled) return "hidden";
  return input.desktopSidebarVisible ? "dock" : "overlay";
}

/**
 * The overlay sidebar starts at the window's left edge, over the workspace's safe-area padding, so
 * its content takes the left inset itself. The dock sits inside app chrome, which already pads it.
 */
export function resolveDesktopSidebarInsetLeft(input: {
  overlay: boolean;
  safeAreaLeft: number;
}): number {
  return input.overlay ? input.safeAreaLeft : 0;
}

export function resolveDesktopAppChromeLayout(input: {
  desktopSidebarRendered: boolean;
  hasTopLeftWindowControls: boolean;
  sidebarControlsEnabled: boolean;
}) {
  const sidebarOwnsTopLeft = input.desktopSidebarRendered && input.hasTopLeftWindowControls;
  let sidebarToggleOwner: "none" | "window" | "content" = "none";
  if (input.sidebarControlsEnabled) {
    sidebarToggleOwner = input.hasTopLeftWindowControls ? "window" : "content";
  }
  return {
    sidebarCorners: sidebarOwnsTopLeft ? ("top-left" as const) : ("none" as const),
    contentCorners: sidebarOwnsTopLeft ? ("top-right" as const) : ("both" as const),
    sidebarToggleOwner,
  };
}

export function resolveDesktopSidebarWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
}): number {
  "worklet";
  const maximumVisibleWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, input.viewportWidth - MIN_DESKTOP_CENTER_WIDTH),
  );
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximumVisibleWidth, input.requestedWidth));
}

/**
 * Width the center must keep before app navigation stops taking layout width.
 * A workspace protects a battle's two side-by-side panes; settings protects its
 * own list + detail split. Everywhere else nothing outranks the panel, and it
 * stays pinned until the width resolver above runs out of room.
 */
export function resolveDesktopCenterMinimumWidth(input: {
  isSettingsRoute: boolean;
  isWorkspaceRoute: boolean;
}): number {
  return Math.max(
    input.isSettingsRoute ? SETTINGS_DESKTOP_SPLIT_MIN_WIDTH : 0,
    input.isWorkspaceRoute ? ARENA_TWO_PANE_MIN_CONTENT_WIDTH : 0,
  );
}

export type DesktopPanelPresentation = "inline" | "overlay";

export interface DesktopPanelPresentations {
  agentList: DesktopPanelPresentation;
}

/**
 * Whether app navigation is pinned beside the center or floats over it. It
 * yields as soon as keeping it pinned would drop the center below its minimum.
 * The workspace side panel is not part of this decision: it splits the center
 * itself, the way a battle's panes do.
 */
export function resolveDesktopPanelPresentation(input: {
  isSettingsRoute: boolean;
  isWorkspaceRoute: boolean;
  requestedSidebarWidth: number;
  viewportWidth: number;
}): DesktopPanelPresentations {
  const centerMinimumWidth = resolveDesktopCenterMinimumWidth(input);
  const sidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: input.requestedSidebarWidth,
    viewportWidth: input.viewportWidth,
  });
  const sidebarFits = input.viewportWidth - sidebarWidth >= centerMinimumWidth;
  return {
    agentList: sidebarFits ? "inline" : "overlay",
  };
}

export function resolveSidebarActivity(
  visible: boolean,
  compact: boolean,
  mobileActive: boolean,
): boolean {
  return visible && (!compact || mobileActive);
}
