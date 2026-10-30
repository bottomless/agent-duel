/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.stubGlobal("React", React);

vi.mock("@/components/thinking-block", () => ({
  ThinkingBlock: () => <div data-testid="paseo-thinking" />,
}));

vi.mock("@/components/message", () => ({
  EXPANDABLE_BADGE_DETAIL_INSET: 13,
  ExpandableBadge: (props: {
    label: string;
    secondaryLabel?: string;
    labelTextStyle?: unknown;
    alwaysShowChevron?: boolean;
    testID: string;
    isExpanded: boolean;
    isLoading: boolean;
    isError?: boolean;
    onToggle?: () => void;
    renderDetails?: () => React.ReactNode;
  }) => (
    <div
      data-testid={props.testID}
      data-loading={props.isLoading}
      data-error={props.isError}
      data-label-style={props.labelTextStyle ? "custom" : undefined}
      data-chevron={props.alwaysShowChevron ? "always" : undefined}
    >
      <button type="button" onClick={props.onToggle}>
        {props.label}
      </button>
      <span>{props.secondaryLabel}</span>
      {props.isExpanded ? props.renderDetails?.() : null}
    </div>
  ),
  ToolCall: () => null,
  UserMessage: ({ message }: { message: string }) => <p data-testid="user-message">{message}</p>,
}));

vi.mock("@/components/question-form-card", () => ({
  QuestionFormCard: () => <div data-testid="pending-question">Choose a scope</div>,
}));
vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text, subdued }: { text: string; subdued?: boolean }) => (
    <p data-subdued={subdued ? "true" : undefined}>{text}</p>
  ),
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
vi.mock("./run-turns", () => ({
  ArenaMessageAnchor: ({ children }: { children: React.ReactNode }) => children,
  useArenaPauseFollow: () => null,
}));

import { ArenaRunThread } from "./run-thread";

afterEach(cleanup);

function TestQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
  canRetry: false,
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

const MIXED_REASONING_RUN = {
  ...PENDING_REASONING_RUN,
  parts: {
    assistant: [
      ...PENDING_REASONING_RUN.parts.assistant,
      { type: "thought", text: "Private thought" },
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "/root.md" }, output: "contents" },
      },
      { type: "text", text: "The file is ready." },
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

function respondingSubagentRun(): ArenaRun {
  const run = subagentRun();
  return {
    ...run,
    parts: {
      ...run.parts,
      "child-work": [
        { type: "reasoning", text: "Done looking", time: { start: 1, end: 2 } },
        { type: "text", text: "Report so far", time: { start: 2 } },
      ],
    },
  };
}

function stoppedSubagentRun(): ArenaRun {
  const run = subagentRun();
  const aborted = {
    type: "tool",
    tool: "task",
    state: {
      status: "error",
      error: "Tool execution aborted",
      input: { description: "Find vote storage" },
      metadata: { sessionId: "child", interrupted: true },
    },
  };
  return { ...run, runState: "stopped", parts: { ...run.parts, assistant: [aborted] } };
}

function promptedSubagentRun(): ArenaRun {
  const run = subagentRun();
  const messages = run.messages ?? [];
  return {
    ...run,
    messages: [
      ...messages.slice(0, 2),
      { id: "child-prompt", role: "user", sessionID: "child" },
      ...messages.slice(2),
    ],
    parts: { ...run.parts, "child-prompt": [{ type: "text", text: "Find where votes live." }] },
  };
}

const CONTINUATION =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const COMPACTING_RUN: ArenaRun = {
  ...PENDING_REASONING_RUN,
  messages: [
    { id: "prompt", role: "user" },
    { id: "compact", role: "user" },
    { id: "summary", role: "assistant", parentID: "compact", summary: true },
  ],
  parts: {
    compact: [{ type: "compaction", auto: true }],
    summary: [{ type: "text", text: "Internal summary of the task" }],
  },
};

const RESUMED_RUN: ArenaRun = {
  ...COMPACTING_RUN,
  messages: [
    { id: "prompt", role: "user" },
    { id: "compact", role: "user" },
    {
      id: "summary",
      role: "assistant",
      parentID: "compact",
      summary: true,
      time: { completed: 2 },
    },
    { id: "continue", role: "user" },
    { id: "answer", role: "assistant" },
  ],
  parts: {
    ...COMPACTING_RUN.parts,
    continue: [{ type: "text", text: CONTINUATION, synthetic: true }],
    answer: [{ type: "text", text: "I fixed the map labels." }],
  },
};

function endedCompactionRun(input: { state: ArenaRun["runState"]; error?: unknown }): ArenaRun {
  return {
    ...PENDING_REASONING_RUN,
    runState: input.state,
    messages: [
      { id: "prompt", role: "user" },
      { id: "compact", role: "user" },
      { id: "summary", role: "assistant", parentID: "compact", summary: true, error: input.error },
    ],
    parts: { compact: [{ type: "compaction", auto: true }] },
  };
}

