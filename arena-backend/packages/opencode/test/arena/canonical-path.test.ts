import { describe, expect, test } from "bun:test"
import {
  canonicalizeTranscriptPaths,
  localizeTranscriptPaths,
  canonicalizeWorktreePaths,
  localizeCanonicalPaths,
} from "@/arena/canonical-path"

const CANONICAL = "/Users/dev/project"
const WORKTREE_A = "/Users/dev/.local/share/opencode/worktree/5f90df7c/turn-1-a-gentle-meadow"
const WORKTREE_B = "/Users/dev/.local/share/opencode/worktree/5f90df7c/turn-1-b-calm-knight"
const BOTH = { worktrees: [WORKTREE_A, WORKTREE_B], canonical: CANONICAL }

describe("Arena canonical path", () => {
  test("rewrites declared path values through objects and arrays, never keys", () => {
    const input = { cwd: WORKTREE_A, paths: [`${WORKTREE_A}/src`, WORKTREE_B], [WORKTREE_A]: WORKTREE_B }
    expect(canonicalizeWorktreePaths(input, BOTH)).toEqual({
      cwd: CANONICAL,
      paths: [`${CANONICAL}/src`, CANONICAL],
      [WORKTREE_A]: CANONICAL,
    })
    expect(input.cwd).toBe(WORKTREE_A)
  })

  test.each([" backup/file", "'s-backup", '"backup', "\n", "\r\n", "\t", "-archive", "/../sibling"])(
    "preserves a sibling or ambiguous path suffix: %s",
    (suffix) => {
      expect(localizeCanonicalPaths(CANONICAL + suffix, { canonical: CANONICAL, worktree: WORKTREE_A })).toBe(
        CANONICAL + suffix,
      )
    },
  )

  test("prefers the longest root and keeps replacements literal", () => {
    expect(
      canonicalizeWorktreePaths("/x/a/nested/file", {
        worktrees: ["/x/a", "/x/a/nested"],
        canonical: "/x/$&$1",
      }),
    ).toBe("/x/$&$1/file")
  })

  test.each(["project with space", "project's", 'project"quote', "project\\slash", "project\n", "[project](x)+$a"])(
    "round-trips exact paths including special characters: %s",
    (name) => {
      const root = `/tmp/${name}`
      const worktree = `${root}/.agent-duel/generation-0-a`
      const input = { cwd: root, file: `${root}/file`, sibling: `${root} backup` }
      const mapped = localizeCanonicalPaths(input, { canonical: root, worktree })
      expect(mapped).toEqual({ cwd: worktree, file: `${worktree}/file`, sibling: `${root} backup` })
      expect(canonicalizeWorktreePaths(mapped, { canonical: root, worktrees: [worktree] })).toEqual(input)
    },
  )

  test("preserves empty mappings, object prototypes and non-string values", () => {
    const date = new Date(0)
    const input = { date, n: 1, b: false, empty: null, missing: undefined }
    expect(canonicalizeWorktreePaths(input, { canonical: CANONICAL, worktrees: [] })).toBe(input)
    expect(canonicalizeWorktreePaths(input, BOTH)).toEqual(input)
    expect(canonicalizeWorktreePaths(input, BOTH).date).toBe(date)
  })

  test("keeps prose and serialized JSON as text, including root prefixes", async () => {
    for (const text of [
      CANONICAL,
      `${CANONICAL}/README.md`,
      `cd "${CANONICAL}" && pwd`,
      JSON.stringify({ cwd: CANONICAL }),
    ]) {
      const part = { type: "text", text }
      expect(await localizeTranscriptPaths(part, { canonical: CANONICAL, worktree: WORKTREE_A })).toEqual(part)
    }
  })

  test("retargets assistant-reported paths reused in a later turn", async () => {
    const first = `${CANONICAL}/.agent-duel/generation-1-a`
    const second = `${CANONICAL}/.agent-duel/generation-2-b`
    const text = `Edited ${first}/src/data/tiers.ts.\n${first}/src/data/tiers.ts\ncd ${first} && pwd`
    const part = { type: "text", text }
    const canonical = await canonicalizeTranscriptPaths(part, { worktrees: [first], canonical: CANONICAL }, "assistant")
    expect(canonical.text).toBe(
      `Edited ${CANONICAL}/src/data/tiers.ts.\n${CANONICAL}/src/data/tiers.ts\ncd ${CANONICAL} && pwd`,
    )
    const continued = await localizeTranscriptPaths(canonical, { canonical: CANONICAL, worktree: second }, "assistant")
    expect(continued.text).toBe(
      `Edited ${second}/src/data/tiers.ts.\n${second}/src/data/tiers.ts\ncd ${second} && pwd`,
    )
    expect(await canonicalizeTranscriptPaths(part, { worktrees: [first], canonical: CANONICAL }, "user")).toBe(part)
  })

  test("does not rewrite sibling paths, embedded prefixes, parent traversal, or tool output", async () => {
    const first = `${CANONICAL}/.agent-duel/generation-1-a`
    const paths = { worktrees: [first], canonical: CANONICAL }
    const text = `${first}-backup\n/prefix${first}/file\n${first}/../sibling\n${first}/file`
    expect((await canonicalizeTranscriptPaths({ type: "text", text }, paths, "assistant")).text).toBe(
      `${first}-backup\n/prefix${first}/file\n${first}/../sibling\n${CANONICAL}/file`,
    )
    const tool = { type: "tool", tool: "custom", state: { input: {}, output: text } }
    expect(await canonicalizeTranscriptPaths(tool, paths, "assistant")).toBe(tool)
  })

  test("rewrites declared file-tool inputs but preserves content, output and unknown tools", async () => {
    const part = {
      type: "tool",
      tool: "edit",
      state: {
        input: { path: `${CANONICAL}/file`, oldString: CANONICAL, newString: WORKTREE_A },
        output: CANONICAL,
      },
    }
    const mapped = await localizeTranscriptPaths(part, { canonical: CANONICAL, worktree: WORKTREE_A })
    expect(mapped).toEqual({
      ...part,
      state: { ...part.state, input: { ...part.state.input, path: `${WORKTREE_A}/file` } },
    })
    const unknown = { ...part, tool: "custom" }
    expect(await localizeTranscriptPaths(unknown, { canonical: CANONICAL, worktree: WORKTREE_A })).toBe(unknown)
  })

  test("rewrites assistant locations and file attachment paths, preserving labels", async () => {
    const paths = { canonical: CANONICAL, worktree: WORKTREE_A }
    expect(
      await localizeTranscriptPaths({ role: "assistant", path: { cwd: CANONICAL, root: CANONICAL } }, paths),
    ).toEqual({
      role: "assistant",
      path: { cwd: WORKTREE_A, root: WORKTREE_A },
    })
    expect(
      await localizeTranscriptPaths(
        {
          type: "file",
          url: `file://${CANONICAL}/a`,
          filename: CANONICAL,
          source: { type: "file", path: `${CANONICAL}/a` },
        },
        paths,
      ),
    ).toEqual({
      type: "file",
      url: `file://${WORKTREE_A}/a`,
      filename: CANONICAL,
      source: { type: "file", path: `${WORKTREE_A}/a` },
    })
  })

  test("retargets patch, summary and tool attachment paths without changing file contents", async () => {
    const paths = { canonical: CANONICAL, worktree: WORKTREE_A }
    expect(await localizeTranscriptPaths({ type: "patch", files: [`${CANONICAL}/file`] }, paths)).toEqual({
      type: "patch",
      files: [`${WORKTREE_A}/file`],
    })
    const diff = { file: `${CANONICAL}/file`, before: CANONICAL, after: CANONICAL }
    expect(await localizeTranscriptPaths({ role: "user", summary: { diffs: [diff] } }, paths)).toEqual({
      role: "user",
      summary: { diffs: [{ ...diff, file: `${WORKTREE_A}/file` }] },
    })
    const part = {
      type: "tool",
      tool: "custom",
      state: { input: {}, attachments: [{ type: "file", url: `file://${CANONICAL}/file` }] },
    }
    expect(await localizeTranscriptPaths(part, paths)).toEqual({
      ...part,
      state: {
        ...part.state,
        attachments: [{ type: "file", url: `file://${WORKTREE_A}/file` }],
      },
    })
  })

  test("distinguishes pwd output from a newline belonging to a path field", async () => {
    const paths = { canonical: CANONICAL, worktree: WORKTREE_A }
    const part = {
      type: "tool",
      tool: "bash",
      state: { input: { command: "pwd", workdir: `${CANONICAL}\n` }, output: `${CANONICAL}\n` },
    }
    expect(await localizeTranscriptPaths(part, paths)).toEqual({
      ...part,
      state: {
        input: part.state.input,
        output: `${WORKTREE_A}\n`,
      },
    })
  })

  test("retargets a complete directory-command output across three generations", async () => {
    const first = `${CANONICAL}/.agent-duel/generation-0-a`
    const second = `${CANONICAL}/.agent-duel/generation-1-b`
    const third = `${CANONICAL}/.agent-duel/generation-2-a`
    const original = {
      type: "tool",
      tool: "bash",
      state: {
        input: { command: 'printf \'cd "%s" && pwd\\n\' "$PWD"' },
        output: `cd "${first}" && pwd\n`,
      },
    }
    const canonical = await canonicalizeTranscriptPaths(original, { worktrees: [first], canonical: CANONICAL })
    const continued = await localizeTranscriptPaths(canonical, { canonical: CANONICAL, worktree: second })
    expect(continued.state.output).toBe(`cd "${second}" && pwd\n`)
    const selected = await canonicalizeTranscriptPaths(continued, { worktrees: [first, second], canonical: CANONICAL })
    expect((await localizeTranscriptPaths(selected, { canonical: CANONICAL, worktree: third })).state.output).toBe(
      `cd "${third}" && pwd\n`,
    )
  })

  test.each([
    `Read ${CANONICAL}/file`,
    `echo "${CANONICAL}"`,
    `cd "${CANONICAL}"\nother log`,
    `cd "${CANONICAL}"; echo x`,
  ])("preserves arbitrary shell output: %s", async (output) => {
    const part = { type: "tool", tool: "bash", state: { input: { command: "printf x" }, output } }
    expect(await localizeTranscriptPaths(part, { canonical: CANONICAL, worktree: WORKTREE_A })).toEqual(part)
  })
})
