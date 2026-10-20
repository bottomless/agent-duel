import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { finalize, promoteWinnerState } from "../../src/arena/git"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const text = (line: string) => `first\n${line}\nlast\n`

/** A repository where the winner and the developer's uncommitted edits both change the first `overlapping` files. */
const overlappingBattle = (overlapping: number) =>
  Effect.gen(function* () {
    const canonical = yield* scopedTmpdir({ git: true })
    const candidate = yield* scopedTmpdir()
    yield* Effect.promise(() => fs.mkdir(`${canonical.path}/src`))
    for (let index = 0; index < 40; index++) {
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/src/file-${index}.txt`, text("base"), "utf8"))
    }
    yield* Effect.promise(() => $`git add . && git commit -q -m base`.cwd(canonical.path).quiet())
    const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
    const baseTree = (yield* Effect.promise(() =>
      $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text(),
    )).trim()
    yield* Effect.promise(() =>
      $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow()).pipe(
        Effect.ignore,
      ),
    )
    for (let index = 0; index < overlapping; index++) {
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/src/file-${index}.txt`, text("winner"), "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/src/file-${index}.txt`, text("developer"), "utf8"))
    }
    const winner = yield* finalize({
      worktree: candidate.path,
      baseSHA: frozenHead,
      permanentRef: "refs/battles/scale/a",
    })
    return {
      canonical: canonical.path,
      frozenHead,
      baseWorkingTree: baseTree,
      baseIndexTree: baseTree,
      resultCommit: winner.finalCommit,
      finalIndexTree: winner.finalIndexTree,
      safetyRef: "refs/battles/scale/safety",
    }
  })

/** Runs `effect` with a Git service that counts the processes it starts. */
const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const git = yield* Git.Service
    let launches = 0
    const counting: Git.Interface = {
      ...git,
      run: (args, options) => {
        launches++
        return git.run(args, options)
      },
    }
    const value = yield* effect.pipe(Effect.provideService(Git.Service, counting))
    return { value, launches }
  })

/** Measures the review's dry run and then applies, the way a vote over these edits does. */
const promoteOver = (overlapping: number) =>
  Effect.gen(function* () {
    const input = yield* overlappingBattle(overlapping)
    const planned = yield* counted(promoteWinnerState({ ...input, dryRun: true }))
    const applied = yield* counted(promoteWinnerState(input))
    const merged = yield* Effect.promise(() => fs.readFile(`${input.canonical}/src/file-0.txt`, "utf8"))
    return { planned, applied, merged }
  })

describe("promoting a winner over the developer's overlapping edits", () => {
  // Starting a git process costs ~10 ms, more on Windows. Run per file, 271 overlapping files kept
  // a user's review and its apply at about four minutes each.
  it.live("starts as many git processes for thirty overlapping files as for three", () =>
    Effect.gen(function* () {
      const few = yield* promoteOver(3)
      const many = yield* promoteOver(30)

      expect(many.planned.value.publicConflicts).toHaveLength(30)
      expect(many.applied.value.conflicts).toHaveLength(30)
      expect(many.merged).toBe("first\n<<<<<<< ours\ndeveloper\n=======\nwinner\n>>>>>>> theirs\nlast\n")
      expect({ planned: many.planned.launches, applied: many.applied.launches }).toEqual({
        planned: few.planned.launches,
        applied: few.applied.launches,
      })
    }),
  )
})
