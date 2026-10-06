import { create } from "zustand";

/**
 * How a file's diff is laid out in the battle card and the archived summary:
 * The agents' changes from the original, side by side or stacked per region.
 */
export type ArenaDiffLayout = "split" | "single";

// Two columns need about 380px each before code stops being cut at every line.
export const SPLIT_MIN_WIDTH = 760;

/** The layout a card opens in when the reader has not chosen: two columns where they fit. */
export function defaultDiffLayout(width: number | null): ArenaDiffLayout {
  return width !== null && width >= SPLIT_MIN_WIDTH ? "split" : "single";
}

export const DIFF_LAYOUT_OPTIONS: Array<{ value: ArenaDiffLayout; label: string; testID: string }> =
  [
    { value: "split", label: "Side by side", testID: "arena-diff-layout-split" },
    { value: "single", label: "One column", testID: "arena-diff-layout-single" },
  ];

interface ArenaDiffLayoutStore {
  /** The reader's choice per chat; absent means the width decides. */
  layoutByChat: Record<string, ArenaDiffLayout>;
  setLayout: (agentId: string, layout: ArenaDiffLayout) => void;
}

// One choice per chat for as long as the app runs; a reload goes back to the
// width rule, which is what a new reader would get anyway.
export const useArenaDiffLayoutStore = create<ArenaDiffLayoutStore>((set) => ({
  layoutByChat: {},
  setLayout: (agentId, layout) =>
    set((state) => ({ layoutByChat: { ...state.layoutByChat, [agentId]: layout } })),
}));

/** The layout to draw a chat's diffs in: the reader's choice, else the width rule. */
export function useArenaDiffLayout(agentId: string, width: number | null): ArenaDiffLayout {
  const chosen = useArenaDiffLayoutStore((state) => state.layoutByChat[agentId]);
  return chosen ?? defaultDiffLayout(width);
}
