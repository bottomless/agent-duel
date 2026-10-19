import { describe, expect, test } from "bun:test"
import {
  arenaTurnEnvironments,
  canonicalizeArenaEnvironment,
  canonicalizeTranscriptPaths,
  localizeTranscriptPaths,
  canonicalizeWorktreePaths,
  localizeArenaPreviewUrls,
  localizeCanonicalPaths,
  producingArenaEnvironment,
  retargetArenaTranscriptPart,
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

const TURN_1 = {
  portAliases: { PASEO_PORT: 51101, PASEO_PORT2: 51102, PASEO_PORT3: 51103 },
  previewUrls: {
    PASEO_PORT: "http://turn1-a--abc.localhost:6768",
    PASEO_PORT2: "http://port2--turn1-a--abc.localhost:6768",
    PASEO_PORT3: "http://port3--turn1-a--abc.localhost:6768",
  },
}
const CURRENT = {
  PORT: "53728",
  PASEO_PORT: "53728",
  PASEO_PORT2: "53729",
  PASEO_PORT3: "53730",
  ARENA_PREVIEW_URL: "http://turn3-b--xyz.localhost:6768",
  ARENA_PREVIEW_URL2: "http://port2--turn3-b--xyz.localhost:6768",
  ARENA_PREVIEW_URL3: "http://port3--turn3-b--xyz.localhost:6768",
}
type Bank = Parameters<typeof retargetArenaTranscriptPart>[1]["producedIn"]
const text = (value: string) => ({ id: "prt_01", messageID: "msg_01", sessionID: "ses_01", type: "text", text: value })
const retarget = <T>(part: T, producedIn: Bank = TURN_1, role = "assistant") =>
  retargetArenaTranscriptPart(part, { role, producedIn, env: CURRENT })

describe("Arena environment retargeting", () => {
  test.each([
    ["Open http://localhost:51101/app", "Open http://localhost:53728/app"],
    ["curl -s http://127.0.0.1:51102/health", "curl -s http://127.0.0.1:53729/health"],
    ["bound to 0.0.0.0:51103.", "bound to 0.0.0.0:53730."],
    ["http://[::1]:51101", "http://[::1]:53728"],
    ["LOCALHOST:51101", "LOCALHOST:53728"],
    ["api.turn1.localhost:51101/v1", "api.turn1.localhost:53728/v1"],
    ["vite --port 51102", "vite --port 53729"],
    ["vite --port=51102", "vite --port=53729"],
    ["python -m http.server -p 51103", "python -m http.server -p 53730"],
    ["PORT=51101 npm run dev", "PORT=53728 npm run dev"],
    [
      "PASEO_PORT2=51102 PASEO_PORT3='51103' VITE_PORT=\"51101\"",
      "PASEO_PORT2=53729 PASEO_PORT3='53730' VITE_PORT=\"53728\"",
    ],
    ["lsof -i :51101 && lsof -iTCP:51102 -sTCP:LISTEN", "lsof -i :53728 && lsof -iTCP:53729 -sTCP:LISTEN"],
    ["The server listens on port 51101. Port: 51102", "The server listens on port 53728. Port: 53729"],
    ['{"port": 51103}', '{"port": 53730}'],
    ["Preview: http://turn1-a--abc.localhost:6768/", "Preview: http://turn3-b--xyz.localhost:6768/"],
    [
      "API http://port2--turn1-a--abc.localhost:6768/api and docs (http://port3--turn1-a--abc.localhost:6768).",
      "API http://port2--turn3-b--xyz.localhost:6768/api and docs (http://port3--turn3-b--xyz.localhost:6768).",
    ],
  ])("retargets the producing run's port in a port context: %s", (before, after) => {
    expect(retarget(text(before)).text).toBe(after)
  })

  test.each([
    "kill 51101",
    "Started dev server (pid 51101)",
    "commit 3a51101fe0c2 and tree 51101aa",
    "id prt_51101abc and msg_0051101",
    "localhost:511010 and localhost:151101",
    "example.com:51101",
    "iVBORw0KGgoAAAANSUhEUgAA51101AAAAAQCAYAAAAf8/9hAAAAD0lEQVR42mNk",
    "took 51101 ms; 51101 bytes",
    "Servers run with this environment's ports: 51101, 51102, 51103.",
    "http://turn1-a--abc.localhost:67680",
    "echo $PASEO_PORT_EXTRA ${PASEO_PORT}",
  ])("leaves numbers outside a port context unchanged: %s", (value) => {
    const part = text(value)
    expect(retarget(part)).toBe(part)
  })

  test("never changes reasoning, its signature or encrypted reasoning", () => {
    const part = {
      id: "prt_02",
      type: "reasoning",
      text: "The server is on localhost:51101; restart with --port 51101.",
      metadata: {
        anthropic: { signature: "EqQBCkgIBRABGAIiQL51101x+localhost:51101" },
        openai: { itemId: "rs_51101", reasoningEncryptedContent: "gAAAAABo51101localhost:51101==" },
      },
      time: { start: 1760000051101 },
    }
    expect(retarget(part)).toBe(part)
  })

  test("retargets bash command and workdir but keeps output, metadata, ids and attachments", () => {
    const image = "iVBORw0KGgoAAAANSUhEUgAAlocalhost:51101AAAAQCAYAAAAf8"
    const part = {
      id: "prt_51101",
      messageID: "msg_51101",
      callID: "toolu_51101",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: {
          command: "PORT=51101 npm run dev & sleep 2; curl localhost:51101; kill 51101",
          workdir: "/tmp/localhost:51101",
          description: "Start on port 51101",
        },
        output: "Listening on http://localhost:51101\nPID 51101",
        metadata: { output: "Listening on http://localhost:51101", exit: 0, pid: 51101 },
        attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${image}` }],
        title: "Start on port 51101",
      },
    }
    const result = retarget(part)
    expect(result).toEqual({
      ...part,
      state: {
        ...part.state,
        input: {
          command: "PORT=53728 npm run dev & sleep 2; curl localhost:53728; kill 51101",
          workdir: "/tmp/localhost:53728",
          description: "Start on port 51101",
        },
      },
    })
    expect(result.state.output).toBe(part.state.output)
    expect(result.state.metadata).toBe(part.state.metadata)
    expect(result.state.attachments).toBe(part.state.attachments)
  })

  test("retargets a webfetch URL but never a data URL", () => {
    const fetch = {
      type: "tool",
      tool: "webfetch",
      state: { input: { url: "http://localhost:51101/", format: "text" } },
    }
    expect(retarget(fetch).state.input).toEqual({ url: "http://localhost:53728/", format: "text" })
    const data = { type: "tool", tool: "webfetch", state: { input: { url: "data:text/plain,localhost:51101" } } }
    expect(retarget(data)).toBe(data)
    const dataText = text("data:text/plain,localhost:51101")
    expect(retarget(dataText)).toBe(dataText)
  })

  test.each(["edit", "write", "multiedit", "apply_patch", "read", "grep", "task", "playwright_navigate", "constructor"])(
    "never changes %s tool input, whose text must match the files on disk",
    (tool) => {
      const part = {
        type: "tool",
        tool,
        state: {
          input: {
            filePath: "/repo/vite.config.ts",
            oldString: "port: 51101",
            newString: "port: Number(process.env.PORT ?? 51101)",
            content: "PORT=51101\n",
            patchText: "+  server: { port: 51101 }",
            url: "http://localhost:51101",
            command: "PORT=51101 npm run dev",
          },
          output: "localhost:51101",
        },
      }
      expect(retarget(part)).toBe(part)
    },
  )

  test.each([
    { type: "file", mime: "text/plain", url: "http://localhost:51101/log.txt", filename: "localhost:51101" },
    { type: "patch", hash: "51101aa", files: ["/repo/localhost:51101"] },
    { type: "step-finish", snapshot: "51101ab", tokens: { input: 51101 } },
    { type: "step-start", snapshot: "51101ab" },
    { type: "subtask", prompt: "check localhost:51101", description: "port 51101" },
  ])("never changes a $type part", (part) => {
    expect(retarget(part)).toBe(part)
  })

  test("keeps user messages unchanged", () => {
    const part = text("Fix the server on localhost:51101 (--port 51101), see http://turn1-a--abc.localhost:6768")
    expect(retarget(part, TURN_1, "user")).toBe(part)
  })

  test("keeps a message no battle run produced unchanged", () => {
    const part = text("Ordinary turn: localhost:51101 and $PASEO_PORT")
    expect(retargetArenaTranscriptPart(part, { role: "assistant", producedIn: undefined, env: CURRENT })).toBe(part)
  })

  test("matches only the producing run's ports", () => {
    const part = text("localhost:51101 and localhost:52000")
    expect(retarget(part, { portAliases: { PASEO_PORT: 52000 } }).text).toBe("localhost:51101 and localhost:53728")
  })

  test("maps a port two runs shared to the alias of the run that produced the message", () => {
    const turn3 = { portAliases: { PASEO_PORT: 51200, PASEO_PORT2: 51101, PASEO_PORT3: 51202 } }
    expect(retarget(text("vite --port 51101"), TURN_1).text).toBe("vite --port 53728")
    expect(retarget(text("vite --port 51101"), turn3).text).toBe("vite --port 53729")
  })

  test("canonicalizes literals to variables only in agent-written fields", () => {
    const part = {
      type: "tool",
      tool: "bash",
      state: {
        input: { command: "PORT=51101 vite --port 51102; open http://turn1-a--abc.localhost:6768" },
        output: "51101",
      },
    }
    const canonical = canonicalizeArenaEnvironment(part, TURN_1)
    expect(canonical.state.input.command).toBe("PORT=$PASEO_PORT vite --port $PASEO_PORT2; open $ARENA_PREVIEW_URL")
    expect(canonical.state.output).toBe("51101")
    expect(retarget(part).state.input.command).toBe(
      "PORT=53728 vite --port 53729; open http://turn3-b--xyz.localhost:6768",
    )
  })

  test("keeps variables the agent wrote, which already name the current environment", () => {
    const part = {
      type: "tool",
      tool: "bash",
      state: { input: { command: "echo $PASEO_PORT $PASEO_PORT2 $PASEO_PORT3; curl $ARENA_PREVIEW_URL" }, output: "51101" },
    }
    expect(retarget(part)).toBe(part)
    const answer = text("Served on $PASEO_PORT at localhost:51101")
    expect(retarget(answer).text).toBe("Served on $PASEO_PORT at localhost:53728")
  })

  test("rewrites each literal once when the current bank reuses an old port", () => {
    // The producing run's PASEO_PORT2 is this contestant's PASEO_PORT: a second pass would turn the
    // new value into yet another port.
    const env = { ...CURRENT, PASEO_PORT: "51102", PASEO_PORT2: "51101" }
    const part = text("web localhost:51101, api localhost:51102")
    expect(retargetArenaTranscriptPart(part, { role: "assistant", producedIn: TURN_1, env }).text).toBe(
      "web localhost:51102, api localhost:51101",
    )
  })

  test("leaves a literal as its variable when this environment has no value for it", () => {
    const part = text("metrics on localhost:51103")
    const env = { PASEO_PORT: "53728" }
    expect(retargetArenaTranscriptPart(part, { role: "assistant", producedIn: TURN_1, env }).text).toBe(
      "metrics on localhost:$PASEO_PORT3",
    )
  })

  test("expands preview URL variables in a finished answer's text only", () => {
    const answer = text("Open $ARENA_PREVIEW_URL (served on $PASEO_PORT)")
    expect(localizeArenaPreviewUrls(answer, CURRENT).text).toBe(
      "Open http://turn3-b--xyz.localhost:6768 (served on $PASEO_PORT)",
    )
    const command = { type: "tool", tool: "bash", state: { input: { command: "curl $ARENA_PREVIEW_URL" } } }
    expect(localizeArenaPreviewUrls(command, CURRENT)).toBe(command)
    const reasoning = { type: "reasoning", text: "$ARENA_PREVIEW_URL", metadata: { signature: "x" } }
    expect(localizeArenaPreviewUrls(reasoning, CURRENT)).toBe(reasoning)
  })
})

describe("Arena producing run", () => {
  const turns = [
    { _id: "turn_1", appliedSide: "a", canonicalUserMessageID: "msg_010" },
    {
      _id: "turn_2",
      appliedSide: "b",
      canonicalUserMessageID: "msg_020",
      canonicalGraftedThroughMessageID: "msg_025",
    },
    { _id: "turn_3", canonicalUserMessageID: "msg_030" },
    { _id: "turn_4", appliedSide: "a" },
    {
      _id: "turn_5",
      appliedSide: "b",
      canonicalUserMessageID: "msg_040",
      canonicalGraftedThroughMessageID: "msg_045",
    },
  ]
  const route = (alias: "PASEO_PORT" | "PASEO_PORT2", url: string) => ({ hostname: "h", alias, url, active: false })
  const runs = [
    {
      turnID: "turn_1",
      side: "a",
      portAliases: { PASEO_PORT: 51101 },
      services: [{ proxyRoutes: [route("PASEO_PORT", "http://t1a.localhost:6768/")] }],
    },
    { turnID: "turn_1", side: "b", portAliases: { PASEO_PORT: 51111 } },
    {
      turnID: "turn_2",
      side: "b",
      portAliases: { PASEO_PORT: 51201, PASEO_PORT2: 51202 },
      services: [
        {
          proxyRoutes: [
            route("PASEO_PORT", "http://t2b.localhost:6768"),
            route("PASEO_PORT2", "http://p2--t2b.localhost:6768"),
          ],
        },
        { proxyRoutes: [{ hostname: "h", active: true }] },
      ],
    },
    { turnID: "turn_3", side: "a", portAliases: { PASEO_PORT: 51301 } },
    { turnID: "turn_4", side: "a", portAliases: { PASEO_PORT: 51401 } },
    { turnID: "turn_5", side: "b" },
  ]

  test("records each resolved turn's winning run and the canonical messages it wrote", () => {
    expect(arenaTurnEnvironments(turns, runs)).toEqual([
      {
        from: "msg_010",
        environment: { portAliases: { PASEO_PORT: 51101 }, previewUrls: { PASEO_PORT: "http://t1a.localhost:6768/" } },
      },
      {
        from: "msg_020",
        through: "msg_025",
        environment: {
          portAliases: { PASEO_PORT: 51201, PASEO_PORT2: 51202 },
          previewUrls: { PASEO_PORT: "http://t2b.localhost:6768", PASEO_PORT2: "http://p2--t2b.localhost:6768" },
        },
      },
      { from: "msg_040", through: "msg_045", environment: { previewUrls: {} } },
    ])
  })

  test("finds the run that produced a canonical message", () => {
    const environments = arenaTurnEnvironments(turns, runs)
    const port = (messageID: string) => producingArenaEnvironment(messageID, environments)?.portAliases?.PASEO_PORT
    // Before the first battle: an ordinary turn.
    expect(producingArenaEnvironment("msg_005", environments)).toBeUndefined()
    expect(port("msg_010")).toBe(51101)
    // A turn grafted before the end marker existed runs to the next battle.
    expect(port("msg_019")).toBe(51101)
    expect(port("msg_020")).toBe(51201)
    expect(port("msg_025")).toBe(51201)
    // After the graft: a conflict resolution or an ordinary turn, which no contestant wrote.
    expect(producingArenaEnvironment("msg_026", environments)).toBeUndefined()
    expect(producingArenaEnvironment("msg_031", environments)).toBeUndefined()
    expect(producingArenaEnvironment("msg_041", environments)?.previewUrls).toEqual({})
    expect(producingArenaEnvironment("msg_050", environments)).toBeUndefined()
  })

  test("retargets a turn's preview URL recorded with a trailing slash", () => {
    const environment = producingArenaEnvironment("msg_011", arenaTurnEnvironments(turns, runs))
    expect(retarget(text("See http://t1a.localhost:6768/ or http://t1a.localhost:6768"), environment).text).toBe(
      "See http://turn3-b--xyz.localhost:6768/ or http://turn3-b--xyz.localhost:6768",
    )
  })
})
