import { promisify } from "util";
import { constants as fsConstants, realpath } from "fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join, basename, dirname, isAbsolute, resolve, sep } from "path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import pLimit from "p-limit";
export {
  PaseoConfigRawSchema,
  PaseoLifecycleCommandRawSchema,
  PaseoScriptEntryRawSchema,
  PaseoWorktreeConfigRawSchema,
  PaseoConfigSchema,
  type PaseoConfig,
  type PaseoConfigRaw,
} from "@getpaseo/protocol/paseo-config-schema";
import {
  createPaseoWorktreeChangeRequestHint,
  hasPaseoWorktreeMetadata,
  findPaseoWorktreeRootForCwd,
  normalizeBaseRefName,
  isQualifiedRef,
  type PaseoWorktreeChangeRequestHint,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { getCurrentBranch, resolveRepositoryDefaultBranch } from "./checkout-git.js";
import { ignoreForFileProviderSync } from "./file-provider-ignore.js";
import type { Logger } from "pino";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import {
  expandTilde,
  getRealpathAwareRelativePath,
  getRelativePathInsideRoot,
  isPathInsideRoot,
} from "./path.js";

export { slugify, validateBranchSlug } from "@getpaseo/protocol/branch-slug";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export interface CreatedWorktree extends WorktreeConfig {
  comparisonBaseRef: string | null;
}

export interface WorktreeRuntimeEnv {
  [key: string]: string;
  PASEO_SOURCE_CHECKOUT_PATH: string;
  PASEO_ROOT_PATH: string;
  PASEO_WORKTREE_PATH: string;
  PASEO_BRANCH_NAME: string;
  PASEO_WORKTREE_PORT: string;
}

export interface WorktreeSetupCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type WorktreeSetupCommandProgressEvent =
  | {
      type: "command_started";
      index: number;
      total: number;
      command: string;
      cwd: string;
    }
  | {
      type: "output";
      index: number;
      total: number;
      command: string;
      cwd: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "command_completed";
      index: number;
      total: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    };

export interface WorktreeTerminalConfig {
  name?: string;
  command: string;
}

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number; // explicit port override, otherwise auto-assigned
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
}

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export type WorktreeTeardownCommandResult = WorktreeSetupCommandResult;

export class WorktreeTeardownError extends Error {
  readonly results: WorktreeTeardownCommandResult[];

  constructor(message: string, results: WorktreeTeardownCommandResult[]) {
    super(message);
    this.name = "WorktreeTeardownError";
    this.results = results;
  }
}

export interface PaseoWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export interface PaseoWorktreeOwnership {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
}

export interface PaseoWorktreeOwnershipOptions extends WorktreeRootOptions {
  knownGitCommonDir?: string | null;
}

export interface WorktreeRootOptions {
  paseoHome?: string;
  worktreesRoot?: string;
}

export interface WorktreeCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export type WorktreeSource =
  | { kind: "branch-off"; baseBranch: string; branchName: string }
  | { kind: "checkout-branch"; branchName: string }
  // A detached HEAD at `baseRef`. No branch is created or checked out, so the same ref can
  // back any number of worktrees at once; a branch is created later, in place, if wanted.
  | { kind: "detached"; baseRef: string }
  | { kind: "restore"; branchName: string; baseRef: string | null }
  | { kind: "restore-from-base"; baseRef: string; branchName: string }
  | {
      kind: "checkout-change-request";
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      headRepository?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

/**
 * Fill a freshly created worktree with the source checkout's ignored content, before its
 * setup commands run. A dependency tree cloned from the checkout turns `npm install` into a
 * no-op check, so a new worktree is ready in seconds rather than minutes.
 */
export type WorktreeSeedFn = (input: { sourceCwd: string; worktreePath: string }) => Promise<void>;

export interface CreateWorktreeOptions {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  paseoHome?: string;
  worktreesRoot?: string;
  seedIgnoredContent?: WorktreeSeedFn;
  onBeforeAdd?: (worktreePath: string) => Promise<void>;
  onAddFailed?: (worktreePath: string) => Promise<void>;
  logger?: Pick<Logger, "warn">;
  worktreePath?: string;
}

export class BranchAlreadyCheckedOutError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Branch already checked out: ${branchName}`);
    this.name = "BranchAlreadyCheckedOutError";
    this.branchName = branchName;
  }
}

export class UnknownBranchError extends Error {
  readonly branchName: string;
  readonly cwd: string;

  constructor(params: { branchName: string; cwd: string }) {
    super(`Unknown branch: ${params.branchName}`);
    this.name = "UnknownBranchError";
    this.branchName = params.branchName;
    this.cwd = params.cwd;
  }
}

export class InvalidGitBranchNameError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Invalid branch name: Git rejected ref name '${branchName}'`);
    this.name = "InvalidGitBranchNameError";
    this.branchName = branchName;
  }
}

export { readPaseoConfig, type ReadPaseoConfigResult } from "./paseo-config-file.js";

export function paseoConfigParseError(failure: { configPath: string; error: unknown }): Error {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return new Error(`Failed to parse paseo.json at ${failure.configPath}: ${detail}`, {
    cause: failure.error,
  });
}

/**
 * Agent Duel does not honour paseo.json worktree lifecycle hooks or scripts.
 * `worktree.setup`, `worktree.teardown`, `worktree.terminals` and `scripts` are
 * read from nowhere, so every project behaves like one that never configured
 * them. The file is still parsed for `worktree.arenaCopy` and
 * `metadataGeneration`, and the project settings editor round-trips the rest of
 * it untouched.
 */
export function getScriptConfigs(): Map<string, ScriptConfig> {
  return new Map();
}

