import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGitCommand } from "../../utils/run-git-command.js";

const SNAPSHOT_REF_ROOT = "refs/agent-duel/workspace-snapshots";
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/;
const SNAPSHOT_GIT_TIMEOUT = 120_000;

export type CodeSnapshotErrorCode =
  | "invalid-input"
  | "not-a-repository"
  | "unsupported-state"
  | "occupied-path"
  | "unstable-source"
  | "invalid-snapshot";

export class CodeSnapshotError extends Error {
  readonly code: CodeSnapshotErrorCode;

  constructor(code: CodeSnapshotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodeSnapshotError";
    this.code = code;
  }
}

export interface CodeSnapshotInput {
  worktreeRoot: string;
  sourceRepoRoot: string;
  snapshotId: string;
}

export interface CodeSnapshot {
  snapshotId: string;
  worktreeRoot: string;
  sourceRepoRoot: string;
  head: string;
  indexCommit: string;
  workingCommit: string;
  branch: string | null;
}

export interface RestoreCodeSnapshotInput {
  worktreeRoot: string;
  sourceRepoRoot: string;
  snapshot: CodeSnapshot;
}

interface GitCheckoutState {
  head: string;
  indexTree: string;
  workingTree: string;
  branch: string | null;
}

interface SnapshotRefs {
  head: string;
  index: string;
  working: string;
}

interface TemporaryIndex {
  directory: string;
  file: string;
}

function snapshotRef(snapshotId: string, name: keyof SnapshotRefs): string {
  return `${SNAPSHOT_REF_ROOT}/${snapshotId}/${name}`;
}

function validateSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new CodeSnapshotError(
      "invalid-input",
      `Invalid workspace snapshot id: ${snapshotId}. Use letters, numbers, dots, underscores, and hyphens.`,
    );
  }
}

function validateDirectory(value: string, label: string): string {
  if (!value || !path.isAbsolute(value)) {
    throw new CodeSnapshotError("invalid-input", `${label} must be an absolute path`);
  }
  try {
    return path.resolve(value);
  } catch (error) {
    throw new CodeSnapshotError("invalid-input", `Invalid ${label}: ${value}`, { cause: error });
  }
}

function cleanGitOutput(output: string): string {
  return output.trim();
}

async function git(
  args: string[],
  cwd: string,
  options?: { envOverlay?: Record<string, string>; acceptExitCodes?: number[] },
): Promise<string> {
  const result = await runGitCommand(args, {
    cwd,
    timeout: SNAPSHOT_GIT_TIMEOUT,
    envOverlay: options?.envOverlay,
    acceptExitCodes: options?.acceptExitCodes,
  });
  return cleanGitOutput(result.stdout);
}

async function resolveCommonGitDir(cwd: string, label: string): Promise<string> {
  try {
    const commonDir = await git(["rev-parse", "--git-common-dir"], cwd);
    return realpathSync(path.resolve(cwd, commonDir));
  } catch (error) {
    throw new CodeSnapshotError("not-a-repository", `${label} is not a Git repository: ${cwd}`, {
      cause: error,
    });
  }
}

async function assertSameRepository(worktreeRoot: string, sourceRepoRoot: string): Promise<string> {
  const [worktreeGitDir, sourceGitDir] = await Promise.all([
    resolveCommonGitDir(worktreeRoot, "Worktree"),
    resolveCommonGitDir(sourceRepoRoot, "Source repository"),
  ]);
  if (worktreeGitDir !== sourceGitDir) {
    throw new CodeSnapshotError(
      "invalid-input",
      `Worktree and source repository do not share a Git directory: ${worktreeRoot} and ${sourceRepoRoot}`,
    );
  }
  return sourceGitDir;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertNoInProgressOperation(worktreeRoot: string): Promise<void> {
  const operationPaths = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "sequencer",
    "rebase-merge",
    "rebase-apply",
  ];
  const resolvedPaths = await Promise.all(
    operationPaths.map(async (operationPath) => {
      const gitPath = await git(["rev-parse", "--git-path", operationPath], worktreeRoot);
      return { operationPath, gitPath: path.resolve(worktreeRoot, gitPath) };
    }),
  );
  const active = resolvedPaths.find(({ gitPath }) => existsSync(gitPath));
  if (active) {
    throw new CodeSnapshotError(
      "unsupported-state",
      `Cannot snapshot a Git operation in progress (${active.operationPath})`,
    );
  }
}

