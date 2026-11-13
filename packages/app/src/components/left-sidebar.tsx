import { SidebarViewSlot } from "@/plugins/sidebar-view";
import { router, usePathname } from "expo-router";
import {
  Archive,
  ArrowLeft,
  ChartNoAxesCombined,
  FolderPlus,
  GitBranch,
  Home,
  MessageSquareText,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import {
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";
import { useWindowLayout, resolveDesktopDivisionLayout } from "@/window-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarArchivedChats } from "@/components/sidebar/archived-chats";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density } from "@/styles/density";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useAccountGateKind } from "@/accounts/gate-context";
import { useFeedbackAvailable } from "@/feedback/availability";
import { FeedbackSheet } from "@/feedback/feedback-sheet";
import { resolveCurrentFeedbackChat } from "@/feedback/current-chat";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import type { PluginSidebarNavItem } from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  useHasOwnedWindowChromeObstruction,
  useOwnsWindowChromeCorner,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { useLeftPanelWidth } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { buildOpenProjectRoute, buildSettingsRoute } from "@/utils/host-routes";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

// Header icon colors come from the active theme through uniProps. Read off the JS theme object, the
// hover color could belong to the other theme and turn the icon white on white (or black on black).
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArchive = withUnistyles(Archive);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedSearch = withUnistyles(Search);

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  flatWorkspaces: SidebarWorkspaceEntry[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  /** Null when this daemon takes no feedback, which hides the entry. */
  handleFeedback: (() => void) | null;
  handleLeaderboard: (() => void) | null;
  labels: SidebarLabels;
}

interface SidebarLabels {
  addProject: string;
  home: string;
  settings: string;
  feedback: string;
  leaderboard: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
  overlay: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({
  active,
  desktopOverlay,
}: {
  active: boolean;
  desktopOverlay: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const pathname = usePathname();
  const feedbackAvailable = useFeedbackAvailable();
  const leaderboardAvailable = useAccountGateKind() === "signed-in";
  const currentFeedbackChat = useWorkspaceLayoutStore(
    useShallow((state) =>
      resolveCurrentFeedbackChat({ pathname, layouts: state.layoutByWorkspace }),
    ),
  );

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    flatWorkspaces,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [feedbackChat, setFeedbackChat] = useState(currentFeedbackChat);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();

  // Each destination closes the navigation overlay first. Closing is idempotent, so a docked
  // sidebar runs the same handler.
  const handleOpenProject = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettings = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleFeedback = useCallback(() => {
    setFeedbackChat(currentFeedbackChat);
    setFeedbackVisible(true);
  }, [currentFeedbackChat]);
  const handleLeaderboard = useCallback(() => {
    showMobileAgent();
    if (pathname !== "/leaderboard") router.push("/leaderboard");
  }, [pathname, showMobileAgent]);
  const handleFeedbackClose = useCallback(() => setFeedbackVisible(false), []);
  const handleHome = useCallback(() => {
    showMobileAgent();
    router.push(buildOpenProjectRoute());
  }, [showMobileAgent]);

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      home: t("sidebar.actions.home"),
      settings: t("sidebar.actions.settings"),
      feedback: t("feedback.sidebarAction"),
      leaderboard: t("leaderboard.title"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    flatWorkspaces,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    handleFeedback: feedbackAvailable ? handleFeedback : null,
    handleLeaderboard: leaderboardAvailable ? handleLeaderboard : null,
    labels,
  };

  const handlers = {
    handleOpenProject,
    handleHome,
    handleSettings,
  };

  return (
    <>
      <RetainedPanelActivity active={active}>
        {isCompactLayout ? (
          <MobileSidebar
            {...sharedProps}
            {...handlers}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
          />
        ) : (
          <DesktopSidebar
            {...sharedProps}
            {...handlers}
            insetsTop={insets.top}
            active={active}
            overlay={desktopOverlay}
          />
        )}
      </RetainedPanelActivity>
      {feedbackAvailable ? (
        <FeedbackSheet
          visible={feedbackVisible}
          onClose={handleFeedbackClose}
          contextTarget={feedbackChat}
        />
      ) : null}
    </>
  );
});

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <DensityIcon
                icon={icon}
                size="md"
                sizeAdjustment={iconSizeAdjustment}
                color={hovered ? "foreground" : "foregroundMuted"}
              />
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

export function SidebarFooter({
  handleOpenProject,
  handleHome,
  handleSettings,
  handleFeedback,
  handleLeaderboard,
  labels,
  onBeforeNavigate,
}: {
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  handleFeedback: (() => void) | null;
  handleLeaderboard: (() => void) | null;
  labels: {
    addProject: string;
    home: string;
    settings: string;
    feedback: string;
    leaderboard: string;
  };
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");

  // One line of icons: Add project, then Home and Settings at the end.
  return (
    <View style={styles.footerContainer} testID="sidebar-footer">
      <SidebarFooterRows
        onBeforeNavigate={onBeforeNavigate}
        feedbackLabel={labels.feedback}
        onFeedback={handleFeedback}
        leaderboardLabel={labels.leaderboard}
        onLeaderboard={handleLeaderboard}
      />
      <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
        <FooterIconButton
          onPress={handleOpenProject}
          testID="sidebar-add-project"
          label={labels.addProject}
          icon={FolderPlus}
          shortcutKeys={newAgentKeys}
        />
        <View style={styles.footerSpacer} />
        <FooterIconButton
          onPress={handleHome}
          testID="sidebar-home"
          label={labels.home}
          icon={Home}
        />
        <FooterIconButton
          onPress={handleSettings}
          testID="sidebar-settings"
          label={labels.settings}
          icon={Settings}
          shortcutKeys={settingsKeys}
        />
      </View>
    </View>
  );
}

/** Feedback and leaderboard precede the user's visible plugin footer rows. */
function SidebarFooterRows({
  onBeforeNavigate,
  feedbackLabel,
  onFeedback,
  leaderboardLabel,
  onLeaderboard,
}: {
  onBeforeNavigate?: () => void;
  feedbackLabel: string;
  onFeedback: (() => void) | null;
  leaderboardLabel: string;
  onLeaderboard: (() => void) | null;
}) {
  const { items } = useSidebarNavItems("footer");
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter(
    (item): item is PluginSidebarNavItem => item.kind === "plugin" && item.visible,
  );
  if (visibleItems.length === 0 && !onFeedback && !onLeaderboard) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {onFeedback ? (
          <SidebarHeaderRow
            icon={MessageSquareText}
            label={feedbackLabel}
            onPress={onFeedback}
            testID="sidebar-feedback"
            nativeID="sidebar-feedback"
            variant="inline"
          />
        ) : null}
        {onLeaderboard ? (
          <SidebarHeaderRow
            icon={ChartNoAxesCombined}
            label={leaderboardLabel}
            onPress={onLeaderboard}
            testID="sidebar-leaderboard"
            nativeID="sidebar-leaderboard"
            variant="inline"
          />
        ) : null}
        {visibleItems.map((item) => (
          <PluginSidebarItem
            key={item.key}
            group={item.group}
            section="footer"
            fallbackAnchorRef={rowsRef}
            onBeforeNavigate={onBeforeNavigate}
          />
        ))}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  active,
  theme,
  workspaceGroups,
  flatWorkspaces,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleHome,
  handleSettings,
  handleFeedback,
  handleLeaderboard,
  labels,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const insets = useSafeAreaInsets();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const listView = useSidebarViewStore((state) => state.listView);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );
  const closeButtonRowStyle = useMemo(
    () => [styles.mobileCloseButtonRow, getIsElectron() && styles.mobileCloseButtonRowElectron],
    [],
  );
  // On desktop the close button sits in the window controls' row, so the slot below that row
  // would stay empty.
  const hasTopLeftChrome = useHasOwnedWindowChromeObstruction("top-left");
  const hasTopRightChrome = useHasOwnedWindowChromeObstruction("top-right");
  const closeButtonInChromeRow = getIsElectron() && (hasTopLeftChrome || hasTopRightChrome);

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto" testID="left-sidebar">
        <WindowChromeSafeArea placement="below" />
        {closeButtonInChromeRow ? (
          <View style={styles.sidebarHeaderDivider} />
        ) : (
          // Holds the overlay's close button, which sits over it.
          <View style={styles.sidebarHeaderGroup}>
            <View style={styles.mobileCloseButtonSlot} />
          </View>
        )}
        <ScrollView
          style={styles.mobileNavScroll}
          showsVerticalScrollIndicator={false}
          alwaysBounceVertical={false}
          testID="sidebar-nav-scroll"
        >
          <SidebarNavRows onBeforeNavigate={closeSidebar} />
        </ScrollView>
        <WindowChromeSafeArea placement="inline" style={closeButtonRowStyle}>
          <SidebarCloseButton
            label={labels.closeSidebar}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            style={styles.mobileCloseButton(insets.right)}
          />
        </WindowChromeSafeArea>

        <SidebarViewSlot dismiss={handleWorkspacePress}>
          <SidebarToastRegion active={active}>
            {listView === "archived" ? <SidebarArchivedView onChatPress={closeSidebar} /> : null}
            {listView === "chats" && isInitialLoad && !hasActiveHostFilter ? (
              <SidebarAgentListSkeleton />
            ) : null}
            {listView === "chats" && !(isInitialLoad && !hasActiveHostFilter) ? (
              <SidebarWorkspaceList
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                groupMode={groupMode}
                workspaceGroups={workspaceGroups}
                flatWorkspaces={flatWorkspaces}
                projectIconTargets={projectIconTargets}
                pinnedGroups={pinnedGroups}
                projects={projects}
                hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                hasActiveProjectFilter={hasActiveProjectFilter}
                workspaceEntriesByKey={workspaceEntriesByKey}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onWorkspacePress={handleWorkspacePress}
                onAddProject={handleOpenProject}
                parentGestureRef={closeGestureRef}
                dragGestureHostActive={active}
                listHeaderComponent={workspaceListActionsElement}
              />
            ) : null}
          </SidebarToastRegion>
        </SidebarViewSlot>

        <SidebarFooter
          handleOpenProject={handleOpenProject}
          handleHome={handleHome}
          handleSettings={handleSettings}
          handleFeedback={handleFeedback}
          handleLeaderboard={handleLeaderboard}
          labels={labels}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  workspaceGroups,
  flatWorkspaces,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleHome,
  handleSettings,
  handleFeedback,
  handleLeaderboard,
  labels,
  insetsTop,
  active,
  overlay,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const listView = useSidebarViewStore((state) => state.listView);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth,
    windowHeight,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  const visibleSidebarWidth = useLeftPanelWidth();

  const closeSidebar = usePanelStore((state) => state.showMobileAgent);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture(overlay);

  const resizeSidebarWithKeyboard = useCallback(
    (width: number) => {
      setSidebarWidth(resolveDesktopSidebarWidth({ requestedWidth: width, viewportWidth }));
    },
    [setSidebarWidth, viewportWidth],
  );
  const startWidth = useSharedValue(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(divisionLayout === null)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidth.value = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidth.value + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd((_event, success) => {
          if (success) runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      divisionLayout,
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      startWidth,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: divisionLayout?.sidebarWidth ?? resizeWidth.value,
  }));
  // The panel host gets no width of its own: the dock sizes to this view and the overlay fills the
  // window. A Reanimated width on the host reached Android after React had switched presentation,
  // and a lost update left the workspace at the dock width after the dock collapsed.
  const desktopSidebarStyle = useMemo(
    () => [staticStyles.desktopSidebar, resizeAnimatedStyle],
    [resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [
      styles.desktopSidebarBorder(divisionLayout !== null),
      {
        flex: 1,
        paddingTop: insetsTop,
        paddingBottom: insets.bottom,
        paddingLeft: resolveDesktopSidebarInsetLeft({ overlay, safeAreaLeft: insets.left }),
      },
    ],
    [insetsTop, insets.bottom, insets.left, overlay, divisionLayout],
  );
  return (
    <MobilePanelOverlay
      panel="agent-list"
      presentation={overlay ? "overlay" : "dock"}
      dockVisible={active}
      closeGesture={closeGesture}
    >
      <Animated.View style={desktopSidebarStyle}>
        <View style={desktopSidebarBorderStyle} testID="left-sidebar">
          <View style={styles.sidebarDragArea}>
            {ownsTopLeft || DEV_BUILD_LABEL ? (
              <View style={styles.desktopChromeRow}>
                <TitlebarDragRegion />
                {DEV_BUILD_LABEL ? (
                  <View
                    pointerEvents="none"
                    style={styles.devBuildBadge}
                    testID="dev-build-label"
                    accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                  >
                    <GitBranch size={12} color={theme.colors.accentForeground} />
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                      {DEV_BUILD_LABEL}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.sidebarTopInset}>
                <TitlebarDragRegion />
              </View>
            )}
            <SidebarNavRows style={styles.desktopNavRows} onBeforeNavigate={closeSidebar} />
          </View>

          <SidebarViewSlot dismiss={closeSidebar}>
            <SidebarToastRegion active={active}>
              {listView === "archived" ? <SidebarArchivedView onChatPress={closeSidebar} /> : null}
              {listView === "chats" && isInitialLoad && !hasActiveHostFilter ? (
                <SidebarAgentListSkeleton />
              ) : null}
              {listView === "chats" && !(isInitialLoad && !hasActiveHostFilter) ? (
                <SidebarWorkspaceList
                  collapsedProjectKeys={collapsedProjectKeys}
                  onToggleProjectCollapsed={toggleProjectCollapsed}
                  shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                  groupMode={groupMode}
                  workspaceGroups={workspaceGroups}
                  flatWorkspaces={flatWorkspaces}
                  projectIconTargets={projectIconTargets}
                  pinnedGroups={pinnedGroups}
                  projects={projects}
                  hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                  hasActiveProjectFilter={hasActiveProjectFilter}
                  workspaceEntriesByKey={workspaceEntriesByKey}
                  isRefreshing={isManualRefresh && isRevalidating}
                  onRefresh={handleRefresh}
                  onAddProject={handleOpenProject}
                  onWorkspacePress={closeSidebar}
                  parentGestureRef={closeGestureRef}
                  dragGestureHostActive={active}
                  listHeaderComponent={workspaceListActionsElement}
                />
              ) : null}
            </SidebarToastRegion>
          </SidebarViewSlot>

          <SidebarCalloutSlot />

          <SidebarFooter
            handleOpenProject={handleOpenProject}
            handleHome={handleHome}
            handleSettings={handleSettings}
            handleFeedback={handleFeedback}
            handleLeaderboard={handleLeaderboard}
            labels={labels}
            onBeforeNavigate={closeSidebar}
          />

          {!overlay && divisionLayout === null ? (
            <SidebarResizeHandle
              edge="right"
              gesture={resizeGesture}
              pressed={resizePressed}
              testID="left-sidebar-resize-handle"
              width={visibleSidebarWidth}
              onResize={resizeSidebarWithKeyboard}
            />
          ) : null}
        </View>
      </Animated.View>
    </MobilePanelOverlay>
  );
}

function sidebarHeaderIconButtonStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.workspacesHeaderIconButton,
    (hovered || pressed) && styles.workspacesHeaderIconButtonHovered,
  ];
}

/** Names the list and holds its tools; the Archived view swaps it for its own header. */
function WorkspaceListActions() {
  const { t } = useTranslation();
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const setListView = useSidebarViewStore((state) => state.setListView);
  const commandCenterKeys = useShortcutKeys("toggle-command-center");
  const handleSearchPress = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const handleArchivedPress = useCallback(() => setListView("archived"), [setListView]);

  return (
    <SidebarSectionHeader title={t("sidebar.sections.chats")}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open command center"
            testID="sidebar-command-center-search"
            style={sidebarHeaderIconButtonStyle}
            onPress={handleSearchPress}
          >
            {({ hovered, pressed }) => (
              <ThemedSearch
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label="Search" shortcutKeys={commandCenterKeys} />
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("sidebar.archived.open")}
            testID="sidebar-archived-open"
            style={sidebarHeaderIconButtonStyle}
            onPress={handleArchivedPress}
          >
            {({ hovered, pressed }) => (
              <ThemedArchive
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label={t("sidebar.archived.open")} />
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View>
            <SidebarDisplayPreferencesMenu />
          </View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label="Display preferences" />
        </TooltipContent>
      </Tooltip>
    </SidebarSectionHeader>
  );
}

/**
 * The sidebar's list swapped for the archived chats. The title says which list this is,
 * because the rows alone look like the active ones. Back sits before the title, the way
 * settings leads with "Back to workspace": an X here would sit under the compact overlay's
 * own close button and mean something else.
 */
function SidebarArchivedView({ onChatPress }: { onChatPress?: () => void }) {
  const { t } = useTranslation();
  const setListView = useSidebarViewStore((state) => state.setListView);
  const handleBack = useCallback(() => setListView("chats"), [setListView]);

  return (
    <View style={styles.archivedView}>
      <View style={styles.archivedHeaderRail}>
        <View style={styles.archivedHeader}>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("sidebar.archived.close")}
                testID="sidebar-archived-close"
                style={sidebarHeaderIconButtonStyle}
                onPress={handleBack}
              >
                {({ hovered, pressed }) => (
                  <ThemedArrowLeft
                    size={14}
                    uniProps={
                      hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                    }
                  />
                )}
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" offset={8}>
              <IconTooltipContent label={t("sidebar.archived.close")} />
            </TooltipContent>
          </Tooltip>
          <Text style={styles.archivedTitle} numberOfLines={1}>
            {t("sidebar.archived.title")}
          </Text>
        </View>
      </View>
      <SidebarArchivedChats onChatPress={onChatPress} />
    </View>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspaceListActions takes no props).
const workspaceListActionsElement = <WorkspaceListActions />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
    flex: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  // The drag area above it already spaces the rows from the window's top edge.
  desktopNavRows: {
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  mobileCloseButtonSlot: {
    height: 36,
  },
  sidebarHeaderDivider: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarTopInset: {
    paddingTop: theme.spacing[2],
  },
  archivedView: {
    flex: 1,
    minHeight: 0,
  },
  archivedHeaderRail: {
    paddingHorizontal: theme.spacing[2],
  },
  archivedHeader: {
    // Same height as the Chats header, so swapping lists leaves the search field and rows
    // where the eye expects them. The arrow's ink sits 7px inside its 28px button; 1px more
    // puts it on the rows' text rail.
    minHeight: density.rowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: 1,
  },
  archivedTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  workspacesHeaderIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  workspacesHeaderIconButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The nav block caps at half the sidebar; a long item list scrolls inside the
  // cap instead of crowding the workspace list off a short screen.
  mobileNavScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "50%",
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButtonRow: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: 2,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  // In Electron the X shares the title bar line with the window controls: its 32px target centred
  // 23.5px down, like the header's buttons and the macOS traffic lights.
  mobileCloseButtonRowElectron: {
    top: 7.5,
  },
  mobileCloseButton: (rightInset: number) => ({
    marginRight: theme.spacing[2] + rightInset,
  }),
  desktopSidebarBorder: (hasDivision: boolean) => ({
    borderRightWidth: hasDivision ? 0 : 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  }),
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  // Pushes Home and Settings to the end of the icon line.
  footerSpacer: {
    flex: 1,
  },
  // Feedback, leaderboard and plugin rows sit above the footer's icon line, spaced like the header nav
  // rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
