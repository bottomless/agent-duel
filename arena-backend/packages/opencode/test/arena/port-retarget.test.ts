import { describe, expect, test } from "bun:test"
import {
  arenaTurnEnvironments,
  localizeArenaPreviewUrls,
  producingArenaEnvironment,
  retargetArenaTranscriptPart,
} from "@/arena/port-retarget"

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
const reasoning = (value: string, metadata?: Record<string, unknown>) => ({
  id: "prt_02",
  type: "reasoning",
  text: value,
  ...(metadata ? { metadata } : {}),
  time: { start: 1760000051101 },
})
const tool = (name: string, input: Record<string, unknown>, output?: string) => ({
  id: "prt_03",
  messageID: "msg_01",
  callID: "toolu_51101",
  type: "tool",
  tool: name,
  state: { status: "completed", input, ...(output === undefined ? {} : { output }), title: "", metadata: {} },
})
const retarget = <T>(part: T, producedIn: Bank = TURN_1, role = "assistant") =>
  retargetArenaTranscriptPart(part, { role, producedIn, env: CURRENT })
const bash = (command: string, output = "") => retarget(tool("bash", { command, description: "run" }, output)).state

const SHA = "9f2c51101ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e"
const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAA51101QAAAAQCAYAAAAf8+51101/hAAAAD0lEQVR42mNk"

describe("Arena port retargeting: text", () => {
  test.each([
    ["The app runs on http://localhost:51101", "The app runs on http://localhost:53728"],
    ["I started the server on 51101 and the API on 51102.", "I started the server on 53728 and the API on 53729."],
    ["Ports: 51101, 51102, 51103", "Ports: 53728, 53729, 53730"],
    ["ports 51101-51103", "ports 53728-53730"],
    // A list changes as a whole: one value rewritten would name two banks.
    [
      "ports in use now = 51101/51102/51103 (web/api/metrics)",
      "ports in use now = 53728/53729/53730 (web/api/metrics)",
    ],
    ["`curl 127.0.0.1:51102/health` (PASEO_PORT2=51102)", "`curl 127.0.0.1:53729/health` (PASEO_PORT2=53729)"],
    ["kill the old one on 51101.", "kill the old one on 53728."],
    ["Preview: http://turn1-a--abc.localhost:6768/", "Preview: http://turn3-b--xyz.localhost:6768/"],
    [
      "API http://port2--turn1-a--abc.localhost:6768/api and docs (http://port3--turn1-a--abc.localhost:6768).",
      "API http://port2--turn3-b--xyz.localhost:6768/api and docs (http://port3--turn3-b--xyz.localhost:6768).",
    ],
    ["curl -H 'Host: turn1-a--abc.localhost' it", "curl -H 'Host: turn3-b--xyz.localhost' it"],
    ["URL: turn1-a--abc.localhost:6768/whoami", "URL: turn3-b--xyz.localhost:6768/whoami"],
    ['It printed {"bound_port": 51101, "turn_side": "turn1-a"}', 'It printed {"bound_port": 53728, "turn_side": "turn1-a"}'],
  ])("rewrites every standalone port number and preview URL: %s", (before, after) => {
    expect(retarget(text(before)).text).toBe(after)
  })

  test.each([
    "dashed_id req-51101-ab12",
    "glued_id ord_ab12c351101d4e5f6",
    "the log is logs/web-51101.txt",
    "build 1.51101.0 finished",
    "wrote 51101.txt",
    "see /proc/51101/status",
    "commit 3a51101fe0 and id prt_51101abc and msg_0051101",
    `sha256 ${SHA}`,
    `blob ${BASE64}`,
    "uuid 3f2a5110-1abc-4def-8a51-101b51101cde",
    "data:text/plain,localhost:51101",
    "localhost:511010 and 151101",
    "echo $PASEO_PORT ${PASEO_PORT2} $ARENA_PREVIEW_URL",
    "http://xturn1-a--abc.localhost:6768 and turn1-a--abc.localhostname",
  ])("keeps names and encoded data: %s", (value) => {
    const part = text(value)
    expect(retarget(part)).toBe(part)
  })

  test("rewrites the port inside a URL path that looks like base64", () => {
    expect(retarget(text("open localhost:51101/ThisIsALongPath123")).text).toBe(
      "open localhost:53728/ThisIsALongPath123",
    )
  })

  test("rewrites reasoning saved without metadata", () => {
    const part = reasoning("Port 51101 is mine; the hash 9f2c51101ab34cd56ef7 is not.")
    expect(retarget(part).text).toBe("Port 53728 is mine; the hash 9f2c51101ab34cd56ef7 is not.")
  })

  test("never changes reasoning that carries a signature or encrypted content", () => {
    const part = reasoning("The server is on localhost:51101.", {
      anthropic: { signature: "EqQBCkgIBRABGAIiQL51101x" },
    })
    expect(retarget(part)).toBe(part)
    const encrypted = reasoning("port 51101", { openai: { reasoningEncryptedContent: "gAAAAABo51101==" } })
    expect(retarget(encrypted)).toBe(encrypted)
  })

  test("rewrites a subagent's prompt and answer", () => {
    const part = tool(
      "task",
      { prompt: "Start the server with --port 51101 and report pid 51101", description: "start" },
      '<task id="ses_0a1B51101c" state="completed">\n<task_result>\nServer up on 51101 (pid 4242).\n</task_result>\n</task>',
    )
    const state = retarget(part).state
    expect(state.input.prompt).toBe("Start the server with --port 53728 and report pid 53728")
    expect(state.output).toBe(
      '<task id="ses_0a1B51101c" state="completed">\n<task_result>\nServer up on 53728 (pid 4242).\n</task_result>\n</task>',
    )
  })
})