export function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }

  const output: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    output.push(line.join(""));
    line = [];
    cursor = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        flushLine();
        output.push("\n");
        index += 1;
        continue;
      }
      cursor = 0;
      continue;
    }

    if (char === "\n") {
      flushLine();
      output.push("\n");
      continue;
    }

    if (cursor < line.length) {
      line[cursor] = char;
    } else {
      line.push(char);
    }
    cursor += 1;
  }

  if (line.length > 0) {
    output.push(line.join(""));
  }

  return output.join("");
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire available port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      let message: string;
      if (error?.code === "EADDRINUSE") {
        message = `Persisted worktree port ${port} is already in use`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      reject(new Error(message));
    });
    server.listen(port, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  });
}

async function inferRepoRootPathFromWorktreePath(worktreePath: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(worktreePath);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    // Normal repo/worktree: common dir is <repoRoot>/.git
    if (basename(normalizedCommonDir) === ".git") {
      return dirname(normalizedCommonDir);
    }
    // Bare repo: common dir is the repo dir itself
    return normalizedCommonDir;
  } catch {
    // Fallback: best-effort resolve toplevel (will be the worktree root in typical cases)
    try {
      const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: worktreePath,
        envOverlay: READ_ONLY_GIT_ENV,
      });
      const topLevel = parseGitRevParsePath(stdout);
      if (topLevel) {
        return await normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return await normalizePathForOwnership(worktreePath);
  }
}

/**
 * Always resolves to no results: there is no source of setup commands any more.
 * Every worktree takes the path an unconfigured project has always taken — the
 * setup step runs, finds nothing to do, and reports completion — so the progress
 * events around it stay exactly as they are today.
 */
export async function runWorktreeSetupCommands(_options: {
  worktreePath: string;
  branchName: string;
  repoRootPath?: string;
  runtimeEnv?: WorktreeRuntimeEnv;
  signal?: AbortSignal;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult[]> {
  return [];
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], {
      cwd: worktreePath,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const branchName = stdout.trim();
    if (branchName.length > 0) {
      return branchName;
    }
  } catch {
    // ignore
  }

  return basename(worktreePath);
}

export async function resolveWorktreeRuntimeEnv(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeRuntimeEnv> {
  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));

  let worktreePort = await readPaseoWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = await readPaseoWorktreeMetadata(options.worktreePath);
    if (metadata) {
      await writePaseoWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    PASEO_WORKTREE_PORT: String(worktreePort),
  };
}

/** Always resolves to no results, for the same reason as `runWorktreeSetupCommands`. */
export async function runWorktreeTeardownCommands(_options: {
  worktreePath: string;
  teardownCwd?: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeTeardownCommandResult[]> {
  return [];
}

export async function seedPaseoConfigFile(options: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceConfigPath = join(options.sourceCwd, "paseo.json");
  const targetConfigPath = join(options.targetCwd, "paseo.json");
  await copyFile(sourceConfigPath, targetConfigPath, fsConstants.COPYFILE_EXCL).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  });
}

/**
 * Get the git common directory (shared across worktrees) for a given cwd.
 * This is where refs, objects, etc. are stored.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  return commonDir;
}

const WORKTREE_PROJECT_HASH_LENGTH = 8;

function deriveShortAlphanumericHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

export async function deriveWorktreeProjectHash(cwd: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(cwd);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(await normalizePathForOwnership(cwd));
  }
}

/**
 * The directory a checkout keeps Agent Duel's state in, excluded from the checkout. The
 * Arena backend owns the same name (`worktree/layout.ts` there); the two have to agree
 * because a worktree of the project and the contestants of a battle share this root.
 */
export const LOCAL_STATE_DIRNAME = ".agent-duel";

/** Where a project's worktrees live: inside the project, beside its contestants. */
export function localWorktreesRoot(repoRoot: string): string {
  return join(repoRoot, LOCAL_STATE_DIRNAME, "worktrees");
}

/**
 * A worktree's directory name: eight hex characters, random. It names nothing on purpose.
 * A directory named after a branch is wrong the moment the branch changes, and a detached
 * worktree has no branch to begin with; the sidebar carries the readable name.
 */
export function randomWorktreeId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Keep the local-state directory out of the checkout's status and out of any snapshot
 * taken of it. Written to the repository's exclude file rather than `.gitignore`, so the
 * checkout's tracked files are untouched. Mirrors what the Arena backend writes before a
 * battle, so whichever runs first leaves the same line.
 */
export async function ensureLocalStateExcluded(repoRoot: string): Promise<void> {
  const { stdout } = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { cwd: repoRoot },
  );
  const file = stdout.trim();
  const pattern = `/${LOCAL_STATE_DIRNAME}/`;
  const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

/**
 * A worktrees root inside the checkout has to be excluded before anything lands in it, or
 * the very first `git status` shows the new worktree as an untracked directory.
 */
async function prepareLocalStateRoot(
  cwd: string,
  root: string,
  logger: Pick<Logger, "warn"> | undefined,
): Promise<void> {
  if (getRealpathAwareRelativePath(cwd, root) === null) return;
  await ensureLocalStateExcluded(cwd);
  // Cloud sync of the local-state directory turns Arena's rewrites into conflict copies.
  const localState = dirname(root);
  const unsynced =
    basename(localState) === LOCAL_STATE_DIRNAME
      ? await ignoreForFileProviderSync(localState)
      : undefined;
  if (unsynced?.state === "failed") {
    logger?.warn(
      { directory: localState, reason: unsynced.reason },
      "Could not exclude the local-state directory from cloud sync",
    );
  }
}

export function resolvePaseoWorktreesBaseRoot(options?: WorktreeRootOptions): string {
  if (options?.worktreesRoot) {
    const expandedRoot = expandTilde(options.worktreesRoot);
    if (isAbsolute(expandedRoot)) {
      return resolve(expandedRoot);
    }
    const home = options.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
    return resolve(home, expandedRoot);
  }

  const home = options?.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
  return join(home, "worktrees");
}

/**
 * Where new worktrees of the checkout at `cwd` go.
 *
 * Inside the project by default, under its local-state directory, so deleting the
 * project deletes its worktrees and nothing a project produced outlives it. A configured
 * `worktreesRoot` keeps the older shared layout, `<root>/<project hash>/<slug>`, for
 * installs that rely on it.
 */
