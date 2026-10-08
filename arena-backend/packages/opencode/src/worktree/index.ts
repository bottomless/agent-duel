import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { path } from "@opencode-ai/core/effect/app-node-platform";
import { Global } from "@opencode-ai/core/global";
import { InstanceStore } from "@/project/instance-store";
import { Project } from "@/project/project";
import { Database } from "@opencode-ai/core/database/database";
import { eq } from "drizzle-orm";
import { ProjectTable } from "@opencode-ai/core/project/sql";
import { ProjectV2 } from "@opencode-ai/core/project";
import { Slug } from "@opencode-ai/core/util/slug";
import { errorMessage } from "../util/error";
import { copyTree } from "../util/copy-tree";
import { copyGitState } from "./git-state";
import {
  discardTree,
  sweepTrash as sweepTrashDir,
  TRASH_DIRNAME,
  trashFor,
} from "../util/discard-tree";
import { GlobalBus } from "@/bus/global";
import { Git } from "@/git";
import { Effect, Layer, Path, Schema, Scope, Context, Semaphore } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { FSUtil } from "@opencode-ai/core/fs-util";
import { AppProcess } from "@opencode-ai/core/process";
import { InstanceState } from "@/effect/instance-state";
import { WorktreeEvent } from "@opencode-ai/schema/worktree-event";
import { ProjectDirectories } from "@opencode-ai/core/project/directories";
import { AbsolutePath } from "@opencode-ai/core/schema";
import { randomUUID } from "crypto";
import { lstat, mkdir, readdir, rename, rm, unlink } from "fs/promises";
import {
  hostRepoPath,
  isolatedRoot,
  localStatePath,
  LOCAL_STATE_DIRNAME,
  PRIVATE_REF_PREFIXES,
} from "./layout";
import { ignoreForFileProviderSync } from "@/util/file-provider-ignore";

export const Event = WorktreeEvent;

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
  /**
   * The repository this worktree belongs to, when it is not the caller's checkout.
   *
   * An isolated worktree is registered in a bare repository of its own, a copy of the
   * checkout's git directory, so its branch, its commits, and the worktree registration
   * itself stay out of the repository the user works in. See `hostRepoPath`.
   */
  host: Schema.optional(Schema.String),
}).annotate({ identifier: "Worktree" });
export type Info = Schema.Schema.Type<typeof Info>;

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({
      description: "Additional startup script to run after the project's start command",
    }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" });
export type CreateInput = Schema.Schema.Type<typeof CreateInput>;

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
  /**
   * Keep the worktree's branch after the directory goes. An Arena contestant
   * branch outlives its worktree so a turn whose result could not be applied
   * still has somewhere to send the user.
   */
  keepBranch: Schema.optional(Schema.Boolean),
  /** The repository holding this worktree's registration, for an isolated worktree. */
  host: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeRemoveInput" });
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>;

export const ReclaimInput = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  /**
   * Register the worktree in a bare repository of its own instead of the caller's
   * checkout, creating that repository if it is not there yet.
   */
  isolated: Schema.optional(Schema.Boolean),
  /**
   * Copy the isolated worktree's repository afresh even when one is already there, so a
   * worktree claimed at this path never inherits what an earlier occupant left in its host.
   */
  freshHost: Schema.optional(Schema.Boolean),
  /**
   * The frozen working tree an isolated worktree will be synced to. Its host ignores the
   * dependency folders this tree does not hold; without it, the host ignores none.
   */
  baseTree: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeReclaimInput" });
export type ReclaimInput = Schema.Schema.Type<typeof ReclaimInput>;

export const AdoptInput = Schema.Struct({
  /** An isolated worktree in whatever state its last user left it. */
  from: Schema.String,
  /** Where the adopted worktree serves next. May be `from` itself. */
  to: Schema.String,
  name: Schema.String,
  /** The branch the worktree has checked out. Without one it is detached at `head`. */
  branch: Schema.optional(Schema.String),
  /** The commit a detached worktree, or a branch the checkout does not have, starts at. */
  head: Schema.String,
  /** As `ReclaimInput.baseTree`. */
  baseTree: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeAdoptInput" });
export type AdoptInput = Schema.Schema.Type<typeof AdoptInput>;

/**
 * An adopted worktree. `indexKept` says whether the previous index came along: when it did it
 * still matches the files by stat; when it did not, the index was read from `head` and carries
 * no stat information, so the first command that compares it with the files hashes them all.
 *
 * A kept index is rewritten once without its untracked cache, which records the directory it
 * was built in and would warn on every `git status` at a new path. Everything else in it, the
 * entries' flags included, stays until the caller's reset replaces it.
 */
export type Adopted = Info & { readonly indexKept: boolean };

/**
 * A tree copied into the worktree after checkout and before the start command runs, so a
 * caller can carry gitignored dependency directories across a recreate. `target` is
 * relative to the worktree root.
 */
export type SeedEntry = {
  readonly source: string;
  readonly target: string;
};

/** Extra control over what `activate` does once the tree is on disk. */
export type ActivateOptions = {
  /** Leave the project's start scripts and the caller's setup command unrun. */
  readonly skipStartScripts?: boolean;
  /** Fail activation when an environment seed cannot be copied completely. */
  readonly requireSeed?: boolean;
  /** Compatibility hook for callers that prepare a worktree after checkout. */
  readonly prepare?: (directory: string) => Promise<void>;
  /** Restore invariants after start scripts run and before the worktree is announced ready. */
  readonly afterStart?: (directory: string) => Promise<void>;
};

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" });
export type ResetInput = Schema.Schema.Type<typeof ResetInput>;

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()(
  "WorktreeCreateFailedError",
  {
    message: Schema.String,
  },
) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()(
  "WorktreeRemoveFailedError",
  {
    message: Schema.String,
  },
) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()(
  "WorktreeResetFailedError",
  {
    message: Schema.String,
  },
) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()(
  "WorktreeListFailedError",
  {
    message: Schema.String,
  },
) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError;

export { hostRepoPath, isolatedRoot, LOCAL_STATE_DIRNAME } from "./layout";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i);
        if (!match) return [];
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "");
        if (!value) return [];
        return [value];
      }),
  );
}

/**
 * Dependency folders a contestant installs are not part of its result.
 *
 * A project often ignores only its root `/node_modules`, so a contestant that installs a tool
 * into a subfolder adds thousands of untracked files. They would count as its changes, slow its
 * snapshot, and land in the checkout if that side won: one installed Playwright under `qa/`
 * and showed +2.3m lines across 9,860 files. Unanchored, so the folders are ignored at any
 * depth. This goes into the contestant's own repository and never the checkout's, where the
 * patterns would hide the developer's own files.
 *
 * A name the frozen base already holds, at any depth, is left out (`dependencyFoldersIn`). The
 * base carries the checkout's tracked files and the untracked ones its own rules do not ignore,
 * and the contestant's tree is checked against it: an untracked `__pycache__` in a project that
 * ignores only `*.pyc` would fail that check on every battle. In a project that commits its
 * `node_modules`, the exclude would also hide the new files of a package the contestant
 * installs while its edits to the tracked ones still count, and the vote would apply half an
 * install.
 *
 * Only names that are never source: `vendor`, `target`, `build` and `deps` are dependency or
 * build folders in some ecosystems and real code in others, and a contestant's new code there
 * would silently drop out of its result.
 */
const DEPENDENCY_FOLDERS = ["node_modules", ".venv", "__pycache__"];

