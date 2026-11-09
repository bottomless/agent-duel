import { create } from "zustand";

/**
 * What a folded review needs to draw its tabs in the decision row: the card renders the review
 * and knows its tabs, the decision row below the transcript does not. Display facts only; the
 * reader's choices stay in `review-state.ts`, where review telemetry watches them.
 */
export interface ArenaReviewDockTabs {
  /** Whether there is a Difference summary tab beside Changes. */
  summary: boolean;
  /** The Changes tab's label, with its file count once known. */
  changesLabel: string;
}

interface ArenaReviewDockStore {
  byTurn: Record<string, ArenaReviewDockTabs>;
  setTabs: (turnId: string, tabs: ArenaReviewDockTabs) => void;
}

export const useArenaReviewDockStore = create<ArenaReviewDockStore>((set) => ({
  byTurn: {},
  setTabs: (turnId, tabs) =>
    set((state) => {
      const current = state.byTurn[turnId];
      if (current?.summary === tabs.summary && current.changesLabel === tabs.changesLabel) {
        return state;
      }
      return { byTurn: { ...state.byTurn, [turnId]: tabs } };
    }),
}));

export function useArenaReviewDockTabs(turnId: string | undefined): ArenaReviewDockTabs | null {
  return useArenaReviewDockStore((state) => (turnId ? (state.byTurn[turnId] ?? null) : null));
}
