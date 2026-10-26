import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  FlatList,
  Text,
  View,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentSearchMatch } from "@getpaseo/protocol/messages";
import type { MatchRange } from "@getpaseo/protocol/search/text-match";
import { Button } from "@/components/ui/button";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { useAgentHistory } from "@/hooks/use-agent-history";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { resolveSidebarServerIds } from "@/hooks/use-sidebar-workspaces-list";
import { useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import {
  type ActiveWorkspaceSelection,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { getFocusedAgentId } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatCompactTimeAgo } from "@/utils/time";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  useWorkspaceRecoveryHistory,
  WorkspaceRecoveryHistory,
} from "@/workspace-recovery/history";
import {
  buildArchivedChatListItems,
  type ArchivedChatListItem,
  type ArchivedChatSection,
} from "./archived-chats-model";
import { PressHighlight } from "@/components/ui/press-highlight";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function sectionLabel(t: TFunction, section: ArchivedChatSection): string {
  switch (section) {
    case "today":
      return t("agentList.dateSections.today");
    case "yesterday":
      return t("agentList.dateSections.yesterday");
    case "thisWeek":
      return t("agentList.dateSections.thisWeek");
    case "thisMonth":
      return t("agentList.dateSections.thisMonth");
    case "older":
      return t("agentList.dateSections.older");
  }
}

/** Changes exactly when a chat is archived or unarchived anywhere: the active set gains or loses it. */
function selectActiveAgentKeys(state: ReturnType<typeof useSessionStore.getState>): string {
  const keys: string[] = [];
  for (const [serverId, session] of Object.entries(state.sessions)) {
    for (const agent of session.agents.values()) {
      if (!agent.archivedAt) keys.push(`${serverId}:${agent.id}`);
    }
  }
  return keys.sort().join("|");
}

/**
 * Asks again when a chat is archived or unarchived while the list is open — from the
 * workspace menu, the CLI, or auto-archive after a merge. Opening the list already asks.
 */
function useRefetchOnArchiveChange(refetch: () => void) {
  const activeAgentKeys = useSessionStore(selectActiveAgentKeys);
  const previousKeys = useRef(activeAgentKeys);
  useEffect(() => {
    if (previousKeys.current === activeAgentKeys) return;
    previousKeys.current = activeAgentKeys;
    refetch();
  }, [activeAgentKeys, refetch]);
}

/**
 * When the open chat leaves this list under the same query, it was unarchived or restored
 * and its row is back in Chats, so the sidebar goes there instead of showing nothing selected.
 */
function useReturnToChatsWhenOpenChatLeaves(input: {
  items: readonly ArchivedChatListItem[];
  selectedKeys: readonly string[];
  search: string;
  /** False while a first page loads: an empty list then says nothing about the open chat. */
  settled: boolean;
}) {
  const setListView = useSidebarViewStore((state) => state.setListView);
  const previous = useRef({ search: input.search, selectedKeys: input.selectedKeys });
  useEffect(() => {
    if (!input.settled) return;
    const before = previous.current;
    previous.current = { search: input.search, selectedKeys: input.selectedKeys };
    if (before.search !== input.search || before.selectedKeys.length === 0) return;
    const listedKeys = new Set(input.items.map((item) => item.key));
    if (before.selectedKeys.some((key) => !listedKeys.has(key))) {
      setListView("chats");
    }
  }, [input.items, input.search, input.selectedKeys, input.settled, setListView]);
}

/**
 * The row for the chat on screen. A workspace can hold several archived agents, so the
 * focused tab picks one; with no agent tab focused, every row of that workspace qualifies.
 */
function isChatSelected(
  agent: AggregatedAgent,
  selection: ActiveWorkspaceSelection | null,
  focusedAgentId: string | null,
) {
  return (
    selection !== null &&
    selection.serverId === agent.serverId &&
    selection.workspaceId === agent.workspaceId &&
    (focusedAgentId === null || focusedAgentId === agent.id)
  );
}

function useFocusedAgentId(selection: ActiveWorkspaceSelection | null): string | null {
  const workspaceKey = selection ? buildWorkspaceTabPersistenceKey(selection) : null;
  return useWorkspaceLayoutStore((state) =>
    workspaceKey ? getFocusedAgentId(state.layoutByWorkspace[workspaceKey]) : null,
  );
}

