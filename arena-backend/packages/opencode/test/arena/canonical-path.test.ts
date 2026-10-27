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
const TEMP = "/var/folders/xy/abc/T/opencode/arena"

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
    const canonical = await canonicalizeTranscriptPaths(
      part,
      { worktrees: [first], canonical: CANONICAL, temp: TEMP },
      "assistant",
    )
    expect(canonical.text).toBe(
      `Edited ${CANONICAL}/src/data/tiers.ts.\n${CANONICAL}/src/data/tiers.ts\ncd ${CANONICAL} && pwd`,
    )
    const continued = await localizeTranscriptPaths(canonical, { canonical: CANONICAL, worktree: second }, "assistant")
    expect(continued.text).toBe(`Edited ${second}/src/data/tiers.ts.\n${second}/src/data/tiers.ts\ncd ${second} && pwd`)
    expect(
      await canonicalizeTranscriptPaths(part, { worktrees: [first], canonical: CANONICAL, temp: TEMP }, "user"),
    ).toBe(part)
  })

  test("does not rewrite sibling paths, embedded prefixes or parent traversal, in text or tool output", async () => {
    const first = `${CANONICAL}/.agent-duel/generation-1-a`
    const paths = { worktrees: [first], canonical: CANONICAL, temp: TEMP }
    const text = `${first}-backup\n/prefix${first}/file\n${first}/../sibling\n${first}/file`
    const expected = `${first}-backup\n/prefix${first}/file\n${first}/../sibling\n${CANONICAL}/file`
    expect((await canonicalizeTranscriptPaths({ type: "text", text }, paths, "assistant")).text).toBe(expected)
    const tool = { type: "tool", tool: "custom", state: { input: {}, output: text } }
    expect((await canonicalizeTranscriptPaths(tool, paths, "assistant")).state.output).toBe(expected)
    const unrelated = { type: "tool", tool: "custom", state: { input: {}, output: `${CANONICAL}/file` } }
    expect(await canonicalizeTranscriptPaths(unrelated, paths, "assistant")).toBe(unrelated)
  })

  describe("Arena references the winner's transcript carries", () => {
    const pool = `${CANONICAL}/.agent-duel/worktrees/1e5a93c70dbcca48`
    const old = `${pool}/generation-5-b`
    const paths = { worktrees: [], canonical: CANONICAL, temp: TEMP, home: "/Users/dev" }
    const tool = (name: string, state: Record<string, unknown>) => ({ type: "tool", tool: name, state })

    test("retargets an earlier turn's worktree in every tool output, whichever turn it was", async () => {
      const read = tool("read", {
        input: { filePath: `${old}/src/scene/Camera.tsx` },
        output: `<path>${old}/src/scene/Camera.tsx</path>\n<type>file</type>`,
      })
      const grep = tool("grep", {
        input: { pattern: "x" },
        output: `Found 1 matches\n${pool}/spare-0a1b2c3d/TODO.md:\n  Line 2: x`,
      })
      const bash = tool("bash", {
        input: { command: "npx vitest" },
        output: `at ${old}/tests/e2e/playback.spec.ts:507:68\nfile://${old}/src/main.ts`,
      })
      const task = tool("task", {
        input: { prompt: `Read ${old}/README.md` },
        output: `[styles](${old}/src/styles.css#L134)`,
      })
      expect((await canonicalizeTranscriptPaths(read, paths, "assistant")).state).toEqual({
        input: { filePath: `${CANONICAL}/src/scene/Camera.tsx` },
        output: `<path>${CANONICAL}/src/scene/Camera.tsx</path>\n<type>file</type>`,
      })
      expect((await canonicalizeTranscriptPaths(grep, paths, "assistant")).state.output).toBe(
        `Found 1 matches\n${CANONICAL}/TODO.md:\n  Line 2: x`,
      )
      expect((await canonicalizeTranscriptPaths(bash, paths, "assistant")).state.output).toBe(
        `at ${CANONICAL}/tests/e2e/playback.spec.ts:507:68\nfile://${CANONICAL}/src/main.ts`,
      )
      expect((await canonicalizeTranscriptPaths(task, paths, "assistant")).state).toEqual({
        input: { prompt: `Read ${CANONICAL}/README.md` },
        output: `[styles](${CANONICAL}/src/styles.css#L134)`,
      })
    })

    test("retargets reasoning, errors and every other spelling of a worktree path", async () => {
      const reasoning = { type: "reasoning", text: `Earlier I edited ${old}/src/a.ts.` }
      expect((await canonicalizeTranscriptPaths(reasoning, paths, "assistant")).text).toBe(
        `Earlier I edited ${CANONICAL}/src/a.ts.`,
      )
      const failed = tool("read", { input: { filePath: "a.ts" }, error: `File not found: ${old}/a.ts` })
      expect((await canonicalizeTranscriptPaths(failed, paths, "assistant")).state.error).toBe(
        `File not found: ${CANONICAL}/a.ts`,
      )
      const spellings = [
        [`~/project/.agent-duel/worktrees/1e5a93c70dbcca48/generation-5-b/x`, `${CANONICAL}/x`],
        [`$HOME/project/.agent-duel/worktrees/1e5a93c70dbcca48/generation-5-b/x`, `${CANONICAL}/x`],
        [
          `import a from '../../Users/dev/project/.agent-duel/worktrees/1e5a93c70dbcca48/generation-5-b/x'`,
          `import a from '../..${CANONICAL}/x'`,
        ],
        [`gitdir: ${old}.git/worktrees/generation-5-b`, `gitdir: ${CANONICAL}/.git/worktrees/generation-5-b`],
      ] as const
      for (const [before, after] of spellings) {
        expect(
          (
            await canonicalizeTranscriptPaths(
              tool("bash", { input: { command: "x" }, output: before }),
              paths,
              "assistant",
            )
          ).state.output,
        ).toBe(after)
      }
    })

    test("ends a worktree path where the slot name ends", async () => {
      const cases = [
        [`My working directory is ${old}.`, `My working directory is ${CANONICAL}.`],
        [JSON.stringify({ msg: `${old}\nnext line` }), JSON.stringify({ msg: `${CANONICAL}\nnext line` })],
        [`${old}.git.`, `${CANONICAL}/.git.`],
        [`${pool}/generation-5-bx`, `${pool}/generation-5-bx`],
      ] as const
      for (const [before, after] of cases) {
        const part = tool("bash", { input: { command: "x" }, output: before })
        expect((await canonicalizeTranscriptPaths(part, paths, "assistant")).state.output).toBe(after)
      }
      const text = { type: "text", text: `My working directory is ${old}.` }
      expect((await canonicalizeTranscriptPaths(text, paths, "assistant")).text).toBe(
        `My working directory is ${CANONICAL}.`,
      )
    })

    test("turns a contestant temp directory into $TMPDIR, in either spelling", async () => {
      const output = `${TEMP}/ses_ecc459383ffesdiw7QdDMWaRmj/shots/a.png\n/private${TEMP}/ses_ecc1bcedfffeBxHZzZdTIaJjCK/log`
      const part = tool("bash", { input: { command: "ls" }, output })
      expect((await canonicalizeTranscriptPaths(part, paths, "assistant")).state.output).toBe(
        "$TMPDIR/shots/a.png\n$TMPDIR/log",
      )
    })

    test("leaves the pool's own directory, the user's typed text and image bytes as they are", async () => {
      const listing = tool("bash", { input: { command: "ls" }, output: `${pool}/` })
      expect(await canonicalizeTranscriptPaths(listing, paths, "assistant")).toEqual(listing)
      const typed = { type: "text", text: `Compare with ${old}/src` }
      expect(await canonicalizeTranscriptPaths(typed, paths, "user")).toBe(typed)
      const synthetic = { type: "text", synthetic: true, text: `<path>${old}/src/a.ts</path>` }
      expect((await canonicalizeTranscriptPaths(synthetic, paths, "user")).text).toBe(
        `<path>${CANONICAL}/src/a.ts</path>`,
      )
      const image = { type: "file", url: `data:image/png;base64,${old}` }
      expect(await canonicalizeTranscriptPaths(image, paths, "assistant")).toEqual(image)
    })

    test("retargets a subagent's prompt, which its parent wrote, and only that user text", async () => {
      const prompt = { type: "text", text: `List the files in ${old} with the read tool.` }
      expect((await canonicalizeTranscriptPaths(prompt, paths, "user", { subagent: true })).text).toBe(
        `List the files in ${CANONICAL} with the read tool.`,
      )
      expect(await canonicalizeTranscriptPaths(prompt, paths, "user")).toBe(prompt)
    })

    test("never localizes a checkout path into the worktree pool", async () => {
      const surviving = tool("read", { input: { filePath: `${old}/a.ts` } })
      const localized = await localizeTranscriptPaths(surviving, {
        canonical: CANONICAL,
        worktree: `${pool}/generation-7-a`,
      })
      expect(localized.state.input.filePath).toBe(`${old}/a.ts`)
    })
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
    const canonical = await canonicalizeTranscriptPaths(original, {
      worktrees: [first],
      canonical: CANONICAL,
      temp: TEMP,
    })
    const continued = await localizeTranscriptPaths(canonical, { canonical: CANONICAL, worktree: second })
    expect(continued.state.output).toBe(`cd "${second}" && pwd\n`)
    const selected = await canonicalizeTranscriptPaths(continued, {
      worktrees: [first, second],
      canonical: CANONICAL,
      temp: TEMP,
    })
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
