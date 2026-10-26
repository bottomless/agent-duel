import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { View, Text, type LayoutChangeEvent, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { ResizeHandle } from "@/components/resize-handle";
import { resolveSplitFloors } from "@/components/split-container-floors";
import { resolveSplitContainerRoot } from "@/components/split-container-focus";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import {
  WindowChromeRegion,
  WindowChromeSafeArea,
  useWindowChromeCorners,
  type WindowChromeCorners,
} from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import {
  computeTabDropPreview,
  type TabDropPreview,
} from "@/components/split-container-tab-drop-preview";
import { SplitDropZone, type SplitDropZoneHover } from "@/components/split-drop-zone";
import {
  deriveWorkspacePaneState,
  getWorkspacePaneDescriptors,
} from "@/screens/workspace/workspace-pane-state";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import {
  WorkspaceDesktopTabsRow,
  type SidePanelLaunchers,
  type WorkspaceDesktopTabRowItem,
  type WorkspacePaneRole,
  WorkspaceExitFocusModeButton,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  useWorkspaceLayoutStore,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { recordRenderProfileReasons, RenderProfile } from "@/utils/render-profiler";
import { isNative } from "@/constants/platform";

interface SplitContainerProps {
  layout: WorkspaceLayout;
  /** The side pane's id, when the layout has one; it gets the side pane chrome. */
  sidePaneId: string | null;
  /** Hidden side panels keep their pane in the layout but are not rendered. */
  sidePanelOpen: boolean;
  /** Compact widths show one pane at a time: the side pane while open, else the chat. */
  compact?: boolean;
  sidePanelLaunchers: SidePanelLaunchers;
  onOpenSidePanelTab: (target: WorkspaceTabTarget) => void;
  workspaceKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  uiTabs: WorkspaceTab[];
  hoveredCloseTabKey: string | null;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  closingTabIds: Set<string>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCreateTerminalTab: (input: { paneId?: string; profile?: TerminalProfile }) => void;
  /** The contestant seats a shell can be opened in, while a battle has live worktrees. */
  arenaSeatSides?: readonly ArenaSide[];
  onCreateArenaSeatTerminal?: (side: ArenaSide) => void;
  onCreateBrowserTab: (input: { paneId?: string }) => void;
  showCreateBrowserTab?: boolean;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  onFocusPane: (paneId: string) => void;
  onMoveTabToPane: (tabId: string, toPaneId: string) => void;
  onResizeSplit: (groupId: string, sizes: number[]) => void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  renderPaneEmptyState?: (paneRole: WorkspacePaneRole) => ReactNode;
  focusModeEnabled?: boolean;
  onExitFocusMode: () => void;
}

interface WorkspaceTabDragData {
  kind: "workspace-tab";
  paneId: string;
  tabId: string;
}

interface SplitPaneDropData {
  kind: "split-pane-drop";
  paneId: string;
}

function isWorkspaceTabDragData(data: unknown): data is WorkspaceTabDragData {
  return typeof data === "object" && data !== null && Reflect.get(data, "kind") === "workspace-tab";
}

function isSplitPaneDropData(data: unknown): data is SplitPaneDropData {
  return (
    typeof data === "object" && data !== null && Reflect.get(data, "kind") === "split-pane-drop"
  );
}

function asWorkspaceTabDragData(data: unknown): WorkspaceTabDragData | undefined {
  return isWorkspaceTabDragData(data) ? data : undefined;
}

function asDragOverData(data: unknown): WorkspaceTabDragData | SplitPaneDropData | undefined {
  if (isWorkspaceTabDragData(data)) return data;
  if (isSplitPaneDropData(data)) return data;
  return undefined;
}

interface SplitNodeViewProps extends Omit<
  SplitContainerProps,
  "layout" | "onMoveTabToPane" | "sidePanelOpen" | "compact"
> {
  node: SplitNode;
  uiTabs: WorkspaceTab[];
  focusedPaneId: string | null;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
  windowChromeCorners: WindowChromeCorners;
}

interface SplitPaneViewProps extends Omit<
  SplitNodeViewProps,
  | "node"
  | "workspaceKey"
  | "focusedPaneId"
  | "activeDragTabId"
  | "showDropZones"
  | "dropPreview"
  | "onResizeSplit"
  | "windowChromeCorners"
  | "sidePaneId"
> {
  pane: SplitPane;
  paneRole: WorkspacePaneRole;
  uiTabs: WorkspaceTab[];
  isFocused: boolean;
  activeDragTabId: string | null;
  showDropZones: boolean;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
}

/**
 * The main pane is the chat and has no tab row, so in focus mode the way out
 * sits in a strip of its own.
 */
function MainPaneFocusStrip({
  focusModeEnabled,
  onExitFocusMode,
}: {
  focusModeEnabled: boolean;
  onExitFocusMode: () => void;
}) {
  if (!focusModeEnabled) {
    return null;
  }
  return (
    <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
      <TitlebarDragRegion />
      <View style={styles.mainPaneFocusStrip}>
        <WorkspaceExitFocusModeButton onPress={onExitFocusMode} />
      </View>
    </WindowChromeSafeArea>
  );
}

interface DragMoveRects {
  translatedRect: { left: number; top: number; width: number; height: number };
  overRect: { left: number; top: number; width: number; height: number };
}

function resolveDragMoveRects(
  event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">,
): DragMoveRects | null {
  const translatedRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!translatedRect || !overRect || overRect.width <= 0 || overRect.height <= 0) {
    return null;
  }
  return { translatedRect, overRect };
}

function computeTabOverDropPreview(input: {
  activeData: WorkspaceTabDragData;
  overData: WorkspaceTabDragData;
  rects: DragMoveRects;
  panesById: Map<string, SplitPane>;
  uiTabs: WorkspaceTab[];
}): TabDropPreview | null {
  const { activeData, overData, rects, panesById, uiTabs } = input;
  const targetPane = panesById.get(overData.paneId) ?? null;
  if (!targetPane) {
    return null;
  }
  const targetTabs = getWorkspacePaneDescriptors({ pane: targetPane, tabs: uiTabs });
  return computeTabDropPreview({
    activePaneId: activeData.paneId,
    activeTabId: activeData.tabId,
    overPaneId: overData.paneId,
    overTabId: overData.tabId,
    targetTabs,
    activeRect: {
      left: rects.translatedRect.left,
      width: rects.translatedRect.width,
    },
    overRect: {
      left: rects.overRect.left,
      width: rects.overRect.width,
    },
  });
}

function computePaneOverDropPreview(input: {
  overData: SplitPaneDropData;
  rects: DragMoveRects;
}): SplitDropZoneHover | null {
  const { overData, rects } = input;
  const centerX = rects.translatedRect.left + rects.translatedRect.width / 2;
  const centerY = rects.translatedRect.top + rects.translatedRect.height / 2;
  const relativeX = centerX - rects.overRect.left;
  const relativeY = centerY - rects.overRect.top;
  if (
    Number.isNaN(relativeX) ||
    Number.isNaN(relativeY) ||
    relativeX < 0 ||
    relativeX > rects.overRect.width ||
    relativeY < 0 ||
    relativeY > rects.overRect.height
  ) {
    return null;
  }
  return { paneId: overData.paneId };
}

const EMPTY_SPLIT_NODES: SplitNode[] = [];
const EMPTY_SPLIT_SIZES: number[] = [];

const dropCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const tabHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "workspace-tab",
  );
  if (tabHits.length > 0) {
    return tabHits;
  }

  const paneHits = pointerHits.filter(
    (entry) => entry.data?.droppableContainer.data.current?.kind === "split-pane-drop",
  );
  if (paneHits.length > 0) {
    return paneHits;
  }

  return closestCenter(args);
};

