import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { environmentReferences, retargetPart, retargetMessages } from "@/arena/environment-context"
import { rewritePortCommand } from "@/arena/path-command"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const history = [
  {
    portAliases: { PASEO_PORT: 51101, PASEO_PORT2: 51102, PASEO_PORT3: 51103 },
    previewUrls: {
      PASEO_PORT: "http://turn1-a--chat.localhost:6768",
      PASEO_PORT2: "http://port2--turn1-a--chat.localhost:6768",
    },
  },
]
const current = {
  portAliases: { PASEO_PORT: 53728, PASEO_PORT2: 53729, PASEO_PORT3: 53730 },
  previewUrls: {
    PASEO_PORT: "http://turn2-b--chat.localhost:6768",
    PASEO_PORT2: "http://port2--turn2-b--chat.localhost:6768",
  },
}
const mapping = environmentReferences(history, current)
const ids = {
  id: PartID.ascending(),
  messageID: MessageID.ascending(),
  sessionID: SessionID.make("ses_environment_test"),
}
function tool(name: string, input: Record<string, unknown>, output = ""): SessionV1.ToolPart {
  return {
    ...ids,
    type: "tool",
    tool: name,
    callID: "call51101xyz",
    state: {
      status: "completed",
      input,
      output,
      title: "51101",
      metadata: { signature: "abc51101def" },
      time: { start: 1, end: 2 },
    },
  }
}
function message(parts: SessionV1.Part[], created = 1): SessionV1.WithParts {
  return {
    info: {
      id: ids.messageID,
      sessionID: ids.sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("arena"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created },
    },
    parts,
  }
}