function compactingSubagentRun(): ArenaRun {
  const run = subagentRun();
  return {
    ...run,
    messages: [
      ...(run.messages ?? []),
      { id: "child-compact", role: "user", sessionID: "child" },
      {
        id: "child-summary",
        role: "assistant",
        sessionID: "child",
        parentID: "child-compact",
        summary: true,
      },
    ],
    parts: {
      ...run.parts,
      "child-compact": [{ type: "compaction", auto: true }],
      "child-summary": [{ type: "text", text: "Internal child summary" }],
    },
  };
}

const OUTPUT_LIMIT_ERROR =
  "Response limit reached after three recovery attempts. Completed work has been preserved. Continue with a smaller request.";
const OUTPUT_LIMIT_RUN: ArenaRun = {
  ...PENDING_REASONING_RUN,
  runState: "error",
  error: OUTPUT_LIMIT_ERROR,
  parts: { assistant: [{ type: "text", text: "Saved progress before the limit." }] },
};

const TRIMMED_RUN: ArenaRun = { ...OUTPUT_LIMIT_RUN, activityOmitted: 12 };

describe("ArenaRunThread", () => {
  it("says so when the engine left out the oldest activity of a very large run", () => {
    const trimmed = render(<ArenaRunThread run={TRIMMED_RUN} />);
    expect(trimmed.getByTestId("arena-run-activity-omitted").textContent).toBe(
      "Earlier activity in this run is too large to show.",
    );
    expect(trimmed.getByText("Saved progress before the limit.")).toBeTruthy();
    trimmed.unmount();

    const whole = render(<ArenaRunThread run={OUTPUT_LIMIT_RUN} />);
    expect(whole.queryByTestId("arena-run-activity-omitted")).toBeNull();
  });

  it("shows output-limit exhaustion while retaining partial text", () => {
    const view = render(<ArenaRunThread run={OUTPUT_LIMIT_RUN} />);
    expect(view.getByText(OUTPUT_LIMIT_ERROR).textContent).toBe(OUTPUT_LIMIT_ERROR);
    expect(view.getByText("Saved progress before the limit.").textContent).toBe(
      "Saved progress before the limit.",
    );
  });

  it.each([
    { state: "error", error: { name: "APIError" }, label: "Context compaction failed" },
    { state: "stopped", error: undefined, label: "Context compaction interrupted" },
  ] as const)("does not keep compaction animated after $state", ({ state, error, label }) => {
    const run = endedCompactionRun({ state, error });
    const view = render(<ArenaRunThread run={run} />);
    expect(view.getByTestId("arena-compaction").textContent).toBe(label);
    expect(view.getByTestId("arena-compaction").getAttribute("data-loading")).toBe("false");
  });

  it("shows a subagent compacting without exposing its summary or interrupting its parent", () => {
    const run = compactingSubagentRun();
    const view = render(<ArenaRunThread run={run} />);
    const child = within(view.getByTestId("arena-subagent"));
    expect(child.getByTestId("arena-subagent-latest").textContent).toBe("Compacting context…");
    expect(child.getByTestId("arena-subagent-latest").getAttribute("data-loading")).toBe("true");
    fireEvent.click(within(child.getByTestId("arena-subagent-heading")).getByRole("button"));
    expect(child.getByTestId("arena-compaction").textContent).toBe("Compacting context…");
    expect(view.queryByText("Internal child summary")).toBeNull();
    expect(view.getAllByTestId("arena-compaction")).toHaveLength(1);
  });

  it("shows compaction progress, hides internal messages, and resumes the contestant thread", () => {
    const view = render(<ArenaRunThread run={COMPACTING_RUN} />);
    expect(view.getByTestId("arena-compaction").textContent).toBe("Compacting context…");
    expect(view.getByTestId("arena-compaction").getAttribute("data-loading")).toBe("true");
    expect(view.queryByText("Internal summary of the task")).toBeNull();

    view.rerender(<ArenaRunThread run={RESUMED_RUN} />);
    expect(view.getByTestId("arena-compaction").textContent).toBe("Context compacted");
    expect(view.getByTestId("arena-compaction").getAttribute("data-loading")).toBe("false");
    expect(view.queryByText(CONTINUATION)).toBeNull();
    expect(view.queryByText("Internal summary of the task")).toBeNull();
    expect(view.getByText("I fixed the map labels.").textContent).toBe("I fixed the map labels.");
  });

  it("keeps thinking content hidden while retaining the activity status", () => {
    const view = render(<ArenaRunThread run={PENDING_REASONING_RUN} />, {
      wrapper: TestQueryProvider,
    });
    fireEvent.click(view.getByRole("button", { name: "Reasoning…" }));

    expect(view.queryByText("Check `grid-template-columns`.")).toBeNull();
    expect(view.getByTestId("arena-activity-group").getAttribute("data-loading")).toBe("true");
    expect(view.queryByTestId("paseo-thinking")).toBeNull();
    expect(view.queryByTestId("paseo-turn-footer")).toBeNull();

    view.rerender(<ArenaRunThread run={MIXED_REASONING_RUN} />);
    fireEvent.click(view.getByRole("button", { name: "Read" }));
    expect(view.queryByText("Check `grid-template-columns`.")).toBeNull();
    expect(view.queryByText("Private thought")).toBeNull();
    expect(view.getByText("The file is ready.").textContent).toBe("The file is ready.");
  });

  it("collapses everything before the final text once the agent is done", () => {
    const run: ArenaRun = {
      ...PENDING_REASONING_RUN,
      parts: {
        assistant: [
          { type: "text", text: "First update" },
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "/root.md" }, output: "contents" },
          },
          { type: "text", text: "Second update" },
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "/root.md" }, output: "done" },
          },
          { type: "text", text: "Final answer" },
        ],
      },
    };
    const thread = (value: ArenaRun) => <ArenaRunThread run={value} />;
    const completedRun: ArenaRun = { ...run, runState: "complete" };
    const view = render(thread(run));
    expect(view.getByText("First update")).toBeTruthy();
    expect(view.getByText("Second update")).toBeTruthy();
    expect(view.queryByTestId("arena-earlier-activity")).toBeNull();

    view.rerender(thread(completedRun));
    expect(view.queryByText("First update")).toBeNull();
    expect(view.queryByText("Second update")).toBeNull();
    expect(view.getByText("Final answer")).toBeTruthy();
    const earlier = view.getByTestId("arena-earlier-activity");
    expect(earlier.getAttribute("data-label-style")).toBe("custom");
    expect(earlier.getAttribute("data-chevron")).toBe("always");
    expect(earlier.textContent).not.toContain("Earlier activity");
    expect(earlier.textContent).toContain("Read 1 file · Edited 1 file");

    fireEvent.click(within(earlier).getByRole("button", { name: "Read 1 file · Edited 1 file" }));
    expect(view.getByText("First update")).toBeTruthy();
    expect(view.getByText("Second update")).toBeTruthy();
    expect(view.getByText("Final answer")).toBeTruthy();
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

  it("tracks background child progress after its launch tool completes", () => {
    const thread = (run: ArenaRun) => <ArenaRunThread run={run} />;
    const source = subagentRun();
    const run: ArenaRun = {
      ...source,
      parts: {
        ...source.parts,
        assistant: [
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { description: "Background task" },
              metadata: { sessionId: "child", background: true },
            },
          },
        ],
      },
    };
    const view = render(thread(run));
    const latest = () =>
      within(view.getByTestId("arena-subagent")).getByTestId("arena-subagent-latest");
    expect(latest().textContent).not.toBe("Completed");
    expect(latest().getAttribute("data-loading")).toBe("true");
    view.rerender(thread({ ...run, runState: "stopped" }));
    expect(latest().textContent).toBe("Stopped");
    const finished: ArenaRun = {
      ...run,
      messages: [
        ...(run.messages ?? []),
        {
          id: "child-final",
          role: "assistant",
          sessionID: "child",
          finish: "stop",
          time: { completed: 10 },
        },
      ],
      parts: { ...run.parts, "child-final": [{ type: "text", text: "Finished child work." }] },
    };
    view.rerender(thread(finished));
    expect(latest().textContent).toBe("Completed");
    expect(latest().getAttribute("data-loading")).toBe("false");
    view.rerender(
      thread({
        ...finished,
        messages: [
          ...(finished.messages ?? []),
          {
            id: "child-follow-up",
            role: "user",
            sessionID: "child",
          },
        ],
      }),
    );
    expect(latest().textContent).not.toBe("Completed");
    view.rerender(
      thread({
        ...finished,
        messages: [
          ...(finished.messages ?? []),
          {
            id: "child-error",
            role: "assistant",
            sessionID: "child",
            error: { name: "APIError" },
          },
        ],
      }),
    );
    expect(latest().textContent).toBe("Failed");
  });

  it("keeps a subagent's row moving while its reply streams", () => {
    const run = respondingSubagentRun();
    const view = render(<ArenaRunThread run={run} />);
    const latest = within(view.getByTestId("arena-subagent")).getByTestId("arena-subagent-latest");
    expect(latest.textContent).toBe("Responding…");
    expect(latest.getAttribute("data-loading")).toBe("true");
  });

  it("shows a subagent cut short by Stop as stopped, not failed", () => {
    const run = stoppedSubagentRun();
    const view = render(<ArenaRunThread run={run} />);
    const latest = within(view.getByTestId("arena-subagent")).getByTestId("arena-subagent-latest");
    expect(latest.textContent).toBe("Stopped");
    expect(latest.getAttribute("data-error")).toBe("false");
  });

  it("folds a subagent's delegation prompt until it is opened", () => {
    const run = promptedSubagentRun();
    const view = render(<ArenaRunThread run={run} />);
    const child = view.getByTestId("arena-subagent");
    fireEvent.click(
      within(within(child).getByTestId("arena-subagent-heading")).getByRole("button"),
    );
    const prompt = within(child).getByTestId("arena-subagent-prompt");
    expect(within(child).queryByText("Find where votes live.")).toBeNull();

    fireEvent.click(within(prompt).getByRole("button", { name: "Task prompt" }));
    expect(within(prompt).getByText("Find where votes live.").getAttribute("data-subdued")).toBe(
      "true",
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
