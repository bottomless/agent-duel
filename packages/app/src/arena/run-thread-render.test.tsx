/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

vi.mock("@/components/thinking-block", () => ({
  ThinkingBlock: () => <div data-testid="paseo-thinking" />,
}));

vi.mock("@/components/message", () => ({
  EXPANDABLE_BADGE_DETAIL_INSET: 13,
  ExpandableBadge: (props: {
    label: string;
    secondaryLabel?: string;
    testID: string;
    isExpanded: boolean;
    isLoading: boolean;
    onToggle?: () => void;
    renderDetails?: () => React.ReactNode;
  }) => (
    <div data-testid={props.testID} data-loading={props.isLoading}>
      <button type="button" onClick={props.onToggle}>
        {props.label}
      </button>
      <span>{props.secondaryLabel}</span>
      {props.isExpanded ? props.renderDetails?.() : null}
    </div>
  ),
  ToolCall: () => null,
  UserMessage: () => null,
}));

vi.mock("@/components/question-form-card", () => ({
  QuestionFormCard: () => <div data-testid="pending-question">Choose a scope</div>,
}));
vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("@/agent-stream/turn-footer", () => ({
  RunningTurnFooter: () => <div data-testid="paseo-turn-footer" />,
}));
vi.mock("@/arena/permission", () => ({
  ArenaPermissionCard: () => null,
  arenaPendingPermissions: () => [],
}));
vi.mock("@/arena/task-progress-card", () => ({ ArenaTaskProgressCard: () => null }));
vi.mock("@/arena/prompt-attachment-pills", () => ({ arenaMessageAttachmentPills: () => [] }));

import { ArenaRunThread } from "./run-thread";

afterEach(cleanup);

const PENDING_REASONING_RUN = {
  id: "run-a",
  side: "a",
  sessionID: "session-a",
  descendantSessionIDs: [],
  worktree: "/tmp/a",
  worktreeName: "a",
  worktreeActive: true,
  runState: "pending",
  durationMs: 10,
  selectable: true,
  applicable: true,
  startedAt: "2026-09-14T12:00:00.000Z",
  promptMessageID: "prompt",
  messages: [
    { id: "prompt", role: "user" },
    { id: "assistant", role: "assistant" },
  ],
  parts: {
    assistant: [
      {
        type: "reasoning",
        text: "Check `grid-template-columns`.",
        time: { start: 1 },
      },
    ],
  },
} satisfies ArenaRun;

function subagentRun(status = "running"): ArenaRun {
  const task = {
    type: "tool",
    tool: "task",
    state: {
      status,
      input: { description: "Find vote storage" },
      metadata: { sessionId: "child" },
    },
  };
  return {
    ...PENDING_REASONING_RUN,
    messages: [
      { id: "prompt", role: "user", sessionID: "session-a" },
      { id: "assistant", role: "assistant", sessionID: "session-a" },
      { id: "child-work", role: "assistant", sessionID: "child" },
      { id: "parent-work", role: "assistant", sessionID: "session-a" },
    ],
    parts: {
      assistant: [task],
      "child-work": [
        { type: "text", text: "Child finding" },
        { type: "tool", tool: "bash", state: { status: "running", input: { command: "ls" } } },
      ],
      "parent-work": [
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "/root.md" }, output: "contents" },
        },
      ],
    },
  };
}

function questioningSubagentRun(): ArenaRun {
  const run = subagentRun();
  return {
    ...run,
    questions: [
      {
        id: "question",
        tool: { callID: "ask" },
        questions: [{ question: "Choose a scope", header: "Scope", options: [] }],
      },
    ],
    parts: {
      ...run.parts,
      "child-work": [
        { type: "tool", tool: "question", callID: "ask", state: { status: "running" } },
      ],
    },
  };
}

describe("ArenaRunThread", () => {
  it("reveals reasoning inside activity details without a second thinking row", () => {
    const view = render(<ArenaRunThread run={PENDING_REASONING_RUN} />);
    fireEvent.click(view.getByRole("button", { name: "Reasoning…" }));

    expect(view.getByText("Check `grid-template-columns`.").textContent).toBe(
      "Check `grid-template-columns`.",
    );
    expect(view.queryByTestId("paseo-thinking")).toBeNull();
    expect(view.queryByTestId("paseo-turn-footer")).toBeNull();
  });

  it("separates a subagent's latest tool from the parent and reveals its transcript", () => {
    const run = subagentRun();
    const view = render(<ArenaRunThread run={run} />);
    const child = view.getByTestId("arena-subagent");
    expect(child.textContent).toContain("Subagent · Find vote storage");
    const heading = within(child).getByTestId("arena-subagent-heading");
    const activity = within(child).getByTestId("arena-subagent-activity");
    expect(heading.textContent).not.toContain("Shell");
    expect(heading.getAttribute("data-loading")).not.toBe("true");
    expect(activity.textContent).toContain("Shell");
    expect(activity.textContent).not.toContain("Working");
    expect(within(activity).getByTestId("arena-subagent-latest").getAttribute("data-loading")).toBe(
      "true",
    );
    expect(view.getByTestId("arena-activity-group").textContent).toContain("Read");
    expect(view.getByTestId("arena-activity-group").getAttribute("data-loading")).toBe("false");
    expect(view.queryByText("Child finding")).toBeNull();
    expect(view.queryByTestId("paseo-turn-footer")).toBeNull();

    fireEvent.click(within(heading).getByRole("button"));
    expect(within(child).getByText("Child finding").textContent).toBe("Child finding");
    expect(within(child).getByTestId("arena-activity-group").textContent).toContain("Shell");

    const completedRun = subagentRun("completed");
    view.rerender(<ArenaRunThread run={completedRun} />);
    const completed = view.getByTestId("arena-subagent");
    expect(within(completed).getByTestId("arena-subagent-heading").textContent).toBe(
      "Subagent · Find vote storage",
    );
    expect(within(completed).getByTestId("arena-subagent-latest").textContent).toBe("Completed");
    expect(
      within(completed).getByTestId("arena-subagent-latest").getAttribute("data-loading"),
    ).toBe("false");
    expect(within(completed).getByTestId("arena-activity-group").getAttribute("data-loading")).toBe(
      "false",
    );
  });

  it("opens a subagent when it needs an answer", () => {
    const run = questioningSubagentRun();
    const respond = vi.fn();
    const view = render(<ArenaRunThread run={run} onQuestionResponse={respond} />);
    expect(
      within(view.getByTestId("arena-subagent")).getByTestId("pending-question").textContent,
    ).toBe("Choose a scope");
  });
});
