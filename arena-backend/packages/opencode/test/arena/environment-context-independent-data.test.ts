import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"
import { environmentReferences, retargetPart } from "../../src/arena/environment-context"
import { rewritePortCommand } from "../../src/arena/path-command"

const mapping = environmentReferences(
  [{ portAliases: { PASEO_PORT: 3100, PASEO_PORT2: 3200 }, previewUrls: { PASEO_PORT: "http://old.localhost:7777" } }],
  { portAliases: { PASEO_PORT: 4100, PASEO_PORT2: 4200 }, previewUrls: { PASEO_PORT: "http://new.localhost:8888" } },
)
const base = {
  id: SessionV1.PartID.make("prt_3100"),
  sessionID: SessionID.make("ses_3100"),
  messageID: SessionV1.MessageID.make("msg_3100"),
}
async function text(value: string) {
  return (await retargetPart({ ...base, type: "text", text: value }, mapping)).text
}

describe("independent history data integrity", () => {
  test.each([
    ["http://localhost:3100/3100?q=3100#3100", "http://localhost:4100/3100?q=3100#3100"],
    ["https://127.0.0.1:3100/a%2Fb?token=3100%2B", "https://127.0.0.1:4100/a%2Fb?token=3100%2B"],
    ["ws://[::1]:3200/ws", "ws://[::1]:4200/ws"],
    ["http://0.0.0.0:3100/", "http://0.0.0.0:4100/"],
    ["http://LOCALHOST:3100/", "http://LOCALHOST:4100/"],
    ["http://old.localhost:7777/a?port=3100", "http://new.localhost:8888/a?port=3100"],
    ["ws://old.localhost:7777/ws", "ws://new.localhost:8888/ws"],
    ["[http://localhost:3100](http://localhost:3100)", "[http://localhost:4100](http://localhost:4100)"],
    ["(http://localhost:3100).", "(http://localhost:4100)."],
    [
      "3100 bytes, 3200 ms, 13100, 31000, /tmp/3100.png, sha256:a3100b",
      "3100 bytes, 3200 ms, 13100, 31000, /tmp/3100.png, sha256:a3100b",
    ],
    ["https://example.test:3100/localhost:3100", "https://example.test:3100/localhost:3100"],
    ["http://localhost.example.test:3100", "http://localhost.example.test:3100"],
    ["http://localhost:31000", "http://localhost:31000"],
    ["http://localhost:3100@evil.test/", "http://localhost:3100@evil.test/"],
    ["http://evil.test/path/http://localhost:3100", "http://evil.test/path/http://localhost:3100"],
    ["data:text/plain,http://localhost:3100", "data:text/plain,http://localhost:3100"],
    ["data:image/png;base64,a3100b3200c==", "data:image/png;base64,a3100b3200c=="],
    [
      "`const port = 3100; const url = 'http://localhost:3100'`",
      "`const port = 3100; const url = 'http://localhost:3100'`",
    ],
    [
      '```json\n{"url":"http://localhost:3100","count":3100}\n```',
      '```json\n{"url":"http://localhost:3100","count":3100}\n```',
    ],
    ["    curl http://localhost:3100\n", "    curl http://localhost:3100\n"],
    [
      '```bash\ncurl http://localhost:3100 -d \'{"count":3100,"url":"http://localhost:3100"}\'\n```',
      '```bash\ncurl \'http://localhost:4100\' -d \'{"count":3100,"url":"http://localhost:3100"}\'\n```',
    ],
  ])("text %s", async (input, expected) => {
    expect(await text(input)).toBe(expected)
  })

  test.each([
    [
      "curl --data '3100 http://localhost:3100' http://localhost:3100",
      "curl --data '3100 http://localhost:3100' 'http://localhost:4100'",
    ],
    [
      "curl -H 'X-Origin: http://localhost:3100' --url http://localhost:3100",
      "curl -H 'X-Origin: http://localhost:3100' --url 'http://localhost:4100'",
    ],
    ["curl -o http://localhost:3100 http://localhost:3100", "curl -o http://localhost:3100 'http://localhost:4100'"],
    [
      "curl --proxy http://localhost:3100 http://localhost:3200",
      "curl --proxy http://localhost:3100 'http://localhost:4200'",
    ],
    ["PORT=3100 npm run dev -- --port 3100", "PORT='4100' npm run dev -- --port '4100'"],
    ["python3 -m http.server 3100 --bind 127.0.0.1", "python3 -m http.server '4100' --bind 127.0.0.1"],
    ["env PORT=3100 npx --yes vite --port=3100", "env 'PORT=4100' npx --yes vite '--port=4100'"],
    ["printf '%s' 'http://localhost:3100'", "printf '%s' 'http://localhost:3100'"],
    ["node -e 'fetch(\"http://localhost:3100\")'", "node -e 'fetch(\"http://localhost:3100\")'"],
    ["cat <<'EOF'\nhttp://localhost:3100\nPORT=3100\nEOF", "cat <<'EOF'\nhttp://localhost:3100\nPORT=3100\nEOF"],
    ['curl "http://localhost:3100/$TOKEN"', 'curl "http://localhost:3100/$TOKEN"'],
    ["python3 -m http.server 3100 > /tmp/3100.log", "python3 -m http.server '4100' > /tmp/3100.log"],
  ])("command %s", async (input, expected) => {
    expect((await rewritePortCommand(input, mapping)).command).toBe(expected)
  })

  test("preserves opaque parts, screenshot data and metadata, leaving input immutable", async () => {
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAABGR1RUxY310064gi3wAAAABJRU5ErkJggg=="
    const attachment: SessionV1.FilePart = {
      ...base,
      type: "file",
      mime: "image/png",
      filename: "3100.png",
      url: image,
    }
    const tool: SessionV1.ToolPart = {
      ...base,
      type: "tool",
      tool: "bash",
      callID: "call_3100",
      metadata: { signature: "3100", raw: image },
      state: {
        status: "completed",
        input: { command: "npm run dev -- --port 3100", timeout: 3100, payload: { url: "http://localhost:3100" } },
        output: "Ready http://localhost:3100\n" + image,
        title: "3100",
        metadata: { url: image, hash: "a3100b" },
        time: { start: 3100, end: 3200 },
        attachments: [attachment],
      },
    }
    const before = JSON.stringify(tool)
    const expected = structuredClone(tool)
    expected.state.input.command = "npm run dev -- --port '4100'"
    if (expected.state.status !== "completed") throw new Error("fixture must be completed")
    expect(await retargetPart(tool, mapping)).toEqual(expected)
    expect(JSON.stringify(tool)).toBe(before)
    expect(await retargetPart(attachment, mapping)).toBe(attachment)
    const reasoning: SessionV1.ReasoningPart = {
      ...base,
      type: "reasoning",
      text: "http://localhost:3100",
      metadata: { signature: image },
      time: { start: 3100 },
    }
    expect(await retargetPart(reasoning, mapping)).toBe(reasoning)
    const opaque = { ...tool, tool: "read" }
    expect(await retargetPart(opaque, mapping)).toBe(opaque)
  })

  test("ambiguous reused port stays put but exact preview origin identifies alias", () => {
    const ambiguous = environmentReferences(
      [
        { portAliases: { PASEO_PORT: 3100 }, previewUrls: { PASEO_PORT: "http://a.localhost:7777" } },
        { portAliases: { PASEO_PORT2: 3100 }, previewUrls: { PASEO_PORT2: "http://b.localhost:7777" } },
      ],
      {
        portAliases: { PASEO_PORT: 4100, PASEO_PORT2: 4200 },
        previewUrls: { PASEO_PORT: "http://c.localhost:7777", PASEO_PORT2: "http://d.localhost:7777" },
      },
    )
    expect(ambiguous.urls("http://localhost:3100 http://a.localhost:7777 http://b.localhost:7777")).toBe(
      "http://localhost:3100 http://c.localhost:7777 http://d.localhost:7777",
    )
  })

  test("maps original references once when new ports overlap old ports", () => {
    const overlap = environmentReferences([{ portAliases: { PASEO_PORT: 3100, PASEO_PORT2: 3200 } }], {
      portAliases: { PASEO_PORT: 3200, PASEO_PORT2: 4100 },
    })
    expect(overlap.urls("http://localhost:3100 http://localhost:3200")).toBe(
      "http://localhost:3200 http://localhost:4100",
    )
  })
})

