import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  migratePanelState,
  selectIsAgentListOpen,
  setMobilePanelTarget,
  selectPanelVisibility,
  type DesktopSidebarState,
  type MobilePanelView,
  type MobilePanelSelection,
  type PanelLayoutInput,
  type PanelVisibilityState,
  type SortOption,
} from "./state";
import { isWeb } from "@/constants/platform";
export type {
  DesktopSidebarState,
  MobilePanelView,
  MobilePanelSelection,
  PanelLayoutInput,
  PanelVisibilityState,
  SortOption,
} from "./state";
export {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  selectIsAgentListOpen,
  selectPanelVisibility,
};

export type ExpandedPathsUpdate = string[] | ((currentPaths: string[]) => string[]);

export interface PanelState {
  // Mobile: React's durable target plus the generation that owns it.
  mobilePanel: MobilePanelSelection;

  // Desktop: the app navigation sidebar and focus mode. The side panel is
  // workspace state and lives in the workspace layout store.
  desktop: DesktopSidebarState;

  // Files and Changes tab settings (shared between mobile/desktop)
  expandedPathsByWorkspace: Record<string, string[]>;
  diffExpandedPathsByWorkspace: Record<string, string[]>;
  // Changes-view folder tree. Inverted semantics vs the fields above:
  // this stores COLLAPSED directory paths (empty = all folders expanded), keyed
  // by full uncompressed dir path, so folders default to expanded and new
  // folders stay expanded as the diff changes.
  diffCollapsedFoldersByWorkspace: Record<string, string[]>;
  sidebarWidth: number;
  explorerSortOption: SortOption;
  explorerShowHiddenFiles: boolean;

  // Actions
  toggleFocusMode: () => void;
  exitFocusMode: () => void;
  showMobileAgent: () => void;
  showMobileAgentList: () => void;
  toggleMobileAgentList: () => void;
  openDesktopAgentList: () => void;
  closeDesktopAgentList: () => void;
  toggleDesktopAgentList: () => void;
  openAgentListForLayout: (input: PanelLayoutInput) => void;
  closeAgentListForLayout: (input: PanelLayoutInput) => void;
  toggleAgentListForLayout: (input: PanelLayoutInput) => void;

  // Files and Changes tab settings actions
  setExpandedPathsForWorkspace: (workspaceKey: string, paths: ExpandedPathsUpdate) => void;
  setDiffExpandedPathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  setDiffCollapsedFoldersForWorkspace: (workspaceKey: string, dirPaths: string[]) => void;
  setSidebarWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  toggleExplorerShowHiddenFiles: () => void;
}

const DEFAULT_DESKTOP_OPEN = isWeb;

function setMobilePanelTargetPatch(
  state: PanelState,
  target: MobilePanelView,
): PanelState | Pick<PanelState, "mobilePanel"> {
  const mobilePanel = setMobilePanelTarget(state.mobilePanel, target);
  return mobilePanel === state.mobilePanel ? state : { mobilePanel };
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobilePanel: { target: "agent", revision: 0 },

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        focusModeEnabled: false,
      },

      expandedPathsByWorkspace: {},
      diffExpandedPathsByWorkspace: {},
      diffCollapsedFoldersByWorkspace: {},
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerShowHiddenFiles: true,

      toggleFocusMode: () =>
        set((state) => ({
          desktop: { ...state.desktop, focusModeEnabled: !state.desktop.focusModeEnabled },
        })),

      exitFocusMode: () =>
        set((state) =>
          state.desktop.focusModeEnabled
            ? { desktop: { ...state.desktop, focusModeEnabled: false } }
            : state,
        ),

      showMobileAgent: () => set((state) => setMobilePanelTargetPatch(state, "agent")),

      showMobileAgentList: () => set((state) => setMobilePanelTargetPatch(state, "agent-list")),

      toggleMobileAgentList: () =>
        set((state) =>
          setMobilePanelTargetPatch(
            state,
            state.mobilePanel.target === "agent-list" ? "agent" : "agent-list",
          ),
        ),

      openDesktopAgentList: () =>
        set((state) => {
          if (state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeDesktopAgentList: () =>
        set((state) => {
          if (!state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: false } };
        }),

      toggleDesktopAgentList: () =>
        set((state) => ({
          desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
        })),

      openAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(state, "agent-list");
          }
          return state.desktop.agentListOpen
            ? state
            : { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(state, "agent");
          }
          return state.desktop.agentListOpen
            ? { desktop: { ...state.desktop, agentListOpen: false } }
            : state;
        }),

      toggleAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(
              state,
              state.mobilePanel.target === "agent-list" ? "agent" : "agent-list",
            );
          }
          return {
            desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
          };
        }),

      setExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => {
          const currentPaths = state.expandedPathsByWorkspace[workspaceKey] ?? ["."];
          const nextPaths = typeof paths === "function" ? paths(currentPaths) : paths;
          return {
            expandedPathsByWorkspace: {
              ...state.expandedPathsByWorkspace,
              [workspaceKey]: nextPaths,
            },
          };
        }),
      setDiffExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          diffExpandedPathsByWorkspace: {
            ...state.diffExpandedPathsByWorkspace,
            [workspaceKey]: paths,
          },
        })),
      setDiffCollapsedFoldersForWorkspace: (workspaceKey, dirPaths) =>
        set((state) => ({
          diffCollapsedFoldersByWorkspace: {
            ...state.diffCollapsedFoldersByWorkspace,
            [workspaceKey]: dirPaths,
          },
        })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      toggleExplorerShowHiddenFiles: () =>
        set((state) => ({ explorerShowHiddenFiles: !state.explorerShowHiddenFiles })),
    }),
    {
      name: "panel-state",
      version: 13,
      storage: createJSONStorage(() => AsyncStorage),
      migrate: (persistedState, version) =>
        migratePanelState(persistedState, version) as unknown as PanelState,
      partialize: (state) => ({
        desktop: state.desktop,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
        diffExpandedPathsByWorkspace: state.diffExpandedPathsByWorkspace,
        diffCollapsedFoldersByWorkspace: state.diffCollapsedFoldersByWorkspace,
        sidebarWidth: state.sidebarWidth,
        explorerSortOption: state.explorerSortOption,
        explorerShowHiddenFiles: state.explorerShowHiddenFiles,
      }),
    },
  ),
);
