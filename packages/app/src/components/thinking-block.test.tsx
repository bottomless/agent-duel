/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { markdownRenderer } = vi.hoisted(() => ({ markdownRenderer: vi.fn() }));

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({
    text,
    compact,
    subdued,
    markdownit,
    enableHtmlish,
    enableDiagrams,
    horizontalScrollCodeBlocks,
  }: {
    text: string;
    compact?: boolean;
    subdued?: boolean;
    markdownit?: unknown;
    enableHtmlish?: boolean;
    enableDiagrams?: boolean;
    horizontalScrollCodeBlocks?: boolean;
  }) => {
    markdownRenderer({
      text,
      compact,
      subdued,
      markdownit,
      enableHtmlish,
      enableDiagrams,
      horizontalScrollCodeBlocks,
    });
    return (
      <div data-testid="thinking-markdown" data-compact={String(Boolean(compact))}>
        {text}
      </div>
    );
  },
}));

vi.mock("@/components/message", () => ({
  ExpandableBadge: ({
    label,
    isExpanded,
    onToggle,
    renderDetails,
    style,
    isLoading,
    disableOuterSpacing,
    borderlessWhenExpanded,
    transparentWhenExpanded,
    compactLabel,
  }: {
    label: string;
    isExpanded: boolean;
    onToggle(): void;
    renderDetails(): React.ReactNode;
    style?: unknown;
    isLoading?: boolean;
    disableOuterSpacing?: boolean;
    borderlessWhenExpanded?: boolean;
    transparentWhenExpanded?: boolean;
    compactLabel?: boolean;
  }) => (
    <div
      data-testid="thinking-block"
      data-rail={String(Boolean(style))}
      data-loading={String(Boolean(isLoading))}
      data-no-outer-spacing={String(Boolean(disableOuterSpacing))}
      data-borderless={String(Boolean(borderlessWhenExpanded))}
      data-transparent={String(Boolean(transparentWhenExpanded))}
      data-compact-label={String(Boolean(compactLabel))}
    >
      <button type="button" aria-expanded={isExpanded} onClick={onToggle}>
        {label}
      </button>
      {isExpanded ? <div data-testid="thinking-details">{renderDetails()}</div> : null}
    </div>
  ),
}));

import { ThinkingBlock } from "./thinking-block";

describe("ThinkingBlock", () => {
  afterEach(() => {
    cleanup();
    markdownRenderer.mockClear();
  });

  it("reveals subdued Markdown reasoning beside a rail", () => {
    const view = render(
      <ThinkingBlock
        text={"Use `grid-template-columns`:\n\n```css\n.board { display: grid; }\n```"}
      />,
    );

    expect(view.queryByTestId("thinking-details")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Thinking" }));

    expect(view.getByTestId("thinking-markdown").textContent).toContain("grid-template-columns");
    expect(view.getByTestId("thinking-block").getAttribute("data-rail")).toBe("true");
    expect(markdownRenderer.mock.lastCall?.[0]).toEqual({
      compact: false,
      subdued: true,
      text: "Use `grid-template-columns`:\n\n```css\n.board { display: grid; }\n```",
      markdownit: expect.anything(),
      enableHtmlish: false,
      enableDiagrams: false,
      horizontalScrollCodeBlocks: true,
    });
  });

  it("stays expanded when live reasoning text changes", () => {
    const view = render(<ThinkingBlock text="First line" />);

    fireEvent.click(view.getByRole("button", { name: "Thinking" }));
    view.rerender(<ThinkingBlock text={"First line\n\n- Next step"} active compact />);

    expect(view.getByRole("button", { name: "Thinking" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(view.getByTestId("thinking-markdown").getAttribute("data-compact")).toBe("true");
    expect(view.getByTestId("thinking-details").textContent).toContain("Next step");
  });

  it("supports an initially expanded compact live block and can still collapse", () => {
    const text = "Checking `min-width` while streaming.";
    const view = render(
      <ThinkingBlock text={text} active compact defaultExpanded disableOuterSpacing />,
    );

    const block = view.getByTestId("thinking-block");
    const toggle = view.getByRole("button", { name: "Thinking" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(block.getAttribute("data-loading")).toBe("true");
    expect(block.getAttribute("data-no-outer-spacing")).toBe("true");
    expect(block.getAttribute("data-compact-label")).toBe("true");
    expect(view.getByTestId("thinking-markdown").textContent).toBe(text);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("thinking-details")).toBeNull();
  });
});
