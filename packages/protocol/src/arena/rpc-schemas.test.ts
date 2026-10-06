import { describe, expect, it } from "vitest";
import {
  ArenaRunQuestionRejectRequestSchema,
  ArenaRunQuestionReplyRequestSchema,
  ArenaSingleAgentVoteRequestSchema,
  ArenaSnapshotSchema,
  ArenaTurnReplyRequestSchema,
  ArenaTurnRetryResolutionRequestSchema,
  ArenaTurnStartRequestSchema,
  ArenaTurnVoteRequestSchema,
} from "./rpc-schemas.js";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";

function snapshot() {
  return {
    chat: {
      id: "chat-1",
      status: "battle_active",
      canonicalSessionID: "session-1",
      canonicalSHA: "abc123",
      activeTurnID: "turn-1",
      trunk: { worktreeName: "project", branch: "main" },
    },
    environment: {},
    turn: {
      id: "turn-1",
      index: 1,
      prompt: "Implement the feature",
      baseSHA: "abc123",
      state: "running",
      comparisonState: "pending",
      canVote: false,
      canRetryResolution: false,
      revealed: false,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    },
    history: [],
    runs: [
      {
        id: "run-a",
        side: "a",
        sessionID: "session-a",
        descendantSessionIDs: [],
        worktree: "/tmp/a",
        worktreeName: "generation-1-a",
        worktreeActive: true,
        runState: "pending",
        durationMs: null,
        selectable: false,
        applicable: false,
        messages: [{ id: "message-a", role: "assistant" }],
        parts: { "message-a": [{ type: "text", text: "Working" }] },
      },
    ],
    events: [],
  };
}

