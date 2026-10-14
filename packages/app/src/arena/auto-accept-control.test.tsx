/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("lucide-react-native", () => {
  const StubIcon = () => null;
  return { ChevronDown: StubIcon, ShieldCheck: StubIcon, ShieldQuestion: StubIcon };
});

// The menu engine and tooltip need a real layout; the hint is plain content inside them.
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuItem: Passthrough,
  };
});
vi.mock("@/components/ui/tooltip", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Tooltip: Passthrough, TooltipTrigger: Passthrough, TooltipContent: () => null };
});

import { ArenaAutoAcceptControl } from "./auto-accept-control";

const noop = () => {};

describe("ArenaAutoAcceptControl", () => {
  afterEach(cleanup);

  it("says the choice also becomes the default for new chats", () => {
    const view = render(
      <ArenaAutoAcceptControl
        enabled={false}
        disabled={false}
        battleActive={false}
        onChange={noop}
      />,
    );

    expect(
      view.getByText(
        "Applies to this chat and becomes the default for new chats. Explicit deny rules still apply.",
      ),
    ).toBeTruthy();
  });

  it("names both contestants while a battle runs", () => {
    const view = render(
      <ArenaAutoAcceptControl enabled battleActive disabled={false} onChange={noop} />,
    );

    expect(
      view.getByText(
        "Applies to both contestants and becomes the default for new chats. Explicit deny rules still apply.",
      ),
    ).toBeTruthy();
  });
});
