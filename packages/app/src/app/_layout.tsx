import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComposerEditingSessionsProvider } from "@/composer/editing-session";
import { SheetHostScope } from "@/components/ui/isolated-bottom-sheet-modal";
import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { LucideProvider } from "lucide-react-native";
import { Stack, useNavigationContainerRef, usePathname } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AppearanceProvider } from "@/appearance/provider";
import { CommandCenter } from "@/command-center/command-center";
import { CommandCenterRootActions } from "@/command-center/root-registration";
import { CommandCenterProvider } from "@/command-center/provider";
import { CommandCenterWorkspaceActions } from "@/command-center/workspace-registration";
import { GitCreateBranchDialogHost } from "@/git/create-branch-dialog";
import { AccountGate } from "@/accounts/account-gate";
import { PluginCommandCenterActions } from "@/plugins/command-center/registration";
import { AddProjectFlowHost } from "@/components/add-project-flow-host";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { DownloadToast } from "@/components/download-toast";
import { QuittingOverlay } from "@/components/quitting-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { LeftSidebar } from "@/components/left-sidebar";
import { WindowSidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { DesktopWindowControls } from "@/components/desktop/window-controls";
import { SidebarModelProvider } from "@/components/sidebar/sidebar-model";
import { WorkspacePinShortcutHandler } from "@/components/workspace-pin-shortcut-handler";
import { WorkspaceRenameHost } from "@/components/workspace-rename-host";
import { ProviderSettingsHost } from "@/components/provider-settings-host";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { WorkspaceShortcutTargetsSubscriber } from "@/components/workspace-shortcut-targets-subscriber";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { DesktopPanelOverlay } from "@/components/desktop-panel-overlay";
import {
  resolveDesktopAppChromeLayout,
  resolveDesktopSidebarVisibility,
} from "@/components/desktop-sidebar-layout";
import { useDesktopPanelPresentation } from "@/components/use-desktop-panel-presentation";
import { isNative, isWeb } from "@/constants/platform";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SessionProvider } from "@/contexts/session-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { VoiceProvider } from "@/contexts/voice-context";
import {
  resolveStartupBlocker,
  resolveStartupNavigationReady,
  shouldRunStartupGiveUpTimer,
  startHostRuntimeBootstrap,
  bindHostRuntimeAppState,
  type StartupBlocker,
} from "@/navigation/host-runtime-bootstrap";
import { registerWorkspaceRouteNavigationRef } from "@/navigation/workspace-route-navigation";
import { ThemedStack } from "@/navigation/themed-stack";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { AgentNavigationListener } from "@/desktop/agent-navigation";
import { LegacyAgentSkillsMigration } from "@/agent-skills/legacy-migration";
import { legacyFavoriteProfileMigration } from "@/agent-profiles/migration";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { updateDesktopWindowChrome } from "@/desktop/electron/window";
import { getDesktopHost } from "@/desktop/host";
import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { RosettaCalloutSource } from "@/desktop/updates/rosetta-callout-source";
import { UpdateCalloutSource } from "@/desktop/updates/update-callout-source";
import { useActiveWorktreeNewAction } from "@/hooks/use-active-worktree-new-action";
import { useGlobalNewWorkspaceAction } from "@/hooks/use-global-new-workspace-action";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { useCompactWebViewportZoomLock } from "@/hooks/use-compact-web-viewport-zoom-lock";
import { useOpenProject } from "@/hooks/use-open-project";
import { useAppSettings } from "@/hooks/use-settings";
import { useOpenAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelsProvider, useIsMobilePanelActive } from "@/mobile-panels/provider";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { polyfillCrypto } from "@/polyfills/crypto";
import {
  getHostRuntimeStore,
  useHostRegistryLoaded,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import { getNextThemePreference, ICON_STROKE_WIDTH } from "@/styles/theme";
import { useSessionStore } from "@/stores/session-store";
import { WorkspaceLayoutModePublisher } from "@/workspace-tabs/layout-mode-publisher";
import { installWebScrollbarStyles } from "@/styles/install-web-scrollbar-styles";
import type { HostProfile } from "@/types/host-connection";
import {
  useHasWindowChromeObstruction,
  WindowChromeProvider,
  WindowChromeRegion,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import { parseHostWorkspaceRouteFromPathname, routeShowsAppChrome } from "@/utils/host-routes";
import { PluginCatalogSync } from "@/plugins";
import { NotificationOpenRouter } from "@/notification-open/react";
import { ensureOsNotificationPermission } from "@/utils/os-notifications";

polyfillCrypto();

export interface HostRuntimeBootstrapState {
  splashError: string | null;
  retry: () => void;
  hasGivenUpWaitingForHost: boolean;
  storeReady: boolean;
  startupBlocker: StartupBlocker;
}

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  splashError: null,
  retry: () => {},
  hasGivenUpWaitingForHost: false,
  storeReady: false,
  startupBlocker: { kind: "none" },
});

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const client = useHostRuntimeClient(daemon.serverId);

  if (!client) {
    return null;
  }

  return (
    <SessionProvider key={daemon.serverId} serverId={daemon.serverId} client={client}>
      <LegacyFavoriteProfileMigrationBootstrap serverId={daemon.serverId} client={client} />
      <PluginCatalogSync serverId={daemon.serverId} client={client} />
    </SessionProvider>
  );
}