async function assertSupportedIndex(worktreeRoot: string): Promise<void> {
  const unmerged = await git(["ls-files", "-u", "-z"], worktreeRoot);
  if (unmerged) {
    throw new CodeSnapshotError(
      "unsupported-state",
      "Cannot snapshot an unmerged index; resolve the Git conflicts first",
    );
  }

  const stagedEntries = await git(["ls-files", "--stage", "-z"], worktreeRoot);
  const entries = stagedEntries.split("\0").filter(Boolean);
  for (const entry of entries) {
    const mode = entry.slice(0, entry.indexOf(" "));
    if (mode === "0" || mode === "160000") {
      const reason = mode === "160000" ? "submodules" : "intent-to-add index entries";
      throw new CodeSnapshotError("unsupported-state", `Cannot snapshot ${reason}`);
    }
  }

  const fileFlags = await git(["ls-files", "-v", "-z"], worktreeRoot);
  const unsupportedFlag = fileFlags
    .split("\0")
    .filter(Boolean)
    .find((entry) => entry[0] === "S" || entry[0] === "s" || entry[0] === "h");
  if (unsupportedFlag) {
    throw new CodeSnapshotError(
      "unsupported-state",
      "Cannot snapshot an index using assume-unchanged or skip-worktree entries",
    );
  }
}

async function assertNoNestedRepositories(worktreeRoot: string): Promise<void> {
  const untracked = await git(
    ["ls-files", "--others", "--exclude-standard", "--directory", "-z"],
    worktreeRoot,
  );
  for (const rawPath of untracked.split("\0").filter(Boolean)) {
    const relativePath = rawPath.replace(/\/$/, "");
    const segments = relativePath.split(path.sep);
    for (let index = 1; index <= segments.length; index += 1) {
      const candidate = path.join(worktreeRoot, ...segments.slice(0, index));
      if (existsSync(path.join(candidate, ".git"))) {
        throw new CodeSnapshotError(
          "unsupported-state",
          `Cannot snapshot a nested repository at ${path.join(...segments.slice(0, index))}`,
        );
      }
    }
  }
}

async function assertSupportedCheckout(worktreeRoot: string): Promise<void> {
  await assertNoInProgressOperation(worktreeRoot);
  await assertSupportedIndex(worktreeRoot);
  await assertNoNestedRepositories(worktreeRoot);
}

function createTemporaryIndex(): TemporaryIndex {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-duel-snapshot-"));
  return { directory, file: path.join(directory, "index") };
}

function removeTemporaryIndex(temporaryIndex: TemporaryIndex): void {
  rmSync(temporaryIndex.directory, { recursive: true, force: true });
}

async function getTreeFromWorkingTree(worktreeRoot: string): Promise<string> {
  const temporaryIndex = createTemporaryIndex();
  try {
    const envOverlay = { GIT_INDEX_FILE: temporaryIndex.file };
    await git(["read-tree", "HEAD"], worktreeRoot, { envOverlay });
    await git(["add", "-A", "--", "."], worktreeRoot, { envOverlay });
    return await git(["write-tree"], worktreeRoot, { envOverlay });
  } finally {
    removeTemporaryIndex(temporaryIndex);
  }
}

async function getCheckoutState(worktreeRoot: string): Promise<GitCheckoutState> {
  const [head, branch, indexTree, workingTree] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD^{commit}"], worktreeRoot),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreeRoot, {
      acceptExitCodes: [0, 1],
    }),
    git(["write-tree"], worktreeRoot),
    getTreeFromWorkingTree(worktreeRoot),
  ]);
  return { head, branch: branch || null, indexTree, workingTree };
}

