import { router, usePathname } from "expo-router";
import {
  Archive,
  FolderPlus,
  GitBranch,
  Home,
  MessageSquareText,
  Search,
  Settings,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
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
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarArchivedChats } from "@/components/sidebar/archived-chats";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useFeedbackAvailable } from "@/feedback/availability";
import { FeedbackSheet } from "@/feedback/feedback-sheet";
import { resolveCurrentFeedbackChat } from "@/feedback/current-chat";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { useIsMobilePanelPresented } from "@/mobile-panels/provider";
import { buildOpenProjectRoute, buildSettingsRoute } from "@/utils/host-routes";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

// Footer icon colors come from the active theme through uniProps. Read off the JS theme object, the
// hover color could belong to the other theme and turn the icon white on white (or black on black).
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArchive = withUnistyles(Archive);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedMessageSquareText = withUnistyles(MessageSquareText);
const ThemedSearch = withUnistyles(Search);
const ThemedX = withUnistyles(X);

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

interface SidebarSharedProps {
  theme: SidebarTheme;
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
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
  labels: SidebarLabels;
}

interface SidebarLabels {
  addProject: string;
  home: string;
  settings: string;
  feedback: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const pathname = usePathname();
  const feedbackAvailable = useFeedbackAvailable();
  const currentFeedbackChat = useWorkspaceLayoutStore(
    useShallow((state) =>
      resolveCurrentFeedbackChat({ pathname, layouts: state.layoutByWorkspace }),
    ),
  );

  const {
    projects,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    statusGroups,
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

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleFeedback = useCallback(() => {
    setFeedbackChat(currentFeedbackChat);
    setFeedbackVisible(true);
  }, [currentFeedbackChat]);
  const handleFeedbackClose = useCallback(() => setFeedbackVisible(false), []);
  const handleHomeMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildOpenProjectRoute());
  }, [showMobileAgent]);

  const handleHomeDesktop = useCallback(() => {
    router.push(buildOpenProjectRoute());
  }, []);

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      home: t("sidebar.actions.home"),
      settings: t("sidebar.actions.settings"),
      feedback: t("feedback.sidebarAction"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    statusGroups,
    pinnedGroups,
    projects,
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
    labels,
  };

  const sidebar = isCompactLayout ? (
    <RetainedPanelActivity active={active}>
      <MobileSidebar
        {...sharedProps}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        closeSidebar={showMobileAgent}
        handleOpenProject={handleOpenProjectMobile}
        handleHome={handleHomeMobile}
        handleSettings={handleSettingsMobile}
      />
    </RetainedPanelActivity>
  ) : (
    <RetainedPanelActivity active={active}>
      <DesktopSidebar
        {...sharedProps}
        insetsTop={insets.top}
        active={active}
        handleOpenProject={handleOpenProjectDesktop}
        handleHome={handleHomeDesktop}
        handleSettings={handleSettingsDesktop}
      />
    </RetainedPanelActivity>
  );

  return (
    <>
      {sidebar}
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
  icon: Icon,
  iconSize,
  shortcutKeys,
  theme,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: typeof FolderPlus;
  iconSize?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
  buttonRef?: RefObject<View | null>;
}) {
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
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
          {({ hovered }) => (
            <ThemedIcon
              size={iconSize ?? theme.iconSize.md}
              uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function footerAddProjectButtonStyle({
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.footerLabeledButton,
    styles.footerAddProjectButton,
    Boolean(hovered) && styles.footerLabeledButtonHovered,
  ];
}

function footerFeedbackButtonStyle({
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.footerLabeledButton,
    styles.footerFeedbackButton,
    Boolean(hovered) && styles.footerLabeledButtonHovered,
  ];
}

function FooterAddProjectButton({
  onPress,
  label,
  shortcutKeys,
  theme,
}: {
  onPress: () => void;
  label: string;
  shortcutKeys: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          style={footerAddProjectButtonStyle}
          testID="sidebar-add-project"
          nativeID="sidebar-add-project"
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered }) => {
            const isHovered = Boolean(hovered);
            return (
              <>
                <ThemedFolderPlus
                  size={theme.iconSize.sm}
                  uniProps={isHovered ? foregroundColorMapping : foregroundMutedColorMapping}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.footerLabeledButtonLabel,
                    isHovered && styles.footerLabeledButtonLabelHovered,
                  ]}
                >
                  {label}
                </Text>
              </>
            );
          }}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
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

