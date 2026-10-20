/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "react-native";
import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("./battle-summary", () => ({
  IdenticalBattleResult: () => <Text>Results are identical</Text>,
}));

vi.mock("@/components/ui/tooltip", async () => {
  const { Pressable } = await import("react-native");
  return {
    Tooltip: ({ children }: { children: React.ReactElement }) => children,
    TooltipTrigger: (props: React.ComponentProps<typeof Pressable>) => <Pressable {...props} />,
    TooltipContent: () => null,
  };
});

// The menu engine needs native modules jsdom cannot host. The stand-in lays its items out as
// plain buttons, always open, so a case can press one by its test id.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect,
    selected,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    selected?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} aria-checked={selected} onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("./file-diff-query", async () =>
  (await import("./review-fixtures.test-helpers")).fileDiffQueryStandIn(),
);

// What the daemon would send: the chat's current battle and the battle's file list.
const served = vi.hoisted(() => ({
  turn: { id: "turn-1", state: "awaiting_vote", canResumeBattle: false } as Record<string, unknown>,
  runs: {} as Record<"a" | "b", { runState: string; finalCommit?: string }>,
  diff: undefined as ArenaComparisonDiff | undefined,
  // The results the panel last asked to read the changes again for.
  refetchResults: [] as string[],
}));
vi.mock("./use-arena-session", () => ({
  useArenaSessionQuery: () => ({
    data: {
      turn: served.turn,
      runs: [
        { side: "a", ...served.runs.a },
        { side: "b", ...served.runs.b },
      ],
    },
  }),
}));
vi.mock("./battle-diff-query", () => ({
  useBattleDiff: () => ({
    data: served.diff,
    error: null,
    isFetching: false,
    refetch: async () => undefined,
  }),
  useRefetchBattleDiffOnResult: (
    _server: string,
    _agent: string,
    _turn: string,
    results: string,
  ) => {
    if (served.refetchResults.at(-1) !== results) served.refetchResults.push(results);
  },
}));

vi.mock("./battle-changes-store", async () => {
  const { create } = await import("zustand");
  return {
    useBattleChangesStore: create<{
      turnByChat: Record<string, string>;
      sideByChat: Record<string, "a" | "b">;
      wrapLines: boolean;
      showFileList: boolean;
      show: (agentId: string, turnId: string) => void;
      setSide: (agentId: string, side: "a" | "b") => void;
      setWrapLines: (wrap: boolean) => void;
      setShowFileList: (show: boolean) => void;
    }>((set) => ({
      turnByChat: {},
      sideByChat: {},
      wrapLines: true,
      showFileList: false,
      show: (agentId, turnId) => set({ turnByChat: { [agentId]: turnId } }),
      setSide: (agentId, side) => set({ sideByChat: { [agentId]: side } }),
      setWrapLines: (wrapLines) => set({ wrapLines }),
      setShowFileList: (showFileList) => set({ showFileList }),
    })),
  };
});

// Closing the panel acts on the workspace layout; its own test covers it.
vi.mock("./use-battle-changes-lifecycle", () => ({ useCloseBattleChangesWhenDecided: () => {} }));

