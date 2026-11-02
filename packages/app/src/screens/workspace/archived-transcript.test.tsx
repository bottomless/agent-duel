/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePaneFocus } from "@/panels/pane-context";
import { ArchivedTranscript } from "@/screens/workspace/archived-transcript";

interface ProbeProps {
  streamHead?: unknown[];
  streamItems: unknown[];
  readOnly?: boolean;
}

const seen: { props: ProbeProps; focus: ReturnType<typeof usePaneFocus> }[] = [];

// ChatFind is what requires the context: AgentStreamView renders it around every transcript.
vi.mock("@/agent-stream/view", () => ({
  AgentStreamView: (props: ProbeProps) => {
    seen.push({ props, focus: usePaneFocus() });
    return null;
  },
}));

vi.mock("@/data/query", () => {
  const query = {
    data: {
      epoch: "epoch",
      agent: { cwd: "/tmp/removed-worktree", provider: "opencode" },
      startCursor: { epoch: "epoch", seq: 1 },
      hasOlder: false,
      entries: [
        {
          provider: "opencode",
          seqStart: 1,
          timestamp: "2026-11-02T00:00:00.000Z",
          item: { type: "assistant_message", messageId: "message", text: "kept after archive" },
        },
      ],
    },
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  return { useFetchQuery: () => query };
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  seen.length = 0;
});

function renderTranscript(isWorkspaceFocused: boolean) {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root?.render(
      <ArchivedTranscript
        serverId="server"
        agentId="agent"
        isWorkspaceFocused={isWorkspaceFocused}
        onClose={vi.fn()}
      />,
    );
  });
}

describe("ArchivedTranscript", () => {
  it("renders the stream inside a pane focus context", () => {
    renderTranscript(true);
    const last = seen.at(-1);
    expect(last?.props.readOnly).toBe(true);
    expect(last?.focus).toMatchObject({ isPaneFocused: true, isInteractive: true });
  });

  it("is not interactive while its route is in the background", () => {
    renderTranscript(false);
    expect(seen.at(-1)?.focus).toMatchObject({ isWorkspaceFocused: false, isInteractive: false });
  });

  it("does not draw the store's stale live head over the fetched pages", () => {
    renderTranscript(true);
    expect(seen.at(-1)?.props.streamHead).toEqual([]);
  });
});