test.each([
  {
    name: "IPv4",
    bind: "127.0.0.1",
    directHost: "127.0.0.1",
    spellings: [
      { origin: "http://127.0.0.1", padding: "" },
      { origin: "//localhost", padding: "" },
      { origin: "http://%6cocalhost", padding: "" },
      { origin: "http://127.1", padding: "" },
      { origin: "http://localhost", padding: "0" },
      { origin: "//127.1", padding: "00" },
    ],
  },
  {
    name: "IPv6",
    bind: "::1",
    directHost: "[::1]",
    spellings: [
      { origin: "http://[0:0:0:0:0:0:0:1]", padding: "" },
      { origin: "//[0:0:0:0:0:0:0:1]", padding: "" },
      { origin: "http://[::1]", padding: "0" },
    ],
  },
])(
  "normalized $name URLs reach only the current real HTTP listener and preserve request bytes",
  async ({ bind, directHost, spellings }) => {
    await using oldFiles = await tmpdir()
    await using newFiles = await tmpdir()
    await Bun.write(`${oldFiles.path}/index.html`, "old turn; immutable data 3100")
    await Bun.write(`${newFiles.path}/index.html`, "current turn; immutable data 3100")
    const oldServer = Bun.spawn(
      ["python3", "-u", "-m", "http.server", "0", "--bind", bind, "--directory", oldFiles.path],
      { stdout: "pipe", stderr: "pipe" },
    )
    const newServer = Bun.spawn(
      ["python3", "-u", "-m", "http.server", "0", "--bind", bind, "--directory", newFiles.path],
      { stdout: "pipe", stderr: "pipe" },
    )
    const port = async (server: typeof oldServer) => {
      const reader = server.stdout.getReader()
      let output = ""
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done)
            throw new Error(
              "HTTP server ended before readiness: " + output + (await new Response(server.stderr).text()),
            )
          output += new TextDecoder().decode(next.value)
          const match = /port (\d+)/.exec(output)
          if (match) return Number(match[1])
        }
      } finally {
        reader.releaseLock()
      }
    }
    const expectedNewRequests: string[] = []
    try {
      const [oldPort, newPort] = await Promise.all([port(oldServer), port(newServer)])
      const live = environmentReferences([{ portAliases: { PASEO_PORT: oldPort } }], {
        portAliases: { PASEO_PORT: newPort },
      })
      for (const [index, spelling] of spellings.entries()) {
        const requestTarget = `/index.html?case=${index}&data=${oldPort}%2B3100&raw=%2f%2F`
        const suffix = requestTarget + `#keep-${oldPort}`
        const original = `${spelling.origin}:${spelling.padding}${oldPort}${suffix}`
        const projected = live.endpoint(original)
        expect(projected).toBe(`${spelling.origin}:${newPort}${suffix}`)
        const resolved = new URL(projected, "http://unused.invalid/base")
        expect(await (await fetch(resolved)).text()).toBe("current turn; immutable data 3100")
        expectedNewRequests.push(requestTarget)
      }
      expect(await (await fetch(`http://${directHost}:${oldPort}/index.html?verify=old`)).text()).toBe(
        "old turn; immutable data 3100",
      )
    } finally {
      oldServer.kill()
      newServer.kill()
      await Promise.all([oldServer.exited, newServer.exited])
    }
    const oldLog = await new Response(oldServer.stderr).text()
    const newLog = await new Response(newServer.stderr).text()
    const requestTargets = (log: string) => [...log.matchAll(/"GET ([^"\r\n]+) HTTP\/1\.1"/g)].map((match) => match[1])
    expect(requestTargets(oldLog)).toEqual(["/index.html?verify=old"])
    expect(requestTargets(newLog)).toEqual(expectedNewRequests)
  },
)