export function SplitContainer({
  layout,
  sidePaneId,
  sidePanelOpen,
  compact = false,
  sidePanelLaunchers,
  onOpenSidePanelTab,
  workspaceKey,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  uiTabs,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateTerminalTab,
  arenaSeatSides,
  onCreateArenaSeatTerminal,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onMoveTabToPane,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState = () => null,
  focusModeEnabled,
  onExitFocusMode,
}: SplitContainerProps) {
  const inheritedWindowChromeCorners = useWindowChromeCorners();
  const windowChromeCorners = focusModeEnabled ? inheritedWindowChromeCorners : "none";
  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<SplitDropZoneHover | null>(null);
  const [tabDropPreview, setTabDropPreview] = useState<TabDropPreview | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const panesById = useMemo(() => collectPanesById(layout.root), [layout.root]);
  const splitRoot = useMemo(
    () =>
      resolveSplitContainerRoot({
        root: layout.root,
        focusedPaneId: layout.focusedPaneId,
        focusModeEnabled,
        sidePaneId,
        sidePanelOpen,
        compact,
      }),
    [compact, focusModeEnabled, layout.focusedPaneId, layout.root, sidePaneId, sidePanelOpen],
  );
  const renderRoot = useMemo(() => wrapRootPaneForStableMount(splitRoot.root), [splitRoot.root]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = asWorkspaceTabDragData(event.active.data.current);
    if (!data) {
      setActiveDragTabId(null);
      setDropPreview(null);
      setTabDropPreview(null);
      return;
    }
    setActiveDragTabId(data.tabId);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragTabId(null);
    setDropPreview(null);
    setTabDropPreview(null);
  }, []);

  const updateDropPreview = useCallback(
    (event: Pick<DragMoveEvent, "active" | "over"> | Pick<DragOverEvent, "active" | "over">) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      if (activeData?.kind !== "workspace-tab") {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      const rects = resolveDragMoveRects(event);
      if (!rects) {
        setDropPreview(null);
        setTabDropPreview(null);
        return;
      }

      if (overData?.kind === "workspace-tab") {
        const preview = computeTabOverDropPreview({
          activeData,
          overData,
          rects,
          panesById,
          uiTabs,
        });
        setDropPreview(null);
        setTabDropPreview(preview);
        return;
      }

      setTabDropPreview(null);
      if (overData?.kind !== "split-pane-drop") {
        setDropPreview(null);
        return;
      }

      setDropPreview(computePaneOverDropPreview({ overData, rects }));
    },
    [panesById, uiTabs],
  );

  const applyTabDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: WorkspaceTabDragData }): void => {
      const { activeData, overData } = input;
      const sourcePane = panesById.get(activeData.paneId) ?? null;
      const targetPane = panesById.get(overData.paneId) ?? null;
      if (!sourcePane || !targetPane) {
        return;
      }

      const sourceTabs = getWorkspacePaneDescriptors({ pane: sourcePane, tabs: uiTabs });
      const targetTabs = getWorkspacePaneDescriptors({ pane: targetPane, tabs: uiTabs });
      const sourceIndex = sourceTabs.findIndex((tab) => tab.tabId === activeData.tabId);
      const resolvedTabDropPreview =
        tabDropPreview?.paneId === overData.paneId ? tabDropPreview : null;
      if (sourceIndex < 0 || !resolvedTabDropPreview) {
        return;
      }

      if (activeData.paneId === overData.paneId) {
        if (sourceIndex !== resolvedTabDropPreview.insertionIndex) {
          const nextTabs = arrayMove(
            sourceTabs,
            sourceIndex,
            resolvedTabDropPreview.insertionIndex,
          );
          onReorderTabsInPane(
            activeData.paneId,
            nextTabs.map((tab) => tab.tabId),
          );
        }
        return;
      }

      const nextTargetTabIds = targetTabs.map((tab) => tab.tabId);
      nextTargetTabIds.splice(resolvedTabDropPreview.insertionIndex, 0, activeData.tabId);
      onMoveTabToPane(activeData.tabId, overData.paneId);
      onReorderTabsInPane(overData.paneId, nextTargetTabIds);
    },
    [onMoveTabToPane, onReorderTabsInPane, panesById, tabDropPreview, uiTabs],
  );

  const applyPaneDropEnd = useCallback(
    (input: { activeData: WorkspaceTabDragData; overData: SplitPaneDropData }): void => {
      const { activeData, overData } = input;
      if (dropPreview?.paneId !== overData.paneId) {
        return;
      }
      if (activeData.paneId !== overData.paneId) {
        onMoveTabToPane(activeData.tabId, overData.paneId);
      }
    },
    [dropPreview, onMoveTabToPane],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = asWorkspaceTabDragData(event.active.data.current);
      const overData = asDragOverData(event.over?.data.current);

      setActiveDragTabId(null);

      if (activeData?.kind === "workspace-tab" && event.over) {
        if (overData?.kind === "workspace-tab") {
          applyTabDropEnd({ activeData, overData });
        } else if (overData?.kind === "split-pane-drop") {
          applyPaneDropEnd({ activeData, overData });
        }
      }

      setDropPreview(null);
      setTabDropPreview(null);
    },
    [applyTabDropEnd, applyPaneDropEnd],
  );

  return (
    <RenderProfile id="SplitContainer">
      <DndContext
        sensors={sensors}
        collisionDetection={dropCollisionDetection}
        onDragStart={handleDragStart}
        onDragMove={updateDropPreview}
        onDragOver={updateDropPreview}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        {splitRoot.usesFallbackStrip && <WindowChromeSafeArea placement="below" />}
        <SplitNodeView
          node={renderRoot}
          sidePaneId={sidePaneId}
          sidePanelLaunchers={sidePanelLaunchers}
          onOpenSidePanelTab={onOpenSidePanelTab}
          workspaceKey={workspaceKey}
          uiTabs={uiTabs}
          focusedPaneId={layout.focusedPaneId}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          isWorkspaceFocused={isWorkspaceFocused}
          hoveredCloseTabKey={hoveredCloseTabKey}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          closingTabIds={closingTabIds}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          onCreateTerminalTab={onCreateTerminalTab}
          arenaSeatSides={arenaSeatSides}
          onCreateArenaSeatTerminal={onCreateArenaSeatTerminal}
          onCreateBrowserTab={onCreateBrowserTab}
          showCreateBrowserTab={showCreateBrowserTab}
          buildPaneContentModel={buildPaneContentModel}
          onFocusPane={onFocusPane}
          onResizeSplit={onResizeSplit}
          onReorderTabsInPane={onReorderTabsInPane}
          renderPaneEmptyState={renderPaneEmptyState}
          activeDragTabId={activeDragTabId}
          showDropZones={activeDragTabId !== null}
          dropPreview={dropPreview}
          tabDropPreview={tabDropPreview}
          windowChromeCorners={splitRoot.usesFallbackStrip ? "none" : windowChromeCorners}
          focusModeEnabled={focusModeEnabled}
          onExitFocusMode={onExitFocusMode}
        />
        <DragOverlay dropAnimation={null}>
          {activeDragTabId ? (
            <DragOverlayTabChip
              tabId={activeDragTabId}
              uiTabs={uiTabs}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </RenderProfile>
  );
}

function DragOverlayTabChip({
  tabId,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tabId: string;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const tab = uiTabs.find((t) => t.tabId === tabId);
  const descriptor = useMemo<WorkspaceTabDescriptor | null>(
    () =>
      tab
        ? {
            key: tab.tabId,
            tabId: tab.tabId,
            kind: tab.target.kind,
            target: tab.target,
          }
        : null,
    [tab],
  );
  if (!descriptor) {
    return null;
  }
  return (
    <DragOverlayTabChipInner
      tab={descriptor}
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
    />
  );
}

function DragOverlayTabChipInner({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const { t } = useTranslation();

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const label =
          presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;

        return (
          <View style={styles.dragOverlayChip}>
            <WorkspaceTabIcon presentation={presentation} active size={14} backdrop="surface1" />
            <Text numberOfLines={1} style={styles.dragOverlayLabel}>
              {label}
            </Text>
          </View>
        );
      }}
    </WorkspaceTabPresentationResolver>
  );
}

