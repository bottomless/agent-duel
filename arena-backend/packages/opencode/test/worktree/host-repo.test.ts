import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { parseIgnoredPaths } from "@/arena/warm"
import { copyGitState } from "@/worktree/git-state"

const roots: string[] = []

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/** `/.agent-duel/` in `info/exclude`, anchored to the checkout root. */
function excludeLocalState(checkoutRoot: string) {
  const file = path.join(checkoutRoot, ".git", "info", "exclude")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, "/.agent-duel/\n")
}

/** What `markConfigBoundary` writes: the eslintrc cascade stops at the local state. */
function markConfigBoundary(checkoutRoot: string) {
  const file = path.join(checkoutRoot, ".agent-duel", ".eslintrc.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ "root": true }\n')
}

/** Stands in for the repository the user works in. */
function checkout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "host-repo-"))
  roots.push(root)
  git(root, "init", "--initial-branch=main")
  writeFileSync(path.join(root, "file.txt"), "checkout")
  git(root, "add", ".")
  git(root, "commit", "-m", "first")
  return { root, head: git(root, "rev-parse", "HEAD"), branch: "main" }
}

/**
 * What `ensureHostRepo` builds: a copy of the checkout's git directory without its worktree
 * registrations, and the exclusion that keeps the checkout blind to everything under the
 * local-state directory.
 */
async function hostRepo(checkoutRoot: string, directory: string) {
  const host = `${directory}.git`
  mkdirSync(path.dirname(host), { recursive: true })
  excludeLocalState(checkoutRoot)
  markConfigBoundary(checkoutRoot)
  await copyGitState({ source: path.join(checkoutRoot, ".git"), target: host })
  return host
}