function LegacyFavoriteProfileMigrationBootstrap({
  serverId,
  client,
}: {
  serverId: string;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
}) {
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const isConnected = useHostRuntimeIsConnected(serverId);

  useEffect(() => {
    if (!serverInfo || !isConnected) {
      return;
    }
    void legacyFavoriteProfileMigration.migrateHost(serverId, client).catch((error) => {
      console.warn("[AgentProfiles] Failed to migrate legacy favourites", error);
    });
  }, [client, isConnected, serverId, serverInfo]);

  return null;
}

function HostSessionManager() {
  const hosts = useHosts();

  if (hosts.length === 0) {
    return null;
  }

  return (
    <>
      {hosts.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}

export function useEarliestOnlineHostServerId(): string | null {
  const store = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeAll = store.subscribeAll(listener);
      const unsubscribeHostList = store.subscribeHostList(listener);
      return () => {
        unsubscribeAll();
        unsubscribeHostList();
      };
    },
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getEarliestOnlineHostServerId(),
    () => store.getEarliestOnlineHostServerId(),
  );
}

function useDaemonStartLastError(): string | null {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getLastError(),
    () => service.getLastError(),
  );
}

function useDaemonStartIsRunning(): boolean {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.isRunning(),
    () => service.isRunning(),
  );
}

const STARTUP_GIVE_UP_TIMEOUT_MS = 5_000;

async function shouldStartBuiltInDaemon(): Promise<boolean> {
  if (!shouldUseDesktopDaemon()) {
    return false;
  }
  const settings = await loadDesktopSettings();
  return settings.daemon.manageBuiltInDaemon;
}

function HostRuntimeBootstrapProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = getHostRuntimeStore();
    return bindHostRuntimeAppState(store, AppState);
  }, []);

  useEffect(() => {
    const store = getHostRuntimeStore();
    const daemonStartService = getDaemonStartService({ store });
    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
    });
  }, []);

  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const daemonStartError = useDaemonStartLastError();
  const daemonStartIsRunning = useDaemonStartIsRunning();
  const [hasGivenUpWaitingForHost, setHasGivenUpWaitingForHost] = useState(false);
  const isDesktopRuntime = shouldUseDesktopDaemon();
  const startupBlocker = useMemo(
    () =>
      resolveStartupBlocker({
        isDesktopRuntime,
        anyOnlineHostServerId,
        daemonStartIsRunning,
        daemonStartError,
      }),
    [anyOnlineHostServerId, daemonStartError, daemonStartIsRunning, isDesktopRuntime],
  );
  const shouldRunGiveUpTimer = shouldRunStartupGiveUpTimer({
    startupBlocker,
    anyOnlineHostServerId,
    hasGivenUpWaitingForHost,
  });

  useEffect(() => {
    if (!shouldRunGiveUpTimer) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForHost(true);
    }, STARTUP_GIVE_UP_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [shouldRunGiveUpTimer]);

  const retry = useCallback(() => {
    const daemonStartService = getDaemonStartService({ store: getHostRuntimeStore() });
    void daemonStartService.startIfEnabled({ shouldStart: shouldStartBuiltInDaemon });
  }, []);

  const splashError =
    startupBlocker.kind === "managed-daemon-error" ? startupBlocker.message : null;
  const storeReady = resolveStartupNavigationReady({ startupBlocker });

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({ splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker }),
    [splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker],
  );

  return (
    <HostRuntimeBootstrapContext.Provider value={state}>
      {children}
    </HostRuntimeBootstrapContext.Provider>
  );
}

