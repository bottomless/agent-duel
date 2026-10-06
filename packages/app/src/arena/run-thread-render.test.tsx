/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

const { thinkingBlock } = vi.hoisted(() => ({ thinkingBlock: vi.fn() }));

vi.stubGlobal("React", React);

vi.mock("@/components/thinking-block", () => ({
  ThinkingBlock: (props: Record<string, unknown>) => {
    thinkingBlock(props);
    return <div data-testid="arena-thinking">{String(props.text)}</div>;
  },
}));

vi.mock("@/components/message", () => ({
  EXPANDABLE_BADGE_DETAIL_INSET: 13,
  ExpandableBadge: ({ renderDetails }: { renderDetails(): React.ReactNode }) => (
    <div>{renderDetails()}</div>
  ),
  ToolCall: () => null,
  UserMessage: () => null,
}));

vi.mock("@/components/question-form-card", () => ({ QuestionFormCard: () => null }));
vi.mock("@/components/markdown/renderer", () => ({ MarkdownRenderer: () => null }));
vi.mock("@/agent-stream/turn-footer", () => ({ RunningTurnFooter: () => null }));
vi.mock("@/arena/permission", () => ({
  ArenaPermissionCard: () => null,
  arenaPendingPermissions: () => [],
}));
vi.mock("@/arena/task-progress-card", () => ({ ArenaTaskProgressCard: () => null }));
vi.mock("@/arena/prompt-attachment-pills", () => ({ arenaMessageAttachmentPills: () => [] }));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: (selector: (settings: { autoExpandReasoning: boolean }) => unknown) =>
    selector({ autoExpandReasoning: true }),
}));

import { ArenaRunThread } from "./run-thread";

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

describe("ArenaRunThread reasoning", () => {
  it("passes active compact battle reasoning to ThinkingBlock", () => {
    const view = render(<ArenaRunThread run={PENDING_REASONING_RUN} />);

    expect(view.getByTestId("arena-thinking").textContent).toBe("Check `grid-template-columns`.");
    expect(thinkingBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Check `grid-template-columns`.",
        active: true,
        compact: true,
        defaultExpanded: true,
        disableOuterSpacing: true,
      }),
    );
  });
});
