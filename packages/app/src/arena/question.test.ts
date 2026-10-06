import { describe, expect, test } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  arenaPendingQuestions,
  arenaQuestionAnswers,
  arenaQuestionResult,
  arenaTimelineQuestionResult,
} from "./question";

function runWithQuestions(questions: unknown[]): ArenaRun {
  return {
    id: "run-a",
    side: "a",
    sessionID: "session-a",
    descendantSessionIDs: [],
    worktree: "/repo-a",
    worktreeName: "repo-a",
    worktreeActive: true,
    runState: "pending",
    durationMs: 1,
    selectable: false,
    applicable: false,
    questions,
  };
}

describe("Arena contestant questions", () => {
  test("renders the same answers after a winner enters the canonical timeline", () => {
    expect(
      arenaTimelineQuestionResult({
        kind: "tool_call",
        id: "question-1",
        timestamp: new Date(0),
        payload: {
          source: "agent",
          data: {
            provider: "opencode",
            callId: "question-1",
            name: "question",
            status: "completed",
            error: null,
            detail: {
              type: "unknown",
              input: { questions: [{ question: "Create the repo?" }] },
              output: "Answered",
            },
            metadata: { answers: [["public and call it WeatherRibbon"]] },
          },
        },
      }),
    ).toEqual({
      interrupted: false,
      questions: [{ question: "Create the repo?", answers: ["public and call it WeatherRibbon"] }],
    });
  });
  test("recovers an answered exchange from the saved tool part without a pending request", () => {
    expect(
      arenaQuestionResult({
        type: "tool",
        tool: "question",
        state: {
          status: "completed",
          input: { questions: [{ question: "Should I create a repo under micjm?" }] },
          metadata: { answers: [["public and call it WeatherRibbon"]] },
        },
      }),
    ).toEqual({
      interrupted: false,
      questions: [
        {
          question: "Should I create a repo under micjm?",
          answers: ["public and call it WeatherRibbon"],
        },
      ],
    });
  });

  test("preserves ordered multiple answers, free text, and unanswered questions", () => {
    expect(
      arenaQuestionResult({
        type: "tool",
        tool: "question",
        state: {
          status: "completed",
          input: {
            questions: [
              { question: "Which files?" },
              { question: "Anything else?" },
              { question: "Which license?" },
            ],
          },
          metadata: {
            answers: [["README", "License"], ["Keep commas, punctuation\nand line breaks."], []],
          },
        },
      }),
    ).toEqual({
      interrupted: false,
      questions: [
        { question: "Which files?", answers: ["README", "License"] },
        { question: "Anything else?", answers: ["Keep commas, punctuation\nand line breaks."] },
        { question: "Which license?", answers: [] },
      ],
    });
  });

  test("keeps interrupted questions visible without inventing an answer", () => {
    expect(
      arenaQuestionResult({
        type: "tool",
        tool: "question",
        state: {
          status: "error",
          input: { questions: [{ question: "Continue?" }] },
          error: "The user dismissed this question",
        },
      }),
    ).toEqual({
      interrupted: true,
      questions: [{ question: "Continue?", answers: [] }],
    });
  });

  test.each([
    { status: "running", input: { questions: [{ question: "Continue?" }] } },
    { status: "completed", input: { questions: [{ question: "Continue?" }] } },
    { status: "completed", input: { questions: [{}] }, metadata: { answers: [["Yes"]] } },
    { status: "completed", input: { questions: [] }, metadata: { answers: [] } },
    {
      status: "completed",
      input: { questions: [{ question: "Continue?" }] },
      metadata: { answers: [42] },
    },
  ])("leaves pending or unavailable results to the existing renderer: %j", (state) => {
    expect(arenaQuestionResult({ type: "tool", tool: "question", state })).toBeNull();
  });

  test("does not interpret another tool as a question exchange", () => {
    expect(
      arenaQuestionResult({
        type: "tool",
        tool: "custom",
        state: {
          status: "completed",
          input: { questions: [{ question: "Continue?" }] },
          metadata: { answers: [["Yes"]] },
        },
      }),
    ).toBeNull();
  });

  test("adapts an OpenCode question to the normal thread form", () => {
    const [question] = arenaPendingQuestions(
      runWithQuestions([
        {
          id: "que_1",
          sessionID: "session-a",
          tool: { messageID: "msg_1", callID: "call_1" },
          questions: [
            {
              header: "Format",
              question: "Which format should I use?",
              multiple: false,
              custom: true,
              options: [{ label: "Markdown", description: "Use Markdown" }],
            },
          ],
        },
      ]),
    );

    expect(question?.permission.request).toMatchObject({
      id: "que_1",
      provider: "opencode",
      kind: "question",
      input: {
        questions: [
          {
            header: "Format",
            question: "Which format should I use?",
            multiSelect: false,
            allowOther: true,
          },
        ],
      },
    });
    expect(question?.toolCallId).toBe("call_1");
  });

  test("maps form responses back to ordered OpenCode answer arrays", () => {
    const [question] = arenaPendingQuestions(
      runWithQuestions([
        {
          id: "que_2",
          questions: [
            {
              header: "Files",
              question: "Which files?",
              multiple: true,
              options: [{ label: "README" }, { label: "License" }],
            },
            { header: "Note", question: "Anything else?", options: [] },
          ],
        },
      ]),
    );

    expect(
      question &&
        arenaQuestionAnswers(question, {
          behavior: "allow",
          updatedInput: {
            answers: { Files: "README, License", Note: "Keep it short" },
          },
        }),
    ).toEqual([["README", "License"], ["Keep it short"]]);
    expect(question && arenaQuestionAnswers(question, { behavior: "deny" })).toBeNull();
  });

  test("ignores malformed question payloads", () => {
    expect(arenaPendingQuestions(runWithQuestions([{ id: "que_bad", questions: [{}] }]))).toEqual(
      [],
    );
  });
});
