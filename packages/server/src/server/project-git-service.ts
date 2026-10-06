import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectGitState } from "@getpaseo/protocol/messages";
import { runGitCommand } from "../utils/run-git-command.js";

type RunGit = typeof runGitCommand;

const FALLBACK_IDENTITY = { name: "Agent Duel", email: "agent-duel@localhost" };
const FALLBACK_BRANCH = "main";
const INITIAL_COMMIT_MESSAGE = "Initialize project";

/**
 * Arena needs a real HEAD to freeze a battle base and cut contestant worktrees. A folder
 * inside another repository's work tree reports that repository's state, because that
 * repository is the one Arena would battle on.
 */
export async function inspectProjectGit(
  directory: string,
  runGit: RunGit = runGitCommand,
): Promise<ProjectGitState> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: directory,
    acceptExitCodes: [0, 128],
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return "not_git";
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: directory,
    acceptExitCodes: [0, 1],
  });
  return head.exitCode === 0 ? "ready" : "no_commit";
}

/**
 * Give an existing folder the first commit Arena needs, leaving its files uncommitted.
 * Resolves true when it changed the folder's Git state.
 */
export async function initializeProjectGit(
  directory: string,
  runGit: RunGit = runGitCommand,
): Promise<boolean> {
  const state = await inspectProjectGit(directory, runGit);
  if (state === "ready") return false;
  if (state === "no_commit") {
    await createInitialCommit(directory, runGit);
    return true;
  }
  try {
    await initializeRepository(directory, runGit);
    return true;
  } catch (error) {
    // Only the repository this call created is removed; the folder and its files stay.
    await rm(resolve(directory, ".git"), { recursive: true, force: true });
    throw error;
  }
}

/**
 * `git init` plus an empty first commit. Callers own rollback of the `.git` it creates.
 * Always a new repository, even inside another work tree, so a new project never commits
 * into its parent's history.
 */
export async function initializeRepository(
  directory: string,
  runGit: RunGit = runGitCommand,
): Promise<void> {
  const configuredBranch = await readGitConfig(runGit, directory, "init.defaultBranch");
  await runGit([...withoutHooks(directory), "init", "--template="], { cwd: directory });
  if (!configuredBranch) {
    // `symbolic-ref` rather than `init --initial-branch`, which needs Git 2.28.
    await runGit(
      [...withoutHooks(directory), "symbolic-ref", "HEAD", `refs/heads/${FALLBACK_BRANCH}`],
      { cwd: directory },
    );
  }
  await createInitialCommit(directory, runGit);
}

// Plumbing on purpose: `commit` would record whatever is staged and run the commit hooks.
// The empty tree comes from a throwaway index, so the real index keeps the user's staged
// files, and `update-ref` with an empty old value refuses if a commit appeared meanwhile.
async function createInitialCommit(directory: string, runGit: RunGit): Promise<void> {
  const emptyIndex = join(tmpdir(), `agent-duel-empty-index-${randomUUID()}`);
  let tree: string;
  try {
    const written = await runGit(["write-tree"], {
      cwd: directory,
      envOverlay: { GIT_INDEX_FILE: emptyIndex },
    });
    tree = written.stdout.trim();
  } finally {
    await rm(emptyIndex, { force: true });
  }
  const identity = await resolveIdentity(runGit, directory);
  const commit = await runGit(
    ["commit-tree", "--no-gpg-sign", "-m", INITIAL_COMMIT_MESSAGE, tree],
    {
      cwd: directory,
      envOverlay: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    },
  );
  await runGit(
    [
      ...withoutHooks(directory),
      "update-ref",
      "-m",
      INITIAL_COMMIT_MESSAGE,
      "HEAD",
      commit.stdout.trim(),
      "",
    ],
    { cwd: directory },
  );
}

// Plumbing still runs the reference-transaction hook when a ref moves. Point hooks at a
// directory that never exists so a global hooksPath cannot veto the bootstrap.
function withoutHooks(directory: string): string[] {
  return ["-c", `core.hooksPath=${resolve(directory, ".git", "agent-duel-no-hooks")}`];
}

async function resolveIdentity(
  runGit: RunGit,
  directory: string,
): Promise<{ name: string; email: string }> {
  const name = await readGitConfig(runGit, directory, "user.name");
  const email = await readGitConfig(runGit, directory, "user.email");
  // A half-configured identity is not the user's; mixing it with the fallback would be neither.
  return name && email ? { name, email } : FALLBACK_IDENTITY;
}

async function readGitConfig(runGit: RunGit, directory: string, key: string): Promise<string> {
  const result = await runGit(["config", "--get", key], {
    cwd: directory,
    acceptExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}
