import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/daemon-client.js";

async function startDaemon(home: string, phase: string) {
  const child = fork(
    path.join(import.meta.dirname, "test-utils/fork-crash-daemon.ts"),
    [home, phase],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(30_000) });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${ready.port}/ws` });
  await client.connect();
  return { child, client };
}

async function stopDaemon(running: Awaited<ReturnType<typeof startDaemon>>) {
  await running.client.close();
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = once(running.child, "exit");
  running.child.disconnect();
  await exited;
}

test.each([
  { kind: "directory", phase: "before-registration", retainedForks: 0 },
  { kind: "worktree", phase: "before-registration", retainedForks: 0 },
  { kind: "non-git", phase: "before-registration", retainedForks: 0 },
  { kind: "directory", phase: "after-registration", retainedForks: 1 },
  { kind: "worktree", phase: "after-registration", retainedForks: 1 },
  { kind: "non-git", phase: "after-registration", retainedForks: 1 },
])(
  "$kind restart at $phase preserves only registered forks",
  async ({ kind, phase, retainedForks }) => {
    const home = await mkdtemp(path.join(tmpdir(), "fork-crash-"));
    const cwd = path.join(home, "source");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "keep.txt"), "source remains\n");
    if (kind !== "non-git") {
      execFileSync("git", ["init", "-b", "main", cwd]);
      execFileSync("git", ["add", "."], { cwd });
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
        { cwd },
      );
    }
    let running = await startDaemon(home, phase);
    try {
      const source = await running.client.createAgent({
        config: { provider: "opencode", cwd, title: "Source" },
      });
      await running.client.createWorkspace({
        source: { kind: "directory", path: cwd },
        title: "Empty sibling",
      });
      const before = (await running.client.fetchWorkspaces()).entries.map((w) => w.id).sort();
      const request = {
        config: { provider: "opencode", cwd, title: "Fork" },
        forkFrom: { sourceAgentId: source.id },
        ...(kind === "worktree"
          ? {
              worktree: {
                mode: "branch-off" as const,
                newBranch: "crash-fork",
                base: "main",
                workspaceTitle: "Fork",
              },
            }
          : {}),
      };
      const paused = once(running.child, "message", { signal: AbortSignal.timeout(30_000) });
      const pending = running.client.createAgent(request).catch(() => undefined);
      await paused;
      const atPause = (await running.client.fetchWorkspaces()).entries;
      expect(atPause).toHaveLength(before.length + 1);
      if (kind === "worktree") {
        expect(await readdir(path.join(home, ".paseo", "pending-fork-worktrees"))).toHaveLength(0);
      }
      const createdWorkspace = atPause.find((w) => !before.includes(w.id))!;
      const createdAgentIds = (await running.client.fetchAgents()).entries
        .map((e) => e.agent.id)
        .sort();
      // Simulate setup output or a manual edit while the provider is starting.
      await writeFile(
        path.join(createdWorkspace.workspaceDirectory, "during-fork.txt"),
        "keep this too\n",
      );
      const exited = once(running.child, "exit");
      running.child.kill("SIGKILL");
      await exited;
      await running.client.close();
      await pending;
      running = await startDaemon(home, "normal");
      const after = (await running.client.fetchWorkspaces()).entries.map((w) => w.id).sort();
      const expected = [...before, ...(retainedForks ? [createdWorkspace.id] : [])].sort();
      expect(after).toEqual(expected);
      expect((await running.client.fetchAgents()).entries.map((e) => e.agent.id).sort()).toEqual(
        createdAgentIds,
      );
      expect(await readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("source remains\n");
      expect(
        await readFile(path.join(createdWorkspace.workspaceDirectory, "during-fork.txt"), "utf8"),
      ).toBe("keep this too\n");
      const retry = await running.client.createAgent(request);
      expect((await running.client.fetchWorkspaces()).entries).toHaveLength(
        before.length + retainedForks + 1,
      );
      expect(retry.workspaceId).not.toBe(source.workspaceId);
      const afterRetry = (await running.client.fetchWorkspaces()).entries.map((w) => w.id).sort();
      await stopDaemon(running);
      running = await startDaemon(home, "normal");
      expect((await running.client.fetchWorkspaces()).entries.map((w) => w.id).sort()).toEqual(
        afterRetry,
      );
      expect((await running.client.fetchAgents()).entries.map((e) => e.agent.id).sort()).toEqual(
        [...createdAgentIds, retry.id].sort(),
      );
    } finally {
      await stopDaemon(running);
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test.each([{ localFile: "none" }, { localFile: "untracked" }, { localFile: "ignored" }])(
  "a fork crash before its workspace record recovers a worktree with localFile=$localFile",
  async ({ localFile }) => {
    const home = await mkdtemp(path.join(tmpdir(), "fork-before-record-"));
    const cwd = path.join(home, "source");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "keep.txt"), "source remains\n");
    await writeFile(path.join(cwd, ".gitignore"), "ignored-notes.txt\n");
    execFileSync("git", ["init", "-b", "main", cwd]);
    execFileSync("git", ["add", "."], { cwd });
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
      { cwd },
    );
    let running = await startDaemon(home, "before-record");
    try {
      const source = await running.client.createAgent({
        config: { provider: "opencode", cwd, title: "Source" },
      });
      const paused = once(running.child, "message", { signal: AbortSignal.timeout(30_000) });
      const pending = running.client
        .createAgent({
          config: { provider: "opencode", cwd, title: "Fork" },
          forkFrom: { sourceAgentId: source.id },
          worktree: {
            mode: "branch-off",
            newBranch: "pre-record-fork",
            base: "main",
            workspaceTitle: "Fork",
          },
        })
        .catch(() => undefined);
      const [pause] = await paused;
      expect(pause).toMatchObject({ paused: "before-record", worktreePath: expect.any(String) });
      const worktreePath = pause.worktreePath as string;
      expect((await running.client.fetchWorkspaces()).entries).toHaveLength(1);
      expect(await readdir(path.join(home, ".paseo", "pending-fork-worktrees"))).toHaveLength(1);
      if (localFile !== "none") {
        await writeFile(
          path.join(
            worktreePath,
            localFile === "ignored" ? "ignored-notes.txt" : "local-notes.txt",
          ),
          "preserve me\n",
        );
      }
      const exited = once(running.child, "exit");
      running.child.kill("SIGKILL");
      await exited;
      await running.client.close();
      await pending;
      running = await startDaemon(home, "normal");
      expect((await running.client.fetchWorkspaces()).entries).toHaveLength(1);
      expect(await readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("source remains\n");
      expect(
        execFileSync("git", ["branch", "--list", "pre-record-fork"], {
          cwd,
          encoding: "utf8",
        }).trim(),
      ).toMatch(/^(\+ )?pre-record-fork$/);
      if (localFile !== "none") {
        expect(
          await readFile(
            path.join(
              worktreePath,
              localFile === "ignored" ? "ignored-notes.txt" : "local-notes.txt",
            ),
            "utf8",
          ),
        ).toBe("preserve me\n");
        const records = JSON.parse(
          await readFile(path.join(home, ".paseo", "projects", "workspaces.json"), "utf8"),
        ) as Array<{
          workspaceId: string;
          projectId: string;
          worktreeRoot: string | null;
          archivedAt: string | null;
          pendingFork?: true;
        }>;
        const recovered = records.find((record) => record.worktreeRoot === worktreePath);
        const sourceRecord = records.find((record) => record.workspaceId === source.workspaceId);
        expect(recovered).toMatchObject({ archivedAt: expect.any(String) });
        expect(recovered?.projectId).toBe(sourceRecord?.projectId);
        expect(recovered?.pendingFork).toBeUndefined();
        expect(await running.client.listWorkspaceRecoveries()).toEqual([
          expect.objectContaining({ workspaceId: recovered!.workspaceId, cwd: worktreePath }),
        ]);
        expect(await readdir(path.join(home, ".paseo", "pending-fork-worktrees"))).toHaveLength(0);
        await stopDaemon(running);
        running = await startDaemon(home, "normal");
        const restartedRecords = JSON.parse(
          await readFile(path.join(home, ".paseo", "projects", "workspaces.json"), "utf8"),
        ) as typeof records;
        expect(
          restartedRecords.filter((record) => record.worktreeRoot === worktreePath),
        ).toHaveLength(1);
        expect(await running.client.listWorkspaceRecoveries()).toEqual([
          expect.objectContaining({ workspaceId: recovered!.workspaceId }),
        ]);
        expect(await running.client.inspectWorkspaceRecovery(recovered!.workspaceId)).toMatchObject(
          {
            kind: "recoverable",
            action: "unarchive",
          },
        );
        await running.client.restoreWorkspace(recovered!.workspaceId);
        expect((await running.client.fetchWorkspaces()).entries).toHaveLength(2);
        expect(
          await readFile(
            path.join(
              worktreePath,
              localFile === "ignored" ? "ignored-notes.txt" : "local-notes.txt",
            ),
            "utf8",
          ),
        ).toBe("preserve me\n");
        expect(await running.client.listWorkspaceRecoveries()).toEqual([]);
        await running.client.archiveWorkspace(recovered!.workspaceId);
        expect(await running.client.listWorkspaceRecoveries()).toEqual([]);
      } else {
        expect(await running.client.listWorkspaceRecoveries()).toEqual([]);
        await expect(readFile(path.join(worktreePath, "keep.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readdir(path.join(home, ".paseo", "pending-fork-worktrees"))).toHaveLength(0);
      }
    } finally {
      await stopDaemon(running);
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