describe("Arena port retargeting: tool calls", () => {
  test.each([
    ["curl -s http://127.0.0.1:51102/health", "curl -s http://127.0.0.1:53729/health"],
    ["bound to 0.0.0.0:51103.", "bound to 0.0.0.0:53730."],
    ["http://[::1]:51101 and [::]:51102", "http://[::1]:53728 and [::]:53729"],
    ["LOCALHOST:51101", "LOCALHOST:53728"],
    ["api.turn1.localhost:51101/v1", "api.turn1.localhost:53728/v1"],
    ["TCP *:51101 (LISTEN)", "TCP *:53728 (LISTEN)"],
    ["vite --port 51102", "vite --port 53729"],
    ["vite --port=51102 --dev-port 51103", "vite --port=53729 --dev-port 53730"],
    ["python server.py -p 51103", "python server.py -p 53730"],
    ["docker run -p 51101:51102 img", "docker run -p 53728:53729 img"],
    ["PORT=51101 npm run dev", "PORT=53728 npm run dev"],
    [
      "export PASEO_PORT2=51102 PASEO_PORT3='51103' VITE_PORT=\"51101\"",
      "export PASEO_PORT2=53729 PASEO_PORT3='53730' VITE_PORT=\"53728\"",
    ],
    ["java -Dserver.port=51101", "java -Dserver.port=53728"],
    ["lsof -i :51101 && lsof -iTCP:51102 -sTCP:LISTEN", "lsof -i :53728 && lsof -iTCP:53729 -sTCP:LISTEN"],
    ["kill $(lsof -ti:51101)", "kill $(lsof -ti:53728)"],
    ["fuser -k 51101/tcp", "fuser -k 53728/tcp"],
    ["nc -zv localhost 51101 && telnet 127.0.0.1 51102", "nc -zv localhost 53728 && telnet 127.0.0.1 53729"],
    ["python3 -m http.server 51101 --bind 127.0.0.1", "python3 -m http.server 53728 --bind 127.0.0.1"],
    ["Listening on 51101", "Listening on 53728"],
    ["serving on :51101; grep ':51102'", "serving on :53728; grep ':53729'"],
    ["The server listens on port 51101. Port: 51102", "The server listens on port 53728. Port: 53729"],
    ["detached port-fixture role=metrics port=51103", "detached port-fixture role=metrics port=53730"],
    ["open http://turn1-a--abc.localhost:6768/", "open http://turn3-b--xyz.localhost:6768/"],
    // Shapes a list of port contexts missed on production transcripts.
    ['lsof -iTCP:"51101" -sTCP:LISTEN -n -P', 'lsof -iTCP:"53728" -sTCP:LISTEN -n -P'],
    ["create_connection(('127.0.0.1', 51101), 5)", "create_connection(('127.0.0.1', 53728), 5)"],
    ["- Network:      http://10.197.64.144:51101", "- Network:      http://10.197.64.144:53728"],
    ["Error: listen EADDRINUSE: address already in use :::51101", "Error: listen EADDRINUSE: address already in use :::53728"],
    ['ps aux | rg "next start|51101|51102"', 'ps aux | rg "next start|53728|53729"'],
    ['echo -n "worker:51102 -> "', 'echo -n "worker:53729 -> "'],
  ])("rewrites every standalone port number: %s", (before, after) => {
    expect(bash(before, before)).toMatchObject({ input: { command: after }, output: after })
  })

  test("rewrites the values a command prints for the port variables", () => {
    expect(bash("printenv PASEO_PORT PORT PASEO_PORT2", "51101\n51101\n51102\n").output).toBe("53728\n53728\n53729\n")
  })

  // The cost of matching every standalone number: a pid or a size equal to a port changes too.
  test.each([
    ["kill 51101", "kill 53728"],
    ["wrote 51101 bytes to out/blob.bin", "wrote 53728 bytes to out/blob.bin"],
  ])("rewrites a number equal to a port that is not one: %s", (before, after) => {
    expect(bash(before, before)).toMatchObject({ input: { command: after }, output: after })
  })

  test.each([
    "dashed_id: req-51101-ab12",
    "build 1.51101.0 finished",
    "glued_id: ord_ab12c351101d4e5f6",
    "see /proc/51101/status",
    "localhost:511010",
  ])("keeps a number that is part of a name: %s", (value) => {
    expect(bash(value, value)).toMatchObject({ input: { command: value }, output: value })
  })

  test("keeps the canary's encoded data and names", () => {
    const output = [
      `CANARY base64_blob: ${BASE64}`,
      `CANARY sha256(pt-7): ${SHA}`,
      "CANARY glued_id: ord_ab12c351101d4e5f6",
      "CANARY dashed_id: req-51101-ab12",
      "CANARY wrote 51101 bytes to out/blob.bin",
      "CANARY out/fake.pid contains pid 51101",
      "CANARY build 1.51101.0 finished, elapsed_ms=51101",
      "port-fixture role=web listening on http://127.0.0.1:51101 turn_side=turn1-a pid=51101 root=/x",
    ].join("\n")
    const expected = [
      `CANARY base64_blob: ${BASE64}`,
      `CANARY sha256(pt-7): ${SHA}`,
      "CANARY glued_id: ord_ab12c351101d4e5f6",
      "CANARY dashed_id: req-51101-ab12",
      "CANARY wrote 53728 bytes to out/blob.bin",
      "CANARY out/fake.pid contains pid 53728",
      "CANARY build 1.51101.0 finished, elapsed_ms=53728",
      "port-fixture role=web listening on http://127.0.0.1:53728 turn_side=turn1-a pid=53728 root=/x",
    ].join("\n")
    expect(bash("python3 tools/canary.py", output).output).toBe(expected)
  })

  test("rewrites short JSON in a command and its output", () => {
    const json = '{"turn_side": "turn1-a", "bound_port": 51101, "url": "http://127.0.0.1:51101"}'
    const rule = `bsk debug rule_add --rule '{"match":{"url":"http://localhost:51101/api"}}' --json`
    expect(bash(rule, json)).toMatchObject({
      input: { command: `bsk debug rule_add --rule '{"match":{"url":"http://localhost:53728/api"}}' --json` },
      output: '{"turn_side": "turn1-a", "bound_port": 53728, "url": "http://127.0.0.1:53728"}',
    })
    const pretty = `{\n  "web_url": "http://127.0.0.1:51101",\n  "api_url": null\n}`
    const mixed = `serving on http://127.0.0.1:51101\n${pretty}\nport 51101 ok`
    expect(bash("scripts/smoke.sh", mixed).output).toBe(mixed.replaceAll("51101", "53728"))
  })

  test("keeps JSON longer than 2,500 characters", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ id: index, url: "http://127.0.0.1:51101/item" }))
    const long = JSON.stringify({ port: 51101, rows }, null, 2)
    expect(long.length).toBeGreaterThan(2500)
    expect(bash("curl -s localhost:51101/dump", long)).toMatchObject({
      input: { command: "curl -s localhost:53728/dump" },
      output: long,
    })
    expect(bash("scripts/dump.sh", `serving on :51101\n${long}`).output).toBe(`serving on :53728\n${long}`)
  })

  test("rewrites shell reads and writes of any file", () => {
    const output = "PORT=51101\nurl=http://localhost:51101"
    for (const command of ["cat .env", "git diff config.yaml", "tail -20 web.server.log", "rg localhost"]) {
      expect(bash(command, output).output).toBe("PORT=53728\nurl=http://localhost:53728")
    }
    const heredoc = [
      "cat > config.json <<'EOF'",
      '{"web_url": "http://127.0.0.1:51101"}',
      "EOF",
      "echo 'PORT=51101' > .env && curl -s localhost:51101",
    ].join("\n")
    expect(bash(heredoc).input.command).toBe(heredoc.replaceAll("51101", "53728"))
  })

  test("keeps the file content file tools read or wrote, and rewrites the rest of the call", () => {
    const write = tool("write", { filePath: "/repo/config.json", content: '{"port": 51101}' }, "Wrote :51101")
    expect(retarget(write).state).toMatchObject({ input: write.state.input, output: "Wrote :53728" })
    const edit = tool("edit", {
      filePath: "/repo/logs/51101/vite.config.ts",
      oldString: "port: 51101",
      newString: "port: 5173",
    })
    expect(retarget(edit).state.input).toEqual(edit.state.input)
    const multiedit = tool("multiedit", { filePath: "/repo/a.ts", edits: [{ oldString: "--port 51101", newString: "" }] })
    expect(retarget(multiedit)).toBe(multiedit)
    const read = tool("read", { filePath: "/repo/server.py" }, "<content>\n1: PORT = 51101  # port 51101\n</content>")
    expect(retarget(read)).toBe(read)
    const patchText = "*** Begin Patch\n*** Update File: vite.config.ts\n-  server: { port: 51101 }\n*** End Patch"
    const patch = tool("apply_patch", { patchText })
    expect(retarget(patch)).toBe(patch)
    const grep = tool("grep", { pattern: "51101" }, "/repo/server.py:\n  Line 3: PORT = 51101")
    expect(retarget(grep).state).toMatchObject({ input: { pattern: "53728" }, output: grep.state.output })
  })

  test("rewrites a fetched page and a search result", () => {
    const fetch = tool("webfetch", { url: "http://localhost:51101/", format: "text" }, "API at localhost:51102")
    expect(retarget(fetch).state).toMatchObject({
      input: { url: "http://localhost:53728/" },
      output: "API at localhost:53729",
    })
    const search = tool("websearch", { query: "vite port 51101" }, "Run on localhost:51101 by default")
    expect(retarget(search).state).toMatchObject({
      input: { query: "vite port 53728" },
      output: "Run on localhost:53728 by default",
    })
  })

  test("rewrites a tool error", () => {
    const part = {
      type: "tool",
      tool: "bash",
      state: { status: "error", input: {}, error: "bind 127.0.0.1:51101: in use" },
    }
    expect(retarget(part).state.error).toBe("bind 127.0.0.1:53728: in use")
  })

  test("keeps metadata, title, ids, attachments and binary output", () => {
    const image = `data:image/png;base64,${BASE64}`
    const part = {
      id: "prt_51101",
      messageID: "msg_51101",
      callID: "toolu_51101",
      type: "tool",
      tool: "bash",
      metadata: { note: "localhost:51101" },
      state: {
        status: "completed",
        input: { command: "curl localhost:51101" },
        output: "\u0000\u0001localhost:51101",
        metadata: { output: "Listening on http://localhost:51101", pid: 51101 },
        attachments: [{ type: "file", mime: "image/png", url: image }],
        title: "Start on port 51101",
        time: { start: 1760000051101, end: 1760000051102 },
      },
    }
    const result = retarget(part)
    expect(result).toEqual({ ...part, state: { ...part.state, input: { command: "curl localhost:53728" } } })
    expect(result.state.metadata).toBe(part.state.metadata)
    expect(result.state.attachments).toBe(part.state.attachments)
  })

  test.each([
    { type: "file", mime: "text/plain", url: "http://localhost:51101/log.txt", filename: "localhost:51101" },
    { type: "patch", hash: "51101aa", files: ["/repo/localhost:51101"] },
    { type: "step-finish", snapshot: "51101ab", tokens: { input: 51101 } },
    { type: "step-start", snapshot: "51101ab" },
    { type: "subtask", prompt: "check localhost:51101", description: "port 51101" },
  ])("never changes a $type part", (part) => {
    expect(retarget(part)).toBe(part)
  })
})

