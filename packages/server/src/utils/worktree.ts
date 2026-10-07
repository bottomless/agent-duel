import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { readFile, rm, stat } from "fs/promises";
import { join, basename, dirname, isAbsolute, resolve, sep } from "path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { readPaseoConfigJson, resolvePaseoConfigPath } from "./paseo-config-file.js";
export {
  PaseoConfigRawSchema,
  PaseoLifecycleCommandRawSchema,
  PaseoScriptEntryRawSchema,
  PaseoWorktreeConfigRawSchema,
  PaseoConfigSchema,
  type PaseoConfig,
  type PaseoConfigRaw,
} from "@getpaseo/protocol/paseo-config-schema";
import { PaseoConfigSchema, type PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import {
  createPaseoWorktreeChangeRequestHint,
  normalizeBaseRefName,
  type PaseoWorktreeChangeRequestHint,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { ignoreForFileProviderSync } from "./file-provider-ignore.js";
import type { Logger } from "pino";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { writeFileAtomic } from "../server/atomic-file.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import { expandTilde, getRealpathAwareRelativePath, isPathInsideRoot } from "./path.js";

export { slugify, validateBranchSlug } from "@getpaseo/protocol/branch-slug";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
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
  | {
      kind: "checkout-change-request";
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
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
  runSetup: boolean;
  paseoHome?: string;
  worktreesRoot?: string;
  seedIgnoredContent?: WorktreeSeedFn;
  onBeforeAdd?: (worktreePath: string) => Promise<void>;
  onAddFailed?: (worktreePath: string) => Promise<void>;
  logger?: Pick<Logger, "warn">;
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

export type ReadPaseoConfigResult =
  | { ok: true; config: PaseoConfig | null }
  | { ok: false; configPath: string; error: unknown };

export function readPaseoConfig(repoRoot: string): ReadPaseoConfigResult {
  try {
    const json = readPaseoConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null };
    }
    return { ok: true, config: PaseoConfigSchema.parse(json) };
  } catch (error) {
    return { ok: false, configPath: resolvePaseoConfigPath(repoRoot), error };
  }
}

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
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
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
        return normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return normalizePathForOwnership(worktreePath);
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
  cleanupOnFailure: boolean;
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

  let worktreePort = readPaseoWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = readPaseoWorktreeMetadata(options.worktreePath);
    if (metadata) {
      writePaseoWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
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

export async function copySourcePaseoConfigFile(options: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceConfigPath = join(options.sourceCwd, "paseo.json");
  const targetConfigPath = join(options.targetCwd, "paseo.json");
  let sourceConfig: Buffer;
  try {
    sourceConfig = await readFile(sourceConfigPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await writeFileAtomic(targetConfigPath, sourceConfig);
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
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(normalizePathForOwnership(cwd));
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
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
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
      return localWorktreesRoot(
        resolveRepoRootFromGitCommonDir(normalizePathForOwnership(commonDir)),
      );
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
function resolveProjectLocalOwnership(
  resolvedCwd: string,
  repoRoot: string | undefined,
): PaseoWorktreeOwnership | null {
  const marker = `${sep}${LOCAL_STATE_DIRNAME}${sep}worktrees${sep}`;
  const index = resolvedCwd.lastIndexOf(marker);
  if (index <= 0) return null;
  const prefix = resolvedCwd.slice(0, index);
  const rest = resolvedCwd
    .slice(index + marker.length)
    .split(sep)
    .filter((part) => part.length > 0);
  if (rest.length === 0) return null;
  if (repoRoot !== undefined && normalizePathForOwnership(repoRoot) !== prefix) return null;
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

function normalizePathForOwnership(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function resolveRepoRootFromGitCommonDir(commonDir: string): string {
  const normalizedCommonDir = normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isPaseoOwnedWorktreeCwd(
  cwd: string,
  options?: PaseoWorktreeOwnershipOptions,
): Promise<PaseoWorktreeOwnership> {
  const resolvedCwd = normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  if (options?.knownGitCommonDir) {
    repoRoot = resolveRepoRootFromGitCommonDir(options.knownGitCommonDir);
  } else if (options?.knownGitCommonDir === undefined) {
    try {
      const gitCommonDir = await getGitCommonDir(cwd);
      repoRoot = resolveRepoRootFromGitCommonDir(gitCommonDir);
    } catch {
      // ignore
    }
  }

  const projectLocal = resolveProjectLocalOwnership(resolvedCwd, repoRoot);
  if (projectLocal) return projectLocal;

  const worktreesBaseRoot = resolvePaseoWorktreesBaseRoot(options);
  const relativePath = getRealpathAwareRelativePath(worktreesBaseRoot, resolvedCwd);

  // Ownership is defined by the path living under <worktrees-root>/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is Paseo-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (relativePath === null) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const parts = relativePath.split(sep).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const worktreesRoot = join(worktreesBaseRoot, parts[0]);
  return {
    allowed: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    worktreeRoot: worktreesRoot,
    worktreePath: join(worktreesRoot, parts[1]),
  };
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

function resolveWorktreeCreatedAtIso(worktreePath: string): string {
  try {
    const stats = statSync(worktreePath);
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

  return parseWorktreeList(stdout)
    .map((entry) => Object.assign({}, entry, { path: normalizePathForOwnership(entry.path) }))
    .filter((entry) => getRealpathAwareRelativePath(projectWorktreesRoot, entry.path) !== null)
    .map((entry) =>
      Object.assign({}, entry, { createdAt: resolveWorktreeCreatedAtIso(entry.path) }),
    );
}

export interface DeletePaseoWorktreeOptions {
  cwd: string | null;
  worktreePath?: string;
  teardownCwds?: string[];
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
}

export async function deletePaseoWorktree({
  cwd,
  worktreePath,
  teardownCwds,
  worktreeSlug,
  worktreesRoot,
  paseoHome,
  worktreesBaseRoot,
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
    throw new Error("cwd or worktreesRoot is required to delete a Paseo worktree");
  }

  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const resolvedRequested = normalizePathForOwnership(requestedPath);
  const ownership = await isPaseoOwnedWorktreeCwd(requestedPath, {
    paseoHome,
    worktreesRoot: worktreesBaseRoot,
  });
  const resolvedWorktree =
    ownership.allowed && ownership.worktreePath ? ownership.worktreePath : resolvedRequested;

  const relativeWorktreePath = getRealpathAwareRelativePath(
    resolvedWorktreesRoot,
    resolvedWorktree,
  );
  if (relativeWorktreePath === null || relativeWorktreePath === "") {
    throw new Error("Refusing to delete non-Paseo worktree");
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

/**
 * Create a git worktree with proper naming conventions
 */
export const createWorktree = async ({
  cwd,
  source,
  worktreeSlug,
  runSetup,
  paseoHome,
  worktreesRoot,
  seedIgnoredContent,
  onBeforeAdd,
  onAddFailed,
  logger,
}: CreateWorktreeOptions): Promise<WorktreeConfig> => {
  const sourcePlan = await resolveWorktreeSourcePlan({ cwd, source, desiredSlug: worktreeSlug });
  const root = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  let worktreePath = join(root, worktreeSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });
  // A root inside the checkout has to be excluded before anything lands in it, or the very
  // first `git status` shows the new worktree as an untracked directory.
  if (getRealpathAwareRelativePath(cwd, root) !== null) {
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

  // Also handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (existsSync(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  await onBeforeAdd?.(normalizePathForOwnership(finalWorktreePath));

  // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
  try {
    await runGitCommand(["worktree", "add", finalWorktreePath, ...sourcePlan.addArguments], {
      cwd,
      timeout: 120_000,
    });
  } catch (error) {
    try {
      await onAddFailed?.(normalizePathForOwnership(finalWorktreePath));
    } catch {
      // Keep the original Git error; a stale marker is checked again on startup.
    }
    throw error;
  }
  worktreePath = normalizePathForOwnership(finalWorktreePath);

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

    writePaseoWorktreeMetadata(worktreePath, {
      baseRefName: sourcePlan.metadataBaseRefName,
      ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
      ...(sourcePlan.changeRequestLookupTarget
        ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
        : {}),
    });

    await copySourcePaseoConfigFile({ sourceCwd: cwd, targetCwd: worktreePath });

    if (seedIgnoredContent) {
      await seedIgnoredContent({ sourceCwd: cwd, worktreePath });
    }

    if (runSetup) {
      await runWorktreeSetupCommands({
        worktreePath,
        branchName: sourcePlan.branchName,
        cleanupOnFailure: true,
      });
    }
  } catch (error) {
    return rollbackCreatedPaseoWorktree(
      {
        cwd,
        worktreePath,
        teardownCwds: [],
        paseoHome,
        worktreesBaseRoot: worktreesRoot,
      },
      error,
    );
  }

  return {
    branchName: sourcePlan.branchName,
    worktreePath,
  };
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

async function planBranchOffWorktreeSource(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "branch-off" }>,
  desiredSlug: string,
): Promise<WorktreeSourcePlan> {
  const branchName = source.branchName;
  validateWorktreeBranchName(branchName);
  const normalizedBaseBranch = normalizeRequiredBaseBranch(source.baseBranch);
  const resolvedBaseBranch = await resolveStartPointRef(cwd, source.baseBranch);
  const branchExists = await localBranchExists(cwd, branchName);
  const base = branchExists ? branchName : resolvedBaseBranch;
  const candidateBranch = branchExists ? desiredSlug : branchName;
  const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);

  return {
    branchName: newBranchName,
    metadataBaseRefName: normalizedBaseBranch,
    metadataBaseRef: resolvedBaseBranch,
    addArguments: ["-b", newBranchName, "--no-track", base],
  };
}

async function planDetachedWorktreeSource(
  cwd: string,
  baseRef: string,
): Promise<WorktreeSourcePlan> {
  const resolvedRef = await resolveStartPointRef(cwd, baseRef);
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
      return planBranchOffWorktreeSource(cwd, source, desiredSlug);
    case "detached":
      return planDetachedWorktreeSource(cwd, source.baseRef);
    case "checkout-branch": {
      await validateExistingWorktreeBranchName(cwd, source.branchName);
      if (!(await localBranchExists(cwd, source.branchName))) {
        try {
          await runGitCommand(["fetch", "origin", `${source.branchName}:${source.branchName}`], {
            cwd,
            timeout: 120_000,
          });
        } catch {
          throw new UnknownBranchError({ branchName: source.branchName, cwd });
        }
      }
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
        return {
          branchName,
          metadataBaseRefName: source.branchName,
          addArguments: ["-b", branchName, "--no-track", source.branchName],
        };
      }

      return {
        branchName: source.branchName,
        metadataBaseRefName: source.branchName,
        addArguments: [source.branchName],
      };
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      await validateExistingWorktreeBranchName(cwd, localBranchCandidate);
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

function validateWorktreeBranchName(branchName: string): void {
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }
}

async function validateExistingWorktreeBranchName(cwd: string, branchName: string): Promise<void> {
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
  if (requested.startsWith("refs/")) {
    exactRef = requested;
  } else if (requested.startsWith("origin/")) {
    exactRef = `refs/remotes/${requested}`;
  }

  if (exactRef) {
    try {
      await runGitCommand(["rev-parse", "--verify", exactRef], { cwd });
      return exactRef;
    } catch {
      throw new Error(`Base branch not found: ${normalized}`);
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
  let newBranchName = candidateBranch;
  let suffix = 1;
  while (await localBranchExists(cwd, newBranchName)) {
    newBranchName = `${candidateBranch}-${suffix}`;
    suffix++;
  }
  return newBranchName;
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return parseWorktreeList(stdout).some((entry) => entry.branchName === branchName);
}
