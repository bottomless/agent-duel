import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_ARENA_THINKING, type ArenaThinkingLevel } from "./constants";

export interface ArenaPreferences {
  battleMode: boolean;
  thinking: ArenaThinkingLevel;
  /**
   * What `battleMode` was before a conflicted trunk paused battles, or undefined when nothing is
   * paused. Battles cannot run on a half-merged tree, so the switch goes off and stays off while
   * the conflict stands; this is what puts it back exactly where the user left it afterwards.
   */
  battleModeBeforeConflict?: boolean;
}

interface ArenaPreferencesState {
  byKey: Record<string, ArenaPreferences>;
  setPreferences: (key: string, patch: Partial<ArenaPreferences>) => void;
  copyPreferences: (fromKey: string, toKey: string) => void;
}

export const DEFAULT_ARENA_PREFERENCES: ArenaPreferences = {
  battleMode: true,
  thinking: DEFAULT_ARENA_THINKING,
};

const useArenaPreferencesStore = create<ArenaPreferencesState>()(
  persist(
    (set) => ({
      byKey: {},
      setPreferences: (key, patch) =>
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: { ...DEFAULT_ARENA_PREFERENCES, ...state.byKey[key], ...patch },
          },
        })),
      copyPreferences: (fromKey, toKey) =>
        set((state) => ({
          byKey: {
            ...state.byKey,
            [toKey]: { ...DEFAULT_ARENA_PREFERENCES, ...state.byKey[fromKey] },
          },
        })),
    }),
    {
      name: "@paseo:arena-preferences-v1",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ byKey: state.byKey }),
    },
  ),
);

export function getArenaPreferences(key: string): ArenaPreferences {
  return {
    ...DEFAULT_ARENA_PREFERENCES,
    ...useArenaPreferencesStore.getState().byKey[key],
  };
}

export function copyArenaPreferences(fromKey: string, toKey: string): void {
  useArenaPreferencesStore.getState().copyPreferences(fromKey, toKey);
}

export function setArenaBattleMode(key: string, battleMode: boolean): void {
  useArenaPreferencesStore.getState().setPreferences(key, { battleMode });
}

export function applyArenaPreferencePatch(key: string, patch: Partial<ArenaPreferences>): void {
  useArenaPreferencesStore.getState().setPreferences(key, patch);
}

export function useArenaPreferences(key: string) {
  const stored = useArenaPreferencesStore((state) => state.byKey[key]);
  const setPreferences = useArenaPreferencesStore((state) => state.setPreferences);
  const battleMode = stored?.battleMode ?? DEFAULT_ARENA_PREFERENCES.battleMode;
  const thinking = stored?.thinking ?? DEFAULT_ARENA_PREFERENCES.thinking;
  const battleModeBeforeConflict = stored?.battleModeBeforeConflict;
  const setBattleMode = useCallback(
    (value: boolean) => setPreferences(key, { battleMode: value }),
    [key, setPreferences],
  );
  const setThinking = useCallback(
    (value: ArenaThinkingLevel) => setPreferences(key, { thinking: value }),
    [key, setPreferences],
  );
  return { battleMode, battleModeBeforeConflict, thinking, setBattleMode, setThinking };
}
