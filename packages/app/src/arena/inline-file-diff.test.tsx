/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// The tooltip animates with reanimated, which jsdom cannot host. Its trigger is the button
// itself, so the stand-in keeps that button and drops the hover label.
vi.mock("@/components/ui/tooltip", async () => {
  const { Pressable } = await import("react-native");
  return {
    Tooltip: ({ children }: { children: React.ReactElement }) => children,
    TooltipTrigger: (props: React.ComponentProps<typeof Pressable>) => <Pressable {...props} />,
    TooltipContent: () => null,
  };
});

import { InlineFileDiff, openChangesFile } from "./inline-file-diff";
import { arenaChangesRows } from "./changes-rows";
import {
  rewrite,
  sameResult,
  sameResultPastBudget,
  shortConflict,
} from "./review-fixtures.test-helpers";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("InlineFileDiff", () => {
  it("shows the original line alongside both independently changed results", () => {
    act(() => {
      root.render(<InlineFileDiff diff={shortConflict()} file="main.py" layout="split" />);
    });
    expect(
      Array.from(container.querySelectorAll("[data-change=remove]")).some(
        (element) => element.textContent === "y = 2",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("y = 20");
    expect(container.textContent).toContain("y = 200");
  });

  it("stacks each region's A and B diffs in one column", () => {
    act(() => {
      root.render(<InlineFileDiff diff={shortConflict()} file="main.py" layout="single" />);
    });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("[data-comparison-side]")).map((node) =>
        node.getAttribute("data-comparison-side"),
      ),
    ).toEqual(["a", "b"]);
    expect(container.textContent).toContain("Agent A");
    expect(container.textContent).toContain("y = 2");
    expect(container.textContent).toContain("y = 200");
    expect(byTestId("arena-combined-direct-note")).toBeNull();
  });

  it("faces the two versions of a conflict side by side", () => {
    act(() => {
      root.render(<InlineFileDiff diff={shortConflict()} file="main.py" layout="split" />);
    });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(byTestId("arena-combined-conflict")).toBeNull();
    expect(container.textContent).toContain("Agent A");
    expect(container.textContent).toContain("y = 20");
    expect(container.textContent).toContain("y = 200");
  });

  it("keeps the original visible for a rewrite in either layout", () => {
    act(() => {
      root.render(<InlineFileDiff diff={rewrite()} file="main.py" layout="single" />);
    });
    expect(byTestId("arena-combined-direct-note")).toBeNull();
    expect(container.textContent).toContain("x = 0");
    expect(byTestId("arena-combined-conflict")).toBeNull();
    expect(container.textContent).toContain("a_0 = 0");
    expect(container.textContent).toContain("b_0 = 0");
    act(() => {
      root.render(<InlineFileDiff diff={rewrite()} file="main.py" layout="split" />);
    });
    expect(byTestId("arena-combined-direct-note")).toBeNull();
    expect(container.textContent).toContain("x = 0");
    expect(container.textContent).toContain("a_0 = 0");
    expect(container.textContent).toContain("b_0 = 0");
  });

  it("reads a file both changed the same way as the change both made", () => {
    act(() => {
      root.render(<InlineFileDiff diff={sameResult()} file="main.py" layout="single" />);
    });
    expect(byTestId("arena-inline-diff-note")).toBeNull();
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(container.textContent).toContain("y = 2");
    expect(container.textContent).toContain("Both");
    act(() => {
      root.render(<InlineFileDiff diff={sameResult()} file="main.py" layout="split" />);
    });
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(container.textContent).toContain("y = 2");
  });

  it("shows shared removals without a limitation note past the matrix budget", () => {
    act(() => {
      root.render(<InlineFileDiff diff={sameResultPastBudget()} file="main.py" layout="single" />);
    });
    expect(byTestId("arena-inline-diff-note")).toBeNull();
    expect(byTestId("arena-inline-diff")).not.toBeNull();
    expect(byTestId("arena-combined-base-note")).toBeNull();
    expect(container.textContent).toContain("line 0");
    expect(container.textContent).toContain("Both");
  });

  it("says so when both produced the same file and there is no base to read it against", () => {
    const diff = sameResult();
    delete diff.files[0]!.base;
    act(() => {
      root.render(<InlineFileDiff diff={diff} file="main.py" layout="single" />);
    });
    expect(byTestId("arena-inline-diff")).toBeNull();
    expect(byTestId("arena-inline-diff-note")?.textContent).toContain("The original was not sent");
  });

  it("expands one agent into the full viewer and restores comparison scroll and keyboard focus", () => {
    const diff = shortConflict();
    act(() => root.render(<InlineFileDiff diff={diff} file="main.py" layout="split" />));
    const viewer = byTestId("arena-inline-diff")!;
    viewer.scrollTop = 120;
    const expand = container.querySelector<HTMLElement>('[aria-label="Expand Agent A"]')!;
    act(() => expand.click());
    expect(viewer.getAttribute("data-detail-side")).toBe("a");
    expect(container.querySelector('[data-comparison-side="b"]')).toBeNull();
    expect(container.textContent).toContain("y = 2");
    expect(container.textContent).not.toContain("y = 200");
    act(() => container.querySelector<HTMLElement>('[aria-label="Back to comparison"]')!.click());
    expect(viewer.getAttribute("data-detail-side")).toBe("both");
    expect(viewer.scrollTop).toBe(120);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand Agent A");
    act(() => container.querySelector<HTMLElement>('[aria-label="Expand Agent B"]')!.click());
    act(() => viewer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(viewer.getAttribute("data-detail-side")).toBe("both");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand Agent B");
  });

  it("offers Close only when the caller can close the diff", () => {
    const diff = shortConflict();
    act(() => root.render(<InlineFileDiff diff={diff} file="main.py" layout="split" />));
    expect(byTestId("arena-diff-close")).toBeNull();
    const onClose = vi.fn();
    act(() =>
      root.render(<InlineFileDiff diff={diff} file="main.py" layout="split" onClose={onClose} />),
    );
    // Close sits beside Back in the one-side view too, so the diff can go from either.
    act(() => container.querySelector<HTMLElement>('[aria-label="Expand Agent A"]')!.click());
    expect(byTestId("arena-diff-back")).not.toBeNull();
    act(() => byTestId("arena-diff-close")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resets detail mode when the layout or turn changes", () => {
    const diff = shortConflict();
    act(() => root.render(<InlineFileDiff diff={diff} file="main.py" layout="split" />));
    act(() => container.querySelector<HTMLElement>('[aria-label="Expand Agent A"]')!.click());
    act(() => root.render(<InlineFileDiff diff={diff} file="main.py" layout="single" />));
    expect(byTestId("arena-inline-diff")?.getAttribute("data-detail-side")).toBe("both");
    act(() => container.querySelector<HTMLElement>('[aria-label="Expand Agent A"]')!.click());
    diff.turnID = "next-turn";
    act(() => root.render(<InlineFileDiff diff={diff} file="main.py" layout="single" />));
    expect(byTestId("arena-inline-diff")?.getAttribute("data-detail-side")).toBe("both");
  });
});

describe("openChangesFile", () => {
  const rows = arenaChangesRows(shortConflict());

  it("opens the default file until the reader chooses", () => {
    expect(openChangesFile(rows, undefined)).toBe("main.py");
  });

  it("keeps a closed diff closed", () => {
    expect(openChangesFile(rows, null)).toBeNull();
  });

  it("falls back to the default when the chosen file is gone", () => {
    expect(openChangesFile(rows, "deleted.py")).toBe("main.py");
    expect(openChangesFile(rows, "main.py")).toBe("main.py");
  });
});
