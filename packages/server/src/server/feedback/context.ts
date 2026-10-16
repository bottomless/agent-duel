import type { FeedbackContext, FeedbackContextTarget } from "@getpaseo/protocol/feedback/schemas";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import { READ_ONLY_GIT_ENV } from "../checkout-git-utils.js";
import { runGitCommand } from "../../utils/run-git-command.js";

export interface FeedbackContextCapture {
  capture(target: FeedbackContextTarget): Promise<FeedbackContext>;
}

interface FeedbackAgent {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider: AgentProvider;
  readonly cwd: string;
  readonly persistence: { readonly sessionId: string } | null;
}

interface FeedbackAgentSource {
  getAgent(id: string): FeedbackAgent | null;
  getTimelineRows(id: string): Promise<AgentTimelineRow[]>;
}

interface FeedbackAgentStorage {
  get(id: string): Promise<{ readonly workspaceId?: string } | null>;
}

interface FeedbackGitSource {
  getSnapshot(
    cwd: string,
    options: { force: true; reason: string },
  ): Promise<Pick<WorkspaceGitRuntimeSnapshot, "git">>;
}

export interface FeedbackContextDependencies {
  readonly agents: FeedbackAgentSource;
  readonly storage: FeedbackAgentStorage;
  /** Resumes a stored agent and its timeline, as opening its chat does. */
  readonly loadAgent: (id: string) => Promise<FeedbackAgent>;
  readonly git: FeedbackGitSource;
  readonly now?: () => Date;
  readonly readGitStatus?: (cwd: string) => Promise<string>;
}

async function readGitStatus(cwd: string): Promise<string> {
  const result = await runGitCommand(["status", "--short", "--branch"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return result.stdout.trim();
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : "Git status is unavailable";
}

// The daemon holds an agent only while a chat keeps it loaded, and feedback can name a chat that
// was archived or never reopened since a restart. Its history is stored, so it is loaded the way
// opening the chat loads it. An unarchive can move an agent to another workspace in storage while
// the loaded copy keeps the old one, so either may match the workspace the feedback names.
async function feedbackAgent(
  dependencies: FeedbackContextDependencies,
  target: FeedbackContextTarget,
): Promise<FeedbackAgent> {
  const record = await dependencies.storage.get(target.agentId);
  let agent = dependencies.agents.getAgent(target.agentId);
  if (!agent && !record) throw new Error("Feedback agent was not found");
  if (!agent) {
    try {
      agent = await dependencies.loadAgent(target.agentId);
    } catch (error) {
      throw new Error(`Feedback agent could not be loaded: ${failureReason(error)}`, {
        cause: error,
      });
    }
  }
  if (agent.workspaceId !== target.workspaceId && record?.workspaceId !== target.workspaceId) {
    throw new Error("Feedback agent belongs to another workspace");
  }
  return agent;
}

export function createFeedbackContextCapture(
  dependencies: FeedbackContextDependencies,
): FeedbackContextCapture {
  const now = dependencies.now ?? (() => new Date());
  const status = dependencies.readGitStatus ?? readGitStatus;
  return {
    async capture(target) {
      const agent = await feedbackAgent(dependencies, target);
      const rows = await dependencies.agents.getTimelineRows(agent.id);
      const timeline = rows.map((row) =>
        row.providerMessageId
          ? {
              seq: row.seq,
              timestamp: row.timestamp,
              item: row.item,
              providerMessageId: row.providerMessageId,
            }
          : { seq: row.seq, timestamp: row.timestamp, item: row.item },
      );

      let git: FeedbackContext["git"];
      try {
        const snapshot = await dependencies.git.getSnapshot(agent.cwd, {
          force: true,
          reason: "feedback-context",
        });
        if (!snapshot.git.isGit) {
          git = { kind: "not_git" };
        } else {
          git = {
            kind: "git",
            branch: snapshot.git.currentBranch,
            baseRef: snapshot.git.baseRef,
            upstreamRef: snapshot.git.upstreamRef,
            isDirty: snapshot.git.isDirty ?? false,
            aheadBehind: snapshot.git.aheadBehind,
            diffStat: snapshot.git.diffStat,
            status: await status(agent.cwd),
          };
        }
      } catch (error) {
        git = { kind: "unavailable", reason: failureReason(error) };
      }

      return {
        version: 1,
        capturedAt: now().toISOString(),
        agent: {
          id: agent.id,
          provider: agent.provider,
          sessionId: agent.persistence?.sessionId ?? null,
        },
        timeline,
        git,
      };
    },
  };
}
