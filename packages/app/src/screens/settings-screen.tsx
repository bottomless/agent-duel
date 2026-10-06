import { matchesSettingsSearch } from "@/screens/settings/settings-search";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Settings, Palette, Keyboard, Bell, FolderGit2 } from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { SettingsSection } from "@/screens/settings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import {
  useAppSettings,
  parseTerminalScrollbackLines,
  type AppSettings,
} from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import {
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  type HostProfile,
} from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { BackHeader } from "@/components/headers/back-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
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
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  buildOpenProjectRoute,
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import {
  navigateToLastWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type SettingsView =
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string };

interface SidebarSectionItem {
  id: SettingsSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string }>;
  desktopOnly?: boolean;
}

const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Settings },
  { id: "appearance", labelKey: "settings.sections.appearance", icon: Palette },
  { id: "shortcuts", labelKey: "settings.sections.shortcuts", icon: Keyboard, desktopOnly: true },
  {
    id: "notifications",
    labelKey: "settings.sections.notifications",
    icon: Bell,
    desktopOnly: true,
  },
];

function matchesSectionSearch(query: string, item: SidebarSectionItem, t: TFunction): boolean {
  let keys = [`settings.${item.id}`];
  if (item.id === "appearance")
    keys = [
      "settings.appearance",
      "settings.general.autoExpandReasoning",
      "settings.general.toolCallDetail",
    ];
  if (item.id === "general")
    keys = [
      "settings.general.language",
      "settings.general.terminalScrollback",
      "settings.general.account",
      "settings.general.openRouterKey",
      "settings.general.browserData",
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
  icon: ComponentType<{ size: number; color: string }>;
}

const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "projects", labelKey: "settings.hostSections.projects", icon: FolderGit2 },
];

function renderHostSettingsContent(view: Extract<SettingsView, { kind: "host" }>): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
  }
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function themeTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.themeTrigger, pressed && { opacity: 0.85 }];
}

function sidebarItemStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [sidebarStyles.item, Boolean(hovered) && sidebarStyles.itemHovered];
}

function selectedSidebarItemStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
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
  search: string;
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
  handleTerminalScrollbackLinesChange: (lines: number) => void;
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

function GeneralSection({
  search,
  settings,
  handleLanguageChange,
  handleTerminalScrollbackLinesChange,
}: GeneralSectionProps) {
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
  const [terminalScrollbackValue, setTerminalScrollbackValue] = useState(
    String(settings.terminalScrollbackLines),
  );

  const handleTerminalScrollbackChangeText = useCallback((value: string) => {
    setTerminalScrollbackValue(value.replace(/[^\d]/g, ""));
  }, []);

  const commitTerminalScrollback = useCallback(() => {
    const parsed = parseTerminalScrollbackLines(terminalScrollbackValue);
    const nextValue = parsed ?? settings.terminalScrollbackLines;
    setTerminalScrollbackValue(String(nextValue));
    if (nextValue !== settings.terminalScrollbackLines) {
      handleTerminalScrollbackLinesChange(nextValue);
    }
  }, [
    handleTerminalScrollbackLinesChange,
    settings.terminalScrollbackLines,
    terminalScrollbackValue,
  ]);

  useEffect(() => {
    setTerminalScrollbackValue(String(settings.terminalScrollbackLines));
  }, [settings.terminalScrollbackLines]);

  return (
    <SettingsSection title={t("settings.general.title")}>
      <View style={settingsStyles.card}>
        {matchesSettingsSearch(
          search,
          t("settings.sections.general"),
          t("settings.general.language", { returnObjects: true }),
        ) ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.general.language.description")}
              </Text>
            </View>
            <DropdownMenu>
              <DropdownTrigger
                accessibilityRole="button"
                accessibilityLabel={selectedLanguageLabel}
                style={themeTriggerStyle}
              >
                <Text style={styles.themeTriggerText}>{selectedLanguageLabel}</Text>
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
        ) : null}

        {matchesSettingsSearch(
          search,
          t("settings.sections.general"),
          t("settings.general.terminalScrollback", { returnObjects: true }),
        ) ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.general.terminalScrollback.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.general.terminalScrollback.description")}
              </Text>
            </View>
            <TextInput
              value={terminalScrollbackValue}
              onChangeText={handleTerminalScrollbackChangeText}
              onBlur={commitTerminalScrollback}
              onSubmitEditing={commitTerminalScrollback}
              keyboardType="number-pad"
              inputMode="numeric"
              selectTextOnFocus
              style={styles.terminalScrollbackInput}
              accessibilityLabel={t("settings.general.terminalScrollback.accessibilityLabel")}
            />
          </View>
        ) : null}
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
  icon: ComponentType<{ size: number; color: string }>;
  isSelected: boolean;
  onSelect: (section: SettingsSectionSlug) => void;
}

