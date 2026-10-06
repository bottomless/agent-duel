import { create, type StateCreator } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ArenaReplyTarget } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  reconcileArenaReplySelection,
  type ArenaReplyAction,
  type ArenaReplySelection,
} from "./reply-state";

/**
 * Retained chats reconcile independently. Keep each turn's target with its draft rather
 * than treating a visit to another chat as a new turn in the current one.
 */
interface ArenaReplyTargetState {
  selections: Readonly<Record<string, ArenaReplySelection>>;
  select: (turnId: string, target: ArenaReplyTarget) => void;
  reconcile: (turnId: string | null, actions: readonly ArenaReplyAction[]) => void;
}

const replyTargetState: StateCreator<ArenaReplyTargetState> = (set) => ({
  selections: {},
  select: (turnId, target) =>
    set((state) => ({ selections: { ...state.selections, [turnId]: { turnId, target } } })),
  reconcile: (turnId, actions) =>
    set((state) => {
      if (!turnId) return state;
      const previous = state.selections[turnId] ?? null;
      const next = reconcileArenaReplySelection(previous, turnId, actions);
      return !next || next === previous
        ? state
        : { selections: { ...state.selections, [turnId]: next } };
    }),
});

// The composer draft survives app restarts; its recipient must survive with it.
export function createArenaReplyTargetStore(storage?: StateStorage) {
  if (!storage) return create<ArenaReplyTargetState>(replyTargetState);
  return create<ArenaReplyTargetState>()(
    persist(replyTargetState, {
      name: "@paseo:arena-reply-targets",
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ selections: state.selections }),
    }),
  );
}

export const useArenaReplyTargetStore = createArenaReplyTargetStore(
  typeof window === "undefined" ? undefined : window.localStorage,
);
