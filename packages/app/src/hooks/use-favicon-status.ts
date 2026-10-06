import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getIsElectronRuntimeMac } from "@/constants/layout";
import { useAggregatedAgents } from "./use-aggregated-agents";
import { getDesktopHost } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { useArenaActivityStore, createArenaDockBadgeSelector } from "@/arena/activity-store";
import { arenaActivityStatus } from "@getpaseo/protocol/arena/activity";
import { isNative } from "@/constants/platform";

type FaviconStatus = "none" | "running" | "attention";
type ColorScheme = "dark" | "light";

/* eslint-disable @typescript-eslint/no-require-imports */
const FAVICON_IMAGES: Record<ColorScheme, Record<FaviconStatus, { uri: string } | number>> = {
  dark: {
    none: require("../../assets/images/favicon-dark.png"),
    running: require("../../assets/images/favicon-dark-running.png"),
    attention: require("../../assets/images/favicon-dark-attention.png"),
  },
  light: {
    none: require("../../assets/images/favicon-light.png"),
    running: require("../../assets/images/favicon-light-running.png"),
    attention: require("../../assets/images/favicon-light-attention.png"),
  },
};
/* eslint-enable @typescript-eslint/no-require-imports */

function deriveFaviconStatus(
  agents: ReturnType<typeof useAggregatedAgents>["agents"],
): FaviconStatus {
  const hasRunning = agents.some((agent) => agent.status === "running");
  if (hasRunning) {
    return "running";
  }
  const hasAttention = agents.some((agent) => agent.requiresAttention);
  const hasNeedsInput = agents.some((agent) => (agent.pendingPermissionCount ?? 0) > 0);
  if (hasAttention || hasNeedsInput) {
    return "attention";
  }
  return "none";
}

function getFaviconUri(status: FaviconStatus, colorScheme: ColorScheme): string {
  const image = FAVICON_IMAGES[colorScheme][status];
  if (typeof image === "object" && "uri" in image) {
    return image.uri;
  }
  const suffix = status === "none" ? "" : `-${status}`;
  return `/assets/images/favicon-${colorScheme}${suffix}.png`;
}

function getOrCreateFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    document.head.appendChild(link);
  }
  return link;
}

function updateFavicon(status: FaviconStatus, colorScheme: ColorScheme) {
  const link = getOrCreateFaviconLink();
  if (!link) return;

  const newHref = getFaviconUri(status, colorScheme);
  if (link.href !== newHref) {
    link.href = newHref;
  }
}

function getSystemColorScheme(): ColorScheme {
  if (isNative || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function updateMacDockBadge(entries: Record<string, string>) {
  if (isNative || !getIsElectronRuntimeMac()) return;

  const desktopWindow = getDesktopHost()?.window?.getCurrentWindow?.();
  if (!desktopWindow || typeof desktopWindow.setBadgeEntries !== "function") {
    return;
  }

  try {
    await desktopWindow.setBadgeEntries(entries);
  } catch (error) {
    console.warn("[useFaviconStatus] Failed to update macOS dock badge", error);
  }
}

export function useFaviconStatus() {
  const { agents } = useAggregatedAgents();
  const arenaHosts = useArenaActivityStore((state) => state.hosts);
  const selectBadgeEntries = useMemo(() => createArenaDockBadgeSelector(arenaHosts), [arenaHosts]);
  const dockBadgeEntries = useSessionStore(
    useShallow((state) => selectBadgeEntries(state.sessions)),
  );
  const [colorScheme, setColorScheme] = useState<ColorScheme>(getSystemColorScheme);

  // Listen for system color scheme changes
  useEffect(() => {
    if (isNative || typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setColorScheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  // Update favicon when agents or color scheme changes
  useEffect(() => {
    if (isNative) return;

    let status = deriveFaviconStatus(agents);
    const activities = Object.values(arenaHosts).flatMap((host) => Array.from(host.values()));
    if (activities.some((activity) => arenaActivityStatus(activity).bucket === "running"))
      status = "running";
    else if (activities.some((activity) => activity.requiresDecision)) status = "attention";
    updateFavicon(status, colorScheme);
  }, [agents, colorScheme, arenaHosts]);

  useEffect(() => {
    void updateMacDockBadge(dockBadgeEntries);
  }, [dockBadgeEntries]);
}
