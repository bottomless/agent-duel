import { $ } from "bun"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import {
  applyIgnoredResync,
  createIgnoredContentSnapshot,
  listIgnoredRoots,
  planIgnoredResync,
} from "@/arena/copy-snapshot"
import { snapshotBase, syncContestantState, verifyContestantState } from "@/arena/git"
import { Git } from "@/git"

test("snapshots omit ignored files' numbered copies and preserve tracked lookalikes for both sides", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-sync-snapshot-test-"))
  try {
    const canonical = join(root, "canonical")
    await mkdir(join(canonical, "app"), { recursive: true })
    await $`git init -q ${canonical}`.quiet()
    await $`git config core.hooksPath /dev/null`.cwd(canonical).quiet()
    await $`git config core.excludesFile /dev/null`.cwd(canonical).quiet()
    await $`git config core.fsmonitor false`.cwd(canonical).quiet()
    await writeFile(join(canonical, ".gitignore"), ".env\nconfig.json\ncredentials\nsettings.json\n")
    const tracked = [".env 9.save", "report.pdf"]
    for (const name of tracked) await writeFile(join(canonical, name), "fixture\n")
    await $`git add .`.cwd(canonical).quiet()
    await $`git -c user.name=Fixture -c user.email=fixture@localhost -c commit.gpgsign=false commit -qm fixture`
      .cwd(canonical)
      .quiet()

    // No rule ignores *.save or the numbered copies themselves.
    const originals = [".env", "config.json", "credentials", "app/settings.json", "app/.env"]
    const copies = [
      ".env 2",
      ".env 2.save",
      "config 2.json",
      "credentials 2.save",
      "app/settings 2.json",
      "app/.env 2.save",
    ]
    const publicFiles = ["report 2.pdf", "notes 2.txt", ".env 3", ".env 3.save", ".env.sb-fixture"]
    for (const name of [...originals, ...copies]) await writeFile(join(canonical, name), "fixture\n")
    for (const name of publicFiles) await writeFile(join(canonical, name), "public\n")
    // An ambiguous name must still be excluded when its extension-preserving original differs.
    await writeFile(join(canonical, ".env.save"), "other\n")
    // An identical public original must not hide the other, ignored original either.
    await writeFile(join(canonical, "credentials.save"), "fixture\n")

    const base = await Effect.runPromise(
      snapshotBase({ canonical }).pipe(Effect.provide(LayerNode.compile(Git.node))),
    )
    const expected = [".gitignore", ".env.save", "credentials.save", ...tracked, ...publicFiles].sort()
    const listed = await $`git ls-tree -r -z --name-only ${base.baseTree}`.cwd(canonical).quiet().text()
    expect(listed.split("\0").filter(Boolean).sort()).toEqual(expected)
    for (const side of ["a", "b"]) {
      const worktree = join(root, side)
      await $`git worktree add --detach ${worktree} ${base.baseCommit}`.cwd(canonical).quiet()
      for (const name of copies) expect(await Bun.file(join(worktree, name)).exists()).toBe(false)
      for (const name of tracked) expect(await readFile(join(worktree, name), "utf8")).toBe("fixture\n")
      for (const name of publicFiles) expect(await readFile(join(worktree, name), "utf8")).toBe("public\n")
    }
    for (const name of copies) expect(await readFile(join(canonical, name), "utf8")).toBe("fixture\n")
    expect((await $`git diff --cached --name-only`.cwd(canonical).quiet().text()).trim()).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("prepares both contestants when filtering leaves only an ignored file in a nested directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-sync-preparation-test-"))
  try {
    const canonical = join(root, "canonical")
    await mkdir(join(canonical, "conf"), { recursive: true })
    await mkdir(join(canonical, "node_modules", "fixture"), { recursive: true })
    await $`git init -q ${canonical}`.quiet()
    await $`git config core.hooksPath /dev/null`.cwd(canonical).quiet()
    await $`git config core.excludesFile /dev/null`.cwd(canonical).quiet()
    await $`git config core.fsmonitor false`.cwd(canonical).quiet()
    await writeFile(join(canonical, ".gitignore"), ".env\nnode_modules/\n")
    await $`git add .gitignore`.cwd(canonical).quiet()
    await $`git -c user.name=Fixture -c user.email=fixture@localhost -c commit.gpgsign=false commit -qm fixture`
      .cwd(canonical)
      .quiet()
    await writeFile(join(canonical, "conf", ".env"), "LOCAL_FIXTURE=1\n")
    await writeFile(join(canonical, "conf", ".env 2.save"), "LOCAL_FIXTURE=1\n")
    await writeFile(join(canonical, "node_modules", "fixture", "index.js"), "fixture\n")

    const gitLayer = LayerNode.compile(Git.node)
    const base = await Effect.runPromise(snapshotBase({ canonical }).pipe(Effect.provide(gitLayer)))
    const manifest = await createIgnoredContentSnapshot({ canonical })
    const wanted = ["conf/.env", "node_modules"]
    expect(manifest.entries.map((entry) => [entry.relativePath, entry.state])).toEqual([
      ["conf/.env", "copied"],
      ["node_modules", "copied"],
    ])
    const quiet = { complete: true, changed: new Set<string>() }
    for (const side of ["a", "b"]) {
      const worktree = join(root, side)
      const host = `${worktree}.git`
      await cp(join(canonical, ".git"), host, { recursive: true })
      await rm(join(host, "index"))
      await $`git --git-dir=${host} config core.bare true`.quiet()
      await $`git --git-dir=${host} worktree add --detach ${worktree} ${base.frozenHead}`.quiet()
      const state = {
        worktree,
        frozenHead: base.frozenHead,
        indexTree: base.indexTree,
        workingTree: base.baseTree,
      }
      await Effect.runPromise(syncContestantState(state).pipe(Effect.provide(gitLayer)))
      const plan = await planIgnoredResync({
        targetRoot: worktree,
        manifest,
        slotRoots: await listIgnoredRoots(worktree),
        canonical: quiet,
        slot: quiet,
      })
      const applied = await applyIgnoredResync({ targetRoot: worktree, manifest, plan })
      await Effect.runPromise(verifyContestantState(state).pipe(Effect.provide(gitLayer)))
      // The same exact-root comparison that gates preparation and warm reuse in the service.
      expect((await listIgnoredRoots(worktree)).sort()).toEqual(wanted)
      expect(await readFile(join(worktree, "conf", ".env"), "utf8")).toBe("LOCAL_FIXTURE=1\n")
      expect(await Bun.file(join(worktree, "conf", ".env 2.save")).exists()).toBe(false)
      expect(await readFile(join(worktree, "node_modules", "fixture", "index.js"), "utf8")).toBe("fixture\n")
      const refresh = await planIgnoredResync({
        targetRoot: worktree,
        manifest,
        slotRoots: await listIgnoredRoots(worktree),
        records: applied.records,
        canonical: quiet,
        slot: quiet,
      })
      expect(refresh.discard).toEqual([])
      expect(refresh.reclone).toEqual([])
      expect(refresh.keep).toEqual(wanted)
    }
    expect(await readFile(join(canonical, "conf", ".env 2.save"), "utf8")).toBe("LOCAL_FIXTURE=1\n")
    expect((await $`git diff --cached --name-only`.cwd(canonical).quiet().text()).trim()).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("ignored file roots stay stable without any rule-ignored directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-sync-roots-test-"))
  try {
    await $`git init -q ${root}`.quiet()
    await $`git config core.excludesFile /dev/null`.cwd(root).quiet()
    await writeFile(join(root, ".gitignore"), ".env\n")
    // Spaces, newlines, and a leading colon must retain their exact path spelling.
    const directories = ["conf", "deep/conf", ":conf \n"]
    for (const directory of directories) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, directory, ".env"), "fixture\n")
      await writeFile(join(root, directory, "public.txt"), "public\n")
    }
    const wanted = directories.map((directory) => `${directory}/.env`).sort()
    expect((await listIgnoredRoots(root)).sort()).toEqual(wanted)
    for (const directory of directories) await rm(join(root, directory, "public.txt"))
    expect((await listIgnoredRoots(root)).sort()).toEqual(wanted)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
