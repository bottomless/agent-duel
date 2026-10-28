import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface LeaderboardPreferencesState {
  excludeEarlyVotes: boolean;
  setExcludeEarlyVotes: (excludeEarlyVotes: boolean) => void;
}

export const useLeaderboardPreferences = create<LeaderboardPreferencesState>()(
  persist(
    (set) => ({
      excludeEarlyVotes: false,
      setExcludeEarlyVotes: (excludeEarlyVotes) => set({ excludeEarlyVotes }),
    }),
    {
      name: "@paseo:leaderboard-preferences-v1",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ excludeEarlyVotes: state.excludeEarlyVotes }),
    },
  ),
);
