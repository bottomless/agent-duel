import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readdirSync,
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
import {
  captureCodeSnapshot,
  CodeSnapshotError,
  SNAPSHOT_MAX_CHANGED_BYTES,
  verifyCodeSnapshot,
} from "./code-snapshot.js";
import { WorkspaceAccess, workspaceAccess } from "./workspace-access.js";
import {
  describeArchiveKeptWorktree,
  groupWorkspaceParents,
  WorkspaceCleanupService,
} from "./workspace-cleanup-service.js";

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

async function setup(
  options: {
    worktreeRetention?: () => number | null;
    deleteWorkspaceAgents?: (workspaceId: string) => Promise<void>;
  } = {},
) {
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
    trimEnvironments: async () => ({ chats: 0, released: 0, kept: 0 }),
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
    ...options,
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
  // The code is back, so the snapshot is released.
  await expect(
    verifyCodeSnapshot({
      worktreeRoot: roots[0],
      sourceRepoRoot: repo,
      snapshot: persisted.snapshot,
    }),
  ).rejects.toThrow();
  expect(existsSync(persisted.manifestPath)).toBe(false);
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

async function environmentSetup(
  retention: { keep: number | null },
  disk: { free: number | null; byPath?: Record<string, number> } = { free: null },
  backend: { available: boolean; gate?: Promise<void> } = { available: true },
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workspace-environments-")));
  directories.push(directory);
  const logger = pino({ level: "silent" });
  const registry = new FileBackedWorkspaceRegistry(join(directory, "workspaces.json"), logger);
  const projects = ["older", "newer", "archived"].map((name) => {
    const root = join(directory, name);
    mkdirSync(root);
    return root;
  });
  const record = (index: number, overrides: { lastChatActivityAt?: string; archivedAt?: string }) =>
    createPersistedWorkspaceRecord({
      workspaceId: `workspace-${index}`,
      projectId: "project",
      cwd: projects[index]!,
      kind: "local_checkout",
      displayName: `Project ${index}`,
      worktreeRoot: projects[index]!,
      mainRepoRoot: projects[index]!,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });
  await registry.upsert(record(0, { lastChatActivityAt: "2026-02-01T00:00:00.000Z" }));
  await registry.upsert(record(1, { lastChatActivityAt: "2026-03-01T00:00:00.000Z" }));
  await registry.archive("workspace-1", "2026-03-02T00:00:00.000Z");
  await registry.upsert(record(2, { lastChatActivityAt: "2026-02-15T00:00:00.000Z" }));
  const trims: Array<{ anchor: string; keep: number; volumeOf?: string }> = [];
  const service = new WorkspaceCleanupService({
    paseoHome: directory,
    registry,
    logger,
    openSource: async (anchor) =>
      backend.available
        ? {
            inspect: async () => ({ eligible: false, lastActivityAt: null }),
            prepare: async () => {},
            release: async () => {},
            trimEnvironments: async (keep, volumeOf) => {
              trims.push({ anchor, keep, ...(volumeOf ? { volumeOf } : {}) });
              await backend.gate;
              return { chats: 3, released: 1, kept: 0 };
            },
            close: async () => {},
          }
        : null,
    isProtected: async () => false,
    stopTerminals: async () => {},
    environmentRetention: () => retention.keep,
    freeBytes: async (path) => disk.byPath?.[path] ?? disk.free,
  });
  services.push(service);
  return { projects, service, trims, logger };
}

test("trims battle environments to the configured limit through the latest open workspace", async () => {
  const retention = { keep: 5 as number | null };
  const { projects, service, trims } = await environmentSetup(retention);
  await service.initialize();
  await vi.waitFor(() => expect(trims).toHaveLength(1));
  // The archived workspace has the newest activity; the request goes through the latest open one.
  expect(trims[0]).toEqual({ anchor: projects[2], keep: 5 });

  // Activity schedules sweeps all the time; one trim a minute is enough until the limit changes.
  service.schedule();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(trims).toHaveLength(1);
  retention.keep = 3;
  service.retentionChanged();
  await vi.waitFor(() => expect(trims).toHaveLength(2));
  expect(trims[1]?.keep).toBe(3);

  expect(await service.trimEnvironments(0)).toEqual({ chats: 3, released: 1, kept: 0 });
  expect(trims[2]?.keep).toBe(0);
});

test("a sweep inside the trim interval trims once the interval ends", async () => {
  const { service, trims } = await environmentSetup({ keep: 3 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await service.initialize();
    await vi.waitFor(() => expect(trims).toHaveLength(1));
    // A battle ends 40 seconds later, and nothing happens after it.
    await vi.advanceTimersByTimeAsync(40_000);
    service.schedule();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(trims).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(trims).toHaveLength(2));
    expect(trims[1]?.keep).toBe(3);
    // With nothing new to sweep, no further trim follows.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(trims).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("leaves every chat's battle environments when the limit is off", async () => {
  const { service, trims } = await environmentSetup({ keep: null });
  await service.initialize();
  service.schedule();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(trims).toEqual([]);
});

test("follows the configured worktree limit, and keeping every worktree removes none", async () => {
  const limit = { value: null as number | null };
  const { roots, service, prepared } = await setup({ worktreeRetention: () => limit.value });
  await service.initialize();
  service.schedule();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(prepared).toEqual([]);
  expect(roots.filter(existsSync)).toHaveLength(16);

  // Fourteen of the sixteen are pinned, so a limit of fourteen removes both unpinned ones.
  limit.value = 14;
  service.retentionChanged();
  await vi.waitFor(() => expect(roots.filter(existsSync)).toHaveLength(14), { timeout: 30_000 });
  expect(prepared.toSorted()).toEqual([roots[0], roots[1]].toSorted());
}, 45_000);

test("keeps only the latest chat's battle environments while the disk is low, whatever the limit", async () => {
  const retention = { keep: null as number | null };
  const disk = { free: 4_000_000_000 as number | null };
  const { projects, service, trims } = await environmentSetup(retention, disk);
  await service.initialize();
  await vi.waitFor(() => expect(trims).toHaveLength(1));
  // Both open projects share the test's volume, which is trimmed once, through the latest of them.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(trims).toEqual([{ anchor: projects[2], keep: 1, volumeOf: projects[2] }]);

  retention.keep = 5;
  disk.free = 200_000_000_000;
  service.retentionChanged();
  await vi.waitFor(() => expect(trims).toHaveLength(2));
  expect(trims[1]).toEqual({ anchor: projects[2], keep: 5 });

  expect(await service.environmentStatus()).toEqual({
    freeBytes: 200_000_000_000,
    lowDiskBytes: 10_000_000_000,
  });
});

test("a full volume keeps only its own latest chat's environments, and others keep the limit", async () => {
  const disk = { free: 500_000_000_000 as number | null, byPath: {} as Record<string, number> };
  const { projects, service, trims } = await environmentSetup({ keep: 5 }, disk);
  // The latest project has room; an older one's volume is almost full.
  disk.byPath[projects[0]!] = 3_000_000_000;
  await service.initialize();
  await vi.waitFor(() => expect(trims).toHaveLength(2));
  expect(trims).toEqual([
    { anchor: projects[2], keep: 5 },
    { anchor: projects[2], keep: 1, volumeOf: projects[0] },
  ]);
  // Storage reports the fullest volume.
  expect((await service.environmentStatus()).freeBytes).toBe(3_000_000_000);
});

test("a sweep stays quiet without the Arena backend, while Free up reports it", async () => {
  const { service, logger } = await environmentSetup(
    { keep: 5 },
    { free: null },
    { available: false },
  );
  const warn = vi.spyOn(logger, "warn");
  await service.initialize();
  service.retentionChanged();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(warn).not.toHaveBeenCalled();
  await expect(service.trimEnvironments(0)).rejects.toThrow("backend is unavailable");
});

test("a limit changed during a sweep is applied by another sweep right after it", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const retention = { keep: 5 as number | null };
  const { service, trims } = await environmentSetup(
    retention,
    { free: null },
    { available: true, gate },
  );
  await service.initialize();
  await vi.waitFor(() => expect(trims).toHaveLength(1));
  // The first trim is still running when the limit drops.
  retention.keep = 2;
  service.retentionChanged();
  open();
  await vi.waitFor(() => expect(trims).toHaveLength(2));
  expect(trims[1]?.keep).toBe(2);
});

test("archive saves a detached worktree's commit and uncommitted files, and Restore files brings them back", async () => {
  const { repo, registry, roots, service, seeded } = await setup({ worktreeRetention: () => null });
  const root = roots[0]!;
  writeFileSync(join(root, "committed.txt"), "c1\n");
  git(root, "add", "committed.txt");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "chat work");
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "file.txt"), "staged\n");
  git(root, "add", "file.txt");
  writeFileSync(join(root, "uncommitted.txt"), "u1\n");
  await registry.update("workspace-0", (record) => ({
    ...record,
    archivedAt: "2026-03-01T00:00:00.000Z",
  }));

  const preserved = await service.preserveForArchive(root);
  expect(preserved).not.toBeNull();
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaning");
  // What archive does to the directory.
  git(repo, "worktree", "remove", "--force", root);
  await preserved!.finish();
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaned");
  expect(workspaceAccess.isClaimed(root)).toBe(true);
  // No branch holds the chat's commit; the snapshot refs do.
  expect(git(repo, "branch", "--contains", head)).toBe("");
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "--prune=now");

  await service.restore("workspace-0");
  expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined();
  expect(workspaceAccess.isClaimed(root)).toBe(false);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "log", "--format=%s", "-1")).toBe("chat work");
  expect(readFileSync(join(root, "committed.txt"), "utf8")).toBe("c1\n");
  expect(readFileSync(join(root, "uncommitted.txt"), "utf8")).toBe("u1\n");
  expect(git(root, "show", ":file.txt")).toBe("staged");
  expect(git(root, "status", "--porcelain")).toBe("M  file.txt\n?? uncommitted.txt");
  expect(seeded).toEqual([{ sourceCwd: repo, worktreePath: root }]);
  // The code is back; nothing keeps the snapshot.
  expect(git(repo, "for-each-ref", "refs/agent-duel/")).toBe("");
}, 45_000);

