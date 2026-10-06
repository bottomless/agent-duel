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

interface FeedbackGitSource {
  getSnapshot(
    cwd: string,
    options: { force: true; reason: string },
  ): Promise<Pick<WorkspaceGitRuntimeSnapshot, "git">>;
}

export interface FeedbackContextDependencies {
  readonly agents: FeedbackAgentSource;
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

export function createFeedbackContextCapture(
  dependencies: FeedbackContextDependencies,
): FeedbackContextCapture {
  const now = dependencies.now ?? (() => new Date());
  const status = dependencies.readGitStatus ?? readGitStatus;
  return {
    async capture(target) {
      const agent = dependencies.agents.getAgent(target.agentId);
      if (!agent || agent.workspaceId !== target.workspaceId) {
        throw new Error("Feedback session is unavailable");
      }
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
