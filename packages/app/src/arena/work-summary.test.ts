import { describe, expect, it } from "vitest";
import {
  arenaPartIsWork,
  arenaRunIsAwaitingResponse,
  arenaRunIsResponding,
  presentArenaWork,
  arenaWorkSummaryLabel,
  projectArenaActivitySegments,
  summarizeArenaWork,
  type ArenaWorkSummary,
} from "./work-summary";

describe("presentArenaWork", () => {
  it.each(["running", "completed"])(
    "shows the latest %s shell even while an older task is unfinished",
    (status) => {
      const task = {
        type: "tool",
        tool: "task",
        state: { status: "running", input: { description: "Explore vote storage" } },
      };
      const shell = {
        type: "tool",
        tool: "bash",
        state: { status, input: { command: "ls docs" } },
      };

      expect(
        presentArenaWork({
          parts: [task, shell],
          runState: "pending",
          isLatest: true,
          awaitingResponse: false,
        }),
      ).toMatchObject({
        kind: "tool",
        label: "Shell",
        secondaryLabel: "ls docs",
        active: status === "running",
      });
    },
  );

  it("does not promote earlier unfinished reasoning over the latest tool", () => {
    expect(
      presentArenaWork({
        parts: [
          { type: "reasoning", text: "Inspecting the result", time: { start: 1 } },
          toolPart("read", { filePath: "app.ts" }),
        ],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toMatchObject({ kind: "tool", label: "Read", secondaryLabel: "app.ts", active: false });
  });

  it("shows thinking during the next empty assistant message instead of a finished tool", () => {
    const run = {
      runState: "pending" as const,
      messages: [
        { id: "previous", role: "assistant", time: { completed: 2 } },
        { id: "next", role: "assistant", time: { created: 3 } },
      ],
      parts: { next: [{ type: "step-start" }] },
    };
    const awaitingResponse = arenaRunIsAwaitingResponse(run);
    expect(awaitingResponse).toBe(true);
    expect(
      presentArenaWork({
        parts: [toolPart("read", { filePath: "app.ts" })],
        runState: run.runState,
        isLatest: true,
        awaitingResponse,
      }),
    ).toEqual({ kind: "reasoning", label: "Thinking…", active: true });
    expect(
      presentArenaWork({ parts: [], runState: run.runState, isLatest: true, awaitingResponse }),
    ).toEqual({ kind: "reasoning", label: "Thinking…", active: true });
    expect(
      presentArenaWork({
        parts: [{ type: "tool", tool: "task", state: { status: "running" } }],
        runState: run.runState,
        isLatest: true,
        awaitingResponse,
      }),
    ).toEqual({ kind: "reasoning", label: "Thinking…", active: true });
  });

  it("keeps historical summaries still even when an old part has no completion timestamp", () => {
    expect(
      presentArenaWork({
        parts: [{ type: "reasoning", text: "Old reasoning" }],
        runState: "pending",
        isLatest: false,
        awaitingResponse: true,
      }),
    ).toEqual({ kind: "summary", label: "Reasoned", active: false });
  });

  it("shows the latest tool until newer content moves its block into history", () => {
    const input = { command: "npm run typecheck" };
    const running = { type: "tool", tool: "bash", state: { status: "running", input } };
    const completed = {
      ...running,
      state: { status: "completed", input, output: "Passed" },
    };
    const before = toolPart("read", { filePath: "README.md" });

    expect(
      presentArenaWork({
        parts: [before, running],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toMatchObject({
      kind: "tool",
      label: "Shell",
      secondaryLabel: "npm run typecheck",
      active: true,
      failed: false,
    });
    expect(
      presentArenaWork({
        parts: [before, completed],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toMatchObject({
      kind: "tool",
      label: "Shell",
      secondaryLabel: "npm run typecheck",
      active: false,
      failed: false,
    });
    expect(
      presentArenaWork({
        parts: [before, completed],
        runState: "pending",
        isLatest: false,
        awaitingResponse: false,
      }),
    ).toEqual({
      kind: "summary",
      label: "Read 1 file · Ran 1 command",
      active: false,
    });
  });

  it("updates the current row to the next tool without aggregating the newest block", () => {
    expect(
      presentArenaWork({
        parts: [
          toolPart("bash", { command: "git status" }),
          toolPart("read", { filePath: "src/app.ts" }),
        ],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toMatchObject({
      kind: "tool",
      label: "Read",
      secondaryLabel: "src/app.ts",
      active: false,
    });
  });

  it("shows current reasoning until a newer block arrives", () => {
    const thinking = { type: "reasoning", text: "Checking", time: { start: 1 } };
    const finished = { ...thinking, time: { start: 1, end: 2 } };
    expect(
      presentArenaWork({
        parts: [thinking],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toEqual({
      kind: "reasoning",
      label: "Reasoning…",
      active: true,
    });
    expect(
      presentArenaWork({
        parts: [finished],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
      }),
    ).toEqual({
      kind: "reasoning",
      label: "Reasoned",
      active: false,
    });
    expect(
      presentArenaWork({
        parts: [finished],
        runState: "pending",
        isLatest: false,
        awaitingResponse: false,
      }),
    ).toEqual({
      kind: "summary",
      label: "Reasoned",
      active: false,
    });
  });

  it.each(["complete", "stopped", "error", "interrupted"] as const)(
    "keeps the newest tool visible without ongoing progress when the run is %s",
    (runState) => {
      expect(
        presentArenaWork({
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: { status: "running", input: { command: "npm run lint" } },
            },
          ],
          runState: runState,
          isLatest: true,
          awaitingResponse: false,
        }),
      ).toMatchObject({
        kind: "tool",
        label: "Shell",
        secondaryLabel: "npm run lint",
        active: false,
        failed: false,
      });
    },
  );

  it("animates Responding while a reply streams after finished reasoning", () => {
    const reasoning = { type: "reasoning", text: "Ready to report", time: { start: 1, end: 2 } };
    expect(
      presentArenaWork({
        parts: [reasoning],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
        responding: true,
      }),
    ).toEqual({ kind: "reasoning", label: "Responding…", active: true });
    expect(
      presentArenaWork({
        parts: [reasoning],
        runState: "stopped",
        isLatest: true,
        awaitingResponse: false,
        responding: true,
      }),
    ).toEqual({ kind: "reasoning", label: "Reasoned", active: false });
  });

  it("shows paths inside the contestant worktree relative to it", () => {
    const worktree = "/repo/.agent-duel/worktrees/turn/generation-1-a";
    expect(
      presentArenaWork({
        parts: [toolPart("write", { filePath: `${worktree}/test/dates.test.js` })],
        runState: "pending",
        isLatest: true,
        awaitingResponse: false,
        cwd: worktree,
      }),
    ).toMatchObject({ kind: "tool", secondaryLabel: "test/dates.test.js" });
  });
});

describe("arenaRunIsResponding", () => {
  const message = { id: "latest", role: "assistant", time: { created: 1 } };
  const reasoning = { type: "reasoning", text: "Ready", time: { start: 1, end: 2 } };

  it("holds while the newest part is unfinished reply text", () => {
    expect(
      arenaRunIsResponding({
        runState: "pending",
        messages: [message],
        parts: { latest: [reasoning, { type: "text", text: "Found", time: { start: 2 } }] },
      }),
    ).toBe(true);
  });

  it("stops once the text ends, a tool follows, the message finishes or the run ends", () => {
    const streaming = { type: "text", text: "Found", time: { start: 2 } };
    const cases = [
      {
        runState: "pending" as const,
        messages: [message],
        parts: { latest: [{ ...streaming, time: { start: 2, end: 3 } }] },
      },
      {
        runState: "pending" as const,
        messages: [message],
        parts: { latest: [streaming, toolPart("read", { filePath: "app.ts" })] },
      },
      {
        runState: "pending" as const,
        messages: [{ ...message, time: { created: 1, completed: 4 } }],
        parts: { latest: [streaming] },
      },
      { runState: "stopped" as const, messages: [message], parts: { latest: [streaming] } },
      { runState: "pending" as const, messages: [message], parts: { latest: [reasoning] } },
    ];
    for (const run of cases) expect(arenaRunIsResponding(run)).toBe(false);
  });
});

describe("arenaRunIsAwaitingResponse", () => {
  it("stops waiting when content arrives or the latest message finishes", () => {
    const message = { id: "latest", role: "assistant", time: { created: 1 } };
    expect(
      arenaRunIsAwaitingResponse({
        runState: "pending",
        messages: [message],
        parts: { latest: [{ type: "text", text: "An update" }] },
      }),
    ).toBe(false);
    expect(
      arenaRunIsAwaitingResponse({
        runState: "pending",
        messages: [message],
        parts: { latest: [{ type: "reasoning", text: "Thinking" }] },
      }),
    ).toBe(false);
    expect(
      arenaRunIsAwaitingResponse({
        runState: "pending",
        messages: [message],
        parts: { latest: [{ type: "tool", tool: "read", state: { status: "pending" } }] },
      }),
    ).toBe(false);
    expect(
      arenaRunIsAwaitingResponse({
        runState: "pending",
        messages: [{ ...message, time: { created: 1, completed: 2 } }],
        parts: { latest: [] },
      }),
    ).toBe(false);
    expect(
      arenaRunIsAwaitingResponse({
        runState: "complete",
        messages: [message],
        parts: { latest: [] },
      }),
    ).toBe(false);
    expect(
      arenaRunIsAwaitingResponse({
        runState: "pending",
        messages: [{ id: "user", role: "user" }],
        parts: {},
      }),
    ).toBe(false);
  });
});

describe("projectArenaActivitySegments", () => {
  it("keeps a question between the work before and after it", () => {
    const before = toolPart("bash", { command: "git remote -v" });
    const question = toolPart("question", { questions: [{ question: "Create a repository?" }] });
    const after = toolPart("bash", { command: "gh repo create" });
    const reply = { type: "text", text: "Created the repository." };
    const segments = projectArenaActivitySegments(["ask", "continue"], {
      ask: [before, question],
      continue: [after, reply],
    });

    expect(segments).toEqual([
      {
        key: "ask:activity",
        content: null,
        trailing: [{ messageId: "ask", partIndex: 0, part: before }],
      },
      {
        key: "ask:1",
        content: { messageId: "ask", partIndex: 1, part: question },
        trailing: [{ messageId: "continue", partIndex: 0, part: after }],
      },
      {
        key: "continue:1",
        content: { messageId: "continue", partIndex: 1, part: reply },
        trailing: [],
      },
    ]);
  });

  it("keeps question positions stable from pending to answered", () => {
    const input = { questions: [{ question: "Which format?" }] };
    const pending = { type: "tool", tool: "question", state: { status: "running", input } };
    const answered = {
      ...pending,
      state: {
        status: "completed",
        input,
        metadata: { answers: [["Markdown"]] },
      },
    };
    const before = { type: "text", text: "Pick a format." };
    const secondQuestion = toolPart("question", { questions: [{ question: "Anything else?" }] });
    const parts = [before, pending, secondQuestion];
    const first = projectArenaActivitySegments(["ask"], { ask: parts });
    const second = projectArenaActivitySegments(["ask"], {
      ask: [before, answered, secondQuestion],
    });

    expect(first.map((segment) => segment.key)).toEqual(["ask:0", "ask:1", "ask:2"]);
    expect(second.map((segment) => segment.key)).toEqual(first.map((segment) => segment.key));
    expect(second.map((segment) => segment.content?.part)).toEqual([
      before,
      answered,
      secondQuestion,
    ]);
    expect(second.every((segment) => segment.trailing.length === 0)).toBe(true);
  });

  it("puts activity beneath the latest text update across message boundaries", () => {
    const reasoningBeforeText = { type: "reasoning", text: "first" };
    const firstText = { type: "text", text: "I am checking the SVG." };
    const firstTool = toolPart("read", { filePath: "icon.svg" });
    const secondReasoning = { type: "reasoning", text: "next" };
    const secondText = { type: "text", text: "I found the white seam." };
    const secondTool = toolPart("edit", { filePath: "icon.svg" });

    const segments = projectArenaActivitySegments(["message-1", "message-2"], {
      "message-1": [reasoningBeforeText, firstText, firstTool],
      "message-2": [secondReasoning, secondText, secondTool],
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].content?.part).toBe(firstText);
    expect(segments[0].trailing.map((entry) => entry.part)).toEqual([
      reasoningBeforeText,
      firstTool,
      secondReasoning,
    ]);
    expect(segments[1].content?.part).toBe(secondText);
    expect(segments[1].trailing.map((entry) => entry.part)).toEqual([secondTool]);
  });

  it("shows one activity-only segment until the first text update arrives", () => {
    const reasoning = { type: "reasoning", text: "working" };
    const tool = toolPart("bash", { command: "npm test" });

    const segments = projectArenaActivitySegments(["message-1"], {
      "message-1": [reasoning, tool],
    });

    expect(segments).toEqual([
      {
        key: "message-1:activity",
        content: null,
        trailing: [
          { messageId: "message-1", partIndex: 0, part: reasoning },
          { messageId: "message-1", partIndex: 1, part: tool },
        ],
      },
    ]);
  });

  it("keeps each text part as its own display segment", () => {
    const firstText = { type: "text", text: "First update" };
    const secondText = { type: "text", text: "Second update" };

    const segments = projectArenaActivitySegments(["message-1"], {
      "message-1": [firstText, secondText],
    });

    expect(segments.map((segment) => segment.content?.part)).toEqual([firstText, secondText]);
  });
});

describe("arenaPartIsWork", () => {
  it("counts tool calls and thinking as work", () => {
    expect(arenaPartIsWork({ type: "tool", tool: "bash" })).toBe(true);
    expect(arenaPartIsWork({ type: "reasoning", text: "considering" })).toBe(true);
    expect(arenaPartIsWork({ type: "thought", text: "considering" })).toBe(true);
  });

  it("leaves the answer itself out of the fold", () => {
    expect(arenaPartIsWork({ type: "text", text: "Done — the CTA now reads…" })).toBe(false);
  });

  it("treats anything unrecognisable as not work", () => {
    expect(arenaPartIsWork(null)).toBe(false);
    expect(arenaPartIsWork(undefined)).toBe(false);
    expect(arenaPartIsWork("tool")).toBe(false);
    expect(arenaPartIsWork([{ type: "tool" }])).toBe(false);
    expect(arenaPartIsWork({ type: 7 })).toBe(false);
    expect(arenaPartIsWork({})).toBe(false);
  });
});

function toolPart(tool: string, input: unknown = {}, output: unknown = "done"): unknown {
  return { type: "tool", tool, state: { input, output } };
}

describe("summarizeArenaWork", () => {
  it("summarizes tool categories and deduplicates file paths", () => {
    const summary = summarizeArenaWork([
      toolPart("read", { filePath: "src/app.ts" }),
      toolPart("read", { filePath: "src/app.ts" }),
      toolPart("read", { filePath: "src/theme.ts" }),
      toolPart("bash", { command: "npm test" }),
      toolPart("bash", { command: "npm run lint" }),
      toolPart("write", { filePath: "src/app.ts", content: "new" }),
      toolPart("edit", { filePath: "src/app.ts", oldString: "old", newString: "new" }),
      toolPart("glob", { pattern: "src/**/*.ts" }),
      toolPart("question", { questions: ["continue?"] }),
      { type: "reasoning", text: "checking" },
    ]);

    expect(summary).toEqual({
      editedFileCount: 1,
      readFileCount: 2,
      commandCount: 2,
      searchCount: 1,
      otherToolCount: 1,
      reasoningCount: 1,
    });
  });

  it("falls back to other tools and counts both reasoning part kinds", () => {
    expect(
      summarizeArenaWork([
        toolPart("mystery_tool"),
        { type: "reasoning", text: "one" },
        { type: "thought", text: "two" },
      ]),
    ).toEqual({
      editedFileCount: 0,
      readFileCount: 0,
      commandCount: 0,
      searchCount: 0,
      otherToolCount: 1,
      reasoningCount: 2,
    });
  });
});

describe("arenaWorkSummaryLabel", () => {
  it("uses concise completed labels in a stable order", () => {
    const summary: ArenaWorkSummary = {
      editedFileCount: 1,
      readFileCount: 3,
      commandCount: 2,
      searchCount: 0,
      otherToolCount: 0,
      reasoningCount: 4,
    };

    expect(arenaWorkSummaryLabel(summary, false)).toBe(
      "Read 3 files · Ran 2 commands · Edited 1 file",
    );
  });

  it("uses present-progress labels while active", () => {
    const summary = summarizeArenaWork([toolPart("read", { filePath: "README.md" })]);
    expect(arenaWorkSummaryLabel(summary, true)).toBe("Reading 1 file");
  });

  it("labels searches as actions rather than exposing reasoning alongside them", () => {
    const summary = summarizeArenaWork([
      toolPart("glob", { pattern: "src/**/*.ts" }),
      toolPart("grep", { pattern: "activity" }),
      { type: "reasoning", text: "checking" },
    ]);

    expect(arenaWorkSummaryLabel(summary, false)).toBe("Ran 2 searches");
    expect(arenaWorkSummaryLabel(summary, true)).toBe("Running 2 searches");
  });

  it("uses Reasoned when reasoning is the only completed work", () => {
    const summary = summarizeArenaWork([{ type: "thought", text: "checking" }]);
    expect(arenaWorkSummaryLabel(summary, false)).toBe("Reasoned");
  });
});
