import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../utils/run-git-command.js";
import { initializeProjectGit, inspectProjectGit } from "./project-git-service.js";

describe("project Git bootstrap", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // Every command reads only the config this test writes, never the developer's.
  async function createSandbox(globalConfig = "") {
    const root = await mkdtemp(join(tmpdir(), "paseo-project-git-"));
    roots.push(root);
    const globalPath = join(root, "global.gitconfig");
    const systemPath = join(root, "system.gitconfig");
    await writeFile(globalPath, globalConfig, "utf8");
    await writeFile(systemPath, "", "utf8");
    const envOverlay = { GIT_CONFIG_GLOBAL: globalPath, GIT_CONFIG_SYSTEM: systemPath };
    const runGit: typeof runGitCommand = (args, options) =>
      runGitCommand(args, { ...options, envOverlay: { ...options.envOverlay, ...envOverlay } });
    const folder = join(root, "project");
    await mkdir(folder);
    const git = async (args: string[], cwd = folder) => (await runGit(args, { cwd })).stdout.trim();
    return { root, folder, runGit, git };
  }

  it("reports a folder outside any repository as not_git", async () => {
    const { folder, runGit } = await createSandbox();
    await expect(inspectProjectGit(folder, runGit)).resolves.toBe("not_git");
  });

  it("reports a repository without commits as no_commit and a committed one as ready", async () => {
    const { folder, runGit, git } = await createSandbox();
    await git(["init", "--template="]);
    await expect(inspectProjectGit(folder, runGit)).resolves.toBe("no_commit");
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "first",
    ]);
    await expect(inspectProjectGit(folder, runGit)).resolves.toBe("ready");
    const nested = join(folder, "nested");
    await mkdir(nested);
    await expect(inspectProjectGit(nested, runGit)).resolves.toBe("ready");
  });

  it("creates a repository on main with an empty first commit and leaves files uncommitted", async () => {
    const { folder, runGit, git } = await createSandbox();
    await writeFile(join(folder, "readme.txt"), "hi\n", "utf8");

    await expect(initializeProjectGit(folder, runGit)).resolves.toBe(true);

    expect(await git(["branch", "--show-current"])).toBe("main");
    expect(await git(["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(["ls-tree", "-r", "HEAD"])).toBe("");
    expect(await git(["status", "--porcelain"])).toBe("?? readme.txt");
    expect(await git(["show", "-s", "--format=%an <%ae>|%cn <%ce>|%s", "HEAD"])).toBe(
      "Agent Duel <agent-duel@localhost>|Agent Duel <agent-duel@localhost>|Initialize project",
    );
    await expect(inspectProjectGit(folder, runGit)).resolves.toBe("ready");
  });

  it("uses the configured default branch and the user's identity", async () => {
    const { folder, runGit, git } = await createSandbox(
      "[init]\n  defaultBranch = trunk\n[user]\n  name = Dev Person\n  email = dev@example.test\n",
    );

    await initializeProjectGit(folder, runGit);

    expect(await git(["branch", "--show-current"])).toBe("trunk");
    expect(await git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"])).toBe(
      "Dev Person <dev@example.test>|Dev Person <dev@example.test>",
    );
  });

  it("falls back to the Agent Duel identity when only part of the user's is set", async () => {
    const { folder, runGit, git } = await createSandbox("[user]\n  name = Only Name\n");

    await initializeProjectGit(folder, runGit);

    expect(await git(["show", "-s", "--format=%an <%ae>", "HEAD"])).toBe(
      "Agent Duel <agent-duel@localhost>",
    );
  });

  it("commits nothing a repository without commits had staged, and keeps its branch", async () => {
    const { folder, runGit, git } = await createSandbox();
    await git(["init", "--template="]);
    await git(["symbolic-ref", "HEAD", "refs/heads/dev"]);
    await writeFile(join(folder, "staged.txt"), "staged\n", "utf8");
    await writeFile(join(folder, "loose.txt"), "loose\n", "utf8");
    await git(["add", "staged.txt"]);

    await expect(initializeProjectGit(folder, runGit)).resolves.toBe(true);

    expect(await git(["branch", "--show-current"])).toBe("dev");
    expect(await git(["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(["ls-tree", "-r", "HEAD"])).toBe("");
    expect(await git(["diff", "--cached", "--name-only"])).toBe("staged.txt");
    expect(await git(["ls-files", "--others", "--exclude-standard"])).toBe("loose.txt");
  });

  it("leaves a repository that already has a commit untouched", async () => {
    const { folder, runGit, git } = await createSandbox();
    await initializeProjectGit(folder, runGit);
    const head = await git(["rev-parse", "HEAD"]);

    await expect(initializeProjectGit(folder, runGit)).resolves.toBe(false);

    expect(await git(["rev-parse", "HEAD"])).toBe(head);
    expect(await git(["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("ignores signing, hooks, and useConfigOnly in the user's configuration", async () => {
    const sandbox = await createSandbox();
    const hooksPath = join(sandbox.root, "hooks");
    const hookMarker = join(sandbox.root, "hook-ran");
    await mkdir(hooksPath);
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "reference-transaction"]) {
      const file = join(hooksPath, hook);
      await writeFile(file, `#!/bin/sh\ntouch "${hookMarker}"\nexit 1\n`, "utf8");
      await chmod(file, 0o755);
    }
    await writeFile(
      join(sandbox.root, "global.gitconfig"),
      `[commit]\n  gpgsign = true\n[core]\n  hooksPath = ${hooksPath}\n[user]\n  signingkey = missing-signing-key\n  useConfigOnly = true\n`,
      "utf8",
    );

    await initializeProjectGit(sandbox.folder, sandbox.runGit);

    await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await sandbox.git(["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await sandbox.git(["show", "-s", "--format=%G?", "HEAD"])).toBe("N");
  });

  it("removes only the repository it created when the first commit fails", async () => {
    const { folder, runGit } = await createSandbox();
    await writeFile(join(folder, "keep.txt"), "keep\n", "utf8");
    const failingGit: typeof runGitCommand = (args, options) => {
      if (args[0] === "commit-tree") return Promise.reject(new Error("commit failed"));
      return runGit(args, options);
    };

    await expect(initializeProjectGit(folder, failingGit)).rejects.toThrow("commit failed");

    await expect(access(join(folder, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(folder, "keep.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("keeps an existing repository when its first commit fails", async () => {
    const { folder, runGit, git } = await createSandbox();
    await git(["init", "--template="]);
    const failingGit: typeof runGitCommand = (args, options) => {
      if (args[0] === "commit-tree") return Promise.reject(new Error("commit failed"));
      return runGit(args, options);
    };

    await expect(initializeProjectGit(folder, failingGit)).rejects.toThrow("commit failed");

    await expect(access(join(folder, ".git"))).resolves.toBeUndefined();
    await expect(inspectProjectGit(folder, runGit)).resolves.toBe("no_commit");
  });
});