// Drag previews write the grow factors to a shared value, so resizing never re-renders the panes
// or adds a style rule per width.
function SplitGroupChild({
  resizeFlex,
  index,
  floorStyle,
  children,
}: {
  resizeFlex: SharedValue<number[]>;
  index: number;
  floorStyle: ViewStyle | null | undefined;
  children: ReactNode;
}) {
  const resizeStyle = useAnimatedStyle(() => ({
    flexGrow: resizeFlex.value[index] ?? 1,
  }));
  const childStyle = useMemo(() => [styles.groupChild, floorStyle], [floorStyle]);
  return <Animated.View style={[childStyle, resizeStyle]}>{children}</Animated.View>;
}

function resolveGroupFlex(children: readonly SplitNode[], sizes: readonly number[]): number[] {
  return children.map((_child, index) => sizes[index] ?? 1);
}

function SplitNodeView({
  node,
  sidePaneId,
  sidePanelLaunchers,
  onOpenSidePanelTab,
  workspaceKey,
  uiTabs,
  focusedPaneId,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateTerminalTab,
  arenaSeatSides,
  onCreateArenaSeatTerminal,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onResizeSplit,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  windowChromeCorners,
  focusModeEnabled,
  onExitFocusMode,
}: SplitNodeViewProps) {
  const [groupContainerSize, setGroupContainerSize] = useState(0);
  const groupId = node.kind === "group" ? node.group.id : null;
  const groupDirection = node.kind === "group" ? node.group.direction : null;

  const storedGroupSizes = useWorkspaceLayoutStore((state) =>
    groupId ? state.splitSizesByWorkspace[workspaceKey]?.[groupId] : undefined,
  );
  const groupChildren = node.kind === "group" ? node.group.children : EMPTY_SPLIT_NODES;
  const groupSizes =
    storedGroupSizes ?? (node.kind === "group" ? node.group.sizes : EMPTY_SPLIT_SIZES);
  const groupFlex = useMemo(
    () => resolveGroupFlex(groupChildren, groupSizes),
    [groupChildren, groupSizes],
  );
  const resizeFlex = useSharedValue(groupFlex);
  useEffect(() => {
    resizeFlex.value = groupFlex;
  }, [resizeFlex, groupFlex]);
  const previewResizeSplit = useCallback(
    (_groupId: string, sizes: number[]) => {
      resizeFlex.value = resolveGroupFlex(groupChildren, sizes);
    },
    [groupChildren, resizeFlex],
  );
  const handleGroupLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextSize =
        groupDirection === "horizontal"
          ? event.nativeEvent.layout.width
          : event.nativeEvent.layout.height;
      setGroupContainerSize((current) => (current === nextSize ? current : nextSize));
    },
    [groupDirection],
  );

  const groupStyle = useMemo(
    () => [
      styles.group,
      groupDirection === "horizontal" ? styles.groupHorizontal : styles.groupVertical,
    ],
    [groupDirection],
  );

  if (node.kind === "pane") {
    return (
      <WindowChromeRegion corners={windowChromeCorners}>
        <SplitPaneView
          pane={node.pane}
          paneRole={node.pane.id === sidePaneId ? "side" : "main"}
          sidePanelLaunchers={sidePanelLaunchers}
          onOpenSidePanelTab={onOpenSidePanelTab}
          uiTabs={uiTabs}
          isFocused={node.pane.id === focusedPaneId}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          isWorkspaceFocused={isWorkspaceFocused}
          hoveredCloseTabKey={hoveredCloseTabKey}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          closingTabIds={closingTabIds}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          onCreateTerminalTab={onCreateTerminalTab}
          arenaSeatSides={arenaSeatSides}
          onCreateArenaSeatTerminal={onCreateArenaSeatTerminal}
          onCreateBrowserTab={onCreateBrowserTab}
          showCreateBrowserTab={showCreateBrowserTab}
          buildPaneContentModel={buildPaneContentModel}
          onFocusPane={onFocusPane}
          onReorderTabsInPane={onReorderTabsInPane}
          renderPaneEmptyState={renderPaneEmptyState}
          activeDragTabId={activeDragTabId}
          showDropZones={showDropZones}
          dropPreview={dropPreview}
          tabDropPreview={tabDropPreview}
          focusModeEnabled={focusModeEnabled}
          onExitFocusMode={onExitFocusMode}
        />
      </WindowChromeRegion>
    );
  }

  const floors = resolveSplitFloors({
    direction: node.group.direction,
    childIsSidePane: node.group.children.map(
      (child) => child.kind === "pane" && child.pane.id === sidePaneId,
    ),
  });

  return (
    <View style={groupStyle} onLayout={handleGroupLayout}>
      {node.group.children.map((child, index) => (
        <Fragment key={getNodeKey(child)}>
          <SplitGroupChild
            resizeFlex={resizeFlex}
            index={index}
            floorStyle={floors.childStyles[index]}
          >
            <SplitNodeView
              node={child}
              sidePaneId={sidePaneId}
              sidePanelLaunchers={sidePanelLaunchers}
              onOpenSidePanelTab={onOpenSidePanelTab}
              workspaceKey={workspaceKey}
              uiTabs={uiTabs}
              focusedPaneId={focusedPaneId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              closingTabIds={closingTabIds}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onCopyTerminalId={onCopyTerminalId}
              onCopyFilePath={onCopyFilePath}
              onReloadAgent={onReloadAgent}
              onRenameTab={onRenameTab}
              onCloseTabsToLeft={onCloseTabsToLeft}
              onCloseTabsToRight={onCloseTabsToRight}
              onCloseOtherTabs={onCloseOtherTabs}
              onCreateTerminalTab={onCreateTerminalTab}
              arenaSeatSides={arenaSeatSides}
              onCreateArenaSeatTerminal={onCreateArenaSeatTerminal}
              onCreateBrowserTab={onCreateBrowserTab}
              showCreateBrowserTab={showCreateBrowserTab}
              buildPaneContentModel={buildPaneContentModel}
              onFocusPane={onFocusPane}
              onResizeSplit={onResizeSplit}
              onReorderTabsInPane={onReorderTabsInPane}
              renderPaneEmptyState={renderPaneEmptyState}
              activeDragTabId={activeDragTabId}
              showDropZones={showDropZones}
              dropPreview={dropPreview}
              tabDropPreview={tabDropPreview}
              windowChromeCorners={windowChromeCorners}
              focusModeEnabled={focusModeEnabled}
              onExitFocusMode={onExitFocusMode}
            />
          </SplitGroupChild>
          {index < node.group.children.length - 1 ? (
            <ResizeHandle
              testID="workspace-side-panel-resize-handle"
              direction={node.group.direction}
              groupId={node.group.id}
              index={index}
              sizes={groupSizes}
              containerSize={groupContainerSize}
              onPreviewResizeSplit={previewResizeSplit}
              onResizeSplit={onResizeSplit}
              floors={floors.handle}
            />
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

const SplitPaneView = memo(function SplitPaneView({
  pane,
  paneRole,
  sidePanelLaunchers,
  onOpenSidePanelTab,
  uiTabs,
  isFocused,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  closingTabIds,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateTerminalTab,
  arenaSeatSides,
  onCreateArenaSeatTerminal,
  onCreateBrowserTab,
  showCreateBrowserTab,
  buildPaneContentModel,
  onFocusPane,
  onReorderTabsInPane,
  renderPaneEmptyState,
  activeDragTabId,
  showDropZones,
  dropPreview,
  tabDropPreview,
  focusModeEnabled,
  onExitFocusMode,
}: SplitPaneViewProps) {
  recordRenderProfileReasons(`SplitPaneView:${pane.id}`, ["render"]);
  const paneRef = useRef<View | null>(null);
  const stableOnFocusPane = useStableEvent(onFocusPane);
  const paneState = useMemo(
    () =>
      deriveWorkspacePaneState({
        pane,
        tabs: uiTabs,
      }),
    [pane, uiTabs],
  );
  const paneTabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabDescriptor = paneState.activeTab?.descriptor ?? null;
  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      paneTabs.map((tab) => ({
        tab,
        isActive: tab.key === activeTabDescriptor?.key,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabDescriptor?.key, closingTabIds, hoveredCloseTabKey, paneTabs],
  );

  useEffect(() => {
    if (isNative) {
      return () => {};
    }

    const rawRef: unknown = paneRef.current;
    if (!(rawRef instanceof HTMLElement)) {
      return () => {};
    }
    const paneElement = rawRef;

    const handlePanePointerDown = (event: PointerEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    const handlePaneFocusIn = (event: FocusEvent) => {
      if (!shouldFocusPaneFromEventTarget(event.target)) {
        return;
      }
      stableOnFocusPane(pane.id);
    };

    paneElement.addEventListener("pointerdown", handlePanePointerDown, true);
    paneElement.addEventListener("focusin", handlePaneFocusIn, true);

    return () => {
      paneElement.removeEventListener("pointerdown", handlePanePointerDown, true);
      paneElement.removeEventListener("focusin", handlePaneFocusIn, true);
    };
  }, [stableOnFocusPane, pane.id]);

  const paneId = pane.id;
  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => onCloseTabsToLeft(tabId, paneTabs),
    [onCloseTabsToLeft, paneTabs],
  );
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => onCloseTabsToRight(tabId, paneTabs),
    [onCloseTabsToRight, paneTabs],
  );
  const handleCloseOtherTabs = useCallback(
    (tabId: string) => onCloseOtherTabs(tabId, paneTabs),
    [onCloseOtherTabs, paneTabs],
  );
  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      onReorderTabsInPane(
        paneId,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [onReorderTabsInPane, paneId],
  );
  // An empty side pane is all launcher: a tab row with nothing in it but the
  // "+" is a second, smaller way to do what the launcher already offers, above
  // a strip of chrome that says nothing. Focus mode is the exception — the row
  // carries the only way out of it.
  const showSideTabRow =
    paneRole === "side" && (desktopTabRowItems.length > 0 || Boolean(focusModeEnabled));

  return (
    <RenderProfile id={`SplitPaneView:${pane.id}`}>
      <View
        ref={paneRef}
        collapsable={false}
        style={styles.pane}
        testID={`workspace-pane-${pane.id}`}
      >
        {showSideTabRow ? (
          <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
            <TitlebarDragRegion />
            <WorkspaceDesktopTabsRow
              paneId={pane.id}
              isFocused={isFocused && isWorkspaceFocused}
              tabs={desktopTabRowItems}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              onCopyResumeCommand={onCopyResumeCommand}
              onCopyAgentId={onCopyAgentId}
              onCopyTerminalId={onCopyTerminalId}
              onCopyFilePath={onCopyFilePath}
              onReloadAgent={onReloadAgent}
              onRenameTab={onRenameTab}
              onCloseTabsToLeft={handleCloseTabsToLeft}
              onCloseTabsToRight={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
              onCreateTerminalTab={onCreateTerminalTab}
              arenaSeatSides={arenaSeatSides}
              onCreateArenaSeatTerminal={onCreateArenaSeatTerminal}
              onCreateBrowserTab={onCreateBrowserTab}
              showCreateBrowserTab={showCreateBrowserTab}
              onReorderTabs={handleReorderTabs}
              externalDndContext
              activeDragTabId={activeDragTabId}
              tabDropPreviewIndex={
                tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
              }
              sidePanelLaunchers={sidePanelLaunchers}
              onOpenSidePanelTab={onOpenSidePanelTab}
              focusModeEnabled={Boolean(focusModeEnabled)}
              onExitFocusMode={onExitFocusMode}
            />
          </WindowChromeSafeArea>
        ) : null}
        {paneRole === "main" ? (
          <MainPaneFocusStrip
            focusModeEnabled={Boolean(focusModeEnabled)}
            onExitFocusMode={onExitFocusMode}
          />
        ) : null}

        <View style={styles.paneContent}>
          {paneTabs.length > 0 ? (
            <WorkspacePanelHost
              paneId={pane.id}
              tabs={paneTabs}
              activeTabId={activeTabDescriptor?.tabId ?? null}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused={isFocused}
              onFocusPane={stableOnFocusPane}
              buildPaneContentModel={buildPaneContentModel}
            />
          ) : (
            (renderPaneEmptyState?.(paneRole) ?? null)
          )}
          <SplitDropZone paneId={pane.id} active={showDropZones} preview={dropPreview} />
        </View>
      </View>
    </RenderProfile>
  );
});

function collectPanesById(node: SplitNode): Map<string, SplitPane> {
  const next = new Map<string, SplitPane>();
  function visit(current: SplitNode) {
    if (current.kind === "pane") {
      next.set(current.pane.id, current.pane);
      return;
    }
    for (const child of current.group.children) {
      visit(child);
    }
  }
  visit(node);
  return next;
}

function getNodeKey(node: SplitNode): string {
  if (node.kind === "pane") {
    return node.pane.id;
  }
  return node.group.id;
}

function wrapRootPaneForStableMount(node: SplitNode): SplitNode {
  if (node.kind === "group") {
    return node;
  }

  return {
    kind: "group",
    group: {
      id: `root:${node.pane.id}`,
      direction: "horizontal",
      children: [node],
      sizes: [1],
    },
  };
}

const styles = StyleSheet.create((theme) => ({
  group: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  groupHorizontal: {
    flexDirection: "row",
  },
  groupVertical: {
    flexDirection: "column",
  },
  groupChild: {
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  },
  pane: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  paneTabs: {
    position: "relative",
    minWidth: 0,
  },
  mainPaneFocusStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    paddingHorizontal: theme.spacing[1],
  },
  paneContent: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  dragOverlayChip: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    maxWidth: 200,
  },
  dragOverlayLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
}));
