import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  applyIgnoredResync,
  clearIgnoredSeed,
  copyIgnoredSeed,
  createIgnoredContentSnapshot,
  fingerprintCopiedContent,
  listIgnoredRoots,
  matchesIgnoredContentSnapshot,
  parseIgnoredRoots,
  PATCH_PATH_LIMIT,
  planIgnoredResync,
  recordIgnoredSeed,
  type CopyManifest,
  type RootObservation,
  type SlotRootRecord,
} from "@/arena/copy-snapshot"

const canClone = process.platform === "darwin" || process.platform === "linux"

async function repository(ignore = "ignored/\n*.secret\noutside-link\n") {
  const root = await mkdtemp(join(tmpdir(), "arena-copy-test-"))
  await $`git init -q ${root}`
  await $`git -C ${root} config user.email arena@example.test`
  await $`git -C ${root} config user.name Arena`
  await writeFile(join(root, "tracked.txt"), "tracked\n")
  await writeFile(join(root, ".gitignore"), ignore)
  await $`git -C ${root} add tracked.txt .gitignore`
  await $`git -C ${root} commit -qm initial`
  return root
}

async function contestant(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `arena-${name}-test-`))
  await writeFile(join(directory, "tracked.txt"), "contestant tracked state\n")
  return directory
}