test("archive saves a worktree on a branch the record does not know, and Restore puts HEAD back on it", async () => {
  const { repo, registry, roots, service } = await setup({ worktreeRetention: () => null });
  const root = roots[0]!;
  // The app's "Create branch here" leaves the record's branch null.
  git(root, "switch", "-c", "chat-branch");
  writeFileSync(join(root, "committed.txt"), "c1\n");
  git(root, "add", "committed.txt");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "branch work");
  writeFileSync(join(root, "untracked.txt"), "u1\n");
  const preserved = await service.preserveForArchive(root);
  git(repo, "worktree", "remove", "--force", root);
  await preserved!.finish();
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaned");

  await service.restore("workspace-0");
  expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("chat-branch");
  expect(git(root, "log", "--format=%s", "-1")).toBe("branch work");
  expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("u1\n");
  expect(git(root, "status", "--porcelain")).toBe("?? untracked.txt");
});

test("Restore leaves HEAD detached when the branch moved on, and releases the snapshot", async () => {
  const { repo, roots, service } = await setup({ worktreeRetention: () => null });
  const root = roots[0]!;
  git(root, "switch", "-c", "moved-branch");
  const head = git(root, "rev-parse", "HEAD");
  const preserved = await service.preserveForArchive(root);
  git(repo, "worktree", "remove", "--force", root);
  await preserved!.finish();
  git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "later");
  git(repo, "branch", "-f", "moved-branch", "HEAD");

  await service.restore("workspace-0");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  expect(git(repo, "for-each-ref", "refs/agent-duel/")).toBe("");
});

