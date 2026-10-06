import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveWorkspaceChatAgentId } from "./chat-agent";

function tab(tabId: string, target: WorkspaceTabTarget) {
  return { tabId, target, createdAt: 0 };
}

function layoutWithPanes(input: {
  mainTabs: { tabId: string; target: WorkspaceTabTarget; createdAt: number }[];
  mainFocusedTabId: string | null;
  sideTabs?: { tabId: string; target: WorkspaceTabTarget; createdAt: number }[];
  focusedPaneId: string;
}): WorkspaceLayout {
  const mainPane = {
    kind: "pane" as const,
    pane: {
      id: "main",
      tabIds: input.mainTabs.map((entry) => entry.tabId),
      focusedTabId: input.mainFocusedTabId,
      tabs: input.mainTabs,
    },
  };
  if (!input.sideTabs) {
    return { focusedPaneId: input.focusedPaneId, root: mainPane } as WorkspaceLayout;
  }
  return {
    focusedPaneId: input.focusedPaneId,
    root: {
      kind: "group",
      group: {
        id: "group",
        direction: "horizontal",
        children: [
          mainPane,
          {
            kind: "pane",
            pane: {
              id: "side",
              tabIds: input.sideTabs.map((entry) => entry.tabId),
              focusedTabId: input.sideTabs[0]?.tabId ?? null,
              tabs: input.sideTabs,
            },
          },
        ],
        sizes: [0.6, 0.4],
      },
    },
  } as WorkspaceLayout;
}

describe("resolveWorkspaceChatAgentId", () => {
  it("returns the main pane's chat", () => {
    expect(
      resolveWorkspaceChatAgentId(
        layoutWithPanes({
          mainTabs: [tab("chat", { kind: "agent", agentId: "agent-1" })],
          mainFocusedTabId: "chat",
          focusedPaneId: "main",
        }),
      ),
    ).toBe("agent-1");
  });

  it("keeps the chat while a side panel tab holds focus", () => {
    expect(
      resolveWorkspaceChatAgentId(
        layoutWithPanes({
          mainTabs: [tab("chat", { kind: "agent", agentId: "agent-1" })],
          mainFocusedTabId: "chat",
          sideTabs: [tab("changes", { kind: "changes" })],
          focusedPaneId: "side",
        }),
      ),
    ).toBe("agent-1");
  });

  it("keeps the chat while a tab dragged onto the main pane holds its focus", () => {
    expect(
      resolveWorkspaceChatAgentId(
        layoutWithPanes({
          mainTabs: [
            tab("changes", { kind: "changes" }),
            tab("chat", { kind: "agent", agentId: "agent-1" }),
          ],
          mainFocusedTabId: "changes",
          focusedPaneId: "main",
        }),
      ),
    ).toBe("agent-1");
  });

  it("has no chat to report without one in the main pane", () => {
    expect(
      resolveWorkspaceChatAgentId(
        layoutWithPanes({
          mainTabs: [tab("changes", { kind: "changes" })],
          mainFocusedTabId: "changes",
          focusedPaneId: "main",
        }),
      ),
    ).toBeNull();
    expect(resolveWorkspaceChatAgentId(undefined)).toBeNull();
  });
});
