import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import type { ArenaCheckoutCleanupSource } from "../agent/agent-sdk-types.js";
import { captureCodeSnapshot, verifyCodeSnapshot } from "./code-snapshot.js";
import { WorkspaceAccess, workspaceAccess } from "./workspace-access.js";
import { groupWorkspaceParents, WorkspaceCleanupService } from "./workspace-cleanup-service.js";

const directories: string[] = [];
const services: WorkspaceCleanupService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cleanup-")));
  directories.push(directory);
  const repo = join(directory, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "file.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), ".agent-duel/\nignored.txt\n");
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "base");
  const logger = pino({ level: "silent" });
  const registry = new FileBackedWorkspaceRegistry(join(directory, "workspaces.json"), logger);
  const roots: string[] = [];
  for (let index = 0; index < 16; index++) {
    const root = join(repo, ".agent-duel", "worktrees", `parent-${index}`);
    git(repo, "worktree", "add", "--detach", root, "HEAD");
    roots.push(root);
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: `workspace-${index}`,
        projectId: "project",
        cwd: root,
        kind: "worktree",
        displayName: `Parent ${index}`,
        worktreeRoot: root,
        mainRepoRoot: repo,
        isPaseoOwnedWorktree: true,
        createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        updatedAt: "2026-02-01T00:00:00.000Z",
        pinnedAt: index > 1 ? "2026-01-01T00:00:00.000Z" : null,
      }),
    );
  }
  const prepared: string[] = [];
  const released: string[] = [];
  const source: ArenaCheckoutCleanupSource = {
    inspect: async () => ({ eligible: true, lastActivityAt: null }),
    prepare: async (root) => {
      prepared.push(root);
    },
    release: async (root) => {
      released.push(root);
    },
    close: async () => {},
  };
  const seeded: Array<{ sourceCwd: string; worktreePath: string }> = [];
  const service = new WorkspaceCleanupService({
    paseoHome: directory,
    registry,
    logger,
    openSource: async () => source,
    isProtected: async () => false,
    stopTerminals: async () => {},
    seedIgnoredContent: async (input) => {
      seeded.push(input);
    },
  });
  services.push(service);
  return { directory, repo, registry, roots, service, prepared, released, seeded, source };
}