describe("independent adversarial boundaries", () => {
  test.each([
    "app.localhost:3100",
    "not-localhost:3100",
    "prefix.127.0.0.1:3100",
    "server-0.0.0.0:3100",
    "http://localhost:3100.evil.test/path",
    "http://localhost%2eevil.test:3100/",
    "http://[::1]:3100@evil.test/",
    "http://user:3100@evil.test/",
    "http://evil.test/%2f%2flocalhost:3100",
    "/tmp/localhost:3100",
    "user@localhost:3100",
    "sha256:abc3100320041004200",
    "data:image/png;base64,3100310032003200==",
    "```python\nPORT=3100\nurl='http://localhost:3100'\n```",
    "````json\n```bash\ncurl http://localhost:3100\n```\n````",
    "> ```bash\n> curl http://localhost:3100\n> ```",
    "- ```bash\n  curl http://localhost:3100\n  ```",
    "```bash\ncurl http://localhost:3100",
    "`curl http://localhost:3100",
    "``printf '`curl http://localhost:3100`'``",
  ])("opaque or non-owned text: %s", async (input) => {
    expect(await text(input)).toBe(input)
  })

  test.each([
    "bash -c 'PORT=3100 curl http://localhost:3100'",
    "eval 'curl http://localhost:3100'",
    "cat <<< 'PORT=3100 http://localhost:3100'",
    "cat <(curl http://localhost:3100)",
    "printf '%s' $(curl http://localhost:3100)",
    "printf '%s' '3100'",
    "git log --grep=3100",
    "curl --data-binary 'http://localhost:3100' https://example.test/3100",
    "curl -F 'file=@3100.png' https://example.test/3100",
    "curl -H 'Referer: http://localhost:3100' https://example.test/3100",
    "curl --cookie 'port=3100; url=http://localhost:3100' https://example.test/3100",
    "curl --resolve 'localhost:3100:127.0.0.1' https://example.test/3100",
  ])("opaque shell payload: %s", async (input) => {
    expect((await rewritePortCommand(input, mapping)).command).toBe(input)
  })

  test("colliding aliases over three banks never guess a service from shared digits", () => {
    const collisions = environmentReferences(
      [
        { portAliases: { PASEO_PORT: 3100, PASEO_PORT2: 3200, PASEO_PORT3: 3300 } },
        { portAliases: { PASEO_PORT: 3200, PASEO_PORT2: 3300, PASEO_PORT3: 3100 } },
        { portAliases: { PASEO_PORT: 3300, PASEO_PORT2: 3100, PASEO_PORT3: 3200 } },
      ],
      { portAliases: { PASEO_PORT: 4100, PASEO_PORT2: 4200, PASEO_PORT3: 4300 } },
    )
    const input = "http://localhost:3100 http://localhost:3200 http://localhost:3300 310032003300"
    expect(collisions.urls(input)).toBe(input)
    expect(collisions.port("3100")).toBe("3100")
    expect(collisions.port("3200")).toBe("3200")
    expect(collisions.port("3300")).toBe("3300")
  })

  test("ambiguous identical historical origins cannot silently choose an alias", () => {
    const collisions = environmentReferences(
      [
        { previewUrls: { PASEO_PORT: "http://same.localhost:7777" } },
        { previewUrls: { PASEO_PORT2: "http://same.localhost:7777" } },
      ],
      { previewUrls: { PASEO_PORT: "http://one.localhost:8888", PASEO_PORT2: "http://two.localhost:8888" } },
    )
    expect(collisions.endpoint("http://same.localhost:7777/a?3100")).toBe("http://same.localhost:7777/a?3100")
  })
})

