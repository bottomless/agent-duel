import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { battlePathDenial, battleToolInput } from "@/arena/engine-runtime/battle-sandbox"
import { shellPaths } from "@/arena/engine-runtime/outside-project"
import { permissionRules, sandboxForSession } from "@/arena/engine-runtime/sandbox"

// The sandbox writes its rules with the platform's own separator (`C:\…\generation-1-a\*` on
// Windows). Both checks must accept that form, or a contestant cannot write or run anything.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "battle-tools-")))
const checkout = path.join(root, "checkout")
const worktree = path.join(checkout, ".agent-duel", "worktrees", "abc", "generation-1-a")
mkdirSync(worktree, { recursive: true })
writeFileSync(path.join(worktree, "index.html"), "<!-- page -->\n")
writeFileSync(path.join(checkout, "index.html"), "<!-- page -->\n")
const rules = permissionRules([], sandboxForSession("ses_native_paths", worktree, checkout))

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("battle tools with the platform's own paths", () => {
  it("lets a contestant write in its own worktree", () => {
    expect(battlePathDenial(rules, "write", path.join(worktree, "index.html"), worktree)).toBeUndefined()
    expect(battlePathDenial(rules, "write", "index.html", worktree)).toBeUndefined()
    expect(
      battlePathDenial(rules, "write", `${worktree.split(path.sep).join("/")}/index.html`, worktree),
    ).toBeUndefined()
  })

  it("still refuses a write in the main checkout", () => {
    expect(battlePathDenial(rules, "write", path.join(checkout, "index.html"), worktree)).toContain(
      "write only in their own worktree",
    )
  })

  it("parses a contestant's shell command", async () => {
    expect(await shellPaths("echo ok", worktree, "write")).toEqual([])
    expect(await shellPaths("echo x > out.txt", worktree, "write")).toEqual([path.join(worktree, "out.txt")])
  })

  it.if(process.platform === "win32")("reads Git Bash spellings as Windows paths", async () => {
    const posix = (file: string) => `/${file[0].toLowerCase()}${file.slice(2).split(path.sep).join("/")}`
    const write = (file: string) =>
      Effect.runPromise(
        battleToolInput({ tool: "write", args: { path: file, content: "x" }, directory: worktree, rules }),
      )
    expect(await write(posix(path.join(worktree, "index.html")))).toMatchObject({
      path: path.join(worktree, "index.html"),
    })
    // Git Bash maps `/tmp` to the user's temp directory, where the contestant's `$TMPDIR` lives.
    const own = path.join(os.tmpdir(), "opencode", "arena", "ses_native_paths", "note.txt")
    expect(
      await Effect.runPromise(
        battleToolInput({
          tool: "write",
          args: { path: "/tmp/opencode/arena/ses_native_paths/note.txt", content: "x" },
          directory: worktree,
          rules,
        }).pipe(Effect.result),
      ),
    ).toMatchObject({ success: { path: own } })
    // The same spellings inside a shell command.
    expect(await shellPaths("echo x > /tmp/opencode/arena/ses_native_paths/out.txt", worktree, "write")).toEqual([
      path.join(os.tmpdir(), "opencode", "arena", "ses_native_paths", "out.txt"),
    ])
  })

  it("lets a shell command write to /dev/null", async () => {
    expect(await shellPaths("ls missing 2>/dev/null || echo none", worktree, "write")).toEqual(["/dev/null"])
    expect(
      await Effect.runPromise(
        battleToolInput({
          tool: "shell",
          args: { command: "ls missing 2>/dev/null || echo none" },
          directory: worktree,
          rules,
        }).pipe(Effect.result),
      ),
    ).toMatchObject({ success: { command: "ls missing 2>/dev/null || echo none" } })
  })
})