describe("Arena model context environment", () => {
  test("preserves images, file contents, IDs, metadata and unknown tool payloads", async () => {
    const image = { ...ids, type: "file" as const, mime: "image/png", url: "data:image/png;base64,aB51101XyAAA" }
    const read = tool("read", { filePath: "/tmp/51101.png" }, "http://localhost:51101 source file contents")
    if (read.state.status !== "completed") throw new Error("fixture")
    read.state.attachments = [image]
    const parts: SessionV1.Part[] = [
      image,
      read,
      tool("write", { content: "PORT=51101", filePath: "51101.ts" }),
      tool("custom", { url: "http://localhost:51101", data: "aB51101Xy" }),
      {
        ...ids,
        type: "reasoning",
        text: "http://localhost:51101",
        time: { start: 1 },
        metadata: { signature: "51101" },
      },
    ]
    const original = structuredClone(parts)
    expect(await Promise.all(parts.map((part) => retargetPart(part, mapping)))).toEqual(original)
    expect(parts).toEqual(original)
  })

  test("keeps a real PNG byte-for-byte through multiple contestant projections", async () => {
    const bytes = await Bun.file(new URL("../tool/fixtures/large-image.png", import.meta.url)).arrayBuffer()
    const base64 = Buffer.from(bytes).toString("base64")
    const match = /(?<!\d)([1-5]\d{4})(?!\d)/.exec(base64)
    expect(match).not.toBeNull()
    const historicalPort = Number(match![1])
    const attachment = { ...ids, type: "file" as const, mime: "image/png", url: `data:image/png;base64,${base64}` }
    const part = tool("bash", { command: `vite --port ${historicalPort}` }, `http://localhost:${historicalPort}`)
    if (part.state.status !== "completed") throw new Error("fixture")
    part.state.attachments = [attachment]
    const source = [message([part])]
    const projected = await retargetMessages(source, [{ portAliases: { PASEO_PORT: historicalPort } }], current, 10)
    const result = projected[0]!.parts[0]
    if (result.type !== "tool") throw new Error("Expected a tool result")
    expect(result.state.input.command).toBe("vite --port '53728'")
    expect(result.state.status === "completed" && result.state.attachments).toEqual([attachment])
    expect(source[0]!.parts[0]).toEqual(part)
    expect(await retargetMessages(source, [{ portAliases: { PASEO_PORT: historicalPort } }], current, 10)).toEqual(
      projected,
    )
  })

  test("changes shell examples but preserves source-code fences", async () => {
    const text = "```bash\nvite --port 51101\n```\n```js\nfetch('http://localhost:51101')\n```"
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(
      text.replace("--port 51101", "--port '53728'"),
    )
  })

  test.each([
    "~~~js\nfetch('http://localhost:51101')\n~~~",
    "````js\nconst fence = '```';\nfetch('http://localhost:51101')\n````",
    "Source:\n```js\nfetch('http://localhost:51101')",
    "    const url = 'http://localhost:51101';",
    "\tconst url = 'http://localhost:51101';",
    ">     const url = 'http://localhost:51101';",
    "``fetch('http://localhost:51101')``",
    "``literal `http://localhost:51101` source``",
    "> ```js\n> fetch('http://localhost:51101')\n> ```",
    "- ```js\n  fetch('http://localhost:51101')\n  ```",
  ])("preserves Markdown code and its delimiters: %s", async (text) => {
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(text)
  })

  test("supports shell fences and inline commands without changing Markdown delimiters", async () => {
    const text = "~~~bash\r\nvite --port 51101\r\n~~~\r\nRun ``curl http://localhost:51102``."
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(
      "~~~bash\r\nvite --port '53728'\r\n~~~\r\nRun ``curl 'http://localhost:53729'``.",
    )
  })

  test("retargets a Markdown link whose label is also a URL", async () => {
    const text = "[http://localhost:51101](http://localhost:51101/path?q=51101)"
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(
      "[http://localhost:53728](http://localhost:53728/path?q=51101)",
    )
  })

  test.each([
    "ftp://example.com/?target=http://localhost:51101",
    "file:///tmp/result?target=http://localhost:51101",
    "//example.com/?target=http://localhost:51101",
    "custom:opaque?target=http://localhost:51101",
  ])("preserves URLs embedded in opaque URI schemes: %s", async (text) => {
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(text)
  })

  test("retargets inline executable examples without changing inline source code", async () => {
    const text =
      "Run `node server.js --port 51101`, open `http://localhost:51101`, keep `const port = 51101` and `fetch('http://localhost:51101')`."
    const result = await retargetPart({ ...ids, type: "text", text }, mapping)
    expect(result.text).toBe(
      "Run `node server.js --port '53728'`, open `http://localhost:53728`, keep `const port = 51101` and `fetch('http://localhost:51101')`.",
    )
  })

  test.each([
    ["export PORT=51101", "export PORT='53728'"],
    ["gunicorn app:app --bind 127.0.0.1:51102", "gunicorn app:app --bind '127.0.0.1:53729'"],
    ["lsof -nP -iTCP:51101 -sTCP:LISTEN", "lsof -nP '-iTCP:53728' -sTCP:LISTEN"],
    ["nc -z localhost 51101", "nc -z localhost '53728'"],
    ["nc -z example.com 51101", "nc -z example.com 51101"],
    ["env PORT=51101 nohup npm run dev -- --port 51102", "env 'PORT=53728' nohup npm run dev -- --port '53729'"],
    ["pnpm exec vite --port=51101", "pnpm exec vite '--port=53728'"],
    ["npm --silent run dev -- --port 51101", "npm --silent run dev -- --port '53728'"],
    ["npm exec -- node server.cjs --port 51101", "npm exec -- node server.cjs --port '53728'"],
    ["npx --yes vite --port 51101", "npx --yes vite --port '53728'"],
    ["npx --no-install -- vite --port 51101", "npx --no-install -- vite --port '53728'"],
    ["serve -l tcp://127.0.0.1:51101", "serve -l 'tcp://127.0.0.1:53728'"],
    ["vite --port \\\n51101", "vite --port \\\n'53728'"],
  ])("handles shell assignment and wrapper forms: %s", async (command, expected) => {
    expect((await rewritePortCommand(command, mapping)).command).toBe(expected)
  })

  test.each([
    ["http://localhost:51101/a?q=51101#51101", "http://localhost:53728/a?q=51101#51101"],
    ["https://127.0.0.1:51102/a%2fb", "https://127.0.0.1:53729/a%2fb"],
    ["ws://[::1]:51103/socket", "ws://[::1]:53730/socket"],
    ["0.0.0.0:51101", "0.0.0.0:53728"],
    ["http://turn1-a--chat.localhost:6768/a?q=%2F", "http://turn2-b--chat.localhost:6768/a?q=%2F"],
    ["ws://port2--turn1-a--chat.localhost:6768/socket", "ws://port2--turn2-b--chat.localhost:6768/socket"],
    ["WS://port2--turn1-a--chat.localhost:6768/socket", "ws://port2--turn2-b--chat.localhost:6768/socket"],
    ["http://external.example:51101/path", "http://external.example:51101/path"],
    ["http://localhost:511010", "http://localhost:511010"],
    ["http://localhost:51101.evil.test", "http://localhost:51101.evil.test"],
    ["http://user:pass@localhost:51101", "http://user:pass@localhost:51101"],
  ])("retargets only owned endpoints: %s", (before, after) => expect(mapping.endpoint(before)).toBe(after))

  test("retargets explicit URLs in prose without touching numeric data, embedded URLs or data URIs", async () => {
    const text =
      "Preview: [open](http://localhost:51101/page). ID=51101 hash=aB51101Xy. data:image/svg+xml,http://localhost:51101 http://external.example/?next=http://localhost:51101"
    expect((await retargetPart({ ...ids, type: "text", text }, mapping)).text).toBe(
      text.replace("localhost:51101/page", "localhost:53728/page"),
    )
  })

  test.each([
    ["vite --port 51101", ["vite", "--port", "53728"]],
    ["vite --port=51101", ["vite", "--port=53728"]],
    ['next dev -p "51102"', ["next", "dev", "-p", "53729"]],
    ["python3 -m http.server 51103", ["python3", "-m", "http.server", "53730"]],
    ["npm run dev -- --port 51101", ["npm", "run", "dev", "--", "--port", "53728"]],
    ["uvicorn app:app --port 51101", ["uvicorn", "app:app", "--port", "53728"]],
    ["curl http://localhost:51102/health", ["curl", "http://localhost:53729/health"]],
  ])("preserves argv while retargeting network arguments: %s", async (command, expected) => {
    const mapped = await rewritePortCommand(command, mapping)
    // Execute only printf with the mapped literal argv, never the program under test.
    const process = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-c", `printf '%s\\0' ${mapped.command}`], {
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(process.stdout).text()).toBe(expected.join("\0") + "\0")
    expect(await process.exited).toBe(0)
  })

  test.each([
    "node -p 51101",
    "curl --request-target http://localhost:51101 https://example.com",
    "curl --header http://localhost:51101 https://example.com",
    "kill -9 51101",
    "echo --port 51101",
    "curl -d 'http://localhost:51101' https://example.com",
    "node -e 'server.listen(51101)'",
    "sh -c 'vite --port 51101'",
    "cat <<'EOF'\nPORT=51101\nEOF",
    "vite --port $PASEO_PORT",
    "vite --port ${PASEO_PORT2}",
    "echo $(curl http://localhost:51101)",
    "vite --port '51101",
    "write --port 51101",
    "curl https://example.com/?next=http://localhost:51101",
  ])("preserves opaque or ambiguous commands: %s", async (command) =>
    expect((await rewritePortCommand(command, mapping)).command).toBe(command),
  )

  test("retargets environment assignments while preserving all shell output", async () => {
    const command = 'PORT="51101" PASEO_PORT2=51102 npm run dev -- --port 51101'
    const result = await retargetPart(tool("bash", { command }, "Local: http://localhost:51101/ (PID 51101)"), mapping)
    expect(result.state.input.command).toBe("PORT=\"53728\" PASEO_PORT2='53729' npm run dev -- --port '53728'")
    expect(result.state.status === "completed" && result.state.output).toBe(
      "Local: http://localhost:51101/ (PID 51101)",
    )
    expect(await retargetPart(tool("bash", { command: "cat config.json" }, "http://localhost:51101"), mapping)).toEqual(
      tool("bash", { command: "cat config.json" }, "http://localhost:51101"),
    )
  })

  test("preserves combined-command output that can include arbitrary file contents", async () => {
    const part = tool("bash", { command: "vite --port 51101 & cat config.json" }, "http://localhost:51101")
    const result = await retargetPart(part, mapping)
    expect(result.state.input.command).toBe("vite --port '53728' & cat config.json")
    expect(result.state.status === "completed" && result.state.output).toBe("http://localhost:51101")
  })

  test("retargets navigation URL fields, keeping other fields and returned content unchanged", async () => {
    const part = tool(
      "paseo_browser_navigate",
      { url: "http://localhost:51101", tabId: "51101", text: "http://localhost:51101" },
      "http://localhost:51101",
    )
    expect(await retargetPart(part, mapping)).toEqual({
      ...part,
      state: { ...part.state, input: { ...part.state.input, url: "http://localhost:53728" } },
    })
  })

  test("builds requests repeatedly without changing stored history or current-turn content", async () => {
    const old = message([{ ...ids, type: "text", text: "http://localhost:51101" }])
    const fresh = message(old.parts, 20)
    const user: SessionV1.WithParts = {
      info: {
        id: MessageID.ascending(),
        sessionID: ids.sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("arena"), modelID: ModelV2.ID.make("test") },
      },
      parts: old.parts,
    }
    const source = [old, fresh, user]
    const saved = structuredClone(source)
    const projected = await retargetMessages(source, history, current, 10)
    expect(projected).toEqual([
      { ...old, parts: [{ ...ids, type: "text", text: "http://localhost:53728" }] },
      fresh,
      user,
    ])
    expect(await retargetMessages(source, history, current, 10)).toEqual(projected)
    expect(source).toEqual(saved)
  })

  test("does not cascade swapped ports or guess an ambiguous reused port", () => {
    const swapped = environmentReferences(history, { portAliases: { PASEO_PORT: 51102, PASEO_PORT2: 51101 } })
    expect(swapped.urls("http://localhost:51101 http://localhost:51102")).toBe(
      "http://localhost:51102 http://localhost:51101",
    )
    const ambiguous = environmentReferences([...history, { portAliases: { PASEO_PORT2: 51101 } }], current)
    expect(ambiguous.endpoint("http://localhost:51101")).toBe("http://localhost:51101")
    expect(ambiguous.endpoint("http://turn1-a--chat.localhost:6768")).toBe("http://turn2-b--chat.localhost:6768")
  })
})