test("browser navigation rewrites only the destination and preserves nested screenshots and output", async () => {
  const input: SessionV1.ToolPart = {
    ...base,
    type: "tool",
    tool: "paseo_browser_navigate",
    callID: "call_3100",
    metadata: { signature: "31003200", encoded: "data:image/jpeg;base64,/9j/310031003200==" },
    state: {
      status: "completed",
      input: {
        url: "http://[::1]:3100/page?data=3100",
        timeout: 3100,
        screenshot: { data: "310031003200", url: "http://localhost:3100" },
      },
      output: '{"url":"http://localhost:3100","payload":"310031003200"}',
      title: "3100",
      metadata: { image: { url: "data:image/jpeg;base64,/9j/310031003200==" } },
      time: { start: 3100, end: 3200 },
    },
  }
  const original = structuredClone(input)
  const expected = structuredClone(input)
  expected.state.input.url = "http://[::1]:4100/page?data=3100"
  expect(await retargetPart(input, mapping)).toEqual(expected)
  expect(input).toEqual(original)
})

test("costs, token counts, snapshot and patch identifiers remain byte-for-byte unchanged", async () => {
  const parts: SessionV1.Part[] = [
    { ...base, type: "snapshot", snapshot: "3100http://localhost:3100" },
    { ...base, type: "patch", hash: "310031003200", files: ["3100.ts", "localhost:3100"] },
    {
      ...base,
      type: "step-finish",
      reason: "3100",
      cost: 3100,
      snapshot: "310032004100",
      tokens: { input: 3100, output: 3200, reasoning: 3100, cache: { read: 3100, write: 3200 } },
    },
  ]
  const before = JSON.stringify(parts)
  expect(await Promise.all(parts.map((part) => retargetPart(part, mapping)))).toEqual(parts)
  expect(JSON.stringify(parts)).toBe(before)
})

