import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecentProject, RecentProjectSource } from "@getpaseo/protocol/messages";
import { runGitCommand } from "../utils/run-git-command.js";

// Projects the user has worked on in Claude Code, Codex or VS Code on this computer, so the first
// screen can offer them as one-click starts. Everything is read from those tools' own local history
// files; nothing is written, and none of it leaves the daemon except the resulting list.

/** The list the first screen shows, newest first. */
const RESULT_LIMIT = 30;
/** History entries read per tool, newest first; older ones rarely add a project. */
const ENTRY_LIMIT = 300;
const GIT_CONCURRENCY = 8;
/**
 * Bytes read from the start of a history file to find its working directory. A Codex session
 * records it in its first line; a Claude Code session in its first message.
 */
const HEAD_BYTES = 64 * 1024;

export interface RecentProjectsEnvironment {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Folders whose contents are scratch work: never offered as projects. */
  readonly ignoredRoots: readonly string[];
  readonly runGit: typeof runGitCommand;
}

interface Sighting {
  readonly directory: string;
  readonly source: RecentProjectSource;
  readonly usedAt: number;
}

export function defaultRecentProjectsEnvironment(): RecentProjectsEnvironment {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    ignoredRoots: [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
    runGit: runGitCommand,
  };
}

export async function discoverRecentProjects(
  environment: RecentProjectsEnvironment = defaultRecentProjectsEnvironment(),
): Promise<RecentProject[]> {
  const sightings = (
    await Promise.all([
      claudeSightings(environment),
      codexSightings(environment),
      vscodeSightings(environment),
    ])
  ).flat();

  // One git lookup per directory, however many sessions ran in it.
  const latestByDirectory = new Map<string, Sighting[]>();
  for (const sighting of sightings) {
    const list = latestByDirectory.get(sighting.directory) ?? [];
    list.push(sighting);
    latestByDirectory.set(sighting.directory, list);
  }
  const ignored = await Promise.all(environment.ignoredRoots.map(resolvedOrSelf));
  const roots = await mapLimit([...latestByDirectory.keys()], GIT_CONCURRENCY, (directory) =>
    projectRoot(directory, environment, ignored),
  );

  const projects = new Map<string, { sources: Set<RecentProjectSource>; usedAt: number }>();
  [...latestByDirectory.values()].forEach((directorySightings, index) => {
    const root = roots[index];
    if (!root) return;
    const project = projects.get(root) ?? { sources: new Set(), usedAt: 0 };
    for (const sighting of directorySightings) {
      project.sources.add(sighting.source);
      project.usedAt = Math.max(project.usedAt, sighting.usedAt);
    }
    projects.set(root, project);
  });

  return [...projects.entries()]
    .sort(([, left], [, right]) => right.usedAt - left.usedAt)
    .slice(0, RESULT_LIMIT)
    .map(([root, project]) => ({
      path: root,
      name: path.basename(root),
      sources: (["claude", "codex", "vscode"] as const).filter((source) =>
        project.sources.has(source),
      ),
      lastUsedAt: new Date(project.usedAt).toISOString(),
    }));
}

/**
 * The project a directory belongs to: the root of its git repository, or of the main checkout when
 * it is a worktree, so a tool's worktrees count toward the project they came from. Null for a
 * directory that is gone, is not in a repository, or holds scratch work.
 */
async function projectRoot(
  directory: string,
  environment: RecentProjectsEnvironment,
  ignored: readonly string[],
): Promise<string | null> {
  const resolved = await realpath(directory).catch(() => null);
  if (!resolved || isWithin(resolved, ignored)) return null;
  const result = await environment
    .runGit(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd: resolved,
      acceptExitCodes: [0, 128],
    })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const [toplevel, commonDir] = result.stdout.trim().split("\n");
  if (!toplevel || !commonDir) return null;
  const root = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : toplevel;
  const resolvedRoot = await realpath(root).catch(() => null);
  if (!resolvedRoot || isWithin(resolvedRoot, ignored)) return null;
  // A dotfiles repository at the home folder is not a project.
  if (resolvedRoot === (await resolvedOrSelf(environment.home))) return null;
  return resolvedRoot;
}

