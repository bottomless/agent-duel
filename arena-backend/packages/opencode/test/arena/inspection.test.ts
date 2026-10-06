import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { finalizedFile, finalizedTree, liveFile, liveTree, repositoryPath } from "../../src/arena/inspection"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ArenaInspection", () => {
  test("accepts only bounded repository-relative POSIX file paths", () => {
    expect(repositoryPath("src/index.ts")).toBe("src/index.ts")
    for (const path of [
      "",
      "./src/index.ts",
      "src//index.ts",
      "/etc/passwd",
      "../secret",
      "src/../../secret",
      "src\\..\\secret",
      "C:\\secret",
      ".git/config",
      "src/.GIT/config",
      ".git./config",
      "src/trailing ",
      "bad\0path",
      "bad\npath",
      "stream:secret",
    ]) {
      expect(() => repositoryPath(path)).toThrow()
    }
    expect(() => repositoryPath("a".repeat(10), { maxPathBytes: 9 })).toThrow()
    expect(() => repositoryPath(Array.from({ length: 129 }, () => "a").join("/"))).toThrow()
  })

  test("reads a bounded live tree and never follows worktree symlinks", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await mkdir(join(root.path, ".git"))
    await mkdir(join(root.path, "src"))
    await writeFile(join(root.path, ".git", "private"), "hidden")
    await writeFile(join(root.path, "src", "index.ts"), "hello world")
    await writeFile(join(root.path, "binary.bin"), new Uint8Array([0, 1, 255]))
    await writeFile(join(outside.path, "secret.txt"), "outside secret")
    await symlink(outside.path, join(root.path, "escape"))

    const tree = await liveTree(root.path)
    expect(tree.source).toBe("live")
    expect(tree.entries.map((entry) => entry.path)).toEqual(["binary.bin", "escape", "src", "src/index.ts"])
    expect(tree.entries.find((entry) => entry.path === "escape")?.type).toBe("symlink")
    expect(tree.entries.some((entry) => entry.path.includes("private") || entry.path.includes("secret"))).toBe(false)

    const limited = await liveTree(root.path, { maxTreeEntries: 2 })
    expect(limited.entryCount).toBe(2)
    expect(limited.truncated).toBe(true)
    const byteLimited = await liveTree(root.path, { maxTreeOutputBytes: 1 })
    expect(byteLimited.entryCount).toBe(0)
    expect(byteLimited.truncated).toBe(true)

    const text = await liveFile(root.path, "src/index.ts", { maxFileBytes: 5 })
    expect(text).toMatchObject({
      type: "file",
      size: 11,
      returnedBytes: 5,
      truncated: true,
      binary: false,
      encoding: "utf8",
      content: "hello",
      hash: { scope: "returned_prefix" },
    })
    const binary = await liveFile(root.path, "binary.bin")
    expect(binary).toMatchObject({ binary: true, encoding: "base64", content: "AAH/", truncated: false })
    const link = await liveFile(root.path, "escape")
    expect(link.type).toBe("symlink")
    expect(link.content).toBe(outside.path)
    expect(link.content).not.toContain("outside secret")
    const escaped = await liveFile(root.path, "escape/secret.txt").then(
      () => undefined,
      (error) => error,
    )
    const metadata = await liveFile(root.path, ".git/private").then(
      () => undefined,
      (error) => error,
    )
    expect(escaped).toBeInstanceOf(Error)
    expect(metadata).toBeInstanceOf(Error)
    expect(metadata).toHaveProperty("message", expect.stringContaining("Git metadata"))
  })

  it.live("reads finalized files from retained Git objects after working files disappear", () =>
    Effect.gen(function* () {
      const repository = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await mkdir(join(repository.path, "src"))
        await writeFile(join(repository.path, "src", "index.ts"), "hello finalized")
        await writeFile(join(repository.path, "binary.bin"), new Uint8Array([0, 2, 255]))
        await writeFile(join(repository.path, "literal[1].txt"), "literal")
        await symlink("src/index.ts", join(repository.path, "link"))
        await $`git add -A`.cwd(repository.path).quiet()
        await $`git commit -m finalized`.cwd(repository.path).quiet()
      })
      const commit = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(repository.path).quiet().text())).trim()
      const tree = (yield* Effect.promise(() =>
        $`git rev-parse HEAD^{tree}`.cwd(repository.path).quiet().text(),
      )).trim()
      const ref = "refs/battles/turn-1/a"
      yield* Effect.promise(() => $`git update-ref ${ref} ${commit}`.cwd(repository.path).quiet())
      yield* Effect.promise(() =>
        Promise.all([
          rm(join(repository.path, "src"), { recursive: true }),
          rm(join(repository.path, "binary.bin")),
          rm(join(repository.path, "literal[1].txt")),
          rm(join(repository.path, "link")),
        ]),
      )

      const result = yield* finalizedTree({ repository: repository.path, commit, tree, ref })
      expect(result.source).toBe("finalized")
      expect(result.revision).toEqual({ commit, ref })
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "binary.bin",
        "link",
        "literal[1].txt",
        "src",
        "src/index.ts",
      ])

      const limited = yield* finalizedTree({
        repository: repository.path,
        commit,
        tree,
        ref,
        limits: { maxTreeEntries: 2 },
      })
      expect(limited.entryCount).toBe(2)
      expect(limited.truncated).toBe(true)

      const text = yield* finalizedFile({
        repository: repository.path,
        commit,
        tree,
        ref,
        path: "src/index.ts",
        limits: { maxFileBytes: 5 },
      })
      expect(text).toMatchObject({
        source: "finalized",
        type: "file",
        content: "hello",
        returnedBytes: 5,
        truncated: true,
        hash: { scope: "returned_prefix" },
      })
      const binary = yield* finalizedFile({ repository: repository.path, commit, tree, ref, path: "binary.bin" })
      expect(binary).toMatchObject({ binary: true, encoding: "base64", content: "AAL/" })
      const literal = yield* finalizedFile({ repository: repository.path, commit, tree, ref, path: "literal[1].txt" })
      expect(literal.content).toBe("literal")
      const link = yield* finalizedFile({ repository: repository.path, commit, tree, ref, path: "link" })
      expect(link).toMatchObject({ type: "symlink", content: "src/index.ts" })
      const directory = yield* Effect.exit(
        finalizedFile({ repository: repository.path, commit, tree, ref, path: "src" }),
      )
      expect(Exit.isFailure(directory)).toBe(true)

      const parent = (yield* Effect.promise(() =>
        $`git rev-parse ${commit}^`.cwd(repository.path).quiet().text(),
      )).trim()
      yield* Effect.promise(() => $`git update-ref ${ref} ${parent}`.cwd(repository.path).quiet())
      const movedRef = yield* Effect.exit(
        finalizedFile({ repository: repository.path, commit, tree, ref, path: "src/index.ts" }),
      )
      expect(Exit.isFailure(movedRef)).toBe(true)
      yield* Effect.promise(() => $`git update-ref ${ref} ${commit}`.cwd(repository.path).quiet())
      const parentTree = (yield* Effect.promise(() =>
        $`git rev-parse ${parent}^{tree}`.cwd(repository.path).quiet().text(),
      )).trim()
      const mismatchedTree = yield* Effect.exit(
        finalizedTree({ repository: repository.path, commit, tree: parentTree, ref }),
      )
      expect(Exit.isFailure(mismatchedTree)).toBe(true)
    }),
  )
})