export async function getPaseoWorktreesRoot(
  cwd: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  if (!worktreesRoot) {
    try {
      const commonDir = await getGitCommonDir(cwd);
      return localWorktreesRoot(await resolveRepoRootFromGitCommonDir(commonDir));
    } catch {
      // Not a repository: fall through to the shared layout, which needs no checkout.
    }
  }
  const baseRoot = resolvePaseoWorktreesBaseRoot({ paseoHome, worktreesRoot });
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(baseRoot, projectHash);
}

/**
 * Ownership of a worktree inside a project's local-state directory, by path shape alone:
 * `<repo>/.agent-duel/worktrees/<id>[/...]`. Path shape has to be enough because git may
 * already have forgotten the worktree (a previous archive removed its admin dir), and the
 * checkout above it may be gone. When git does answer, the repository it names has to be
 * the one the path sits in: a battle contestant has the same shape under its checkout but
 * belongs to a bare host repository of its own, and is not Paseo's to delete.
 */
async function resolveProjectLocalOwnership(
  resolvedCwd: string,
  repoRoot: string | undefined,
): Promise<PaseoWorktreeOwnership | null> {
  const marker = `${sep}${LOCAL_STATE_DIRNAME}${sep}worktrees${sep}`;
  const index = resolvedCwd.lastIndexOf(marker);
  if (index <= 0) return null;
  const prefix = resolvedCwd.slice(0, index);
  const rest = resolvedCwd
    .slice(index + marker.length)
    .split(sep)
    .filter((part) => part.length > 0);
  if (rest.length === 0) return null;
  if (repoRoot !== undefined && (await normalizePathForOwnership(repoRoot)) !== prefix) {
    return null;
  }
  const worktreeRoot = localWorktreesRoot(prefix);
  return {
    allowed: true,
    repoRoot: repoRoot ?? prefix,
    worktreeRoot,
    worktreePath: join(worktreeRoot, rest[0]!),
  };
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  return join(projectWorktreesRoot, slug);
}

