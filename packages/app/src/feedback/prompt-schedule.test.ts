import { describe, expect, it } from "vitest";
import {
  considerFeedbackPrompt,
  createFeedbackPromptSchedule,
  finishFeedbackPrompt,
  recordFeedbackMessageSent,
  type FeedbackPromptSchedule,
} from "./prompt-schedule";

describe("feedback prompt schedule", () => {
  it("picks the first prompt after five to ten total messages", () => {
    expect(createFeedbackPromptSchedule(() => 0)).toEqual({
      totalMessagesSent: 0,
      nextPromptMessageCount: 5,
      activeBattleId: null,
    });
    expect(createFeedbackPromptSchedule(() => 0.99)).toEqual({
      totalMessagesSent: 0,
      nextPromptMessageCount: 10,
      activeBattleId: null,
    });
  });

  it("counts sent messages globally without reference to an agent or session", () => {
    const initial = createFeedbackPromptSchedule(() => 0);
    expect(recordFeedbackMessageSent(recordFeedbackMessageSent(initial))).toEqual({
      totalMessagesSent: 2,
      nextPromptMessageCount: 5,
      activeBattleId: null,
    });
  });

  it("schedules the next appearance ten to twenty-five messages after showing", () => {
    const due: FeedbackPromptSchedule = {
      totalMessagesSent: 6,
      nextPromptMessageCount: 6,
      activeBattleId: null,
    };
    expect(considerFeedbackPrompt(due, "battle-2", () => 0)).toEqual({
      schedule: {
        totalMessagesSent: 6,
        nextPromptMessageCount: 16,
        activeBattleId: "battle-2",
      },
      show: true,
    });
    expect(considerFeedbackPrompt(due, "battle-2", () => 0.99)).toEqual({
      schedule: {
        totalMessagesSent: 6,
        nextPromptMessageCount: 31,
        activeBattleId: "battle-2",
      },
      show: true,
    });
  });

  it("advances the schedule when shown even if the user ignores it", () => {
    const active: FeedbackPromptSchedule = {
      totalMessagesSent: 16,
      nextPromptMessageCount: 16,
      activeBattleId: "battle-2",
    };
    expect(considerFeedbackPrompt(active, "battle-3", () => 0)).toEqual({
      schedule: {
        totalMessagesSent: 16,
        nextPromptMessageCount: 26,
        activeBattleId: "battle-3",
      },
      show: true,
    });
  });

  it("does not change the next threshold when a prompt is dismissed or submitted", () => {
    const active: FeedbackPromptSchedule = {
      totalMessagesSent: 7,
      nextPromptMessageCount: 17,
      activeBattleId: "battle-2",
    };
    expect(finishFeedbackPrompt(active, "battle-1")).toBe(active);
    expect(finishFeedbackPrompt(active, "battle-2")).toEqual({
      totalMessagesSent: 7,
      nextPromptMessageCount: 17,
      activeBattleId: null,
    });
  });
});
