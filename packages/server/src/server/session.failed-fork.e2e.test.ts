import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient, type CreateAgentOptions } from "./test-utils/daemon-client.js";
import { FileBackedWorkspaceRegistry } from "./workspace-registry.js";

let ctx: DaemonTestContext;
let directory: string;
let failFork: boolean;
let beforeFork: (() => Promise<void>) | undefined;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "failed-fork-"));
  writeFileSync(path.join(directory, "keep.txt"), "source files must survive\n");
  failFork = true;
  beforeFork = undefined;
  const clients = createTestAgentClients();
  const provider = clients.opencode;
  provider.forkSession = async (input) => {
    await beforeFork?.();
    if (failFork) throw new Error("Controlled provider fork failure");
    return provider.createSession(input.config, input.launchContext);
  };
  ctx = await createDaemonTestContext({ agentClients: clients });
});

test("disconnect during creation preserves the successful fork", async () => {
  const { source, before } = await sourceAndSibling();
  failFork = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeFork = async () => {
    entered.resolve();
    await release.promise;
  };
  const disconnected = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await disconnected.connect();
  const pending = disconnected
    .createAgent({
      config: { provider: "opencode", cwd: directory, title: "Disconnected fork" },
      forkFrom: { sourceAgentId: source.id },
    })
    .catch(() => undefined);
  try {
    await entered.promise;
    await disconnected.close();
  } finally {
    release.resolve();
  }
  await pending;
  await expect.poll(() => ctx.daemon.daemon.agentManager.listAgents().length).toBe(2);
  const fork = ctx.daemon.daemon.agentManager.listAgents().find((agent) => agent.id !== source.id);
  expect((await ctx.client.fetchWorkspaces()).entries).toHaveLength(before.length + 1);
  expect(
    (await ctx.client.fetchWorkspaces()).entries.some(
      (workspace) => workspace.id === fork?.workspaceId,
    ),
  ).toBe(true);
  expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe(
    "source files must survive\n",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  rmSync(directory, { recursive: true, force: true });
});

async function sourceAndSibling() {
  const source = await ctx.client.createAgent({
    config: { provider: "opencode", cwd: directory, title: "Source" },
  });
  const sibling = await ctx.client.createWorkspace({
    source: { kind: "directory", path: directory },
    title: "Sibling",
  });
  expect(sibling.error).toBeNull();
  const before = (await ctx.client.fetchWorkspaces()).entries.map((w) => w.id).sort();
  return { source, before };
}

function makeGitRepo() {
  execFileSync("git", ["init", "-b", "main", directory]);
  execFileSync("git", ["add", "keep.txt"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
}

test.each(["directory", "worktree", "non-git"] as const)(
  "%s fork failure cleans only the new workspace and retry succeeds",
  async (kind) => {
    if (kind !== "non-git") makeGitRepo();
    const { source, before } = await sourceAndSibling();
    const request: CreateAgentOptions = {
      config: { provider: "opencode", cwd: directory, title: "Source (2)" },
      forkFrom: { sourceAgentId: source.id },
      ...(kind === "worktree"
        ? {
            worktree: {
              mode: "branch-off",
              newBranch: "retry-fork",
              base: "main",
              workspaceTitle: "Source (2)",
            },
          }
        : {}),
    };
    await expect(ctx.client.createAgent(request)).rejects.toThrow(
      "Controlled provider fork failure",
    );
    expect((await ctx.client.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(before);
    expect((await ctx.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
      source.id,
    ]);
    expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe(
      "source files must survive\n",
    );
    if (kind === "worktree") {
      expect((await ctx.client.getPaseoWorktreeList({ cwd: directory })).worktrees).toEqual([]);
    }

    failFork = false;
    const fork = await ctx.client.createAgent(request);
    expect(fork.workspaceId).not.toBe(source.workspaceId);
    expect(fork.title).toBe("Source (2)");
    const after = (await ctx.client.fetchWorkspaces()).entries;
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((w) => w.id === fork.workspaceId)?.name).toBe("Source (2)");
    expect(existsSync(fork.cwd)).toBe(true);
    // Reload the connection instead of trusting a renderer-local removal.
    const reloaded = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
    try {
      await reloaded.connect();
      expect((await reloaded.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(
        after.map((w) => w.id).sort(),
      );
    } finally {
      await reloaded.close();
    }
    if (kind === "worktree") await ctx.client.archivePaseoWorktree({ worktreePath: fork.cwd });
  },
);

test("invalid fork source leaves no new workspace", async () => {
  const { before } = await sourceAndSibling();
  await expect(
    ctx.client.createAgent({
      config: { provider: "opencode", cwd: directory },
      forkFrom: { sourceAgentId: "missing-source" },
    }),
  ).rejects.toThrow();
  expect((await ctx.client.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(before);
});

test("failure in an explicitly supplied workspace preserves that workspace", async () => {
  const { source, before } = await sourceAndSibling();
  await expect(
    ctx.client.createAgent({
      config: { provider: "opencode", cwd: directory },
      workspaceId: source.workspaceId,
      forkFrom: { sourceAgentId: source.id },
    }),
  ).rejects.toThrow("Controlled provider fork failure");
  expect((await ctx.client.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(before);
});

test("context preparation failure does not create a workspace", async () => {
  const { before } = await sourceAndSibling();
  await expect(ctx.client.buildAgentForkContext("missing-source")).rejects.toThrow();
  expect((await ctx.client.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(before);
});

test("cleanup failure preserves the original fork error", async () => {
  const { source } = await sourceAndSibling();
  vi.spyOn(FileBackedWorkspaceRegistry.prototype, "archive").mockRejectedValueOnce(
    new Error("Cleanup failed"),
  );
  await expect(
    ctx.client.createAgent({
      config: { provider: "opencode", cwd: directory },
      forkFrom: { sourceAgentId: source.id },
    }),
  ).rejects.toThrow("Controlled provider fork failure");
});

test.each([false, true])(
  "history hydration failure preserves the registered agent (worktree: %s)",
  async (worktree) => {
    if (worktree) makeGitRepo();
    const { source, before } = await sourceAndSibling();
    failFork = false;
    vi.spyOn(ctx.daemon.daemon.agentManager, "hydrateTimelineFromProvider").mockRejectedValueOnce(
      new Error("History hydration failed"),
    );
    await expect(
      ctx.client.createAgent({
        config: { provider: "opencode", cwd: directory, title: "Preserved fork" },
        forkFrom: { sourceAgentId: source.id },
        ...(worktree
          ? { worktree: { mode: "branch-off" as const, newBranch: "preserved-fork", base: "main" } }
          : {}),
      }),
    ).rejects.toThrow("History hydration failed");
    const fork = ctx.daemon.daemon.agentManager
      .listAgents()
      .find((agent) => agent.id !== source.id);
    expect(fork).toBeDefined();
    expect((await ctx.client.fetchWorkspaces()).entries).toHaveLength(before.length + 1);
    expect(existsSync(fork!.cwd)).toBe(true);
    if (worktree) await ctx.client.archivePaseoWorktree({ worktreePath: fork!.cwd });
  },
);