describe("Arena RPC schemas", () => {
  it("retains hydrated blind transcripts without requiring revealed identities", () => {
    const parsed = ArenaSnapshotSchema.parse(snapshot());
    expect(parsed.runs[0]?.messages).toHaveLength(1);
    expect(parsed.runs[0]?.identity).toBeUndefined();
  });

  it("distinguishes an intentionally skipped comparison from a failed one", () => {
    const input = snapshot();
    input.turn.comparisonState = "skipped";
    const parsed = ArenaSnapshotSchema.parse(input);
    expect(parsed.turn?.comparisonState).toBe("skipped");
  });

  it("keeps the trunk merge conflicts of a ready chat", () => {
    const parsed = ArenaSnapshotSchema.parse({
      ...snapshot(),
      chat: {
        ...snapshot().chat,
        status: "ready",
        activeTurnID: undefined,
        trunkConflicts: ["src/a.ts"],
      },
    });
    expect(parsed.chat.trunkConflicts).toEqual(["src/a.ts"]);
    expect(ArenaSnapshotSchema.parse(snapshot()).chat.trunkConflicts).toBeUndefined();
    expect(() =>
      ArenaSnapshotSchema.parse({
        ...snapshot(),
        chat: { ...snapshot().chat, trunkConflicts: [7] },
      }),
    ).toThrow();
  });

  it("projects the current retained winner and warmed successor environments", () => {
    const current = ArenaSnapshotSchema.parse({
      ...snapshot(),
      chat: {
        ...snapshot().chat,
        trunk: { worktreeName: "project", branch: "main" },
        blockedReason: "The trunk worktree is unavailable.",
      },
      environment: {
        retainedWinner: {
          runID: "run-a",
          side: "a",
          worktreeName: "generation-1-a",
          branch: "main",
          state: "live",
        },
        warmPair: {
          generation: 2,
          state: "ready",
          sides: [
            { side: "a", worktreeName: "generation-2-a", branch: "main", ready: true },
            { side: "b", worktreeName: "generation-2-b", branch: "main", ready: true },
          ],
        },
      },
      turn: {
        ...snapshot().turn,
        gitApplication: { state: "applied", conflicts: [] },
        transition: {
          id: "transition-1",
          previousWinningRunID: "run-old",
          stoppedCommands: [
            {
              command: "npm run dev",
              relativeCwd: ".",
              status: "stopped",
              verified: true,
              listeners: [
                { alias: "PASEO_PORT" },
                { alias: "PASEO_PORT2" },
                { alias: "PASEO_PORT3" },
              ],
            },
          ],
          copyOmissions: [{ relativePath: "cache.bin", omissionReason: "ignored_file_too_large" }],
          summary: {
            commandsStopped: 1,
            commandsAlreadyAbsent: 0,
            stopFailures: 0,
            listenersReleased: 3,
            pathsOmitted: 1,
          },
          createdAt: "2026-08-12T00:00:02.000Z",
        },
      },
      runs: [
        {
          ...snapshot().runs[0],
          worktreeName: "generation-1-a",
          branchAtRun: "main",
          worktreeActive: true,
          copyOmissions: [{ relativePath: "cache.bin", omissionReason: "ignored_file_too_large" }],
          portAliases: { PASEO_PORT: 43121 },
          services: [
            {
              kind: "owned_process",
              command: "npm run dev",
              relativeCwd: ".",
              listeners: [{ port: 43121, alias: "PASEO_PORT" }],
              proxyRoutes: [{ hostname: "a.localhost", active: true }],
            },
          ],
          retention: "retained_until_next_send",
        },
      ],
    });
    expect(current.chat.trunk?.worktreeName).toBe("project");
    expect(current.chat.blockedReason).toBe("The trunk worktree is unavailable.");
    expect(current.environment.retainedWinner?.state).toBe("live");
    expect(current.environment.warmPair?.sides).toHaveLength(2);
    expect(current.runs[0]?.copyOmissions?.[0]?.relativePath).toBe("cache.bin");
    expect(current.turn?.transition?.summary.pathsOmitted).toBe(1);
    expect(current.turn?.transition?.summary.listenersReleased).toBe(3);
    expect(current.turn?.transition?.stoppedCommands[0]?.listeners).toHaveLength(3);
  });

  it("keeps participant identity out of browser requests", () => {
    const start = ArenaTurnStartRequestSchema.parse({
      type: "arena.turn.start.request",
      requestId: "request-1",
      agentId: "agent-1",
      chatId: "chat-1",
      prompt: "Build it",
      participantID: "browser-must-not-supply-this",
    });
    const vote = ArenaTurnVoteRequestSchema.parse({
      type: "arena.turn.vote.request",
      requestId: "request-2",
      agentId: "agent-1",
      turnId: "turn-1",
      vote: "a",
      participantID: "browser-must-not-supply-this",
    });
    const singleAgentVote = ArenaSingleAgentVoteRequestSchema.parse({
      type: "arena.single_agent.vote.request",
      requestId: "request-3",
      agentId: "agent-1",
      ratingId: "rating-1",
      vote: "up",
      participantID: "browser-must-not-supply-this",
    });
    expect("participantId" in start).toBe(false);
    expect("participantId" in vote).toBe(false);
    expect("participantID" in start).toBe(false);
    expect("participantID" in vote).toBe(false);
    expect("participantID" in singleAgentVote).toBe(false);
  });

  it("keeps the single-agent identity hidden until a thumbs vote is present", () => {
    const hidden = ArenaSnapshotSchema.parse({
      ...snapshot(),
      singleAgent: { id: "single-agent-1", revealed: false },
    });
    expect(hidden.singleAgent).toEqual({ id: "single-agent-1", revealed: false });

    const revealed = ArenaSnapshotSchema.parse({
      ...snapshot(),
      singleAgent: {
        id: "single-agent-1",
        revealed: true,
        vote: "down",
        identity: { name: "Qwen 3.8 Max" },
      },
    });
    expect(revealed.singleAgent).toEqual({
      id: "single-agent-1",
      revealed: true,
      vote: "down",
      identity: { name: "Qwen 3.8 Max" },
    });
  });

  it("validates reply targets for an active battle", () => {
    expect(
      ArenaTurnReplyRequestSchema.parse({
        type: "arena.turn.reply.request",
        requestId: "request-reply",
        agentId: "agent-1",
        turnId: "turn-1",
        prompt: "Check the edge case",
        target: "both",
      }).target,
    ).toBe("both");
    expect(() =>
      ArenaTurnReplyRequestSchema.parse({
        type: "arena.turn.reply.request",
        requestId: "request-reply-bad",
        agentId: "agent-1",
        turnId: "turn-1",
        prompt: "Check the edge case",
        target: "all",
      }),
    ).toThrow();
  });

  it("accepts discarding the winner as a separate divergence choice", () => {
    const request = ArenaTurnRetryResolutionRequestSchema.parse({
      type: "arena.turn.retry_resolution.request",
      requestId: "discard-winner",
      agentId: "agent-1",
      turnId: "turn-1",
      mode: "discard_winner",
    });
    expect(request.mode).toBe("discard_winner");
    const current = snapshot();
    const parsed = ArenaSnapshotSchema.parse({
      ...current,
      turn: { ...current.turn, state: "discarded", gitApplication: { state: "discarded" } },
    });
    expect(parsed.turn?.gitApplication?.state).toBe("discarded");
  });

  it("validates retry-resolution requests", () => {
    expect(
      ArenaTurnRetryResolutionRequestSchema.parse({
        type: "arena.turn.retry_resolution.request",
        requestId: "request-retry-resolution",
        agentId: "agent-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      type: "arena.turn.retry_resolution.request",
      requestId: "request-retry-resolution",
      agentId: "agent-1",
      turnId: "turn-1",
    });
  });

  it("validates contestant question responses", () => {
    expect(
      ArenaRunQuestionReplyRequestSchema.parse({
        type: "arena.run.question.reply.request",
        requestId: "request-3",
        agentId: "agent-1",
        runId: "run-a",
        questionRequestId: "que_1",
        answers: [["Markdown"], ["Short"]],
      }).answers,
    ).toEqual([["Markdown"], ["Short"]]);
    expect(() =>
      ArenaRunQuestionReplyRequestSchema.parse({
        type: "arena.run.question.reply.request",
        requestId: "request-4",
        agentId: "agent-1",
        runId: "run-a",
        questionRequestId: "que_1",
        answers: ["Markdown"],
      }),
    ).toThrow();
    expect(
      ArenaRunQuestionRejectRequestSchema.parse({
        type: "arena.run.question.reject.request",
        requestId: "request-5",
        agentId: "agent-1",
        runId: "run-a",
        questionRequestId: "que_1",
      }).questionRequestId,
    ).toBe("que_1");
  });

  it("carries the BYOK key and its status over the session channel", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "arena.byok.key.set.request",
        requestId: "request-set",
        key: "sk-or-v1-test",
      }),
    ).toEqual({
      type: "arena.byok.key.set.request",
      requestId: "request-set",
      key: "sk-or-v1-test",
    });
    expect(
      SessionInboundMessageSchema.parse({
        type: "arena.byok.key.set.request",
        requestId: "request-clear",
        key: null,
      }),
    ).toEqual({ type: "arena.byok.key.set.request", requestId: "request-clear", key: null });
    expect(() =>
      SessionInboundMessageSchema.parse({ type: "arena.byok.key.set.request", requestId: "r" }),
    ).toThrow();
    expect(
      SessionOutboundMessageSchema.parse({
        type: "arena.byok.status.get.response",
        payload: { requestId: "request-status", available: true, configured: false },
      }),
    ).toEqual({
      type: "arena.byok.status.get.response",
      payload: { requestId: "request-status", available: true, configured: false },
    });
  });
});