describe("Arena port retargeting: scope", () => {
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

  test("rewrites each literal once when the current bank reuses an old port", () => {
    // The producing run's PASEO_PORT2 is this contestant's PASEO_PORT: a second pass would turn the
    // new value into yet another port.
    const env = { ...CURRENT, PASEO_PORT: "51102", PASEO_PORT2: "51101" }
    const part = text("web localhost:51101, api 51102")
    expect(retargetArenaTranscriptPart(part, { role: "assistant", producedIn: TURN_1, env }).text).toBe(
      "web localhost:51102, api 51101",
    )
  })

  test("writes the variable when this environment has no value for it", () => {
    const env = { PASEO_PORT: "53728" }
    expect(
      retargetArenaTranscriptPart(text("metrics on 51103"), { role: "assistant", producedIn: TURN_1, env }).text,
    ).toBe("metrics on $PASEO_PORT3")
    expect(
      retargetArenaTranscriptPart(text("open http://turn1-a--abc.localhost:6768"), {
        role: "assistant",
        producedIn: TURN_1,
        env,
      }).text,
    ).toBe("open $ARENA_PREVIEW_URL")
  })

  test("expands preview URL variables in a finished answer's text only", () => {
    const answer = text("Open $ARENA_PREVIEW_URL (served on $PASEO_PORT)")
    expect(localizeArenaPreviewUrls(answer, CURRENT).text).toBe(
      "Open http://turn3-b--xyz.localhost:6768 (served on $PASEO_PORT)",
    )
    const command = { type: "tool", tool: "bash", state: { input: { command: "curl $ARENA_PREVIEW_URL" } } }
    expect(localizeArenaPreviewUrls(command, CURRENT)).toBe(command)
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
