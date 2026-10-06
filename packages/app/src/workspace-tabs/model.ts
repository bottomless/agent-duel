import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import type { WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export interface WorkspaceWorkingDiffTabTarget {
  kind: "working_diff";
  focusPath?: string;
  focusRequestId?: number;
}

export type WorkspaceTabTarget =
  | { kind: "draft"; draftId: string; setup?: WorkspaceDraftTabSetup }
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "terminal"; terminalId: string }
  // A contestant's shell. Identified by the instance the seat opened rather than by a terminal,
  // because the worktree behind it is replaced every turn and the tab has to outlive that. The
  // shell itself is in the seat-terminal store, keyed by the same instance.
  | { kind: "arena_terminal"; agentId: string; side: ArenaSide; instanceId: string }
  | { kind: "browser"; browserId: string }
  | WorkspaceFileTabTarget
  | WorkspaceWorkingDiffTabTarget
  | { kind: "setup"; workspaceId: string }
  | { kind: "commit_diff"; sha: string }
  // Side panel surfaces that used to live in the Explorer sidebar. One per
  // workspace, so they carry no identity beyond their kind.
  | { kind: "changes" }
  | { kind: "files" }
  | { kind: "pull_request" };

export interface WorkspaceTab {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}
