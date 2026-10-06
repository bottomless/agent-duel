/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsElectronRuntime } from "./use-is-electron-runtime";

const { getIsElectron } = vi.hoisted(() => ({
  getIsElectron: vi.fn<() => boolean>(),
}));

vi.mock("@/constants/platform", () => ({ getIsElectron }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getIsElectron.mockReset();
});

describe("useIsElectronRuntime", () => {
  it("becomes ready when the packaged preload bridge appears after the first render", async () => {
    vi.useFakeTimers();
    getIsElectron.mockReturnValue(false);
    const { result } = renderHook(useIsElectronRuntime);

    expect(result.current).toBe(false);

    getIsElectron.mockReturnValue(true);
    await act(() => vi.advanceTimersByTimeAsync(250));

    expect(result.current).toBe(true);
  });

  it("does not poll when the bridge is ready on the first render", () => {
    vi.useFakeTimers();
    getIsElectron.mockReturnValue(true);

    const { result } = renderHook(useIsElectronRuntime);

    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
