import { describe, expect, it } from "vitest";
import {
  considerFeedbackPrompt,
  createFeedbackPromptSchedule,
  finishFeedbackPrompt,
  recordFeedbackMessageSent,
  type FeedbackPromptSchedule,
} from "./prompt-schedule";

describe("feedback prompt schedule", () => {
  it("doubles the message gap after each appearance", () => {
    let schedule = createFeedbackPromptSchedule();
    const appearances: number[] = [];
    for (let message = 1; message <= 310; message += 1) {
      schedule = recordFeedbackMessageSent(schedule);
      const battleId = `battle-${message}`;
      const transition = considerFeedbackPrompt(schedule, battleId);
      schedule = transition.schedule;
      if (transition.show) appearances.push(message);
    }
    expect(appearances).toEqual([10, 30, 70, 150, 310]);
  });

  it("schedules the first prompt after ten total messages", () => {
    expect(createFeedbackPromptSchedule()).toEqual({
      totalMessagesSent: 0,
      nextPromptMessageCount: 10,
      activeBattleId: null,
    });
  });

  it("counts sent messages globally without reference to an agent or session", () => {
    const initial = createFeedbackPromptSchedule();
    expect(recordFeedbackMessageSent(recordFeedbackMessageSent(initial))).toEqual({
      totalMessagesSent: 2,
      nextPromptMessageCount: 10,
      activeBattleId: null,
    });
  });

  it("backs off from the actual message count when a prompt appears late", () => {
    const due: FeedbackPromptSchedule = {
      totalMessagesSent: 15,
      nextPromptMessageCount: 10,
      activeBattleId: null,
    };
    expect(considerFeedbackPrompt(due, "battle-2")).toEqual({
      schedule: {
        totalMessagesSent: 15,
        nextPromptMessageCount: 40,
        activeBattleId: "battle-2",
      },
      show: true,
    });
  });

  it("advances the schedule when shown even if the user ignores it", () => {
    const active: FeedbackPromptSchedule = {
      totalMessagesSent: 30,
      nextPromptMessageCount: 30,
      activeBattleId: "battle-2",
    };
    expect(considerFeedbackPrompt(active, "battle-3")).toEqual({
      schedule: {
        totalMessagesSent: 30,
        nextPromptMessageCount: 70,
        activeBattleId: "battle-3",
      },
      show: true,
    });
  });

  it("keeps a visible prompt without advancing the schedule again", () => {
    const active: FeedbackPromptSchedule = {
      totalMessagesSent: 10,
      nextPromptMessageCount: 30,
      activeBattleId: "battle-2",
    };
    const transition = considerFeedbackPrompt(active, "battle-2");
    expect(transition).toEqual({ schedule: active, show: true });
    expect(transition.schedule).toBe(active);
  });

  it("does not change the next threshold when a prompt is dismissed or submitted", () => {
    const active: FeedbackPromptSchedule = {
      totalMessagesSent: 10,
      nextPromptMessageCount: 30,
      activeBattleId: "battle-2",
    };
    expect(finishFeedbackPrompt(active, "battle-1")).toBe(active);
    expect(finishFeedbackPrompt(active, "battle-2")).toEqual({
      totalMessagesSent: 10,
      nextPromptMessageCount: 30,
      activeBattleId: null,
    });
  });
});