/** The hosts the sidebar lists, so Archived follows the same host filter as Chats. */
function useSidebarServerIds(): string[] {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  return useMemo(
    () =>
      resolveSidebarServerIds({
        allServerIds: hosts.map((host) => host.serverId),
        hostFilters,
        hostRegistryLoaded,
      }),
    [hostFilters, hostRegistryLoaded, hosts],
  );
}

/**
 * The sidebar's Archived view: archived chats in place of the active ones. Rows
 * open the chat the way the active list does; unarchiving happens there.
 */
export function SidebarArchivedChats({
  onChatPress,
}: {
  /** The compact layout closes its overlay so the opened chat is visible. */
  onChatPress?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const serverIds = useSidebarServerIds();
  const {
    agents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isSearchTruncated,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({ serverIds, search, archivedOnly: true });
  const isSearching = isSearchSupported && search.length > 0;
  const recoveries = useWorkspaceRecoveryHistory(serverIds, search);
  const refreshRecoveries = recoveries.refresh;
  const selection = useActiveWorkspaceSelection();
  const focusedAgentId = useFocusedAgentId(selection);
  const showHost = serverIds.length > 1;

  const items = useMemo(
    () => buildArchivedChatListItems({ agents, grouped: !isSearching }),
    [agents, isSearching],
  );
  const selectedKeys = useMemo(
    () =>
      items.flatMap((item) =>
        item.kind === "chat" && isChatSelected(item.agent, selection, focusedAgentId)
          ? [item.key]
          : [],
      ),
    [focusedAgentId, items, selection],
  );
  useReturnToChatsWhenOpenChatLeaves({ items, selectedKeys, search, settled: !isInitialLoad });

  const handleRefresh = useCallback(() => {
    void Promise.all([refreshAll(), refreshRecoveries()]);
  }, [refreshAll, refreshRecoveries]);
  useRefetchOnArchiveChange(handleRefresh);
  const handleClearSearch = useCallback(() => setSearchInput(""), []);
  const handleChatPress = useCallback(
    (agent: AggregatedAgent) => {
      onChatPress?.();
      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        pin: true,
      });
    },
    [onChatPress],
  );

  const renderItem: ListRenderItem<ArchivedChatListItem> = useCallback(
    ({ item }) => {
      if (item.kind === "heading") {
        return <Text style={styles.sectionHeading}>{sectionLabel(t, item.section)}</Text>;
      }
      return (
        <ArchivedChatRow
          agent={item.agent}
          selected={selectedKeys.includes(item.key)}
          showHost={showHost}
          onPress={handleChatPress}
        />
      );
    },
    [handleChatPress, selectedKeys, showHost, t],
  );

  const listHeader = useMemo(
    () => (
      <WorkspaceRecoveryHistory
        entries={recoveries.entries}
        failedHosts={recoveries.failedHosts}
        onRefresh={handleRefresh}
      />
    ),
    [handleRefresh, recoveries.entries, recoveries.failedHosts],
  );

  const listFooter = useMemo(() => {
    // A ranked result set has no next page: reaching a weaker match means
    // narrowing the query, so the footer says that instead of offering a button.
    if (isSearchTruncated) {
      return <Text style={styles.footerHint}>{t("sidebar.archived.tooManyMatches")}</Text>;
    }
    if (!hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" size="xs" onPress={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? t("common.loading") : t("sidebar.archived.loadMore")}
        </Button>
      </View>
    );
  }, [hasMore, isLoadingMore, isSearchTruncated, loadMore, t]);

  const hasRecoveryRows = recoveries.entries.length > 0 || recoveries.failedHosts.length > 0;
  const isLoading = isInitialLoad || recoveries.isLoading;
  const showLoadError = isError && agents.length === 0 && !hasRecoveryRows;

  let body: ReactElement;
  if (isLoading && items.length === 0 && !hasRecoveryRows) {
    body = (
      <View style={styles.centered}>
        <ThemedLoadingSpinner uniProps={foregroundMutedColorMapping} />
      </View>
    );
  } else if (showLoadError) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{t("sidebar.archived.loadFailed")}</Text>
        <Button variant="ghost" size="xs" onPress={handleRefresh}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else if (items.length === 0 && !hasRecoveryRows) {
    body = (
      <View style={styles.centered} testID="sidebar-archived-empty">
        <Text style={styles.emptyText}>
          {isSearching ? t("sidebar.archived.noMatches") : t("sidebar.archived.empty")}
        </Text>
        {isSearching ? (
          <Button variant="ghost" size="xs" onPress={handleClearSearch}>
            {t("sidebar.archived.clearSearch")}
          </Button>
        ) : null}
      </View>
    );
  } else {
    body = (
      <FlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={archivedChatKey}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
      />
    );
  }

  return (
    <View style={styles.container} testID="sidebar-archived">
      {isSearchSupported ? (
        <View style={styles.searchRow}>
          <SearchField
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder={t("sidebar.archived.searchPlaceholder")}
            clearAccessibilityLabel={t("sidebar.archived.clearSearch")}
            testID="sidebar-archived-search-input"
            clearTestID="sidebar-archived-search-clear"
          />
        </View>
      ) : null}
      {hostErrors.map((error) => (
        <Text key={error.serverId} style={styles.hostError}>
          {t("sidebar.archived.hostLoadFailed", { host: error.serverName })}
        </Text>
      ))}
      {body}
    </View>
  );
}

