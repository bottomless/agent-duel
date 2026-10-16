import { describe, expect, it } from "vitest";
import { createFeedbackContextCapture } from "./context.js";

const feedback = {
  id: "9d5b3081-70b8-4d51-82d4-5d76035ea62f",
  source: "chat" as const,
  rating: "great" as const,
  battleId: "battle-1",
  agentId: "agent-1",
  workspaceId: "workspace-1",
};

function agent(workspaceId: string) {
  return {
    id: "agent-1",
    workspaceId,
    provider: "opencode" as const,
    cwd: "/repo",
    persistence: { sessionId: "session-1" },
  };
}

const userMessage = {
  seq: 1,
  timestamp: "2026-09-22T09:58:00.000Z",
  item: { type: "user_message" as const, text: "bug" },
};

const notGit = {
  getSnapshot: async () => ({
    git: {
      isGit: false,
      repoRoot: null,
      mainRepoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
  }),
};

describe("feedback context", () => {
  it("captures the canonical timeline and a fresh git status", async () => {
    const capture = createFeedbackContextCapture({
      agents: {
        getAgent: () => ({
          id: "agent-1",
          workspaceId: "workspace-1",
          provider: "codex",
          cwd: "/repo",
          persistence: { sessionId: "session-1" },
        }),
        getTimelineRows: async () => [
          {
            seq: 4,
            timestamp: "2026-09-22T09:59:00.000Z",
            item: {
              type: "tool_call",
              callId: "call-1",
              name: "Shell",
              status: "completed",
              error: null,
              detail: { type: "shell", command: "npm test", output: "passed", exitCode: 0 },
            },
          },
        ],
      },
      storage: { get: async () => ({ workspaceId: "workspace-1" }) },
      loadAgent: async () => {
        throw new Error("The agent is already loaded");
      },
      git: {
        getSnapshot: async () => ({
          git: {
            isGit: true,
            repoRoot: "/repo",
            mainRepoRoot: "/repo",
            currentBranch: "main",
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            isDirty: true,
            baseRef: "main",
            aheadBehind: { ahead: 1, behind: 0 },
            upstreamRef: "refs/remotes/origin/main",
            aheadOfOrigin: 1,
            behindOfOrigin: 0,
            hasRemote: true,
            diffStat: { additions: 3, deletions: 1 },
          },
        }),
      },
      readGitStatus: async () => "## main...origin/main [ahead 1]\n M src/app.ts",
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });

    await expect(capture.capture(feedback)).resolves.toEqual({
      version: 1,
      capturedAt: "2026-09-22T10:00:00.000Z",
      agent: { id: "agent-1", provider: "codex", sessionId: "session-1" },
      timeline: [
        {
          seq: 4,
          timestamp: "2026-09-22T09:59:00.000Z",
          item: {
            type: "tool_call",
            callId: "call-1",
            name: "Shell",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "npm test", output: "passed", exitCode: 0 },
          },
        },
      ],
      git: {
        kind: "git",
        branch: "main",
        baseRef: "main",
        upstreamRef: "refs/remotes/origin/main",
        isDirty: true,
        aheadBehind: { ahead: 1, behind: 0 },
        diffStat: { additions: 3, deletions: 1 },
        status: "## main...origin/main [ahead 1]\n M src/app.ts",
      },
    });
  });

  it("loads an agent the daemon does not hold, such as one archived since the battle", async () => {
    const loaded: string[] = [];
    let live: ReturnType<typeof agent> | null = null;
    const capture = createFeedbackContextCapture({
      agents: {
        getAgent: () => live,
        getTimelineRows: async () => (live ? [userMessage] : []),
      },
      storage: { get: async () => ({ workspaceId: "workspace-1" }) },
      loadAgent: async (id) => {
        loaded.push(id);
        live = agent("workspace-1");
        return live;
      },
      git: notGit,
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });

    const context = await capture.capture(feedback);

    expect(loaded).toEqual(["agent-1"]);
    expect(context.timeline).toEqual([userMessage]);
    expect(context.git).toEqual({ kind: "not_git" });
  });

  it("accepts the workspace an unarchive moved the agent to", async () => {
    const capture = createFeedbackContextCapture({
      agents: { getAgent: () => agent("workspace-2"), getTimelineRows: async () => [userMessage] },
      storage: { get: async () => ({ workspaceId: "workspace-1" }) },
      loadAgent: async () => {
        throw new Error("The agent is already loaded");
      },
      git: notGit,
    });

    await expect(capture.capture(feedback)).resolves.toMatchObject({ timeline: [userMessage] });
  });

  it("refuses to capture a different workspace", async () => {
    const capture = createFeedbackContextCapture({
      agents: { getAgent: () => agent("workspace-2"), getTimelineRows: async () => [] },
      storage: { get: async () => ({ workspaceId: "workspace-2" }) },
      loadAgent: async () => agent("workspace-2"),
      git: notGit,
    });

    await expect(capture.capture(feedback)).rejects.toThrow(
      "Feedback agent belongs to another workspace",
    );
  });

  it("says when the agent does not exist", async () => {
    const capture = createFeedbackContextCapture({
      agents: { getAgent: () => null, getTimelineRows: async () => [] },
      storage: { get: async () => null },
      loadAgent: async () => agent("workspace-1"),
      git: notGit,
    });

    await expect(capture.capture(feedback)).rejects.toThrow("Feedback agent was not found");
  });

  it("says why an agent could not be loaded", async () => {
    const capture = createFeedbackContextCapture({
      agents: { getAgent: () => null, getTimelineRows: async () => [] },
      storage: { get: async () => ({ workspaceId: "workspace-1" }) },
      loadAgent: async () => {
        throw new Error("OpenCode session is gone");
      },
      git: notGit,
    });

    await expect(capture.capture(feedback)).rejects.toThrow(
      "Feedback agent could not be loaded: OpenCode session is gone",
    );
  });
});
