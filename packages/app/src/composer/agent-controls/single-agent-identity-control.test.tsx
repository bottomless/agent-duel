/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactComposerToolbarContext } from "@/composer/toolbar-layout";
import { SingleAgentIdentityControl } from "./single-agent-identity-control";

// The real Combobox pulls in the bottom sheet, which jsdom cannot load. This stand-in renders the
// options while open and wires each one to onSelect, which is all the control relies on.
vi.mock("@/components/ui/combobox", async () => {
  const { createElement, Fragment } = await import("react");
  interface Option {
    id: string;
    label: string;
  }
  return {
    Combobox: (props: {
      open?: boolean;
      options: Option[];
      onSelect: (id: string) => void;
      renderOption: (input: {
        option: Option;
        selected: boolean;
        active: boolean;
        onPress: () => void;
      }) => React.ReactElement;
    }) =>
      props.open
        ? createElement(
            Fragment,
            null,
            props.options.map((option) =>
              createElement(
                Fragment,
                { key: option.id },
                props.renderOption({
                  option,
                  selected: false,
                  active: false,
                  onPress: () => props.onSelect(option.id),
                }),
              ),
            ),
          )
        : null,
    ComboboxItem: (props: { label: string; accessibilityLabel?: string; onPress: () => void }) =>
      createElement(
        "button",
        { type: "button", "aria-label": props.accessibilityLabel, onClick: props.onPress },
        props.label,
      ),
  };
});

// The tooltip needs matchMedia, which jsdom lacks. Render its content inline so the test can
// read it.
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement, Fragment } = await import("react");
  const passthrough = ({ children }: { children: React.ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Tooltip: passthrough,
    TooltipTrigger: passthrough,
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      createElement("div", { role: "tooltip" }, children),
  };
});

beforeEach(() => vi.stubGlobal("React", React));

const hiddenSingleAgent = { id: "rating-1", revealed: false } as const;
const revealedSingleAgent = {
  id: "rating-1",
  revealed: true,
  vote: "up",
  identity: { name: "GLM 5.2" },
} as const;

describe("SingleAgentIdentityControl", () => {
  it("requires a thumb vote before revealing the assigned contestant", () => {
    const onVote = vi.fn();
    const view = render(
      <SingleAgentIdentityControl
        disabled={false}
        pending={false}
        singleAgent={hiddenSingleAgent}
        onVote={onVote}
      />,
    );

    expect(view.getByText("Agent identity hidden")).toBeTruthy();
    fireEvent.click(view.getByRole("link", { name: "Reveal agent identity" }));

    expect(view.getByText("Rate to reveal")).toBeTruthy();
    expect(view.queryByText("GLM 5.2")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Thumbs up and reveal agent identity" }));

    expect(onVote).toHaveBeenCalledWith("up");
    expect(view.getByText("Agent identity hidden")).toBeTruthy();

    view.rerender(
      <SingleAgentIdentityControl
        disabled={false}
        pending={false}
        singleAgent={revealedSingleAgent}
        onVote={onVote}
      />,
    );

    expect(view.getByText("GLM 5.2")).toBeTruthy();
    expect(view.queryByRole("link", { name: "Reveal agent identity" })).toBeNull();
  });

  it("fits a narrow toolbar by rating from a menu on the hidden identity icon", () => {
    const onVote = vi.fn();
    const view = render(
      <CompactComposerToolbarContext.Provider value>
        <SingleAgentIdentityControl
          disabled={false}
          pending={false}
          singleAgent={hiddenSingleAgent}
          onVote={onVote}
        />
      </CompactComposerToolbarContext.Provider>,
    );

    expect(view.queryByText("Agent identity hidden")).toBeNull();
    expect(view.getByRole("tooltip").textContent).toBe("Agent identity hidden · rate to reveal");
    expect(view.queryByRole("button", { name: /Thumbs/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Reveal agent identity" }));

    fireEvent.click(view.getByRole("button", { name: "Rate bad and reveal agent identity" }));
    expect(onVote).toHaveBeenCalledWith("down");
  });
});
