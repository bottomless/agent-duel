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
import { verdictFolds } from "./verdict-body";
import { arenaChangesRows } from "./changes-rows";
import { shortConflict } from "./review-fixtures.test-helpers";

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

function render(input: {
  summaryAvailable: boolean;
  onOpenInPanel?: (file: string | null) => void;
}) {
  const diff = shortConflict();
  act(() => {
    root.render(
      <BattleReview
        agentId="agent-1"
        turnId="turn-1"
        summaryAvailable={input.summaryAvailable}
        summaryPending={false}
        summaryFailed={false}
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
  it("keeps Changes open when the verdict arrives, until the reader switches", () => {
    render({ summaryAvailable: false });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    render({ summaryAvailable: true });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(container.textContent).not.toContain("The judge's report");
    act(() => fireEvent.click(byTestId("arena-review-tab-verdict") as HTMLElement));
    expect(container.textContent).toContain("The judge's report");
    expect(byTestId("arena-inline-diff")).toBeNull();
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
    expect(opened?.file).toBeUndefined();
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

  it("closes the diff from its pinned header", () => {
    render({ summaryAvailable: false });
    act(() => fireEvent.click(byTestId("arena-diff-close") as HTMLElement));
    expect(byTestId("arena-inline-diff")).toBeNull();
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.file).toBeNull();
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
