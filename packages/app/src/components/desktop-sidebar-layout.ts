import {
  ARENA_TWO_PANE_MIN_CONTENT_WIDTH,
  SETTINGS_DESKTOP_SPLIT_MIN_WIDTH,
} from "@/constants/layout";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";

export const MIN_DESKTOP_CENTER_WIDTH = 400;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
}): boolean {
  return input.chromeEnabled && !input.isCompactLayout && input.isMounted && input.isOpen;
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
