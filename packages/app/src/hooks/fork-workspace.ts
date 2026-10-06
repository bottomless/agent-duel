import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { slugify } from "@getpaseo/protocol/branch-slug";

type ForkWorkspaceSource = Pick<AgentScreenAgent, "cwd" | "projectPlacement">;

interface ForkWorkspaceName {
  title: string;
  fallbackBranch: string;
}

export type ForkWorkspaceTarget = "current_worktree" | "new_worktree";

export type ForkWorkspaceCreationTarget =
  | {
      kind: "worktree";
      cwd: string;
      worktree: {
        mode: "branch-off";
        newBranch: string;
        base?: string;
        workspaceTitle: string;
      };
    }
  | {
      kind: "directory";
      path: string;
    };

export function resolveForkWorkspaceCreationTarget(
  agent: ForkWorkspaceSource,
  name: ForkWorkspaceName,
  target: ForkWorkspaceTarget = "new_worktree",
): ForkWorkspaceCreationTarget | null {
  if (target === "current_worktree") {
    const cwd = agent.cwd.trim();
    return cwd ? { kind: "directory", path: cwd } : null;
  }

  const checkout = agent.projectPlacement?.checkout;
  if (!checkout) return null;

  const cwd = checkout.cwd?.trim() || agent.cwd.trim();
  if (!cwd) return null;

  if (!checkout.isGit) {
    return { kind: "directory", path: cwd };
  }

  const base = checkout.currentBranch?.trim();
  const newBranch = slugify(name.title) || name.fallbackBranch;
  return {
    kind: "worktree",
    cwd,
    worktree: {
      mode: "branch-off",
      newBranch,
      workspaceTitle: name.title,
      ...(base ? { base } : {}),
    },
  };
}