test("archive saves a workspace whose record names a branch too, since Paseo's restore drops its uncommitted files", async () => {
  const { repo, registry, roots, service } = await setup({ worktreeRetention: () => null });
  const root = roots[0]!;
  git(root, "switch", "-c", "recorded");
  await registry.update("workspace-0", (record) => ({ ...record, branch: "recorded" }));
  writeFileSync(join(root, "untracked.txt"), "u1\n");
  const preserved = await service.preserveForArchive(root);
  git(repo, "worktree", "remove", "--force", root);
  await preserved!.finish();
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaned");

  await service.restore("workspace-0");
  expect(git(root, "symbolic-ref", "--short", "HEAD")).toBe("recorded");
  expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("u1\n");
  expect((await registry.get("workspace-0"))?.branch).toBe("recorded");
});

test("a kept directory clears the archive snapshot state", async () => {
  const { registry, roots, service } = await setup({ worktreeRetention: () => null });
  const preserved = await service.preserveForArchive(roots[1]!);
  // The removal failed and the directory is still there.
  await preserved!.finish();
  expect((await registry.get("workspace-1"))?.cleanup).toBeUndefined();
  expect(workspaceAccess.isClaimed(roots[1]!)).toBe(false);
});

test("archive keeps the directory instead of saving more than the snapshot size limit", async () => {
  const { registry, roots, service } = await setup({ worktreeRetention: () => null });
  writeFileSync(join(roots[0]!, "big.bin"), Buffer.alloc(SNAPSHOT_MAX_CHANGED_BYTES + 1));
  const error = await service.preserveForArchive(roots[0]!).catch((caught: unknown) => caught);
  expect(describeArchiveKeptWorktree(error)).toEqual({
    reason: "too_large",
    changedMegabytes: 100.1,
    limitMegabytes: 100,
  });
  expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined();
  expect(workspaceAccess.isClaimed(roots[0]!)).toBe(false);
});