export function mapWorkspaceCwdToWorktree(input: {
  sourceWorktreePath: string;
  workspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(
    input.sourceWorktreePath,
    input.workspaceCwd,
  );
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${input.workspaceCwd}`);
  }

  return mapWorkspaceRelativeCwdToWorktree({
    relativeWorkspaceCwd,
    targetWorktreePath: input.targetWorktreePath,
  });
}

export function mapWorkspaceRelativeCwdToWorktree(input: {
  relativeWorkspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const mappedCwd = resolve(input.targetWorktreePath, input.relativeWorkspaceCwd);
  if (!isPathInsideRoot(input.targetWorktreePath, mappedCwd)) {
    throw new Error(`Workspace cwd escapes its target worktree: ${input.relativeWorkspaceCwd}`);
  }
  return mappedCwd;
}

// Keep the former realpathSync spelling on Windows: promises.realpath uses the
// native resolver and can return an 8.3 alias instead of the long path.
const resolveOwnershipPath = promisify(realpath);
const resolveNativeOwnershipPath = promisify(realpath.native);
const ownershipIdentityIo = pLimit(2);

async function normalizePathForOwnership(input: string): Promise<string> {
  try {
    return await ownershipIdentityIo(() => resolveOwnershipPath(input));
  } catch {
    return resolve(input);
  }
}

async function ownershipPathVariants(input: string): Promise<string[]> {
  const variants = new Set([input, await normalizePathForOwnership(input)]);
  try {
    variants.add(await ownershipIdentityIo(() => resolveNativeOwnershipPath(input)));
  } catch {
    // Missing descendants still match a lexical or established root spelling.
  }
  return [...variants];
}

// Keep lexical variants for missing paths: archive must still recognize a removed
// worktree below a symlinked worktrees root, whose full realpath no longer exists.
async function getOwnershipRelativePath(root: string, candidate: string): Promise<string | null> {
  const roots = await ownershipPathVariants(root);
  const candidates = await ownershipPathVariants(candidate);
  for (const rootPath of roots) {
    for (const candidatePath of candidates) {
      const relative = getRelativePathInsideRoot(rootPath, candidatePath);
      if (relative !== null) return relative;
    }
  }
  return null;
}

async function resolveRepoRootFromGitCommonDir(commonDir: string): Promise<string> {
  const normalizedCommonDir = await normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isPaseoOwnedWorktreeCwd(
  cwd: string,
  options?: PaseoWorktreeOwnershipOptions,
): Promise<PaseoWorktreeOwnership> {
  const resolvedCwd = await normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  if (options?.knownGitCommonDir) {
    repoRoot = await resolveRepoRootFromGitCommonDir(options.knownGitCommonDir);
  } else if (options?.knownGitCommonDir === undefined) {
    try {
      const gitCommonDir = await getGitCommonDir(cwd);
      repoRoot = await resolveRepoRootFromGitCommonDir(gitCommonDir);
    } catch {
      // ignore
    }
  }

  const projectLocal = await resolveProjectLocalOwnership(resolvedCwd, repoRoot);
  if (projectLocal) return projectLocal;

  // Worktrees placed at plugin-chosen paths are
  // proven by the marker createWorktree writes unconditionally: a
  // paseo/worktree.json in the worktree's git admin dir, with the path
  // still registered in the repo's `git worktree list`. The marker alone
  // is not proof — it lives in a git admin dir a user can copy into a
  // hand-made directory that git does not know about.
  if (options?.knownGitCommonDir !== null) {
    const metadataProof = await resolveMetadataOwnedWorktree(cwd, repoRoot);
    if (metadataProof) {
      return {
        allowed: true,
        ...(repoRoot !== undefined ? { repoRoot } : {}),
        worktreeRoot: metadataProof.worktreeRoot,
        worktreePath: metadataProof.worktreePath,
      };
    }
  }

  const worktreesBaseRoot = resolvePaseoWorktreesBaseRoot(options);
  const relativePath = await getOwnershipRelativePath(worktreesBaseRoot, resolvedCwd);

  // Ownership is defined by the path living under <worktrees-root>/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is Paseo-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (relativePath !== null) {
    const parts = relativePath.split(sep).filter((part) => part.length > 0);
    if (parts.length >= 2) {
      const worktreesRoot = join(worktreesBaseRoot, parts[0]);
      return {
        allowed: true,
        ...(repoRoot !== undefined ? { repoRoot } : {}),
        worktreeRoot: worktreesRoot,
        worktreePath: join(worktreesRoot, parts[1]),
      };
    }
  }

  return {
    allowed: false,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    worktreePath: resolvedCwd,
  };
}

async function resolveMetadataOwnedWorktree(
  cwd: string,
  repoRoot: string | undefined,
): Promise<{ worktreePath: string; worktreeRoot: string } | null> {
  try {
    const root = await findPaseoWorktreeRootForCwd(cwd);
    if (!root) return null;
    const candidate = await normalizePathForOwnership(root);
    if (repoRoot !== undefined && candidate === (await normalizePathForOwnership(repoRoot)))
      return null;
    const { stdout: listOutput } = await runGitCommand(["worktree", "list", "--porcelain"], {
      cwd: candidate,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    for (const entry of parseWorktreeList(listOutput)) {
      if ((await normalizePathForOwnership(entry.path)) === candidate) {
        return { worktreePath: candidate, worktreeRoot: dirname(candidate) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

type ParsedPaseoWorktreeInfo = Omit<PaseoWorktreeInfo, "createdAt">;

function parseWorktreeList(output: string): ParsedPaseoWorktreeInfo[] {
  const entries: ParsedPaseoWorktreeInfo[] = [];
  let current: ParsedPaseoWorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.trim().length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

async function resolveWorktreeCreatedAtIso(worktreePath: string): Promise<string> {
  try {
    const stats = await stat(worktreePath);
    const birthtimeMs = stats.birthtimeMs;
    const createdAtMs =
      Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export async function listPaseoWorktrees({
  cwd,
  paseoHome,
  worktreesRoot,
}: {
  cwd: string;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<PaseoWorktreeInfo[]> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });

  const mainCheckoutPath = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(cwd));
  const roots = await ownershipPathVariants(projectWorktreesRoot);
  const worktrees: PaseoWorktreeInfo[] = [];
  // Inspect foreign paths sequentially; a large worktree list must not consume the FS pool.
  for (const entry of parseWorktreeList(stdout)) {
    const path = await normalizePathForOwnership(entry.path);
    if (
      !roots.some((root) => getRelativePathInsideRoot(root, path) !== null) &&
      !(path !== mainCheckoutPath && (await hasPaseoWorktreeMetadata(path)))
    )
      continue;
    worktrees.push({ ...entry, path, createdAt: await resolveWorktreeCreatedAtIso(path) });
  }
  return worktrees;
}

export interface DeletePaseoWorktreeOptions {
  cwd: string | null;
  worktreePath?: string;
  teardownCwds?: string[];
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  // The caller has a workspace registry record backing worktreePath (the
  // record's cwd is this path). Registry membership is an ownership proof
  // in its own right: it covers worktrees whose git admin dir is already
  // gone, where the marker proof can no longer be verified. Only pass
  // this when the record was matched against the path by the caller.
  registryProven?: boolean;
}

// Project scoping for delete: a proof for some other repo's worktree must
// not make this repo's delete remove it. Only refuses on a positive
// mismatch — when git has forgotten either side, the ownership proof the
// caller already established stands.
async function assertWorktreeBelongsToRepo(cwd: string, worktreePath: string): Promise<void> {
  let callerRepoRoot: string;
  let targetRepoRoot: string;
  try {
    callerRepoRoot = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(cwd));
    targetRepoRoot = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(worktreePath));
  } catch {
    return;
  }
  if ((await getOwnershipRelativePath(callerRepoRoot, targetRepoRoot)) !== "") {
    throw new Error("Refusing to delete a non-Agent Duel worktree");
  }
}

export async function deletePaseoWorktree({
  cwd,
  worktreePath,
  teardownCwds,
  worktreeSlug,
  worktreesRoot,
  paseoHome,
  worktreesBaseRoot,
  registryProven,
}: DeletePaseoWorktreeOptions): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  // Resolve the worktrees-root. With a repo cwd we hash it the normal way; if
  // git has forgotten about the worktree we expect the caller to hand us the
  // path-derived worktreesRoot from the ownership check.
  let resolvedWorktreesRoot: string;
  if (worktreesRoot) {
    resolvedWorktreesRoot = worktreesRoot;
  } else if (cwd) {
    resolvedWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesBaseRoot);
  } else {
    throw new Error("cwd or worktreesRoot is required to delete an Agent Duel worktree");
  }

  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const ownership = await isPaseoOwnedWorktreeCwd(requestedPath, {
    paseoHome,
    worktreesRoot: worktreesBaseRoot,
  });
  // Deletion is gated on the ownership proof set (legacy shape, the
  // paseo/worktree.json marker verified against `git worktree list`, or a
  // caller-asserted registry record), not on living under the per-project
  // hashed root: plugin-placed worktrees live anywhere.
  let resolvedWorktree: string;
  if (registryProven) {
    resolvedWorktree = await normalizePathForOwnership(requestedPath);
  } else if (ownership.allowed && ownership.worktreePath) {
    resolvedWorktree = ownership.worktreePath;
  } else {
    throw new Error("Refusing to delete a non-Agent Duel worktree");
  }

  if (cwd) {
    await assertWorktreeBelongsToRepo(cwd, resolvedWorktree);
  }

  if (await pathExists(resolvedWorktree)) {
    for (const teardownCwd of teardownCwds ?? [resolvedWorktree]) {
      await runWorktreeTeardownCommands({
        worktreePath: resolvedWorktree,
        teardownCwd,
      });
    }
  }

  if (cwd) {
    try {
      await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
        cwd,
        timeout: 120_000,
      });
    } catch {
      // `git worktree remove` fails if the admin dir is already gone (e.g. a
      // prior archive attempt removed it before the working tree could be
      // fully cleaned up), or if the repo root has moved. Fall through to the
      // rm retry loop below so the operation stays idempotent.
    }
  }

  await removeDirectoryWithRetries(resolvedWorktree);

  if (cwd) {
    try {
      await runGitCommand(["worktree", "prune"], { cwd, timeout: 30_000 });
    } catch {
      // not critical; git will prune lazily
    }
  }
}

export async function rollbackCreatedPaseoWorktree(
  options: DeletePaseoWorktreeOptions,
  cause: unknown,
): Promise<never> {
  let cleanupError: unknown;
  try {
    await deletePaseoWorktree(options);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const failure = new Error(
      `${cause instanceof Error ? cause.message : "Worktree workflow failed"}; rollback also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause },
    );
    Object.assign(failure, { cleanupError });
    throw failure;
  }
  throw cause;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeDirectoryWithRetries(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const delaysMs = [0, 100, 300, 700, 1500];
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
    try {
      await rm(path, { recursive: true, force: true });
      if (!(await pathExists(path))) {
        return;
      }
      lastError = new Error(`Directory still present after rm: ${path}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (await pathExists(path)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to remove worktree directory: ${path}`);
  }
}

