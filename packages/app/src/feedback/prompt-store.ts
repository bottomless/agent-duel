import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  considerFeedbackPrompt,
  createFeedbackPromptSchedule,
  finishFeedbackPrompt,
  recordFeedbackMessageSent as incrementFeedbackMessageCount,
  type FeedbackPromptSchedule,
} from "./prompt-schedule";

interface FeedbackPromptState {
  schedule: FeedbackPromptSchedule;
  hydrated: boolean;
  recordMessageSent: () => void;
  consider: (battleId: string) => void;
  finish: (battleId: string) => void;
  markHydrated: () => void;
}

const useFeedbackPromptStore = create<FeedbackPromptState>()(
  persist(
    (set) => ({
      schedule: createFeedbackPromptSchedule(Math.random),
      hydrated: false,
      recordMessageSent: () =>
        set((state) => ({ schedule: incrementFeedbackMessageCount(state.schedule) })),
      consider: (battleId) =>
        set((state) => {
          const transition = considerFeedbackPrompt(state.schedule, battleId, Math.random);
          if (transition.schedule === state.schedule) return state;
          return { schedule: transition.schedule };
        }),
      finish: (battleId) =>
        set((state) => {
          const schedule = finishFeedbackPrompt(state.schedule, battleId);
          if (schedule === state.schedule) return state;
          return { schedule };
        }),
      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "@paseo:feedback-prompt-v2",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ schedule: state.schedule }),
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);

export function recordFeedbackMessageSent(): void {
  useFeedbackPromptStore.getState().recordMessageSent();
}

export function useChatFeedbackPrompt(input: { battleId: string; enabled: boolean }) {
  const schedule = useFeedbackPromptStore((state) => state.schedule);
  const hydrated = useFeedbackPromptStore((state) => state.hydrated);
  const consider = useFeedbackPromptStore((state) => state.consider);
  const finish = useFeedbackPromptStore((state) => state.finish);
  useEffect(() => {
    if (!hydrated || !input.enabled) return;
    consider(input.battleId);
  }, [
    consider,
    hydrated,
    input.battleId,
    input.enabled,
    schedule.nextPromptMessageCount,
    schedule.totalMessagesSent,
  ]);
  const finishCurrent = useCallback(() => finish(input.battleId), [finish, input.battleId]);
  return {
    show: schedule.activeBattleId === input.battleId,
    finish: finishCurrent,
  };
}
