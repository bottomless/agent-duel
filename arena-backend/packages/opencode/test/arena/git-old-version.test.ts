import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  applySnapshot,
  compare,
  finalize,
  promoteWinnerState,
  requireBattleGit,
  snapshotBase,
} from "../../src/arena/git"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const realGit = Bun.which("git")

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

/**
 * Puts a `git` script first on PATH for the rest of the scope. The engine finds git on PATH, so
 * every git it runs goes through the script; the returned log lists the `merge-tree` calls.
 */
const fakeGit = (body: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await fs.mkdtemp(path.join(await fs.realpath(process.env.TMPDIR ?? "/tmp"), "fake-git-"))
      const log = path.join(dir, "calls.log")
      await fs.writeFile(log, "", "utf8")
      await fs.writeFile(
        path.join(dir, "git"),
        `#!/bin/sh\ncase " $* " in *" merge-tree "*) echo "$*" >> '${log}' ;; esac\n${body}\n`,
        { mode: 0o755 },
      )
      const previous = process.env.PATH
      process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`
      return { dir, log, previous }
    }),
    ({ dir, previous }) =>
      Effect.promise(async () => {
        process.env.PATH = previous
        await fs.rm(dir, { recursive: true, force: true })
      }),
  )

// Git 2.38 and 2.39 have `merge-tree --write-tree` but refuse `--merge-base`, which arrived in 2.40.
// Older Command Line Tools install Apple's 2.39.
const git239 = () =>
  fakeGit(
    [
      'for arg in "$@"; do',
      '  case "$arg" in --merge-base|--merge-base=*) echo "error: unknown option \\`${arg#--}\'" >&2; exit 129 ;; esac',
      "done",
      `exec '${realGit}' "$@"`,
    ].join("\n"),
  )

const mergeTreeCalls = (log: string) =>
  Effect.promise(() => fs.readFile(log, "utf8")).pipe(Effect.map((text) => text.split("\n").filter(Boolean)))

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

