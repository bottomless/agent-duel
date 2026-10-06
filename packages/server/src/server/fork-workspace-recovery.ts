import type { Logger } from "pino";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  deletePaseoWorktree,
  getGitCommonDir,
  getPaseoWorktreesRoot,
  mapWorkspaceRelativeCwdToWorktree,
} from "../utils/worktree.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { getCurrentBranch } from "../utils/checkout-git.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { generateWorkspaceId, initialWorkspacePlacement } from "./workspace-registry-model.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  listPendingForkWorktreeIntents,
  removePendingForkWorktreeIntent,
  type PendingForkWorktreeIntent,
} from "./pending-fork-worktree-intent.js";

interface ForkWorkspaceDependencies {
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}

export async function recoverInterruptedForkWorkspaces(
  dependencies: ForkWorkspaceDependencies & { agentStorage: AgentStorage },
): Promise<void> {
  // Only run before accepting requests. Empty workspaces without this marker
  // may be intentional; never infer an interrupted fork from emptiness alone.
  const { agentStorage, workspaceRegistry, logger } = dependencies;
  const agentWorkspaceIds = new Set((await agentStorage.list()).map((agent) => agent.workspaceId));
  for (const workspace of await workspaceRegistry.list()) {
    if (!workspace.pendingFork) continue;
    try {
      if (!workspace.archivedAt && !agentWorkspaceIds.has(workspace.workspaceId)) {
        // Keep the checkout and its files, including worktree setup output.
        await workspaceRegistry.archive(workspace.workspaceId, new Date().toISOString());
        logger.info({ workspaceId: workspace.workspaceId }, "Archived interrupted fork workspace");
      }
      await workspaceRegistry.update(workspace.workspaceId, (record) => ({
        ...record,
        pendingFork: undefined,
      }));
    } catch (error) {
      logger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to recover interrupted fork workspace",
      );
    }
  }
}