function SidebarFooter({
  theme,
  handleOpenProject,
  handleHome,
  handleSettings,
  handleFeedback,
  labels,
}: {
  theme: SidebarTheme;
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  handleFeedback: (() => void) | null;
  labels: {
    addProject: string;
    home: string;
    settings: string;
    feedback: string;
  };
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");

  return (
    <View style={styles.sidebarFooter}>
      {handleFeedback ? (
        <Pressable
          style={footerFeedbackButtonStyle}
          onPress={handleFeedback}
          testID="sidebar-feedback"
          nativeID="sidebar-feedback"
          accessible
          accessibilityLabel={labels.feedback}
          accessibilityRole="button"
        >
          {({ hovered }) => {
            const isHovered = Boolean(hovered);
            return (
              <>
                <ThemedMessageSquareText
                  size={theme.iconSize.sm}
                  uniProps={isHovered ? foregroundColorMapping : foregroundMutedColorMapping}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.footerLabeledButtonLabel,
                    isHovered && styles.footerLabeledButtonLabelHovered,
                  ]}
                >
                  {labels.feedback}
                </Text>
              </>
            );
          }}
        </Pressable>
      ) : null}
      <View style={styles.footerMainRow}>
        <FooterAddProjectButton
          onPress={handleOpenProject}
          label={labels.addProject}
          shortcutKeys={newAgentKeys}
          theme={theme}
        />
        <View style={styles.footerIconRow}>
          <FooterIconButton
            onPress={handleHome}
            testID="sidebar-home"
            label={labels.home}
            icon={Home}
            theme={theme}
          />
          <FooterIconButton
            onPress={handleSettings}
            testID="sidebar-settings"
            label={labels.settings}
            icon={Settings}
            shortcutKeys={settingsKeys}
            theme={theme}
          />
        </View>
      </View>
    </View>
  );
}

function MobileSidebar({
  theme,
  statusGroups,
  pinnedGroups,
  projects,
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
  labels,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const listView = useSidebarViewStore((state) => state.listView);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();
  const dragGestureHostPresented = useIsMobilePanelPresented("agent-list");

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

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto" testID="left-sidebar">
        <WindowChromeSafeArea placement="below" />
        {/* Holds the overlay's close button, which sits over it. */}
        <View style={styles.sidebarHeaderGroup}>
          <View style={styles.mobileCloseButtonSlot} />
        </View>
        <WindowChromeSafeArea placement="inline" style={styles.mobileCloseButtonRow}>
          <Pressable
            style={styles.mobileCloseButton}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={labels.closeSidebar}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <ThemedX
                size={theme.iconSize.md}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </Pressable>
        </WindowChromeSafeArea>

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
            statusGroups={statusGroups}
            pinnedGroups={pinnedGroups}
            projects={projects}
            workspaceEntriesByKey={workspaceEntriesByKey}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            onWorkspacePress={handleWorkspacePress}
            onAddProject={handleOpenProject}
            parentGestureRef={closeGestureRef}
            dragGestureHostPresented={dragGestureHostPresented}
            listHeaderComponent={workspaceListActionsElement}
          />
        ) : null}

        <SidebarFooter
          theme={theme}
          handleOpenProject={handleOpenProject}
          handleHome={handleHome}
          handleSettings={handleSettings}
          handleFeedback={handleFeedback}
          labels={labels}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  statusGroups,
  pinnedGroups,
  projects,
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
  labels,
  insetsTop,
  active,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const listView = useSidebarViewStore((state) => state.listView);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const resizeSidebarWithKeyboard = useCallback(
    (width: number) => {
      setSidebarWidth(resolveDesktopSidebarWidth({ requestedWidth: width, viewportWidth }));
    },
    [setSidebarWidth, viewportWidth],
  );
  const startWidthRef = useRef(visibleSidebarWidth);
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
          startWidthRef.current = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
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
        </View>

        {listView === "archived" ? <SidebarArchivedView /> : null}
        {listView === "chats" && isInitialLoad && !hasActiveHostFilter ? (
          <SidebarAgentListSkeleton />
        ) : null}
        {listView === "chats" && !(isInitialLoad && !hasActiveHostFilter) ? (
          <SidebarWorkspaceList
            collapsedProjectKeys={collapsedProjectKeys}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
            groupMode={groupMode}
            statusGroups={statusGroups}
            pinnedGroups={pinnedGroups}
            projects={projects}
            workspaceEntriesByKey={workspaceEntriesByKey}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            onAddProject={handleOpenProject}
            listHeaderComponent={workspaceListActionsElement}
          />
        ) : null}

        <SidebarCalloutSlot />

        <SidebarFooter
          theme={theme}
          handleOpenProject={handleOpenProject}
          handleHome={handleHome}
          handleSettings={handleSettings}
          handleFeedback={handleFeedback}
          labels={labels}
        />

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
          width={visibleSidebarWidth}
          onResize={resizeSidebarWithKeyboard}
        />
      </View>
    </Animated.View>
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
    <View style={styles.workspaceListActionsHeader}>
      <Text style={styles.sidebarListTitle} numberOfLines={1}>
        {t("sidebar.sections.chats")}
      </Text>
      <View style={styles.workspacesSectionActions}>
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
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
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
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
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
      </View>
    </View>
  );
}