function ensureObjectId(value: string, label: string): void {
  if (!HEX_OBJECT_PATTERN.test(value)) {
    throw new CodeSnapshotError("invalid-snapshot", `Invalid ${label} object id: ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getSnapshotString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodeSnapshotError("invalid-snapshot", `Workspace snapshot field ${key} is invalid`);
  }
  return value;
}

export function parseCodeSnapshot(value: unknown): CodeSnapshot {
  if (!isRecord(value)) {
    throw new CodeSnapshotError("invalid-snapshot", "Workspace snapshot must be an object");
  }
  const snapshotId = getSnapshotString(value, "snapshotId");
  const worktreeRoot = getSnapshotString(value, "worktreeRoot");
  const sourceRepoRoot = getSnapshotString(value, "sourceRepoRoot");
  const head = getSnapshotString(value, "head");
  const indexCommit = getSnapshotString(value, "indexCommit");
  const workingCommit = getSnapshotString(value, "workingCommit");
  const branchValue = value.branch;
  if (branchValue !== null && typeof branchValue !== "string") {
    throw new CodeSnapshotError("invalid-snapshot", "Workspace snapshot field branch is invalid");
  }
  validateSnapshotId(snapshotId);
  validateDirectory(worktreeRoot, "snapshot.worktreeRoot");
  validateDirectory(sourceRepoRoot, "snapshot.sourceRepoRoot");
  ensureObjectId(head, "HEAD");
  ensureObjectId(indexCommit, "index");
  ensureObjectId(workingCommit, "working");
  return {
    snapshotId,
    worktreeRoot: path.resolve(worktreeRoot),
    sourceRepoRoot: path.resolve(sourceRepoRoot),
    head,
    indexCommit,
    workingCommit,
    branch: branchValue,
  };
}

async function createSnapshotCommit(
  worktreeRoot: string,
  tree: string,
  head: string,
  kind: "index" | "working",
): Promise<string> {
  const commit = await git(
    [
      "-c",
      "user.name=Agent Duel workspace snapshot",
      "-c",
      "user.email=agent-duel-snapshot@localhost",
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      `Agent Duel workspace snapshot (${kind})`,
    ],
    worktreeRoot,
  );
  ensureObjectId(commit, `${kind} commit`);
  return commit;
}

function statesEqual(first: GitCheckoutState, second: GitCheckoutState): boolean {
  return (
    first.head === second.head &&
    first.branch === second.branch &&
    first.indexTree === second.indexTree &&
    first.workingTree === second.workingTree
  );
}

async function writeSnapshotRefs(sourceRepoRoot: string, snapshot: CodeSnapshot): Promise<void> {
  const refs: SnapshotRefs = {
    head: snapshot.head,
    index: snapshot.indexCommit,
    working: snapshot.workingCommit,
  };
  for (const name of ["head", "index", "working"] as const) {
    await git(["update-ref", snapshotRef(snapshot.snapshotId, name), refs[name]], sourceRepoRoot);
  }
}

async function assertSnapshotRef(
  sourceRepoRoot: string,
  snapshotId: string,
  name: keyof SnapshotRefs,
  expected: string,
): Promise<void> {
  const actual = await git(
    ["rev-parse", "--verify", snapshotRef(snapshotId, name)],
    sourceRepoRoot,
  );
  if (actual !== expected) {
    throw new CodeSnapshotError(
      "invalid-snapshot",
      `Workspace snapshot ref ${name} does not match its metadata`,
    );
  }
}

async function assertSnapshotCommit(
  sourceRepoRoot: string,
  commit: string,
  head: string,
  label: string,
): Promise<string> {
  ensureObjectId(commit, `${label} commit`);
  const commitLine = await git(["rev-list", "--parents", "-n", "1", commit], sourceRepoRoot);
  const parents = commitLine.split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== head) {
    throw new CodeSnapshotError(
      "invalid-snapshot",
      `Workspace snapshot ${label} commit does not have the saved HEAD as its only parent`,
    );
  }
  return git(["rev-parse", `${commit}^{tree}`], sourceRepoRoot);
}

async function verifySnapshotMetadata(
  worktreeRoot: string,
  sourceRepoRoot: string,
  snapshot: CodeSnapshot,
): Promise<{ indexTree: string; workingTree: string }> {
  validateSnapshotId(snapshot.snapshotId);
  ensureObjectId(snapshot.head, "HEAD");
  ensureObjectId(snapshot.indexCommit, "index");
  ensureObjectId(snapshot.workingCommit, "working");
  await assertSameRepository(worktreeRoot, sourceRepoRoot);
  if (path.resolve(snapshot.sourceRepoRoot) !== sourceRepoRoot) {
    throw new CodeSnapshotError(
      "invalid-snapshot",
      "Workspace snapshot source repository does not match the restore source",
    );
  }
  await assertSnapshotRef(sourceRepoRoot, snapshot.snapshotId, "head", snapshot.head);
  await assertSnapshotRef(sourceRepoRoot, snapshot.snapshotId, "index", snapshot.indexCommit);
  await assertSnapshotRef(sourceRepoRoot, snapshot.snapshotId, "working", snapshot.workingCommit);
  await git(["cat-file", "-e", `${snapshot.head}^{commit}`], sourceRepoRoot);
  const indexTree = await assertSnapshotCommit(
    sourceRepoRoot,
    snapshot.indexCommit,
    snapshot.head,
    "index",
  );
  const workingTree = await assertSnapshotCommit(
    sourceRepoRoot,
    snapshot.workingCommit,
    snapshot.head,
    "working",
  );
  return { indexTree, workingTree };
}

export async function verifyCodeSnapshot(input: RestoreCodeSnapshotInput): Promise<void> {
  const worktreeRoot = validateDirectory(input.worktreeRoot, "worktreeRoot");
  const sourceRepoRoot = validateDirectory(input.sourceRepoRoot, "sourceRepoRoot");
  await verifySnapshotMetadata(worktreeRoot, sourceRepoRoot, input.snapshot);
}

export async function verifyCodeSnapshotCheckout(input: RestoreCodeSnapshotInput): Promise<void> {
  const worktreeRoot = validateDirectory(input.worktreeRoot, "worktreeRoot");
  const sourceRepoRoot = validateDirectory(input.sourceRepoRoot, "sourceRepoRoot");
  const snapshot = input.snapshot;
  const trees = await verifySnapshotMetadata(worktreeRoot, sourceRepoRoot, snapshot);
  let state: GitCheckoutState;
  try {
    state = await getCheckoutState(worktreeRoot);
  } catch (error) {
    throw new CodeSnapshotError(
      "invalid-snapshot",
      "Current worktree cannot be compared with the workspace snapshot",
      { cause: error },
    );
  }
  if (
    state.head !== snapshot.head ||
    state.indexTree !== trees.indexTree ||
    state.workingTree !== trees.workingTree
  ) {
    throw new CodeSnapshotError(
      "invalid-snapshot",
      "Current worktree does not match the saved HEAD, index, and working tree",
    );
  }
}

export async function captureCodeSnapshot(input: CodeSnapshotInput): Promise<CodeSnapshot> {
  const worktreeRoot = validateDirectory(input.worktreeRoot, "worktreeRoot");
  const sourceRepoRoot = validateDirectory(input.sourceRepoRoot, "sourceRepoRoot");
  validateSnapshotId(input.snapshotId);
  await assertSameRepository(worktreeRoot, sourceRepoRoot);
  await assertSupportedCheckout(worktreeRoot);

  let before: GitCheckoutState;
  try {
    before = await getCheckoutState(worktreeRoot);
  } catch (error) {
    throw new CodeSnapshotError(
      "unsupported-state",
      "Cannot snapshot a Git checkout without a committed HEAD",
      { cause: error },
    );
  }
  const indexCommit = await createSnapshotCommit(
    worktreeRoot,
    before.indexTree,
    before.head,
    "index",
  );
  const workingCommit = await createSnapshotCommit(
    worktreeRoot,
    before.workingTree,
    before.head,
    "working",
  );
  const after = await getCheckoutState(worktreeRoot);
  if (!statesEqual(before, after)) {
    throw new CodeSnapshotError(
      "unstable-source",
      "Workspace changed while its Git code snapshot was being captured",
    );
  }

  const snapshot: CodeSnapshot = {
    snapshotId: input.snapshotId,
    worktreeRoot,
    sourceRepoRoot,
    head: before.head,
    indexCommit,
    workingCommit,
    branch: before.branch,
  };
  await writeSnapshotRefs(sourceRepoRoot, snapshot);
  await verifyCodeSnapshotCheckout({ worktreeRoot, sourceRepoRoot, snapshot });
  return snapshot;
}

function assertRestorePathIsFree(worktreeRoot: string): void {
  try {
    lstatSync(worktreeRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw new CodeSnapshotError("occupied-path", `Cannot inspect restore path: ${worktreeRoot}`, {
      cause: error,
    });
  }
  throw new CodeSnapshotError("occupied-path", `Restore path already exists: ${worktreeRoot}`);
}

export async function restoreCodeSnapshot(
  input: RestoreCodeSnapshotInput,
): Promise<{ worktreeRoot: string; branch: null }> {
  const worktreeRoot = validateDirectory(input.worktreeRoot, "worktreeRoot");
  const sourceRepoRoot = validateDirectory(input.sourceRepoRoot, "sourceRepoRoot");
  const snapshot = input.snapshot;
  await verifySnapshotMetadata(sourceRepoRoot, sourceRepoRoot, snapshot);
  assertRestorePathIsFree(worktreeRoot);
  const parent = path.dirname(worktreeRoot);
  if (!existsSync(parent)) {
    throw new CodeSnapshotError(
      "invalid-input",
      `Restore parent directory does not exist: ${parent}`,
    );
  }

  let worktreeAdded = false;
  try {
    await git(["worktree", "prune"], sourceRepoRoot);
    await git(["worktree", "add", "--detach", worktreeRoot, snapshot.head], sourceRepoRoot);
    worktreeAdded = true;
    await git(["read-tree", "--reset", "-u", `${snapshot.workingCommit}^{tree}`], worktreeRoot);
    await git(["read-tree", `${snapshot.indexCommit}^{tree}`], worktreeRoot);
    await verifyCodeSnapshotCheckout({ worktreeRoot, sourceRepoRoot, snapshot });
    return { worktreeRoot, branch: null };
  } catch (error) {
    if (worktreeAdded) {
      try {
        await git(["worktree", "remove", "--force", worktreeRoot], sourceRepoRoot);
      } catch {
        // Preserve the original restore error; the path is still available for diagnosis.
      }
    }
    if (error instanceof CodeSnapshotError) {
      throw error;
    }
    throw new CodeSnapshotError("invalid-snapshot", `Unable to restore workspace snapshot`, {
      cause: error,
    });
  }
}

export async function releaseCodeSnapshot(input: {
  sourceRepoRoot: string;
  snapshotId: string;
}): Promise<void> {
  const sourceRepoRoot = validateDirectory(input.sourceRepoRoot, "sourceRepoRoot");
  validateSnapshotId(input.snapshotId);
  await resolveCommonGitDir(sourceRepoRoot, "Source repository");
  for (const name of ["head", "index", "working"] as const) {
    await git(["update-ref", "-d", snapshotRef(input.snapshotId, name)], sourceRepoRoot);
  }
}
