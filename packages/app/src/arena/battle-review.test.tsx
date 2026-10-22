/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "react-native";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <Text>{text}</Text>,
}));

// The summary card animates with reanimated, which jsdom cannot host; the
// review only borrows two static pieces of it.
vi.mock("./battle-summary", () => ({
  IdenticalBattleResult: () => <Text>Results are identical</Text>,
  SummaryOmissionNotice: () => null,
}));

// The tooltip animates with reanimated too. Its trigger is the button itself, so the
// stand-in keeps that button and drops the hover label.
vi.mock("@/components/ui/tooltip", async () => {
  const { Pressable } = await import("react-native");
  return {
    Tooltip: ({ children }: { children: React.ReactElement }) => children,
    TooltipTrigger: (props: React.ComponentProps<typeof Pressable>) => <Pressable {...props} />,
    TooltipContent: () => null,
  };
});

import { BattleReview } from "./battle-review";
import { useArenaReviewStore } from "./review-state";
import { useArenaDiffLayoutStore } from "./diff-layout";
import { verdictFolds } from "./verdict-body";
import { arenaChangesRows } from "./changes-rows";
import { comparisonDiff, shortConflict, threeWayFile } from "./review-fixtures.test-helpers";

const NOOP = () => {};
const COMPARISON = { state: "completed", output: "The judge's report" } as never;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The tab and the verdict fold live in a shared store now, so a case that
  // switches tabs would otherwise decide where the next one opens.
  useArenaReviewStore.setState({ byTurn: {} });
  // The layout choice is per chat, so a case that picks one would set the next case's.
  useArenaDiffLayoutStore.setState({ layoutByChat: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

// jsdom has no ResizeObserver, so react-native-web never measures; the
// handler it stores on the node stands in for the layout event.
function layoutProse(height: number) {
  const prose = byTestId("arena-verdict-prose") as HTMLElement & {
    __reactLayoutHandler?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  };
  act(() => {
    prose.__reactLayoutHandler?.({ nativeEvent: { layout: { height } } });
  });
}

/**
 * A battle where both sides changed `count` files, all diverging, or only the one at
 * `firstDiverging` when it is given, which is then the file Changes opens on.
 */
function manyFiles(count: number, firstDiverging?: number) {
  const files = Array.from({ length: count }, (_, index) => `src/f${index}.py`);
  return comparisonDiff({
    files: files.map((file) => threeWayFile({ file, base: "x = 1\n", a: "x = 2\n", b: "x = 3\n" })),
    divergence: files.map((file, index) => ({
      file,
      status:
        firstDiverging === undefined || index >= firstDiverging
          ? ("diverging" as const)
          : ("identical" as const),
    })),
  });
}

function render(input: {
  summaryAvailable: boolean;
  waitingFor?: "a" | "b";
  onOpenInPanel?: (file: string | null) => void;
  diff?: ReturnType<typeof shortConflict>;
}) {
  const diff = input.diff ?? shortConflict();
  act(() => {
    root.render(
      <BattleReview
        agentId="agent-1"
        turnId="turn-1"
        summaryAvailable={input.summaryAvailable}
        summaryPending={false}
        summaryFailed={false}
        waitingFor={input.waitingFor ?? null}
        comparison={COMPARISON}
        retrying={false}
        onRetry={NOOP}
        onRetryDiff={NOOP}
        retryingDiff={false}
        diff={diff}
        diffError={null}
        rows={arenaChangesRows(diff)}
      />,
    );
  });
}

describe("BattleReview", () => {
  it("opens the summary when it is on its way, unless the reader chose Changes", () => {
    render({ summaryAvailable: false, waitingFor: "b" });
    expect(byTestId("arena-summary-waiting")).not.toBeNull();
    render({ summaryAvailable: true });
    expect(container.textContent).toContain("The judge's report");
    expect(byTestId("arena-inline-diff")).toBeNull();

    useArenaReviewStore.setState({ byTurn: {} });
    render({ summaryAvailable: false, waitingFor: "b" });
    act(() => fireEvent.click(byTestId("arena-review-tab-changes") as HTMLElement));
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    render({ summaryAvailable: true });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(container.textContent).not.toContain("The judge's report");
  });

  it("reviews the first result while the other side still works", () => {
    render({ summaryAvailable: false, waitingFor: "b" });
    expect(byTestId("arena-review-tabs")).not.toBeNull();
    // The summary tab opens first and says who is still at it.
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBe("verdict");
    expect(byTestId("arena-summary-waiting")?.textContent).toBe(
      "Agent B is still working. The difference summary compares both results once it finishes.",
    );

    act(() => fireEvent.click(byTestId("arena-review-tab-changes") as HTMLElement));
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBe("changes");
    // A's counts beside B's "working"; no verdict on a pair that is not in yet.
    const row = byTestId("arena-changes-row-main.py");
    expect(row?.textContent).toContain("working");
    expect(row?.textContent).not.toContain("unchanged");
    expect(container.textContent).not.toContain("diverging");
    expect(byTestId("arena-diff-layout")).not.toBeNull();
    // jsdom measures no width, so the card opens in one column: B's slot is one line per region.
    expect(byTestId("arena-diff-pending-b")?.textContent).toBe(
      "Agent Bis still working · its version of this region appears here",
    );
    // Side by side, B's column is one placeholder beside A's diff; only A expands.
    act(() => fireEvent.click(byTestId("arena-diff-layout-split") as HTMLElement));
    expect(byTestId("arena-diff-pending-b")?.textContent).toBe(
      "Agent B is still workingIts version of this file appears here when it finishes.",
    );
    expect(container.textContent).toContain("y = 20");
    expect(container.textContent).not.toContain("y = 200");
    expect(container.querySelector('[aria-label="Expand Agent A"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand Agent B"]')).toBeNull();
  });

  it("says so when the finished side changed nothing", () => {
    render({
      summaryAvailable: false,
      waitingFor: "a",
      diff: comparisonDiff({ treesEqual: true, files: [], divergence: [] }),
    });
    act(() => fireEvent.click(byTestId("arena-review-tab-changes") as HTMLElement));
    expect(byTestId("arena-changes-none")?.textContent).toBe(
      "Agent B made no changes · Agent A is still working",
    );
    expect(container.textContent).not.toContain("Results are identical");
  });

  it("shows a short verdict whole, with nothing to unfold", () => {
    render({ summaryAvailable: true });
    expect(byTestId("arena-verdict-body")).not.toBeNull();
    expect(container.textContent).toContain("The judge's report");
    layoutProse(200);
    expect(byTestId("arena-verdict-more")).toBeNull();
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.verdictFolded).toBeUndefined();
  });

  it("folds a long verdict to its opening until the reader asks for the rest", () => {
    render({ summaryAvailable: true });
    expect(byTestId("arena-verdict-more")).toBeNull();
    // A verdict that never folded records no offer, so leaving it unexpanded is
    // distinguishable from there being nothing to expand.
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.verdictFolded).toBeUndefined();
    layoutProse(900);
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.verdictFolded).toBe(true);
    expect(byTestId("arena-verdict-more")).not.toBeNull();
    act(() => {
      fireEvent.click(byTestId("arena-verdict-more") as HTMLElement);
    });
    expect(byTestId("arena-verdict-more")).toBeNull();
    expect(container.textContent).toContain("The judge's report");
  });

  it("folds only above the height a short report stays under", () => {
    expect(verdictFolds(null)).toBe(false);
    expect(verdictFolds(0)).toBe(false);
    expect(verdictFolds(480)).toBe(false);
    expect(verdictFolds(481)).toBe(true);
  });

  it("opens on Verdict when it is already available", () => {
    render({ summaryAvailable: true });
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBe("verdict");
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.tab).toBeUndefined();
  });

  it("opens on the changes when there is no verdict to land on", () => {
    render({ summaryAvailable: false });
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBe("changes");
  });

  it("records the file it opens on, not only the ones the reader clicks", () => {
    // The card auto-selects a file when Changes opens. That file is on screen
    // and read, so telemetry has to see it; counting only clicks loses the
    // first file of every review.
    render({ summaryAvailable: true });
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownFile).toBeUndefined();

    act(() => {
      fireEvent.click(byTestId("arena-review-tab-changes") as HTMLElement);
    });
    const opened = useArenaReviewStore.getState().byTurn["turn-1"];
    expect(opened?.shownFile).toBe("main.py");
    expect(opened?.shownIndex).toBe(0);
    // Nothing was clicked, so the reader has still chosen no file of their own.
    expect(opened?.files).toBeUndefined();
  });

  it("closes the open diff from its row and opens it again", () => {
    render({ summaryAvailable: false });
    const row = () => byTestId("arena-changes-row-main.py") as HTMLElement;
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(row().getAttribute("aria-label")).toBe("Hide the diff of main.py");

    act(() => fireEvent.click(row()));
    expect(byTestId("arena-inline-diff")).toBeNull();
    expect(row().getAttribute("aria-label")).toBe("Show the diff of main.py");
    // Closed is the reader's choice, so the default file does not reopen on its own.
    render({ summaryAvailable: false });
    expect(byTestId("arena-inline-diff")).toBeNull();

    act(() => fireEvent.click(row()));
    expect(byTestId("arena-inline-diff")).not.toBeNull();
  });

  it("marks its diffs as this battle's, so review telemetry can tell them from another's", () => {
    render({ summaryAvailable: false });
    const viewer = byTestId("arena-inline-diff") as HTMLElement;
    expect(viewer.closest("[data-review-turn]")?.getAttribute("data-review-turn")).toBe("turn-1");
  });

  it("keeps several diffs open at once, each under its own row", () => {
    render({ summaryAvailable: false, diff: manyFiles(3) });
    const row = (file: string) => byTestId(`arena-changes-row-${file}`) as HTMLElement;
    act(() => fireEvent.click(row("src/f2.py")));
    expect(byTestId("arena-changes-diff-src/f0.py")).not.toBeNull();
    expect(byTestId("arena-changes-diff-src/f1.py")).toBeNull();
    expect(byTestId("arena-changes-diff-src/f2.py")).not.toBeNull();
    // The diff sits between its own row and the next one, not under the list.
    const band = byTestId("arena-changes-diff-src/f0.py") as HTMLElement;
    expect(band.previousElementSibling?.contains(row("src/f0.py"))).toBe(true);
    expect(band.nextElementSibling?.contains(row("src/f1.py"))).toBe(true);
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.files).toEqual([
      "src/f0.py",
      "src/f2.py",
    ]);
  });

  it("records each file the reader opens, and nothing when one closes", () => {
    render({ summaryAvailable: false, diff: manyFiles(3) });
    const row = (file: string) => byTestId(`arena-changes-row-${file}`) as HTMLElement;
    const shown = () => useArenaReviewStore.getState().byTurn["turn-1"];
    expect(shown()?.shownFile).toBe("src/f0.py");
    act(() => fireEvent.click(row("src/f1.py")));
    expect(shown()?.shownFile).toBe("src/f1.py");
    expect(shown()?.shownIndex).toBe(1);
    // Closing the newest diff leaves the earlier one open but is not a new read of it.
    act(() => fireEvent.click(row("src/f1.py")));
    expect(shown()?.shownFile).toBe("src/f1.py");
    // Opening the same file again is a new opening, though the shown file does not change.
    const opens = shown()?.fileOpens;
    act(() => fireEvent.click(row("src/f1.py")));
    expect(shown()?.shownFile).toBe("src/f1.py");
    expect(shown()?.fileOpens).toBe((opens ?? 0) + 1);
  });

  it("shows eight rows and keeps the rest behind Show more, never hiding an open one", () => {
    render({ summaryAvailable: false, diff: manyFiles(12) });
    const rows = () => container.querySelectorAll('[data-testid^="arena-changes-row-"]');
    const more = () => byTestId("arena-changes-more") as HTMLElement;
    expect(rows()).toHaveLength(8);
    expect(more().textContent).toContain("Show 4 more files");

    act(() => fireEvent.click(more()));
    expect(rows()).toHaveLength(12);
    act(() => fireEvent.click(byTestId("arena-changes-row-src/f11.py") as HTMLElement));
    act(() => fireEvent.click(more()));
    // f11 is open, so it stays after the first eight on its own.
    expect(rows()).toHaveLength(9);
    expect(byTestId("arena-changes-diff-src/f11.py")).not.toBeNull();
    expect(more().textContent).toContain("Show 3 more files");
  });

  it("opens on a diverging file deep in the list without showing every row above it", () => {
    render({ summaryAvailable: false, diff: manyFiles(30, 20) });
    const rows = () =>
      Array.from(container.querySelectorAll('[data-testid^="arena-changes-row-"]')).map((row) =>
        row.getAttribute("data-testid"),
      );
    expect(rows()).toHaveLength(9);
    expect(rows()[8]).toBe("arena-changes-row-src/f20.py");
    expect(byTestId("arena-changes-diff-src/f20.py")).not.toBeNull();
    expect((byTestId("arena-changes-more") as HTMLElement).textContent).toContain(
      "Show 21 more files",
    );

    // Closing it leaves the row where it was, under the pointer that pressed it.
    act(() => fireEvent.click(byTestId("arena-changes-row-src/f20.py") as HTMLElement));
    expect(byTestId("arena-changes-diff-src/f20.py")).toBeNull();
    expect(rows()).toHaveLength(9);
    expect(rows()[8]).toBe("arena-changes-row-src/f20.py");
  });

  it("folds the whole section away and opens it again from a tab", () => {
    render({ summaryAvailable: true });
    const collapse = () => byTestId("arena-review-collapse") as HTMLElement;
    expect(collapse().getAttribute("aria-label")).toBe("Hide the difference summary and changes");
    act(() => fireEvent.click(collapse()));
    expect(container.textContent).not.toContain("The judge's report");
    expect(byTestId("arena-review-tabs")).not.toBeNull();
    expect(collapse().getAttribute("aria-label")).toBe("Show the difference summary and changes");

    act(() => fireEvent.click(byTestId("arena-review-tab-changes") as HTMLElement));
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.collapsed).toBe(false);
  });

  it("records nothing as shown while the section is folded", () => {
    useArenaReviewStore.setState({ byTurn: { "turn-1": { collapsed: true } } });
    render({ summaryAvailable: false });
    expect(byTestId("arena-inline-diff")).toBeNull();
    const state = useArenaReviewStore.getState().byTurn["turn-1"];
    expect(state?.shownFile).toBeUndefined();
    expect(state?.shownTab).toBeUndefined();
  });

  it("shows the changes alone when there is no verdict to read", () => {
    render({ summaryAvailable: false });
    expect(byTestId("arena-review-tabs")).toBeNull();
    expect(byTestId("arena-inline-diff")).not.toBeNull();
  });

  it("lets the reader switch the diff between A beside B and one column", () => {
    render({ summaryAvailable: false });
    // jsdom measures no width, so the card opens in one column.
    expect(byTestId("arena-diff-layout")).not.toBeNull();
    const region = () => container.querySelector('[data-testid^="arena-diff-region-"]');
    expect(region()?.textContent).toContain("Agent A");
    expect(region()?.textContent).toContain("Agent B");
    act(() => {
      fireEvent.click(byTestId("arena-diff-layout-split") as HTMLElement);
    });
    expect(region()?.textContent).not.toContain("Agent A");
    expect(container.textContent).toContain("y = 20");
    expect(container.textContent).toContain("y = 200");
    act(() => {
      fireEvent.click(byTestId("arena-diff-layout-single") as HTMLElement);
    });
    expect(region()?.textContent).toContain("Agent A");
    expect(region()?.textContent).toContain("Agent B");
  });
});
