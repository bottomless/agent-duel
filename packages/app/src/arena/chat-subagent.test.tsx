/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

vi.stubGlobal("React", React);

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("@/components/message", () => ({
  EXPANDABLE_BADGE_DETAIL_INSET: 13,
  ExpandableBadge: (props: { label: string; testID: string; onToggle?: () => void }) => (
    <button type="button" data-testid={props.testID} onClick={props.onToggle}>
      {props.label}
    </button>
  ),
}));

const session = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ sessions: { "server-1": { client: session.client } } }),
}));

import { ArenaChatSubagent, type ArenaChatSubagentTimeline } from "./chat-subagent";
import { useProviderSubagentStore } from "@/subagents/provider-store";

const STEPS = 50;

/** Serves a subagent timeline the way the daemon does: the last `limit` rows, or all for 0. */
function daemonServing(steps: number) {
  const rows = Array.from({ length: steps }, (_, index) => ({
    seq: index + 1,
    timestamp: new Date(Date.UTC(2026, 9, 21, 10, 0, index)).toISOString(),
    item: { type: "assistant_message" as const, text: `Step ${index + 1} finished. ` },
  }));
  return {
    fetchProviderSubagentTimeline: vi.fn(
      async (parentAgentId: string, subagentId: string, options: { limit?: number }) => {
        const limit = options.limit ?? 200;
        const served = limit === 0 ? rows : rows.slice(-limit);
        return {
          requestId: "timeline",
          parentAgentId,
          subagentId,
          provider: "opencode" as const,
          direction: "tail" as const,
          epoch: "epoch-1",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 1, maxSeq: steps, nextSeq: steps + 1 },
          hasOlder: served.length < rows.length,
          hasNewer: false,
          rows: served,
          error: null,
        };
      },
    ),
  };
}

function TranscriptHost() {
  const [expanded, setExpanded] = React.useState(false);
  const onExpandedChange = React.useCallback((_: string, next: boolean) => setExpanded(next), []);
  const renderTranscript = React.useCallback(
    (timeline: ArenaChatSubagentTimeline) => (
      <div data-testid="transcript">
        {[...timeline.tail, ...timeline.head]
          .map((item) => ("text" in item ? String(item.text) : ""))
          .join("")}
      </div>
    ),
    [],
  );
  return (
    <ArenaChatSubagent
      callId="call-1"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      serverId="server-1"
      parentAgentId="agent-1"
      subagentId="ses_child"
      description="Run fifty steps"
      status="completed"
      renderTranscript={renderTranscript}
    />
  );
}

afterEach(() => {
  cleanup();
  useProviderSubagentStore.setState({ timelines: new Map(), descriptors: new Map() });
});

describe("ArenaChatSubagent", () => {
  it("shows a long transcript from its first step, as the battle pane does", async () => {
    session.client = daemonServing(STEPS) as unknown as DaemonClient;
    render(<TranscriptHost />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("arena-chat-subagent-heading"));
    });

    const transcript = await screen.findByTestId("transcript");
    await vi.waitFor(() => expect(transcript.textContent).toContain(`Step ${STEPS} finished.`));
    expect(transcript.textContent).toContain("Step 1 finished.");
  });
});