async function contestant(checkoutRoot: string, name: string, ref: string, branch: string) {
  const directory = path.join(checkoutRoot, ".agent-duel", "worktrees", name)
  const host = await hostRepo(checkoutRoot, directory)
  git(host, "worktree", "add", "--no-checkout", "-B", branch, directory, ref)
  git(directory, "reset", "--hard")
  return { host, directory }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("a contestant worktree registered in a repository of its own", () => {
  // The whole point. A contestant used to be a worktree of the user's checkout, which meant
  // its branch showed up in the user's `git branch` and its registration in their
  // `git worktree list`. Neither is a thing the user asked for or can act on.
  test("keeps its branch and its registration out of the checkout", async () => {
    const { root, head, branch } = checkout()
    const worktreesBefore = git(root, "worktree", "list", "--porcelain")

    const { directory } = await contestant(root, "agent-a", head, branch)
    writeFileSync(path.join(directory, "file.txt"), "contestant")
    git(directory, "commit", "-am", "contestant work")

    expect(git(root, "branch", "--list")).toBe("* main")
    expect(git(root, "worktree", "list", "--porcelain")).toBe(worktreesBefore)
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main")
  })

  // Asked for by name: a contestant should be able to work on the branch the user is on, so
  // its `git diff <branch>...` and `git log <branch>..` mean what the model expects them to.
  // Two repositories is what makes the name free — as one worktree of the checkout, this is
  // the case git refuses outright with "already used by worktree at".
  test("can hold the branch name the checkout has checked out", async () => {
    const { root, head, branch } = checkout()

    const { directory } = await contestant(root, "agent-a", head, branch)

    expect(git(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch)
    writeFileSync(path.join(directory, "file.txt"), "contestant")
    git(directory, "commit", "-am", "contestant work")

    // Same name, unrelated refs: the contestant's commit moved its own branch and nothing else.
    expect(git(root, "rev-parse", branch)).toBe(head)
    expect(git(directory, "rev-parse", branch)).not.toBe(head)
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  test("gives both sides the same branch name without either seeing the other", async () => {
    const { root, head, branch } = checkout()

    const a = await contestant(root, "agent-a", head, branch)
    const b = await contestant(root, "agent-b", head, branch)
    writeFileSync(path.join(a.directory, "file.txt"), "from a")
    git(a.directory, "commit", "-am", "a")

    expect(git(b.directory, "rev-parse", "HEAD")).toBe(head)
    expect(git(b.directory, "branch", "--list")).toBe(`* ${branch}`)
  })

  // Copied, not borrowed: the contestant repository holds the checkout's objects, so it
  // resolves them with no reference back to the checkout.
  test("owns a copy of the checkout's objects", async () => {
    const { root, head, branch } = checkout()

    const { host, directory } = await contestant(root, "agent-a", head, branch)

    expect(existsSync(path.join(host, "objects", "info", "alternates"))).toBe(false)
    expect(git(host, "cat-file", "-t", head)).toBe("commit")
    expect(readFileSync(path.join(directory, "file.txt"), "utf8")).toBe("checkout")
  })

  // A moved checkout takes the contestant repositories with it — they are inside it — and
  // each still resolves every object, because nothing in it points at the old path.
  test("keeps resolving objects when the checkout moves", async () => {
    const { root, head, branch } = checkout()
    const { host } = await contestant(root, "agent-a", head, branch)
    const moved = `${root}-moved`
    roots.push(moved)

    execFileSync("mv", [root, moved])
    const movedHost = host.replace(root, moved)
    expect(() => git(movedHost, "cat-file", "-e", `${head}^{commit}`)).not.toThrow()
  })
})

describe("bringing a contestant's result back", () => {
  // Everything that reads a finished turn reads it from the checkout, so the result has to
  // travel. It travels as objects the contestant wrote and a ref naming the turn — never as
  // the branch, which means nothing outside the repository it was made in.
  test("imports the result commit into the checkout without touching a branch", async () => {
    const { root, head, branch } = checkout()
    const { host, directory } = await contestant(root, "agent-a", head, branch)
    writeFileSync(path.join(directory, "file.txt"), "contestant")
    git(directory, "commit", "-am", "contestant work")
    const result = git(directory, "rev-parse", "HEAD")
    const ref = "refs/battles/chat/turn-0/a"
    git(host, "update-ref", ref, result)

    git(root, "fetch", "--no-tags", "--no-write-fetch-head", host, `+${ref}:${ref}`)

    expect(git(root, "rev-parse", `${result}^{commit}`)).toBe(result)
    expect(git(root, "rev-parse", ref)).toBe(result)
    expect(git(root, "branch", "--list")).toBe("* main")
    expect(git(root, "rev-parse", branch)).toBe(head)
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  // Why the import targets `refs/battles/...` and not the branch the result was made on.
  // Git refuses to fetch into a branch that is checked out, and with the contestant on the
  // user's branch name that is exactly the collision an import onto a branch would hit.
  test("git refuses to fetch into the branch the checkout has checked out", async () => {
    const { root, head, branch } = checkout()
    const { host, directory } = await contestant(root, "agent-a", head, branch)
    writeFileSync(path.join(directory, "file.txt"), "contestant")
    git(directory, "commit", "-am", "contestant work")

    expect(() =>
      git(root, "fetch", host, `+refs/heads/${branch}:refs/heads/${branch}`),
    ).toThrow(/refusing to fetch into branch/)
  })

  // Removing the loser's worktree is a command against the repository that holds the
  // registration. Run against the checkout it finds nothing to remove and leaves the
  // directory and its admin entry behind.
  test("the worktree is removed through its own repository", async () => {
    const { root, head, branch } = checkout()
    const { host, directory } = await contestant(root, "agent-a", head, branch)

    expect(git(host, "worktree", "list", "--porcelain")).toContain(directory)
    git(host, "worktree", "remove", "--force", directory)

    expect(existsSync(directory)).toBe(false)
    // Only the bare repository itself is left in the list.
    expect(
      git(host, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(1)
    // The branch outlives the directory, which is what the next turn force-points at its base.
    expect(git(host, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe(branch)
  })
})

describe("keeping the checkout blind to what is built inside it", () => {
  // The layout's whole point: deleting the repository deletes every trace of the battles
  // that ran against it. Nothing is left behind in a data directory to find later.
  test("puts the contestant and its repository inside the checkout", async () => {
    const { root, head, branch } = checkout()

    const { host, directory } = await contestant(root, "agent-a", head, branch)

    expect(directory.startsWith(`${root}${path.sep}`)).toBe(true)
    expect(host.startsWith(`${root}${path.sep}`)).toBe(true)
    expect(existsSync(path.join(root, ".agent-duel", "worktrees", "agent-a"))).toBe(true)
  })

  // A turn reads the checkout's cleanliness to decide what it may apply, so a battle in
  // progress showing up as untracked changes would block applying its own winner.
  test("leaves the checkout clean while a contestant is working", async () => {
    const { root, head, branch } = checkout()

    const { directory } = await contestant(root, "agent-a", head, branch)
    writeFileSync(path.join(directory, "file.txt"), "contestant")
    git(directory, "commit", "-am", "contestant work")

    expect(git(root, "status", "--porcelain")).toBe("")
  })

  // The trap the exclusion sets: ignored paths are how a prepared worktree's dependencies
  // are carried to the other side, and this directory is now one of them. Copying it would
  // hand each side a copy of every side, including the one being prepared.
  test("reports the battle as untracked changes without the exclusion", async () => {
    const { root, head, branch } = checkout()
    await contestant(root, "agent-a", head, branch)
    writeFileSync(path.join(root, ".git", "info", "exclude"), "")

    expect(git(root, "status", "--porcelain")).toBe("?? .agent-duel/")
  })

  test("lists the local state as ignored, which is why the seed filters it", async () => {
    const { root, head, branch } = checkout()
    await contestant(root, "agent-a", head, branch)

    const ignored = git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory")

    expect(ignored.split("\n")).toContain(".agent-duel/")
    expect(parseIgnoredPaths(ignored.split("\n").join("\0"))).toEqual([])
  })
})

// A contestant worktree inside the checkout puts the checkout on every ancestor walk that
// starts inside it. ESLint merges what it finds on the way up, so it reached the project's
// own configuration twice, from two `node_modules` trees, and refused to run: "ESLint
// couldn't determine the plugin 'react' uniquely". The contestant's dev server failed on a
// project that builds fine anywhere else.
describe("tools that read ancestor directories", () => {
  test("stop at the local state rather than reaching the checkout", async () => {
    const { root, head, branch } = checkout()
    writeFileSync(path.join(root, ".eslintrc.json"), JSON.stringify({ plugins: ["react"] }))
    git(root, "add", ".")
    git(root, "commit", "-m", "eslint config")
    const { directory } = await contestant(root, "agent-a", head, branch)

    const localState = path.join(root, ".agent-duel")
    expect(JSON.parse(readFileSync(path.join(localState, ".eslintrc.json"), "utf8"))).toEqual({ root: true })
    // The boundary sits between the two: a walk up from the worktree meets it before the
    // checkout's own config, which is the one that would have been found twice.
    expect(directory.startsWith(`${localState}${path.sep}`)).toBe(true)
    expect(localState.startsWith(`${root}${path.sep}`)).toBe(true)
  })
})