/** `held` is the dependency folder names the frozen base holds, which stay visible. */
function withDependencyExcludes(excludes: string, held: ReadonlySet<string>) {
  const folders = DEPENDENCY_FOLDERS.filter((name) => !held.has(name));
  if (folders.length === 0) return excludes;
  const separator = excludes && !excludes.endsWith("\n") ? "\n" : "";
  const block = [
    "# Agent Duel: dependency folders are not a contestant's changes",
    ...folders.map((name) => `${name}/`),
  ];
  return `${excludes}${separator}${block.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: {
    name?: string;
    detached?: boolean;
  }) => Effect.Effect<Info, Error>;
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>;
  readonly createFromInfoAt: (
    info: Info,
    ref: string,
    startCommand?: string,
    options?: {
      reset?: boolean;
      seed?: readonly SeedEntry[];
      /** Compatibility hook retained for the pre-seed Arena service. */
      prepare?: (directory: string) => Promise<void>;
    },
  ) => Effect.Effect<void, Error>;
  readonly attachAt: (
    info: Info,
    ref: string,
    options?: { reset?: boolean },
  ) => Effect.Effect<void, Error>;
  readonly repointAt: (info: Info, ref: string) => Effect.Effect<void, Error>;
  readonly activate: (
    info: Info,
    startCommand?: string,
    seed?: readonly SeedEntry[],
    options?: ActivateOptions,
  ) => Effect.Effect<void, Error>;
  readonly reclaimWorktreeInfo: (input: ReclaimInput) => Effect.Effect<Info, Error>;
  readonly adopt: (input: AdoptInput) => Effect.Effect<Adopted, Error>;
  readonly retire: (directory: string) => Effect.Effect<void, Error>;
  /**
   * Empty `<root>/.trash` in the background. An isolated worktree discarded from
   * `<isolatedRoot>/<chat>/` lands in that directory's own trash, which nothing else sweeps.
   * Safe to call at any time: a host an adopt in progress still reads from is left for that
   * adopt to delete, and a `.trash` that is not a directory is unlinked, never followed.
   */
  readonly sweepTrash: (root: string) => Effect.Effect<void>;
  /**
   * `sweepTrash`, returning once the trash is empty. For an archive: the user asked for the
   * disk back, and a delete left in the background dies with the process if it stops first.
   */
  readonly drainTrash: (root: string) => Effect.Effect<void>;
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>;
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>;
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>;
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>;
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Worktree") {}

type GitResult = { code: number; text: string; stderr: string };

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | ProjectV2.Service
  | ProjectDirectories.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const fs = yield* FSUtil.Service;
    const pathSvc = yield* Path.Path;
    const appProcess = yield* AppProcess.Service;
    const { db } = yield* Database.Service;
    const gitSvc = yield* Git.Service;
    const project = yield* Project.Service;
    const projectV2 = yield* ProjectV2.Service;
    const projectDirectories = yield* ProjectDirectories.Service;
    const store = yield* InstanceStore.Service;

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        );
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult;
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    );

    const MAX_NAME_ATTEMPTS = 26;
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string;
      name?: string;
      detached?: boolean;
    }) {
      const ctx = yield* InstanceState.context;
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name
          ? attempt === 0
            ? input.name
            : `${input.name}-${Slug.create()}`
          : Slug.create();
        const branch = input.detached ? undefined : `opencode/${name}`;
        const directory = pathSvc.join(input.root, name);

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue;

        if (branch) {
          const ref = `refs/heads/${branch}`;
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], {
            cwd: ctx.worktree,
          });
          if (branchCheck.code === 0) continue;
        }

        return { name, directory, ...(branch ? { branch } : {}) };
      }
      return yield* new NameGenerationFailedError({
        message: "Failed to generate a unique worktree name",
      });
    });

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string;
      detached?: boolean;
    }) {
      const ctx = yield* InstanceState.context;
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" });
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id);
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);

      return yield* candidate({
        root,
        name: input?.name ? slugify(input.name) : "",
        detached: input?.detached,
      });
    });

    // Both contestant sides claim at once, and each writes the checkout's shared files. A plain
    // write truncates before it writes, so the other side could read an empty `info/exclude`
    // and write that back without the user's patterns.
    const fileLocks = new Map<string, Semaphore.Semaphore>();
    const withFileLock = <A, E, R>(file: string, effect: Effect.Effect<A, E, R>) => {
      const existing = fileLocks.get(file);
      const lock = existing ?? Semaphore.makeUnsafe(1);
      if (!existing) fileLocks.set(file, lock);
      return lock.withPermits(1)(effect);
    };
    /** Readers see the old content or the new, never a partial file. */
    const replaceFile = Effect.fnUntraced(function* (file: string, content: string) {
      yield* fs.makeDirectory(pathSvc.dirname(file), { recursive: true }).pipe(Effect.orDie);
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      yield* fs.writeFileString(temporary, content).pipe(Effect.orDie);
      yield* fs.rename(temporary, file).pipe(Effect.orDie);
    });

    /**
     * Keep the checkout blind to the state built inside it.
     *
     * An isolated worktree lives in the checkout, so without this git reports a battle in
     * progress as untracked changes — and a turn reads the checkout's cleanliness to decide
     * what it may apply. Written to `info/exclude`, not `.gitignore`: the pattern is this
     * machine's business, and a tracked file is the user's.
     *
     * Anchored with a leading slash, so a directory of the same name deeper in the tree is
     * left to the user.
     */
    const excludeLocalState = Effect.fnUntraced(function* (checkout: string) {
      const located = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
        cwd: checkout,
      });
      if (located.code !== 0) {
        return yield* new CreateFailedError({
          message: located.stderr || located.text || "Failed to locate the checkout's exclude file",
        });
      }
      const file = located.text.trim();
      const pattern = `/${LOCAL_STATE_DIRNAME}/`;
      yield* withFileLock(
        file,
        Effect.gen(function* () {
          const current = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
          if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
          yield* replaceFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
        }),
      );
      yield* keepLocalStateUnsynced(checkout);
    });

    /**
     * Keep cloud sync out of the local-state directory; see `FILE_PROVIDER_IGNORE_ATTRIBUTE`.
     * Runs with the exclude, so with every host a slot is built or adopted into, which also marks
     * a directory an older version created.
     */
    const keepLocalStateUnsynced = Effect.fnUntraced(function* (checkout: string) {
      const directory = localStatePath(checkout);
      const outcome = yield* Effect.promise(() => ignoreForFileProviderSync(directory));
      if (outcome.state === "failed") {
        yield* Effect.logWarning("Arena could not exclude its local state from cloud sync", {
          directory,
          reason: outcome.reason,
        });
      }
    });

    /**
     * Stop tools that read ancestor directories at the local-state directory.
     *
     * An isolated worktree sits inside the checkout, so anything that walks up from a file
     * being built now walks through here and into the checkout — and finds the project's own
     * configuration a second time, from a second `node_modules`. ESLint says so out loud:
     * "ESLint couldn't determine the plugin 'react' uniquely", and the contestant's dev
     * server fails on a project that builds fine anywhere else.
     *
     * `root: true` is the eslintrc cascade's own way of saying stop here. It is written into
     * the local-state directory rather than the worktree, so it applies to everything built
     * under it and nothing the user has.
     */
    const markConfigBoundary = Effect.fnUntraced(function* (checkout: string) {
      const file = pathSvc.join(localStatePath(checkout), ".eslintrc.json");
      yield* withFileLock(
        file,
        Effect.gen(function* () {
          if (yield* fs.exists(file).pipe(Effect.orDie)) return;
          yield* replaceFile(file, `{ "root": true }\n`);
        }),
      );
    });

    /**
     * The `DEPENDENCY_FOLDERS` names `tree` holds as a directory at any depth. Read from the
     * checkout, which wrote the frozen tree. Compared without case: a checkout that ignores case
     * matches `node_modules/` against `Node_Modules` too, and keeping a name is always safe.
     */
    const dependencyFoldersIn = Effect.fnUntraced(function* (checkout: string, tree: string) {
      const listed = yield* git(["ls-tree", "-r", "-d", "-z", "--name-only", "--full-tree", tree], {
        cwd: checkout,
      });
      if (listed.code !== 0) {
        return yield* new CreateFailedError({
          message: listed.stderr || listed.text || `Failed to read the frozen tree ${tree}`,
        });
      }
      const held = new Set<string>();
      for (const directory of listed.text.split("\0")) {
        const name = directory.slice(directory.lastIndexOf("/") + 1).toLowerCase();
        if (DEPENDENCY_FOLDERS.includes(name)) held.add(name);
      }
      return held;
    });

    /**
     * Create — or repair — the bare repository an isolated worktree is registered in.
     *
     * It is a copy of the checkout's git directory without the worktree registrations, so a
     * contestant runs with the developer's hooks, config, remotes, objects, and refs
     * (`./git-state.ts`). The copy is one-directional: the checkout holds no record of it,
     * which is what keeps the contestant's branch, commits, and worktree registration
     * invisible there. The arena mirror refreshes refs before each turn; nothing here has to.
     *
     * An existing host is kept unless `fresh` is set; then it goes to the trash and a new copy
     * is made, so nothing an earlier contestant did to it survives.
     */
    const ensureHostRepo = Effect.fnUntraced(function* (
      directory: string,
      options?: { readonly fresh?: boolean; readonly baseTree?: string },
    ) {
      const ctx = yield* InstanceState.context;
      const host = hostRepoPath(directory);
      const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: ctx.worktree,
      });
      if (common.code !== 0) {
        return yield* new CreateFailedError({
          message: common.stderr || common.text || "Failed to locate the checkout's object store",
        });
      }
      const commonDir = common.text.trim();
      const parent = pathSvc.dirname(host);
      yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.orDie);
      if (options?.fresh) yield* discardEntry(host);

      if (!(yield* fs.exists(pathSvc.join(host, "HEAD")).pipe(Effect.orDie))) {
        // Anything half-written from an interrupted create has no `HEAD`; the copy lands
        // under `<host>.partial` and is renamed only when complete.
        if (yield* fs.exists(host).pipe(Effect.orDie)) yield* cleanDirectory(host);
        const started = performance.now();
        yield* Effect.tryPromise({
          try: () =>
            copyGitState({
              source: commonDir,
              target: host,
              excludeRefPrefixes: PRIVATE_REF_PREFIXES,
            }),
          catch: (error) =>
            new CreateFailedError({
              message: errorMessage(error) || "Failed to copy the checkout's git state",
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.logInfo("worktree host repository copied", {
              directory,
              host,
              durationMs: Math.round(performance.now() - started),
            }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("worktree host repository copy failed", {
              directory,
              host,
              durationMs: Math.round(performance.now() - started),
              error,
            }),
          ),
        );
      }

      yield* excludeLocalState(ctx.worktree);
      // The copy carries the checkout's excludes, but the checkout may have changed them
      // since, and a repaired host keeps its old file. Those paths are environment state in
      // the canonical checkout and must remain ignored when copied into a contestant.
      const canonicalExclude = pathSvc.join(commonDir, "info", "exclude");
      const hostExclude = pathSvc.join(host, "info", "exclude");
      const excludes = yield* fs
        .readFileString(canonicalExclude)
        .pipe(Effect.catch(() => Effect.succeed("")));
      const hostedExcludes = yield* fs
        .readFileString(hostExclude)
        .pipe(Effect.catch(() => Effect.succeed("")));
      const held = options?.baseTree
        ? yield* dependencyFoldersIn(ctx.worktree, options.baseTree)
        : new Set(DEPENDENCY_FOLDERS);
      const contestantExcludes = withDependencyExcludes(excludes, held);
      if (hostedExcludes !== contestantExcludes) {
        yield* fs.makeDirectory(pathSvc.dirname(hostExclude), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(hostExclude, contestantExcludes).pipe(Effect.orDie);
      }
      yield* markConfigBoundary(ctx.worktree);

      // A worktree's project is resolved from the repository it belongs to. The copy shares
      // the checkout's root commit, but the stamp is what `Project.resolve` reads first, and
      // it keeps a moved session's destination project equal to the source's.
      yield* projectV2.commit({ store: AbsolutePath.make(host), id: ctx.project.id });

      return host;
    });

    const setup = Effect.fnUntraced(function* (
      info: Info,
      ref: string,
      options?: { reset?: boolean },
    ) {
      const ctx = yield* InstanceState.context;
      // `-B` force-points an existing branch at `ref`. Arena reuses one branch per
      // contestant across turns, so every turn after the first would fail under `-b`.
      const create = options?.reset ? "-B" : "-b";
      const started = performance.now();
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", create, info.branch, info.directory, ref]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, ref],
        { cwd: info.host ?? ctx.worktree },
      );
      if (created.code !== 0) {
        yield* Effect.logWarning("worktree attach failed", {
          directory: info.directory,
          durationMs: Math.round(performance.now() - started),
          error: created.stderr || created.text || "git worktree add failed",
        });
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        });
      }

      yield* Effect.logInfo("worktree attached", {
        directory: info.directory,
        durationMs: Math.round(performance.now() - started),
      });

      yield* project
        .addSandbox(ctx.project.id, info.directory)
        .pipe(Effect.catch(() => Effect.void));
    });

    /**
     * Restore the caller's gitignored trees into a freshly checked out worktree.
     *
     * Ordinary seeds are best effort because the start command repairs the environment.
     * A caller that skips setup can require the seed and receive a failed activation instead.
     */
    const applySeed = Effect.fnUntraced(function* (
      directory: string,
      seed: readonly SeedEntry[],
      required: boolean,
    ) {
      for (const entry of seed) {
        const started = performance.now();
        const copied = Effect.tryPromise({
          try: () => copyTree(entry.source, pathSvc.join(directory, entry.target)),
          catch: errorMessage,
        });
        if (required) {
          yield* copied.pipe(
            Effect.tap(() =>
              Effect.logInfo("worktree seed copied", {
                directory,
                target: entry.target,
                durationMs: Math.round(performance.now() - started),
              }),
            ),
            Effect.tapError((error) =>
              Effect.logWarning("worktree seed copy failed", {
                directory,
                target: entry.target,
                durationMs: Math.round(performance.now() - started),
                error,
              }),
            ),
          );
        } else {
          yield* copied.pipe(
            Effect.tap(() =>
              Effect.logInfo("worktree seed copied", {
                directory,
                target: entry.target,
                durationMs: Math.round(performance.now() - started),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree seed failed", {
                directory,
                target: entry.target,
                durationMs: Math.round(performance.now() - started),
                cause,
              }),
            ),
          );
        }
      }
    });

    const boot = Effect.fnUntraced(function* (
      info: Info,
      startCommand?: string,
      seed?: readonly SeedEntry[],
      options?: ActivateOptions,
    ) {
      const ctx = yield* InstanceState.context;
      const workspaceID = yield* InstanceState.workspaceID;
      const projectID = ctx.project.id;
      const extra = startCommand?.trim();

      const resetStarted = performance.now();
      const populated = yield* git(["reset", "--hard"], { cwd: info.directory });
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree";
        yield* Effect.logWarning("worktree activation reset failed", {
          directory: info.directory,
          durationMs: Math.round(performance.now() - resetStarted),
          error: message,
        });
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message });
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        });
        return;
      }
      yield* Effect.logInfo("worktree activation reset", {
        directory: info.directory,
        durationMs: Math.round(performance.now() - resetStarted),
      });

      if (seed?.length) {
        const seeded = yield* applySeed(info.directory, seed, options?.requireSeed === true).pipe(
          Effect.as(true),
          Effect.catch((message) =>
            Effect.gen(function* () {
              GlobalBus.emit("event", {
                directory: info.directory,
                project: ctx.project.id,
                workspace: workspaceID,
                payload: { type: Event.Failed.type, properties: { message } },
              });
              return false;
            }),
          ),
        );
        if (!seeded) return;
      }

      if (options?.prepare) {
        const prepared = yield* Effect.tryPromise({
          try: () => options.prepare!(info.directory),
          catch: errorMessage,
        }).pipe(
          Effect.as(true),
          Effect.catch((message) =>
            Effect.gen(function* () {
              GlobalBus.emit("event", {
                directory: info.directory,
                project: ctx.project.id,
                workspace: workspaceID,
                payload: { type: Event.Failed.type, properties: { message } },
              });
              return false;
            }),
          ),
        );
        if (!prepared) return;
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error);
            yield* Effect.logError("worktree bootstrap failed", {
              directory: info.directory,
              message,
            });
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            });
            return false;
          }),
        ),
      );
      if (!booted) return;

      // Skipped when the caller has already run these somewhere else and copied the result
      // in. Arena warms one contestant during the idle window and builds the other from its
      // payload, so running them again here would be the second run of a setup that is
      // supposed to happen once per turn — and two runs minutes apart are two environments.
      const started = options?.skipStartScripts
        ? true
        : yield* runStartScripts(info.directory, { projectID, extra });
      if (!started) {
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: {
            type: Event.Failed.type,
            properties: { message: "Worktree setup command failed" },
          },
        });
        return;
      }

      if (options?.afterStart) {
        const finalized = yield* Effect.tryPromise({
          try: () => options.afterStart!(info.directory),
          catch: errorMessage,
        }).pipe(
          Effect.as(true),
          Effect.catch((message) =>
            Effect.gen(function* () {
              GlobalBus.emit("event", {
                directory: info.directory,
                project: ctx.project.id,
                workspace: workspaceID,
                payload: { type: Event.Failed.type, properties: { message } },
              });
              return false;
            }),
          ),
        );
        if (!finalized) return;
      }

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      });
    });

    /**
     * Register the worktree with Git, without populating it.
     *
     * Split from `activate` so a caller preparing several worktrees can serialize just
     * this half. `worktree add` mutates the repository-wide worktree list and is not safe
     * to run concurrently; filling the directories afterwards is.
     */
    const attachAt = Effect.fn("Worktree.attachAt")(function* (
      info: Info,
      ref: string,
      options?: { reset?: boolean },
    ) {
      yield* setup(info, ref, options);
    });

    /**
     * Move an already-registered worktree to a ref without re-creating it.
     *
     * `attachAt` cannot: it is `git worktree add`, and git refuses to add a worktree whose
     * branch is checked out somewhere — including in the very directory being re-attached.
     * The normal path never notices because reclaiming unregisters the worktree first, which
     * is exactly what a caller reusing a prepared directory must not do.
     *
     * `reset --hard` moves the checked-out branch and the working tree together, which is
     * what `add -B` would have done, and touches no files when the trees already match.
     */
    const repointAt = Effect.fn("Worktree.repointAt")(function* (info: Info, ref: string) {
      const moved = yield* git(["reset", "--hard", ref], { cwd: info.directory });
      if (moved.code !== 0) {
        return yield* new ResetFailedError({
          message: moved.stderr || moved.text || `Failed to move worktree to ${ref}`,
        });
      }
    });

    /** Populate an attached worktree and announce it, in the background. */
    const activate = Effect.fn("Worktree.activate")(function* (
      info: Info,
      startCommand?: string,
      seed?: readonly SeedEntry[],
      options?: ActivateOptions,
    ) {
      yield* boot(info, startCommand, seed, options).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      );
    });

    const createFromInfoAt = Effect.fn("Worktree.createFromInfoAt")(function* (
      info: Info,
      ref: string,
      startCommand?: string,
      options?: {
        reset?: boolean;
        seed?: readonly SeedEntry[];
        /** Compatibility hook retained for the pre-seed Arena service. */
        prepare?: (directory: string) => Promise<void>;
      },
    ) {
      yield* attachAt(info, ref, options);
      yield* activate(info, startCommand, options?.seed, { prepare: options?.prepare });
    });

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (
      info: Info,
      startCommand?: string,
    ) {
      yield* createFromInfoAt(info, "HEAD", startCommand);
    });

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name });
      if (!input?.branch) {
        yield* createFromInfo(info, input?.startCommand);
        return info;
      }
      const ctx = yield* InstanceState.context;
      const ref = `refs/heads/${input.branch}`;
      if (
        (yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })).code !== 0
      ) {
        return yield* new CreateFailedError({ message: `Branch not found: ${input.branch}` });
      }
      yield* createFromInfoAt(info, ref, input.startCommand);
      return info;
    });

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input);
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)));
      const normalized = pathSvc.normalize(real);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    });

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc;
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() });
            return acc;
          }
          const current = acc[acc.length - 1];
          if (!current) return acc;
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim();
          }
          return acc;
        }, []);
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue;
        const key = yield* canonical(item.path);
        if (key === directory) return item;
      }
      return undefined;
    });

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context;
      if (ctx.project.vcs !== "git") {
        return [];
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree });
      if (result.code !== 0) {
        return yield* new ListFailedError({
          message: result.stderr || result.text || "Failed to read git worktrees",
        });
      }

      const primary = yield* canonical(ctx.project.worktree);
      const primaryName = pathSvc.basename(primary).toLowerCase();
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined;
          const directory = yield* canonical(entry.path);
          if (directory === primary) return undefined;
          const name = pathSvc.basename(directory).toLowerCase();
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          };
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)));
    });

    // Only in a directory with a `.git` of its own: without one git searches the parents, and
    // the parent of an isolated worktree is the user's checkout, whose daemon this would stop.
    // A file retired in a worktree's place has no `.git` below it, which access reports as ENOTDIR.
    function stopFsmonitor(target: string) {
      return fs.exists(pathSvc.join(target, ".git")).pipe(
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((exists) =>
          exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void,
        ),
      );
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises");
          const attempts = process.platform === "win32" ? 50 : 5;
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true });
              return;
            } catch (error) {
              if (attempt === attempts - 1) throw error;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({
            message: errorMessage(error) || "Failed to remove git worktree directory",
          }),
      });
    }

    /**
     * Whether `trash` is a directory a tree can be renamed into and a sweep can empty.
     *
     * Anything else there is unlinked, never followed. A contestant reaches its chat's trash as
     * `../.trash`, and through a symlink a sweep would empty the directory it names and a
     * discard would drop a whole tree into it.
     */
    const realTrash = (trash: string) =>
      Effect.promise(async () => {
        const found = await lstat(trash).catch(() => undefined);
        if (!found) return false;
        if (found.isDirectory()) return true;
        await unlink(trash).catch(() => undefined);
        return false;
      });

    /**
     * Names of hosts an adopt has moved into a trash and still reads from. A sweep leaves them
     * to the adopt, which deletes each one itself once it is done with it.
     */
    const parked = new Set<string>();

    /**
     * Take a worktree out of the caller's way, leaving the unlink for later.
     *
     * Until now clearing a worktree meant either blocking a turn on a hundred thousand
     * unlinks or deferring the whole removal and racing the next turn for the directory.
     * Renaming settles both: the path is free after one syscall, and the bytes go in the
     * background. Reports whether it worked — see `discardTree` for when it cannot.
     */
    const discardDirectory = Effect.fnUntraced(function* (target: string) {
      yield* realTrash(trashFor(target));
      const grave = yield* Effect.promise(() => discardTree(target));
      if (!grave) return false;
      // Nothing waits on this and nothing depends on it finishing: the path the caller wanted
      // is already free, and a delete that dies with the daemon is swept at the next start.
      yield* cleanDirectory(grave).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree discard could not delete", { directory: grave, cause }),
        ),
        Effect.forkIn(scope),
      );
      return true;
    });

    /**
     * Finish deletions a previous process did not.
     *
     * A discarded tree is unlinked in the background, so a daemon that stops before that
     * drains leaves it behind. Everything under a trash directory is already detached from
     * git and from any worktree path, so there is nothing to identify or spare.
     */
    const sweepDataTrash = Effect.promise(async () => {
      const fsp = await import("fs/promises");
      const root = pathSvc.join(Global.Path.data, "worktree");
      const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      let cleared = 0;
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        cleared += await sweepTrashDir(pathSvc.join(root, project.name, TRASH_DIRNAME));
      }
      return cleared;
    }).pipe(
      Effect.flatMap((cleared) =>
        cleared > 0 ? Effect.logInfo("worktree trash swept", { trees: cleared }) : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("worktree trash sweep failed", { cause })),
      Effect.forkIn(scope),
    );

    /**
     * Drain one worktree root's trash.
     *
     * The startup sweep walks the daemon's data directory, which is not where an isolated
     * worktree's trash ends up — that sits in the checkout, beside the trees it held.
     *
     * An adopt parks the previous host in this same trash while it still needs its index, and
     * a caller cannot tell when a forked sweep has listed the directory, so the sweep skips
     * what is parked rather than relying on the caller's ordering.
     */
    const drainTrashAt = Effect.fnUntraced(function* (root: string) {
      const trash = pathSvc.join(root, TRASH_DIRNAME);
      yield* realTrash(trash).pipe(
        Effect.flatMap((usable) =>
          usable ? Effect.promise(() => sweepUnparked(trash)) : Effect.succeed(0),
        ),
        Effect.flatMap((cleared) =>
          cleared > 0
            ? Effect.logInfo("worktree trash swept", { root, trees: cleared })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree trash sweep failed", { root, cause }),
        ),
      );
    });

    /** `drainTrashAt` in the background: the caller is a turn claiming a directory. */
    const sweepTrashAt = Effect.fnUntraced(function* (root: string) {
      yield* drainTrashAt(root).pipe(Effect.forkIn(scope));
    });

    /** Delete everything in `trash` an adopt has not parked there. Returns how many went. */
    async function sweepUnparked(trash: string) {
      const entries = await readdir(trash).catch(() => [] as string[]);
      let cleared = 0;
      for (const entry of entries) {
        if (parked.has(entry)) continue;
        const removed = await rm(pathSvc.join(trash, entry), { recursive: true, force: true }).then(
          () => true,
          () => false,
        );
        if (removed) cleared++;
      }
      return cleared;
    }

    /** True when anything is at `target`, a dangling symlink included. */
    const present = (target: string) =>
      Effect.promise(() =>
        lstat(target)
          .then(() => true)
          .catch(() => false),
      );

    /** Out of the way by rename when it can be, deleted in place when it cannot. */
    const discardEntry = Effect.fnUntraced(function* (target: string) {
      if (!(yield* present(target))) return;
      if (!(yield* discardDirectory(target))) yield* cleanDirectory(target);
    });

    /** Shared by both removal paths, which differ only in how the directory went. */
    const deleteBranch = Effect.fnUntraced(function* (
      entry: { readonly branch?: string },
      keepBranch: boolean | undefined,
      repo: string,
    ) {
      const branch = keepBranch ? undefined : entry.branch?.replace(/^refs\/heads\//, "");
      if (!branch) return;
      const deleted = yield* git(["branch", "-D", branch], { cwd: repo });
      if (deleted.code !== 0) {
        return yield* new RemoveFailedError({
          message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
        });
      }
    });

    const unregister = Effect.fnUntraced(function* (sandbox: string, directory: string) {
      const ctx = yield* InstanceState.context;
      yield* Effect.all(
        [
          project.removeSandbox(ctx.project.id, sandbox),
          projectDirectories.remove({
            projectID: ctx.project.id,
            directory: AbsolutePath.make(directory),
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree project registration cleanup failed", { directory, cause }),
        ),
      );
    });

    /**
     * Remove an isolated host repository after its worktree is gone.
     *
     * The host is adjacent to the worktree and holds a copy of the repository's objects, so use
     * the same rename-first path as the worktree itself. A failed rename is rare (Windows can
     * keep a handle open); fall back to a best-effort direct removal without making an already
     * successful worktree removal fail.
     */
    const discardHost = Effect.fnUntraced(function* (host: string) {
      if (yield* discardDirectory(host)) return;
      yield* cleanDirectory(host).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("isolated worktree host cleanup failed", { directory: host, cause }),
        ),
      );
    });

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context;
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" });
      }

      const directory = yield* canonical(input.directory);
      // An isolated worktree is registered in its own repository, so every command below
      // has to run there: the checkout does not know the worktree, the branch, or the
      // admin entry that has to be pruned.
      // Callers often only have the worktree path when a run settles. Isolated contestants
      // keep their registration in the adjacent bare repository, so infer that host before
      // falling back to the daemon's ordinary checkout repository.
      const inferredHost = hostRepoPath(directory);
      const repo =
        input.host ??
        ((yield* fs.exists(pathSvc.join(inferredHost, "HEAD")).pipe(Effect.orDie))
          ? inferredHost
          : ctx.worktree);
      const host = input.host ?? (repo === inferredHost ? inferredHost : undefined);

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree)))
        yield* store.disposeDirectory(input.directory);

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: repo });
      if (list.code !== 0) {
        return yield* new RemoveFailedError({
          message: list.stderr || list.text || "Failed to read git worktrees",
        });
      }

      const entries = parseWorktreeList(list.text);
      const entry = yield* locateWorktree(entries, directory);

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie);
        if (directoryExists) {
          yield* stopFsmonitor(directory);
          yield* cleanDirectory(directory);
        }
        yield* unregister(input.directory, directory);
        if (host && !input.keepBranch) yield* discardHost(host);
        return true;
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path);
      yield* stopFsmonitor(entry.path);

      // Renamed out of the way first, so `git worktree remove` never has to walk the tree.
      // With the directory already gone it has nothing to unlink and `prune` drops the admin
      // entry, which is the only part of the removal anything waits on.
      if (yield* discardDirectory(entry.path)) {
        yield* git(["worktree", "prune"], { cwd: repo });
        yield* unregister(input.directory, directory);
        yield* deleteBranch(entry, input.keepBranch, repo);
        if (host && !input.keepBranch) yield* discardHost(host);
        return true;
      }

      const removed = yield* git(["worktree", "remove", "--force", entry.path], {
        cwd: repo,
      });
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: repo });
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message:
              removed.stderr ||
              removed.text ||
              next.stderr ||
              next.text ||
              "Failed to remove git worktree",
          });
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory);
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          });
        }
      }

      yield* cleanDirectory(entry.path);
      yield* unregister(input.directory, directory);
      yield* deleteBranch(entry, input.keepBranch, repo);
      if (host && !input.keepBranch) yield* discardHost(host);

      return true;
    });

    /**
     * Resolve a worktree at an exact path and branch, clearing whatever a previous
     * turn left behind.
     *
     * `candidate()` cannot serve this: it rejects a name whose directory or branch
     * already exists and silently mutates the name instead, which is the opposite of
     * a stable per-contestant path. Reclaiming has to survive a crash mid-turn too —
     * git keeps the admin entry under `.git/worktrees/<name>` even when the directory
     * is gone, and `worktree add` refuses the path until that entry is pruned.
     */
    const reclaimWorktreeInfo = Effect.fn("Worktree.reclaimWorktreeInfo")(function* (
      input: ReclaimInput,
    ) {
      const ctx = yield* InstanceState.context;
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" });
      }

      const root = input.isolated
        ? isolatedRoot(ctx.worktree)
        : pathSvc.join(Global.Path.data, "worktree", ctx.project.id);
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
      const directory = pathSvc.join(root, input.name);
      const key = yield* canonical(directory);
      // Finished here rather than at daemon start: a repo-local trash is not somewhere the
      // startup sweep knows to look, and the turn that reclaims this directory is the one
      // that put the previous tree there.
      if (input.isolated) yield* sweepTrashAt(root);
      if (input.isolated && input.freshHost) {
        // The old host is about to go, and with it the registration the lookup below uses to
        // find and stop whatever still runs in the tree.
        yield* store.disposeDirectory(directory);
        yield* stopFsmonitor(directory);
      }
      // Built before the worktree is claimed, because every git command below has to run
      // against the repository that will hold the registration, not the user's checkout.
      const host = input.isolated
        ? yield* ensureHostRepo(directory, { fresh: input.freshHost, baseTree: input.baseTree })
        : undefined;
      const repo = host ?? ctx.worktree;

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: repo });
      if (list.code === 0) {
        const entry = yield* locateWorktree(parseWorktreeList(list.text), key);
        if (entry?.path) {
          yield* store.disposeDirectory(entry.path);
          yield* stopFsmonitor(entry.path);
          // Renamed out of the way rather than unlinked here: reclaiming is the first thing a
          // turn does, so the caller is a user waiting on a prompt, and the tree being cleared
          // is the previous turn's — a hundred thousand files they have no reason to wait for.
          if (!(yield* discardDirectory(entry.path))) {
            yield* git(["worktree", "remove", "--force", entry.path], { cwd: repo });
          }
        }
      }

      if (yield* fs.exists(directory).pipe(Effect.orDie)) {
        if (!(yield* discardDirectory(directory))) yield* cleanDirectory(directory);
      }
      yield* git(["worktree", "prune"], { cwd: repo });
      if (host) yield* git(["worktree", "prune"], { cwd: ctx.worktree });
      yield* unregister(directory, key);

      return {
        name: input.name,
        branch: input.branch,
        directory,
        ...(host ? { host } : {}),
      } satisfies Info;
    });

    /**
     * Adopt and retire move whole trees to the trash, so they accept only a path under the
     * checkout's isolated root: a caller that got a path wrong must not take the checkout.
     */
    const insideIsolatedRoot = Effect.fnUntraced(function* (target: string) {
      const ctx = yield* InstanceState.context;
      const root = isolatedRoot(ctx.worktree);
      const under = (base: string, candidate: string) =>
        candidate.startsWith(`${base}${pathSvc.sep}`);
      if (under(pathSvc.resolve(root), pathSvc.resolve(target))) return true;
      return under(yield* canonical(root), yield* canonical(target));
    });

    /** A directory itself, not a symlink to one. */
    const realDirectory = (target: string) =>
      Effect.promise(() =>
        lstat(target).then(
          (found) => found.isDirectory(),
          () => false,
        ),
      );

    /**
     * Whether `<host>/worktrees/<entry>/index` is a file reached through real directories only.
     * The index is moved by that path, and a symlink anywhere on it would move another
     * worktree's index instead: the previous contestant can write to its host.
     */
    const indexAt = Effect.fnUntraced(function* (host: string, entry: string) {
      const entries = pathSvc.join(host, "worktrees");
      for (const directory of [host, entries, pathSvc.join(entries, entry)]) {
        if (!(yield* realDirectory(directory))) return false;
      }
      return yield* Effect.promise(() =>
        lstat(pathSvc.join(entries, entry, "index")).then(
          (found) => found.isFile(),
          () => false,
        ),
      );
    });

    /**
     * The admin entry whose index an adopted worktree can keep, by name under the host's
     * `worktrees/`, or undefined when the index has to be rebuilt.
     *
     * The `.git` link is followed only to the entry this module wrote for the directory, in the
     * directory's own host: the previous contestant could rewrite the link to name anything,
     * and nothing outside that entry is taken. A split index is not kept, because most of its
     * entries live in a `sharedindex.*` file beside it that does not move with it.
     */
    const keepableIndex = Effect.fnUntraced(function* (directory: string) {
      const link = yield* fs
        .readFileString(pathSvc.join(directory, ".git"))
        .pipe(Effect.catch(() => Effect.succeed("")));
      if (!link.startsWith("gitdir: ")) return undefined;
      const target = link.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
      if (!target) return undefined;
      const resolve = (file: string) =>
        fs.realPath(file).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const host = hostRepoPath(directory);
      const admin = yield* resolve(pathSvc.resolve(directory, target));
      const real = yield* resolve(host);
      if (!admin || !real || pathSvc.dirname(admin) !== pathSvc.join(real, "worktrees")) {
        return undefined;
      }
      const entry = pathSvc.basename(admin);
      if (!(yield* indexAt(host, entry))) return undefined;
      const names = yield* Effect.promise(() => readdir(admin).catch(() => [] as string[]));
      if (names.some((name) => name.startsWith("sharedindex."))) return undefined;
      return entry;
    });

    /**
     * Move a worktree's host into its trash, where a sweep will not touch it until
     * `unpark`. Named before the rename, so no sweep can list it unprotected.
     */
    const park = Effect.fnUntraced(function* (host: string) {
      const trash = trashFor(host);
      yield* realTrash(trash);
      const name = `${pathSvc.basename(host)}-${randomUUID()}`;
      parked.add(name);
      const grave = pathSvc.join(trash, name);
      const moved = yield* Effect.promise(() =>
        mkdir(trash, { recursive: true })
          .then(() => rename(host, grave))
          .then(
            () => true,
            () => false,
          ),
      );
      if (moved) return grave;
      parked.delete(name);
      return undefined;
    });

    const unpark = (grave: string | undefined) =>
      Effect.sync(() => {
        if (grave) parked.delete(pathSvc.basename(grave));
      });

    /** Exit 1 is an unset key, which is the files backend. */
    const usesReftable = Effect.fnUntraced(function* (repo: string) {
      const storage = yield* git(["config", "--get", "extensions.refStorage"], { cwd: repo });
      return storage.code === 0 && storage.text.trim().toLowerCase() === "reftable";
    });

    /**
     * Put a worktree's previous host back after an adopt failed before the tree moved, so the
     * worktree is left as the caller had it. Best effort: the caller is already failing.
     */
    const restoreHost = Effect.fnUntraced(
      function* (grave: string | undefined, host: string, created: string) {
        yield* discardEntry(created);
        yield* discardEntry(`${created}.partial`);
        if (grave) yield* fs.rename(grave, host);
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree adopt could not restore the previous host", { cause }),
      ),
    );

    /**
     * Turn a worktree a previous contestant used into a fresh isolated worktree at `to`,
     * leaving its files where they are.
     *
     * Everything git keeps is replaced. The host is a new copy of the checkout's git directory,
     * made exactly as for a created worktree, and the admin entry is written new; what the
     * previous contestant left in its host (branches, stash, reflogs, config, hooks, other
     * worktrees, locks, objects) goes to the trash with the old host. Only the files and the
     * index come along, and only by rename, so every file keeps its inode and ctime and the kept
     * index still matches the tree by stat: git does not have to read the files again.
     *
     * The caller owns the content: the files and the index are the previous contestant's until
     * it resets them to the turn's base and clears any index flags. The kept index can name
     * blobs that only the old host had, which a reset replaces without reading.
     *
     * A failure before the tree moves puts the old host back. A failure after leaves a
     * worktree the caller has to retire.
     */
    const adopt = Effect.fn("Worktree.adopt")(
      function* (input: AdoptInput) {
        const ctx = yield* InstanceState.context;
        if (ctx.project.vcs !== "git") {
          return yield* new NotGitError({
            message: "Worktrees are only supported for git projects",
          });
        }
        const started = performance.now();
        const from = pathSvc.resolve(input.from);
        const to = pathSvc.resolve(input.to);
        const moving = from !== to;
        const failed = (message: string) =>
          new CreateFailedError({ message: `Failed to adopt ${from} at ${to}: ${message}` });
        const attempt = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.mapError((error) => failed(errorMessage(error))));

        if (!(yield* insideIsolatedRoot(from)) || !(yield* insideIsolatedRoot(to))) {
          return yield* failed("both paths must be under the checkout's isolated root");
        }
        // Compared resolved as well: APFS folds case, so two spellings can be one directory,
        // and clearing `to` would then clear `from`.
        const fromKey = yield* canonical(from);
        const toKey = yield* canonical(to);
        const within = (outer: string, inner: string) => inner.startsWith(`${outer}${pathSvc.sep}`);
        if (
          moving &&
          (fromKey === toKey ||
            within(from, to) ||
            within(to, from) ||
            within(fromKey, toKey) ||
            within(toKey, fromKey))
        ) {
          return yield* failed("the paths overlap");
        }
        const kind = yield* Effect.promise(() => lstat(from).catch(() => undefined));
        if (!kind?.isDirectory()) return yield* failed("not a directory");

        const entry = yield* keepableIndex(from);
        // `from` stops being a worktree here whatever happens next, and a caller retiring a
        // failed adopt knows only `to`.
        yield* store.disposeDirectory(from);
        if (moving) yield* store.disposeDirectory(to);
        yield* stopFsmonitor(from);
        yield* unregister(from, fromKey);
        if (moving) {
          yield* discardEntry(to);
          yield* discardEntry(hostRepoPath(to));
        }

        // Aside, not deleted: the index still has to come out of it, and a failure before the
        // tree moves puts it back.
        const oldHost = hostRepoPath(from);
        const grave = (yield* present(oldHost)) ? yield* park(oldHost) : undefined;
        if (!grave && (yield* present(oldHost))) {
          return yield* failed(`could not move ${oldHost} aside`);
        }

        const host = hostRepoPath(to);
        const admin = pathSvc.join(host, "worktrees", pathSvc.basename(to));
        const hostStarted = performance.now();
        const { commit, hostCopyMs } = yield* Effect.gen(function* () {
          yield* ensureHostRepo(to, { fresh: true, baseTree: input.baseTree });
          const hostCopyMs = Math.round(performance.now() - hostStarted);
          const resolved = yield* git(
            ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.head}^{commit}`],
            { cwd: host },
          );
          if (resolved.code !== 0)
            return yield* failed(`${input.head} is not a commit in the checkout`);
          const commit = resolved.text.trim();
          if (input.branch) {
            const ref = `refs/heads/${input.branch}`;
            const known = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: host });
            if (known.code !== 0) {
              const created = yield* git(["update-ref", ref, commit], { cwd: host });
              if (created.code !== 0)
                return yield* failed(created.stderr || `could not create ${ref}`);
            }
          }
          // What `git worktree add` writes, minus the index, which is moved in or rebuilt below.
          yield* attempt(fs.makeDirectory(admin, { recursive: true }));
          yield* attempt(
            fs.writeFileString(pathSvc.join(admin, "gitdir"), `${pathSvc.join(to, ".git")}\n`),
          );
          yield* attempt(fs.writeFileString(pathSvc.join(admin, "commondir"), "../..\n"));
          if (yield* usesReftable(host)) {
            // Reftable keeps a worktree's HEAD in the entry's own tables and ignores a HEAD file,
            // so the entry gets the placeholders `git worktree add` writes and git sets HEAD.
            yield* attempt(fs.makeDirectory(pathSvc.join(admin, "reftable"), { recursive: true }));
            yield* attempt(fs.writeFileString(pathSvc.join(admin, "reftable", "tables.list"), ""));
            yield* attempt(fs.makeDirectory(pathSvc.join(admin, "refs"), { recursive: true }));
            yield* attempt(
              fs.writeFileString(
                pathSvc.join(admin, "refs", "heads"),
                "this repository uses the reftable format\n",
              ),
            );
            yield* attempt(
              fs.writeFileString(pathSvc.join(admin, "HEAD"), "ref: refs/heads/.invalid\n"),
            );
            // No reflog, as for the HEAD file the files backend gets.
            const pointed = yield* git(
              [
                "-c",
                "core.logAllRefUpdates=false",
                `--git-dir=${admin}`,
                ...(input.branch
                  ? ["symbolic-ref", "HEAD", `refs/heads/${input.branch}`]
                  : ["update-ref", "--no-deref", "HEAD", commit]),
              ],
              { cwd: host },
            );
            if (pointed.code !== 0) return yield* failed(pointed.stderr || "could not set HEAD");
          } else {
            yield* attempt(
              fs.writeFileString(
                pathSvc.join(admin, "HEAD"),
                input.branch ? `ref: refs/heads/${input.branch}\n` : `${commit}\n`,
              ),
            );
          }
          if (moving) {
            yield* attempt(fs.makeDirectory(pathSvc.dirname(to), { recursive: true }));
            yield* attempt(fs.rename(from, to));
          }
          return { commit, hostCopyMs };
        }).pipe(
          Effect.onError(() =>
            restoreHost(grave, oldHost, host).pipe(Effect.ensuring(unpark(grave))),
          ),
        );

        const indexKept = yield* Effect.gen(function* () {
          // Checked again at the moved host: the index is renamed through these directories.
          const moved =
            entry !== undefined &&
            grave !== undefined &&
            (yield* indexAt(grave, entry)) &&
            (yield* fs
              .rename(
                pathSvc.join(grave, "worktrees", entry, "index"),
                pathSvc.join(admin, "index"),
              )
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              ));

          const link = pathSvc.join(to, ".git");
          // A contestant can leave a repository of its own where the link belongs.
          if ((yield* Effect.promise(() => lstat(link).catch(() => undefined)))?.isDirectory()) {
            yield* cleanDirectory(link);
          }
          const temporary = `${link}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
          yield* attempt(fs.writeFileString(temporary, `gitdir: ${admin}\n`));
          yield* attempt(fs.rename(temporary, link));

          // Reading the index is the check that git can use it: it stops on a bad signature,
          // version or extension and on a truncated file. It does not verify the checksum
          // outside `fsck`; an entry damaged inside differs from the base, and the caller's
          // reset replaces it. The rewrite drops the untracked cache, which names the directory
          // it was built in and would make every `git status` here warn.
          const probe = ["-c", "core.untrackedCache=false", "update-index", "--no-untracked-cache"];
          const kept = moved && (yield* git(probe, { cwd: to })).code === 0;
          if (!kept) {
            yield* Effect.promise(() => rm(pathSvc.join(admin, "index"), { force: true }));
            const built = yield* git(["read-tree", commit], { cwd: to });
            if (built.code !== 0) return yield* failed(built.stderr || "could not build the index");
          }

          // HEAD is checked on its own: git reads it from where the ref backend keeps it, which
          // for reftable is not the file.
          const resolved = yield* git(
            [
              "rev-parse",
              "--path-format=absolute",
              "--absolute-git-dir",
              "--git-common-dir",
              "HEAD^{commit}",
              "--symbolic-full-name",
              "HEAD",
              "--",
            ],
            { cwd: to },
          );
          const [gitDir, commonDir, headCommit, headName] = resolved.text.trim().split("\n");
          if (resolved.code !== 0 || !gitDir || !commonDir || !headCommit || !headName) {
            return yield* failed(resolved.stderr || "the worktree does not resolve");
          }
          if (
            (yield* canonical(gitDir)) !== (yield* canonical(admin)) ||
            (yield* canonical(commonDir)) !== (yield* canonical(host))
          ) {
            return yield* failed(`the worktree resolves to ${gitDir} in ${commonDir}`);
          }
          if (
            headName !== (input.branch ? `refs/heads/${input.branch}` : "HEAD") ||
            (!input.branch && headCommit !== commit)
          ) {
            return yield* failed(`HEAD is ${headName} at ${headCommit}`);
          }
          const listed = yield* git(["worktree", "list", "--porcelain"], { cwd: host });
          const registered = parseWorktreeList(listed.text).map((item) => item.path ?? "");
          if (
            listed.code !== 0 ||
            registered.length !== 2 ||
            (yield* canonical(registered[0]!)) !== (yield* canonical(host)) ||
            (yield* canonical(registered[1]!)) !== (yield* canonical(to))
          ) {
            return yield* failed(listed.stderr || `the new host lists ${registered.join(", ")}`);
          }
          return kept;
        }).pipe(
          // Nothing needs the old host once the tree has moved, whether or not the rest worked.
          Effect.ensuring(
            grave
              ? unpark(grave).pipe(
                  Effect.andThen(
                    cleanDirectory(grave).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("worktree discard could not delete", {
                          directory: grave,
                          cause,
                        }),
                      ),
                      Effect.forkIn(scope),
                    ),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
        );

        if (moving) yield* unregister(to, yield* canonical(to));
        yield* project.addSandbox(ctx.project.id, to).pipe(Effect.catch(() => Effect.void));

        yield* Effect.logInfo("worktree adopted", {
          from,
          to,
          indexKept,
          hostCopyMs,
          durationMs: Math.round(performance.now() - started),
        });
        return {
          name: input.name,
          ...(input.branch ? { branch: input.branch } : {}),
          directory: to,
          host,
          indexKept,
        } satisfies Adopted;
      },
      Effect.tapError((error) => Effect.logWarning("worktree adopt failed", { error })),
      // Half an adopt is two hosts and a tree between them; once started it runs to the end,
      // where every outcome is a state the caller can act on.
      Effect.uninterruptible,
    );

    /**
     * Remove a worktree and its host without asking git about either.
     *
     * For a worktree nothing vouches for: a crash leftover, a tree whose `.git` link a
     * contestant broke, a host without its tree. Both go to the trash by rename and are
     * deleted in the background; only what cannot be renamed is deleted in place.
     */
    const retire = Effect.fn("Worktree.retire")(function* (directory: string) {
      const target = pathSvc.resolve(directory);
      if (!(yield* insideIsolatedRoot(target))) {
        return yield* new RemoveFailedError({
          message: `Refusing to retire ${target}: not under the checkout's isolated root`,
        });
      }
      const key = yield* canonical(target);
      yield* store.disposeDirectory(directory);
      yield* stopFsmonitor(target);
      const host = hostRepoPath(target);
      yield* discardEntry(target);
      yield* discardEntry(host);
      yield* discardEntry(`${host}.partial`);
      yield* unregister(directory, key);
    });

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts);
      if (result.code !== 0) return yield* error(result);
      return result;
    });

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] =
          process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]];
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], {
            cwd: directory,
            extendEnv: true,
            stdin: "ignore",
          }),
        );
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") };
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    );

    const runStartScript = Effect.fnUntraced(function* (
      directory: string,
      cmd: string,
      kind: string,
    ) {
      const text = cmd.trim();
      if (!text) return true;
      const result = yield* runStartCommand(directory, text);
      if (result.code === 0) return true;
      yield* Effect.logError("worktree start command failed", {
        kind,
        directory,
        message: result.stderr,
      });
      return false;
    });

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie);
      const project = row ? Project.fromRow(row) : undefined;
      const startup = project?.commands?.start?.trim() ?? "";
      const ok = yield* runStartScript(directory, startup, "project");
      if (!ok) return false;
      yield* runStartScript(directory, input.extra ?? "", "worktree");
      return true;
    });

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root);
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry));
            if (target === base) return;
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return;
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore);
          }),
        { concurrency: "unbounded" },
      );
    });

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root });
      if (first.code === 0) return first;

      const entries = failedRemoves(first.stderr, first.text);
      if (!entries.length) return first;

      yield* prune(root, entries);
      return yield* git(["clean", "-ffdx"], { cwd: root });
    });

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context;
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" });
      }

      const directory = yield* canonical(input.directory);
      const primary = yield* canonical(ctx.worktree);
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" });
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree });
      if (list.code !== 0) {
        return yield* new ResetFailedError({
          message: list.stderr || list.text || "Failed to read git worktrees",
        });
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory);
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" });
      }

      const worktreePath = entry.path;

      const base = yield* gitSvc.defaultBranch(ctx.worktree);
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" });
      }

      const sep = base.ref.indexOf("/");
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep);
        const branch = base.ref.slice(sep + 1);
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) =>
            new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        );
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) =>
          new ResetFailedError({
            message: r.stderr || r.text || "Failed to reset worktree to target",
          }),
      );

      const cleanResult = yield* sweep(worktreePath);
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        });
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) =>
          new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      );

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) =>
          new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      );

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) =>
          new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      );

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], {
        cwd: worktreePath,
      });
      if (status.code !== 0) {
        return yield* new ResetFailedError({
          message: status.stderr || status.text || "Failed to read git status",
        });
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({
          message: `Worktree reset left local changes:\n${status.text.trim()}`,
        });
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      );

      return true;
    });

    yield* sweepDataTrash;

    return Service.of({
      makeWorktreeInfo,
      reclaimWorktreeInfo,
      adopt,
      retire,
      sweepTrash: sweepTrashAt,
      drainTrash: drainTrashAt,
      createFromInfo,
      createFromInfoAt,
      attachAt,
      repointAt,
      activate,
      create,
      list,
      remove,
      reset,
    });
  }),
);

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    path,
    AppProcess.node,
    Git.node,
    Project.node,
    ProjectV2.node,
    ProjectDirectories.node,
    InstanceStore.node,
    Database.node,
  ],
});

export * as Worktree from ".";
