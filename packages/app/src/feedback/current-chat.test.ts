import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { resolveCurrentFeedbackChat } from "./current-chat";

function layout(target: { kind: "agent"; agentId: string } | { kind: "files" }): WorkspaceLayout {
  return {
    focusedPaneId: "pane-1",
    root: {
      kind: "pane",
      pane: {
        id: "pane-1",
        tabIds: ["tab-1"],
        focusedTabId: "tab-1",
        tabs: [{ tabId: "tab-1", target, createdAt: 1 }],
      },
    },
  } as WorkspaceLayout;
}

describe("current feedback chat", () => {
  it("returns the focused agent on a workspace route", () => {
    expect(
      resolveCurrentFeedbackChat({
        pathname: "/h/server-1/workspace/workspace-1",
        layouts: { "server-1:workspace-1": layout({ kind: "agent", agentId: "agent-1" }) },
      }),
    ).toEqual({ agentId: "agent-1", workspaceId: "workspace-1" });
  });

  it("does not offer context outside a focused chat", () => {
    expect(
      resolveCurrentFeedbackChat({
        pathname: "/settings",
        layouts: { "server-1:workspace-1": layout({ kind: "agent", agentId: "agent-1" }) },
      }),
    ).toBeNull();
    expect(
      resolveCurrentFeedbackChat({
        pathname: "/h/server-1/workspace/workspace-1",
        layouts: { "server-1:workspace-1": layout({ kind: "files" }) },
      }),
    ).toBeNull();
  });
});