export function useStoreReady(): boolean {
  return useContext(HostRuntimeBootstrapContext).storeReady;
}

export function useHostRuntimeBootstrapState(): HostRuntimeBootstrapState {
  return useContext(HostRuntimeBootstrapContext);
}

const rowStyle = { flex: 1, flexDirection: "row" } as const;
const flexStyle = { flex: 1 } as const;
const MOBILE_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

interface AppContainerProps {
  children: ReactNode;
  chromeEnabled?: boolean;
}

const WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING = 12;

function AppContainer({ children, chromeEnabled: chromeEnabledOverride }: AppContainerProps) {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const daemons = useHosts();
  const { settings, updateSettings } = useAppSettings();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const openDesktopAgentList = usePanelStore((state) => state.openDesktopAgentList);
  const closeDesktopAgentList = usePanelStore((state) => state.closeDesktopAgentList);
  const exitFocusMode = usePanelStore((state) => state.exitFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const insets = useSafeAreaInsets();

  const cycleTheme = useCallback(() => {
    void updateSettings({ theme: getNextThemePreference(settings.theme) });
  }, [settings.theme, updateSettings]);

  const isCompactLayout = useIsCompactFormFactor();
  useCompactWebViewportZoomLock(isCompactLayout);
  const pathname = usePathname();
  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(pathname) !== null;
  const isWorkspaceFocusModeEnabled = isWorkspaceRoute && isFocusModeEnabled;
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;
  const hasMountedDesktopSidebar = useLatchedBoolean(chromeEnabled);
  const panelPresentation = useDesktopPanelPresentation();
  const agentListFloats = panelPresentation.agentList === "overlay";
  const isAgentListOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: agentListFloats }),
  );
  const toggleAgentList = agentListFloats ? toggleMobileAgentList : toggleDesktopAgentList;
  const toggleDesktopSidebars = useCallback(() => {
    // A floating app navigation panel has no side panel to pair with, so the
    // shortcut falls back to the one panel it can show.
    if (agentListFloats) {
      toggleMobileAgentList();
      return;
    }
    // App navigation and the focused workspace's side panel move together:
    // hide both while either shows, otherwise show both.
    const { desktop } = usePanelStore.getState();
    if (desktop.agentListOpen) {
      closeDesktopAgentList();
    } else {
      openDesktopAgentList();
    }
    keyboardActionDispatcher.dispatch({
      id: "sidebar.toggle.right",
      scope: "sidebar",
    });
  }, [
    agentListFloats,
    closeDesktopAgentList,
    keyboardActionDispatcher,
    openDesktopAgentList,
    toggleMobileAgentList,
  ]);
  // TODO: stop matching pathname here as a branch. `chromeEnabled` should not
  // conflate workspace/project-specific chrome (sidebar, mobile gesture) with
  // global concerns like keyboard shortcuts. Split those out so settings (and
  // other non-workspace routes) don't need a special-case to keep shortcuts alive.
  const keyboardShortcutsEnabled = chromeEnabled || pathname.startsWith("/settings");

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    isMobile: isCompactLayout,
    isWorkspaceFocusModeEnabled,
    toggleAgentList,
    toggleBothSidebars: toggleDesktopSidebars,
    exitFocusMode,
    cycleTheme,
  });

  useActiveWorktreeNewAction();
  useGlobalNewWorkspaceAction();

  const desktopSidebarMounted = hasMountedDesktopSidebar && !isWorkspaceFocusModeEnabled;
  const desktopSidebarVisible = resolveDesktopSidebarVisibility({
    chromeEnabled,
    isCompactLayout,
    isMounted: desktopSidebarMounted,
    isOpen: isAgentListOpen,
  });
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const appChromeLayout = resolveDesktopAppChromeLayout({
    desktopSidebarRendered: desktopSidebarVisible && !agentListFloats,
    hasTopLeftWindowControls,
    sidebarControlsEnabled: chromeEnabled && !isWorkspaceFocusModeEnabled,
  });
  const sidebarChrome = (
    <SidebarChrome
      floats={agentListFloats}
      mounted={isCompactLayout ? chromeEnabled : desktopSidebarMounted}
      visible={isCompactLayout ? chromeEnabled : desktopSidebarVisible}
      keyboardShortcutsEnabled={keyboardShortcutsEnabled}
    />
  );
  let themedSidebarChrome = sidebarChrome;
  if (isWeb) {
    themedSidebarChrome = <AppearanceStyleBoundary>{sidebarChrome}</AppearanceStyleBoundary>;
  }
  const workspaceChromeStyle = useMemo(
    () => [rowStyle, !isCompactLayout && { paddingLeft: insets.left, paddingRight: insets.right }],
    [insets.left, insets.right, isCompactLayout],
  );
  const workspaceChrome = (
    <View style={workspaceChromeStyle}>
      <WorkspaceLayoutModePublisher />
      {!isCompactLayout && !agentListFloats ? (
        <WindowChromeRegion corners={appChromeLayout.sidebarCorners}>
          {themedSidebarChrome}
        </WindowChromeRegion>
      ) : null}
      <WindowChromeRegion
        corners={isCompactLayout && chromeEnabled ? "both" : appChromeLayout.contentCorners}
      >
        <View style={flexStyle}>{children}</View>
      </WindowChromeRegion>
    </View>
  );

  // Native panel gesture hosts outlive appearance keys, like native navigators.
  // Their tracked styles update in place; web numeric styles still need remounting.
  const surface = (
    <View style={layoutStyles.surfaceFill}>
      {workspaceChrome}
      <AppearanceStyleBoundary>
        {!isCompactLayout && appChromeLayout.sidebarToggleOwner === "window" ? (
          <WindowChromeRegion corners="top-left">
            <WindowChromeSafeArea
              placement="inline"
              horizontalPadding={WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING}
              pointerEvents="box-none"
              style={layoutStyles.windowSidebarToggle}
            >
              <WindowSidebarMenuToggle />
            </WindowChromeSafeArea>
          </WindowChromeRegion>
        ) : null}
        <DesktopWindowControls />
      </AppearanceStyleBoundary>
      {/* Above the content, below the portal host: a menu opened inside the
          floating panel portals to that host and has to paint over the panel. */}
      <FloatingAgentListChrome enabled={!isCompactLayout && agentListFloats}>
        {themedSidebarChrome}
      </FloatingAgentListChrome>
      <AppearanceStyleBoundary>
        <FloatingPanelPortalHost />
      </AppearanceStyleBoundary>
      {isCompactLayout ? themedSidebarChrome : null}
      <AppearanceStyleBoundary>
        <DownloadToast />
        <RosettaCalloutSource />
        <UpdateCalloutSource />
        <LegacyAgentSkillsMigration />
        <CommandCenterRootActions />
        <CommandCenterWorkspaceActions />
        <PluginCommandCenterActions />
        <WorkspacePinShortcutHandler />
        <WorkspaceRenameHost />
        <CommandCenter />
        <AddProjectFlowHost />
        <ProviderSettingsHost />
        <WorkspaceSetupDialog />
        <GitCreateBranchDialogHost />
        <KeyboardShortcutsDialog />
        <ConfirmDialogHost />
        <QuittingOverlay />
      </AppearanceStyleBoundary>
    </View>
  );

  return (
    <AppContainerLifetime compactGesturesEnabled={chromeEnabled && isCompactLayout}>
      <SheetHostScope enabled={isCompactLayout}>{surface}</SheetHostScope>
    </AppContainerLifetime>
  );
}

