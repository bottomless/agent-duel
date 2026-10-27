const FIRST_PROMPT_MESSAGE_COUNT = 10;

export interface FeedbackPromptSchedule {
  totalMessagesSent: number;
  nextPromptMessageCount: number;
  activeBattleId: string | null;
}

interface PromptTransition {
  schedule: FeedbackPromptSchedule;
  show: boolean;
}

export function createFeedbackPromptSchedule(): FeedbackPromptSchedule {
  return {
    totalMessagesSent: 0,
    nextPromptMessageCount: FIRST_PROMPT_MESSAGE_COUNT,
    activeBattleId: null,
  };
}

export function recordFeedbackMessageSent(
  schedule: FeedbackPromptSchedule,
): FeedbackPromptSchedule {
  return { ...schedule, totalMessagesSent: schedule.totalMessagesSent + 1 };
}

export function considerFeedbackPrompt(
  schedule: FeedbackPromptSchedule,
  battleId: string,
): PromptTransition {
  if (schedule.activeBattleId === battleId) {
    return { schedule, show: true };
  }

  const availableSchedule = schedule.activeBattleId
    ? { ...schedule, activeBattleId: null }
    : schedule;
  if (availableSchedule.totalMessagesSent < availableSchedule.nextPromptMessageCount) {
    return { schedule: availableSchedule, show: false };
  }

  return {
    schedule: {
      ...availableSchedule,
      nextPromptMessageCount: availableSchedule.totalMessagesSent * 2 + FIRST_PROMPT_MESSAGE_COUNT,
      activeBattleId: battleId,
    },
    show: true,
  };
}

export function finishFeedbackPrompt(
  schedule: FeedbackPromptSchedule,
  battleId: string,
): FeedbackPromptSchedule {
  if (schedule?.activeBattleId !== battleId) return schedule;
  return { ...schedule, activeBattleId: null };
}
