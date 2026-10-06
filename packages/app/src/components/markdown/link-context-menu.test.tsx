/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownLinkContextMenu } from "./link-context-menu";

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/utils/open-external-url", () => ({
  canOpenExternalUrl: (url: string) => url.startsWith("http://") || url.startsWith("https://"),
  openExternalUrl,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: () => "Open in external browser" }),
}));
vi.mock("@/components/ui/menu", async () => {
  const React = await import("react");
  interface TestMenuContextValue {
    open: boolean;
    setOpen(open: boolean): void;
    setAnchorRect(rect: unknown): void;
  }
  const TestMenuContext = React.createContext<TestMenuContextValue | null>(null);
  const useTestMenu = () => {
    const value = React.useContext(TestMenuContext);
    if (!value) throw new Error("Missing test menu context");
    return value;
  };
  return {
    MenuRoot: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      const value = React.useMemo(() => ({ open, setOpen, setAnchorRect: () => {} }), [open]);
      return <TestMenuContext.Provider value={value}>{children}</TestMenuContext.Provider>;
    },
    useMenuContext: useTestMenu,
    MenuSurface: ({ children }: { children: React.ReactNode }) => {
      const menu = useTestMenu();
      return menu.open ? <div role="menu">{children}</div> : null;
    },
    MenuItem: ({
      children,
      onSelect,
      testID,
    }: {
      children: React.ReactNode;
      onSelect(): void;
      testID?: string;
    }) => (
      <button type="button" data-testid={testID} onClick={onSelect}>
        {children}
      </button>
    ),
  };
});

afterEach(() => {
  cleanup();
  openExternalUrl.mockClear();
});

describe("MarkdownLinkContextMenu", () => {
  it("offers an external-browser action on right click", () => {
    const view = render(
      <MarkdownLinkContextMenu url="https://example.com">
        {(onContextMenu) => (
          <a href="https://example.com" onContextMenu={onContextMenu}>
            Example
          </a>
        )}
      </MarkdownLinkContextMenu>,
    );

    fireEvent.contextMenu(view.getByRole("link"), { pageX: 20, pageY: 30 });
    fireEvent.click(view.getByTestId("markdown-link-open-external"));

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("does not add an external action for workspace file links", () => {
    const view = render(
      <MarkdownLinkContextMenu url="src/index.ts">
        {(onContextMenu) => (
          <a href="src/index.ts" onContextMenu={onContextMenu}>
            Source
          </a>
        )}
      </MarkdownLinkContextMenu>,
    );

    fireEvent.contextMenu(view.getByRole("link"), { pageX: 20, pageY: 30 });

    expect(view.queryByRole("menu")).toBeNull();
  });
});
