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
  IdenticalBattleResult: ({ hasChanges }: { hasChanges?: boolean }) => (
    <Text>{hasChanges ? "Both agents made the same changes" : "Results are identical"}</Text>
  ),
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

vi.mock("./file-diff-query", async () =>
  (await import("./review-fixtures.test-helpers")).fileDiffQueryStandIn(),
);

// The panel lives in the workspace layout, which this card only asks to open.
const { openBattleChanges } = vi.hoisted(() => ({ openBattleChanges: vi.fn() }));
vi.mock("./battle-changes-store", () => ({ openBattleChanges }));

import { BattleReview } from "./battle-review";
import { useArenaReviewStore } from "./review-state";
import { verdictFolds } from "./verdict-body";
import { arenaChangesRows } from "./changes-rows";
import {
  comparisonDiff,
  sameResult,
  shortConflict,
  threeWayFile,
} from "./review-fixtures.test-helpers";
import type { ArenaComparisonDiff } from "@getpaseo/protocol/arena/rpc-schemas";

const NOOP = () => {};
const COMPARISON = { state: "completed", output: "The judge's report" } as never;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useArenaReviewStore.setState({ byTurn: {} });
  openBattleChanges.mockClear();
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

function manyFiles(count: number) {
  const files = Array.from({ length: count }, (_, index) => `src/f${index}.py`);
  return comparisonDiff({
    files: files.map((file) => threeWayFile({ file, base: "x = 1\n", a: "x = 2\n", b: "x = 3\n" })),
    divergence: files.map((file) => ({ file, status: "diverging" as const })),
  });
}

function render(input: {
  summaryAvailable: boolean;
  diff?: ArenaComparisonDiff;
  diffError?: Error | null;
}) {
  const diff = input.diff ?? shortConflict();
  act(() => {
    root.render(
      <BattleReview
        serverId="server-1"
        workspaceId="workspace-1"
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
        diff={input.diffError ? undefined : diff}
        diffError={input.diffError ?? null}
        rows={input.diffError ? [] : arenaChangesRows(diff)}
      />,
    );
  });
}

describe("BattleReview", () => {
  it("shows the summary with the way to the files, and no file list", () => {
    render({ summaryAvailable: true, diff: manyFiles(13) });
    expect(container.textContent).toContain("The judge's report");
    expect(byTestId("arena-review-open-panel")?.textContent).toContain("Changes (13)");
    expect(container.querySelector('[data-testid^="arena-changes-row-"]')).toBeNull();
    expect(byTestId("arena-inline-diff")).toBeNull();
  });

  it("opens the side panel on this battle", () => {
    render({ summaryAvailable: true });
    act(() => fireEvent.click(byTestId("arena-review-open-panel") as HTMLElement));
    expect(openBattleChanges).toHaveBeenCalledWith({
      serverId: "server-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      turnId: "turn-1",
    });
  });

  it("shows a short verdict whole, with nothing to unfold", () => {
    render({ summaryAvailable: true });
    expect(byTestId("arena-verdict-body")).not.toBeNull();
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

  it("records the summary as shown while it is on screen", () => {
    render({ summaryAvailable: true });
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBe("verdict");
  });

  it("folds the summary away and opens it again", () => {
    render({ summaryAvailable: true });
    const collapse = () => byTestId("arena-review-collapse") as HTMLElement;
    expect(collapse().getAttribute("aria-label")).toBe("Hide the difference summary");
    act(() => fireEvent.click(collapse()));
    expect(container.textContent).not.toContain("The judge's report");
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.collapsed).toBe(true);
    // The way to the files stays on the folded heading.
    expect(byTestId("arena-review-open-panel")).not.toBeNull();
    act(() => fireEvent.click(collapse()));
    expect(container.textContent).toContain("The judge's report");
  });

  it("records nothing as shown while the summary is folded", () => {
    useArenaReviewStore.setState({ byTurn: { "turn-1": { collapsed: true } } });
    render({ summaryAvailable: true });
    expect(useArenaReviewStore.getState().byTurn["turn-1"]?.shownTab).toBeUndefined();
  });

  it("offers only the files when there is no summary", () => {
    render({ summaryAvailable: false, diff: manyFiles(3) });
    expect(byTestId("arena-review-header")?.textContent).toContain("Changes");
    expect(byTestId("arena-review-open-panel")?.textContent).toContain("Changes (3)");
    expect(byTestId("arena-review-collapse")).toBeNull();
  });

  it("says when both agents left the same files", () => {
    render({ summaryAvailable: false, diff: { ...sameResult(), treesEqual: true } });
    expect(container.textContent).toContain("Both agents made the same changes");
  });

  it("offers a retry when the file list fails to load", () => {
    render({ summaryAvailable: true, diffError: new Error("Diff read failed") });
    expect(container.textContent).toContain("Diff read failed");
    expect(container.textContent).toContain("Retry changes");
    expect(byTestId("arena-review-open-panel")).toBeNull();
  });

  it("marks the review as this battle's, so review telemetry can tell it from another's", () => {
    render({ summaryAvailable: true });
    const review = byTestId("arena-battle-comparison") as HTMLElement;
    expect(review.getAttribute("data-review-turn")).toBe("turn-1");
  });
});