test("the real SQLite-backed model conversion retargets requests without mutating saved parts", async () => {
  const { connectLocalStore } = await import("@/arena/local-store")
  const { setStoreForTest, registry, projectEnvironment } = await import("@/arena/runtime")
  const { toModelMessages } = await import("@/session/message-v2")
  const { tmpdir } = await import("../fixture/fixture")
  await using directory = await tmpdir()
  const store = await connectLocalStore({ directory: directory.path })
  const previous = process.env.OPENCODE_ARENA
  process.env.OPENCODE_ARENA = "1"
  setStoreForTest(store)
  try {
    // Persist the fields used by request projection in the real store, with no model or DB stubs.
    await store.db.collection<{ _id: string; chatID: string }>("turns").insertOne({ _id: "turn", chatID: "chat" })
    const runs = store.db.collection<{
      _id: string
      turnID: string
      rootSessionID: string
      descendantSessionIDs: string[]
      createdAt: Date
      portAliases: { PASEO_PORT: number }
    }>("runs")
    await runs.insertOne({
      _id: "old",
      turnID: "turn",
      rootSessionID: "old",
      descendantSessionIDs: [],
      createdAt: new Date(0),
      portAliases: { PASEO_PORT: 51101 },
    })
    await runs.insertOne({
      _id: "current",
      turnID: "turn",
      rootSessionID: ids.sessionID,
      descendantSessionIDs: ["ses_child"],
      createdAt: new Date(10),
      portAliases: { PASEO_PORT: 53728 },
    })
    const original = message([
      { ...ids, type: "text", text: "http://localhost:51101" },
      tool("bash", { command: "vite --port 51101" }),
    ])
    const records = store.db.collection<{ _id: string; message: SessionV1.WithParts }>("context_test")
    await records.insertOne({ _id: "source", message: original })
    const model: import("@/provider/provider").Provider.Model = {
      id: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("arena"),
      api: { id: "test", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
      name: "test",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 10000, input: 10000, output: 1000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    }
    const wire = await toModelMessages([original], model)
    expect(JSON.stringify(wire)).toContain("http://localhost:53728")
    expect(JSON.stringify(wire)).toContain("vite --port '53728'")
    expect((await records.findOne({ _id: "source" }))!.message).toEqual(original)
    expect(original.parts[0]).toEqual({ ...ids, type: "text", text: "http://localhost:51101" })
    expect(await toModelMessages([original], model, { stripMedia: true })).toEqual(wire)
    expect(
      await toModelMessages(
        [{ ...original, info: { ...original.info, sessionID: SessionID.make("ses_child") } }],
        model,
      ),
    ).toEqual(wire)
    registry.assign(ids.sessionID, {
      runID: "current",
      rootSessionID: ids.sessionID,
      scopeID: "turn",
      assignmentID: "assignment",
      telemetry: true,
    })
    expect(await toModelMessages([original], model)).toEqual(wire)
    const ordinary = await toModelMessages([original], { ...model, providerID: ProviderV2.ID.make("other") })
    expect(JSON.stringify(ordinary)).toContain("http://localhost:51101")

    // Other chats and future runs cannot make a known historical alias ambiguous.
    await store.db
      .collection<{ _id: string; chatID: string }>("turns")
      .insertOne({ _id: "other-turn", chatID: "other-chat" })
    await runs.insertOne({
      _id: "other-chat-run",
      turnID: "other-turn",
      rootSessionID: "other",
      descendantSessionIDs: [],
      createdAt: new Date(0),
      portAliases: { PASEO_PORT: 51101 },
    })
    await runs.insertOne({
      _id: "future",
      turnID: "turn",
      rootSessionID: "future",
      descendantSessionIDs: [],
      createdAt: new Date(30),
      portAliases: { PASEO_PORT: 51101 },
    })
    await runs.updateOne({ _id: "other-chat-run" }, { $set: { portAliases: { PASEO_PORT2: 51101 } } })
    await runs.updateOne({ _id: "future" }, { $set: { portAliases: { PASEO_PORT2: 51101 } } })
    expect(await toModelMessages([original], model)).toEqual(wire)

    // Resolve each request afresh after a port collision/reassignment, without cascading a projection.
    await runs.updateOne({ _id: "current" }, { $set: { portAliases: { PASEO_PORT: 54731 } } })
    expect(JSON.stringify(await toModelMessages([original], model))).toContain("http://localhost:54731")
    expect((await records.findOne({ _id: "source" }))!.message).toEqual(original)
    await runs.updateOne({ _id: "current" }, { $set: { portAliases: { PASEO_PORT: 53728 } } })

    const read = tool("read", { filePath: "/tmp/51101.png" }, "Image read successfully")
    read.callID = "image_read_51101"
    read.id = PartID.ascending()
    if (read.state.status !== "completed") throw new Error("fixture")
    const bytes = await Bun.file(new URL("../tool/fixtures/large-image.png", import.meta.url)).arrayBuffer()
    const base64 = Buffer.from(bytes).toString("base64")
    read.state.attachments = [{ ...ids, type: "file", mime: "image/png", url: `data:image/png;base64,${base64}` }]
    const withImage = message([...original.parts, read])
    const imageWire = await toModelMessages([withImage], model)
    const images = imageWire
      .flatMap((entry) => (typeof entry.content === "string" ? [] : entry.content))
      .filter((part) => part.type === "file" && part.mediaType === "image/png")
    expect(images).toHaveLength(1)
    expect(images[0]!.type === "file" && images[0]!.data.toString()).toBe(`data:image/png;base64,${base64}`)
    const compacted = await toModelMessages([withImage], model, { stripMedia: true })
    expect(JSON.stringify(compacted)).toContain("http://localhost:53728")
    expect(
      compacted
        .flatMap((entry) => (typeof entry.content === "string" ? [] : entry.content))
        .filter((part) => part.type === "file" && part.mediaType === "image/png"),
    ).toEqual([])
    expect(read.state.attachments[0]!.url).toBe(`data:image/png;base64,${base64}`)

    registry.assign(ids.sessionID, {
      runID: "current",
      rootSessionID: ids.sessionID,
      scopeID: "turn",
      assignmentID: "assignment",
      telemetry: false,
    })
    expect(await projectEnvironment([original])).toEqual([original])
    registry.assignments.clear()
    expect(
      await projectEnvironment([{ ...original, info: { ...original.info, sessionID: SessionID.make("ses_unknown") } }]),
    ).toEqual([{ ...original, info: { ...original.info, sessionID: SessionID.make("ses_unknown") } }])
    expect(await projectEnvironment([])).toEqual([])
    process.env.OPENCODE_ARENA = "0"
    expect(await projectEnvironment([original])).toEqual([original])
  } finally {
    registry.assignments.clear()
    setStoreForTest(undefined)
    if (previous === undefined) delete process.env.OPENCODE_ARENA
    else process.env.OPENCODE_ARENA = previous
    await store.close()
  }
})