function SidebarSectionButton({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme } = useUnistyles();
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
        size={theme.iconSize.md}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
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
  icon: ComponentType<{ size: number; color: string }>;
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
  const { theme } = useUnistyles();
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
        size={theme.iconSize.md}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
    (item) => (!item.desktopOnly || isDesktopApp) && matchesSectionSearch(query, item, t),
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

  const sidebarBody = (
    <>
      <TextInput
        value={search}
        onChangeText={onSearchChange}
        placeholder="Search settings"
        accessibilityLabel="Search settings"
        style={sidebarStyles.search}
      />
      {items.length === 0 && (!hasHosts || hostItems.length === 0) ? (
        <Text style={sidebarStyles.groupLabel}>No matching sections</Text>
      ) : null}
      <View style={sidebarStyles.list}>
        <Text style={sidebarStyles.groupLabel}>{t("settings.groups.app")}</Text>
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
      </View>
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
          <ScrollView style={sidebarStyles.scrollBody} showsVerticalScrollIndicator={false}>
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
  const { theme } = useUnistyles();
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
    view.kind === "host" || view.kind === "project" ? view.serverId : null;
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

  // The host the four sections scope to: the host on the active view, otherwise
  // the picker choice, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (view.kind === "host" || view.kind === "project") return view.serverId;
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

  const handleTerminalScrollbackLinesChange = useCallback(
    (terminalScrollbackLines: number) => {
      void updateSettings({ terminalScrollbackLines });
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

  const handleBackToRoot = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/settings");
    }
  }, [router]);

  const detailProjectServerId = view.kind === "project" ? view.serverId : null;
  const handleBackFromDetail = useCallback(() => {
    if (detailProjectServerId) {
      router.navigate(buildSettingsHostSectionRoute(detailProjectServerId, "projects"));
      return;
    }
    handleBackToRoot();
  }, [detailProjectServerId, handleBackToRoot, router]);

  const handleBackToWorkspace = useCallback(() => {
    if (navigateToLastWorkspace()) {
      return;
    }
    router.replace(buildOpenProjectRoute());
  }, [router]);

  const detailHeader = ((): {
    title: string;
    Icon: ComponentType<{ size: number; color: string }>;
    titleAccessory?: ReactNode;
  } | null => {
    if (view.kind === "host") {
      const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return { title: t(item.labelKey), Icon: item.icon };
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return { title: t(item.labelKey), Icon: item.icon };
    }
    if (view.kind === "project") {
      return { title: t("settings.projects"), Icon: FolderGit2 };
    }
    return null;
  })();

  const renderSection = (section: SettingsSectionSlug) => {
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
            <GeneralSection
              search={search}
              settings={settings}
              handleLanguageChange={handleLanguageChange}
              handleTerminalScrollbackLinesChange={handleTerminalScrollbackLinesChange}
            />
            {isDesktopApp && matchesSettingsSearch(search, "browser data clear") ? (
              <BrowserDataSection />
            ) : null}
          </>
        );
      case "appearance":
        return <AppearanceSection search={search} />;
      case "shortcuts":
        return isDesktopApp ? <KeyboardShortcutsSection /> : null;
      case "notifications":
        return isDesktopApp ? <DesktopNotificationsSection /> : null;
    }
    return null;
  };
  const searchResults = SIDEBAR_SECTION_ITEMS.filter(
    (item) => (!item.desktopOnly || isDesktopApp) && matchesSectionSearch(search, item, t),
  );
  const hostSearchResults = activeHostServerId
    ? HOST_SECTION_ITEMS.filter((item) => matchesSettingsSearch(search, t(item.labelKey)))
    : [];
  const content = (() => {
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
    if (view.kind === "host") return renderHostSettingsContent(view);
    if (view.kind === "project")
      return <ProjectSettingsScreen serverId={view.serverId} projectId={view.projectId} />;
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

  const desktopDetailHeaderLeft = detailHeader ? (
    <>
      <HeaderIconBadge>
        <detailHeader.Icon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </HeaderIconBadge>
      <ScreenTitle testID="settings-detail-header-title">{detailHeader.title}</ScreenTitle>
      {detailHeader.titleAccessory}
    </>
  ) : null;

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
        <BackHeader
          title={detailHeader?.title}
          titleAccessory={detailHeader?.titleAccessory}
          onBack={handleBackFromDetail}
        />
        <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
          <View style={styles.content}>{content}</View>
        </ScrollView>
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
            <ScreenHeader
              borderless={!detailHeader}
              left={desktopDetailHeaderLeft}
              leftStyle={desktopStyles.detailLeft}
            />
            <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
              <View style={styles.content}>{content}</View>
            </ScrollView>
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
    fontSize: theme.fontSize.lg,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  searchResultTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[4],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  themeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  themeTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  terminalScrollbackInput: {
    width: 112,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

const desktopStyles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
  detailLeft: {
    gap: theme.spacing[2],
  },
}));

const sidebarStyles = StyleSheet.create((theme) => ({
  search: {
    margin: theme.spacing[3],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
  list: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  groupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