async function listLocalBranchNames(cwd: string): Promise<Set<string>> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd },
  );
  return new Set(
    stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

// The one local branch a source plan can create while resolving: a
// checkout-branch plan fetches refs/heads/<source.branchName>, and a
// change-request/PR plan fetches refs/heads/<localBranchName> (which is
// the plan's branchName). branch-off creates no local branch. Only this
// ref may be rolled back when creation fails — never any other
// branch that appeared in the meantime; other creators own those.
function planCreatedLocalBranch(
  source: WorktreeSource,
  sourcePlan: WorktreeSourcePlan,
): string | null {
  switch (source.kind) {
    case "checkout-branch":
      return source.branchName;
    case "checkout-change-request":
    case "checkout-github-pr":
      return sourcePlan.branchName;
    default:
      return null;
  }
}

async function readLocalBranchTip(cwd: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(
      ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`],
      { cwd },
    );
    const tip = stdout.trim();
    return tip.length > 0 ? tip : null;
  } catch {
    return null;
  }
}

/** Resolve the default placement once, before presenting it to creation hooks. */
export async function resolveDefaultWorktreePath(
  options: Pick<CreateWorktreeOptions, "cwd" | "paseoHome" | "worktreesRoot" | "worktreeSlug">,
): Promise<string> {
  const original = join(
    await getPaseoWorktreesRoot(options.cwd, options.paseoHome, options.worktreesRoot),
    options.worktreeSlug,
  );
  let candidate = original;
  let suffix = 1;
  while (await pathExists(candidate)) candidate = `${original}-${suffix++}`;
  return candidate;
}

interface AddWorktreeOptions extends Pick<CreateWorktreeOptions, "onBeforeAdd" | "onAddFailed"> {
  cwd: string;
  worktreePath: string;
  addArguments: string[];
}

/** `git worktree add`, bracketed by the caller's ownership hooks. */
async function addWorktree({
  cwd,
  worktreePath,
  addArguments,
  onBeforeAdd,
  onAddFailed,
}: AddWorktreeOptions): Promise<void> {
  await onBeforeAdd?.(await normalizePathForOwnership(worktreePath));
  try {
    await runGitCommand(["worktree", "add", worktreePath, ...addArguments], {
      cwd,
      timeout: 120_000,
    });
  } catch (error) {
    try {
      await onAddFailed?.(await normalizePathForOwnership(worktreePath));
    } catch {
      // Keep the original Git error; a stale marker is checked again on startup.
    }
    throw error;
  }
}

/**
 * Create a git worktree with proper naming conventions
 */
export const createWorktree = async ({
  cwd,
  source,
  worktreeSlug,
  paseoHome,
  worktreesRoot,
  worktreePath: explicitWorktreePath,
  seedIgnoredContent,
  onBeforeAdd,
  onAddFailed,
  logger,
}: CreateWorktreeOptions): Promise<CreatedWorktree> => {
  const branchesBefore =
    source.kind === "checkout-branch" ||
    source.kind === "checkout-change-request" ||
    source.kind === "checkout-github-pr"
      ? await listLocalBranchNames(cwd)
      : new Set<string>();
  const sourcePlan = await resolveWorktreeSourcePlan({ cwd, source, desiredSlug: worktreeSlug });
  const fetchedBranch = planCreatedLocalBranch(source, sourcePlan);
  const fetchedTip =
    fetchedBranch && !branchesBefore.has(fetchedBranch)
      ? await readLocalBranchTip(cwd, fetchedBranch)
      : null;
  try {
    let worktreePath =
      explicitWorktreePath ??
      (await resolveDefaultWorktreePath({ cwd, paseoHome, worktreesRoot, worktreeSlug }));
    await mkdir(dirname(worktreePath), { recursive: true });
    await prepareLocalStateRoot(cwd, dirname(worktreePath), logger);

    // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
    await addWorktree({
      cwd,
      worktreePath,
      addArguments: sourcePlan.addArguments,
      onBeforeAdd,
      onAddFailed,
    });
    worktreePath = await normalizePathForOwnership(worktreePath);

    try {
      if (sourcePlan.pushRemote) {
        await configureWorktreePushRemote({
          cwd,
          branchName: sourcePlan.branchName,
          remote: sourcePlan.pushRemote,
        });
      }
      if (sourcePlan.trackingRemote) {
        await configureWorktreeTrackingRemote({
          cwd,
          branchName: sourcePlan.branchName,
          remote: sourcePlan.trackingRemote,
        });
      }

      await writePaseoWorktreeMetadata(worktreePath, {
        baseRefName: sourcePlan.metadataBaseRefName,
        ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
        ...(sourcePlan.changeRequestLookupTarget
          ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
          : {}),
      });

      await seedPaseoConfigFile({ sourceCwd: cwd, targetCwd: worktreePath });

      if (seedIgnoredContent) {
        await seedIgnoredContent({ sourceCwd: cwd, worktreePath });
      }
    } catch (error) {
      return await rollbackCreatedPaseoWorktree(
        {
          cwd,
          worktreePath,
          teardownCwds: [],
          paseoHome,
          worktreesBaseRoot: worktreesRoot,
          // This call just added the worktree at this path, which proves ownership even
          // before its marker is written.
          registryProven: true,
        },
        error,
      );
    }

    return {
      branchName: sourcePlan.branchName,
      worktreePath,
      comparisonBaseRef: sourcePlan.metadataBaseRef ?? sourcePlan.metadataBaseRefName,
    };
  } catch (error) {
    if (
      fetchedBranch &&
      fetchedTip &&
      (await readLocalBranchTip(cwd, fetchedBranch)) === fetchedTip
    ) {
      await runGitCommand(["branch", "-D", fetchedBranch], { cwd }).catch(() => {});
    }
    throw error;
  }
};

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
}

interface WorktreeSourcePlan {
  branchName: string;
  // Display name and exact ref are two different facts. The name cannot round-trip to a
  // commit — "main" resolves local-first even when the worktree was cut from a fork's
  // upstream — so comparisons and actions read the ref and the UI reads the name.
  metadataBaseRefName: string;
  metadataBaseRef?: string;
  changeRequestLookupTarget?: PaseoWorktreeChangeRequestHint;
  addArguments: string[];
  pushRemote?: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
  trackingRemote?: {
    name: string;
    headRef: string;
  };
}

async function resolveRestoredWorktreeSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore" }>,
): Promise<WorktreeSourcePlan> {
  await validateGitBranchName(cwd, source.branchName);
  await ensureLocalBranch(cwd, source.branchName);
  if (await isBranchCheckedOut(cwd, source.branchName)) {
    throw new BranchAlreadyCheckedOutError(source.branchName);
  }
  let exactBase: string | undefined;
  if (source.baseRef && isQualifiedRef(source.baseRef)) {
    try {
      exactBase = await resolveStartPointRef(cwd, source.baseRef);
    } catch {
      // Restore the saved branch even when its comparison ref no longer exists.
    }
  }
  return {
    branchName: source.branchName,
    metadataBaseRefName: normalizeRequiredBaseBranch(source.baseRef ?? source.branchName),
    ...(exactBase ? { metadataBaseRef: exactBase } : {}),
    changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
      headRef: source.branchName,
      localBranchName: source.branchName,
    }),
    addArguments: [source.branchName],
  };
}

async function resolveRestoredWorktreeFromBasePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore-from-base" }>,
): Promise<WorktreeSourcePlan> {
  await validateGitBranchName(cwd, source.branchName);
  const baseRef = await resolveStartPointRef(cwd, source.baseRef);
  const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
  return {
    branchName,
    metadataBaseRefName: normalizeRequiredBaseBranch(source.baseRef),
    metadataBaseRef: baseRef,
    addArguments: ["-b", branchName, "--no-track", baseRef],
  };
}

async function resolveBranchOffWorktreeSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "branch-off" }>,
  desiredSlug: string,
): Promise<WorktreeSourcePlan> {
  const branchName = source.branchName;
  await validateGitBranchName(cwd, branchName);
  const normalizedBaseBranch = normalizeRequiredBaseBranch(source.baseBranch);
  const resolvedBaseBranch = await resolveStartPointRef(cwd, source.baseBranch);
  const branchExists = await localBranchExists(cwd, branchName);
  const base = branchExists ? branchName : resolvedBaseBranch;
  await refreshRemoteTrackingBaseRef(cwd, base);
  const candidateBranch = branchExists ? desiredSlug : branchName;
  const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);

  return {
    branchName: newBranchName,
    metadataBaseRefName: normalizedBaseBranch,
    metadataBaseRef: resolvedBaseBranch,
    changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
      headRef: newBranchName,
      localBranchName: newBranchName,
    }),
    addArguments: ["-b", newBranchName, "--no-track", base],
  };
}

async function resolveDetachedWorktreeSourcePlan(
  cwd: string,
  baseRef: string,
): Promise<WorktreeSourcePlan> {
  const resolvedRef = await resolveStartPointRef(cwd, baseRef);
  await refreshRemoteTrackingBaseRef(cwd, resolvedRef);
  return {
    // No branch: the empty name is what every consumer already treats as "none".
    branchName: "",
    metadataBaseRefName: normalizeRequiredBaseBranch(baseRef),
    metadataBaseRef: resolvedRef,
    addArguments: ["--detach", resolvedRef],
  };
}

async function resolveWorktreeSourcePlan({
  cwd,
  source,
  desiredSlug,
}: ResolveWorktreeSourcePlanOptions): Promise<WorktreeSourcePlan> {
  switch (source.kind) {
    case "branch-off":
      return resolveBranchOffWorktreeSourcePlan(cwd, source, desiredSlug);
    case "detached":
      return resolveDetachedWorktreeSourcePlan(cwd, source.baseRef);
    case "restore":
      return resolveRestoredWorktreeSourcePlan(cwd, source);
    case "restore-from-base":
      return resolveRestoredWorktreeFromBasePlan(cwd, source);
    case "checkout-branch": {
      await validateGitBranchName(cwd, source.branchName);
      await ensureLocalBranch(cwd, source.branchName);
      const baseRef = await resolveCheckoutBranchBaseRef(cwd, source.branchName);
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
        return {
          branchName,
          metadataBaseRefName: baseRef,
          changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
            headRef: branchName,
            localBranchName: branchName,
          }),
          addArguments: ["-b", branchName, "--no-track", source.branchName],
        };
      }

      return {
        branchName: source.branchName,
        metadataBaseRefName: baseRef,
        changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
          headRef: source.branchName,
          localBranchName: source.branchName,
        }),
        addArguments: [source.branchName],
      };
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      await validateGitBranchName(cwd, localBranchCandidate);
      const localBranchName = await resolveUniqueLocalBranchName(cwd, localBranchCandidate);
      const normalizedBaseRefName = normalizeRequiredBaseBranch(source.baseRefName);
      const changeRequestNumber =
        source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
      await fetchWorktreeCheckoutRefs({
        cwd,
        localBranchName,
        checkoutRefs: source.checkoutRefs ?? [
          { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
        ],
      });
      const shouldTrackOriginHead = source.trackOriginHead === true;
      const trackingRemote = shouldTrackOriginHead
        ? await tryFetchWorktreeTrackingRemote({
            cwd,
            remoteName: "origin",
            headRef: source.headRef,
          })
        : undefined;
      const remotePlan: Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote"> = {};
      if (source.pushRemoteUrl) {
        const remoteName = `paseo-pr-${changeRequestNumber}`;
        remotePlan.pushRemote = {
          name: remoteName,
          url: source.pushRemoteUrl,
          headRef: source.headRef,
          track: true,
        };
      } else if (shouldTrackOriginHead && localBranchName !== source.headRef) {
        const originUrl = await getWorktreeRemotePushUrl(cwd, "origin");
        if (originUrl) {
          remotePlan.pushRemote = {
            name: `paseo-pr-${changeRequestNumber}`,
            url: originUrl,
            headRef: source.headRef,
            track: false,
          };
        }
      }
      if (trackingRemote) {
        remotePlan.trackingRemote = trackingRemote;
      }

      return {
        branchName: localBranchName,
        metadataBaseRefName: normalizedBaseRefName,
        changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
          headRef: source.headRef,
          ...(source.headRepositoryOwner
            ? { headRepositoryOwner: source.headRepositoryOwner }
            : {}),
          changeRequestNumber,
          localBranchName,
        }),
        addArguments: [localBranchName],
        ...remotePlan,
      };
    }
  }
}

async function configureWorktreePushRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
}): Promise<void> {
  await runGitCommand(["config", `remote.${options.remote.name}.url`, options.remote.url], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `remote.${options.remote.name}.push`, `HEAD:refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
  await runGitCommand(["config", `branch.${options.branchName}.pushRemote`, options.remote.name], {
    cwd: options.cwd,
  });
  if (!options.remote.track) {
    return;
  }
  await runGitCommand(
    [
      "config",
      `remote.${options.remote.name}.fetch`,
      `+refs/heads/${options.remote.headRef}:refs/remotes/${options.remote.name}/${options.remote.headRef}`,
    ],
    { cwd: options.cwd },
  );
  const trackingRemote = await tryFetchWorktreeTrackingRemote({
    cwd: options.cwd,
    remoteName: options.remote.name,
    headRef: options.remote.headRef,
  });
  if (trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd: options.cwd,
      branchName: options.branchName,
      remote: trackingRemote,
    });
  }
}

