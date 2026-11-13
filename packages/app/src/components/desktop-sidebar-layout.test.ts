import { describe, expect, it } from "vitest";
import {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  type WindowLayout,
} from "@/window-layout";
import {
  resolveDesktopAppChromeLayout,
  resolveDesktopPanelPresentation,
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarVisibility,
  resolveSidebarActivity,
  resolveDesktopSidebarWidth,
  resolveLeftSidebarPresentation,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
  const geometry: WindowLayout = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    verticalBarEdge: "trailing",
    verticalBar: { x: 875, y: 160, width: 44, height: 450 },
    divisions: [{ x: 465, y: 0, width: 21, height: 669 }],
  };

  it("places workspace action symbols in the reported trailing bar", () => {
    expect(resolveWorkspaceActionPlacement(geometry)).toBe("vertical-bar");
    expect(resolveWorkspaceActionPlacement(null)).toBe("header");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBarEdge: "none" })).toBe(
      "header",
    );
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBar: null })).toBe("header");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBarEdge: "leading" })).toBe(
      "header",
    );
  });

  it("shows the tab count only for the compact header selection", () => {
    expect(resolveWorkspaceBarActions("compact")).toEqual(["tab-count", "overflow", "explorer"]);
    expect(resolveWorkspaceBarActions("full")).toEqual(["overflow", "explorer"]);
  });

  it("allocates both panels around a live division without clamping to saved sidebar widths", () => {
    const input = {
      geometry,
      windowWidth: 951,
      windowHeight: 669,
      leftInset: 0,
      rightInset: 84,
    };
    expect(resolveDesktopDivisionLayout(input)).toEqual({
      sidebarWidth: 465,
      gap: 21,
      contentWidth: 381,
    });
    expect(
      resolveDesktopDivisionLayout({ ...input, geometry: { ...geometry, divisions: [] } }),
    ).toBeNull();
    expect(
      resolveDesktopDivisionLayout({ ...input, windowWidth: 669, windowHeight: 951 }),
    ).toBeNull();
    expect(resolveDesktopDivisionLayout({ ...input, geometry: null })).toBeNull();
    expect(
      resolveDesktopDivisionLayout({
        ...input,
        geometry: { ...geometry, divisions: [{ x: 0, y: 325, width: 951, height: 19 }] },
      }),
    ).toBeNull();
  });

  it("activates a revealed folded sidebar while preserving closed desktop intent", () => {
    expect(resolveSidebarActivity(true, false, false)).toBe(true);
    expect(resolveSidebarActivity(false, false, false)).toBe(false);
    expect(resolveSidebarActivity(true, true, false)).toBe(false);
    expect(resolveSidebarActivity(true, true, true)).toBe(true);
  });

  it("temporarily reveals navigation for a division without changing the saved closed intent", () => {
    const visibility = {
      chromeEnabled: true,
      isCompactLayout: false,
      isMounted: true,
      isOpen: false,
    };
    expect(
      resolveDesktopSidebarVisibility({
        ...visibility,
        divisionLayout: { sidebarWidth: 465, gap: 21, contentWidth: 381 },
      }),
    ).toBe(true);
    expect(resolveDesktopSidebarVisibility({ ...visibility, divisionLayout: null })).toBe(false);
    expect(visibility.isOpen).toBe(false);
  });

  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
      }),
    ).toBe(false);
  });

  it("offers an overlay only after wide navigation yields its dock", () => {
    const input = {
      chromeEnabled: true,
      isCompactLayout: false,
      isFocusModeEnabled: false,
    };
    expect(resolveLeftSidebarPresentation({ ...input, desktopSidebarVisible: true })).toBe("dock");
    expect(resolveLeftSidebarPresentation({ ...input, desktopSidebarVisible: false })).toBe(
      "overlay",
    );
  });

  it("does not reveal navigation over a focused workspace or suppressed chrome", () => {
    const input = {
      chromeEnabled: true,
      isCompactLayout: false,
      isFocusModeEnabled: false,
      desktopSidebarVisible: false,
    };
    expect(resolveLeftSidebarPresentation({ ...input, isFocusModeEnabled: true })).toBe("hidden");
    expect(resolveLeftSidebarPresentation({ ...input, chromeEnabled: false })).toBe("hidden");
  });

  it("keeps phone navigation available independently of saved wide focus mode", () => {
    expect(
      resolveLeftSidebarPresentation({
        chromeEnabled: true,
        isCompactLayout: true,
        isFocusModeEnabled: true,
        desktopSidebarVisible: false,
      }),
    ).toBe("overlay");
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("floats app navigation before a battle's panes stack", () => {
    const workspace = {
      isSettingsRoute: false,
      isWorkspaceRoute: true,
      requestedSidebarWidth: 320,
    };

    // 320 sidebar + 726 center is the last width that fits both.
    expect(resolveDesktopPanelPresentation({ ...workspace, viewportWidth: 1046 }).agentList).toBe(
      "inline",
    );
    expect(resolveDesktopPanelPresentation({ ...workspace, viewportWidth: 1045 }).agentList).toBe(
      "overlay",
    );
  });

  it("yields app navigation to the settings split", () => {
    const settings = {
      isSettingsRoute: true,
      isWorkspaceRoute: false,
      requestedSidebarWidth: 320,
    };

    expect(resolveDesktopPanelPresentation({ ...settings, viewportWidth: 751 }).agentList).toBe(
      "overlay",
    );
    expect(resolveDesktopPanelPresentation({ ...settings, viewportWidth: 1040 }).agentList).toBe(
      "inline",
    );
  });

  it("pins app navigation on routes with no center minimum", () => {
    expect(
      resolveDesktopPanelPresentation({
        isSettingsRoute: false,
        isWorkspaceRoute: false,
        requestedSidebarWidth: 320,
        viewportWidth: 721,
      }).agentList,
    ).toBe("inline");
  });
});

it("insets an overlay sidebar's content by the left safe area and leaves the dock to app chrome", () => {
  expect(resolveDesktopSidebarInsetLeft({ overlay: true, safeAreaLeft: 20 })).toBe(20);
  expect(resolveDesktopSidebarInsetLeft({ overlay: false, safeAreaLeft: 20 })).toBe(0);
});
