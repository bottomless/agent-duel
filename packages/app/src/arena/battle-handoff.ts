import { create } from "zustand";

/**
 * Battles whose opening panes the agent panel already holds.
 *
 * An ordinary send hands its new agent the message it was typed into, and the panel reads that
 * handoff as licence to paint at once instead of holding a spinner over a new agent until the
 * daemon's history for it lands. A battle hands over nothing: the prompt goes to `arenaStart`,
 * never to the canonical timeline, so its create record is dropped rather than marked sent —
 * a record left behind keeps the sidebar showing a workspace stuck mid-create.
 *
 * Dropping it also dropped the only sign that the screen had something to draw, so starting a
 * battle flashed: panes, spinner, panes again. This is that sign kept on its own. It is written
 * beside the seeded arena snapshot the panel paints from, and cleared once the history it stood
 * in for has landed.
 */
interface ArenaBattleHandoffState {
  handoffs: Readonly<Record<string, true>>;
  mark: (input: { serverId: string; agentId: string }) => void;
  clear: (input: { serverId: string; agentId: string }) => void;
}

function handoffKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

const useArenaBattleHandoffStore = create<ArenaBattleHandoffState>((set) => ({
  handoffs: {},
  mark: ({ serverId, agentId }) =>
    set((state) => ({
      handoffs: { ...state.handoffs, [handoffKey(serverId, agentId)]: true },
    })),
  clear: ({ serverId, agentId }) =>
    set((state) => {
      const key = handoffKey(serverId, agentId);
      if (!state.handoffs[key]) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.handoffs;
      return { handoffs: rest };
    }),
}));

export function markArenaBattleHandoff(input: { serverId: string; agentId: string }): void {
  useArenaBattleHandoffStore.getState().mark(input);
}

export function clearArenaBattleHandoff(input: { serverId: string; agentId: string }): void {
  useArenaBattleHandoffStore.getState().clear(input);
}

export function useArenaBattleHandoff(serverId: string, agentId: string | undefined): boolean {
  return useArenaBattleHandoffStore((state) =>
    agentId ? state.handoffs[handoffKey(serverId, agentId)] === true : false,
  );
}
