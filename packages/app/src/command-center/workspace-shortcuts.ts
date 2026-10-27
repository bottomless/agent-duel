import {
  resolveShortcutKeysForAction,
  type ShortcutOverrides,
} from "@/keyboard/keyboard-shortcuts";
import type { WorkspaceCommandCenterShortcuts } from "./workspace-contributions";

interface ResolveWorkspaceCommandCenterShortcutsInput {
  overrides: ShortcutOverrides;
  platform: { isMac: boolean; isDesktop: boolean };
}

export function resolveWorkspaceCommandCenterShortcuts({
  overrides,
  platform,
}: ResolveWorkspaceCommandCenterShortcutsInput): WorkspaceCommandCenterShortcuts {
  return {
    newTerminal:
      resolveShortcutKeysForAction("workspace-terminal-new", overrides, platform) ?? undefined,
    archiveWorkspace:
      resolveShortcutKeysForAction("archive-workspace", overrides, platform) ?? undefined,
    previousTab:
      resolveShortcutKeysForAction("workspace-tab-prev", overrides, platform) ?? undefined,
    nextTab: resolveShortcutKeysForAction("workspace-tab-next", overrides, platform) ?? undefined,
    closeCurrentTab:
      resolveShortcutKeysForAction("workspace-tab-close-current", overrides, platform) ?? undefined,
    closePane:
      resolveShortcutKeysForAction("workspace-pane-close", overrides, platform) ?? undefined,
    toggleFocusMode: resolveShortcutKeysForAction("toggle-focus", overrides, platform) ?? undefined,
    toggleSidePanel:
      resolveShortcutKeysForAction("toggle-right-sidebar", overrides, platform) ?? undefined,
    // Workspace management shortcuts
    pinWorkspace: resolveShortcutKeysForAction("pin-workspace", overrides, platform) ?? undefined,
  };
}
