import { usePathname } from "expo-router";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import {
  resolveDesktopPanelPresentation,
  type DesktopPanelPresentations,
} from "@/components/desktop-sidebar-layout";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

const COMPACT_PRESENTATION: DesktopPanelPresentations = {
  agentList: "overlay",
};

/**
 * Whether app navigation is pinned beside the center or floats over it.
 *
 * Compact is the same answer by a different route: its panel is always an
 * overlay. Callers that need the compact drawer specifically still branch on
 * `useIsCompactFormFactor()` — this hook only says pinned or floating, and both
 * form factors read and write the floating panel's open state the same way.
 */
export function useDesktopPanelPresentation(): DesktopPanelPresentations {
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  const { width: viewportWidth } = useWindowDimensions();
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(pathname) !== null;
  const isSettingsRoute = pathname.includes("/settings");

  return useMemo(() => {
    if (isCompact) {
      return COMPACT_PRESENTATION;
    }
    return resolveDesktopPanelPresentation({
      isSettingsRoute,
      isWorkspaceRoute,
      requestedSidebarWidth: sidebarWidth,
      viewportWidth,
    });
  }, [isCompact, isSettingsRoute, isWorkspaceRoute, sidebarWidth, viewportWidth]);
}