async function moveWorkspaceToTrashWithSnapshot(input: {
  directory: string;
  repo: string;
  root: string;
  registry: FileBackedWorkspaceRegistry;
  workspaceId: string;
  snapshotId: string;
}): Promise<{ manifestPath: string; snapshot: Awaited<ReturnType<typeof captureCodeSnapshot>> }> {
  const snapshot = await captureCodeSnapshot({
    worktreeRoot: input.root,
    sourceRepoRoot: input.repo,
    snapshotId: input.snapshotId,
  });
  const trashPath = join(join(input.root, ".."), ".trash", `workspace-${input.snapshotId}`);
  mkdirSync(join(input.root, "..", ".trash"), { recursive: true });
  renameSync(input.root, trashPath);
  git(input.repo, "worktree", "prune");
  const snapshotsDirectory = join(input.directory, "workspace-snapshots");
  mkdirSync(snapshotsDirectory, { recursive: true });
  const manifestPath = join(snapshotsDirectory, `${input.snapshotId}.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      root: input.root,
      sourceRepoRoot: input.repo,
      trashPath,
      snapshot,
    }),
  );
  await input.registry.update(input.workspaceId, (record) => ({
    ...record,
    cleanup: { snapshotId: input.snapshotId, phase: "cleaning" },
  }));
  return { manifestPath, snapshot };
}

test("keeps fifteen physical parents, uses newest shared-chat activity, and restores code without archiving chats", async () => {
  const { repo, registry, roots, service, prepared, released, seeded } = await setup();
  const first = (await registry.get("workspace-0"))!;
  await registry.upsert({
    ...first,
    workspaceId: "shared-chat",
    lastChatActivityAt: "2026-03-01T00:00:00.000Z",
  });
  writeFileSync(join(roots[1], "file.txt"), "staged\n");
  git(roots[1], "add", "file.txt");
  writeFileSync(join(roots[1], "file.txt"), "working\n");
  writeFileSync(join(roots[1], "new.txt"), "new\n");
  writeFileSync(join(roots[1], "ignored.txt"), "excluded\n");
  await service.initialize();
  await vi.waitFor(
    async () => expect((await registry.get("workspace-1"))?.cleanup?.phase).toBe("cleaned"),
    { timeout: 30_000 },
  );
  await service.close();
  expect(prepared).toEqual([roots[1]]);
  expect(roots.filter(existsSync)).toHaveLength(15);
  expect(groupWorkspaceParents(await registry.list())).toHaveLength(16);
  expect((await registry.list()).every((record) => record.archivedAt === null)).toBe(true);
  expect((await registry.get("shared-chat"))?.cleanup).toBeUndefined();
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "--prune=now");
  await service.restore("workspace-1");
  expect(released).toEqual([roots[1]]);
  expect((await registry.get("workspace-1"))?.cleanup).toBeUndefined();
  expect(readFileSync(join(roots[1], "file.txt"), "utf8")).toBe("working\n");
  expect(git(roots[1], "show", ":file.txt")).toBe("staged");
  expect(readFileSync(join(roots[1], "new.txt"), "utf8")).toBe("new\n");
  // The snapshot holds tracked content only; ignored content comes back by
  // being cloned from the source checkout again, as it is for a new worktree.
  expect(existsSync(join(roots[1], "ignored.txt"))).toBe(false);
  expect(seeded).toEqual([{ sourceCwd: repo, worktreePath: roots[1] }]);
}, 45_000);

test("a cleanup claim rejects a new prompt and a failed preparation keeps the original files", async () => {
  const { registry, roots, service, source, released } = await setup();
  await registry.update("workspace-1", (record) => ({ ...record, pinnedAt: record.createdAt }));
  let releasePreparation!: () => void;
  let preparationEntered!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    preparationEntered = resolve;
  });
  const preparationReleased = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  source.prepare = async () => {
    preparationEntered();
    await preparationReleased;
    throw new Error("A retained contestant contains newer code");
  };
  await service.initialize();
  await preparationStarted;
  await vi.waitFor(
    async () => expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaning"),
    { timeout: 30_000 },
  );
  await expect(workspaceAccess.use(roots[0], async () => "started")).rejects.toThrow(
    "Restore the workspace",
  );
  releasePreparation();
  await vi.waitFor(async () =>
    expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined(),
  );
  await service.close();
  expect(released).toEqual([roots[0]]);
  expect(roots.filter(existsSync)).toHaveLength(16);
  expect(readFileSync(join(roots[0], "file.txt"), "utf8")).toBe("base\n");
  await expect(workspaceAccess.use(roots[0], async () => "started")).resolves.toBe("started");
}, 45_000);

test("a pinned member protects its shared physical parent", async () => {
  const { registry, roots, service } = await setup();
  const first = (await registry.get("workspace-0"))!;
  await registry.upsert({
    ...first,
    workspaceId: "pinned-member",
    pinnedAt: "2026-03-01T00:00:00.000Z",
  });

  await service.initialize();
  await vi.waitFor(
    async () => expect((await registry.get("workspace-1"))?.cleanup?.phase).toBe("cleaned"),
    { timeout: 30_000 },
  );
  expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined();
  expect(existsSync(roots[0])).toBe(true);
});

test("restarts a cleaning claim with the original worktree still present", async () => {
  const { registry, roots, service, released } = await setup();
  await registry.update("workspace-0", (record) => ({
    ...record,
    pinnedAt: record.createdAt,
    cleanup: { snapshotId: "a".repeat(64), phase: "cleaning" },
  }));

  await service.initialize();
  await vi.waitFor(async () =>
    expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined(),
  );
  expect(existsSync(roots[0])).toBe(true);
  expect(readFileSync(join(roots[0], "file.txt"), "utf8")).toBe("base\n");
  expect(released).toEqual([roots[0]]);
  await expect(workspaceAccess.use(roots[0], async () => "started")).resolves.toBe("started");
});

test("recovers a missing worktree from its durable cleaning snapshot", async () => {
  const { directory, repo, registry, roots, service, released } = await setup();
  const snapshotId = "b".repeat(64);
  writeFileSync(join(roots[0], "file.txt"), "saved\n");
  const persisted = await moveWorkspaceToTrashWithSnapshot({
    directory,
    repo,
    root: roots[0],
    registry,
    workspaceId: "workspace-0",
    snapshotId,
  });

  await service.initialize();
  await vi.waitFor(async () =>
    expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaned"),
  );
  await service.restore("workspace-0");

  expect(existsSync(roots[0])).toBe(true);
  expect(readFileSync(join(roots[0], "file.txt"), "utf8")).toBe("saved\n");
  expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined();
  expect(released).toEqual([roots[0]]);
  await verifyCodeSnapshot({
    worktreeRoot: roots[0],
    sourceRepoRoot: repo,
    snapshot: persisted.snapshot,
  });
  expect(existsSync(persisted.manifestPath)).toBe(true);
});

test("an occupied restore path leaves the occupant and durable snapshot intact", async () => {
  const { directory, repo, registry, roots, service } = await setup();
  const snapshotId = "c".repeat(64);
  const persisted = await moveWorkspaceToTrashWithSnapshot({
    directory,
    repo,
    root: roots[0],
    registry,
    workspaceId: "workspace-0",
    snapshotId,
  });
  const marker = join(roots[0], "marker.txt");
  mkdirSync(roots[0]);
  writeFileSync(marker, "keep\n");
  await registry.update("workspace-0", (record) => ({
    ...record,
    cleanup: { snapshotId, phase: "cleaned" },
  }));

  await expect(service.restore("workspace-0")).rejects.toThrow("Restore path already exists");
  expect(readFileSync(marker, "utf8")).toBe("keep\n");
  expect(existsSync(persisted.manifestPath)).toBe(true);
  expect(
    git(repo, "show-ref", "--verify", `refs/agent-duel/workspace-snapshots/${snapshotId}/head`),
  ).toContain(persisted.snapshot.head);
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("restoring");
});

test("an in-flight use prevents a cleanup claim, including use through a subdirectory", async () => {
  const access = new WorkspaceAccess();
  let release: () => void = () => {};
  const running = access.use(
    "/repo/worktree/subproject",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(access.claim("/repo/worktree")).toBe(false);
  release();
  await running;
  expect(access.claim("/repo/worktree")).toBe(true);
  await expect(access.use("/repo/worktree/subproject", async () => {})).rejects.toThrow(
    "Restore the workspace",
  );
  access.release("/repo/worktree");
});
