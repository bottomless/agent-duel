import { describe, expect, it } from "vitest";
import {
  initialLoopbackHistoryState,
  stepLoopbackHistory,
  type LoopbackHistoryInput,
} from "./loopback-history";

const input = (patch: Partial<LoopbackHistoryInput>): LoopbackHistoryInput => ({
  refused: false,
  streamFailed: false,
  dataUpdatedAt: 100,
  historyFailed: true,
  ...patch,
});

describe("stepLoopbackHistory", () => {
  it("shows the history banner when the stream has no loopback refusal", () => {
    const step = stepLoopbackHistory(initialLoopbackHistoryState, input({}));
    expect(step).toEqual({
      state: initialLoopbackHistoryState,
      hideHistoryError: false,
      retryHistory: false,
    });
  });

  it("hides the history banner while the stream shows the loopback refusal", () => {
    const step = stepLoopbackHistory(initialLoopbackHistoryState, input({ refused: true }));
    expect(step).toEqual({
      state: { refusedAt: 100 },
      hideHistoryError: true,
      retryHistory: false,
    });
  });

  it("keeps the banner hidden while the stream's Retry reconnects without a snapshot", () => {
    const step = stepLoopbackHistory({ refusedAt: 100 }, input({ dataUpdatedAt: 100 }));
    expect(step).toEqual({
      state: { refusedAt: 100 },
      hideHistoryError: true,
      retryHistory: false,
    });
  });

  it("fetches history again once the stream answers with a new snapshot", () => {
    const step = stepLoopbackHistory({ refusedAt: 100 }, input({ dataUpdatedAt: 200 }));
    expect(step).toEqual({
      state: initialLoopbackHistoryState,
      hideHistoryError: false,
      retryHistory: true,
    });
  });

  it("does not fetch history again when it did not fail", () => {
    const step = stepLoopbackHistory(
      { refusedAt: 100 },
      input({ dataUpdatedAt: 200, historyFailed: false }),
    );
    expect(step.retryHistory).toBe(false);
  });

  it("shows the history banner again when the stream fails for another reason", () => {
    const step = stepLoopbackHistory({ refusedAt: 100 }, input({ streamFailed: true }));
    expect(step).toEqual({
      state: initialLoopbackHistoryState,
      hideHistoryError: false,
      retryHistory: false,
    });
  });
});
