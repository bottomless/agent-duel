import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog, useConfirmDialogStore } from "@/utils/confirm-dialog";
import { ConfirmDialogHost } from "./confirm-dialog-host";

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    absoluteFillObject: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            spacing: { 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
            fontSize: { sm: 14 },
            fontWeight: { medium: "500" },
            borderRadius: { lg: 8 },
            shadow: { md: {} },
            colors: {
              foreground: "#fff",
              foregroundMuted: "#aaa",
              surface1: "#111",
              borderAccent: "#333",
            },
          })
        : factory,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "common.actions.cancel" ? "Cancel" : key),
  }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      testID,
      variant,
      ref,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
      variant?: string;
      ref?: React.Ref<HTMLButtonElement>;
    }) =>
      ReactModule.createElement(
        "button",
        { ref, type: "button", "data-testid": testID, "data-variant": variant, onClick: onPress },
        children,
      ),
  };
});

let root: Root | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ConfirmDialogHost />);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.unstubAllGlobals();
});

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  act(() => {
    byTestId(testId)?.click();
  });
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function ask(input: Parameters<typeof confirmDialog>[0]): Promise<boolean> {
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = confirmDialog(input);
  });
  return answer;
}

async function waitForExit(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe("ConfirmDialogHost", () => {
  it("renders the question in the app and resolves true on confirm", async () => {
    const answer = ask({
      title: "Discard winning changes?",
      message: "This will discard the winning agent’s work from this battle.",
      confirmLabel: "Discard winning changes",
      destructive: true,
    });

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.parentElement?.closest("#overlay-root")).not.toBeNull();
    expect(byTestId("confirm-dialog-title")?.textContent).toBe("Discard winning changes?");
    expect(byTestId("confirm-dialog-message")?.textContent).toBe(
      "This will discard the winning agent’s work from this battle.",
    );
    expect(byTestId("confirm-dialog-cancel")?.textContent).toBe("Cancel");
    expect(byTestId("confirm-dialog-confirm")?.textContent).toBe("Discard winning changes");
    expect(byTestId("confirm-dialog-confirm")?.dataset.variant).toBe("destructive");

    click("confirm-dialog-confirm");
    await expect(answer).resolves.toBe(true);
    await waitForExit();
    expect(byTestId("confirm-dialog")).toBeNull();
  });

  it("resolves false on Cancel", async () => {
    const answer = ask({ title: "Close tabs?", message: "This will close 2 tabs." });
    click("confirm-dialog-cancel");
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false on Escape", async () => {
    const answer = ask({ title: "Close tabs?", message: "This will close 2 tabs." });
    pressKey("Escape");
    await expect(answer).resolves.toBe(false);
  });

  it("resolves false when the backdrop is clicked", async () => {
    const answer = ask({ title: "Close tabs?", message: "This will close 2 tabs." });
    click("confirm-dialog-backdrop");
    await expect(answer).resolves.toBe(false);
  });

  it("starts a destructive question on Cancel and any other on its confirm button", async () => {
    const destructive = ask({ title: "Remove key?", message: "Removes it.", destructive: true });
    expect(document.activeElement).toBe(byTestId("confirm-dialog-cancel"));
    click("confirm-dialog-cancel");
    await destructive;
    await waitForExit();

    const plain = ask({ title: "Create a first commit?", message: "Commits the folder." });
    expect(document.activeElement).toBe(byTestId("confirm-dialog-confirm"));
    expect(byTestId("confirm-dialog-confirm")?.dataset.variant).toBe("default");
    click("confirm-dialog-confirm");
    await expect(plain).resolves.toBe(true);
  });

  it("moves on to the next question once the first is answered", async () => {
    const first = ask({ title: "First?", message: "1" });
    const second = ask({ title: "Second?", message: "2", destructive: true });

    expect(byTestId("confirm-dialog-title")?.textContent).toBe("First?");
    click("confirm-dialog-confirm");
    await expect(first).resolves.toBe(true);

    expect(byTestId("confirm-dialog-title")?.textContent).toBe("Second?");
    expect(document.activeElement).toBe(byTestId("confirm-dialog-cancel"));
    pressKey("Escape");
    await expect(second).resolves.toBe(false);
  });

  it("cancels an open question when the host unmounts", async () => {
    const answer = ask({ title: "Close tabs?", message: "This will close 2 tabs." });
    act(() => {
      root?.unmount();
    });
    root = null;
    await expect(answer).resolves.toBe(false);
    expect(useConfirmDialogStore.getState().pending).toEqual([]);
  });
});