function archivedChatKey(item: ArchivedChatListItem): string {
  return item.key;
}

interface ArchivedChatDetail {
  key: string;
  text: string;
  ranges?: readonly MatchRange[];
}

/**
 * Where the chat lived, after its title: project, workspace, branch, and the host when the
 * list spans several. Search matches all four, so each one shown carries its own marks.
 */
function buildArchivedChatDetails(input: {
  agent: AggregatedAgent;
  showHost: boolean;
  rangesFor: (field: AgentSearchMatch["field"]) => readonly MatchRange[] | undefined;
}): ArchivedChatDetail[] {
  const { agent, rangesFor } = input;
  const projectName = agent.projectPlacement?.projectName ?? "";
  const workspaceName = agent.projectPlacement?.workspaceName ?? "";
  const branch = agent.projectPlacement?.checkout.currentBranch ?? "";
  const details: ArchivedChatDetail[] = [];
  if (projectName) {
    details.push({ key: "project", text: projectName, ranges: rangesFor("project") });
  }
  // Most workspaces are named after their chat or their branch, and an untitled chat
  // already shows its workspace as the title; only a name that adds something is shown.
  if (agent.title && workspaceName && workspaceName !== agent.title && workspaceName !== branch) {
    details.push({ key: "workspace", text: workspaceName, ranges: rangesFor("workspace") });
  }
  if (branch) {
    details.push({ key: "branch", text: branch, ranges: rangesFor("branch") });
  }
  if (input.showHost && agent.serverLabel) {
    details.push({ key: "host", text: agent.serverLabel });
  }
  return details;
}

function ArchivedChatRow({
  agent,
  selected,
  showHost,
  searchMatches,
  onPress,
}: {
  agent: AggregatedAgent;
  selected: boolean;
  showHost: boolean;
  searchMatches?: readonly AgentSearchMatch[];
  onPress: (agent: AggregatedAgent) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(agent), [agent, onPress]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      selected && styles.rowSelected,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [selected],
  );
  const rangesFor = (field: AgentSearchMatch["field"]) =>
    searchMatches?.find((match) => match.field === field)?.ranges;
  const workspaceName = agent.projectPlacement?.workspaceName ?? "";
  // The agent's title is what the chat was called; an untitled one falls back to its workspace.
  const title = agent.title || workspaceName || t("agentList.fallbackTitle");
  let titleRanges = undefined;
  if (agent.title) {
    titleRanges = rangesFor("title");
  } else if (workspaceName) {
    titleRanges = rangesFor("workspace");
  }
  const details = buildArchivedChatDetails({ agent, showHost, rangesFor });
  const accessibilityLabel = [title, ...details.map((detail) => detail.text)].join(", ");

  return (
    <PressHighlight
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`archived-chat-${agent.serverId}-${agent.id}`}
    >
      <View style={styles.rowText}>
        <HighlightedText
          text={title}
          ranges={titleRanges}
          numberOfLines={1}
          style={selected ? styles.titleSelected : styles.title}
        />
        {details.length > 0 ? (
          <Text numberOfLines={1} style={styles.details}>
            {details.map((detail, index) => (
              <Fragment key={detail.key}>
                {index > 0 ? " · " : null}
                <HighlightedText text={detail.text} ranges={detail.ranges} />
              </Fragment>
            ))}
          </Text>
        ) : null}
      </View>
      <Text style={styles.time}>{formatCompactTimeAgo(agent.lastActivityAt)}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  searchRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  hostError: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1],
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  sectionHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  row: {
    minHeight: 48,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    opacity: 0.76,
  },
  titleSelected: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  details: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  time: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
