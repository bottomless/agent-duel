import { describe, expect, it } from "vitest";
import {
  migratePanelState,
  selectIsAgentListOpen,
  setMobilePanelTarget,
  selectPanelVisibility,
  type PanelCoreState,
} from "./state";

function makePanelState(overrides: Partial<PanelCoreState> = {}): PanelCoreState {
  return {
    mobilePanel: { target: "agent", revision: 0 },
    desktop: {
      agentListOpen: false,
      focusModeEnabled: false,
    },
    ...overrides,
  };
}

describe("panel-store migration", () => {
  it("defaults hidden-file visibility to showing hidden files", () => {
    const state = migratePanelState({}, 10);

    expect(state.explorerShowHiddenFiles).toBe(true);
  });

  it("initializes diffCollapsedFoldersByWorkspace for pre-v12 state", () => {
    const state = migratePanelState({}, 11);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({});
  });

  it("preserves an existing diffCollapsedFoldersByWorkspace map", () => {
    const state = migratePanelState({ diffCollapsedFoldersByWorkspace: { ws: ["src/app"] } }, 12);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({ ws: ["src/app"] });
  });

  it("drops persisted compact panel state so cold starts return to content", () => {
    const state = migratePanelState(
      { mobileView: "agent-list", mobilePanel: { target: "agent-list", revision: 42 } },
      11,
    );

    expect(state.mobileView).toBeUndefined();
    expect(state.mobilePanel).toBeUndefined();
  });

  it("drops the Explorer sidebar state the side panel replaced", () => {
    const state = migratePanelState(
      {
        desktop: { agentListOpen: true, fileExplorerOpen: true, focusModeEnabled: false },
        explorerTab: "changes",
        explorerTabByCheckout: { "server::/tmp/repo": "files" },
        explorerWidth: 400,
        explorerFilesSplitRatio: 0.38,
        explorerShowHiddenFiles: false,
      },
      12,
    );

    expect(state.desktop).toEqual({ agentListOpen: true, focusModeEnabled: false });
    expect(state.explorerTab).toBeUndefined();
    expect(state.explorerTabByCheckout).toBeUndefined();
    expect(state.explorerWidth).toBeUndefined();
    expect(state.explorerFilesSplitRatio).toBeUndefined();
    expect(state.explorerShowHiddenFiles).toBe(false);
  });
});

describe("panel-store visibility selectors", () => {
  it("increments the mobile panel revision only when the target changes", () => {
    const initial = { target: "agent" as const, revision: 4 };

    expect(setMobilePanelTarget(initial, "agent")).toBe(initial);
    expect(setMobilePanelTarget(initial, "agent-list")).toEqual({
      target: "agent-list",
      revision: 5,
    });
  });

  it("uses the mobile panel target for compact layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "agent-list", revision: 1 },
      desktop: { agentListOpen: false, focusModeEnabled: false },
    });

    expect(selectPanelVisibility(state, { isCompact: true })).toEqual({ isAgentListOpen: true });
    expect(selectIsAgentListOpen(state, { isCompact: true })).toBe(true);
  });

  it("uses desktop flags for expanded layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "agent-list", revision: 1 },
      desktop: { agentListOpen: false, focusModeEnabled: false },
    });

    expect(selectPanelVisibility(state, { isCompact: false })).toEqual({ isAgentListOpen: false });
    expect(selectIsAgentListOpen(state, { isCompact: false })).toBe(false);
  });
});