describe("normalized local endpoints preserve raw spelling outside the owned port", () => {
  test.each([
    ["//localhost:3100/3100?q=3100#3100", "//localhost:4100/3100?q=3100#3100"],
    ["//127.0.0.1:3200/api?token=3100%2B", "//127.0.0.1:4200/api?token=3100%2B"],
    ["//old.localhost:7777/a%2Fb?q=3100#3100", "//new.localhost:8888/a%2Fb?q=3100#3100"],
    ["http://127.1:3100/3100?q=3100#3100", "http://127.1:4100/3100?q=3100#3100"],
    ["http://[0:0:0:0:0:0:0:1]:3100/a%2Fb", "http://[0:0:0:0:0:0:0:1]:4100/a%2Fb"],
    ["ws://[0:0:0:0:0:0:0:1]:3200/ws?data=3100", "ws://[0:0:0:0:0:0:0:1]:4200/ws?data=3100"],
    ["http://%6cocalhost:3100/3100?q=3100#3100", "http://%6cocalhost:4100/3100?q=3100#3100"],
    ["http://local%68ost:3200/path?data=3100", "http://local%68ost:4200/path?data=3100"],
    ["http://localhost:03100/a%2Fb?q=03100", "http://localhost:4100/a%2Fb?q=03100"],
    ["//127.1:003100/a?data=3100", "//127.1:4100/a?data=3100"],
  ])("retargets %s", async (input, expected) => {
    expect(mapping.endpoint(input)).toBe(expected)
    expect(await text(input)).toBe(expected)
  })

  test.each([
    "//localhost:3101/a?q=3100",
    "//old.localhost:7778/a?q=3100",
    "http://127.1:3101/a?q=3100",
    "http://[0:0:0:0:0:0:0:1]:3101/a?q=3100",
    "http://%6cocalhost:3101/a?q=3100",
    "http://localhost:03101/a?q=3100",
    "http://%6cocalhost.evil.test:3100/a?q=3100",
    "http://127.1.evil.test:3100/a?q=3100",
    "http://localhost%40evil.test:3100/a?q=3100",
    "http://user%40localhost:3100/a?q=3100",
    "//localhost%40evil.test:3100/a?q=3100",
    "http://user:password@localhost:3100/a?q=3100",
    "//user:password@localhost:3100/a?q=3100",
    "http://localhost:3100@evil.test/a?q=3100",
  ])("leaves unowned or authenticated reference intact: %s", async (input) => {
    expect(mapping.endpoint(input)).toBe(input)
    expect(await text(input)).toBe(input)
  })
})

test.each([
  ["node dump-fixture.js", "node dump-fixture.js"],
  ["npm run dev -- --port 3100", "npm run dev -- --port '4100'"],
])("preserves all bash stdout as opaque for %s", async (command, expectedCommand) => {
  const output =
    '{"expectedUrl":"http://localhost:3100/3100?q=3100","count":3100,"image":"data:image/png;base64,a3100b3200c=="}\nLocal: http://localhost:3100/\n'
  const part: SessionV1.ToolPart = {
    ...base,
    type: "tool",
    tool: "bash",
    callID: "call_stdout_3100",
    state: {
      status: "completed",
      input: { command },
      output,
      title: "script output",
      metadata: { source: "fixture-3100.json" },
      time: { start: 3100, end: 3200 },
    },
  }
  const original = structuredClone(part)
  const expected = structuredClone(part)
  expected.state.input.command = expectedCommand
  expect(await retargetPart(part, mapping)).toEqual(expected)
  expect(part).toEqual(original)
})
