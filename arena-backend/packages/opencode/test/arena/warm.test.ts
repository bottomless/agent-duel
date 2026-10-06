import { describe, expect, test } from "bun:test"
import path from "path"
import { parseIgnoredPaths, warmSeed } from "../../src/arena/warm"

describe("Arena warm copies", () => {
  test("deduplicates ignored roots and excludes repository-local Arena state", () => {
    expect(
      parseIgnoredPaths(
        [
          "node_modules/",
          "node_modules/",
          ".env",
          ".git",
          ".git/worktrees/x",
          ".agent-duel/",
          ".agent-duel/worktrees/a",
        ].join("\0"),
      ),
    ).toEqual(["node_modules", ".env"])
  })

  test("drops a listed path that sits inside a listed directory", () => {
    expect(
      parseIgnoredPaths([".claude/", ".claude/settings.local.json", ".husky/_/", ".husky/_/husky.sh"].join("\0")),
    ).toEqual([".claude", ".husky/_"])
  })

  test("maps ignored roots from the prepared side into the same relative targets", () => {
    expect(warmSeed("/tmp/prepared", ["node_modules", "packages/app/node_modules"])).toEqual([
      { source: path.join("/tmp/prepared", "node_modules"), target: "node_modules" },
      {
        source: path.join("/tmp/prepared", "packages/app/node_modules"),
        target: "packages/app/node_modules",
      },
    ])
  })
})
