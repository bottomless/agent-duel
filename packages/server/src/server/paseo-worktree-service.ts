import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkspaceGitService } from "./workspace-git-service.js";
import { getRealpathAwareRelativePath } from "../utils/path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import {
  mapWorkspaceRelativeCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  seedPaseoConfigFile,
  type WorktreeConfig,
} from "../utils/worktree.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";
import {
  removePendingForkWorktreeIntent,
  writePendingForkWorktreeIntent,
} from "./pending-fork-worktree-intent.js";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {
  pendingFork?: boolean;
  workspaceId?: string;
  projectId?: string;
  title?: string;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface CreatePaseoWorktreeResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  workspace: PersistedWorkspaceRecord;
  repoRoot: string;
  created: boolean;
}

export type CreatePaseoWorktreeFn = (
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  },
) => Promise<CreatePaseoWorktreeResult>;

export interface CreatePaseoWorktreeDeps extends CreateWorktreeCoreDeps {
  workspaceGitService: WorkspaceGitService;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "createWorkspaceForWorktree">;
}

export async function createPaseoWorktree(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  return runWithGitCommandPriority("high", () => createPaseoWorktreeWithPriority(input, deps));
}

async function createPaseoWorktreeWithPriority(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const workspaceCwdPlan = await planWorkspaceCwdForWorktree(input.cwd, deps.workspaceGitService);
  let pendingIntent: { file: string; worktreePath: string } | undefined;
  let workspacePersisted = false;
  try {
    const createdWorktree = await createWorktreeCore(input, {
      ...deps,
      onBeforeAdd: input.pendingFork
        ? async (worktreePath, repoRoot) => {
            const file = await writePendingForkWorktreeIntent(
              {
                repoRoot,
                worktreePath,
                worktreesBaseRoot: input.worktreesRoot,
                sourceCwd: workspaceCwdPlan.inputCwd,
                relativeWorkspaceCwd: workspaceCwdPlan.relativeWorkspaceCwd,
                projectId: input.projectId,
                title: input.title?.trim() || resolveFirstAgentPromptTitle(input.firstAgentContext),
              },
              input.paseoHome,
            );
            pendingIntent = { file, worktreePath };
          }
        : undefined,
      onAddFailed: input.pendingFork
        ? async (worktreePath) => {
            if (pendingIntent?.worktreePath !== worktreePath) return;
            await removePendingForkWorktreeIntent(pendingIntent.file);
            pendingIntent = undefined;
          }
        : undefined,
    });
    try {
      const workspaceCwd = mapWorkspaceRelativeCwdToWorktree({
        relativeWorkspaceCwd: workspaceCwdPlan.relativeWorkspaceCwd,
        targetWorktreePath: createdWorktree.worktree.worktreePath,
      });
      if (!(await isDirectory(workspaceCwd))) {
        throw new Error(`Selected project directory is missing from the worktree: ${workspaceCwd}`);
      }

      if (createdWorktree.created) {
        await seedPaseoConfigFile({
          sourceCwd: workspaceCwdPlan.inputCwd,
          targetCwd: workspaceCwd,
        });
      }
      const workspace = await deps.workspaceProvisioning.createWorkspaceForWorktree({
        sourceCwd: workspaceCwdPlan.inputCwd,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        repoRoot: createdWorktree.repoRoot,
        cwd: workspaceCwd,
        worktreeRoot: createdWorktree.worktree.worktreePath,
        branch: createdWorktree.worktree.branchName || null,
        baseBranch: createdWorktree.worktree.comparisonBaseRef,
        title: input.title?.trim() || resolveFirstAgentPromptTitle(input.firstAgentContext),
        expectsInitialAgent: Boolean(input.firstAgentContext),
        pendingFork: input.pendingFork,
        background: input.background,
        callerWorkspaceId: input.callerWorkspaceId,
        ...(createdWorktree.intent.kind === "checkout-change-request" &&
        createdWorktree.intent.headRepository
          ? {
              untrustedSource: {
                kind: "change_request" as const,
                forge: createdWorktree.intent.forge,
                number: createdWorktree.intent.changeRequestNumber,
                headRepository: createdWorktree.intent.headRepository,
              },
            }
          : {}),
      });
      workspacePersisted = true;

      deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });

      return {
        worktree: createdWorktree.worktree,
        intent: createdWorktree.intent,
        workspace,
        repoRoot: createdWorktree.repoRoot,
        created: createdWorktree.created,
      };
    } catch (error) {
      if (!createdWorktree.created) {
        throw error;
      }
      return await rollbackCreatedPaseoWorktree(
        {
          cwd: createdWorktree.repoRoot,
          worktreePath: createdWorktree.worktree.worktreePath,
          teardownCwds: [],
          paseoHome: input.paseoHome,
          worktreesBaseRoot: input.worktreesRoot,
        },
        error,
      );
    }
  } finally {
    if (pendingIntent && (workspacePersisted || !(await isDirectory(pendingIntent.worktreePath)))) {
      // A stale intent is harmless: startup checks the workspace registry before recovery.
      await removePendingForkWorktreeIntent(pendingIntent.file).catch(() => {});
    }
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function planWorkspaceCwdForWorktree(
  inputCwd: string,
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout">,
): Promise<{ inputCwd: string; relativeWorkspaceCwd: string }> {
  const normalizedInputCwd = resolve(inputCwd);
  const sourceCheckout = await workspaceGitService.getCheckout(normalizedInputCwd);
  const sourceWorktreePath = sourceCheckout.worktreeRoot ?? normalizedInputCwd;
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(sourceWorktreePath, normalizedInputCwd);
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${normalizedInputCwd}`);
  }
  return { inputCwd: normalizedInputCwd, relativeWorkspaceCwd };
}
