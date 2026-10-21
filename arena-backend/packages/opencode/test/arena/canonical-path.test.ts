import { describe, expect, test } from "bun:test"
import {
  canonicalizeEnvironmentProse,
  canonicalizeEnvironmentText,
  canonicalizeTranscriptPaths,
  DISPLAY_METADATA_KEY,
  displayEnvironmentProse,
  expandEnvironmentText,
  localizeTranscriptPaths,
  canonicalizeWorktreePaths,
  localizeCanonicalPaths,
} from "@/arena/canonical-path"

const CANONICAL = "/Users/dev/project"
const WORKTREE_A = "/Users/dev/.local/share/opencode/worktree/5f90df7c/turn-1-a-gentle-meadow"
const WORKTREE_B = "/Users/dev/.local/share/opencode/worktree/5f90df7c/turn-1-b-calm-knight"
const BOTH = { worktrees: [WORKTREE_A, WORKTREE_B], canonical: CANONICAL }

describe("Arena canonical path", () => {
  const WINNER = {
    portAliases: { PASEO_PORT: 21400, PASEO_PORT2: 21401, PASEO_PORT3: 21402 },
    previewUrls: {
      PASEO_PORT: "http://turn1-a--abc.localhost:6768",
      PASEO_PORT2: "http://port2--turn1-a--abc.localhost:6768",
      PASEO_PORT3: "http://port3--turn1-a--abc.localhost:6768",
    },
  }

  test.each([
    ["http://localhost:21400/", "http://localhost:$PASEO_PORT/"],
    ["https://127.0.0.1:21401/api?q=1", "https://127.0.0.1:$PASEO_PORT2/api?q=1"],
    ["bound to 0.0.0.0:21402.", "bound to 0.0.0.0:$PASEO_PORT3."],
    ["curl [::1]:21400", "curl [::1]:$PASEO_PORT"],
    ["listen on [::]:21401", "listen on [::]:$PASEO_PORT2"],
    ["(localhost:21400)", "(localhost:$PASEO_PORT)"],
    ["Open http://turn1-a--abc.localhost:6768", "Open $ARENA_PREVIEW_URL"],
    ["Open http://turn1-a--abc.localhost:6768/admin.", "Open $ARENA_PREVIEW_URL/admin."],
    ["[API](http://port2--turn1-a--abc.localhost:6768/v1)", "[API]($ARENA_PREVIEW_URL2/v1)"],
    ["ws at http://port3--turn1-a--abc.localhost:6768", "ws at $ARENA_PREVIEW_URL3"],
  ])("replaces the winner's own port or preview URL in %s", (text, expected) => {
    expect(canonicalizeEnvironmentText(text, WINNER)).toBe(expected)
  })

  test.each([
    "port 21400",
    "PID 21400 exited",
    "localhost:214001",
    "localhost:21400abc",
    "mylocalhost:21400",
    "10.0.0.1:21400",
    "https://example.com:21400/",
    "localhost:21403",
    "sha 9f21400a",
    "line 21400:",
    "http://turn1-a--abc.localhost:67689",
    "http://turn1-a--abc.localhost:6768.evil.test",
    "http://turn1-a--abcd.localhost:6768",
    "iVBORw0KGgoqzp8localhost:21400",
  ])("leaves %s unchanged", (text) => {
    expect(canonicalizeEnvironmentText(text, WINNER)).toBe(text)
  })

  test("is idempotent", () => {
    const once = canonicalizeEnvironmentText(
      "Started at http://localhost:21400 and http://turn1-a--abc.localhost:6768",
      WINNER,
    )
    expect(once).toBe("Started at http://localhost:$PASEO_PORT and $ARENA_PREVIEW_URL")
    expect(canonicalizeEnvironmentText(once, WINNER)).toBe(once)
  })

  test("changes an assistant text part and keeps its original text for display", () => {
    const part = {
      type: "text",
      text: "Running at http://localhost:21400",
      metadata: { openai: { itemId: "msg_1" } },
    }
    const result = canonicalizeEnvironmentProse(part, "assistant", WINNER)
    expect(result).toEqual({
      type: "text",
      text: "Running at http://localhost:$PASEO_PORT",
      metadata: {
        openai: { itemId: "msg_1" },
        [DISPLAY_METADATA_KEY]: { text: "Running at http://localhost:21400" },
      },
    })
    expect(part.text).toBe("Running at http://localhost:21400")
    expect(canonicalizeEnvironmentProse(result, "assistant", WINNER)).toEqual(result)
  })

  test("returns a text part without a match unchanged", () => {
    const part = { type: "text", text: "No server this time" }
    expect(canonicalizeEnvironmentProse(part, "assistant", WINNER)).toBe(part)
  })

  test("keeps the display text a contestant's own run already set", () => {
    const part = {
      type: "text",
      text: "Old http://localhost:21400, now URL: $ARENA_PREVIEW_URL",
      metadata: {
        [DISPLAY_METADATA_KEY]: { text: "Old http://localhost:21400, now URL: http://turn1-a--abc.localhost:6768" },
      },
    }
    expect(canonicalizeEnvironmentProse(part, "assistant", WINNER)).toEqual({
      type: "text",
      text: "Old http://localhost:$PASEO_PORT, now URL: $ARENA_PREVIEW_URL",
      metadata: {
        [DISPLAY_METADATA_KEY]: { text: "Old http://localhost:21400, now URL: http://turn1-a--abc.localhost:6768" },
      },
    })
  })

  test.each([
    ["URL: $ARENA_PREVIEW_URL", "URL: http://turn1-a--abc.localhost:6768"],
    ["URL: ${ARENA_PREVIEW_URL}/admin", "URL: http://turn1-a--abc.localhost:6768/admin"],
    ["api at $ARENA_PREVIEW_URL2.", "api at http://port2--turn1-a--abc.localhost:6768."],
    ["http://localhost:$PASEO_PORT/ and 127.0.0.1:$PASEO_PORT3", "http://localhost:21400/ and 127.0.0.1:21402"],
    ["the server is on port $PASEO_PORT2", "the server is on port 21401"],
    ["Use `npm start`, then open $ARENA_PREVIEW_URL", "Use `npm start`, then open http://turn1-a--abc.localhost:6768"],
  ])("expands this run's variables for display in %s", (text, expected) => {
    expect(expandEnvironmentText(text, WINNER)).toBe(expected)
  })

  test.each([
    "$PASEO_PORTS",
    "$ARENA_PREVIEW_URL_OLD",
    "$HOME",
    "no variables",
    // In code the contestant names the variable or writes a command the shell expands.
    "I wrote the variable names `$PASEO_PORT` and `$ARENA_PREVIEW_URL` instead of values.",
    "Run:\n```bash\ncurl -s http://127.0.0.1:$PASEO_PORT/whoami\n```",
  ])("leaves %s as written", (text) => {
    expect(expandEnvironmentText(text, WINNER)).toBe(text)
  })

  test("sets display text on an assistant text part that names a variable, and changes nothing else", () => {
    const part = { type: "text", text: "Done.\nURL: $ARENA_PREVIEW_URL", metadata: { openai: { itemId: "msg_1" } } }
    expect(displayEnvironmentProse(part, "assistant", WINNER)).toEqual({
      type: "text",
      text: "Done.\nURL: $ARENA_PREVIEW_URL",
      metadata: {
        openai: { itemId: "msg_1" },
        [DISPLAY_METADATA_KEY]: { text: "Done.\nURL: http://turn1-a--abc.localhost:6768" },
      },
    })
    const plain = { type: "text", text: "URL: http://turn1-a--abc.localhost:6768" }
    expect(displayEnvironmentProse(plain, "assistant", WINNER)).toBe(plain)
    const user = { type: "text", text: "use $PASEO_PORT" }
    expect(displayEnvironmentProse(user, "user", WINNER)).toBe(user)
    const tool = { type: "tool", tool: "bash", state: { input: { command: "curl localhost:$PASEO_PORT" } } }
    expect(displayEnvironmentProse(tool, "assistant", WINNER)).toBe(tool)
  })

  test("never changes user prompts, reasoning, tools, files, or other parts", () => {
    const literal = "http://localhost:21400"
    const parts = [
      { role: "user", part: { type: "text", text: literal } },
      {
        role: "assistant",
        part: { type: "reasoning", text: literal, metadata: { anthropic: { signature: "21400" } } },
      },
      {
        role: "assistant",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: `curl ${literal}` }, output: `ok ${literal}` },
        },
      },
      {
        role: "assistant",
        part: {
          type: "tool",
          tool: "edit",
          state: { status: "completed", input: { oldString: literal, newString: "http://localhost:3000" } },
        },
      },
      { role: "assistant", part: { type: "file", mime: "image/png", url: "data:image/png;base64,localhost:21400" } },
      { role: "assistant", part: { type: "patch", hash: "21400", files: [] } },
    ]
    for (const { role, part } of parts) expect(canonicalizeEnvironmentProse(part, role, WINNER)).toBe(part)
  })

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
    expect(continued.text).toBe(`Edited ${second}/src/data/tiers.ts.\n${second}/src/data/tiers.ts\ncd ${second} && pwd`)
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
