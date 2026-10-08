import { afterEach, describe, expect } from "bun:test";
import * as fs from "fs/promises";
import path from "path";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { FSUtil } from "@opencode-ai/core/fs-util";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { GlobalBus, type GlobalEvent } from "../../src/bus/global";
import { Git } from "../../src/git";
import { InstanceBootstrap } from "../../src/project/bootstrap";
import { InstanceStore } from "../../src/project/instance-store";
import { Project } from "../../src/project/project";
import { Worktree } from "../../src/worktree";
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture";
import { testEffect } from "../lib/effect";

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node, Project.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
);
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip;

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase();
}

const exists = (target: string) =>
  Effect.promise(() => fs.stat(target).then(() => true, () => false));

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>();
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return;
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties));
  };

  GlobalBus.on("event", on);
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)));

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  );
});

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service;
    const ok = yield* svc.remove({ directory });
    if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${directory}`));
  });

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: {
    info: Worktree.Info;
    ready: { name: string; branch?: string };
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service;
      const ready = yield* waitReady().pipe(Effect.forkScoped);
      const info = yield* svc.create(input);
      const props = yield* Fiber.join(ready);
      return { info, ready: props };
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  );

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service;
  const result = yield* service.run(args, { cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.text();
});

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service;
  return yield* service.run(args, { cwd });
});

describe("Worktree", () => {
  afterEach(() => disposeAllInstances());

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service;
          const info = yield* svc.makeWorktreeInfo();

          expect(info.name).toBeDefined();
          expect(typeof info.name).toBe("string");
          expect(info.branch).toBe(`opencode/${info.name}`);
          expect(info.directory).toContain(info.name);
        }),
      { git: true },
    );

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service;
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" });

          expect(info.name).toBe("my-feature");
          expect(info.branch).toBe("opencode/my-feature");
        }),
      { git: true },
    );

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service;
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" });

          expect(info.name).toBe("my-feature-branch");
        }),
      { git: true },
    );

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          yield* git(test.directory, ["branch", "opencode/my-feature"]);

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true });

          expect(info.name).toBe("my-feature");
          expect(info.branch).toBeUndefined();
        }),
      { git: true },
    );

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service;
        const exit = yield* Effect.exit(svc.makeWorktreeInfo());

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(Worktree.NotGitError);
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError");
        }
      }),
    );

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true });
          const ready = yield* waitReady().pipe(Effect.forkScoped);
          yield* svc.createFromInfo(info);

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"]);
          const normalizedList = normalize(list);
          const normalizedDir = normalize(info.directory);
          expect(normalizedList).toContain(normalizedDir);

          const branch = yield* gitResult(info.directory, [
            "symbolic-ref",
            "-q",
            "--short",
            "HEAD",
          ]);
          expect(branch.exitCode).not.toBe(0);

          const props = yield* Fiber.join(ready);
          expect(props.name).toBe(info.name);
          expect(props.branch).toBeUndefined();

          yield* svc.remove({ directory: info.directory });
        }),
      { git: true },
    );

    wintest(
      "creates a detached worktree at an explicit frozen ref",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* git(test.directory, [
            "commit",
            "--allow-empty",
            "-m",
            "advance canonical checkout",
          ]);
          const canonical = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          expect(canonical).not.toBe(base);

          const info = yield* svc.makeWorktreeInfo({ name: "frozen-ref-test", detached: true });
          const ready = yield* waitReady().pipe(Effect.forkScoped);
          yield* svc.createFromInfoAt(info, base);
          yield* Fiber.join(ready);

          const head = (yield* git(info.directory, ["rev-parse", "HEAD"])).trim();
          expect(head).toBe(base);
          yield* svc.remove({ directory: info.directory });
        }),
      { git: true },
    );
  });

  describe("create + remove lifecycle", () => {
    wintest(
      "reclaims a registered worktree without invoking git removal",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const name = `reclaim-remove-failure-${Date.now().toString(36)}`;
          const branch = `opencode/${name}`;
          const info = yield* svc.reclaimWorktreeInfo({ name, branch });
          yield* git(test.directory, [
            "worktree",
            "add",
            "--no-checkout",
            "-b",
            branch,
            info.directory,
          ]);
          yield* git(info.directory, ["reset", "--hard"]);

          const sentinel = path.join(info.directory, "reclaim-sentinel.txt");
          yield* Effect.promise(() => Bun.write(sentinel, "keep\n"));
          const realGit = Bun.which("git");
          if (!realGit) return yield* Effect.fail(new Error("git executable not found"));
          const bin = path.join(test.directory, "reclaim-bin");
          const shim = path.join(bin, "git");
          yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }));
          yield* Effect.promise(() =>
            Bun.write(
              shim,
              [
                "#!/bin/bash",
                `REAL_GIT=${JSON.stringify(realGit)}`,
                'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
                '  echo "fatal: simulated registered worktree removal failure" >&2',
                "  exit 1",
                "fi",
                'exec "$REAL_GIT" "$@"',
              ].join("\n"),
            ),
          );
          yield* Effect.promise(() => fs.chmod(shim, 0o755));

          const previousPath = process.env.PATH ?? "";
          process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
          const exit = yield* Effect.exit(svc.reclaimWorktreeInfo({ name, branch })).pipe(
            Effect.ensuring(Effect.sync(() => (process.env.PATH = previousPath))),
          );

          expect(Exit.isSuccess(exit)).toBe(true);
          expect(yield* Effect.promise(() => Bun.file(sentinel).exists())).toBe(false);
          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"]);
          expect(normalize(list)).not.toContain(normalize(info.directory));
          expect(yield* exists(info.directory)).toBe(false);
        }),
      { git: true },
    );

    wintest(
      "removes the isolated host repository when a contestant worktree is removed",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const name = `isolated-remove-${Date.now().toString(36)}`;
          const info = yield* svc.reclaimWorktreeInfo({ name, branch: "main", isolated: true });
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, base, { reset: true });

          expect(info.host).toBe(Worktree.hostRepoPath(info.directory));
          expect(yield* exists(info.host!)).toBe(true);
          yield* svc.remove({ directory: info.directory });

          expect(yield* exists(info.directory)).toBe(false);
          expect(yield* exists(info.host!)).toBe(false);
        }),
      { git: true },
    );

    wintest(
      "carries repository-local excludes into an isolated contestant repository",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const exclude = (yield* git(test.directory, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
          ])).trim();
          yield* Effect.promise(() => fs.appendFile(exclude, "\n.contestant-cache\n"));
          const info = yield* svc.reclaimWorktreeInfo({
            name: `isolated-excludes-${Date.now().toString(36)}`,
            branch: "main",
            isolated: true,
          });
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, base, { reset: true });
          yield* Effect.promise(() => fs.writeFile(path.join(info.directory, ".contestant-cache"), "cache\n"));

          expect(
            (yield* gitResult(info.directory, ["check-ignore", "--quiet", ".contestant-cache"]))
              .exitCode,
          ).toBe(0);
          expect(yield* git(info.directory, ["status", "--porcelain"])).toBe("");
          yield* svc.remove({ directory: info.directory });
        }),
      { git: true },
    );

    wintest(
      "keeps dependency folders out of an isolated contestant's changes",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const baseTree = (yield* git(test.directory, ["rev-parse", "HEAD^{tree}"])).trim();
          const info = yield* svc.reclaimWorktreeInfo({
            name: `dependency-excludes-${Date.now().toString(36)}`,
            branch: "main",
            isolated: true,
            baseTree,
          });
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, base, { reset: true });
          const installed = [
            "qa/node_modules/pkg/index.js",
            "tools/.venv/lib/site.py",
            "src/__pycache__/app.pyc",
          ];
          for (const file of installed) {
            yield* Effect.promise(() =>
              fs.mkdir(path.dirname(path.join(info.directory, file)), { recursive: true }),
            );
            yield* Effect.promise(() => fs.writeFile(path.join(info.directory, file), "installed\n"));
          }
          expect(yield* git(info.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
          // The patterns are the contestant's; the checkout's own excludes stay the developer's.
          const exclude = (yield* git(test.directory, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
          ])).trim();
          expect(yield* Effect.promise(() => fs.readFile(exclude, "utf8"))).not.toContain("node_modules/");
          yield* svc.remove({ directory: info.directory });
        }),
      { git: true },
    );

    // The contestant is checked against the frozen base, which holds the checkout's tracked files
    // and the untracked ones its rules do not ignore. An exclude that hid either would fail that
    // check, or drop the new files of a package installed into a tracked `node_modules`.
    wintest(
      "leaves a dependency folder the frozen base holds visible to the contestant",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const write = (root: string, file: string) =>
            Effect.promise(async () => {
              await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
              await fs.writeFile(path.join(root, file), "content\n");
            });
          yield* write(test.directory, "vendor/node_modules/pkg/index.js");
          yield* git(test.directory, ["add", "-A"]);
          yield* git(test.directory, ["commit", "-qm", "vendored"]);
          // Untracked and not ignored: a project that ignores only `*.pyc`, say.
          yield* write(test.directory, "src/__pycache__/app.pyc");
          // The frozen working tree, as `snapshotBase` takes it.
          const index = path.join(test.directory, ".git", "base-index");
          yield* Effect.promise(() => fs.copyFile(path.join(test.directory, ".git", "index"), index));
          const service = yield* Git.Service;
          yield* service.run(["add", "-A"], { cwd: test.directory, env: { GIT_INDEX_FILE: index } });
          const baseTree = (yield* service.run(["write-tree"], {
            cwd: test.directory,
            env: { GIT_INDEX_FILE: index },
          })).text().trim();
          yield* Effect.promise(() => fs.rm(index));

          const info = yield* svc.reclaimWorktreeInfo({
            name: `dependency-held-${Date.now().toString(36)}`,
            branch: "main",
            isolated: true,
            baseTree,
          });
          const head = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, head, { reset: true });
          yield* git(info.directory, ["reset", "-q", "--hard", head]);
          // What the sync restores from the base, then what the contestant installs.
          yield* write(info.directory, "src/__pycache__/app.pyc");
          yield* write(info.directory, "vendor/node_modules/new/index.js");
          yield* write(info.directory, "tools/.venv/lib/site.py");
          expect(
            (yield* git(info.directory, ["status", "--porcelain", "--untracked-files=all"]))
              .trim()
              .split("\n")
              .sort(),
          ).toEqual(["?? src/__pycache__/app.pyc", "?? vendor/node_modules/new/index.js"]);
          yield* svc.remove({ directory: info.directory });
        }),
      { git: true },
    );

    // Both contestant sides claim at once and each makes sure the checkout excludes the local
    // state. The race this guards is timing-dependent, so this checks the outcome, not the race.
    wintest(
      "keeps the checkout's own excludes when both sides claim at once",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const exclude = (yield* git(test.directory, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
          ])).trim();
          yield* Effect.promise(() => fs.writeFile(exclude, "# mine\n.user-cache\n"));
          const suffix = Date.now().toString(36);
          const [a, b] = yield* Effect.all(
            [
              svc.reclaimWorktreeInfo({ name: `concurrent-a-${suffix}`, branch: "main", isolated: true }),
              svc.reclaimWorktreeInfo({ name: `concurrent-b-${suffix}`, branch: "main", isolated: true }),
            ],
            { concurrency: 2 },
          );

          const lines = (yield* Effect.promise(() => fs.readFile(exclude, "utf8"))).split("\n");
          expect(lines.filter((line) => line === ".user-cache")).toHaveLength(1);
          expect(lines.filter((line) => line === "/.agent-duel/")).toHaveLength(1);
          yield* svc.remove({ directory: a.directory });
          yield* svc.remove({ directory: b.directory });
        }),
      { git: true },
    );

    wintest(
      "keeps an isolated host repository for a retained branch and cleans it when unregistered",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const name = `isolated-keep-${Date.now().toString(36)}`;
          const info = yield* svc.reclaimWorktreeInfo({ name, branch: "main", isolated: true });
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, base, { reset: true });

          yield* svc.remove({ directory: info.directory, keepBranch: true });
          expect(yield* exists(info.host!)).toBe(true);

          // The worktree registration is gone, but the adjacent host remains. A later cleanup
          // with no worktree entry must still identify and discard that host repository.
          yield* svc.remove({ directory: info.directory });
          expect(yield* exists(info.host!)).toBe(false);
        }),
      { git: true },
    );

    wintest(
      "removes an isolated host repository when its worktree path is stale",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const name = `isolated-stale-${Date.now().toString(36)}`;
          const info = yield* svc.reclaimWorktreeInfo({ name, branch: "main", isolated: true });
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* svc.attachAt(info, base, { reset: true });

          // Leave the host's git worktree registration behind while the served directory goes
          // missing, which is the state a crashed process can leave for the next cleanup.
          yield* Effect.promise(() => fs.rm(info.directory, { recursive: true, force: true }));
          expect(yield* exists(info.host!)).toBe(true);

          yield* svc.remove({ directory: info.directory });
          expect(yield* exists(info.host!)).toBe(false);
        }),
      { git: true },
    );

    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined();
            expect(info.branch ?? "").toStartWith("opencode/");
            expect(info.directory).toBeDefined();
          }),
        ),
      { git: true },
    );

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service;

            expect(info.name).toBeDefined();
            expect(info.branch ?? "").toStartWith("opencode/");

            expect(ready.name).toBe(info.name);
            expect(ready.branch).toBe(info.branch);

            const list = yield* svc.list();
            expect(list).toContainEqual(
              expect.objectContaining({ name: info.name, branch: info.branch }),
            );
          }),
        ),
      { git: true },
    );

    wintest(
      "fires Event.Ready only after the project setup command completes",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const fs = yield* FSUtil.Service;
          const project = yield* Project.Service;
          const current = yield* project.fromDirectory(test.directory);
          yield* project.update({
            projectID: current.project.id,
            commands: {
              start: "bun -e \"await Bun.sleep(300); await Bun.write('.setup-complete', 'ready')\"",
            },
          });

          yield* withCreatedWorktree(undefined, ({ info }) =>
            Effect.gen(function* () {
              expect(yield* fs.exists(path.join(info.directory, ".setup-complete"))).toBe(true);
            }),
          );
        }),
      { git: true },
    );

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance;
            const svc = yield* Worktree.Service;
            const list = yield* svc.list().pipe(provideInstance(info.directory));

            expect(list.map((item) => item.name)).toContain(info.name);
            expect(list.map((item) => item.name)).not.toContain(
              path.basename(test.directory).toLowerCase(),
            );
          }),
        ),
      { git: true },
    );

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace");
            expect(info.branch).toBe("opencode/test-workspace");
          }),
        ),
      { git: true },
    );

    it.instance(
      "creates a worktree from an existing branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const base = (yield* git(test.directory, ["rev-parse", "HEAD"])).trim();
          yield* git(test.directory, ["branch", "selected-base", base]);
          yield* git(test.directory, ["commit", "--allow-empty", "-m", "advance current branch"]);

          yield* withCreatedWorktree({ branch: "selected-base" }, ({ info }) =>
            Effect.gen(function* () {
              expect((yield* git(info.directory, ["rev-parse", "HEAD"])).trim()).toBe(base);
            }),
          );
        }),
      { git: true },
    );
  });

  describe("createFromInfo", () => {
    wintest(
      "creates git worktree and boots asynchronously",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" });
          const ready = yield* waitReady().pipe(Effect.forkScoped);
          yield* svc.createFromInfo(info);

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"]);
          const normalizedList = list.replace(/\\/g, "/");
          const normalizedDir = info.directory.replace(/\\/g, "/");
          expect(normalizedList).toContain(normalizedDir);

          yield* Fiber.join(ready);
          yield* removeCreatedWorktree(info.directory);
        }),
      { git: true },
    );
  });

  describe("list", () => {
    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const fs = yield* FSUtil.Service;
          const svc = yield* Worktree.Service;
          const parent = path.join(
            path.dirname(test.directory),
            `${path.basename(test.directory)}-parent`,
          );
          const target = path.join(parent, path.basename(test.directory));
          const branch = `same-basename-list-${Date.now()}`;

          yield* fs.ensureDir(parent);
          yield* git(test.directory, ["worktree", "add", "-b", branch, target]);

          const list = yield* svc.list();
          const directory = yield* fs
            .realPath(target)
            .pipe(Effect.catch(() => Effect.succeed(target)));

          expect(
            list.map((item) => ({ ...item, directory: normalize(item.directory) })),
          ).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          });

          yield* svc.remove({ directory: target });
        }),
      { git: true },
    );
  });

  describe("remove edge cases", () => {
    it.instance(
      "remove non-existent directory succeeds silently",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance;
          const svc = yield* Worktree.Service;
          const ok = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") });
          expect(ok).toBe(true);
        }),
      { git: true },
    );

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance;
        const svc = yield* Worktree.Service;
        const exit = yield* Effect.exit(
          svc.remove({ directory: path.join(test.directory, "fake") }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(Worktree.NotGitError);
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError");
        }
      }),
    );
  });
});