async function claudeSightings(environment: RecentProjectsEnvironment): Promise<Sighting[]> {
  const configDir =
    environment.env.CLAUDE_CONFIG_DIR?.trim() || path.join(environment.home, ".claude");
  const projectsDir = path.join(configDir, "projects");
  // One folder per working directory; its newest session says when it was last used.
  const sessions = await newestFiles(await subdirectories(projectsDir), (name) =>
    name.endsWith(".jsonl"),
  );
  const sightings = await Promise.all(
    sessions.slice(0, ENTRY_LIMIT).map(async (session) => {
      const directory = workingDirectory(await readHead(session.file));
      return directory ? { directory, source: "claude" as const, usedAt: session.mtimeMs } : null;
    }),
  );
  return sightings.filter((sighting) => sighting !== null);
}

async function codexSightings(environment: RecentProjectsEnvironment): Promise<Sighting[]> {
  const codexHome = environment.env.CODEX_HOME?.trim() || path.join(environment.home, ".codex");
  // sessions/YYYY/MM/DD/rollout-*.jsonl: walking the dated folders newest first finds the
  // recent sessions without listing every one ever recorded.
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (files.length >= ENTRY_LIMIT) return;
    // Dated names sort the same as their dates.
    const names = (await readdir(directory).catch(() => [])).sort((left, right) =>
      right.localeCompare(left),
    );
    for (const name of names) {
      if (files.length >= ENTRY_LIMIT) return;
      const entry = path.join(directory, name);
      if (depth < 3) await walk(entry, depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(entry);
    }
  };
  await walk(path.join(codexHome, "sessions"), 0);
  const sightings = await Promise.all(
    files.map(async (file) => {
      const [head, info] = await Promise.all([readHead(file), stat(file).catch(() => null)]);
      const directory = workingDirectory(head);
      return directory && info
        ? { directory, source: "codex" as const, usedAt: info.mtimeMs }
        : null;
    }),
  );
  return sightings.filter((sighting) => sighting !== null);
}

function vscodeUserDir(environment: RecentProjectsEnvironment): string {
  if (environment.platform === "darwin") {
    return path.join(environment.home, "Library", "Application Support", "Code", "User");
  }
  if (environment.platform === "win32") {
    const appData =
      environment.env.APPDATA?.trim() || path.join(environment.home, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  const configHome =
    environment.env.XDG_CONFIG_HOME?.trim() || path.join(environment.home, ".config");
  return path.join(configHome, "Code", "User");
}

async function vscodeSightings(environment: RecentProjectsEnvironment): Promise<Sighting[]> {
  // workspaceStorage/<hash>/workspace.json names the folder VS Code opened; the folder's own
  // state changes whenever it is used.
  const storage = await subdirectories(path.join(vscodeUserDir(environment), "workspaceStorage"));
  const entries = await Promise.all(
    storage.map(async (directory) => {
      const info = await stat(directory).catch(() => null);
      return info ? { directory, mtimeMs: info.mtimeMs } : null;
    }),
  );
  const newest = entries
    .filter((entry) => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, ENTRY_LIMIT);
  const sightings = await Promise.all(
    newest.map(async (entry) => {
      const directory = folderPath(await readHead(path.join(entry.directory, "workspace.json")));
      return directory ? { directory, source: "vscode" as const, usedAt: entry.mtimeMs } : null;
    }),
  );
  return sightings.filter((sighting) => sighting !== null);
}

/** A local folder from a workspace.json; remote and multi-root workspaces are not projects here. */
function folderPath(text: string): string | null {
  try {
    const value = (JSON.parse(text) as { folder?: unknown }).folder;
    if (typeof value !== "string" || !value.startsWith("file://")) return null;
    return fileURLToPath(value);
  } catch {
    return null;
  }
}

const CWD_PATTERN = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

function workingDirectory(text: string): string | null {
  const match = CWD_PATTERN.exec(text);
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}

async function subdirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

/** The newest matching file in each folder, newest folder first. */
async function newestFiles(
  directories: readonly string[],
  matches: (name: string) => boolean,
): Promise<{ file: string; mtimeMs: number }[]> {
  const newest = await Promise.all(
    directories.map(async (directory) => {
      const names = (await readdir(directory).catch(() => [])).filter(matches);
      const files = await Promise.all(
        names.map(async (name) => {
          const file = path.join(directory, name);
          const info = await stat(file).catch(() => null);
          return info ? { file, mtimeMs: info.mtimeMs } : null;
        }),
      );
      return files
        .filter((entry) => entry !== null)
        .reduce<{ file: string; mtimeMs: number } | null>(
          (best, entry) => (!best || entry.mtimeMs > best.mtimeMs ? entry : best),
          null,
        );
    }),
  );
  return newest
    .filter((entry) => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function resolvedOrSelf(directory: string): Promise<string> {
  return (await realpath(directory).catch(() => null)) ?? path.resolve(directory);
}

function isWithin(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