async function exists(path: string) {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

describe("Arena ignored-content snapshot", () => {
  test("clones each ignored root whole into two identical contestants", async () => {
    const root = await repository()
    await mkdir(join(root, "ignored", "nested"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    await writeFile(join(root, "ignored", "nested", "two.txt"), "two\n")
    await symlink("one.txt", join(root, "ignored", "link"))
    await writeFile(join(root, "config.secret"), "secret\n")
    await mkdir(join(root, ".agent-duel", "worktrees", "private.git"), { recursive: true })
    await writeFile(join(root, ".agent-duel", "worktrees", "private.git", "HEAD"), "private\n")
    await writeFile(join(root, ".git", "info", "exclude"), "/.agent-duel/\n")
    const outside = await mkdtemp(join(tmpdir(), "arena-outside-test-"))
    await writeFile(join(outside, "outside.txt"), "outside\n")
    await symlink(join(outside, "outside.txt"), join(root, "outside-link"))

    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    expect(manifest.entries.map((entry) => [entry.relativePath, entry.type, entry.state])).toEqual([
      ["config.secret", "file", "copied"],
      ["ignored", "directory", "copied"],
      ["outside-link", "symlink", "omitted"],
    ])
    expect(manifest.entries.find((entry) => entry.relativePath === "outside-link")?.omissionReason).toBe("outside_root")

    const a = await contestant("a")
    const b = await contestant("b")
    const seededA = await copyIgnoredSeed({ targetRoot: a, manifest })
    const seededB = await copyIgnoredSeed({ targetRoot: b, manifest })
    expect(seededA.entries).toBe(2)
    if (canClone) expect(seededA.cloned).toBe(2)
    expect(seededB).toEqual(seededA)

    for (const directory of [a, b]) {
      expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe("contestant tracked state\n")
      expect(await readFile(join(directory, "ignored", "one.txt"), "utf8")).toBe("one\n")
      expect(await readFile(join(directory, "ignored", "nested", "two.txt"), "utf8")).toBe("two\n")
      expect((await lstat(join(directory, "ignored", "link"))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(directory, "config.secret"), "utf8")).toBe("secret\n")
      expect(await exists(join(directory, "outside-link"))).toBe(false)
      expect(await exists(join(directory, ".agent-duel"))).toBe(false)
    }

    const fingerprint = await fingerprintCopiedContent({ targetRoot: a, manifest })
    expect(await fingerprintCopiedContent({ targetRoot: b, manifest })).toBe(fingerprint)
    await writeFile(join(a, "config.secret"), "changed\n")
    expect(await fingerprintCopiedContent({ targetRoot: a, manifest })).not.toBe(fingerprint)
  })

  test("bounds concurrent ignored-root clones", async () => {
    const root = await repository("*.secret\n")
    for (const name of ["one", "two", "three", "four"]) {
      await writeFile(join(root, `${name}.secret`), `${name}\n`)
    }
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const target = await contestant("parallel")
    let active = 0
    let maximum = 0

    const result = await copyIgnoredSeed({
      targetRoot: target,
      manifest,
      concurrency: 2,
      clone: async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
        return "clonefile"
      },
    })

    expect(result).toEqual({ entries: 4, cloned: 4, copied: 0 })
    expect(maximum).toBe(2)
  })

  test("leaves a tracked file inside an ignored directory to the base tree", async () => {
    const root = await repository("build/\n")
    await mkdir(join(root, "build", "sub"), { recursive: true })
    await writeFile(join(root, "build", "keep.txt"), "canonical keep\n")
    await writeFile(join(root, "build", "sub", "out.js"), "out\n")
    await $`git -C ${root} add -f build/keep.txt`
    await $`git -C ${root} commit -qm keep`

    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["build/sub"])

    const a = await contestant("a")
    await mkdir(join(a, "build"), { recursive: true })
    await writeFile(join(a, "build", "keep.txt"), "contestant keep\n")
    await copyIgnoredSeed({ targetRoot: a, manifest })
    expect(await readFile(join(a, "build", "keep.txt"), "utf8")).toBe("contestant keep\n")
    expect(await readFile(join(a, "build", "sub", "out.js"), "utf8")).toBe("out\n")
  })

  test("omits ignored roots that contain registered Git worktrees", async () => {
    const root = await repository(".worktrees/\ncache/\n")
    const nested = join(root, ".worktrees", "secondary")
    await $`git -C ${root} worktree add -q -b secondary ${nested}`
    await mkdir(join(root, "cache"), { recursive: true })
    await writeFile(join(root, "cache", "value.txt"), "cache\n")

    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    expect(manifest.entries.find((entry) => entry.relativePath === ".worktrees")).toMatchObject({
      state: "omitted",
      omissionReason: "nested_worktree",
    })
    expect(manifest.entries.find((entry) => entry.relativePath === "cache")?.state).toBe("copied")
    expect(await matchesIgnoredContentSnapshot({ canonical: root, manifest })).toBe(true)

    const target = await contestant("nested-worktree")
    await copyIgnoredSeed({ targetRoot: target, manifest })
    expect(await exists(join(target, ".worktrees"))).toBe(false)
    expect(await readFile(join(target, "cache", "value.txt"), "utf8")).toBe("cache\n")

    await $`git -C ${root} worktree remove --force ${nested}`
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, "ordinary.txt"), "ordinary\n")
    expect(await matchesIgnoredContentSnapshot({ canonical: root, manifest })).toBe(false)
  })

  test("replaces a leftover tree at a seed path instead of nesting the seed inside it", async () => {
    const root = await repository()
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })

    const a = await contestant("a")
    await mkdir(join(a, "ignored"), { recursive: true })
    await writeFile(join(a, "ignored", "stale.txt"), "stale\n")
    const trash = join(await mkdtemp(join(tmpdir(), "arena-trash-test-")), "trash")
    await copyIgnoredSeed({ targetRoot: a, manifest, trash })
    expect(await readFile(join(a, "ignored", "one.txt"), "utf8")).toBe("one\n")
    expect(await exists(join(a, "ignored", "stale.txt"))).toBe(false)
    expect(await exists(join(a, "ignored", "ignored"))).toBe(false)
  })

  test("applies the byte limits only where the filesystem cannot clone", async () => {
    const root = await repository()
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "big.bin"), "x".repeat(64))
    await writeFile(join(root, "config.secret"), "secret\n")
    const policy = { ignoredFileMaxBytes: 32, ignoredTotalMaxBytes: 32 }

    const plain = await createIgnoredContentSnapshot({ canonical: root, policy, clone: async () => undefined })
    expect(plain.entries.find((entry) => entry.relativePath === "ignored")).toMatchObject({
      state: "omitted",
      omissionReason: "ignored_total_limit",
    })
    expect(plain.entries.find((entry) => entry.relativePath === "config.secret")).toMatchObject({
      state: "copied",
      method: "copy",
      logicalBytes: 7,
    })
    const a = await contestant("a")
    const seeded = await copyIgnoredSeed({ targetRoot: a, manifest: plain, clone: async () => undefined })
    expect(seeded).toEqual({ entries: 1, cloned: 0, copied: 1 })
    expect(await readFile(join(a, "config.secret"), "utf8")).toBe("secret\n")
    expect(await exists(join(a, "ignored"))).toBe(false)

    if (!canClone) return
    const cloned = await createIgnoredContentSnapshot({ canonical: root, policy })
    expect(cloned.entries.every((entry) => entry.state === "copied")).toBe(true)
    expect(cloned.entries.find((entry) => entry.relativePath === "ignored")?.logicalBytes).toBe(0)
  })

  test("recognizes an unchanged source and rejects a changed one", async () => {
    const root = await repository()
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    const policy = { ignoredFileMaxBytes: 1024, ignoredTotalMaxBytes: 1024 }
    const manifest = await createIgnoredContentSnapshot({ canonical: root, policy })

    expect(await matchesIgnoredContentSnapshot({ canonical: root, policy, manifest })).toBe(true)
    expect(
      await matchesIgnoredContentSnapshot({
        canonical: root,
        policy: { ignoredFileMaxBytes: 512, ignoredTotalMaxBytes: 1024 },
        manifest,
      }),
    ).toBe(false)

    // A new entry directly under the tree changes the tree's own inode.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(root, "ignored", "two.txt"), "two\n")
    expect(await matchesIgnoredContentSnapshot({ canonical: root, policy, manifest })).toBe(false)

    const again = await createIgnoredContentSnapshot({ canonical: root, policy })
    await writeFile(join(root, "config.secret"), "secret\n")
    expect(await matchesIgnoredContentSnapshot({ canonical: root, policy, manifest: again })).toBe(false)
  })

  test("clears a seed by moving its trees to the trash", async () => {
    const root = await repository()
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    await writeFile(join(root, "config.secret"), "secret\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const a = await contestant("a")
    await copyIgnoredSeed({ targetRoot: a, manifest })

    const trash = join(await mkdtemp(join(tmpdir(), "arena-trash-test-")), "trash")
    await clearIgnoredSeed({ targetRoot: a, manifest, trash })
    expect(await exists(join(a, "ignored"))).toBe(false)
    expect(await exists(join(a, "config.secret"))).toBe(false)
    expect(await readFile(join(a, "tracked.txt"), "utf8")).toBe("contestant tracked state\n")
    expect(await readdir(trash).catch(() => undefined)).toBeDefined()
  })

  test("fails on a checkout that is not a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-non-git-test-"))
    await expect(createIgnoredContentSnapshot({ canonical: root })).rejects.toThrow()
  })
})

const quiet: RootObservation = { complete: true, changed: new Set() }

/** A kept worktree: a clone of the checkout, seeded and recorded the way a slot is. */
async function slot(root: string, manifest: CopyManifest) {
  const directory = join(await mkdtemp(join(tmpdir(), "arena-slot-test-")), "slot")
  await $`git clone -q ${root} ${directory}`
  await copyIgnoredSeed({ targetRoot: directory, manifest })
  return { directory, records: await recordIgnoredSeed({ targetRoot: directory, manifest }) }
}

/** The worktree's ignored roots, listed the way the sync lists them. */
async function listed(directory: string) {
  return await listIgnoredRoots(directory)
}