function AppContainerLifetime({
  children,
  compactGesturesEnabled,
}: {
  children: ReactNode;
  compactGesturesEnabled: boolean;
}) {
  return (
    <ComposerEditingSessionsProvider>
      <CommandCenterProvider>
        <MobileGestureWrapper chromeEnabled={compactGesturesEnabled}>
          {children}
        </MobileGestureWrapper>
      </CommandCenterProvider>
    </ComposerEditingSessionsProvider>
  );
}

/**
 * The agent list at the widths where it floats over the center instead of
 * sitting beside it. Compact keeps its own drawer; this is the desktop shell
 * running out of room, so the panel is the desktop one, just unpinned.
 */
function FloatingAgentListChrome({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  if (!enabled) {
    return null;
  }
  return (
    <DesktopPanelOverlay
      edge="left"
      onDismiss={showMobileAgent}
      open={isOpen}
      testID="floating-agent-list"
    >
      {children}
    </DesktopPanelOverlay>
  );
}

function SidebarChrome({
  floats,
  mounted,
  visible,
  keyboardShortcutsEnabled,
}: {
  floats: boolean;
  mounted: boolean;
  visible: boolean;
  keyboardShortcutsEnabled: boolean;
}) {
  const isCompactLayout = useIsCompactFormFactor();
  const isMobileActive = useIsMobilePanelActive("agent-list");
  // The floating desktop list reads the compact panel's open state directly: it
  // has no motion to settle before it counts as open.
  const isFloatingOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: true }),
  );
  const isDesktopOpen = usePanelStore((state) => state.desktop.agentListOpen);
  let isOpen = isDesktopOpen;
  if (isCompactLayout) {
    isOpen = isMobileActive;
  } else if (floats) {
    isOpen = isFloatingOpen;
  }
  const active = visible && isOpen;
  return (
    <SidebarModelProvider active={active}>
      {mounted ? <LeftSidebar active={active} /> : null}
      <WorkspaceShortcutTargetsSubscriber enabled={keyboardShortcutsEnabled} />
    </SidebarModelProvider>
  );
}

