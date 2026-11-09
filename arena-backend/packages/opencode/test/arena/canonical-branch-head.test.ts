import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { branchFromHeadFile } from "@/arena/git"

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "canonical-branch-")))
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const checkout = path.join(root, "checkout")
git(root, "init", "-q", "-b", "main", checkout)
writeFileSync(path.join(checkout, "a.txt"), "a\n")
git(checkout, "add", "a.txt")
git(checkout, "commit", "-q", "-m", "a")

afterAll(() => rmSync(root, { recursive: true, force: true }))

// The stream poll reads HEAD instead of starting Git every second; it must answer as Git does.
describe("the canonical branch read from HEAD", () => {
  it("names the checked-out branch", async () => {
    git(checkout, "switch", "-q", "-c", "feature/x")
    expect(await branchFromHeadFile(checkout)).toEqual({ branch: "feature/x" })
    git(checkout, "switch", "-q", "main")
    expect(await branchFromHeadFile(checkout)).toEqual({ branch: "main" })
  })

  it("answers no branch for a detached HEAD", async () => {
    git(checkout, "switch", "-q", "--detach")
    expect(await branchFromHeadFile(checkout)).toEqual({ branch: undefined })
    git(checkout, "switch", "-q", "main")
  })

  it("follows a linked worktree's .git file", async () => {
    const linked = path.join(root, "linked")
    git(checkout, "worktree", "add", "-q", "-b", "side", linked)
    expect(await branchFromHeadFile(linked)).toEqual({ branch: "side" })
  })

  it("leaves what it cannot read to Git", async () => {
    expect(await branchFromHeadFile(path.join(root, "missing"))).toBeUndefined()
  })
})