async function plan(
  directory: string,
  manifest: CopyManifest,
  records: ReadonlyMap<string, SlotRootRecord>,
  observations: { canonical?: RootObservation; slot?: RootObservation } = {},
) {
  return await planIgnoredResync({
    targetRoot: directory,
    manifest,
    slotRoots: await listed(directory),
    records,
    canonical: observations.canonical ?? quiet,
    slot: observations.slot ?? quiet,
  })
}

async function inode(path: string) {
  return (await lstat(path)).ino
}

describe("Arena ignored-content resync", () => {
  test("keeps the roots nothing touched and recreates symlinks", async () => {
    const root = await repository("ignored/\n*.secret\nlink-root\n")
    await mkdir(join(root, "ignored", "nested"), { recursive: true })
    await writeFile(join(root, "ignored", "nested", "one.txt"), "one\n")
    await writeFile(join(root, "config.secret"), "secret\n")
    await symlink("tracked.txt", join(root, "link-root"))
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    expect(Array.from(records.keys())).toEqual(["config.secret", "ignored", "link-root"])

    const decided = await plan(directory, manifest, records)
    expect(decided.keep).toEqual(["config.secret", "ignored"])
    expect(decided.reclone).toEqual(["link-root"])
    expect(decided.discard).toEqual([])
    expect(decided.reasons["link-root"]).toBe("a symlink root is always recreated")
    expect(decided.records.get("ignored")).toEqual(records.get("ignored"))
  })

  test("clones again every root it cannot prove unchanged, and says why", async () => {
    const root = await repository("ignored/\ncache/\n*.secret\n")
    for (const name of ["ignored", "cache"]) {
      await mkdir(join(root, name, "nested"), { recursive: true })
      await writeFile(join(root, name, "nested", "one.txt"), "one\n")
    }
    await writeFile(join(root, "config.secret"), "secret\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const reason = async (
      path: string,
      options: {
        records?: ReadonlyMap<string, SlotRootRecord>
        manifest?: CopyManifest
        canonical?: RootObservation
        slot?: RootObservation
      } = {},
    ) => {
      const decided = await plan(directory, options.manifest ?? manifest, options.records ?? records, options)
      return decided.keep.includes(path) ? "kept" : decided.reasons[path]
    }

    expect(await reason("ignored")).toBe("kept")
    const withoutRecord = new Map(records)
    withoutRecord.delete("ignored")
    expect(await reason("ignored", { records: withoutRecord })).toBe("no record of an earlier clone")
    const wrongType = new Map(records)
    wrongType.set("config.secret", { ...records.get("config.secret")!, type: "directory" })
    expect(await reason("config.secret", { records: wrongType })).toBe("was cloned as a directory")

    // Deep writes are the watches' to report; a root-level identity cannot see them.
    const incomplete = { complete: false, changed: new Set<string>() }
    const written = { complete: true, changed: new Set(["ignored", "config.secret"]) }
    expect(await reason("ignored", { canonical: incomplete })).toBe("the checkout was not watched for the whole window")
    expect(await reason("ignored", { canonical: written })).toBe("written to in the checkout since it was cloned")
    expect(await reason("ignored", { slot: incomplete })).toBe("the worktree was not watched for the whole window")
    expect(await reason("ignored", { slot: written })).toBe("written to in the worktree since it was cloned")
    // A file root's own identity changes with any edit, so the watches have nothing to add.
    expect(await reason("config.secret", { canonical: incomplete, slot: written })).toBe("kept")

    await Bun.sleep(20)
    await writeFile(join(directory, "ignored", "stray.txt"), "stray\n")
    expect(await reason("ignored")).toBe("changed in the worktree since it was cloned")
    await rm(join(directory, "config.secret"))
    await mkdir(join(directory, "config.secret"))
    await writeFile(join(directory, "config.secret", "inside"), "inside\n")
    expect(await reason("config.secret")).toBe("no longer a file in the worktree")
    await rm(join(directory, "cache"), { recursive: true })
    expect(await reason("cache")).toBe("not listed as ignored in the worktree")

    await writeFile(join(root, "config.secret"), "rotated\n")
    const rotated = await createIgnoredContentSnapshot({ canonical: root })
    await rm(join(directory, "config.secret"), { recursive: true })
    await writeFile(join(directory, "config.secret"), "secret\n")
    const again = await recordIgnoredSeed({ targetRoot: directory, manifest })
    expect(await reason("config.secret", { manifest: rotated, records: again })).toBe(
      "changed in the checkout since it was cloned",
    )
  })

  test("discards what the checkout does not copy, and Agent Duel's own state", async () => {
    const root = await repository("ignored/\ndist/\n*.log\noutside-link\n")
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    await writeFile(join(root, "debug.log"), "debug\n")
    const outside = await mkdtemp(join(tmpdir(), "arena-outside-test-"))
    await writeFile(join(outside, "outside.txt"), "outside\n")
    await symlink(join(outside, "outside.txt"), join(root, "outside-link"))
    const manifest = await createIgnoredContentSnapshot({ canonical: root, policy: { exclude: ["debug.log"] } })
    const { directory, records } = await slot(root, manifest)

    await mkdir(join(directory, "dist"), { recursive: true })
    await writeFile(join(directory, "dist", "bundle.js"), "bundle\n")
    await writeFile(join(directory, "debug.log"), "contestant debug\n")
    await symlink(join(outside, "outside.txt"), join(directory, "outside-link"))
    await mkdir(join(directory, ".agent-duel", "worktrees"), { recursive: true })

    const decided = await plan(directory, manifest, records)
    expect(decided.keep).toEqual(["ignored"])
    expect(decided.reclone).toEqual([])
    expect(decided.discard.toSorted()).toEqual([".agent-duel", "debug.log", "dist", "outside-link"])
    expect(decided.reasons["dist"]).toBe("not a root the checkout copies")
    expect(decided.reasons["debug.log"]).toBe("omitted from the checkout's copy (excluded)")
    expect(decided.reasons["outside-link"]).toBe("omitted from the checkout's copy (outside_root)")
    expect(decided.reasons[".agent-duel"]).toBe("Agent Duel state never belongs to a contestant")
  })

  test("clones a copied root whole when the worktree disagrees on where it starts", async () => {
    const root = await repository("ignored/\nbuild/\n")
    await mkdir(join(root, "ignored", "sub"), { recursive: true })
    await writeFile(join(root, "ignored", "sub", "one.txt"), "one\n")
    await mkdir(join(root, "build", "sub"), { recursive: true })
    await writeFile(join(root, "build", "keep.txt"), "keep\n")
    await writeFile(join(root, "build", "sub", "out.js"), "out\n")
    await $`git -C ${root} add -f build/keep.txt`
    await $`git -C ${root} commit -qm keep`
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["build/sub", "ignored"])
    const { directory, records } = await slot(root, manifest)

    const decided = await planIgnoredResync({
      targetRoot: directory,
      manifest,
      // A descendant of one copied root, an ancestor of another.
      slotRoots: ["build", "ignored/sub"],
      records,
      canonical: quiet,
      slot: quiet,
    })
    expect(decided.discard).toEqual(["build", "ignored/sub"])
    expect(decided.reclone).toEqual(["build/sub", "ignored"])
    expect(decided.keep).toEqual([])
    expect(decided.reasons["ignored"]).toBe("overlaps ignored/sub, which the checkout does not copy")
    expect(decided.reasons["build/sub"]).toBe("overlaps build, which the checkout does not copy")

    // On a filesystem that ignores case, `Ignored` is the copied root under another name.
    const cased = await planIgnoredResync({
      targetRoot: directory,
      manifest,
      slotRoots: ["build/sub", "Ignored"],
      records,
      canonical: quiet,
      slot: quiet,
    })
    expect(cased.discard).toEqual(["Ignored"])
    expect(cased.reclone).toEqual(["ignored"])
    expect(cased.keep).toEqual(["build/sub"])
  })

  test("applies a plan: discards to the trash, clones again, and records every copied root", async () => {
    const root = await repository("ignored/\ncache/\ndist/\n*.secret\nlink-root\n")
    for (const name of ["ignored", "cache"]) {
      await mkdir(join(root, name, "nested"), { recursive: true })
      await writeFile(join(root, name, "nested", "one.txt"), `${name}\n`)
    }
    await writeFile(join(root, "config.secret"), "secret\n")
    await symlink("tracked.txt", join(root, "link-root"))
    const first = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, first)
    const cacheInode = await inode(join(directory, "cache"))

    // The contestant wrote into one tree and built another; the developer rotated a secret.
    await writeFile(join(directory, "ignored", "nested", "one.txt"), "contestant\n")
    await mkdir(join(directory, "dist"), { recursive: true })
    await writeFile(join(directory, "dist", "bundle.js"), "bundle\n")
    await mkdir(join(directory, ".agent-duel"), { recursive: true })
    await writeFile(join(root, "config.secret"), "rotated\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const decided = await plan(directory, manifest, records, {
      slot: { complete: true, changed: new Set(["ignored"]) },
    })
    expect(decided.keep).toEqual(["cache"])
    expect(decided.reclone).toEqual(["config.secret", "ignored", "link-root"])
    expect(decided.discard.toSorted()).toEqual([".agent-duel", "dist"])

    const trash = join(await mkdtemp(join(tmpdir(), "arena-trash-test-")), "trash")
    const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided, trash })
    expect(applied).toMatchObject({ discarded: 2, recloned: 3, kept: 1 })
    expect(Array.from(applied.records.keys())).toEqual(["cache", "config.secret", "ignored", "link-root"])
    expect(applied.records.get("cache")).toEqual(records.get("cache"))
    expect(await inode(join(directory, "cache"))).toBe(cacheInode)
    expect(await readFile(join(directory, "ignored", "nested", "one.txt"), "utf8")).toBe("ignored\n")
    expect(await readFile(join(directory, "config.secret"), "utf8")).toBe("rotated\n")
    expect((await lstat(join(directory, "link-root"))).isSymbolicLink()).toBe(true)
    expect(await exists(join(directory, "dist"))).toBe(false)
    expect(await exists(join(directory, ".agent-duel"))).toBe(false)
    // Discarded trees go by rename into the trash, where a background unlink finishes them.
    expect(await exists(trash)).toBe(true)
    for (const [path, record] of applied.records) {
      const stats = await lstat(join(directory, path))
      expect(record.targetIdentity.inode).toBe(stats.ino)
      expect(record.targetIdentity.ctimeMs).toBe(stats.ctimeMs)
    }

    // With nothing touched since, the next resync keeps everything but the symlink.
    const next = await plan(directory, manifest, applied.records)
    expect(next.keep).toEqual(["cache", "config.secret", "ignored"])
    expect(next.reclone).toEqual(["link-root"])
    expect(next.discard).toEqual([])
    const reapplied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: next, trash })
    expect(reapplied).toMatchObject({ discarded: 0, recloned: 1, kept: 3 })
  })

  test("clones a kept root again when it moved between the plan and the apply", async () => {
    const root = await repository("cache/\n")
    await mkdir(join(root, "cache"), { recursive: true })
    await writeFile(join(root, "cache", "one.txt"), "one\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const decided = await plan(directory, manifest, records)
    expect(decided.keep).toEqual(["cache"])

    await Bun.sleep(20)
    await writeFile(join(directory, "cache", "late.txt"), "late\n")
    const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
    expect(applied).toMatchObject({ recloned: 1, kept: 0 })
    expect(await exists(join(directory, "cache", "late.txt"))).toBe(false)
  })

  test("refuses a plan the manifest does not back, and a parent that leaves the worktree", async () => {
    const root = await repository("node_modules/\n")
    await mkdir(join(root, "packages", "app", "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "packages", "app", "index.ts"), "export {}\n")
    await writeFile(join(root, "packages", "app", "node_modules", "pkg", "index.js"), "pkg\n")
    await $`git -C ${root} add packages/app/index.ts`
    await $`git -C ${root} commit -qm app`
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(["packages/app/node_modules"])
    const { directory, records } = await slot(root, manifest)
    const decided = await plan(directory, manifest, records)
    expect(decided.keep).toEqual(["packages/app/node_modules"])

    await expect(
      applyIgnoredResync({ targetRoot: directory, manifest, plan: { ...decided, reclone: ["elsewhere"] } }),
    ).rejects.toThrow("which the manifest does not copy")

    const outside = await mkdtemp(join(tmpdir(), "arena-outside-test-"))
    await rm(join(directory, "packages", "app"), { recursive: true })
    await symlink(outside, join(directory, "packages", "app"))
    const escaped = await planIgnoredResync({
      targetRoot: directory,
      manifest,
      slotRoots: ["packages/app/node_modules"],
      records,
      canonical: quiet,
      slot: quiet,
    })
    expect(escaped.keep).toEqual([])
    await expect(applyIgnoredResync({ targetRoot: directory, manifest, plan: escaped })).rejects.toThrow(
      "parent escaped the worktree",
    )
    expect(await readdir(outside)).toEqual([])
  })
  test("lists ignored names exactly, so a whitespace variant of a copied root is discarded", async () => {
    expect(parseIgnoredRoots(" notes.log\0.env \0.env\0dist/\0dist/x.js\0.git/x\0.agent-duel/y\0")).toEqual([
      " notes.log",
      ".env ",
      ".env",
      "dist",
    ])

    const root = await repository("*.log\n.env*\nnode_modules/\n")
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "pkg\n")
    await writeFile(join(root, ".env"), "SECRET=1\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)

    // Names git lists apart, and a trimmed listing would fold into `notes.log` and `.env`.
    await writeFile(join(directory, " notes.log"), "contestant\n")
    await writeFile(join(directory, ".env "), "CONTESTANT=1\n")
    expect((await listed(directory)).toSorted()).toEqual([" notes.log", ".env", ".env ", "node_modules"])

    const decided = await plan(directory, manifest, records)
    expect(decided.keep).toEqual([".env", "node_modules"])
    expect(decided.discard.toSorted()).toEqual([" notes.log", ".env "])
    await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
    expect((await readdir(directory)).toSorted()).toEqual([".env", ".git", ".gitignore", "node_modules", "tracked.txt"])
    expect(await readFile(join(directory, ".env"), "utf8")).toBe("SECRET=1\n")

    // A listing that disagrees with the disk on a name fails the resync instead of skipping it.
    await writeFile(join(directory, " notes.log"), "contestant\n")
    const trimmed = await planIgnoredResync({
      targetRoot: directory,
      manifest,
      slotRoots: [".env", "node_modules", "notes.log"],
      records,
      canonical: quiet,
      slot: quiet,
    })
    expect(trimmed.discard).toEqual(["notes.log"])
    await expect(applyIgnoredResync({ targetRoot: directory, manifest, plan: trimmed })).rejects.toThrow(
      "which is not in the worktree",
    )
  })

  test("never keeps or discards through a parent that resolves outside the worktree", async () => {
    const root = await repository("node_modules/\n*.log\n")
    await mkdir(join(root, "packages", "app", "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "packages", "app", "index.ts"), "export {}\n")
    await writeFile(join(root, "packages", "app", "node_modules", "pkg", "index.js"), "pkg\n")
    await $`git -C ${root} add packages/app/index.ts`
    await $`git -C ${root} commit -qm app`
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)

    // The package moved out and a symlink put in its place: the root is the very tree that was
    // recorded, with the same identity, but it is no longer the worktree's.
    const outside = await mkdtemp(join(tmpdir(), "arena-outside-test-"))
    await rename(join(directory, "packages", "app"), join(outside, "app"))
    await symlink(join(outside, "app"), join(directory, "packages", "app"))
    await writeFile(join(outside, "app", "debug.log"), "outside\n")
    const decided = await planIgnoredResync({
      targetRoot: directory,
      manifest,
      slotRoots: ["packages/app/node_modules", "packages/app/debug.log"],
      records,
      canonical: quiet,
      slot: quiet,
    })
    expect(decided.keep).toEqual([])
    expect(decided.reasons["packages/app/node_modules"]).toBe("resolves outside the worktree")
    expect(decided.discard).toEqual(["packages/app/debug.log"])
    await expect(applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })).rejects.toThrow(
      "resolves outside the worktree",
    )
    expect((await readdir(join(outside, "app"))).toSorted()).toEqual(["debug.log", "index.ts", "node_modules"])
  })

  test("names the watch's reason when a root was not watched rather than written", async () => {
    const root = await repository("cache/\n")
    await mkdir(join(root, "cache"), { recursive: true })
    await writeFile(join(root, "cache", "one.txt"), "one\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const decided = await plan(directory, manifest, records, {
      canonical: { complete: false, changed: new Set(["cache"]), reason: "no journal for this checkout" },
      slot: {
        complete: true,
        changed: new Set(["cache"]),
        unwatched: new Map([["cache", "its watch stopped: its directory was deleted, moved or made again"]]),
      },
    })
    expect(decided.reasons["cache"]).toBe(
      "the checkout was not watched for the whole window (no journal for this checkout)",
    )
    const slotOnly = await plan(directory, manifest, records, {
      slot: { complete: true, changed: new Set(["cache"]), unwatched: new Map([["cache", "not a directory"]]) },
    })
    expect(slotOnly.reasons["cache"]).toBe("not watched in the worktree for the whole window (not a directory)")
  })
  test("patches a root the checkout wrote to: brings over only the named paths, and keeps the rest", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored", "pkg"), { recursive: true })
    for (const name of ["edited.txt", "gone.txt", "untouched.txt"]) {
      await writeFile(join(root, "ignored", "pkg", name), `${name} v1\n`)
    }
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const untouched = await inode(join(directory, "ignored", "pkg", "untouched.txt"))

    // The developer edits, adds a package, and deletes.
    await writeFile(join(root, "ignored", "pkg", "edited.txt"), "edited v2\n")
    await mkdir(join(root, "ignored", "added", "lib"), { recursive: true })
    await writeFile(join(root, "ignored", "added", "lib", "deep.js"), "deep\n")
    await rm(join(root, "ignored", "pkg", "gone.txt"))
    const next = await createIgnoredContentSnapshot({ canonical: root })
    const decided = await plan(directory, next, records, {
      canonical: {
        complete: true,
        changed: new Set(["ignored"]),
        paths: new Map([["ignored", new Set(["pkg/edited.txt", "added", "added/lib/deep.js", "pkg/gone.txt"])]]),
      },
    })
    expect(decided.keep).toEqual([])
    expect(decided.reclone).toEqual([])
    // `added/lib/deep.js` goes with `added`.
    expect(decided.patch.get("ignored")).toEqual(["added", "pkg/edited.txt", "pkg/gone.txt"])
    expect(decided.reasons["ignored"]).toBe("patched: 3 paths written in the checkout")

    const applied = await applyIgnoredResync({ targetRoot: directory, manifest: next, plan: decided })
    expect(applied).toMatchObject({ patched: 1, patchedPaths: 3, recloned: 0, unpatched: {} })
    const pkg = join(directory, "ignored", "pkg")
    expect(await readFile(join(pkg, "edited.txt"), "utf8")).toBe("edited v2\n")
    expect(await exists(join(pkg, "gone.txt"))).toBe(false)
    expect(await readFile(join(directory, "ignored", "added", "lib", "deep.js"), "utf8")).toBe("deep\n")
    expect(await inode(join(pkg, "untouched.txt"))).toBe(untouched)
    // A patched file keeps the checkout's times, as a clone of the whole root would.
    expect((await lstat(join(pkg, "edited.txt"))).mtimeMs).toBe(
      (await lstat(join(root, "ignored", "pkg", "edited.txt"))).mtimeMs,
    )
    const record = applied.records.get("ignored")!
    expect(record.targetIdentity.inode).toBe(await inode(join(directory, "ignored")))

    // The record now stands for the patched root, so with nothing written since it is kept.
    const after = await plan(directory, next, applied.records)
    expect(after.keep).toEqual(["ignored"])
  })

  test("clones a root whole when a side's writes cannot all be named, or a root changed on its own", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored", "pkg"), { recursive: true })
    await writeFile(join(root, "ignored", "pkg", "one.txt"), "one\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const named = (paths: readonly string[]): RootObservation => ({
      complete: true,
      changed: new Set(["ignored"]),
      paths: new Map([["ignored", new Set(paths)]]),
    })
    const unnamed: RootObservation = { complete: true, changed: new Set(["ignored"]) }
    const reason = async (observations: { canonical?: RootObservation; slot?: RootObservation }, target = manifest) =>
      (await plan(directory, target, records, observations)).reasons["ignored"]

    // Both sides' paths are brought over together, a path both named once.
    expect(await reason({ canonical: named(["pkg/one.txt"]), slot: named(["pkg/one.txt"]) })).toBe(
      "patched: 1 path written in the checkout and the worktree",
    )
    // Either side writing where its watch could not name the path.
    expect(await reason({ canonical: named(["pkg/one.txt"]), slot: unnamed })).toBe(
      "written to in the worktree since it was cloned",
    )
    expect(await reason({ canonical: unnamed, slot: named(["pkg/one.txt"]) })).toBe(
      "written to in the checkout since it was cloned",
    )
    const many = Array.from({ length: PATCH_PATH_LIMIT + 1 }, (_, index) => `file-${index}.txt`)
    expect(await reason({ canonical: named(many) })).toBe(
      `${PATCH_PATH_LIMIT + 1} paths written under it, more than are brought over one by one`,
    )
    // The limit counts both sides together.
    const half = Math.ceil(many.length / 2)
    expect(await reason({ canonical: named(many.slice(0, half)), slot: named(many.slice(half)) })).toBe(
      `${PATCH_PATH_LIMIT + 1} paths written under it, more than are brought over one by one`,
    )

    // The checkout's root moved with nothing named under it: its own metadata changed.
    await Bun.sleep(20)
    await writeFile(join(root, "ignored", "added.txt"), "added\n")
    const grown = await createIgnoredContentSnapshot({ canonical: root })
    expect(await reason({}, grown)).toBe("changed in the checkout since it was cloned")
    // The same move, explained by the child the journal named, is patched.
    expect(await reason({ canonical: named(["added.txt"]) }, grown)).toBe("patched: 1 path written in the checkout")
    // A different mode on the root is never a patch.
    await $`chmod 700 ${join(root, "ignored")}`
    const chmodded = await createIgnoredContentSnapshot({ canonical: root })
    expect(await reason({ canonical: named(["added.txt"]) }, chmodded)).toBe(
      "changed in the checkout since it was cloned",
    )
    // A child added in the worktree moves its root too, which the child its watch named explains.
    await writeFile(join(directory, "ignored", "stray.txt"), "stray\n")
    expect(await reason({ canonical: named(["added.txt"]) }, grown)).toBe("changed in the worktree since it was cloned")
    expect(await reason({ canonical: named(["added.txt"]), slot: named(["stray.txt"]) }, grown)).toBe(
      "patched: 2 paths written in the checkout and the worktree",
    )
    // Renamed away and straight back, the worktree's root moves its ctime alone. Whatever was
    // written through its other name went unreported, so no named child explains it.
    await Bun.sleep(20)
    await rename(join(directory, "ignored"), join(directory, "away"))
    await rename(join(directory, "away"), join(directory, "ignored"))
    expect(await reason({ canonical: named(["added.txt"]), slot: named(["stray.txt"]) }, grown)).toBe(
      "changed in the worktree since it was cloned",
    )
  })

  test("patches a root the contestant wrote to: its edits undone, its additions gone, its deletions back", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored", "pkg"), { recursive: true })
    for (const name of ["edited.txt", "gone.txt", "mode.txt", "untouched.txt"]) {
      await writeFile(join(root, "ignored", "pkg", name), `${name} v1\n`)
    }
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    const ignored = join(directory, "ignored")
    const rootInode = await inode(ignored)
    const untouched = await inode(join(ignored, "pkg", "untouched.txt"))

    // What a contestant leaves behind: an edit, a new file, a deletion, a mode change, a new
    // tree and a link out of the worktree, the last two as new children of the root itself.
    await Bun.sleep(20)
    await writeFile(join(ignored, "pkg", "edited.txt"), "contestant edit\n")
    await writeFile(join(ignored, "pkg", "added.txt"), "contestant file\n")
    await rm(join(ignored, "pkg", "gone.txt"))
    await $`chmod 755 ${join(ignored, "pkg", "mode.txt")}`
    await mkdir(join(ignored, "built", "deep"), { recursive: true })
    await writeFile(join(ignored, "built", "deep", "out.js"), "built\n")
    const outside = join(await mkdtemp(join(tmpdir(), "arena-patch-outside-")), "victim.txt")
    await writeFile(outside, "outside\n")
    await symlink(outside, join(ignored, "escape"))

    const reported = [
      "pkg/edited.txt",
      "pkg/added.txt",
      "pkg/gone.txt",
      "pkg/mode.txt",
      "built",
      "built/deep",
      "built/deep/out.js",
      "escape",
    ]
    const decided = await plan(directory, manifest, records, {
      slot: { complete: true, changed: new Set(["ignored"]), paths: new Map([["ignored", new Set(reported)]]) },
    })
    expect(decided.reclone).toEqual([])
    expect(decided.patch.get("ignored")).toEqual([
      "built",
      "escape",
      "pkg/added.txt",
      "pkg/edited.txt",
      "pkg/gone.txt",
      "pkg/mode.txt",
    ])
    expect(decided.reasons["ignored"]).toBe("patched: 6 paths written in the worktree")

    const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
    expect(applied).toMatchObject({ patched: 1, patchedPaths: 6, recloned: 0, unpatched: {} })
    expect(await inode(ignored)).toBe(rootInode)
    expect(await inode(join(ignored, "pkg", "untouched.txt"))).toBe(untouched)
    expect((await readdir(ignored)).toSorted()).toEqual(["pkg"])
    expect((await readdir(join(ignored, "pkg"))).toSorted()).toEqual([
      "edited.txt",
      "gone.txt",
      "mode.txt",
      "untouched.txt",
    ])
    expect(await readFile(join(ignored, "pkg", "edited.txt"), "utf8")).toBe("edited.txt v1\n")
    expect(await readFile(join(ignored, "pkg", "gone.txt"), "utf8")).toBe("gone.txt v1\n")
    expect((await lstat(join(ignored, "pkg", "mode.txt"))).mode).toBe(
      (await lstat(join(root, "ignored", "pkg", "mode.txt"))).mode,
    )
    expect(await readFile(outside, "utf8")).toBe("outside\n")

    // The record now stands for the patched root, so with nothing written since it is kept.
    const after = await plan(directory, manifest, applied.records)
    expect(after.keep).toEqual(["ignored"])
  })

  test.skipIf(process.platform !== "darwin")(
    "removes a lookalike name the contestant made without writing through it",
    async () => {
      const root = await repository("ignored/\n")
      await mkdir(join(root, "ignored", "pkg"), { recursive: true })
      await writeFile(join(root, "ignored", "pkg", "sass.js"), "sass\n")
      const manifest = await createIgnoredContentSnapshot({ canonical: root })
      const { directory, records } = await slot(root, manifest)
      // APFS matches U+017F to `s`; lowercasing does not. The contestant swaps the checkout's
      // file for a link out of the worktree under that spelling, and its watch names both.
      const outside = join(await mkdtemp(join(tmpdir(), "arena-patch-outside-")), "victim.txt")
      await writeFile(outside, "outside\n")
      await rm(join(directory, "ignored", "pkg", "sass.js"))
      await symlink(outside, join(directory, "ignored", "pkg", "ſass.js"))
      const decided = await plan(directory, manifest, records, {
        slot: {
          complete: true,
          changed: new Set(["ignored"]),
          paths: new Map([["ignored", new Set(["pkg/sass.js", "pkg/ſass.js"])]]),
        },
      })
      await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
      // Patched, or cloned whole when the lookalike still answered; never written through.
      expect(await readFile(outside, "utf8")).toBe("outside\n")
      expect(await readdir(join(directory, "ignored", "pkg"))).toEqual(["sass.js"])
      expect((await lstat(join(directory, "ignored", "pkg", "sass.js"))).isFile()).toBe(true)
      expect(await readFile(join(directory, "ignored", "pkg", "sass.js"), "utf8")).toBe("sass\n")
    },
  )

  test("patches through a symlink or a removed directory by writing the nearest plain ancestor", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored", "sub", "inner"), { recursive: true })
    await writeFile(join(root, "ignored", "sub", "inner", "file.txt"), "old\n")
    await mkdir(join(root, "ignored", "gone", "inner"), { recursive: true })
    await writeFile(join(root, "ignored", "gone", "inner", "file.txt"), "old\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    // The developer links a directory in from elsewhere in the checkout, and removes another.
    await mkdir(join(root, "ignored", "real", "inner"), { recursive: true })
    await writeFile(join(root, "ignored", "real", "inner", "file.txt"), "linked\n")
    await rm(join(root, "ignored", "sub"), { recursive: true })
    await symlink("real", join(root, "ignored", "sub"))
    await rm(join(root, "ignored", "gone"), { recursive: true })

    const decided = await plan(directory, manifest, records, {
      canonical: {
        complete: true,
        changed: new Set(["ignored"]),
        // Only the deepest paths, as a watch that folded the directory events away would name them.
        paths: new Map([["ignored", new Set(["sub/inner/file.txt", "gone/inner/file.txt", "real/inner/file.txt"])]]),
      },
    })
    const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
    expect(applied).toMatchObject({ patched: 1, patchedPaths: 3, recloned: 0 })
    expect((await lstat(join(directory, "ignored", "sub"))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(directory, "ignored", "sub", "inner", "file.txt"), "utf8")).toBe("linked\n")
    expect(await exists(join(directory, "ignored", "gone"))).toBe(false)
  })

  test("lands a case-only rename under the checkout's spelling", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "Readme.md"), "readme\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    await rename(join(root, "ignored", "Readme.md"), join(root, "ignored", "tmp.md"))
    await rename(join(root, "ignored", "tmp.md"), join(root, "ignored", "README.md"))
    const next = await createIgnoredContentSnapshot({ canonical: root })
    const decided = await plan(directory, next, records, {
      canonical: {
        complete: true,
        changed: new Set(["ignored"]),
        paths: new Map([["ignored", new Set(["Readme.md", "tmp.md", "README.md"])]]),
      },
    })
    await applyIgnoredResync({ targetRoot: directory, manifest: next, plan: decided })
    expect(await readdir(join(directory, "ignored"))).toEqual(["README.md"])
  })

  test.skipIf(process.platform !== "darwin")(
    "never writes into a name the worktree still holds under a spelling the fold does not match",
    async () => {
      const root = await repository("ignored/\n")
      await mkdir(join(root, "ignored", "pkg"), { recursive: true })
      await writeFile(join(root, "ignored", "pkg", "keep.txt"), "keep\n")
      const manifest = await createIgnoredContentSnapshot({ canonical: root })
      const { directory, records } = await slot(root, manifest)
      // APFS matches U+017F to `s`; lowercasing does not. Left there unreported, it answers to
      // the name the checkout writes.
      const outside = join(await mkdtemp(join(tmpdir(), "arena-patch-outside-")), "victim.txt")
      await writeFile(outside, "outside\n")
      await symlink(outside, join(directory, "ignored", "pkg", "ſass.js"))
      await writeFile(join(root, "ignored", "pkg", "sass.js"), "sass\n")
      const decided = await plan(directory, manifest, records, {
        canonical: {
          complete: true,
          changed: new Set(["ignored"]),
          paths: new Map([["ignored", new Set(["pkg/sass.js"])]]),
        },
      })
      const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
      expect(applied).toMatchObject({ patched: 0, recloned: 1 })
      expect(applied.unpatched["ignored"]).toBe(
        'patch failed: Patched path is still taken in the worktree: "pkg/sass.js"',
      )
      expect(await readFile(outside, "utf8")).toBe("outside\n")
      expect(await readFile(join(directory, "ignored", "pkg", "sass.js"), "utf8")).toBe("sass\n")
    },
  )

  test("stops between roots once stopped, and does not fall back to a plain copy", async () => {
    const root = await repository("one/\ntwo/\nthree/\n")
    for (const name of ["one", "two", "three"]) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, "file.txt"), `${name}\n`)
    }
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory } = await slot(root, manifest)
    const decided = await plan(directory, manifest, new Map())
    expect(decided.reclone).toHaveLength(3)
    const controller = new AbortController()
    const stopped = new Error("stopped")
    const cloned: string[] = []
    const clone = async (_source: string, target: string, options?: { signal?: AbortSignal }) => {
      cloned.push(target)
      controller.abort(stopped)
      options?.signal?.throwIfAborted()
      return undefined
    }

    await expect(
      applyIgnoredResync({
        targetRoot: directory,
        manifest,
        plan: decided,
        clone,
        concurrency: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(stopped)
    expect(cloned).toHaveLength(1)
  })

  test("clones a root whole when its patch fails partway", async () => {
    const root = await repository("ignored/\n")
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored", "one.txt"), "one\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const { directory, records } = await slot(root, manifest)
    await writeFile(join(root, "ignored", "one.txt"), "two\n")
    const decided = await plan(directory, manifest, records, {
      canonical: {
        complete: true,
        changed: new Set(["ignored"]),
        paths: new Map([["ignored", new Set(["one.txt", "../escape.txt"])]]),
      },
    })
    const applied = await applyIgnoredResync({ targetRoot: directory, manifest, plan: decided })
    expect(applied).toMatchObject({ patched: 0, recloned: 1 })
    expect(applied.unpatched["ignored"]).toBe(
      'patch failed: Patched path is not a plain relative path: "../escape.txt"',
    )
    expect(await readFile(join(directory, "ignored", "one.txt"), "utf8")).toBe("two\n")
  })

  test("records only the roots that stand as the manifest describes them", async () => {
    const root = await repository("cache/\n*.secret\n")
    await mkdir(join(root, "cache"), { recursive: true })
    await writeFile(join(root, "cache", "one.txt"), "one\n")
    await writeFile(join(root, "config.secret"), "secret\n")
    const manifest = await createIgnoredContentSnapshot({ canonical: root })
    const directory = await contestant("record")
    await copyIgnoredSeed({ targetRoot: directory, manifest })
    // Something replaced one root before the record was taken; it gets no record, so the next
    // resync clones it.
    await rm(join(directory, "cache"), { recursive: true })
    await writeFile(join(directory, "cache"), "not a tree\n")
    const records = await recordIgnoredSeed({ targetRoot: directory, manifest })
    expect(Array.from(records.keys())).toEqual(["config.secret"])
  })
})