function MobileGestureWrapper({
  children,
  chromeEnabled,
}: {
  children: ReactNode;
  chromeEnabled: boolean;
}) {
  const openGesture = useOpenAgentListGesture(chromeEnabled);
  const isCompactLayout = useIsCompactFormFactor();

  return (
    <GestureDetector gesture={openGesture} touchAction={MOBILE_WEB_GESTURE_TOUCH_ACTION}>
      <View
        collapsable={false}
        style={layoutStyles.surfaceFill}
        testID={isCompactLayout ? "compact-shell" : "wide-shell"}
      >
        {children}
      </View>
    </GestureDetector>
  );
}

function ProvidersWrapper({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <VoiceProvider>
        <DesktopWindowControlsSync />
        <HostSessionManager />
        <FaviconStatusSync />
        {children}
      </VoiceProvider>
    </AppearanceProvider>
  );
}

function DesktopWindowControlsSync() {
  const { isLoading } = useAppSettings();
  const { theme } = useUnistyles();
  const surface0 = theme.colors.surface0;

  useEffect(() => {
    if (isLoading || isNative) return;
    void updateDesktopWindowChrome({
      backgroundColor: surface0,
      trafficLightOffsetY: -4,
    }).catch((error) => {
      console.warn("[DesktopWindow] Failed to update window controls overlay", error);
    });
  }, [isLoading, surface0]);

  return null;
}

interface OpenProjectEventPayload {
  path?: unknown;
}

interface PendingOpenProjectRequest {
  id: number;
  serverId: string;
  path: string;
}

let nextOpenProjectRequestId = 1;

function OpenProjectListener() {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [request, setRequest] = useState<PendingOpenProjectRequest | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const openProject = useOpenProject(request?.serverId ?? null);

  const openPathOnChosenHost = useCallback(
    (path: string) => {
      const nextPath = path.trim();
      if (!nextPath) {
        return;
      }

      if (!hostRegistryLoaded) {
        setPendingPath(nextPath);
        return;
      }

      const serverId = hosts[0]?.serverId;
      if (!serverId) {
        return;
      }
      setRequest({
        id: nextOpenProjectRequestId++,
        serverId,
        path: nextPath,
      });
    },
    [hosts, hostRegistryLoaded],
  );

  useEffect(() => {
    if (!hostRegistryLoaded || !pendingPath) {
      return;
    }
    const nextPath = pendingPath;
    setPendingPath(null);
    openPathOnChosenHost(nextPath);
  }, [hostRegistryLoaded, openPathOnChosenHost, pendingPath]);

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void openProject(request.path).then((result) => {
      if (cancelled) {
        return null;
      }

      if (!result.ok) {
        setRequest((current) => (current?.id === request.id ? null : current));
        return null;
      }

      setRequest((current) => (current?.id === request.id ? null : current));
      return null;
    });
    return () => {
      cancelled = true;
    };
  }, [openProject, request]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getDesktopHost()
      ?.getPendingOpenProject?.()
      ?.then((pending) => {
        if (!disposed && pending) {
          openPathOnChosenHost(pending);
        }
        return;
      })
      .catch(() => undefined);

    // Listen for hot-start paths relayed via the second-instance event.
    void listenToDesktopEvent<OpenProjectEventPayload>("open-project", (payload) => {
      if (disposed) {
        return;
      }
      const nextPath = typeof payload?.path === "string" ? payload.path.trim() : "";
      openPathOnChosenHost(nextPath);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        return;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathOnChosenHost]);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hosts = useHosts();
  const storeReady = useStoreReady();
  const knownServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const shouldShowAppChrome = storeReady && routeShowsAppChrome(pathname, knownServerIds);

  return <AppContainer chromeEnabled={shouldShowAppChrome}>{children}</AppContainer>;
}

