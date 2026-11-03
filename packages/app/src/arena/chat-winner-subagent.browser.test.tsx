import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { within } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS } from "@/hooks/use-settings/storage";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { AgentStreamView } from "@/agent-stream/view";
import { i18n } from "@/i18n/i18next";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { StreamItem } from "@/types/stream";

const paneFocus = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });
const context: AgentScreenAgent = {
  id: "parent",
  serverId: "offline-test",
  status: "idle",
  cwd: "/test",
};
const turnPresentation: TurnPresentation = {
  isActive: false,
  startedAt: null,
  isCancelling: false,
  turnId: null,
};

it("opens a winning child's transcript in the canonical chat and after remount", async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  const items: StreamItem[] = [
    {
      kind: "tool_call",
      id: "child-call",
      timestamp: new Date(0),
      payload: {
        source: "agent",
        data: {
          provider: "opencode",
          callId: "child-call",
          name: "subagent",
          status: "completed",
          error: null,
          detail: { type: "sub_agent", childSessionId: "ses_child", description: "QUICK", log: "" },
        },
      },
    },
  ];
  useProviderSubagentStore.setState({
    timelines: new Map([
      [
        providerSubagentKey("offline-test", "parent", "ses_child"),
        {
          tail: [
            {
              kind: "assistant_message",
              id: "copied-answer",
              text: "QUICK done",
              timestamp: new Date(0),
            },
          ],
          head: [],
          epoch: "copied-child",
          lastSeq: 1,
          hasOlder: false,
          cursor: undefined,
          needsRefresh: false,
        },
      ],
    ]),
  });
  const queryClient = new QueryClient();
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pendingPermissions = new Map();
  const empty: StreamItem[] = [];
  try {
    for (const lane of ["head", "history", "reload"] as const) {
      act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <PaneFocusProvider value={paneFocus}>
              <AgentStreamView
                key={lane === "reload" ? "reloaded" : "original"}
                agentId="parent"
                serverId="offline-test"
                context={context}
                streamItems={lane === "head" ? empty : items}
                streamHead={lane === "head" ? items : empty}
                pendingPermissions={pendingPermissions}
                turnPresentation={turnPresentation}
                arenaChat
                readOnly
              />
            </PaneFocusProvider>
          </QueryClientProvider>,
        ),
      );
      act(() => within(container).getByRole("button", { name: "Subagent · QUICK" }).click());
      const transcript = within(container).getByTestId("arena-chat-subagent-transcript");
      expect(transcript.textContent).toContain("QUICK done");
      act(() => within(container).getByRole("button", { name: "Subagent · QUICK" }).click());
      expect(within(container).queryByTestId("arena-chat-subagent-transcript")).toBeNull();
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    useProviderSubagentStore.setState({ timelines: new Map(), descriptors: new Map() });
    vi.unstubAllGlobals();
  }
});
