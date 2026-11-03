/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

vi.mock("lucide-react-native", () => ({ ChevronDown: () => null }));

// The menu engine needs a real layout; the rows are plain content inside it.
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  const Item = ({
    children,
    trailing,
    onSelect,
    testID,
  }: {
    children?: React.ReactNode;
    trailing?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
      {trailing}
    </button>
  );
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Item,
  };
});

import { ArenaRunTurnsMenu } from "./run-turns";

const at = (seconds: number) => Date.parse("2026-09-14T12:00:00.000Z") + seconds * 1000;

function timedMessage(id: string, role: string, created: number, completed?: number) {
  return {
    id,
    role,
    sessionID: "session-a",
    time: {
      created: at(created),
      ...(completed === undefined ? {} : { completed: at(completed) }),
    },
    ...(role === "assistant" && completed !== undefined ? { finish: "stop" } : {}),
  };
}

// The prompt took 45s; the follow-up sent at 100s took 30s.
const FOLLOWED_UP_RUN = {
  id: "run-a",
  side: "a",
  sessionID: "session-a",
  descendantSessionIDs: [],
  worktree: "/tmp/a",
  worktreeName: "a",
  worktreeActive: true,
  runState: "complete",
  durationMs: 75_000,
  priorDurationMs: 45_000,
  selectable: true,
  applicable: true,
  canRetry: false,
  startedAt: new Date(at(100)).toISOString(),
  promptMessageID: "prompt",
  messages: [
    timedMessage("prompt", "user", 0),
    timedMessage("a1", "assistant", 1, 45),
    timedMessage("reply", "user", 100),
    timedMessage("a2", "assistant", 101, 130),
  ],
  parts: {},
} satisfies ArenaRun;

const FOLLOW_UP_RUNNING_RUN = {
  ...FOLLOWED_UP_RUN,
  runState: "pending",
  durationMs: null,
  messages: [...FOLLOWED_UP_RUN.messages.slice(0, 3), timedMessage("a2", "assistant", 101)],
} satisfies ArenaRun;

const ONE_REQUEST_RUN = {
  ...FOLLOWED_UP_RUN,
  durationMs: 45_000,
  priorDurationMs: 0,
  messages: FOLLOWED_UP_RUN.messages.slice(0, 2),
} satisfies ArenaRun;

const noop = () => {};

function turnTexts(view: ReturnType<typeof render>) {
  return [...view.getByTestId("arena-run-turns-a-content").children].map((row) => row.textContent);
}

describe("ArenaRunTurnsMenu", () => {
  afterEach(cleanup);

  it("counts the turns and lists each one's time", () => {
    const view = render(
      <ArenaRunTurnsMenu run={FOLLOWED_UP_RUN} side="a" onJumpToMessage={noop} />,
    );

    expect(view.getByTestId("arena-run-turns-a").textContent).toBe("2 turns");
    expect(turnTexts(view)).toEqual(["Turn 145s", "Turn 230s"]);
  });

  it("lists the running turn as working", () => {
    const view = render(
      <ArenaRunTurnsMenu run={FOLLOW_UP_RUNNING_RUN} side="a" onJumpToMessage={noop} />,
    );

    expect(turnTexts(view)).toEqual(["Turn 145s", "Turn 2Working"]);
  });

  it("jumps to the follow-up that began a turn, and to the top for the first", () => {
    const onJumpToMessage = vi.fn();
    const view = render(
      <ArenaRunTurnsMenu run={FOLLOWED_UP_RUN} side="a" onJumpToMessage={onJumpToMessage} />,
    );

    fireEvent.click(view.getByTestId("arena-run-turn-reply"));
    fireEvent.click(view.getByTestId("arena-run-turn-prompt"));

    expect(onJumpToMessage.mock.calls).toEqual([["reply"], [null]]);
  });

  it("shows nothing for a run with one turn", () => {
    const view = render(
      <ArenaRunTurnsMenu run={ONE_REQUEST_RUN} side="a" onJumpToMessage={noop} />,
    );

    expect(view.queryByTestId("arena-run-turns-a")).toBeNull();
  });
});
