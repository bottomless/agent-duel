/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ArenaQuestionResultView } from "./question-result";
import { SingleAgentSizeControl } from "@/composer/agent-controls/single-agent-size-control";
import { ArenaTransitionRow } from "./transition-row";
import type { ArenaTransition } from "./environment";
import { DiffLayoutControl } from "./diff-layout-control";
import { ArenaReplyTargetControl } from "./reply-target-control";
import { arenaWorkSummaryLabel, type ArenaWorkSummary } from "./work-summary";
import { arenaRunAccountWait, arenaRunStatusLabel } from "./run-stats";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

import { ArenaTaskProgressCard } from "./task-progress-card";
import type { ArenaTask } from "./task-progress";

vi.mock("lucide-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react-native")>()),
  CircleHelp: () => null,
  CheckSquare: () => null,
}));
// The badge owns native animation; this test exercises its caller's translated label props.
vi.mock("@/components/message", () => ({
  ExpandableBadge: ({ label, secondaryLabel }: { label: string; secondaryLabel?: string }) => (
    <div>
      {label}
      <span>{secondaryLabel}</span>
    </div>
  ),
}));
const cancelledTasks: ArenaTask[] = [{ content: "keep-this-task-text", status: "cancelled" }];

vi.stubGlobal("React", React);
vi.mock("@/composer/toolbar-layout", () => ({ useCompactComposerToolbar: () => false }));

vi.mock("@/components/ui/dropdown-menu", () => {
  function Container({ children }: { children?: React.ReactNode }) {
    return <div>{children}</div>;
  }
  function Trigger({
    children,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
  }) {
    return (
      <button type="button" aria-label={accessibilityLabel}>
        {children}
      </button>
    );
  }
  return {
    DropdownMenu: Container,
    DropdownMenuTrigger: Trigger,
    DropdownMenuContent: Container,
    DropdownMenuItem: Container,
  };
});

const transition: ArenaTransition = {
  id: "transition",
  previousWinningRunID: "winner",
  createdAt: "2026-01-01T00:00:00Z",
  copyOmissions: [],
  stoppedCommands: [
    { command: "npm run dev", relativeCwd: ".", status: "stopped", verified: true },
  ],
};
const noop = () => {};
const questionResult = {
  questions: [{ question: "Use TypeScript?", answers: ["Keep model-name-v2"] }],
  interrupted: false,
};

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("Arena labels", () => {
  it("changes question chrome without translating the contestant's content", async () => {
    const view = render(<ArenaQuestionResultView result={questionResult} />);
    expect(view.getByText("Questions")).toBeTruthy();
    await act(() => i18n.changeLanguage("zh-CN"));
    expect(view.getByText("问题")).toBeTruthy();
    expect(view.getByText("已回答 1/1")).toBeTruthy();
    expect(view.getByText("Use TypeScript?")).toBeTruthy();
    expect(view.getByText("Keep model-name-v2")).toBeTruthy();
  });

  it("changes cached diff layout labels in a mounted control", async () => {
    const view = render(<DiffLayoutControl agentId="labels-test" width={900} />);
    expect(view.getByRole("button", { name: "Side by side" })).toBeTruthy();
    await act(() => i18n.changeLanguage("fr"));
    expect(view.getByRole("button", { name: "Côte à côte" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Une colonne" })).toBeTruthy();
  });

  it("changes memoized contestant labels and disabled accessibility explanations", async () => {
    const actions = [{ target: "both", label: "Message both", steering: false }] as const;
    const view = render(
      <ArenaReplyTargetControl actions={actions} value="both" onValueChange={noop} />,
    );
    expect(
      view.getByRole("button", { name: "Agent A cannot take a message right now" }),
    ).toBeTruthy();
    await act(() => i18n.changeLanguage("es"));
    expect(view.getByText("Ambos")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "El agente A no puede recibir un mensaje ahora" }),
    ).toBeTruthy();
  });

  it("translates model-size accessibility and nearby help while retaining model names", async () => {
    const view = render(<SingleAgentSizeControl value="medium" disabled={false} onChange={noop} />);
    expect(view.getByRole("button", { name: "Model size: medium" })).toBeTruthy();
    await act(() => i18n.changeLanguage("zh-CN"));
    expect(view.getByRole("button", { name: "模型规格：中等" })).toBeTruthy();
    expect(view.getByRole("button", { name: "关于模型规格和必需评价" })).toBeTruthy();
    expect(view.getByText("中等规格使用 GPT Luna 5.6 Xhigh，无需评价即可无限使用。")).toBeTruthy();
  });

  it("translates expanded transition status badges and leaves commands intact", async () => {
    const view = render(<ArenaTransitionRow transition={transition} />);
    fireEvent.click(view.getByRole("button", { name: "Expand environment transition details" }));
    expect(view.getByText("stopped")).toBeTruthy();
    await act(() => i18n.changeLanguage("fr"));
    expect(view.getByText("arrêté")).toBeTruthy();
    expect(view.getByText("npm run dev")).toBeTruthy();
  });

  it("recomputes memoized task status labels when language changes", async () => {
    const view = render(<ArenaTaskProgressCard tasks={cancelledTasks} state="snapshot" />);
    expect(view.getByText("1 cancelled")).toBeTruthy();
    await act(() => i18n.changeLanguage("zh-CN"));
    expect(view.getByText("1 项已取消")).toBeTruthy();
  });

  it("keeps English work counts and translates their whole phrases", async () => {
    const work: ArenaWorkSummary = {
      readFileCount: 1,
      commandCount: 2,
      editedFileCount: 1,
      searchCount: 2,
      otherToolCount: 1,
      reasoningCount: 0,
    };
    expect(arenaWorkSummaryLabel(work, true)).toBe(
      "Reading 1 file · Running 2 commands · Editing 1 file · Running 2 searches · Using 1 other tool",
    );
    await i18n.changeLanguage("zh-CN");
    expect(arenaWorkSummaryLabel(work, true)).toBe(
      "正在读取1 个文件 · 正在运行2 条命令 · 正在编辑1 个文件 · 正在运行2 次搜索 · 正在使用1 个其他工具",
    );
  });

  it("translates known engine wait messages while detecting their original wire values", async () => {
    const run = {
      runState: "pending",
      status: { type: "retry", message: "Waiting for sign-in" },
    } satisfies Pick<ArenaRun, "runState" | "status">;
    await i18n.changeLanguage("ja");
    expect(arenaRunAccountWait(run)).toBe("sign-in");
    // Only the status fields are read before this known wait is returned.
    const completeRun: ArenaRun = {
      ...run,
      id: "run",
      side: "a",
      sessionID: "session",
      descendantSessionIDs: [],
      worktree: "/tmp/labels",
      worktreeName: "labels",
      worktreeActive: true,
      durationMs: 0,
      selectable: false,
      applicable: false,
      canRetry: false,
    };
    expect(arenaRunStatusLabel(completeRun, 0)).toBe("サインイン待ち");
  });
});
