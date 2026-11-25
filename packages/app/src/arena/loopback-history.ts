/**
 * While hosted Arena refuses the daemon's listener, an open chat's history fetch fails with the same
 * refusal the battle stream already shows with its own Retry. The history banner would only repeat
 * it without the instruction, so it waits until the stream answers again, and history is fetched
 * again then.
 */
export interface LoopbackHistoryState {
  /** When the stream last published a snapshot before the refusal; null while not refused. */
  readonly refusedAt: number | null;
}

export interface LoopbackHistoryInput {
  /** The stream ended with the loopback refusal. */
  readonly refused: boolean;
  /** The stream failed for some other reason, which the history banner may well share. */
  readonly streamFailed: boolean;
  /** The stream's last snapshot time; 0 before the first one. */
  readonly dataUpdatedAt: number;
  readonly historyFailed: boolean;
}

export interface LoopbackHistoryStep {
  readonly state: LoopbackHistoryState;
  readonly hideHistoryError: boolean;
  readonly retryHistory: boolean;
}

export const initialLoopbackHistoryState: LoopbackHistoryState = { refusedAt: null };

export function stepLoopbackHistory(
  state: LoopbackHistoryState,
  input: LoopbackHistoryInput,
): LoopbackHistoryStep {
  if (input.refused) {
    return {
      state: { refusedAt: state.refusedAt ?? input.dataUpdatedAt },
      hideHistoryError: true,
      retryHistory: false,
    };
  }
  if (state.refusedAt === null || input.streamFailed) {
    return { state: initialLoopbackHistoryState, hideHistoryError: false, retryHistory: false };
  }
  // The stream's Retry clears the refusal before it reconnects; only a new snapshot means the
  // engine started, and the history that failed beside the refusal can load now.
  if (input.dataUpdatedAt > state.refusedAt) {
    return {
      state: initialLoopbackHistoryState,
      hideHistoryError: false,
      retryHistory: input.historyFailed,
    };
  }
  return { state, hideHistoryError: true, retryHistory: false };
}
