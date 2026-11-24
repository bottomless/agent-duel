import { $ } from "bun"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import {
  allocateBattleBaseRef,
  importResultRef,
  importWinnerRef,
  refRoot,
  selectResult,
  snapshotBase,
} from "@/arena/git"
import { Git } from "@/git"

const git = LayerNode.compile(Git.node)
function run<A, E>(effect: Effect.Effect<A, E, Git.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(git)))
}
async function revision(repo: string, ref: string) {
  return (await $`git rev-parse --verify ${ref}`.cwd(repo).quiet().text()).trim()
}

let parent: string
let canonical: string
let source: string
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "arena-result-refs-"))
  canonical = join(parent, "canonical")
  source = join(parent, "source")
  for (const repo of [canonical, source]) {
    await $`git init -q ${repo}`.quiet()
    await $`git config user.name Test`.cwd(repo).quiet()
    await $`git config user.email test@localhost`.cwd(repo).quiet()
    await $`git config commit.gpgSign false`.cwd(repo).quiet()
    await $`git commit -qm initial --allow-empty`.cwd(repo).quiet()
  }
})
afterEach(() => rm(parent, { recursive: true, force: true }))

test("a reused turn index preserves both incarnations' results and the legacy refs", async () => {
  const ordinal = { chatID: "chat", turnIndex: 4 }
  const legacy = "refs/battles/31e06f7d89feb99a/turn-4"
  expect(refRoot(ordinal)).toBe(legacy) // No stored base snapshot on the earliest turns.
  const attempts = [`${legacy}/base`, allocateBattleBaseRef("chat", 4), allocateBattleBaseRef("chat", 4)]
  const results = []
  for (const permanentRef of attempts) {
    await writeFile(join(canonical, "starting-point"), permanentRef)
    const base = await run(snapshotBase({ canonical, permanentRef }))
    const root = refRoot({
      ...ordinal,
      baseSnapshot: {
        canonicalHead: base.canonicalHead,
        tree: base.baseTree,
        indexTree: base.indexTree,
        permanentRef,
      },
    })
    expect(`${root}/base`).toBe(permanentRef)
    await $`git commit -qm ${permanentRef} --allow-empty`.cwd(source).quiet()
    const oid = await revision(source, "HEAD")
    const input = {
      canonical,
      sourceRepository: source,
      sourceRef: "HEAD",
      destinationRef: `${root}/a`,
      expectedCommit: oid,
    }
    expect(await run(importResultRef(input))).toBe(oid)
    expect(await run(importResultRef(input))).toBe(oid)
    await run(selectResult({ canonical, selectedRef: `${root}/selected`, resultCommit: oid }))
    results.push({ root, base: base.baseCommit, oid })
  }
  for (const result of results) {
    expect(await revision(canonical, `${result.root}/base`)).toBe(result.base)
    expect(await revision(canonical, `${result.root}/a`)).toBe(result.oid)
    expect(await revision(canonical, `${result.root}/selected`)).toBe(result.oid)
  }
})

test("result and winner imports never replace an unrelated object, even of a different type", async () => {
  const ref = "refs/battles/imported/a"
  const tree = await revision(canonical, "HEAD^{tree}")
  await $`git update-ref ${ref} ${tree}`.cwd(canonical).quiet()
  const oid = await revision(source, "HEAD")
  const input = { canonical, sourceRepository: source, sourceRef: "HEAD", destinationRef: ref }
  await expect(run(importResultRef({ ...input, expectedCommit: oid }))).rejects.toThrow("already points to")
  await expect(run(importWinnerRef({ ...input, expected: oid }))).rejects.toThrow("already points to")
  expect(await revision(canonical, ref)).toBe(tree)
})

test("a repeated winner-ref import keeps the annotated tag object without its host", async () => {
  await $`git tag -a v1 -m release`.cwd(source).quiet()
  const sourceRef = "refs/tags/v1"
  const expected = await revision(source, sourceRef)
  const destinationRef = "refs/battles/tags/a-refs/tags/v1"
  const input = { canonical, sourceRepository: source, sourceRef, destinationRef, expected }
  await run(importWinnerRef(input))
  await run(importWinnerRef({ ...input, sourceRepository: join(parent, "released-host") }))
  expect(await revision(canonical, destinationRef)).toBe(expected)
  expect((await $`git cat-file -t ${destinationRef}`.cwd(canonical).quiet().text()).trim()).toBe("tag")
})

test("racing first imports cannot both publish different commits", async () => {
  const first = await revision(source, "HEAD")
  await $`git commit --allow-empty -qm next`.cwd(source).quiet()
  const second = await revision(source, "HEAD")
  const destinationRef = "refs/battles/race/a"
  const imports = await Promise.allSettled(
    [first, second].map((oid) =>
      run(
        importResultRef({
          canonical,
          sourceRepository: source,
          sourceRef: oid,
          destinationRef,
          expectedCommit: oid,
        }),
      ),
    ),
  )
  const pinned = await revision(canonical, destinationRef)
  expect(imports.filter((result) => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: pinned }])
  expect(imports.filter((result) => result.status === "rejected")).toHaveLength(1)
})

test("only a continuing run's previous index tree can advance to a new one", async () => {
  const ref = "refs/battles/imported/a-index"
  const input = {
    canonical,
    sourceRepository: source,
    sourceRef: ref,
    destinationRef: ref,
    objectType: "tree" as const,
  }
  const previous = await revision(source, "HEAD^{tree}")
  await $`git update-ref ${ref} ${previous}`.cwd(source).quiet()
  await run(importResultRef({ ...input, expectedCommit: previous }))
  await writeFile(join(source, "staged.txt"), "continued\n")
  await $`git add staged.txt`.cwd(source).quiet()
  const next = (await $`git write-tree`.cwd(source).quiet().text()).trim()
  await $`git update-ref ${ref} ${next} ${previous}`.cwd(source).quiet()
  await expect(run(importResultRef({ ...input, expectedCommit: next }))).rejects.toThrow("already points to")
  const admitted = { ...input, expectedCommit: next, expectedDestinationCommit: previous }
  expect(await run(importResultRef(admitted))).toBe(next)
  expect(await run(importResultRef(admitted))).toBe(next)
  expect(await revision(canonical, ref)).toBe(next)
})
