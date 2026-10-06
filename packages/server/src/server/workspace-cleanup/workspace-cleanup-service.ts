import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { normalizePathForIdentity } from "../../utils/path.js";
import { runGitCommand, runWithGitCommandPriority } from "../../utils/run-git-command.js";
import { isPaseoOwnedWorktreeCwd, type WorktreeSeedFn } from "../../utils/worktree.js";
import type { ArenaCheckoutCleanupSource } from "../agent/agent-sdk-types.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import {
  captureCodeSnapshot,
  restoreCodeSnapshot,
  verifyCodeSnapshotCheckout,
  parseCodeSnapshot,
} from "./code-snapshot.js";
import { workspaceAccess } from "./workspace-access.js";

export const WORKSPACE_KEEP_COUNT = 15;

export interface WorkspaceParent {
  root: string;
  sourceRepoRoot: string;
  workspaces: PersistedWorkspaceRecord[];
}

export function groupWorkspaceParents(workspaces: PersistedWorkspaceRecord[]): WorkspaceParent[] {
  const groups = new Map<string, WorkspaceParent>();
  for (const workspace of workspaces) {
    if (!workspace.isPaseoOwnedWorktree || !workspace.worktreeRoot || !workspace.mainRepoRoot)
      continue;
    const root = normalizePathForIdentity(workspace.worktreeRoot);
    if (root === normalizePathForIdentity(workspace.mainRepoRoot)) continue;
    const group = groups.get(root) ?? {
      root,
      sourceRepoRoot: workspace.mainRepoRoot,
      workspaces: [],
    };
    group.workspaces.push(workspace);
    groups.set(root, group);
  }
  return [...groups.values()];
}

interface CleanupManifest {
  version: 1;
  root: string;
  sourceRepoRoot: string;
  trashPath: string;
  snapshot: Awaited<ReturnType<typeof captureCodeSnapshot>>;
}

interface CleanupDeps {
  paseoHome: string;
  worktreesRoot?: string;
  registry: WorkspaceRegistry;
  logger: Logger;
  openSource(cwd: string): Promise<ArenaCheckoutCleanupSource | null>;
  isProtected(parent: WorkspaceParent): Promise<boolean>;
  stopTerminals(parent: WorkspaceParent): Promise<void>;
  seedIgnoredContent?: WorktreeSeedFn;
}

export class WorkspaceCleanupService {
  private pending: NodeJS.Immediate | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private readonly restoring = new Set<string>();

  constructor(private readonly deps: CleanupDeps) {}

  async initialize(): Promise<void> {
    const parents = groupWorkspaceParents(await this.deps.registry.list());
    for (const parent of parents) {
      if (parent.workspaces.some((workspace) => workspace.cleanup))
        workspaceAccess.retain(parent.root);
    }
    this.running = this.recoverInterrupted(parents).finally(() => {
      this.running = null;
      this.schedule();
    });
  }

  private async recoverInterrupted(parents: WorkspaceParent[]): Promise<void> {
    for (const parent of parents) {
      const cleanup = parent.workspaces.find((workspace) => workspace.cleanup)?.cleanup;
      if (!cleanup) continue;
      workspaceAccess.retain(parent.root);
      try {
        const present = await pathExists(parent.root);
        if (cleanup.phase === "cleaning" && present) {
          // A crash before rename leaves the original authoritative. Never delete it on recovery.
          await this.releaseBackend(parent);
          await this.setPhase(parent, undefined);
          workspaceAccess.release(parent.root);
        } else if (cleanup.phase === "cleaning") {
          await this.readManifest(cleanup.snapshotId, parent);
          await this.setPhase(parent, { snapshotId: cleanup.snapshotId, phase: "cleaned" });
        }
        const manifest = await this.readManifest(cleanup.snapshotId, parent).catch(() => null);
        if (manifest) await fs.rm(manifest.trashPath, { recursive: true, force: true });
      } catch (err) {
        this.deps.logger.warn({ err, root: parent.root }, "Workspace cleanup recovery needs retry");
      }
    }
  }

