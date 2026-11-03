import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../utils/run-git-command.js";
import { discoverRecentProjects, type RecentProjectsEnvironment } from "./recent-projects.js";

let root: string;
let home: string;

function repository(name: string): string {
  const directory = path.join(root, "code", name);
  mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "-q");
  git(
    "-c",
    "user.email=qa@localhost",
    "-c",
    "user.name=QA",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Initial",
  );
  return realpathSync(directory);
}

function write(file: string, text: string, usedAt: Date): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, usedAt, usedAt);
  utimesSync(path.dirname(file), usedAt, usedAt);
}

function environment(
  overrides: Partial<RecentProjectsEnvironment> = {},
): RecentProjectsEnvironment {
  return {
    home,
    env: {},
    platform: "linux",
    ignoredRoots: [],
    runGit: runGitCommand,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "recent-projects-"));
  home = path.join(root, "home");
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverRecentProjects", () => {
  it("lists each git project once, from every tool that used it, newest first", async () => {
    const duel = repository("duel");
    const coffee = repository("coffee");
    mkdirSync(path.join(duel, "packages", "app"), { recursive: true });
    const worktree = path.join(root, "worktrees", "duel-feature");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: duel });

    // Claude Code: the working directory is in a message, not the first line.
    write(
      path.join(home, ".claude", "projects", "-code-duel-packages-app", "session.jsonl"),
      [
        JSON.stringify({ type: "summary", sessionId: "s1" }),
        JSON.stringify({ type: "user", cwd: path.join(duel, "packages", "app") }),
      ].join("\n"),
      new Date("2026-10-20T10:00:00Z"),
    );
    // Codex, in a worktree of the same project.
    write(
      path.join(home, ".codex", "sessions", "2026", "10", "27", "rollout-1.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: worktree } })}\n`,
      new Date("2026-10-27T10:00:00Z"),
    );
    // VS Code: a project, a remote folder and a folder outside git.
    const storage = path.join(home, ".config", "Code", "User", "workspaceStorage");
    write(
      path.join(storage, "a", "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(coffee).href }),
      new Date("2026-10-25T10:00:00Z"),
    );
    write(
      path.join(storage, "b", "workspace.json"),
      JSON.stringify({ folder: "vscode-remote://ssh-remote+box/home/me/project" }),
      new Date("2026-10-26T10:00:00Z"),
    );
    const plain = path.join(root, "code", "notes");
    mkdirSync(plain, { recursive: true });
    write(
      path.join(storage, "c", "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(plain).href }),
      new Date("2026-10-28T10:00:00Z"),
    );

    const projects = await discoverRecentProjects(environment());

    expect(projects).toEqual([
      {
        path: duel,
        name: "duel",
        sources: ["claude", "codex"],
        lastUsedAt: "2026-10-27T10:00:00.000Z",
      },
      { path: coffee, name: "coffee", sources: ["vscode"], lastUsedAt: "2026-10-25T10:00:00.000Z" },
    ]);
  });

  it("leaves out scratch folders, folders that are gone and a repository at the home folder", async () => {
    const scratch = path.join(root, "scratch");
    const scratchRepo = path.join(scratch, "experiment");
    mkdirSync(scratchRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: scratchRepo });
    execFileSync("git", ["init", "-q"], { cwd: home });
    const usedAt = new Date("2026-10-27T10:00:00Z");
    for (const [index, cwd] of [scratchRepo, path.join(root, "deleted"), home].entries()) {
      write(
        path.join(home, ".codex", "sessions", "2026", "10", "27", `rollout-${index}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`,
        usedAt,
      );
    }

    expect(await discoverRecentProjects(environment({ ignoredRoots: [scratch] }))).toEqual([]);
  });

  it("finds nothing, without failing, when no tool has history here", async () => {
    expect(await discoverRecentProjects(environment({ platform: "darwin" }))).toEqual([]);
  });
});
