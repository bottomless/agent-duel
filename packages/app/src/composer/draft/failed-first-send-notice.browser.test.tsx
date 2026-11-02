import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollView, View } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerDock } from "@/composer/dock";
import { i18n } from "@/i18n/i18next";
import { FailedFirstSendNotice } from "./failed-first-send-notice";
import { useFailedFirstSendNotice } from "./failed-first-send";

void i18n;
const surfaceStyle = { height: 300, width: 360 };
const scrollStyle = { flex: 1 };
const composerStyle = { height: 80, flexShrink: 0 };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  useFailedFirstSendNotice.getState().dismiss();
  container.remove();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "keeps a long persistent failure out of the composer (centered=%s) and dismisses it",
  async (centered) => {
    act(() => {
      useFailedFirstSendNotice.getState().show("Backup failed. ".repeat(1000));
      root.render(
        <View style={surfaceStyle}>
          <ComposerDock centered={centered}>
            {centered ? (
              <FailedFirstSendNotice />
            ) : (
              <ScrollView style={scrollStyle}>
                <FailedFirstSendNotice />
              </ScrollView>
            )}
            <textarea data-testid="composer" style={composerStyle} defaultValue="Saved prompt" />
          </ComposerDock>
        </View>,
      );
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const composer = container.querySelector<HTMLTextAreaElement>("textarea");
    const dismiss = container.querySelector<HTMLElement>(
      '[data-testid="failed-first-send-dismiss"]',
    );
    expect(composer).not.toBeNull();
    expect(dismiss).not.toBeNull();
    if (!composer || !dismiss) throw new Error("Missing failure controls");
    const bounds = composer.getBoundingClientRect();
    expect(bounds.height).toBeGreaterThanOrEqual(80);
    expect(bounds.bottom).toBeLessThanOrEqual(container.getBoundingClientRect().bottom);
    expect(document.elementFromPoint(bounds.left + 10, bounds.top + 10)).toBe(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);
    act(() => dismiss.click());
    expect(container.querySelector('[data-testid="failed-first-send-notice"]')).toBeNull();
    expect(composer.value).toBe("Saved prompt");
  },
);
