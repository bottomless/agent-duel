import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { create } from "zustand";

/**
 * What the voter has chosen while reviewing one battle, held outside the card
 * so [review telemetry](review-telemetry.ts) can watch it without the
 * components carrying any telemetry of their own. Absent fields mean the
 * reader has not chosen and the card's own default stands, the same contract
 * `diff-layout.ts` uses for the layout.
 */
export type ArenaReviewTab = "verdict" | "changes";

export interface ArenaReviewState {
  /** The tab the reader picked. Absent means the card's default is standing. */
  readonly tab?: ArenaReviewTab;
  /**
   * The tab actually rendered, default included. Telemetry counts this rather
   * than `tab`: a reader who lands on Verdict and reads it has read it, whether
   * or not they ever touched the tab control.
   */
  readonly shownTab?: ArenaReviewTab;
  /** The file the reader picked. Absent means the card's default is standing. */
  readonly file?: string;
  /**
   * The file whose diff is actually on screen, default included. Telemetry
   * counts this rather than `file`: a reader who opens Changes and reads the
   * file already showing has read it, whether or not they clicked anything.
   */
  readonly shownFile?: string;
  /** Row position of `shownFile`, which says whether the reader went in order. */
  readonly shownIndex?: number;
  readonly verdictExpanded?: boolean;
  /**
   * Whether the report was long enough to clip. Without it an unexpanded
   * verdict is indistinguishable from one that was never foldable.
   */
  readonly verdictFolded?: boolean;
  /** Contestants whose running app the reader opened through the preview proxy. */
  readonly previewsOpened?: readonly ArenaSide[];
}

interface ArenaReviewStore {
  /** Per turn, not per chat: a chat holds many battles and each is reviewed on its own. */
  byTurn: Record<string, ArenaReviewState>;
  setTab: (turnId: string, tab: ArenaReviewTab) => void;
  setFile: (turnId: string, file: string) => void;
  setShownTab: (turnId: string, shownTab: ArenaReviewTab) => void;
  setShownFile: (turnId: string, shownFile: string, shownIndex: number) => void;
  setVerdictExpanded: (turnId: string, expanded: boolean) => void;
  setVerdictFolded: (turnId: string) => void;
  addPreviewOpened: (turnId: string, side: ArenaSide) => void;
}

const EMPTY: ArenaReviewState = {};

function patch(turnId: string, next: ArenaReviewState) {
  return (state: ArenaReviewStore) => ({
    byTurn: { ...state.byTurn, [turnId]: { ...state.byTurn[turnId], ...next } },
  });
}

export const useArenaReviewStore = create<ArenaReviewStore>((set) => ({
  byTurn: {},
  setTab: (turnId, tab) => set(patch(turnId, { tab })),
  setFile: (turnId, file) => set(patch(turnId, { file })),
  setShownTab: (turnId, shownTab) =>
    set((state) => {
      if (state.byTurn[turnId]?.shownTab === shownTab) return state;
      return { byTurn: { ...state.byTurn, [turnId]: { ...state.byTurn[turnId], shownTab } } };
    }),
  setShownFile: (turnId, shownFile, shownIndex) =>
    set((state) => {
      // Returning the same state leaves subscribers untouched, so the card does
      // not re-render for a write that changes nothing.
      if (state.byTurn[turnId]?.shownFile === shownFile) return state;
      return {
        byTurn: { ...state.byTurn, [turnId]: { ...state.byTurn[turnId], shownFile, shownIndex } },
      };
    }),
  setVerdictExpanded: (turnId, verdictExpanded) => set(patch(turnId, { verdictExpanded })),
  addPreviewOpened: (turnId, side) =>
    set((state) => {
      const opened = state.byTurn[turnId]?.previewsOpened ?? [];
      if (opened.includes(side)) return state;
      return {
        byTurn: {
          ...state.byTurn,
          [turnId]: { ...state.byTurn[turnId], previewsOpened: [...opened, side] },
        },
      };
    }),
  setVerdictFolded: (turnId) =>
    set((state) => {
      if (state.byTurn[turnId]?.verdictFolded) return state;
      return {
        byTurn: { ...state.byTurn, [turnId]: { ...state.byTurn[turnId], verdictFolded: true } },
      };
    }),
}));

export function useArenaReviewState(turnId: string): ArenaReviewState {
  return useArenaReviewStore((state) => state.byTurn[turnId] ?? EMPTY);
}