/**
 * The sidebar's list swapped for the archived chats. The title says which list this is,
 * because the rows alone look like the active ones.
 */
function SidebarArchivedView({ onChatPress }: { onChatPress?: () => void }) {
  const { t } = useTranslation();
  const setListView = useSidebarViewStore((state) => state.setListView);
  const handleClose = useCallback(() => setListView("chats"), [setListView]);

  return (
    <View style={styles.archivedView}>
      <View style={styles.archivedHeaderRail}>
        <View style={styles.workspaceListActionsHeader}>
          <View style={styles.archivedTitleGroup}>
            <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />
            <Text style={styles.archivedTitle} numberOfLines={1}>
              {t("sidebar.archived.title")}
            </Text>
          </View>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("sidebar.archived.close")}
                testID="sidebar-archived-close"
                style={sidebarHeaderIconButtonStyle}
                onPress={handleClose}
              >
                {({ hovered, pressed }) => (
                  <ThemedX
                    size={14}
                    uniProps={
                      hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                    }
                  />
                )}
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <IconTooltipContent label={t("sidebar.archived.close")} />
            </TooltipContent>
          </Tooltip>
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
  },
  desktopSidebarHidden: {
    display: "none",
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
  mobileCloseButtonSlot: {
    height: 36,
  },
  sidebarTopInset: {
    paddingTop: theme.spacing[2],
  },
  workspaceListActionsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // Lines the title up with the rows' text, which sits inside their own padding.
    paddingLeft: theme.spacing[2],
    // Rendered inside the scroll's listContent (paddingHorizontal spacing[2]). Settings2's
    // painted path stops inside its 14px SVG, so 4px aligns the ink to the row rail.
    paddingRight: 4,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  workspacesSectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  sidebarListTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  archivedView: {
    flex: 1,
    minHeight: 0,
  },
  archivedHeaderRail: {
    paddingHorizontal: theme.spacing[2],
  },
  archivedTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  archivedTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
  mobileCloseButton: {
    // The 16px X paints farther inside its 32px hit target than the 14px Settings2 glyph.
    // This optical inset puts their painted right edges on the same sidebar rail.
    marginRight: theme.spacing[2] + 1.5,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
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
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  sidebarFooter: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerFeedbackButton: {
    width: "100%",
  },
  footerMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerLabeledButton: {
    minWidth: 0,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  footerAddProjectButton: {
    flex: 1,
  },
  footerLabeledButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  footerLabeledButtonLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  footerLabeledButtonLabelHovered: {
    color: theme.colors.foreground,
  },
  footerIconButton: {
    width: 28,
    height: 28,
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
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
