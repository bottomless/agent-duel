import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { normalizePathForIdentity } from "../../utils/path.js";
import { runGitCommand, runWithGitCommandPriority } from "../../utils/run-git-command.js";
import { isPaseoOwnedWorktreeCwd, type WorktreeSeedFn } from "../../utils/worktree.js";
import type {
  ArenaEnvironmentStatus,
  ArenaEnvironmentTrim,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { DEFAULT_WORKTREE_RETENTION } from "@getpaseo/protocol/messages";
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

/**
 * Below this much free space on a project's volume, only the latest chat on that volume keeps its
 * battle environments, whatever the limit says: they can be built again, and a full disk fails the
 * git writes every battle and vote depends on.
 */
export const LOW_DISK_BYTES = 10_000_000_000;
/**
 * A trim reads every chat's battle history and lists processes, and the sweep is scheduled on
 * every bit of activity, so it trims at most this often unless the limit changed.
 */
const ENVIRONMENT_TRIM_INTERVAL_MS = 60_000;

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
  /** How many chats keep their battle environments; `null` keeps every chat's. */
  environmentRetention?(): number | null;
  /** How many worktrees made with New worktree keep their files; `null` keeps them all. */
  worktreeRetention?(): number | null;
  /** Free bytes on the volume holding `path`, or null when unknown. */
  freeBytes?(path: string): Promise<number | null>;
}

export class WorkspaceCleanupService {
  private pending: NodeJS.Immediate | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private readonly restoring = new Set<string>();
  private lastEnvironmentTrim = 0;
  private sweepAgain = false;

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
          if (!this.sweepAgain) return;
          this.sweepAgain = false;
          this.schedule();
        });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) clearImmediate(this.pending);
    this.pending = null;
    await this.running;
  }

  /** Sweep again now, trimming environments even if a trim ran recently: a limit changed. */
  retentionChanged(): void {
    this.lastEnvironmentTrim = 0;
    // A sweep in progress may already have read the old limits; another follows it.
    if (this.running) this.sweepAgain = true;
    this.schedule();
  }

  private async sweep(): Promise<void> {
    await this.sweepParents();
    await this.sweepEnvironments();
  }

  private async sweepEnvironments(): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastEnvironmentTrim < ENVIRONMENT_TRIM_INTERVAL_MS) return;
    this.lastEnvironmentTrim = now;
    const limit = this.deps.environmentRetention?.() ?? null;
    // A daemon without the Arena backend has no environments to trim.
    if (limit !== null && (await this.trimThroughBackend(limit)) === "unavailable") return;
    // Environments live inside their projects, so a full volume is freed only by its own chats.
    for (const { root, freeBytes } of await this.lowVolumes()) {
      this.deps.logger.info(
        { root, freeBytes, limit },
        "Disk is low; only the latest chat on it keeps its battle environments",
      );
      if ((await this.trimThroughBackend(1, root)) === "unavailable") return;
    }
  }

  /** Free space where battle environments live, for the Storage settings. */
  async environmentStatus(): Promise<ArenaEnvironmentStatus> {
    return { freeBytes: await this.lowestFreeBytes(), lowDiskBytes: LOW_DISK_BYTES };
  }

  /**
   * The least free space on the volumes the open projects live on. Each chat's environments sit
   * inside its project, so the fullest of those volumes is the one a battle can run out of.
   */
  private async lowestFreeBytes(): Promise<number | null> {
    let lowest: number | null = null;
    for (const root of await this.projectRoots()) {
      const free = await this.freeBytesAt(root);
      if (free !== null && (lowest === null || free < lowest)) lowest = free;
    }
    return lowest;
  }

  /** The latest open project on each volume with less than `LOW_DISK_BYTES` free. */
  private async lowVolumes(): Promise<Array<{ root: string; freeBytes: number }>> {
    const devices = new Set<number>();
    const low: Array<{ root: string; freeBytes: number }> = [];
    for (const root of await this.projectRoots()) {
      const freeBytes = await this.freeBytesAt(root);
      if (freeBytes === null || freeBytes >= LOW_DISK_BYTES) continue;
      const device = await fs.stat(root).then(
        (stats) => stats.dev,
        () => null,
      );
      if (device !== null && devices.has(device)) continue;
      if (device !== null) devices.add(device);
      low.push({ root, freeBytes });
    }
    return low;
  }

  private async freeBytesAt(path: string): Promise<number | null> {
    if (this.deps.freeBytes) return this.deps.freeBytes(path);
    return fs.statfs(path).then(
      (stats) => stats.bavail * stats.bsize,
      () => null,
    );
  }

  /**
   * Release idle chats' battle environments past the `keep` most recently active. The backend
   * covers every chat, so any existing workspace's checkout can carry the request.
   */
  async trimEnvironments(keep: number): Promise<ArenaEnvironmentTrim> {
    const trimmed = await this.trimThroughBackend(keep);
    if (trimmed === "unavailable") throw new Error("The Agent Duel backend is unavailable");
    return trimmed;
  }

  /** `unavailable` when no backend serves Arena, as in a daemon running without it. */
  private async trimThroughBackend(
    keep: number,
    volumeOf?: string,
  ): Promise<ArenaEnvironmentTrim | "unavailable"> {
    const [anchor] = await this.projectRoots();
    if (!anchor) return { chats: 0, released: 0, kept: 0 };
    const source = await this.deps.openSource(anchor);
    if (!source) return "unavailable";
    try {
      return await source.trimEnvironments(keep, volumeOf);
    } finally {
      await source.close();
    }
  }

  /** The open workspaces' project roots that exist, most recently active first. */
  private async projectRoots(): Promise<string[]> {
    const workspaces = (await this.deps.registry.list())
      .filter((workspace) => !workspace.archivedAt && !workspace.cleanup)
      .sort((left, right) =>
        (right.lastChatActivityAt ?? right.createdAt).localeCompare(
          left.lastChatActivityAt ?? left.createdAt,
        ),
      );
    const roots: string[] = [];
    for (const workspace of workspaces) {
      const root = workspace.mainRepoRoot ?? workspace.worktreeRoot ?? workspace.cwd;
      if (roots.includes(root) || !(await pathExists(root).catch(() => false))) continue;
      roots.push(root);
    }
    return roots;
  }

  private async sweepParents(): Promise<void> {
    const parents = groupWorkspaceParents(await this.deps.registry.list());
    const materialized: WorkspaceParent[] = [];
    for (const parent of parents) {
      if (await pathExists(parent.root)) materialized.push(parent);
    }
    const limit = this.deps.worktreeRetention
      ? this.deps.worktreeRetention()
      : DEFAULT_WORKTREE_RETENTION;
    if (limit === null) return;
    let excess = materialized.length - limit;
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