test("the kept-directory size rounds to the nearest megabyte and stays above the limit", () => {
  const tooLarge = (changedBytes: number) =>
    describeArchiveKeptWorktree(new CodeSnapshotError("too-large", "too large", { changedBytes }));
  const mebibyte = 1024 * 1024;
  expect(tooLarge(101 * mebibyte + 6)).toMatchObject({ changedMegabytes: 101 });
  expect(tooLarge(101.6 * mebibyte)).toMatchObject({ changedMegabytes: 102 });
  expect(tooLarge(105172173)).toMatchObject({ changedMegabytes: 100.3 });
  expect(tooLarge(100.34 * mebibyte)).toMatchObject({ changedMegabytes: 100.3 });
  expect(tooLarge(100.02 * mebibyte)).toMatchObject({ changedMegabytes: 100.1 });
  expect(tooLarge(100.5 * mebibyte)).toMatchObject({ changedMegabytes: 101 });
});

test("removing a project or a workspace record releases its snapshot", async () => {
  const agentsDeleted: string[] = [];
  const { directory, repo, registry, roots, service } = await setup({
    worktreeRetention: () => null,
    deleteWorkspaceAgents: async (workspaceId) => {
      agentsDeleted.push(workspaceId);
    },
  });
  for (const index of [0, 1]) {
    writeFileSync(join(roots[index]!, "untracked.txt"), "u1\n");
    const preserved = await service.preserveForArchive(roots[index]!);
    git(repo, "worktree", "remove", "--force", roots[index]!);
    await preserved!.finish();
  }
  const snapshots = join(directory, "workspace-snapshots");
  expect(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/agent-duel/").split("\n"),
  ).toHaveLength(6);
  expect(readdirSync(snapshots)).toHaveLength(2);

  await service.releaseProjectSnapshots("other-project");
  expect(readdirSync(snapshots)).toHaveLength(2);
  await registry.update("workspace-1", (record) => ({
    ...record,
    projectId: "removed",
    archivedAt: new Date().toISOString(),
  }));
  await service.releaseProjectSnapshots("removed");
  // No directory and no saved code: the archived record goes with its project.
  expect(await registry.get("workspace-1")).toBeNull();
  expect(agentsDeleted).toEqual(["workspace-1"]);
  expect(workspaceAccess.isClaimed(roots[1]!)).toBe(false);
  expect(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/agent-duel/").split("\n"),
  ).toHaveLength(3);

  const removed = (await registry.get("workspace-0"))!;
  await registry.remove("workspace-0");
  await service.releaseRemovedWorkspaceSnapshot(removed);
  expect(git(repo, "for-each-ref", "refs/agent-duel/")).toBe("");
  expect(readdirSync(snapshots)).toHaveLength(0);
});