async function fetchWorktreeCheckoutRefs(options: {
  cwd: string;
  localBranchName: string;
  checkoutRefs: WorktreeCheckoutRef[];
}): Promise<void> {
  let lastResult:
    | Awaited<ReturnType<typeof runGitCommand>>
    | { stderr: string; stdout: string; exitCode: number | null }
    | null = null;
  for (const checkoutRef of options.checkoutRefs) {
    lastResult = await runGitCommand(
      [
        "fetch",
        checkoutRef.remoteName ?? "origin",
        `+${checkoutRef.remoteRef}:refs/heads/${options.localBranchName}`,
        "--force",
      ],
      {
        cwd: options.cwd,
        timeout: 120_000,
        acceptExitCodes: [0, 1, 128],
      },
    );
    if (lastResult.exitCode === 0) {
      return;
    }
  }
  const attemptedRefs = options.checkoutRefs
    .map((checkoutRef) => `${checkoutRef.remoteName ?? "origin"} ${checkoutRef.remoteRef}`)
    .join(", ");
  throw new Error(
    `Unable to fetch change request refs for worktree branch ${options.localBranchName}: ${attemptedRefs}${lastResult?.stderr ? `\n${lastResult.stderr}` : ""}`,
  );
}

async function tryFetchWorktreeTrackingRemote(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<{ name: string; headRef: string } | undefined> {
  const result = await runGitCommand(
    [
      "fetch",
      options.remoteName,
      `+refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`,
    ],
    {
      cwd: options.cwd,
      timeout: 120_000,
      acceptExitCodes: [0, 1, 128],
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  await ensureRemoteFetchesBranch(options);
  return { name: options.remoteName, headRef: options.headRef };
}

async function ensureRemoteFetchesBranch(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<void> {
  const configKey = `remote.${options.remoteName}.fetch`;
  const exactRefspec = `refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`;
  const wildcardRefspec = `refs/heads/*:refs/remotes/${options.remoteName}/*`;
  const { stdout } = await runGitCommand(["config", "--get-all", configKey], {
    cwd: options.cwd,
    acceptExitCodes: [0, 1],
  });
  const alreadyTracked = stdout
    .split("\n")
    .map((refspec) => refspec.trim().replace(/^\+/, ""))
    .some((refspec) => refspec === exactRefspec || refspec === wildcardRefspec);
  if (alreadyTracked) {
    return;
  }
  await runGitCommand(["config", "--add", configKey, `+${exactRefspec}`], { cwd: options.cwd });
}

async function getWorktreeRemotePushUrl(
  cwd: string,
  remoteName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "--push", remoteName], {
      cwd,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

async function configureWorktreeTrackingRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    headRef: string;
  };
}): Promise<void> {
  await runGitCommand(
    [
      "branch",
      "--set-upstream-to",
      `${options.remote.name}/${options.remote.headRef}`,
      options.branchName,
    ],
    { cwd: options.cwd },
  );
}

async function validateGitBranchName(cwd: string, branchName: string): Promise<void> {
  const result = await runGitCommand(["check-ref-format", "--branch", branchName], {
    cwd,
    timeout: 30_000,
    acceptExitCodes: [0, 1, 128],
  });
  if (result.exitCode !== 0) {
    throw new InvalidGitBranchNameError(branchName);
  }
}

function normalizeRequiredBaseBranch(baseBranch: string): string {
  const normalizedBaseBranch = normalizeBaseRefName(baseBranch);
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD");
  }
  return normalizedBaseBranch;
}

// The checked-out branch itself isn't a base to diff against — resolve the
// repository's default branch so the diff panel has a real comparison target.
// If the default branch can't be determined (no origin/HEAD, no local
// main/master — e.g. a local-only repo based on "develop"), fall back to
// whichever branch is currently checked out in the main repo, since that's
// almost always the branch this one was intended to be compared against.
async function resolveCheckoutBranchBaseRef(cwd: string, branchName: string): Promise<string> {
  const defaultBranch = await resolveRepositoryDefaultBranch(cwd);
  if (defaultBranch) {
    return defaultBranch;
  }
  const currentBranch = await getCurrentBranch(cwd);
  return currentBranch && currentBranch !== branchName ? currentBranch : branchName;
}

/**
 * The exact ref a base names, or an error. Cutting a worktree and cutting a branch in place
 * both start from here, so "start from main" means the same commit either way and a base that
 * has since been deleted fails loudly rather than falling back to somewhere else.
 */
export async function resolveStartPointRef(
  cwd: string,
  requestedBaseBranch: string,
): Promise<string> {
  const requested = requestedBaseBranch.trim();
  const normalized = normalizeRequiredBaseBranch(requested);
  let exactRef: string | null = null;
  if (isQualifiedRef(requested)) {
    exactRef = requested;
  } else if (requested.startsWith("origin/")) {
    exactRef = `refs/remotes/${requested}`;
  }

  if (exactRef) {
    try {
      await runGitCommand(["rev-parse", "--verify", exactRef], { cwd });
      return exactRef;
    } catch {
      throw new Error(`Base branch not found: ${exactRef}`);
    }
  }

  const candidates = [`refs/heads/${requested}`, `refs/remotes/origin/${requested}`, requested];
  for (const candidate of candidates) {
    try {
      await runGitCommand(["rev-parse", "--verify", candidate], { cwd });
      return candidate;
    } catch {
      // Try the next unambiguous local, remote, or legacy ref candidate.
    }
  }
  throw new Error(`Base branch not found: ${normalized}`);
}

// Clients give up on a create request after 60s. A remote that accepts the connection and never
// answers (a VPN-only host while off the VPN) must fall back to the cached ref well before that.
const REMOTE_BASE_REFRESH_TIMEOUT_MS = 15_000;

// A remote-tracking base is only as fresh as the last fetch, and the background fetch only runs
// while a workspace of the repository is observed. Refresh the one base branch so the new branch
// starts at the remote tip; when the fetch fails (offline, auth) the cached ref is still usable.
async function refreshRemoteTrackingBaseRef(cwd: string, baseRef: string): Promise<void> {
  if (!baseRef.startsWith("refs/remotes/")) {
    return;
  }
  try {
    // Remote names may contain slashes, so the owning remote is looked up rather than parsed.
    const { stdout } = await runGitCommand(["remote"], { cwd });
    const remoteName = stdout
      .split("\n")
      .map((name) => name.trim())
      .find((name) => name.length > 0 && baseRef.startsWith(`refs/remotes/${name}/`));
    if (!remoteName) {
      return;
    }
    const remoteBranch = baseRef.slice(`refs/remotes/${remoteName}/`.length);
    // No refspec is added to remote.<name>.fetch: one left behind breaks later fetches once the
    // branch is deleted on the remote.
    await runGitCommand(["fetch", remoteName, `+refs/heads/${remoteBranch}:${baseRef}`], {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
      timeout: REMOTE_BASE_REFRESH_TIMEOUT_MS,
      acceptExitCodes: [0, 1, 128],
    });
  } catch {
    // The fetch timed out; branch from the cached ref.
  }
}

async function ensureLocalBranch(cwd: string, branchName: string): Promise<void> {
  if (await localBranchExists(cwd, branchName)) {
    return;
  }
  try {
    await runGitCommand(["fetch", "origin", `${branchName}:${branchName}`], {
      cwd,
      timeout: 120_000,
    });
  } catch {
    throw new UnknownBranchError({ branchName, cwd });
  }
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueLocalBranchName(cwd: string, candidateBranch: string): Promise<string> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"],
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
  );
  const existingBranches = new Set(stdout.trim().split("\n").filter(Boolean));
  const candidateSegments = candidateBranch.split("/");
  const segments = [...candidateSegments];
  let suffix = 1;
  while (true) {
    const branchName = segments.join("/");
    const parentConflict = segments.findIndex((_, index) =>
      existingBranches.has(segments.slice(0, index + 1).join("/")),
    );
    const childConflict = [...existingBranches].some((branch) =>
      branch.startsWith(`${branchName}/`),
    );
    if (parentConflict === -1 && !childConflict) {
      return branchName;
    }
    // Git refs form a namespace: a branch cannot also be another branch's
    // parent directory. Rename the conflicting segment, preserving the rest.
    const conflictIndex = parentConflict === -1 ? segments.length - 1 : parentConflict;
    segments[conflictIndex] = `${candidateSegments[conflictIndex]}-${suffix++}`;
  }
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return parseWorktreeList(stdout).some((entry) => entry.branchName === branchName);
}
