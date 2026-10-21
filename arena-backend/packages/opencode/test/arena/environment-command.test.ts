import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { environmentReferences, retargetPart } from "@/arena/environment-context"
import { rewritePortCommand } from "@/arena/path-command"
import { MessageID, PartID, SessionID } from "@/session/schema"

const mapping = environmentReferences([{ portAliases: { PASEO_PORT: 51101 } }], { portAliases: { PASEO_PORT: 53728 } })

describe("environment command argument boundaries", () => {
  test.each([
    "vite --port 51101 & declare -p CONFIG",
    "vite --port 51101 & export -p",
    "vite --port 51101 & export PORT=51101",
    "vite --port 51101 & [[ http://localhost:51101 == x ]]",
    "vite --port 51101 & (( 51101 ))",
    "vite --port 51101 & CONFIG=$(printf http://localhost:51101 >&2)",
    "CONFIG=$(printf http://localhost:51101 >&2) vite --port 51101",
    "function launch() { vite --port 51101; }",
  ])("keeps mixed statement output opaque in %s", async (command) => {
    const part: SessionV1.ToolPart = {
      id: PartID.ascending(),
      messageID: MessageID.ascending(),
      sessionID: SessionID.make("ses_command_test"),
      type: "tool",
      tool: "bash",
      callID: "command_test",
      state: {
        status: "completed",
        input: { command },
        output: "CONFIG=http://localhost:51101",
        title: "statement output",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    const result = await retargetPart(part, mapping)
    expect(result.state.status === "completed" && result.state.output).toBe("CONFIG=http://localhost:51101")
    expect(result.state.input.command).toContain("vite --port '53728'")
    if (command.includes("export PORT=")) expect(result.state.input.command).toContain("export PORT='53728'")
  })

  test.each([
    ["curl -ksS http://localhost:51101", "curl -ksS 'http://localhost:53728'"],
    ["vite --host --port 51101", "vite --host --port '53728'"],
    ["npm run dev -- --host --port 51101", "npm run dev -- --host --port '53728'"],
    ["vite --host 127.0.0.1 --port 51101", "vite --host 127.0.0.1 --port '53728'"],
    ["vite --host 51101 --port 51101", "vite --host 51101 --port '53728'"],
    ["curl -fsS --noproxy '*' http://localhost:51101", "curl -fsS --noproxy '*' 'http://localhost:53728'"],
    ["curl -6g --noproxy '*' 'http://[::1]:51101'", "curl -6g --noproxy '*' 'http://[::1]:53728'"],
    [
      "curl --noproxy http://localhost:51101 http://localhost:51101",
      "curl --noproxy http://localhost:51101 'http://localhost:53728'",
    ],
    ["wget -qO- http://localhost:51101", "wget -qO- 'http://localhost:53728'"],
    ["wget -qO /tmp/51101 http://localhost:51101", "wget -qO /tmp/51101 'http://localhost:53728'"],
    ["curl --header=X http://localhost:51101", "curl --header=X 'http://localhost:53728'"],
    ["curl --url=http://localhost:51101", "curl '--url=http://localhost:53728'"],
    ["curl -- http://localhost:51101", "curl -- 'http://localhost:53728'"],
    [
      "curl -H http://localhost:51101 http://localhost:51101",
      "curl -H http://localhost:51101 'http://localhost:53728'",
    ],
    ["curl -dhttp://localhost:51101 http://localhost:51101", "curl -dhttp://localhost:51101 'http://localhost:53728'"],
    [
      "curl --data=http://localhost:51101 http://localhost:51101",
      "curl --data=http://localhost:51101 'http://localhost:53728'",
    ],
    [
      "curl -o http://localhost:51101 http://localhost:51101",
      "curl -o http://localhost:51101 'http://localhost:53728'",
    ],
    ["python3 -m http.server --bind 127.0.0.1 51101", "python3 -m http.server --bind 127.0.0.1 '53728'"],
    ["python3 -m http.server --directory 51101 51101", "python3 -m http.server --directory 51101 '53728'"],
    [
      "node server.js --message http://localhost:51101 --port 51101",
      "node server.js --message http://localhost:51101 --port '53728'",
    ],
    ["vite --define http://localhost:51101 --port 51101", "vite --define http://localhost:51101 --port '53728'"],
    ["serve --listen=tcp://127.0.0.1:51101", "serve '--listen=tcp://127.0.0.1:53728'"],
    ["gunicorn app:app --bind=127.0.0.1:51101", "gunicorn app:app '--bind=127.0.0.1:53728'"],
    [
      "open -a http://localhost:51101 http://localhost:51101",
      "open -a http://localhost:51101 'http://localhost:53728'",
    ],
  ])("retargets only the endpoint argv in %s", async (command, expected) => {
    expect((await rewritePortCommand(command, mapping)).command).toBe(expected)
  })

  test.each([
    "node server.js -- --port 51101",
    "node server.js --message --port 51101",
    "npm run dev -- -- --port 51101",
    "curl --unknown http://localhost:51101",
    "curl -Zunknown http://localhost:51101",
    "open -a Safari --args http://localhost:51101",
    "python3 -m http.server --directory 51101",
    "serve http://localhost:51101",
    "vite http://localhost:51101",
    "node server.js http://localhost:51101",
    "npx --package unknown vite --port 51101",
  ])("preserves opaque payloads and unknown syntax in %s", async (command) => {
    expect((await rewritePortCommand(command, mapping)).command).toBe(command)
  })
})
