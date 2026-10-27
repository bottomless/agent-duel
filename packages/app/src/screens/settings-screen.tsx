import { matchesSettingsSearch } from "@/screens/settings/settings-search";
import { useCallback, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowLeft,
  Settings,
  Palette,
  Keyboard,
  Bell,
  FolderGit2,
  SquareTerminal,
  Files,
  Blocks,
  Globe,
  HardDrive,
  MessageSquare,
} from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import {
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  type HostProfile,
} from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { BackHeader } from "@/components/headers/back-header";
import { PageLayout } from "@/components/page-layout";
import { EditingTextInput } from "@/components/ui/text-input";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { FilesSection } from "@/screens/settings/files-section";
import { StorageSection } from "@/screens/settings/storage-section";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { isElectronRuntime } from "@/desktop/host";
import { AccountSection } from "@/accounts/account-section";
import { ArenaByokKeySection } from "@/byok/key-section";
import { settingsStyles } from "@/styles/settings";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { densityIconSize } from "@/styles/density";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface SidebarSectionItem {
  id: SettingsSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  desktopOnly?: boolean;
  /** The page body, for pages that need nothing from the settings screen. */
  Content?: ComponentType;
}

const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Settings },
  { id: "appearance", labelKey: "settings.sections.appearance", icon: Palette },
  { id: "chat", labelKey: "settings.sections.chat", icon: MessageSquare, Content: ChatSection },
  {
    id: "terminal",
    labelKey: "settings.sections.terminal",
    icon: SquareTerminal,
    Content: TerminalSection,
  },
  {
    id: "browser",
    labelKey: "settings.sections.browser",
    icon: Globe,
    desktopOnly: true,
    Content: BrowserDataSection,
  },
  { id: "files", labelKey: "settings.sections.files", icon: Files, Content: FilesSection },
  {
    id: "shortcuts",
    labelKey: "settings.sections.shortcuts",
    icon: Keyboard,
    desktopOnly: true,
    Content: KeyboardShortcutsSection,
  },
  {
    id: "notifications",
    labelKey: "settings.sections.notifications",
    icon: Bell,
    desktopOnly: true,
    Content: DesktopNotificationsSection,
  },
  { id: "storage", labelKey: "settings.sections.storage", icon: HardDrive },
];

function isSectionAvailable(item: SidebarSectionItem, isDesktopApp: boolean): boolean {
  return !item.desktopOnly || isDesktopApp;
}

function matchesSectionSearch(query: string, item: SidebarSectionItem, t: TFunction): boolean {
  let keys = [`settings.${item.id}`];
  if (item.id === "appearance") keys = ["settings.appearance"];
  if (item.id === "chat")
    keys = [
      "settings.appearance.detailLevel",
      "settings.general.autoExpandReasoning",
      "settings.general.toolCallDetail",
      "settings.appearance.chatOutline",
    ];
  if (item.id === "terminal") keys = ["settings.general.terminalScrollback"];
  if (item.id === "browser") keys = ["settings.general.browserData"];
  if (item.id === "general")
    keys = [
      "settings.general.language",
      "settings.general.account",
      "settings.general.openRouterKey",
    ];
  return matchesSettingsSearch(
    query,
    t(item.labelKey),
    ...keys.map((key) => t(key, { returnObjects: true, defaultValue: "" })),
  );
}

interface HostSectionItem {
  id: HostSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
}

const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "projects", labelKey: "settings.hostSections.projects", icon: FolderGit2 },
  { id: "plugins", labelKey: "settings.hostSections.plugins", icon: Blocks },
];

function renderHostSettingsContent(view: Extract<SettingsView, { kind: "host" }>): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function sidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    pressed && sidebarStyles.itemPressed,
  ];
}

function selectedSidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
    pressed && sidebarStyles.itemPressed,
  ];
}

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface GeneralSectionProps {
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function GeneralSection({ settings, handleLanguageChange }: GeneralSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const selectedLanguageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;
  return (
    <SettingsSection title={t("settings.general.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLanguageLabel}>
              {selectedLanguageLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Local daemon first, then remaining hosts in their existing order.
 */
function useSortedHosts(hosts: HostProfile[], localServerId: string | null): HostProfile[] {
  return useMemo(() => orderHostsLocalFirst(hosts, localServerId), [hosts, localServerId]);
}

interface SidebarSectionButtonProps {
  itemId: SettingsSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  isSelected: boolean;
  onSelect: (section: SettingsSectionSlug) => void;
}

// Lighter than lucide's default 2px stroke so the nav reads quieter than the content.
const SIDEBAR_ICON_STROKE_WIDTH = 1.5;

function SidebarSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface SidebarHostSectionButtonProps {
  itemId: HostSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  isSelected: boolean;
  onSelect: (section: HostSectionSlug) => void;
}

function SidebarHostSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarHostSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={`settings-host-section-${itemId}`}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled group of sidebar rows. On compact layouts the rows sit together in one island. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={sidebarStyles.group}>
      {label ? <Text style={sidebarStyles.groupLabel}>{label}</Text> : null}
      <View style={sidebarStyles.island}>{children}</View>
    </View>
  );
}

interface SettingsSidebarProps {
  view: SettingsView;
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHostSection: (section: HostSectionSlug) => void;
  onBackToWorkspace: () => void;
  layout: "desktop" | "mobile";
  search: string;
  onSearchChange: (value: string) => void;
}

function SettingsSidebar({
  view,
  onSelectSection,
  onSelectHostSection,
  onBackToWorkspace,
  layout,
  search,
  onSearchChange,
}: SettingsSidebarProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const hasHosts = sortedHosts.length > 0;
  const isDesktopApp = isElectronRuntime();
  const query = search.trim().toLocaleLowerCase();
  const items = SIDEBAR_SECTION_ITEMS.filter(
    (item) => isSectionAvailable(item, isDesktopApp) && matchesSectionSearch(query, item, t),
  );
  const hostItems = HOST_SECTION_ITEMS.filter((item) =>
    matchesSettingsSearch(query, t(item.labelKey)),
  );
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const outerContainerStyle = useMemo(
    () => [isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer],
    [isDesktop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );
  const selectedSectionId = view.kind === "section" ? view.section : null;
  let selectedHostSection: HostSectionSlug | null = null;
  if (view.kind === "host") selectedHostSection = view.section;
  if (view.kind === "project") selectedHostSection = "projects";
  if (view.kind === "plugin") selectedHostSection = "plugins";

  const sidebarBody = (
    <>
      <EditingTextInput
        initialValue={search}
        onChangeText={onSearchChange}
        placeholder="Search settings"
        accessibilityLabel="Search settings"
        style={sidebarStyles.search}
      />
      {items.length === 0 && (!hasHosts || hostItems.length === 0) ? (
        <Text style={sidebarStyles.groupLabel}>No matching sections</Text>
      ) : null}
      <SidebarGroup label={t("settings.groups.app")}>
        {items.map((item) => (
          <SidebarSectionButton
            key={item.id}
            itemId={item.id}
            label={t(item.labelKey)}
            icon={item.icon}
            isSelected={selectedSectionId === item.id}
            onSelect={onSelectSection}
          />
        ))}
        {hasHosts
          ? hostItems.map((item) => (
              <SidebarHostSectionButton
                key={item.id}
                itemId={item.id}
                label={t(item.labelKey)}
                icon={item.icon}
                isSelected={selectedHostSection === item.id}
                onSelect={onSelectHostSection}
              />
            ))
          : null}
      </SidebarGroup>
    </>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            <SidebarHeaderRow
              icon={ArrowLeft}
              label={t("settings.backToWorkspace")}
              onPress={onBackToWorkspace}
              testID="settings-back-to-workspace"
            />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
          >
            {sidebarBody}
          </ScrollView>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
}

export default function SettingsScreen({ view }: SettingsScreenProps) {
  const [search, setSearch] = useState("");
  const router = useRouter();
  const { t } = useTranslation();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const isDesktopApp = isElectronRuntime();
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const routedSettingsHostServerId =
    view.kind === "host" || view.kind === "project" || view.kind === "plugin"
      ? view.serverId
      : null;
  const [selectedSettingsHostServerId, setSelectedSettingsHostServerId] = useState<string | null>(
    routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
  );
  useFocusEffect(
    useCallback(() => {
      setSelectedSettingsHostServerId(
        routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
      );
    }, [lastWorkspaceSelection?.serverId, routedSettingsHostServerId]),
  );

  // The host the sections scope to: the host on the active view, otherwise the
  // last workspace's host, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (view.kind === "host" || view.kind === "project" || view.kind === "plugin")
      return view.serverId;
    return resolveActiveHostServerId({
      selectedServerId: selectedSettingsHostServerId,
      localServerId,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [view, selectedSettingsHostServerId, localServerId, hosts, sortedHosts]);

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      const target = buildSettingsSectionRoute(section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        return;
      }
      const target = buildSettingsHostSectionRoute(activeHostServerId, section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [activeHostServerId, isCompactLayout, router],
  );

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const installedPlugins = useInstalledPlugins();
  const detailTitle = ((): string | undefined => {
    if (view.kind === "plugin") {
      const plugin = installedPlugins.find(
        (candidate) => candidate.serverId === view.serverId && candidate.id === view.pluginId,
      );
      const screen = plugin?.settingsScreens.find((candidate) => candidate.id === view.screenId);
      return `${view.pluginId} · ${plugin && screen ? plugin.i18n.resolve(screen.title, plugin.locale) : t("settings.title")}`;
    }
    if (view.kind === "host") {
      const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
      return item ? t(item.labelKey) : undefined;
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((s) => s.id === view.section);
      return item ? t(item.labelKey) : undefined;
    }
    if (view.kind === "project") {
      return t("settings.projects");
    }
    return undefined;
  })();

  const renderSection = (section: SettingsSectionSlug): ReactNode => {
    const item = SIDEBAR_SECTION_ITEMS.find((candidate) => candidate.id === section);
    if (!item || !isSectionAvailable(item, isDesktopApp)) return null;
    switch (section) {
      case "general":
        return (
          <>
            {matchesSettingsSearch(search, "account sign in email") ? <AccountSection /> : null}
            {matchesSettingsSearch(
              search,
              t("settings.general.openRouterKey", { returnObjects: true }),
            ) ? (
              <ArenaByokKeySection serverId={activeHostServerId} />
            ) : null}
            {matchesSettingsSearch(
              search,
              t("settings.sections.general"),
              t("settings.general.language", { returnObjects: true }),
            ) ? (
              <GeneralSection settings={settings} handleLanguageChange={handleLanguageChange} />
            ) : null}
          </>
        );
      case "appearance":
        return <AppearanceSection search={search} />;
      case "storage":
        return <StorageSection serverId={activeHostServerId} />;
      default:
        return item.Content ? <item.Content /> : null;
    }
  };
  const searchResults = SIDEBAR_SECTION_ITEMS.filter(
    (item) => isSectionAvailable(item, isDesktopApp) && matchesSectionSearch(search, item, t),
  );
  const hostSearchResults = activeHostServerId
    ? HOST_SECTION_ITEMS.filter((item) => matchesSettingsSearch(search, t(item.labelKey)))
    : [];
  const content: ReactNode = (() => {
    if (search.trim()) {
      return (
        <View testID="settings-search-results">
          {searchResults.map((item) => (
            <View key={item.id}>
              <Text style={styles.searchResultTitle}>{t(item.labelKey)}</Text>
              {renderSection(item.id)}
            </View>
          ))}
          {hostSearchResults.map((item) => (
            <View key={item.id}>
              <Text style={styles.searchResultTitle}>{t(item.labelKey)}</Text>
              {activeHostServerId
                ? renderHostSettingsContent({
                    kind: "host",
                    serverId: activeHostServerId,
                    section: item.id,
                  })
                : null}
            </View>
          ))}
          {searchResults.length === 0 && hostSearchResults.length === 0 ? (
            <Text style={styles.placeholderText}>No matching settings</Text>
          ) : null}
        </View>
      );
    }
    if (view.kind === "plugin")
      return (
        <PluginSettingsContent
          serverId={view.serverId}
          pluginId={view.pluginId}
          screenId={view.screenId}
          onBackToPlugins={handleBackFromDetail}
          showBackToPlugins={!isCompactLayout}
        />
      );
    if (view.kind === "host") return renderHostSettingsContent(view);
    if (view.kind === "project")
      return (
        <ProjectSettingsScreen
          serverId={view.serverId}
          projectId={view.projectId}
          onBackToProjects={handleBackFromDetail}
          showBackToProjects={!isCompactLayout}
        />
      );
    if (view.kind === "section") return renderSection(view.section);
    return null;
  })();

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
        <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onBackToWorkspace={handleBackToWorkspace}
            search={search}
            onSearchChange={setSearch}
            layout="mobile"
          />
        </ScrollView>
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <PageLayout title={detailTitle} onBack={handleBackFromDetail}>
          {content}
        </PageLayout>
      </View>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <WindowChromeRegion corners="top-left">
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onBackToWorkspace={handleBackToWorkspace}
            search={search}
            onSearchChange={setSearch}
            layout="desktop"
          />
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View style={desktopStyles.contentPane} testID="settings-detail-pane">
            <PageLayout title={detailTitle} titleTestID="settings-detail-header-title">
              {content}
            </PageLayout>
          </View>
        </WindowChromeRegion>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  searchResultTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[4],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const desktopStyles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
});

const sidebarStyles = StyleSheet.create((theme) => ({
  search: {
    margin: theme.spacing[3],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scrollBody: {
    flex: 1,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  // Compact values draw each group as an island of tiles; desktop keeps a plain list.
  group: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: { xs: theme.spacing[1], md: theme.spacing[0.5] },
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    paddingVertical: theme.spacing[1],
  },
  island: {
    gap: { xs: 2, md: theme.spacing[0.5] },
    borderRadius: { xs: theme.borderRadius["2xl"], md: 0 },
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 28 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The workspace rows' pressed fill.
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
}));
