import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  randomWorktreeId,
  type WorktreeSeedFn,
  slugify,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout" | "detach";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  worktreesRoot?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  seedIgnoredContent?: WorktreeSeedFn;
  onBeforeAdd?: (worktreePath: string, repoRoot: string) => Promise<void>;
  onAddFailed?: (worktreePath: string) => Promise<void>;
}

export interface CreateWorktreeCoreResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  repoRoot: string;
  created: boolean;
  /**
   * Whether the branch name was invented here rather than asked for. A caller that names a
   * branch gets that name and keeps it; everything else starts on a stand-in that the first
   * prompt is allowed to replace.
   */
  branchNameIsPlaceholder: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const requestedBranchName = input.branchName
    ? validateWorktreeSlug(input.branchName.trim())
    : undefined;

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.action === "detach") {
    intentInput = {
      action: "detach",
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.checkoutSource !== undefined || input.githubPrNumber !== undefined) {
    intentInput = {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    // The placeholder branch a branch-off worktree starts on, renamed once the first prompt
    // names it. A word pair rather than the directory id: this one is a branch people see.
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      branchName: requestedBranchName ?? normalizeWorktreeSlug(createNameId()),
      worktreeSlug: requestedWorktreeSlug,
    };
  }

  const forge = await resolveForge(repoRoot, deps, intentInput);
  const intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
  });
  // The directory is named by id whatever the worktree checks out. A name derived from
  // the branch would go stale as soon as the branch is renamed, created, or switched.
  const normalizedSlug = requestedWorktreeSlug ?? randomWorktreeId();

  const worktree = await createWorktree({
    cwd: repoRoot,
    worktreeSlug: normalizedSlug,
    source: intent,
    runSetup: input.runSetup ?? true,
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
    seedIgnoredContent: deps.seedIgnoredContent,
    onBeforeAdd: deps.onBeforeAdd
      ? (worktreePath) => deps.onBeforeAdd!(worktreePath, repoRoot)
      : undefined,
    onAddFailed: deps.onAddFailed,
  });

  return {
    worktree,
    intent,
    repoRoot,
    created: true,
    // Read from the branch that exists rather than from the request: a requested name that
    // was already taken lands on the generated slug instead, and that slug is a placeholder
    // like any other.
    branchNameIsPlaceholder: worktree.branchName !== requestedBranchName,
  };
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return { forge: resolution.forge, service: resolution.service };
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
): Promise<string> {
  const baseBranch = deps.resolveDefaultBranch
    ? await deps.resolveDefaultBranch(repoRoot)
    : await deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

export async function resolveWorktreeRepoRoot(
  input: Pick<CreateWorktreeCoreInput, "cwd" | "paseoHome">,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}
