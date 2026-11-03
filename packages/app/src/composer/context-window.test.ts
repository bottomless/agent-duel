import { describe, expect, it } from "vitest";
import { shouldShowComposerContextWindow } from "./context-window";

const idleAgent = {
  hasAgent: true,
  provider: "opencode",
  model: "test/model",
  maxTokens: null,
  usedTokens: null,
  pending: false,
};

describe("composer context window", () => {
  it.each([
    { maxTokens: null, usedTokens: null },
    { maxTokens: 200_000, usedTokens: null },
    { maxTokens: null, usedTokens: 1_000 },
  ])("omits the meter slot with incomplete idle usage: %j", (usage) => {
    expect(shouldShowComposerContextWindow({ ...idleAgent, ...usage })).toBe(false);
  });

  it.each(["opencode", "claude", "codex"])("keeps reported usage for %s", (provider) => {
    expect(
      shouldShowComposerContextWindow({
        ...idleAgent,
        provider,
        maxTokens: 200_000,
        usedTokens: 1_000,
      }),
    ).toBe(true);
  });

  it("keeps zero used tokens as real data", () => {
    expect(
      shouldShowComposerContextWindow({ ...idleAgent, maxTokens: 200_000, usedTokens: 0 }),
    ).toBe(true);
  });

  it("keeps the meter mounted from pending first usage through the idle result", () => {
    const initializing = { ...idleAgent, pending: true };
    const running = { ...initializing, maxTokens: 200_000 };
    const firstUsage = { ...running, usedTokens: 1_000 };
    const finished = { ...firstUsage, pending: false };

    expect(
      [initializing, running, firstUsage, finished].map(shouldShowComposerContextWindow),
    ).toEqual([true, true, true, true]);
  });

  it.each(["arena/contestant", "arena/medium", "arena/other", null])(
    "hides Arena model %s before usage, during a run, and with stale numeric data",
    (model) => {
      const arena = { ...idleAgent, model };
      const running = { ...arena, pending: true };
      const staleUsage = { ...running, maxTokens: 200_000, usedTokens: 100_000 };
      const finished = { ...staleUsage, pending: false };

      expect([arena, running, staleUsage, finished].map(shouldShowComposerContextWindow)).toEqual([
        false,
        false,
        false,
        false,
      ]);
    },
  );

  it("does not reserve a slot for a draft even with pending or stale usage", () => {
    expect(
      shouldShowComposerContextWindow({
        ...idleAgent,
        hasAgent: false,
        pending: true,
        maxTokens: 200_000,
        usedTokens: 1_000,
      }),
    ).toBe(false);
  });

  it("keeps other providers' reported usage when their model is unknown", () => {
    expect(
      shouldShowComposerContextWindow({
        ...idleAgent,
        provider: "claude",
        model: null,
        maxTokens: 200_000,
        usedTokens: 1_000,
      }),
    ).toBe(true);
  });
});
