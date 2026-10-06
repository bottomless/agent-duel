import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import {
  alwaysObserved,
  createEnvironmentWatch,
  createIgnoredJournal,
  createSlotWatch,
  neverObserved,
  type EnvironmentWatch,
} from "@/arena/environment-watch"
import { cloneTree } from "@/util/copy-tree"

const started: Array<{ watch: EnvironmentWatch; key: string }> = []
const cleanups: Array<() => Promise<void>> = []
const directories: string[] = []

async function checkout(roots: readonly string[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-watch-"))
  directories.push(directory)
  for (const root of roots) {
    await mkdir(path.join(directory, root, "nested"), { recursive: true })
    await writeFile(path.join(directory, root, "nested", "file.js"), "before\n")
  }
  // The roots exist long before a warm pair is prepared. Letting the fixture's own writes
  // settle keeps them out of the observation the test is about.
  await Bun.sleep(400)
  return directory
}

async function begin(watch: EnvironmentWatch, input: { key: string; canonical: string; roots: readonly string[] }) {
  await watch.begin(input)
  started.push({ watch, key: input.key })
}

/** The backend reports asynchronously, so a negative needs a deadline rather than one look. */
async function waitForChange(watch: EnvironmentWatch, key: string, root: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const observation = watch.settle(key)
    if (!observation.complete) throw new Error(`observation broke: ${observation.reason}`)
    if (observation.changed.has(root)) return observation
    await Bun.sleep(25)
  }
  throw new Error(`watch never reported a change under ${root}`)
}