import { BattleChangesPanel } from "./battle-changes-panel";
import { useBattleChangesStore } from "./battle-changes-store";
import { useArenaReviewStore } from "./review-state";
import { comparisonDiff, shortConflict, threeWayFile } from "./review-fixtures.test-helpers";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  served.turn = { id: "turn-1", state: "awaiting_vote", canResumeBattle: false };
  served.runs = {
    a: { runState: "complete", finalCommit: "commit-a" },
    b: { runState: "complete", finalCommit: "commit-b" },
  };
  served.diff = undefined;
  served.refetchResults = [];
  useArenaReviewStore.setState({ byTurn: {} });
  useBattleChangesStore.setState({
    turnByChat: {},
    sideByChat: {},
    wrapLines: true,
    showFileList: false,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function manyFiles(count: number) {
  const files = Array.from({ length: count }, (_, index) => `src/f${index}.py`);
  return comparisonDiff({
    files: files.map((file) => threeWayFile({ file, base: "x = 1\n", a: "x = 2\n", b: "x = 3\n" })),
    divergence: files.map((file) => ({ file, status: "diverging" as const })),
  });
}

function render(diff: ArenaComparisonDiff | undefined = shortConflict()) {
  served.diff = diff;
  act(() => {
    root.render(
      <BattleChangesPanel serverId="server-1" workspaceId="workspace-1" agentId="agent-1" />,
    );
  });
}

describe("BattleChangesPanel", () => {
  it("shows every file's diff under its own heading, in one scroll", () => {
    render(manyFiles(3));
    const scroll = byTestId("arena-battle-changes-scroll") as HTMLElement;
    const headings = scroll.querySelectorAll('[data-testid^="arena-battle-changes-heading-"]');
    expect(headings).toHaveLength(3);
    expect(scroll.querySelectorAll('[data-testid="arena-inline-diff"]')).toHaveLength(3);
    expect(byTestId("arena-battle-changes-toolbar")?.textContent).toContain("3 files");
  });

  it("folds a file's diff from its heading and opens it again", () => {
    render(manyFiles(2));
    const heading = () => byTestId("arena-battle-changes-heading-src/f0.py") as HTMLElement;
    const diffs = () => container.querySelectorAll('[data-testid="arena-inline-diff"]');
    expect(heading().getAttribute("aria-label")).toBe("Hide the diff of src/f0.py");
    act(() => fireEvent.click(heading()));
    expect(diffs()).toHaveLength(1);
    expect(heading().getAttribute("aria-label")).toBe("Show the diff of src/f0.py");
    act(() => fireEvent.click(heading()));
    expect(diffs()).toHaveLength(2);
  });

  it("waits for an agent to finish before showing a live battle's changes", () => {
    served.turn = { id: "turn-1", state: "running", canResumeBattle: false };
    served.runs = { a: { runState: "pending" }, b: { runState: "pending" } };
    render();
    expect(byTestId("arena-battle-changes-scroll")).toBeNull();
    expect(byTestId("arena-battle-changes-note")?.textContent).toContain("once it finishes");
  });

  it("shows the agent that finished while the other still works, opening on it", () => {
    served.turn = { id: "turn-1", state: "running", canResumeBattle: false };
    served.runs = {
      a: { runState: "pending" },
      b: { runState: "complete", finalCommit: "commit-b" },
    };
    // The engine reads A, still working, as the original: every file is B's alone.
    const onlyB = threeWayFile({ file: "b.py", base: "x = 1\n", a: "x = 1\n", b: "x = 3\n" });
    render(
      comparisonDiff({
        files: [{ ...onlyB, additionsA: 0, deletionsA: 0 }],
        divergence: [{ file: "b.py", status: "only_b" as const }],
      }),
    );
    const files = () =>
      Array.from(container.querySelectorAll("[data-battle-file]")).map((section) =>
        section.getAttribute("data-battle-file"),
      );
    expect(files()).toEqual(["b.py"]);
    // The review has not started, so nothing is credited as read.
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownFile).toBeUndefined();
    act(() => fireEvent.click(byTestId("arena-battle-changes-side-a") as HTMLElement));
    expect(files()).toEqual([]);
    expect(byTestId("arena-battle-changes-working")?.textContent).toBe(
      "Agent A is still working. Its changes show here once it finishes.",
    );
    expect(container.textContent).not.toContain("Results are identical");
  });

  it("reads the changes again when the other agent's result lands", () => {
    served.turn = { id: "turn-1", state: "running", canResumeBattle: false };
    served.runs = {
      a: { runState: "complete", finalCommit: "commit-a" },
      b: { runState: "pending" },
    };
    render();
    served.turn = { id: "turn-1", state: "awaiting_vote", canResumeBattle: false };
    served.runs = {
      a: { runState: "complete", finalCommit: "commit-a" },
      b: { runState: "complete", finalCommit: "commit-b" },
    };
    render();
    expect(served.refetchResults).toEqual(["commit-a:", "commit-a:commit-b"]);
    expect(byTestId("arena-battle-changes-working")).toBeNull();
  });

  it("marks its scroller and files for review telemetry", () => {
    render(manyFiles(2));
    const scroll = byTestId("arena-battle-changes-scroll") as HTMLElement;
    expect(scroll.closest("[data-review-turn]")?.getAttribute("data-review-turn")).toBe("turn-1");
    const files = Array.from(scroll.querySelectorAll("[data-battle-file]")).map((section) =>
      section.getAttribute("data-battle-file"),
    );
    expect(files).toEqual(["src/f0.py", "src/f1.py"]);
  });

  it("records the file at the top as read when the changes arrive", () => {
    render(manyFiles(2));
    const state = useArenaReviewStore.getState().byTurn["turn-1"];
    expect(state?.shownFile).toBe("src/f0.py");
    expect(state?.shownIndex).toBe(0);
  });

  it("says when it shows an earlier battle, and goes to the latest", () => {
    useBattleChangesStore.setState({ turnByChat: { "agent-1": "turn-0" } });
    render();
    expect(container.textContent).toContain("Showing an earlier battle");
    act(() => fireEvent.click(byTestId("arena-battle-changes-latest") as HTMLElement));
    expect(useBattleChangesStore.getState().turnByChat["agent-1"]).toBe("turn-1");
    expect(container.textContent).not.toContain("Showing an earlier battle");
  });

  it("shows one agent's changes at a time, A first", () => {
    render();
    const code = () =>
      Array.from(container.querySelectorAll('[data-testid^="arena-diff-region-"]'))
        .map((region) => region.textContent)
        .join("\n");
    expect(code()).toContain("y = 20");
    expect(code()).not.toContain("y = 200");
    act(() => fireEvent.click(byTestId("arena-battle-changes-side-b") as HTMLElement));
    expect(code()).toContain("y = 200");
    expect(useBattleChangesStore.getState().sideByChat["agent-1"]).toBe("b");
  });

  it("lists only the files the shown agent changed", () => {
    // B alone changed b.py, so A's view leaves it out and B's view has it.
    const onlyB = {
      ...threeWayFile({ file: "b.py", base: "x = 1\n", a: "x = 1\n", b: "x = 3\n" }),
    };
    const diff = comparisonDiff({
      files: [
        threeWayFile({ file: "both.py", base: "x = 1\n", a: "x = 2\n", b: "x = 3\n" }),
        { ...onlyB, additionsA: 0, deletionsA: 0 },
      ],
      divergence: [
        { file: "both.py", status: "diverging" as const },
        { file: "b.py", status: "compatible" as const },
      ],
    });
    render(diff);
    const files = () =>
      Array.from(container.querySelectorAll("[data-battle-file]")).map((section) =>
        section.getAttribute("data-battle-file"),
      );
    expect(files()).toEqual(["both.py"]);
    expect(byTestId("arena-battle-changes-toolbar")?.textContent).toContain("1 file");
    act(() => fireEvent.click(byTestId("arena-battle-changes-side-b") as HTMLElement));
    expect(files()).toEqual(["both.py", "b.py"]);
  });

  it("shows nothing of the other agent in a file's heading or rows", () => {
    // Both set x to 2; only B touched z, three lines.
    const file = threeWayFile({
      file: "src/shared.py",
      base: "x = 1\ny = 1\n",
      a: "x = 2\ny = 2\n",
      b: "x = 2\ny = 3\nz = 1\nz = 2\nz = 3\n",
    });
    render(
      comparisonDiff({
        files: [file],
        divergence: [{ file: "src/shared.py", status: "diverging" as const }],
      }),
    );
    const heading = byTestId("arena-battle-changes-heading-src/shared.py") as HTMLElement;
    expect(heading.textContent).toBe(`shared.py  src+${file.additionsA}-${file.deletionsA}`);
    expect(container.textContent).not.toContain("Both");
    expect(container.textContent).not.toContain("diverging");
  });

  it("says so when the shown agent changed no files", () => {
    const onlyB = threeWayFile({ file: "b.py", base: "x = 1\n", a: "x = 1\n", b: "x = 3\n" });
    const diff = comparisonDiff({
      files: [{ ...onlyB, additionsA: 0, deletionsA: 0 }],
      divergence: [{ file: "b.py", status: "compatible" as const }],
    });
    render(diff);
    expect(byTestId("arena-battle-changes-side-empty")?.textContent).toContain(
      "Agent A changed no files.",
    );
  });

  it("collapses every file from the menu and expands them again", () => {
    render(manyFiles(3));
    const diffs = () => container.querySelectorAll('[data-testid="arena-inline-diff"]');
    act(() => fireEvent.click(byTestId("arena-battle-changes-menu-collapse") as HTMLElement));
    expect(diffs()).toHaveLength(0);
    act(() => fireEvent.click(byTestId("arena-battle-changes-menu-expand") as HTMLElement));
    expect(diffs()).toHaveLength(3);
  });

  it("shows a file list that opens the file it names", () => {
    render(manyFiles(3));
    expect(byTestId("arena-battle-changes-file-list")).toBeNull();
    act(() => fireEvent.click(byTestId("arena-battle-changes-menu-files") as HTMLElement));
    expect(byTestId("arena-battle-changes-file-list")).not.toBeNull();
    act(() => fireEvent.click(byTestId("arena-battle-changes-menu-collapse") as HTMLElement));
    act(() => fireEvent.click(byTestId("arena-battle-changes-file-link-src/f1.py") as HTMLElement));
    const open = Array.from(container.querySelectorAll("[data-battle-file]")).filter((section) =>
      section.querySelector('[data-testid="arena-inline-diff"]'),
    );
    expect(open.map((section) => section.getAttribute("data-battle-file"))).toEqual(["src/f1.py"]);
  });

  it("wraps long lines by default and keeps them on one row when wrapping is off", () => {
    render();
    const wrapped = () =>
      container.querySelectorAll('[data-testid="arena-inline-diff"] [data-row-key]');
    const wrappedRows = wrapped().length;
    expect(wrappedRows).toBeGreaterThan(0);
    expect(byTestId("arena-battle-changes-menu-wrap")?.getAttribute("aria-checked")).toBe("true");
    act(() => fireEvent.click(byTestId("arena-battle-changes-menu-wrap") as HTMLElement));
    expect(useBattleChangesStore.getState().wrapLines).toBe(false);
    expect(byTestId("arena-battle-changes-menu-wrap")?.getAttribute("aria-checked")).toBe("false");
    // Unwrapped, each line still has one row holding its code.
    expect(wrapped()).toHaveLength(wrappedRows);
  });
});