function FaviconStatusSync() {
  useFaviconStatus();
  return null;
}

const ROOT_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};
const ROOT_STACK_NESTED_NAVIGATOR_SCREENS = ["h/[serverId]"] as const;

function RootStack() {
  const storeReady = useStoreReady();
  return (
    <ThemedStack
      screenOptions={ROOT_STACK_SCREEN_OPTIONS}
      nestedNavigatorScreens={ROOT_STACK_NESTED_NAVIGATOR_SCREENS}
    >
      <Stack.Screen name="index" />
      <Stack.Protected guard={storeReady}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/[section]" />
        <Stack.Screen name="new" />
        <Stack.Screen name="open-project" />
      </Stack.Protected>
      <Stack.Screen name="h/[serverId]" />
      <Stack.Screen name="settings/hosts/[serverId]/index" />
      <Stack.Screen name="settings/hosts/[serverId]/[hostSection]" />
      <Stack.Screen name="settings/hosts/[serverId]/plugins/[pluginId]/[screenId]" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/index" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/[projectId]" />
    </ThemedStack>
  );
}

function WorkspaceRouteNavigationBridge() {
  const navigationRef = useNavigationContainerRef();

  useEffect(() => {
    return registerWorkspaceRouteNavigationRef(navigationRef);
  }, [navigationRef]);

  return null;
}

function AppShell() {
  useEffect(() => {
    if (!getDesktopHost()) return;
    void ensureOsNotificationPermission().catch((error) => {
      console.warn("Failed to request desktop notification permission", error);
    });
  }, []);
  return (
    <MobilePanelsProvider>
      <HorizontalScrollProvider>
        <OpenProjectListener />
        <AgentNavigationListener />
        <AppWithSidebar>
          <WorkspaceRouteNavigationBridge />
          <RootStack />
        </AppWithSidebar>
      </HorizontalScrollProvider>
    </MobilePanelsProvider>
  );
}

function NotificationOpenBridge() {
  const { startupBlocker } = useHostRuntimeBootstrapState();
  return <NotificationOpenRouter startupBlocked={startupBlocker.kind !== "none"} />;
}

function RuntimeProviders({ children }: { children: ReactNode }) {
  return (
    <HostRuntimeBootstrapProvider>
      <NotificationOpenBridge />
      <SidebarCalloutProvider>
        <ProvidersWrapper>{children}</ProvidersWrapper>
      </SidebarCalloutProvider>
    </HostRuntimeBootstrapProvider>
  );
}

// PortalProvider must stay inside normal app-wide context providers.
// `@gorhom/portal` renders portaled children at the host's location in the
// tree, so any context a portaled sheet might consume (QueryClient, theme,
// auth, settings, ...) must wrap PortalProvider, not be wrapped by it.
// BottomSheetModalProvider is the exception: Gorhom modals consume portal
// context and need one shared provider for sibling sheets to stack.
function RootProviders({ children }: { children: ReactNode }) {
  return (
    <KeyboardActionDispatcherProvider>
      <WindowChromeProvider>
        <KeyboardProvider>
          <KeyboardShiftProvider>
            <ToastProvider>
              <PortalProvider>
                <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
              </PortalProvider>
            </ToastProvider>
          </KeyboardShiftProvider>
        </KeyboardProvider>
      </WindowChromeProvider>
    </KeyboardActionDispatcherProvider>
  );
}

function RootAppTree() {
  return (
    <GestureHandlerRootView style={flexStyle}>
      <View style={layoutStyles.surfaceFill}>
        <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>
          <RootProviders>
            <RuntimeProviders>
              <AccountGate>
                <AppShell />
              </AccountGate>
            </RuntimeProviders>
          </RootProviders>
        </LucideProvider>
      </View>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  useEffect(() => installWebScrollbarStyles(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        void flushDraftPersistStorage();
      }
    });
    return () => subscription.remove();
  }, []);

  return <RootAppTree />;
}

const layoutStyles = StyleSheet.create((theme) => ({
  surfaceFill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  windowSidebarToggle: {
    position: "absolute",
    top: 1,
    left: 0,
    zIndex: 20,
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
}));
