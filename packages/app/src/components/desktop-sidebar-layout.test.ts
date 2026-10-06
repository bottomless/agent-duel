import { describe, expect, it } from "vitest";
import {
  resolveDesktopAppChromeLayout,
  resolveDesktopPanelPresentation,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";

describe("desktop sidebar layout", () => {
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
