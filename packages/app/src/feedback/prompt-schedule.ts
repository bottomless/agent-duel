export const FIRST_PROMPT_MESSAGE_RANGE = { minimum: 5, maximum: 10 } as const;
export const NEXT_PROMPT_MESSAGE_RANGE = { minimum: 10, maximum: 25 } as const;

export interface FeedbackPromptSchedule {
  totalMessagesSent: number;
  nextPromptMessageCount: number;
  activeBattleId: string | null;
}

interface PromptTransition {
  schedule: FeedbackPromptSchedule;
  show: boolean;
}

interface IntegerRange {
  minimum: number;
  maximum: number;
}

function randomInteger(range: IntegerRange, random: () => number): number {
  return range.minimum + Math.floor(random() * (range.maximum - range.minimum + 1));
}

export function createFeedbackPromptSchedule(random: () => number): FeedbackPromptSchedule {
  return {
    totalMessagesSent: 0,
    nextPromptMessageCount: randomInteger(FIRST_PROMPT_MESSAGE_RANGE, random),
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
  random: () => number,
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
      nextPromptMessageCount:
        availableSchedule.totalMessagesSent + randomInteger(NEXT_PROMPT_MESSAGE_RANGE, random),
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