test("removing one project keeps a snapshot that another project's record on the same root owns", async () => {
  const agentsDeleted: string[] = [];
  const { repo, registry, roots, service } = await setup({
    worktreeRetention: () => null,
    deleteWorkspaceAgents: async (workspaceId) => {
      agentsDeleted.push(workspaceId);
    },
  });
  await registry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "other-project-workspace",
      projectId: "other-project",
      cwd: roots[0]!,
      kind: "worktree",
      displayName: "Other project",
      worktreeRoot: roots[0]!,
      mainRepoRoot: repo,
      isPaseoOwnedWorktree: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    }),
  );
  writeFileSync(join(roots[0]!, "untracked.txt"), "kept\n");
  const preserved = await service.preserveForArchive(roots[0]!);
  git(repo, "worktree", "remove", "--force", roots[0]!);
  await preserved!.finish();
  for (const workspaceId of ["workspace-0", "other-project-workspace"])
    await registry.archive(workspaceId, "2026-03-02T00:00:00.000Z");

  await service.releaseProjectSnapshots("project");

  expect(await registry.get("workspace-0")).toBeNull();
  expect(agentsDeleted).toEqual(["workspace-0"]);
  expect((await registry.get("other-project-workspace"))?.cleanup?.phase).toBe("cleaned");
  expect(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/agent-duel/").split("\n"),
  ).toHaveLength(3);
  await service.restore("other-project-workspace");
  expect(readFileSync(join(roots[0]!, "untracked.txt"), "utf8")).toBe("kept\n");
});

test("a failure before the record goes keeps its snapshot", async () => {
  const { repo, registry, roots, service } = await setup({
    worktreeRetention: () => null,
    deleteWorkspaceAgents: async () => {
      throw new Error("agent storage failed");
    },
  });
  writeFileSync(join(roots[0]!, "untracked.txt"), "kept\n");
  const preserved = await service.preserveForArchive(roots[0]!);
  git(repo, "worktree", "remove", "--force", roots[0]!);
  await preserved!.finish();
  await registry.archive("workspace-0", "2026-03-02T00:00:00.000Z");

  await service.releaseProjectSnapshots("project");

  // The record is still there, so its snapshot must be too: Restore still brings the work back.
  expect((await registry.get("workspace-0"))?.cleanup?.phase).toBe("cleaned");
  expect(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/agent-duel/").split("\n"),
  ).toHaveLength(3);
  await service.restore("workspace-0");
  expect(readFileSync(join(roots[0]!, "untracked.txt"), "utf8")).toBe("kept\n");
});

test("archive keeps the directory when the worktree code cannot be saved", async () => {
  const { registry, roots, service } = await setup({ worktreeRetention: () => null });
  mkdirSync(join(roots[0]!, "nested"));
  git(join(roots[0]!, "nested"), "init");
  const error = await service.preserveForArchive(roots[0]!).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("nested repository");
  expect(describeArchiveKeptWorktree(error)).toEqual({ reason: "unsupported_state" });
  expect(describeArchiveKeptWorktree(new Error("disk full"))).toEqual({ reason: "failed" });
  expect((await registry.get("workspace-0"))?.cleanup).toBeUndefined();
  expect(workspaceAccess.isClaimed(roots[0]!)).toBe(false);
});
