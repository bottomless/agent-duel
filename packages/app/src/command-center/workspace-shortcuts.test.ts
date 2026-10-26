import { describe, expect, it } from "vitest";
import { resolveWorkspaceCommandCenterShortcuts } from "./workspace-shortcuts";

describe("resolveWorkspaceCommandCenterShortcuts", () => {
  it("assigns the side panel toggle its shortcut", () => {
    expect(
      resolveWorkspaceCommandCenterShortcuts({
        overrides: {},
        platform: { isMac: true, isDesktop: true },
      }).toggleSidePanel,
    ).toBeDefined();
  });
});