  schedule(): void {
    if (this.closed || this.pending || this.running) return;
    this.pending = setImmediate(() => {
      this.pending = null;
      this.running = runWithGitCommandPriority("normal", () => this.sweep())
        .catch((err) => this.deps.logger.warn({ err }, "Workspace cleanup failed"))
        .finally(() => {
          this.running = null;
        });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) clearImmediate(this.pending);
    this.pending = null;
    await this.running;
  }

  private async sweep(): Promise<void> {
    const parents = groupWorkspaceParents(await this.deps.registry.list());
    const materialized: WorkspaceParent[] = [];
    for (const parent of parents) {
      if (await pathExists(parent.root)) materialized.push(parent);
    }
    let excess = materialized.length - WORKSPACE_KEEP_COUNT;
    if (excess <= 0) return;
    const candidates: Array<{ parent: WorkspaceParent; activity: number }> = [];
    for (const parent of materialized) {
      if (this.closed) return;
      if (
        parent.workspaces.some((workspace) => workspace.pinnedAt || workspace.cleanup) ||
        (await this.deps.isProtected(parent))
      )
        continue;
      const source = await this.deps.openSource(parent.sourceRepoRoot);
      if (!source) continue;
      try {
        const state = await source.inspect(parent.root);
        if (!state.eligible) continue;
        const activity = Math.max(
          Date.parse(state.lastActivityAt ?? "") || 0,
          ...parent.workspaces.map(
            (workspace) => Date.parse(workspace.lastChatActivityAt ?? workspace.createdAt) || 0,
          ),
        );
        candidates.push({ parent, activity });
      } catch (err) {
        this.deps.logger.debug(
          { err, root: parent.root },
          "Skipping unavailable cleanup candidate",
        );
      } finally {
        await source.close();
      }
    }
    candidates.sort(
      (left, right) =>
        left.activity - right.activity || left.parent.root.localeCompare(right.parent.root),
    );
    for (const { parent } of candidates) {
      if (this.closed || excess <= 0) break;
      if (await this.evict(parent)) excess--;
    }
  }

  private async evict(candidate: WorkspaceParent): Promise<boolean> {
    const parent = groupWorkspaceParents(await this.deps.registry.list()).find(
      (item) => item.root === candidate.root,
    );
    if (!parent || parent.workspaces.some((workspace) => workspace.pinnedAt || workspace.cleanup))
      return false;
    if ((await this.deps.isProtected(parent)) || !workspaceAccess.claim(parent.root)) return false;
    const snapshotId = createHash("sha256").update(parent.root).digest("hex");
    let removed = false;
    let source: ArenaCheckoutCleanupSource | null = null;
    try {
      // Claim first, then recheck: no prompt or terminal can start between this check and rename.
      if (await this.deps.isProtected(parent)) return false;
      const ownership = await isPaseoOwnedWorktreeCwd(parent.root, {
        paseoHome: this.deps.paseoHome,
        worktreesRoot: this.deps.worktreesRoot,
      });
      if (
        !ownership.allowed ||
        normalizePathForIdentity(ownership.worktreePath ?? "") !== parent.root
      )
        return false;
      source = await this.deps.openSource(parent.sourceRepoRoot);
      if (!source) return false;
      await this.setPhase(parent, { snapshotId, phase: "cleaning" });
      await source.prepare(parent.root);
      await this.deps.stopTerminals(parent);
      const snapshot = await captureCodeSnapshot({
        worktreeRoot: parent.root,
        sourceRepoRoot: parent.sourceRepoRoot,
        snapshotId,
      });
      const manifest: CleanupManifest = {
        version: 1,
        root: parent.root,
        sourceRepoRoot: parent.sourceRepoRoot,
        snapshot,
        trashPath: join(dirname(parent.root), ".trash", `workspace-${snapshotId}`),
      };
      await writeJsonFileAtomic(this.manifestPath(snapshotId), manifest);
      await this.readManifest(snapshotId, parent);
      await verifyCodeSnapshotCheckout({
        worktreeRoot: parent.root,
        sourceRepoRoot: parent.sourceRepoRoot,
        snapshot,
      });
      if (await this.deps.isProtected(parent))
        throw new Error("Workspace became protected during cleanup");
      await fs.mkdir(dirname(manifest.trashPath), { recursive: true });
      if (await pathExists(manifest.trashPath))
        throw new Error("Previous workspace trash still exists");
      await fs.rename(parent.root, manifest.trashPath);
      removed = true;
      await this.setPhase(parent, { snapshotId, phase: "cleaned" });
      // The original path is gone before expensive recursive removal begins.
      await runGitCommand(["worktree", "prune"], { cwd: parent.sourceRepoRoot });
      await fs.rm(manifest.trashPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { err, root: parent.root },
        "Workspace cleanup skipped; snapshot retained",
      );
      if (!removed) {
        try {
          if (source) await source.release(parent.root);
          await this.setPhase(parent, undefined);
        } catch (releaseError) {
          this.deps.logger.warn(
            { err: releaseError, root: parent.root },
            "Workspace cleanup claim retained for recovery",
          );
          return false;
        }
      }
      return removed;
    } finally {
      await source?.close();
      const current = await this.deps.registry.get(parent.workspaces[0].workspaceId);
      if (!current?.cleanup) workspaceAccess.release(parent.root);
    }
  }

  async restore(workspaceId: string): Promise<void> {
    const workspace = await this.deps.registry.get(workspaceId);
    if (!workspace?.cleanup) throw new Error("This workspace has no cleanup snapshot");
    const parent = groupWorkspaceParents(await this.deps.registry.list()).find((item) =>
      item.workspaces.some((record) => record.workspaceId === workspaceId),
    );
    if (!parent) throw new Error("Workspace placement is unavailable");
    if (this.restoring.has(parent.root) || workspace.cleanup.phase === "cleaning")
      throw new Error("Workspace cleanup is still in progress");
    this.restoring.add(parent.root);
    try {
      const manifest = await this.readManifest(workspace.cleanup.snapshotId, parent);
      const wasRestoring = workspace.cleanup.phase === "restoring";
      await this.setPhase(parent, { snapshotId: workspace.cleanup.snapshotId, phase: "restoring" });
      if (wasRestoring && (await pathExists(parent.root))) {
        await verifyCodeSnapshotCheckout({
          worktreeRoot: parent.root,
          sourceRepoRoot: parent.sourceRepoRoot,
          snapshot: manifest.snapshot,
        });
      } else {
        await restoreCodeSnapshot({
          worktreeRoot: parent.root,
          sourceRepoRoot: parent.sourceRepoRoot,
          snapshot: manifest.snapshot,
        });
      }
      for (const record of parent.workspaces) {
        if (!(await fs.stat(record.cwd)).isDirectory())
          throw new Error(`Restored project directory is missing: ${record.cwd}`);
      }
      // Snapshots hold tracked content only, so the dependencies and local
      // configuration a new worktree is seeded with are cloned back here
      // rather than stored. Seeding reports its own failures and never throws;
      // a workspace that returns without them is still restored.
      await this.deps.seedIgnoredContent?.({
        sourceCwd: parent.sourceRepoRoot,
        worktreePath: parent.root,
      });
      await this.releaseBackend(parent);
      for (const record of parent.workspaces) {
        await this.deps.registry.update(record.workspaceId, (current) => ({
          ...current,
          branch: null,
          cleanup: undefined,
        }));
      }
      workspaceAccess.release(parent.root);
    } finally {
      this.restoring.delete(parent.root);
    }
  }

  private async releaseBackend(parent: WorkspaceParent): Promise<void> {
    const source = await this.deps.openSource(parent.sourceRepoRoot);
    if (!source) throw new Error("Arena backend is unavailable; workspace remains protected");
    try {
      await source.release(parent.root);
    } finally {
      await source.close();
    }
  }

  private async setPhase(
    parent: WorkspaceParent,
    cleanup: PersistedWorkspaceRecord["cleanup"],
  ): Promise<void> {
    for (const workspace of parent.workspaces) {
      await this.deps.registry.update(workspace.workspaceId, (record) => ({ ...record, cleanup }));
    }
  }

  private manifestPath(snapshotId: string): string {
    if (!/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error("Invalid workspace snapshot ID");
    return join(this.deps.paseoHome, "workspace-snapshots", `${snapshotId}.json`);
  }

  private async readManifest(
    snapshotId: string,
    parent: WorkspaceParent,
  ): Promise<CleanupManifest> {
    const data: unknown = JSON.parse(await fs.readFile(this.manifestPath(snapshotId), "utf8"));
    const envelope = z
      .object({
        version: z.literal(1),
        root: z.string(),
        sourceRepoRoot: z.string(),
        trashPath: z.string(),
        snapshot: z.object({}).passthrough(),
      })
      .parse(data);
    if (
      envelope.root !== parent.root ||
      envelope.sourceRepoRoot !== parent.sourceRepoRoot ||
      envelope.trashPath !== join(dirname(parent.root), ".trash", `workspace-${snapshotId}`)
    ) {
      throw new Error("Workspace snapshot placement does not match the workspace");
    }
    const snapshot = parseCodeSnapshot(envelope.snapshot);
    if (
      snapshot.snapshotId !== snapshotId ||
      snapshot.worktreeRoot !== parent.root ||
      snapshot.sourceRepoRoot !== parent.sourceRepoRoot
    )
      throw new Error("Snapshot code belongs to a different workspace");
    return { ...envelope, snapshot };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
