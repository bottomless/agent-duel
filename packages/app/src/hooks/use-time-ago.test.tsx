/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useCompactTimeAgo, useTimeAgo } from "./use-time-ago";

const now = new Date("2026-07-16T12:00:00Z");
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

it("refreshes mounted relative and static date labels when the language changes without a clock tick", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const recent = renderHook(() => useTimeAgo(new Date(now.getTime() - 300_000)));
  const old = renderHook(() => useCompactTimeAgo(new Date(2026, 0, 15)));
  expect(recent.result.current).toBe("5m ago");
  expect(old.result.current).toBe("Jan 15");
  await act(() => i18n.changeLanguage("zh-CN"));
  expect(recent.result.current).toBe("5分钟前");
  expect(old.result.current).toBe("1月15日");
});
