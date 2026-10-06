/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { highlightedCodeBlock, mermaidFence } = vi.hoisted(() => ({
  highlightedCodeBlock: vi.fn(),
  mermaidFence: vi.fn(),
}));

vi.stubGlobal("React", React);

vi.mock("@/components/highlighted-code-block", () => ({
  HighlightedCodeBlock: (props: Record<string, unknown>) => {
    highlightedCodeBlock(props);
    return <div data-testid="highlighted-code" />;
  },
}));

vi.mock("./mermaid", () => ({
  MermaidFence: (props: Record<string, unknown>) => {
    mermaidFence(props);
    return <div data-testid="mermaid-diagram" />;
  },
}));

import { MarkdownFenceBlock } from ".";

const sharedProps = {
  code: "flowchart LR\n  A --> B\n",
  info: "mermaid",
  phase: "complete" as const,
  inheritedStyles: {},
  textStyle: {},
};

describe("MarkdownFenceBlock", () => {
  afterEach(() => {
    highlightedCodeBlock.mockClear();
    mermaidFence.mockClear();
  });

  it("keeps Mermaid diagrams enabled by default", () => {
    const view = render(<MarkdownFenceBlock {...sharedProps} />);

    expect(view.getByTestId("mermaid-diagram")).toBeTruthy();
    expect(mermaidFence).toHaveBeenCalledOnce();
    expect(highlightedCodeBlock).not.toHaveBeenCalled();
  });

  it("renders Mermaid as horizontally scrollable code when diagrams are disabled", () => {
    const view = render(
      <MarkdownFenceBlock {...sharedProps} enableDiagrams={false} horizontalScroll />,
    );

    expect(view.getByTestId("highlighted-code")).toBeTruthy();
    expect(highlightedCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: sharedProps.code,
        language: "mermaid",
        horizontalScroll: true,
      }),
    );
    expect(mermaidFence).not.toHaveBeenCalled();
  });
});
