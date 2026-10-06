import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { cp } from "fs/promises"
import os from "os"
import path from "path"
import { copyGitState, isExcludedGitEntry } from "@/worktree/git-state"

const roots: string[] = []

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function checkout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "git-state-"))
  roots.push(root)
  git(root, "init", "--initial-branch=main")
  writeFileSync(path.join(root, "file.txt"), "checkout")
  git(root, "add", ".")
  git(root, "commit", "-m", "first")
  git(root, "branch", "feature")
  git(root, "tag", "-a", "v1", "-m", "v1")
  git(root, "remote", "add", "origin", "https://example.invalid/repo.git")
  git(root, "config", "user.signingkey", "ABCDEF")
  const hooks = path.join(root, ".git", "hooks")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  // A linked worktree registration, which must not reach the copy.
  const linked = path.join(root, "..", `${path.basename(root)}-linked`)
  git(root, "worktree", "add", "--detach", linked, "HEAD")
  roots.push(linked)
  writeFileSync(path.join(root, ".git", "index.lock"), "")
  writeFileSync(path.join(root, ".git", "MERGE_MSG"), "merge\n")
  return {
    root,
    head: git(root, "rev-parse", "HEAD"),
    tag: git(root, "rev-parse", "refs/tags/v1"),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("copyGitState", () => {
  test.skipIf(process.platform === "win32")("preserves a private source git directory's permissions", async () => {
    const { root } = checkout()
    const source = path.join(root, ".git")
    const target = path.join(root, ".agent-duel", "private.git")
    chmodSync(source, 0o700)

    await copyGitState({ source, target })

    expect(statSync(target).mode & 0o777).toBe(0o700)
  })

  test("keeps each host's objects independent after the source is removed", async () => {
    const { root, head } = checkout()
    const hosts = mkdtempSync(path.join(os.tmpdir(), "git-state-independent-"))
    roots.push(hosts)
    const a = path.join(hosts, "a.git")
    const b = path.join(hosts, "b.git")
    await copyGitState({ source: path.join(root, ".git"), target: a })
    await copyGitState({ source: path.join(root, ".git"), target: b })
    rmSync(root, { recursive: true, force: true })

    expect(git(a, "cat-file", "-t", head)).toBe("commit")
    expect(git(b, "cat-file", "-t", head)).toBe("commit")
    const object = path.join("objects", head.slice(0, 2), head.slice(2))
    const original = readFileSync(path.join(b, object))
    chmodSync(path.join(a, object), 0o644)
    writeFileSync(path.join(a, object), "changed host object")
    expect(readFileSync(path.join(b, object))).toEqual(original)
    expect(git(b, "cat-file", "-t", head)).toBe("commit")
    expect(existsSync(path.join(b, "objects", "info", "alternates"))).toBe(false)
  })

  test("clones the whole git directory once and prunes what the filter would skip", async () => {
    const { root, head, tag } = checkout()
    const source = path.join(root, ".git")
    const target = path.join(root, ".agent-duel", "whole.git")
    writeFileSync(path.join(source, "refs", "heads", "feature.lock"), "")
    const calls: string[] = []
    await copyGitState({
      source,
      target,
      clone: async (from, destination) => {
        calls.push(from)
        await cp(from, destination, { recursive: true, verbatimSymlinks: true })
        return "clonefile"
      },
    })

    expect(calls).toEqual([source])
    expect(existsSync(path.join(target, "worktrees"))).toBe(false)
    expect(existsSync(path.join(target, "index.lock"))).toBe(false)
    expect(existsSync(path.join(target, "refs", "heads", "feature.lock"))).toBe(false)
    expect(existsSync(path.join(target, "MERGE_MSG"))).toBe(true)
    expect(git(target, "config", "--get", "core.bare")).toBe("true")
    expect(git(target, "rev-parse", "feature")).toBe(head)
    expect(git(target, "rev-parse", "refs/tags/v1")).toBe(tag)
    expect(git(target, "worktree", "list", "--porcelain")).not.toContain("-linked")
  })

  test("falls back to the filtered copy after an unsupported partial clone", async () => {
    const { root, head } = checkout()
    const target = path.join(root, ".agent-duel", "fallback.git")
    await copyGitState({
      source: path.join(root, ".git"),
      target,
      clone: async (_source, destination) => {
        mkdirSync(destination, { recursive: true })
        writeFileSync(path.join(destination, "incomplete-clone"), "partial")
        return undefined
      },
    })

    expect(git(target, "cat-file", "-t", head)).toBe("commit")
    expect(existsSync(path.join(target, "objects", "incomplete-clone"))).toBe(false)
    expect(existsSync(path.join(target, "index.lock"))).toBe(false)
    expect(existsSync(`${target}.partial`)).toBe(false)
  })

  test("discards a cloned object tree containing a nested lock", async () => {
    const { root, head } = checkout()
    const target = path.join(root, ".agent-duel", "locked-objects.git")
    writeFileSync(path.join(root, ".git", "objects", "info", "test.lock"), "lock")
    await copyGitState({
      source: path.join(root, ".git"),
      target,
      clone: async (source, destination) => {
        await cp(source, destination, { recursive: true })
        writeFileSync(path.join(destination, "clone-only"), "must be discarded")
        return "clonefile"
      },
    })

    expect(existsSync(path.join(target, "objects", "info", "test.lock"))).toBe(false)
    expect(existsSync(path.join(target, "objects", "clone-only"))).toBe(false)
    expect(git(target, "cat-file", "-t", head)).toBe("commit")
  })

  test("preserves the filtered copy's relative symlink resolution", async () => {
    const { root } = checkout()
    const target = path.join(root, ".agent-duel", "linked-objects.git")
    const linkedFile = path.join(root, ".git", "object-metadata")
    writeFileSync(linkedFile, "metadata")
    symlinkSync("../../object-metadata", path.join(root, ".git", "objects", "info", "linked"))
    await copyGitState({
      source: path.join(root, ".git"),
      target,
      clone: async (source, destination) => {
        await cp(source, destination, { recursive: true, verbatimSymlinks: true })
        writeFileSync(path.join(destination, "clone-only"), "must be discarded")
        return "clonefile"
      },
    })

    const copiedLink = path.join(target, "objects", "info", "linked")
    expect(readlinkSync(copiedLink)).toBe(linkedFile)
    expect(readFileSync(copiedLink, "utf8")).toBe("metadata")
    expect(existsSync(path.join(target, "objects", "clone-only"))).toBe(false)
  })

  test.skipIf(process.platform === "win32")("discards special files introduced in a completed object clone", async () => {
    const { root, head } = checkout()
    const target = path.join(root, ".agent-duel", "special-objects.git")
    await copyGitState({
      source: path.join(root, ".git"),
      target,
      clone: async (source, destination) => {
        await cp(source, destination, { recursive: true })
        execFileSync("mkfifo", [path.join(destination, "pipe")])
        return "clonefile"
      },
    })

    expect(existsSync(path.join(target, "objects", "pipe"))).toBe(false)
    expect(git(target, "cat-file", "-t", head)).toBe("commit")
  })

  test("copies everything but the worktree registrations and lock files", async () => {
    const { root, head, tag } = checkout()
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    expect(existsSync(path.join(target, "HEAD"))).toBe(true)
    expect(existsSync(path.join(target, "index"))).toBe(true)
    expect(existsSync(path.join(target, "MERGE_MSG"))).toBe(true)
    expect(existsSync(path.join(target, "worktrees"))).toBe(false)
    expect(existsSync(path.join(target, "index.lock"))).toBe(false)
    expect(existsSync(path.join(target, "objects", "info", "alternates"))).toBe(false)
    expect(existsSync(`${target}.partial`)).toBe(false)
    expect(readFileSync(path.join(target, "hooks", "pre-commit"), "utf8")).toContain("exit 0")
    expect(git(target, "config", "--get", "core.bare")).toBe("true")
    expect(git(target, "config", "--get", "remote.origin.url")).toBe("https://example.invalid/repo.git")
    expect(git(target, "config", "--get", "user.signingkey")).toBe("ABCDEF")
    expect(git(target, "rev-parse", "feature")).toBe(head)
    expect(git(target, "rev-parse", "refs/tags/v1")).toBe(tag)
    expect(git(target, "cat-file", "-t", head)).toBe("commit")
    expect(git(target, "worktree", "list", "--porcelain")).not.toContain("-linked")
  })

  test("unsets core.worktree so the host never points at the checkout", async () => {
    const { root } = checkout()
    git(root, "config", "core.worktree", root)
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    expect(() => git(target, "config", "--get", "core.worktree")).toThrow()
  })

  test("rewrites a relative alternates line to an absolute path", async () => {
    const { root, head } = checkout()
    const shared = mkdtempSync(path.join(os.tmpdir(), "git-state-shared-"))
    roots.push(shared)
    git(shared, "init", "--bare")
    const info = path.join(root, ".git", "objects", "info")
    mkdirSync(info, { recursive: true })
    const relative = path.relative(path.join(root, ".git", "objects"), path.join(shared, "objects"))
    writeFileSync(path.join(info, "alternates"), `${relative}\n`)
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    expect(readFileSync(path.join(target, "objects", "info", "alternates"), "utf8").trim()).toBe(
      path.join(shared, "objects"),
    )
    expect(git(target, "cat-file", "-t", head)).toBe("commit")
  })

  test("a worktree added to the copy can commit", async () => {
    const { root, head } = checkout()
    const directory = path.join(root, ".agent-duel", "worktrees", "agent-a")
    const target = `${directory}.git`

    await copyGitState({ source: path.join(root, ".git"), target })
    git(target, "worktree", "add", "--no-checkout", "-B", "main", directory, head)
    git(directory, "reset", "--hard")
    writeFileSync(path.join(directory, "side.txt"), "side")
    git(directory, "add", "side.txt")
    git(directory, "commit", "-m", "side")

    expect(git(target, "rev-parse", "main")).not.toBe(head)
    expect(git(root, "rev-parse", "main")).toBe(head)
  })

  test("preserves the pre-commit hook's executable bit", async () => {
    const { root } = checkout()
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    const mode = statSync(path.join(target, "hooks", "pre-commit")).mode
    expect((mode & 0o111) !== 0).toBe(true)
  })

  // Below the top level, only lock files are excluded: a branch literally named `worktrees`
  // lives at `refs/heads/worktrees`, one level down, and must not be mistaken for the
  // registration directory the top-level rule exists to drop.
  test("keeps a branch literally named worktrees", async () => {
    const { root, head } = checkout()
    git(root, "branch", "worktrees")
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    expect(git(target, "rev-parse", "worktrees")).toBe(head)
  })

  // The `.lock` rule is the only one that applies below the top level, and it has to reach
  // that deep: a stale lock beside a ref would block every update to sibling refs too.
  test("skips a lock file nested under refs while keeping its sibling ref", async () => {
    const { root } = checkout()
    writeFileSync(path.join(root, ".git", "refs", "heads", "feature.lock"), "")
    const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

    await copyGitState({ source: path.join(root, ".git"), target })

    expect(existsSync(path.join(target, "refs", "heads", "feature.lock"))).toBe(false)
    expect(existsSync(path.join(target, "refs", "heads", "feature"))).toBe(true)
  })

  // `config.worktree` wins over `config` whenever `extensions.worktreeConfig` is set, so a copied
  // one overrides the bare-ification below it and the host stops being a repository a contestant
  // worktree can attach to.
  test("stays a bare host when the source keeps core.bare and core.worktree per worktree", async () => {
    const { root, head } = checkout()
    rmSync(path.join(root, ".git", "index.lock"))
    git(root, "config", "extensions.worktreeConfig", "true")
    git(root, "config", "--worktree", "core.bare", "false")
    git(root, "config", "--worktree", "core.worktree", root)
    const directory = path.join(root, ".agent-duel", "worktrees", "agent-a")
    const target = `${directory}.git`

    await copyGitState({ source: path.join(root, ".git"), target })

    // The harm first: without the exclusion this call dies with "'main' is already used by
    // worktree at <host>", because the host still believes the developer's checkout is its own.
    git(target, "worktree", "add", "-B", "main", directory, head)
    expect(git(directory, "rev-parse", "HEAD")).toBe(head)
    expect(git(directory, "reset", "--hard")).toContain("HEAD is now at")
    expect(git(directory, "rev-parse", "--is-inside-work-tree")).toBe("true")
    expect(git(target, "rev-parse", "--is-bare-repository")).toBe("true")
    expect(() => git(target, "config", "--get", "core.worktree")).toThrow()
  })

  // The shape from the field: the extension is on, but `core.bare false` is still in the shared
  // config, because git leaves it there unless `git config --worktree` moved it. A shared
  // `core.bare true` then applies to the linked worktree as well and the contestant is bare, so
  // its first work-tree command dies with "this operation must be run in a work tree".
  test("keeps the contestant worktree a work tree when the source has the per-worktree config extension on", async () => {
    const { root, head } = checkout()
    rmSync(path.join(root, ".git", "index.lock"))
    git(root, "config", "extensions.worktreeConfig", "true")
    git(root, "config", "core.bare", "false")
    const directory = path.join(root, ".agent-duel", "worktrees", "agent-a")
    const target = `${directory}.git`

    await copyGitState({ source: path.join(root, ".git"), target })
    git(target, "worktree", "add", "-B", "contestant", directory, head)

    expect(git(directory, "reset", "--hard")).toContain("HEAD is now at")
    expect(git(directory, "rev-parse", "--is-inside-work-tree")).toBe("true")
    writeFileSync(path.join(directory, "side.txt"), "side")
    git(directory, "add", "side.txt")
    git(directory, "commit", "-m", "side")

    expect(git(target, "rev-parse", "--is-bare-repository")).toBe("true")
    expect(readFileSync(path.join(target, "config.worktree"), "utf8")).toContain("bare = true")
    expect(() => git(target, "config", "--file", path.join(target, "config"), "--get", "core.bare")).toThrow()
  })

  // `git sparse-checkout set` turns the per-worktree config on by itself, so this is the quiet
  // half of the same defect: the host stays bare and the battle starts, but the contestant
  // silently works on the developer's partial tree.
  test("does not carry the source's sparse-checkout into a contestant worktree", async () => {
    const { root } = checkout()
    rmSync(path.join(root, ".git", "index.lock"))
    for (const name of ["d1", "d2"]) {
      mkdirSync(path.join(root, name), { recursive: true })
      writeFileSync(path.join(root, name, "file.txt"), name)
    }
    git(root, "add", ".")
    git(root, "commit", "-m", "directories")
    const head = git(root, "rev-parse", "HEAD")
    git(root, "sparse-checkout", "set", "d1")
    expect(existsSync(path.join(root, "d2"))).toBe(false)
    const directory = path.join(root, ".agent-duel", "worktrees", "agent-a")
    const target = `${directory}.git`

    await copyGitState({ source: path.join(root, ".git"), target })
    git(target, "worktree", "add", "-B", "contestant", directory, head)

    expect(existsSync(path.join(directory, "d1", "file.txt"))).toBe(true)
    expect(existsSync(path.join(directory, "d2", "file.txt"))).toBe(true)
  })

  describe("with private ref prefixes", () => {
    const prefixes = ["refs/battles/", "refs/heads/agent-duel/", "refs/agent-duel/"]

    function refs(gitDir: string) {
      return git(gitDir, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)
    }

    // Battle refs pile up in the checkout, so most of them are packed by the time a host is
    // copied. An annotated tag under a private prefix packs with a `^<peeled>` line after it,
    // which has to go with its ref or git reads it as the peel of whatever line is left above.
    test("drops loose and packed private refs, their peeled lines and their reflogs", async () => {
      const { root, head, tag } = checkout()
      git(root, "update-ref", "refs/battles/chat/turn-0/a", head)
      git(root, "update-ref", "refs/battles/chat/turn-0/tagged", tag)
      git(root, "update-ref", "refs/agent-duel/start/heads/main", head)
      git(root, "update-ref", "refs/battles-kept/x", head)
      git(root, "pack-refs", "--all")
      git(root, "update-ref", "--create-reflog", "refs/battles/chat/turn-1/a", head)
      git(root, "update-ref", "--create-reflog", "refs/heads/agent-duel/chat-agent-a", head)
      git(root, "branch", "agent-duel-kept")
      const packed = readFileSync(path.join(root, ".git", "packed-refs"), "utf8")
      expect(packed).toContain("refs/battles/chat/turn-0/tagged\n^")
      expect(existsSync(path.join(root, ".git", "logs", "refs", "heads", "agent-duel"))).toBe(true)
      const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

      await copyGitState({ source: path.join(root, ".git"), target, excludeRefPrefixes: prefixes })

      const copied = refs(target)
      expect(copied.filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)))).toEqual([])
      expect(copied).toContain("refs/battles-kept/x")
      expect(copied).toContain("refs/heads/agent-duel-kept")
      expect(copied).toContain("refs/heads/feature")
      expect(git(target, "rev-parse", "refs/tags/v1^{commit}")).toBe(head)
      const filtered = readFileSync(path.join(target, "packed-refs"), "utf8")
      expect(filtered).not.toContain("refs/battles/")
      expect(filtered).not.toContain("refs/agent-duel/")
      // Every peeled line still follows the tag it belongs to.
      const lines = filtered.split("\n")
      lines.forEach((line, index) => {
        if (line.startsWith("^")) expect(lines[index - 1]).toContain("refs/tags/v1")
      })
      for (const logs of ["refs/battles", "refs/heads/agent-duel", "refs/agent-duel"]) {
        expect(existsSync(path.join(target, "logs", logs))).toBe(false)
      }
      expect(existsSync(path.join(target, "logs", "refs", "heads", "main"))).toBe(true)
      // The checkout keeps them all.
      expect(refs(path.join(root, ".git"))).toContain("refs/battles/chat/turn-0/tagged")
      expect(refs(path.join(root, ".git"))).toContain("refs/heads/agent-duel/chat-agent-a")
    })

    test("leaves a branch named like the namespace itself", async () => {
      const { root, head } = checkout()
      git(root, "branch", "agent-duel")
      const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

      await copyGitState({ source: path.join(root, ".git"), target, excludeRefPrefixes: prefixes })

      expect(git(target, "rev-parse", "refs/heads/agent-duel")).toBe(head)
    })

    // Reftable keeps refs in binary tables that only git may edit. The copy leaves them and the
    // arena mirror purges them through git.
    test("leaves a reftable repository's refs alone", async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "git-state-reftable-"))
      roots.push(root)
      git(root, "init", "--initial-branch=main", "--ref-format=reftable")
      git(root, "commit", "--allow-empty", "-m", "first")
      git(root, "update-ref", "refs/battles/chat/turn-0/a", "HEAD")
      const target = path.join(root, ".agent-duel", "worktrees", "agent-a.git")

      await copyGitState({ source: path.join(root, ".git"), target, excludeRefPrefixes: prefixes })

      expect(refs(target)).toContain("refs/battles/chat/turn-0/a")
      expect(git(target, "rev-parse", "main")).toBe(git(root, "rev-parse", "HEAD"))
    })
  })

  test("names the excluded entries", () => {
    expect(isExcludedGitEntry("worktrees")).toBe(true)
    expect(isExcludedGitEntry("config.worktree")).toBe(true)
    expect(isExcludedGitEntry("fsmonitor--daemon")).toBe(true)
    expect(isExcludedGitEntry("index.lock")).toBe(true)
    expect(isExcludedGitEntry("packed-refs.lock")).toBe(true)
    for (const name of [
      "HEAD",
      "config",
      "hooks",
      "objects",
      "refs",
      "packed-refs",
      "logs",
      "info",
      "index",
      "MERGE_HEAD",
      "lfs",
      "modules",
    ]) {
      expect(isExcludedGitEntry(name)).toBe(false)
    }
  })
})
