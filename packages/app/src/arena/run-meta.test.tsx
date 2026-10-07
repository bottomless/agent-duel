/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);

// The live clock is the only thing here that reaches for Reanimated, and this
// test is about the settled line.
vi.mock("@/components/message", () => ({ LiveElapsed: () => null }));

import { ArenaRunMeta } from "./run-meta";

const FINISHED_RUN = {
  id: "run-a",
  side: "a",
  sessionID: "session-a",
  descendantSessionIDs: [],
  worktree: "/tmp/a",
  worktreeName: "a",
  worktreeActive: true,
  runState: "complete",
  durationMs: 1000,
  selectable: true,
  applicable: true,
  startedAt: "2026-09-14T12:00:00.000Z",
  promptMessageID: "prompt",
  messages: [],
  parts: {},
  diff: { files: 9, additions: 132, deletions: 26 },
} satisfies ArenaRun;

const UNCHANGED_RUN = {
  ...FINISHED_RUN,
  diff: { files: 0, additions: 0, deletions: 0 },
} satisfies ArenaRun;

describe("ArenaRunMeta", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // Each rerender supplies a new immutable server snapshot.
  /* oxlint-disable react-perf/jsx-no-new-object-as-prop */
  it("changes from working to quiet and back when activity arrives", () => {
    vi.useFakeTimers();
    const start = new Date("2026-09-25T10:00:00Z");
    vi.setSystemTime(start);
    const run = {
      ...FINISHED_RUN,
      runState: "pending" as const,
      durationMs: null,
      startedAt: start.toISOString(),
      lastEventAt: start.toISOString(),
      diff: undefined,
    };
    const view = render(<ArenaRunMeta run={run} side="a" active />);
    const label = () => view.getByTestId("arena-run-meta-a").textContent;
    act(() => vi.advanceTimersByTime(89_999));
    expect(label()).toBe("Working·");
    act(() => vi.advanceTimersByTime(1));
    expect(label()).toBe("No recent activity·");
    view.rerender(
      <ArenaRunMeta run={{ ...run, lastEventAt: new Date().toISOString() }} side="a" active />,
    );
    expect(label()).toBe("Working·");
  });

  it("prioritizes input, retry and terminal state over silence in the rendered line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
    const run = {
      ...FINISHED_RUN,
      runState: "pending" as const,
      durationMs: null,
      status: { type: "retry" },
      questions: [{ id: "question" }],
      diff: undefined,
    };
    const view = render(<ArenaRunMeta run={run} side="a" active />);
    const label = () => view.getByTestId("arena-run-meta-a").textContent;
    expect(label()).toBe("Waiting for your answer·");
    view.rerender(<ArenaRunMeta run={{ ...run, questions: [] }} side="a" active />);
    expect(label()).toBe("Retrying·");
    view.rerender(
      <ArenaRunMeta run={{ ...run, runState: "error", durationMs: 1000 }} side="a" active />,
    );
    expect(label()).toContain("Failed");
    expect(label()).not.toMatch(/Retrying|Waiting|No recent/);
  });

  it("refreshes the clock and activity when a retained chat becomes active again", () => {
    vi.useFakeTimers();
    const start = new Date("2026-09-25T10:00:00Z");
    vi.setSystemTime(start);
    const run = {
      ...FINISHED_RUN,
      runState: "pending" as const,
      durationMs: null,
      startedAt: start.toISOString(),
      lastEventAt: start.toISOString(),
      diff: undefined,
    };
    const view = render(<ArenaRunMeta run={run} side="a" active />);
    view.rerender(<ArenaRunMeta run={run} side="a" active={false} />);
    act(() => vi.advanceTimersByTime(120_000));
    view.rerender(<ArenaRunMeta run={run} side="a" active />);
    expect(view.getByTestId("arena-run-meta-a").textContent).toBe("No recent activity·");
    view.rerender(
      <ArenaRunMeta run={{ ...run, lastEventAt: new Date().toISOString() }} side="a" active />,
    );
    expect(view.getByTestId("arena-run-meta-a").textContent).toBe("Working·");
  });

  /* oxlint-enable react-perf/jsx-no-new-object-as-prop */

  it("opens the run's changes from its diff stats", () => {
    const onOpenChanges = vi.fn();
    const view = render(
      <ArenaRunMeta run={FINISHED_RUN} side="a" active onOpenChanges={onOpenChanges} />,
    );

    const stat = view.getByTestId("arena-run-diff-open-a");
    expect(stat.textContent).toContain("9 files");
    fireEvent.click(stat);
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it("still reports the size of a change nothing can open", () => {
    const view = render(<ArenaRunMeta run={FINISHED_RUN} side="b" active />);

    expect(view.queryByTestId("arena-run-diff-open-b")).toBeNull();
    expect(view.getByTestId("arena-run-meta-b").textContent).toContain("9 files");
  });

  it("leaves a run with no changes alone", () => {
    const view = render(
      <ArenaRunMeta run={UNCHANGED_RUN} side="a" active onOpenChanges={vi.fn()} />,
    );

    expect(view.queryByTestId("arena-run-diff-open-a")).toBeNull();
    expect(view.getByTestId("arena-run-diff-a").textContent).toBe("No changes");
  });
});
