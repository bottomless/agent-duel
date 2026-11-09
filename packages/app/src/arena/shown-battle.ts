import { create } from "zustand";

/**
 * The decided battle a chat has opened with Show battle, if any. The battle then stands in for its
 * kept answer, and the composer's place holds what was kept and the way back, so the chat and the
 * composer slot both read it. One per chat: showing another battle hides the first.
 */
interface ArenaShownBattleStore {
  byAgent: Record<string, string>;
  show: (agentId: string, turnId: string) => void;
  hide: (agentId: string) => void;
}

export const useArenaShownBattleStore = create<ArenaShownBattleStore>((set) => ({
  byAgent: {},
  show: (agentId, turnId) => set((state) => ({ byAgent: { ...state.byAgent, [agentId]: turnId } })),
  hide: (agentId) =>
    set((state) => {
      if (!(agentId in state.byAgent)) return state;
      const { [agentId]: _hidden, ...rest } = state.byAgent;
      return { byAgent: rest };
    }),
}));

export function useArenaShownBattle(agentId: string | undefined): string | null {
  return useArenaShownBattleStore((state) => (agentId ? (state.byAgent[agentId] ?? null) : null));
}
