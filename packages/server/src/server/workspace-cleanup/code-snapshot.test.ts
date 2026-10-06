import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { captureCodeSnapshot, restoreCodeSnapshot } from "./code-snapshot.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function createRepository(): { root: string; head: string } {
  const root = mkdtempSync(path.join(tmpdir(), "agent-duel-code-snapshot-"));
  cleanupPaths.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  git(root, ["config", "user.email", "test@getpaseo.local"]);
  git(root, ["config", "user.name", "Paseo Test"]);
  writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n.agent-duel/\n");
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]) };
}

describe("code workspace snapshots", () => {
  test("preserves staged and unstaged changes plus nonignored untracked files after gc", async () => {
    const { root } = createRepository();
    writeFileSync(path.join(root, "tracked.txt"), "staged\n");
    git(root, ["add", "tracked.txt"]);
    writeFileSync(path.join(root, "tracked.txt"), "working\n");
    writeFileSync(path.join(root, "new.txt"), "untracked\n");
    writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
    mkdirSync(path.join(root, ".agent-duel"));
    writeFileSync(path.join(root, ".agent-duel", "generated.txt"), "generated\n");

    const snapshot = await captureCodeSnapshot({
      worktreeRoot: root,
      sourceRepoRoot: root,
      snapshotId: "dirty-state",
    });
    git(root, ["reflog", "expire", "--expire=now", "--all"]);
    git(root, ["gc", "--prune=now"]);

    const restored = `${root}-restored-dirty-state`;
    cleanupPaths.push(restored);
    await restoreCodeSnapshot({
      worktreeRoot: restored,
      sourceRepoRoot: root,
      snapshot,
    });

    expect(readFileSync(path.join(restored, "tracked.txt"), "utf8")).toBe("working\n");
    expect(readFileSync(path.join(restored, "new.txt"), "utf8")).toBe("untracked\n");
    expect(git(restored, ["show", ":tracked.txt"])).toBe("staged");
    expect(git(restored, ["diff", "--", "tracked.txt"])).toContain("+working");
    expect(git(restored, ["status", "--porcelain"])).toContain("MM tracked.txt");
    expect(git(restored, ["status", "--porcelain"])).toContain("?? new.txt");
    expect(git(restored, ["ls-tree", "-r", "--name-only", snapshot.workingCommit])).not.toContain(
      "ignored.txt",
    );
    expect(git(restored, ["ls-tree", "-r", "--name-only", snapshot.workingCommit])).not.toContain(
      ".agent-duel",
    );
  });

  test("restores the exact saved detached HEAD when its source branch advances", async () => {
    const { root, head } = createRepository();
    const snapshot = await captureCodeSnapshot({
      worktreeRoot: root,
      sourceRepoRoot: root,
      snapshotId: "branch-advanced",
    });

    writeFileSync(path.join(root, "advanced.txt"), "advanced\n");
    git(root, ["add", "advanced.txt"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "advanced"]);
    expect(git(root, ["rev-parse", "main"])).not.toBe(head);

    const restored = `${root}-restored-branch-advanced`;
    cleanupPaths.push(restored);
    await restoreCodeSnapshot({
      worktreeRoot: restored,
      sourceRepoRoot: root,
      snapshot,
    });

    expect(git(restored, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(restored, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  test("keeps snapshots for separate workspace ids reachable through gc", async () => {
    const { root } = createRepository();
    const first = await captureCodeSnapshot({
      worktreeRoot: root,
      sourceRepoRoot: root,
      snapshotId: "snapshot-a",
    });
    writeFileSync(path.join(root, "tracked.txt"), "second\n");
    const second = await captureCodeSnapshot({
      worktreeRoot: root,
      sourceRepoRoot: root,
      snapshotId: "snapshot-b",
    });
    git(root, ["reflog", "expire", "--expire=now", "--all"]);
    git(root, ["gc", "--prune=now"]);

    const restoredFirst = `${root}-restored-a`;
    const restoredSecond = `${root}-restored-b`;
    cleanupPaths.push(restoredFirst, restoredSecond);
    await restoreCodeSnapshot({
      worktreeRoot: restoredFirst,
      sourceRepoRoot: root,
      snapshot: first,
    });
    await restoreCodeSnapshot({
      worktreeRoot: restoredSecond,
      sourceRepoRoot: root,
      snapshot: second,
    });

    expect(readFileSync(path.join(restoredFirst, "tracked.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(path.join(restoredSecond, "tracked.txt"), "utf8")).toBe("second\n");
  });

  test("rejects an occupied restore path without changing it", async () => {
    const { root } = createRepository();
    const snapshot = await captureCodeSnapshot({
      worktreeRoot: root,
      sourceRepoRoot: root,
      snapshotId: "occupied-path",
    });
    const occupied = `${root}-occupied`;
    cleanupPaths.push(occupied);
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, "marker.txt"), "keep\n");

    await expect(
      restoreCodeSnapshot({
        worktreeRoot: occupied,
        sourceRepoRoot: root,
        snapshot,
      }),
    ).rejects.toMatchObject({ code: "occupied-path" });
    expect(readFileSync(path.join(occupied, "marker.txt"), "utf8")).toBe("keep\n");
  });

  test("rejects an unmerged index", async () => {
    const { root } = createRepository();
    git(root, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(root, "tracked.txt"), "feature\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "feature"]);
    git(root, ["checkout", "main"]);
    writeFileSync(path.join(root, "tracked.txt"), "main\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "main"]);
    try {
      execFileSync("git", ["merge", "feature"], { cwd: root, stdio: "pipe" });
    } catch {
      // The merge is expected to leave the index unmerged.
    }
    await expect(
      captureCodeSnapshot({
        worktreeRoot: root,
        sourceRepoRoot: root,
        snapshotId: "conflict",
      }),
    ).rejects.toMatchObject({ code: "unsupported-state" });
  });
});