describe("ArenaGit on git 2.38 and 2.39", () => {
  it.live("classifies divergence without merge-tree --merge-base", () =>
    Effect.gen(function* () {
      const { log } = yield* git239()
      const canonical = yield* scopedTmpdir({ git: true })
      const candidateA = yield* scopedTmpdir()
      const candidateB = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/greet.py`, "def greet():\n    pass\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/notes.txt`, "one\ntwo\nthree\nfour\nfive\n", "utf8"))
      yield* Effect.promise(() => $`git add -A && git commit -m base`.cwd(canonical.path).quiet())
      const base = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      for (const candidate of [candidateA, candidateB]) {
        yield* Effect.promise(() => $`git worktree add --detach ${candidate.path} ${base}`.cwd(canonical.path).quiet())
      }
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [candidateA, candidateB].map((candidate) =>
            Effect.promise(() =>
              $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
            ).pipe(Effect.ignore),
          ),
          { concurrency: 2, discard: true },
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(`${candidateA.path}/greet.py`, 'def greet():\n    return "hello from A"\n', "utf8"),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidateA.path}/notes.txt`, "ONE\ntwo\nthree\nfour\nfive\n", "utf8"))
      yield* Effect.promise(() =>
        fs.writeFile(`${candidateB.path}/greet.py`, 'def greet():\n    print("hello from B")\n', "utf8"),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidateB.path}/notes.txt`, "one\ntwo\nthree\nfour\nFIVE\n", "utf8"))
      const a = yield* finalize({ worktree: candidateA.path, baseSHA: base, permanentRef: "refs/battles/old-git/a" })
      const b = yield* finalize({ worktree: candidateB.path, baseSHA: base, permanentRef: "refs/battles/old-git/b" })

      const evidence = yield* compare({
        canonical: canonical.path,
        baseCommit: base,
        aCommit: a.finalCommit,
        bCommit: b.finalCommit,
      })
      const status = Object.fromEntries((evidence.divergence?.files ?? []).map((file) => [file.file, file.status]))
      expect(status).toEqual({ "greet.py": "diverging", "notes.txt": "compatible" })
      const merged = evidence.divergence?.files.find((file) => file.file === "greet.py")?.merged?.content ?? ""
      expect(merged).toContain("|||||||")
      expect(merged).toContain('return "hello from A"')
      expect(merged).toContain('print("hello from B")')
      expect(yield* mergeTreeCalls(log)).toHaveLength(1)
    }),
  )

  it.live("applies a result over a changed checkout without merge-tree --merge-base", () =>
    Effect.gen(function* () {
      const { log } = yield* git239()
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/conflict.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/clean.txt`, "one\ntwo\nthree\nfour\nfive\n", "utf8"))
      yield* Effect.promise(() => $`git add -A && git commit -m seed`.cwd(canonical.path).quiet())
      const head = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const branch = (yield* Effect.promise(() =>
        $`git branch --show-current`.cwd(canonical.path).quiet().text(),
      )).trim()
      const base = yield* snapshotBase({ canonical: canonical.path, permanentRef: "refs/battles/old-git-apply/base" })
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${base.baseCommit}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/conflict.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/clean.txt`, "ONE\ntwo\nthree\nfour\nfive\n", "utf8"))
      const result = yield* finalize({
        worktree: candidate.path,
        baseSHA: base.baseCommit,
        permanentRef: "refs/battles/old-git-apply/a",
      })
      const indexTree = (yield* Effect.promise(() => $`git write-tree`.cwd(canonical.path).quiet().text())).trim()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/conflict.txt`, "canonical\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/clean.txt`, "one\ntwo\nthree\nfour\nFIVE\n", "utf8"))

      const applied = yield* applySnapshot({
        canonical: canonical.path,
        expectedCanonicalHead: head,
        expectedBranch: branch,
        expectedBaseCommit: base.baseCommit,
        expectedBaseTree: base.baseTree,
        expectedIndexTree: indexTree,
        resultCommit: result.finalCommit,
      })
      expect(applied.conflicts).toEqual(["conflict.txt"])
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/clean.txt`, "utf8"))).toBe(
        "ONE\ntwo\nthree\nfour\nFIVE\n",
      )
      const conflicted = yield* Effect.promise(() => fs.readFile(`${canonical.path}/conflict.txt`, "utf8"))
      expect(conflicted).toContain("canonical\n")
      expect(conflicted).toContain("winner\n")
      expect((yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()).toBe(head)
      expect(yield* mergeTreeCalls(log)).toHaveLength(1)
    }),
  )

  it.live("promotes a winner over public edits without merge-tree --merge-base", () =>
    Effect.gen(function* () {
      const { log } = yield* git239()
      const canonical = yield* scopedTmpdir({ git: true })
      const candidate = yield* scopedTmpdir()
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "base\n", "utf8"))
      yield* Effect.promise(() => $`git add shared.txt && git commit -m base`.cwd(canonical.path).quiet())
      const frozenHead = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(canonical.path).quiet().text())).trim()
      const baseTree = (yield* Effect.promise(() =>
        $`git rev-parse HEAD^{tree}`.cwd(canonical.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() =>
        $`git worktree add --detach ${candidate.path} ${frozenHead}`.cwd(canonical.path).quiet(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove --force ${candidate.path}`.cwd(canonical.path).quiet().nothrow(),
        ).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/shared.txt`, "winner\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${candidate.path}/winner.txt`, "winner\n", "utf8"))
      const winner = yield* finalize({
        worktree: candidate.path,
        baseSHA: frozenHead,
        permanentRef: "refs/battles/old-git-promote/a",
      })
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/shared.txt`, "public\n", "utf8"))
      yield* Effect.promise(() => fs.writeFile(`${canonical.path}/public.txt`, "public\n", "utf8"))

      const promoted = yield* promoteWinnerState({
        canonical: canonical.path,
        frozenHead,
        baseWorkingTree: baseTree,
        baseIndexTree: baseTree,
        resultCommit: winner.finalCommit,
        finalIndexTree: winner.finalIndexTree,
        safetyRef: "refs/battles/old-git-promote/safety",
      })
      expect(promoted.conflicts).toEqual(["shared.txt"])
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/winner.txt`, "utf8"))).toBe("winner\n")
      expect(yield* Effect.promise(() => fs.readFile(`${canonical.path}/public.txt`, "utf8"))).toBe("public\n")
      const conflicted = yield* Effect.promise(() => fs.readFile(`${canonical.path}/shared.txt`, "utf8"))
      expect(conflicted).toContain("<<<<<<<")
      expect(conflicted).toContain("public\n")
      expect(conflicted).toContain("winner\n")
      expect((yield* mergeTreeCalls(log)).length).toBeGreaterThan(0)
    }),
  )
})

describe("ArenaGit battle git check", () => {
  const check = Effect.gen(function* () {
    const cwd = yield* scopedTmpdir()
    return refusal(yield* Effect.exit(requireBattleGit(cwd.path)))
  })

  it.live("admits git 2.38 and newer", () =>
    Effect.gen(function* () {
      for (const version of ["2.38.0", "2.39.5 (Apple Git-154)", "2.54.0", "3.0.0", "2.45.1.windows.1"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fakeGit(`echo "git version ${version}"`)
            expect(yield* check).toBeUndefined()
          }),
        )
      }
    }),
  )

  it.live("refuses git older than 2.38 with the version it found", () =>
    Effect.gen(function* () {
      yield* fakeGit('echo "git version 2.37.1 (Apple Git-137.1)"')
      const message = yield* check
      expect(message).toContain("Git 2.38 or newer")
      expect(message).toContain("2.37.1")
    }),
  )

  it.live("asks for the Xcode license when git refuses to run without it", () =>
    Effect.gen(function* () {
      yield* fakeGit(
        "echo \"You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\" >&2\nexit 69",
      )
      expect(yield* check).toContain("sudo xcodebuild -license")
    }),
  )

  it.live("asks to install git when the Command Line Tools are missing", () =>
    Effect.gen(function* () {
      yield* fakeGit(
        'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2\nexit 1',
      )
      expect(yield* check).toContain("Install Git")
    }),
  )

  it.live("asks to install git when there is no git on PATH", () =>
    Effect.gen(function* () {
      const empty = yield* scopedTmpdir()
      const previous = process.env.PATH
      process.env.PATH = empty.path
      const message = yield* check.pipe(Effect.ensuring(Effect.sync(() => (process.env.PATH = previous))))
      expect(message).toContain("Install Git")
    }),
  )
})