export async function recoverUnrecordedForkWorktrees(
  dependencies: ForkWorkspaceDependencies & {
    agentStorage: AgentStorage;
    workspaceProvisioning: Pick<WorkspaceProvisioningService, "resolveSourceProjectForWorktree">;
    paseoHome: string;
  },
): Promise<void> {
  const { agentStorage, workspaceRegistry, workspaceProvisioning, paseoHome, logger } =
    dependencies;
  const workspaces = await workspaceRegistry.list();
  const agents = await agentStorage.list();
  const isWithinWorktree = (worktreePath: string, candidate: string): boolean => {
    const relative = path.relative(worktreePath, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  let pendingIntents;
  try {
    pendingIntents = await listPendingForkWorktreeIntents(paseoHome);
  } catch (error) {
    logger.warn({ err: error }, "Failed to read pending fork worktree intents");
    return;
  }
  for (const entry of pendingIntents) {
    const { file } = entry;
    if ("error" in entry) {
      logger.warn({ err: entry.error, file }, "Preserving invalid fork worktree intent");
      continue;
    }
    const { intent } = entry;
    const { repoRoot, worktreePath, worktreesBaseRoot } = intent;
    try {
      const normalizedPath = path.resolve(worktreePath);
      const hasWorkspace = workspaces.some(
        (workspace) =>
          (workspace.worktreeRoot && path.resolve(workspace.worktreeRoot) === normalizedPath) ||
          isWithinWorktree(normalizedPath, path.resolve(workspace.cwd)),
      );
      if (hasWorkspace) {
        await removePendingForkWorktreeIntent(file);
        continue;
      }
      if (agents.some((agent) => isWithinWorktree(normalizedPath, path.resolve(agent.cwd)))) {
        logger.warn({ worktreePath }, "Preserving unrecorded fork worktree with an agent");
        continue;
      }
      let worktreeStat;
      try {
        worktreeStat = await lstat(normalizedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await removePendingForkWorktreeIntent(file);
        continue;
      }
      if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
        logger.warn({ worktreePath }, "Preserving unexpected unrecorded fork path");
        continue;
      }
      const root = await getPaseoWorktreesRoot(repoRoot, paseoHome, worktreesBaseRoot);
      const relative = path.relative(root, normalizedPath);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        relative.includes(path.sep)
      ) {
        logger.warn({ worktreePath }, "Preserving fork path outside its worktree root");
        continue;
      }
      const [sourceCommonDir, worktreeCommonDir] = await Promise.all([
        getGitCommonDir(repoRoot),
        getGitCommonDir(normalizedPath),
      ]);
      if (path.resolve(sourceCommonDir) !== path.resolve(worktreeCommonDir)) {
        logger.warn({ worktreePath }, "Preserving worktree from another repository");
        continue;
      }
      const { stdout: changes } = await runGitCommand(
        ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
        { cwd: normalizedPath },
      );
      if (changes.trim()) {
        const workspace = await createArchivedForkWorkspaceRecord({
          intent,
          workspaceProvisioning,
          worktreePath: normalizedPath,
        });
        await workspaceRegistry.upsert(workspace);
        workspaces.push(workspace);
        await removePendingForkWorktreeIntent(file);
        logger.info(
          { workspaceId: workspace.workspaceId, worktreePath },
          "Archived unrecorded fork worktree with local files",
        );
        continue;
      }
      await deletePaseoWorktree({
        cwd: repoRoot,
        worktreePath: normalizedPath,
        teardownCwds: [],
        paseoHome,
        worktreesBaseRoot,
      });
      await removePendingForkWorktreeIntent(file);
      logger.info({ worktreePath }, "Removed clean unrecorded fork worktree");
    } catch (error) {
      logger.warn({ err: error, worktreePath }, "Failed to recover unrecorded fork worktree");
    }
  }
}

async function createArchivedForkWorkspaceRecord(input: {
  intent: PendingForkWorktreeIntent;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "resolveSourceProjectForWorktree">;
  worktreePath: string;
}): Promise<PersistedWorkspaceRecord> {
  const { intent, workspaceProvisioning, worktreePath } = input;
  const project = await workspaceProvisioning.resolveSourceProjectForWorktree({
    sourceCwd: intent.sourceCwd ?? intent.repoRoot,
    projectId: intent.projectId,
    repoRoot: intent.repoRoot,
  });
  const workspaceCwd = mapWorkspaceRelativeCwdToWorktree({
    relativeWorkspaceCwd: intent.relativeWorkspaceCwd ?? "",
    targetWorktreePath: worktreePath,
  });
  const cwd = (await lstat(workspaceCwd).catch(() => null))?.isDirectory()
    ? workspaceCwd
    : worktreePath;
  const branch = await getCurrentBranch(worktreePath);
  let baseBranch: string | null = null;
  try {
    baseBranch = readPaseoWorktreeMetadata(worktreePath)?.baseRefName ?? null;
  } catch {
    // The crash may have interrupted metadata writing; the checkout remains recoverable.
  }
  const timestamp = new Date().toISOString();
  return createPersistedWorkspaceRecord({
    workspaceId: generateWorkspaceId(),
    projectId: project.projectId,
    ...initialWorkspacePlacement({
      source: "created_worktree",
      cwd,
      worktreeRoot: worktreePath,
      branch,
      baseBranch,
      mainRepoRoot: intent.repoRoot,
    }),
    title: intent.title ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: timestamp,
    recoveryReason: "interrupted_fork",
  });
}

export async function completeWorkspaceFork(
  workspaceId: string,
  { workspaceRegistry, logger }: ForkWorkspaceDependencies,
): Promise<void> {
  // Registration has already persisted the agent. If this write fails, startup
  // keeps its workspace by checking durable agent ownership.
  try {
    const workspace = await workspaceRegistry.get(workspaceId);
    if (!workspace?.pendingFork) return;
    await workspaceRegistry.update(workspaceId, (record) => ({
      ...record,
      pendingFork: undefined,
    }));
  } catch (error) {
    logger.warn({ err: error, workspaceId }, "Failed to clear completed fork marker");
  }
}