afterEach(async () => {
  await Promise.all(started.splice(0).map(({ watch, key }) => watch.stop(key)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("environment watch", () => {
  test("reports a file edited deep inside a watched root", async () => {
    const canonical = await checkout(["node_modules"])
    const watch = createEnvironmentWatch()
    await begin(watch, { key: "chat:1", canonical, roots: ["node_modules"] })
    expect(watch.settle("chat:1")).toMatchObject({ complete: true })

    await writeFile(path.join(canonical, "node_modules", "nested", "file.js"), "after\n")
    const observation = await waitForChange(watch, "chat:1", "node_modules")
    expect(Array.from(observation.changed)).toEqual(["node_modules"])
  }, 20_000)

  test("covers a root that only appears once the manifest names it", async () => {
    const canonical = await checkout(["node_modules", "packages/app/node_modules"])
    const watch = createEnvironmentWatch()
    await begin(watch, { key: "chat:2", canonical, roots: ["node_modules"] })

    await watch.retarget("chat:2", ["node_modules", "packages/app/node_modules"])
    await writeFile(path.join(canonical, "packages/app/node_modules", "nested", "file.js"), "after\n")
    const observation = await waitForChange(watch, "chat:2", "packages/app/node_modules")
    expect(observation.changed.has("packages/app/node_modules")).toBe(true)
  }, 20_000)

  test("ignores writes that fall outside every watched root", async () => {
    const canonical = await checkout(["node_modules"])
    const watch = createEnvironmentWatch()
    await begin(watch, { key: "chat:3", canonical, roots: ["node_modules"] })

    await writeFile(path.join(canonical, "tracked.ts"), "export const value = 1\n")
    await Bun.sleep(1_000)
    const observation = watch.settle("chat:3")
    expect(observation.complete).toBe(true)
    expect(observation.changed.size).toBe(0)
  }, 20_000)

  test("treats a generation it never watched as unobserved", () => {
    const watch = createEnvironmentWatch()
    const observation = watch.settle("chat:never")
    expect(observation.complete).toBe(false)
    expect(observation.changed.size).toBe(0)
  })

  test("treats a stopped generation as unobserved, so a restart re-clones", async () => {
    const canonical = await checkout(["node_modules"])
    const watch = createEnvironmentWatch()
    await begin(watch, { key: "chat:4", canonical, roots: ["node_modules"] })
    expect(watch.settle("chat:4").complete).toBe(true)

    await watch.stop("chat:4")
    expect(watch.settle("chat:4").complete).toBe(false)
  }, 20_000)
})

/** Poll until the backend has delivered what the test is waiting for. */
async function waitUntil(description: string, done: () => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (done()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting until ${description}`)
}

function journalFor(key: string) {
  const journal = createIgnoredJournal()
  cleanups.push(() => journal.stop(key))
  return journal
}

function changed(observation: { readonly changed: ReadonlySet<string> }) {
  return Array.from(observation.changed).toSorted()
}

describe("ignored journal", () => {
  test("reports a deep write after a mark, and nothing after a later mark", async () => {
    const canonical = await checkout(["node_modules"])
    const journal = journalFor("chat:j1")
    await journal.begin("chat:j1", canonical, ["node_modules"])
    const before = journal.mark("chat:j1")!
    expect(journal.changedSince("chat:j1", before, ["node_modules"])).toEqual({ complete: true, changed: new Set() })

    await writeFile(path.join(canonical, "node_modules", "nested", "file.js"), "after\n")
    await waitUntil("the deep write is reported", () =>
      journal.changedSince("chat:j1", before, ["node_modules"]).changed.has("node_modules"),
    )

    await Bun.sleep(700)
    const after = journal.mark("chat:j1")!
    expect(after.epoch).toBe(before.epoch)
    expect(after.seq).toBeGreaterThan(before.seq)
    await Bun.sleep(1_000)
    expect(journal.changedSince("chat:j1", after, ["node_modules"])).toEqual({ complete: true, changed: new Set() })
  }, 20_000)

  test("names the paths written under a root, relative to it, and only those after the mark", async () => {
    // Nested, so the stream is on `packages` and the root's own creation is long past.
    const canonical = await checkout(["packages/app/node_modules"])
    const root = "packages/app/node_modules"
    const journal = journalFor("chat:jp")
    await journal.begin("chat:jp", canonical, [root])
    const before = journal.mark("chat:jp")!

    await writeFile(path.join(canonical, root, "nested", "file.js"), "after\n")
    await mkdir(path.join(canonical, root, "Added", "lib"), { recursive: true })
    await writeFile(path.join(canonical, root, "Added", "lib", "index.js"), "added\n")
    const named = () => journal.changedSince("chat:jp", before, [root]).paths?.get(root) ?? new Set<string>()
    await waitUntil("every write is named", () => named().has("nested/file.js") && named().has("Added/lib/index.js"))
    // Spelled as on disk, which is the name a patch has to create.
    expect(named().has("Added")).toBe(true)

    await Bun.sleep(700)
    const after = journal.mark("chat:jp")!
    await rm(path.join(canonical, root, "nested", "file.js"))
    await waitUntil(
      "the delete is named",
      () => journal.changedSince("chat:jp", after, [root]).paths?.get(root)?.has("nested/file.js") === true,
    )
    await Bun.sleep(700)
    expect(Array.from(journal.changedSince("chat:jp", after, [root]).paths?.get(root) ?? [])).toEqual([
      "nested/file.js",
    ])
  }, 20_000)

  test("names no paths for a root whose ancestor moved: it reads as written throughout", async () => {
    const canonical = await checkout(["packages/app/node_modules"])
    const root = "packages/app/node_modules"
    const journal = journalFor("chat:jw")
    await journal.begin("chat:jw", canonical, [root])
    const before = journal.mark("chat:jw")!
    await writeFile(path.join(canonical, root, "nested", "file.js"), "named\n")
    await waitUntil(
      "the write is named",
      () => journal.changedSince("chat:jw", before, [root]).paths?.has(root) === true,
    )

    await rename(path.join(canonical, "packages", "app"), path.join(canonical, "packages", "web"))
    await rename(path.join(canonical, "packages", "web"), path.join(canonical, "packages", "app"))
    await waitUntil("the move is reported", () => journal.changedSince("chat:jw", before, [root]).paths === undefined)
    expect(journal.changedSince("chat:jw", before, [root]).changed.has(root)).toBe(true)
  }, 20_000)

  test("never mistakes a root deleted and made again for one still watched", async () => {
    const canonical = await checkout(["node_modules"])
    const root = path.join(canonical, "node_modules")
    const journal = journalFor("chat:j2")
    await journal.begin("chat:j2", canonical, ["node_modules"])
    const before = journal.mark("chat:j2")!

    // `npm ci`: the root goes and comes back, and the next writes land deep inside it.
    await rm(root, { recursive: true, force: true })
    await mkdir(path.join(root, "nested"), { recursive: true })
    await writeFile(path.join(root, "nested", "file.js"), "reinstalled\n")
    await waitUntil("the reinstall is reported", () =>
      journal.changedSince("chat:j2", before, ["node_modules"]).changed.has("node_modules"),
    )
    await Bun.sleep(1_000)

    // Whether the stream survived is the backend's business. Either the root still reads as
    // unwatched, or, once retargeted, a later deep write is seen.
    await journal.retarget("chat:j2", ["node_modules"])
    const later = journal.mark("chat:j2")!
    expect(journal.changedSince("chat:j2", later, ["node_modules"]).changed.size).toBe(0)
    await writeFile(path.join(root, "nested", "file.js"), "patched\n")
    await waitUntil("the write after the reinstall is reported", () =>
      journal.changedSince("chat:j2", later, ["node_modules"]).changed.has("node_modules"),
    )
  }, 30_000)

  test("takes a deleted root out of coverage until it is retargeted", async () => {
    const canonical = await checkout(["node_modules"])
    const root = path.join(canonical, "node_modules")
    const journal = journalFor("chat:j3")
    await journal.begin("chat:j3", canonical, ["node_modules"])

    await rm(root, { recursive: true, force: true })
    await waitUntil("the root is out of coverage", () => {
      const now = journal.mark("chat:j3")!
      return journal.changedSince("chat:j3", now, ["node_modules"]).changed.has("node_modules")
    })
    await mkdir(path.join(root, "nested"), { recursive: true })
    await Bun.sleep(1_000)
    const recreated = journal.mark("chat:j3")!
    expect(changed(journal.changedSince("chat:j3", recreated, ["node_modules"]))).toEqual(["node_modules"])

    await journal.retarget("chat:j3", ["node_modules"])
    const watched = journal.mark("chat:j3")!
    expect(journal.changedSince("chat:j3", recreated, ["node_modules"]).changed.has("node_modules")).toBe(true)
    expect(journal.changedSince("chat:j3", watched, ["node_modules"]).changed.size).toBe(0)
    await writeFile(path.join(root, "nested", "file.js"), "after\n")
    await waitUntil("the write into the new root is reported", () =>
      journal.changedSince("chat:j3", watched, ["node_modules"]).changed.has("node_modules"),
    )
  }, 30_000)

  test("watches a root again even while another watch still holds its stopped stream", async () => {
    const canonical = await checkout(["node_modules"])
    const root = path.join(canonical, "node_modules")
    // Parcel shares one native watcher per directory and options. The environment watch keeps
    // its subscription to the root after the root is deleted, which is what would hand the
    // journal the stopped watcher again.
    const legacy = createEnvironmentWatch()
    await begin(legacy, { key: "chat:legacy", canonical, roots: ["node_modules"] })
    const journal = journalFor("chat:j4")
    await journal.begin("chat:j4", canonical, ["node_modules"])

    await rm(root, { recursive: true, force: true })
    await waitUntil("the root is out of coverage", () => {
      const now = journal.mark("chat:j4")!
      return journal.changedSince("chat:j4", now, ["node_modules"]).changed.has("node_modules")
    })
    await mkdir(path.join(root, "nested"), { recursive: true })
    await Bun.sleep(1_000)
    await journal.retarget("chat:j4", ["node_modules"])
    const watched = journal.mark("chat:j4")!
    expect(journal.changedSince("chat:j4", watched, ["node_modules"]).changed.size).toBe(0)
    await writeFile(path.join(root, "nested", "file.js"), "after\n")
    await waitUntil("the write into the new root is reported", () =>
      journal.changedSince("chat:j4", watched, ["node_modules"]).changed.has("node_modules"),
    )
  }, 30_000)

  test("rejects a mark from a journal that is gone or belongs to another", async () => {
    const canonical = await checkout(["node_modules"])
    const journal = journalFor("chat:j5")
    await journal.begin("chat:j5", canonical, ["node_modules"])
    const mark = journal.mark("chat:j5")!

    // Beginning again on the same checkout keeps the journal and its marks.
    await journal.begin("chat:j5", canonical, ["node_modules"])
    expect(journal.mark("chat:j5")!.epoch).toBe(mark.epoch)
    expect(journal.changedSince("chat:j5", mark, ["node_modules"]).complete).toBe(true)

    const other = journalFor("chat:j5")
    await other.begin("chat:j5", canonical, ["node_modules"])
    expect(journal.changedSince("chat:j5", other.mark("chat:j5"), ["node_modules"]).complete).toBe(false)

    // A restart, or a stopped journal begun again, counts from nothing.
    await journal.stop("chat:j5")
    expect(journal.mark("chat:j5")).toBeUndefined()
    expect(journal.changedSince("chat:j5", mark, ["node_modules"])).toMatchObject({ complete: false })
    await journal.begin("chat:j5", canonical, ["node_modules"])
    const restarted = journal.changedSince("chat:j5", mark, ["node_modules"])
    expect(restarted.complete).toBe(false)
    expect(changed(restarted)).toEqual(["node_modules"])
    expect(journal.changedSince("chat:j5", undefined, ["node_modules"]).complete).toBe(false)
  }, 20_000)

  test("covers a root only from the moment a retarget subscribes it", async () => {
    const canonical = await checkout(["node_modules", "packages/app/node_modules"])
    const journal = journalFor("chat:j6")
    const roots = ["node_modules", "packages/app/node_modules"]
    await journal.begin("chat:j6", canonical, ["node_modules"])
    const before = journal.mark("chat:j6")!
    expect(changed(journal.changedSince("chat:j6", before, roots))).toEqual(["packages/app/node_modules"])

    await journal.retarget("chat:j6", roots)
    expect(changed(journal.changedSince("chat:j6", before, roots))).toEqual(["packages/app/node_modules"])
    const after = journal.mark("chat:j6")!
    expect(journal.changedSince("chat:j6", after, roots).changed.size).toBe(0)

    await writeFile(path.join(canonical, "packages/app/node_modules", "nested", "file.js"), "after\n")
    await waitUntil("the new root reports the write", () =>
      journal.changedSince("chat:j6", after, roots).changed.has("packages/app/node_modules"),
    )
    expect(journal.changedSince("chat:j6", after, roots).changed.has("node_modules")).toBe(false)
  }, 20_000)

  test("names a new direct child, and reads a change to the root itself as written throughout", async () => {
    // Nested, so the stream is on `packages` and the root is only something under it. A stream
    // counts any create of its own directory as a move, so a top-level root's metadata can
    // read as a change; that costs a clone and nothing else.
    const canonical = await checkout(["packages/app/node_modules"])
    const root = path.join(canonical, "packages/app/node_modules")
    await writeFile(path.join(canonical, "file-root"), "file\n")
    const roots = ["packages/app/node_modules", "missing", "file-root"]
    const journal = journalFor("chat:j7")
    await journal.begin("chat:j7", canonical, roots)
    const before = journal.mark("chat:j7")!
    // A root that is not there, or not a directory, is never covered.
    const uncovered = journal.changedSince("chat:j7", before, roots)
    expect(changed(uncovered)).toEqual(["file-root", "missing"])
    expect(uncovered.unwatched?.get("missing")).toBe("not a directory")

    await writeFile(path.join(root, "added.js"), "added\n")
    await waitUntil(
      "the new child is named",
      () => journal.changedSince("chat:j7", before, [roots[0]!]).paths?.get(roots[0]!)?.has("added.js") === true,
    )

    // The checkout's root may move for a patch, so the journal cannot leave its own changes to
    // the identity check: a root moved away and back reaches it as an event on the root.
    await Bun.sleep(700)
    const after = journal.mark("chat:j7")!
    const now = new Date(Date.now() + 5_000)
    await utimes(root, now, now)
    await waitUntil("the root's own change is reported", () =>
      journal.changedSince("chat:j7", after, [roots[0]!]).changed.has(roots[0]!),
    )
    expect(journal.changedSince("chat:j7", after, [roots[0]!]).paths).toBeUndefined()
  }, 20_000)

  test("sees a root's parent moved away and back, which leaves the root itself untouched", async () => {
    const canonical = await checkout(["packages/app/node_modules", "node_modules"])
    const roots = ["packages/app/node_modules", "node_modules"]
    const journal = journalFor("chat:j8")
    await journal.begin("chat:j8", canonical, roots)
    const before = journal.mark("chat:j8")!
    await Bun.sleep(300)

    await rename(path.join(canonical, "packages", "app"), path.join(canonical, "packages", "web"))
    await writeFile(path.join(canonical, "packages", "web", "node_modules", "nested", "file.js"), "patched\n")
    await rename(path.join(canonical, "packages", "web"), path.join(canonical, "packages", "app"))
    await waitUntil("the move is reported", () =>
      journal.changedSince("chat:j8", before, roots).changed.has("packages/app/node_modules"),
    )
    await Bun.sleep(700)
    expect(journal.changedSince("chat:j8", before, roots)).toEqual({
      complete: true,
      changed: new Set(["packages/app/node_modules"]),
    })
  }, 20_000)

  test("starts a new record, and refuses the old marks, when a key moves to another checkout", async () => {
    const first = await checkout(["node_modules"])
    const second = await checkout(["node_modules"])
    const journal = journalFor("chat:j9")
    await journal.begin("chat:j9", first, ["node_modules"])
    const mark = journal.mark("chat:j9")!

    await journal.begin("chat:j9", second, ["node_modules"])
    const moved = journal.mark("chat:j9")!
    expect(moved.epoch).not.toBe(mark.epoch)
    expect(journal.changedSince("chat:j9", mark, ["node_modules"])).toMatchObject({ complete: false })
    expect(journal.changedSince("chat:j9", moved, ["node_modules"])).toEqual({ complete: true, changed: new Set() })

    // The first checkout is no longer followed; the second one is.
    await writeFile(path.join(first, "node_modules", "nested", "file.js"), "first\n")
    await writeFile(path.join(second, "node_modules", "nested", "file.js"), "second\n")
    await waitUntil("the second checkout's write is reported", () =>
      journal.changedSince("chat:j9", moved, ["node_modules"]).changed.has("node_modules"),
    )
  }, 20_000)

  test("reports a chmod of a file it already reported, when renewed before the mark", async () => {
    const canonical = await checkout(["build"])
    const file = path.join(canonical, "build", "nested", "file.js")
    const journal = journalFor("chat:j11")
    await journal.begin("chat:j11", canonical, ["build"])
    const before = journal.mark("chat:j11")!

    // The stream reports the edit, and remembers the file with its mtime from then on.
    await writeFile(file, "edited\n")
    await waitUntil("the edit is reported", () =>
      journal.changedSince("chat:j11", before, ["build"]).changed.has("build"),
    )
    await Bun.sleep(700)

    await journal.renew("chat:j11")
    const after = journal.mark("chat:j11")!
    await Bun.sleep(1_000)
    expect(journal.changedSince("chat:j11", after, ["build"])).toEqual({ complete: true, changed: new Set() })

    // A chmod leaves the mtime alone.
    await chmod(file, 0o755)
    await waitUntil("the chmod is reported", () =>
      journal.changedSince("chat:j11", after, ["build"]).changed.has("build"),
    )
  }, 20_000)

  test("keeps earlier marks covered across a renewal", async () => {
    const canonical = await checkout(["node_modules", "packages/app/node_modules"])
    const roots = ["node_modules", "packages/app/node_modules"]
    const journal = journalFor("chat:j12")
    await journal.begin("chat:j12", canonical, roots)
    const before = journal.mark("chat:j12")!

    await journal.renew("chat:j12")
    await journal.renew("chat:j12")
    expect(journal.changedSince("chat:j12", before, roots)).toEqual({ complete: true, changed: new Set() })
    await writeFile(path.join(canonical, "packages/app/node_modules", "nested", "file.js"), "after\n")
    await waitUntil("the write after the renewals is reported", () =>
      journal.changedSince("chat:j12", before, roots).changed.has("packages/app/node_modules"),
    )
    // Past the drain, so the old subscriptions are gone and only the new ones deliver.
    await Bun.sleep(1_500)
    await writeFile(path.join(canonical, "node_modules", "nested", "file.js"), "after\n")
    await waitUntil("the write after the drain is reported", () =>
      journal.changedSince("chat:j12", before, roots).changed.has("node_modules"),
    )
    expect(journal.changedSince("chat:j12", before, roots).complete).toBe(true)
  }, 20_000)

  test("covers hundreds of nested roots, past what one stream per root allows", async () => {
    // FSEvents gives a process about 512 streams. A stream per root would run out here.
    const roots = Array.from({ length: 600 }, (_, index) => `packages/p${index}/node_modules`)
    const canonical = await checkout([])
    for (const root of roots) await mkdir(path.join(canonical, root), { recursive: true })
    await Bun.sleep(400)
    const journal = journalFor("chat:j10")
    await journal.begin("chat:j10", canonical, roots)
    const before = journal.mark("chat:j10")!
    expect(journal.changedSince("chat:j10", before, roots)).toEqual({ complete: true, changed: new Set() })

    await writeFile(path.join(canonical, roots[599]!, "late.js"), "late\n")
    await waitUntil("the write under the last root is reported", () =>
      journal.changedSince("chat:j10", before, roots).changed.has(roots[599]!),
    )
    expect(changed(journal.changedSince("chat:j10", before, roots))).toEqual([roots[599]])
  }, 30_000)
})

describe("slot watch", () => {
  test("reports a deep write and a deleted root since it began", async () => {
    const slot = await checkout(["node_modules", ".next"])
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["node_modules", ".next"])
    expect(watch.settle(slot)).toEqual({ complete: true, changed: new Set() })

    await writeFile(path.join(slot, "node_modules", "nested", "file.js"), "after\n")
    await waitUntil("the deep write is reported", () => watch.settle(slot).changed.has("node_modules"))
    await rm(path.join(slot, ".next"), { recursive: true, force: true })
    await waitUntil("the deleted root is reported", () => watch.settle(slot).changed.has(".next"))
    await Bun.sleep(700)
    expect(changed(watch.settle(slot))).toEqual([".next", "node_modules"])
    expect(watch.settle(slot).complete).toBe(true)
  }, 20_000)

  test("names the paths written under each root since it began", async () => {
    const slot = await checkout(["node_modules", ".next"])
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["node_modules", ".next"])

    await writeFile(path.join(slot, "node_modules", "nested", "file.js"), "after\n")
    await writeFile(path.join(slot, ".next", "stray.txt"), "stray\n")
    const named = (root: string) => watch.settle(slot).paths?.get(root) ?? new Set<string>()
    await waitUntil("both writes are named", () => named("node_modules").size > 0 && named(".next").size > 0)
    await Bun.sleep(700)
    expect(Array.from(named("node_modules"))).toEqual(["nested/file.js"])
    expect(Array.from(named(".next"))).toEqual(["stray.txt"])
  }, 20_000)

  test("names a child added to a root, and reads a change to the root itself as written throughout", async () => {
    const slot = await checkout(["node_modules", ".next", "dist"])
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["node_modules", ".next", "dist"])
    await Bun.sleep(300)

    // A child added moves the root's own identity, and is reported under its own path.
    await writeFile(path.join(slot, "node_modules", "added.js"), "added\n")
    // Moved away and straight back, the root is reported as itself, and what was written
    // through its other name is not reported at all.
    await rename(path.join(slot, ".next"), path.join(slot, ".next-away"))
    await writeFile(path.join(slot, ".next-away", "nested", "file.js"), "hidden\n")
    await rename(path.join(slot, ".next-away"), path.join(slot, ".next"))
    await chmod(path.join(slot, "dist"), 0o700)
    await waitUntil("every change is reported", () => watch.settle(slot).changed.size === 3)
    await Bun.sleep(700)
    const settled = watch.settle(slot)
    expect(Array.from(settled.paths?.get("node_modules") ?? [])).toEqual(["added.js"])
    expect(settled.paths?.has(".next")).toBe(false)
    expect(settled.paths?.has("dist")).toBe(false)
  }, 20_000)

  test("stops the stream attached longest ago once the budget is full, and that slot reads as changed", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "arena-watch-budget-"))
    directories.push(base)
    // One more slot than the engine holds streams for; each slot watch is one stream.
    const slots = Array.from({ length: 257 }, (_, index) => path.join(base, `slot-${index}`))
    for (const slot of slots) await mkdir(path.join(slot, "node_modules"), { recursive: true })
    await Bun.sleep(400)
    const watch = createSlotWatch()
    cleanups.push(async () => {
      for (const slot of slots) await watch.stop(slot)
    })
    for (const slot of slots.slice(0, -1)) await watch.begin(slot, ["node_modules"])
    expect(watch.settle(slots[0]!).changed.size).toBe(0)
    await watch.begin(slots.at(-1)!, ["node_modules"])
    expect(changed(watch.settle(slots[0]!))).toEqual(["node_modules"])
    expect(watch.settle(slots[1]!).changed.size).toBe(0)
    expect(watch.settle(slots.at(-1)!)).toEqual({ complete: true, changed: new Set() })
  }, 60_000)

  test("counts any root it never covered as changed", async () => {
    const slot = await checkout(["node_modules"])
    await writeFile(path.join(slot, "file-root"), "file\n")
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["node_modules", "file-root", "missing"])
    await Bun.sleep(700)
    expect(changed(watch.settle(slot))).toEqual(["file-root", "missing"])
    expect(changed(watch.settle(slot, ["node_modules", "other"]))).toEqual(["file-root", "missing", "other"])

    expect(watch.settle(path.join(slot, "elsewhere"))).toMatchObject({ complete: false })
    await watch.stop(slot)
    const stopped = watch.settle(slot, ["node_modules"])
    expect(stopped.complete).toBe(false)
    expect(changed(stopped)).toEqual(["node_modules"])
  }, 20_000)

  test("sees a root's parent moved away and back, which leaves the root itself untouched", async () => {
    const slot = await checkout(["packages/app/node_modules"])
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["packages/app/node_modules"])
    await Bun.sleep(300)

    await rename(path.join(slot, "packages", "app"), path.join(slot, "packages", "web"))
    await writeFile(path.join(slot, "packages", "web", "node_modules", "nested", "file.js"), "patched\n")
    await rename(path.join(slot, "packages", "web"), path.join(slot, "packages", "app"))
    await waitUntil("the move is reported", () => watch.settle(slot).changed.has("packages/app/node_modules"))
  }, 20_000)

  test("takes every root out of coverage when the worktree itself moves away", async () => {
    const slot = await checkout(["node_modules", "packages/app/node_modules"])
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, ["node_modules", "packages/app/node_modules"])
    await Bun.sleep(300)

    await rename(slot, `${slot}-moved`)
    await rename(`${slot}-moved`, slot)
    await waitUntil("the move is reported", () => watch.settle(slot).changed.size === 2)
    const settled = watch.settle(slot)
    expect(settled.complete).toBe(true)
    expect(Array.from(settled.unwatched?.values() ?? [])).toEqual([
      expect.stringContaining("its watch stopped"),
      expect.stringContaining("its watch stopped"),
    ])
  }, 20_000)

  test("covers hundreds of roots with one stream", async () => {
    const roots = Array.from({ length: 600 }, (_, index) => `r${index}`)
    const slot = await checkout([])
    for (const root of roots) await mkdir(path.join(slot, root, "deep"), { recursive: true })
    await Bun.sleep(400)
    const watch = createSlotWatch()
    cleanups.push(() => watch.stop(slot))
    await watch.begin(slot, roots)
    await Bun.sleep(700)
    expect(watch.settle(slot)).toEqual({ complete: true, changed: new Set() })

    await writeFile(path.join(slot, "r599", "deep", "late.js"), "late\n")
    await waitUntil("the write under the last root is reported", () => watch.settle(slot).changed.has("r599"))
    expect(changed(watch.settle(slot))).toEqual(["r599"])
  }, 30_000)

  test.skipIf(process.platform !== "darwin")(
    "does not count a tree cloned just before it began",
    async () => {
      const source = await checkout(["node_modules"])
      for (let index = 0; index < 20; index++) {
        await mkdir(path.join(source, "node_modules", `pkg-${index}`, "lib"), { recursive: true })
        await writeFile(path.join(source, "node_modules", `pkg-${index}`, "lib", "index.js"), `${index}\n`)
      }
      const slot = await mkdtemp(path.join(os.tmpdir(), "arena-slot-"))
      directories.push(slot)
      await Bun.sleep(400)

      // The sync's last write is the clone, and FSEvents replays it to a stream begun right after.
      // Staged outside the slot, as a seed is, the tree arrives as one create of its root.
      const staging = `${slot}-staging`
      directories.push(staging)
      expect(await cloneTree(path.join(source, "node_modules"), path.join(slot, "node_modules"), { staging })).toBe(
        "clonefile",
      )
      const watch = createSlotWatch()
      cleanups.push(() => watch.stop(slot))
      await watch.begin(slot, ["node_modules"])
      await Bun.sleep(1_000)
      expect(watch.settle(slot)).toEqual({ complete: true, changed: new Set() })

      await writeFile(path.join(slot, "node_modules", "pkg-3", "lib", "index.js"), "edited\n")
      await waitUntil("the edit is reported", () => watch.settle(slot).changed.has("node_modules"))
    },
    20_000,
  )

  test.skipIf(process.platform !== "darwin")(
    "still sees a root moved away and back once the replay of its own clone is over",
    async () => {
      const source = await checkout(["node_modules"])
      // The replay leaves parcel remembering the root, which drops the move back in most runs
      // unless the watch has taken a new native watcher since; a few runs make that reliable.
      for (let trial = 0; trial < 3; trial++) {
        const slot = await checkout(["node_modules"])
        // A clone whole: the old root goes and the checkout's takes its place, just before the
        // watch begins.
        await rename(path.join(slot, "node_modules"), path.join(slot, "trashed"))
        const staging = `${slot}-staging`
        directories.push(staging)
        expect(await cloneTree(path.join(source, "node_modules"), path.join(slot, "node_modules"), { staging })).toBe(
          "clonefile",
        )
        const watch = createSlotWatch()
        cleanups.push(() => watch.stop(slot))
        await watch.begin(slot, ["node_modules"])
        // The replay, the new watcher a second after it, and the old watcher's drain.
        await Bun.sleep(2_500)
        expect(watch.settle(slot)).toEqual({ complete: true, changed: new Set() })

        await rename(path.join(slot, "node_modules"), path.join(slot, "away"))
        await writeFile(path.join(slot, "away", "nested", "file.js"), "hidden\n")
        await rename(path.join(slot, "away"), path.join(slot, "node_modules"))
        await waitUntil("the move is reported", () => watch.settle(slot).changed.has("node_modules"))
        expect(watch.settle(slot).paths).toBeUndefined()
      }
    },
    40_000,
  )
})

describe("substitutes", () => {
  test("alwaysObserved never blocks reuse", () => {
    expect(alwaysObserved.settle("any")).toMatchObject({ complete: true })
  })

  test("neverObserved always blocks reuse", () => {
    expect(neverObserved.settle("any").complete).toBe(false)
  })
})
