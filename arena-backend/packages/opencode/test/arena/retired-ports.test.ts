import { afterEach, describe, expect, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  createProcessIdentifier,
  createRetiredPortForwarder,
  matchCaller,
  OPEN_SHIM,
  parseHttpHead,
  parseNetstatOwner,
  processChain,
  referrerContestant,
  type Contestant,
  type RetiredPortForwarder,
} from "@/arena/retired-ports"
import { forgetCallerRoot, recordCallerRoot } from "@/arena/caller-roots"
import { serviceOwnerID } from "@/arena/services"

const SIDE_A: Contestant = {
  directory: "/pool/generation-3-a",
  hostname: "turn3-a--chat.localhost",
  portAliases: { PASEO_PORT: 20_110, PASEO_PORT2: 20_111, PASEO_PORT3: 20_112 },
}
const SIDE_B: Contestant = {
  directory: "/pool/generation-3-b",
  hostname: "turn3-b--chat.localhost",
  portAliases: { PASEO_PORT: 20_113, PASEO_PORT2: 20_114, PASEO_PORT3: 20_115 },
}

describe("caller identification", () => {
  test("reads the client end's owner from macOS netstat, process names with spaces included", () => {
    const output = [
      "Active Internet connections (including servers)",
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options",
      "tcp4       0      0  127.0.0.1.29871        127.0.0.1.51969        ESTABLISHED          208            0  408256  146988             bun:36478  00102 00000104",
      "tcp4       0      0  127.0.0.1.51969        127.0.0.1.29871        ESTABLISHED            0           78  408300  146988    Google Chrome H:36482  00102 00000008",
      "tcp6       0      0  ::1.51970              ::1.29871              ESTABLISHED            0           78  408300  146988             curl:36490  00102 00000008",
    ].join("\n")

    expect(parseNetstatOwner(output, { localPort: 29871, remotePort: 51969 })).toBe(36482)
    expect(parseNetstatOwner(output, { localPort: 29871, remotePort: 51970 })).toBe(36490)
    expect(parseNetstatOwner(output, { localPort: 29871, remotePort: 5196 })).toBeUndefined()
  })

  test("walks the parent chain nearest first and stops at the engine", () => {
    const parents = new Map([
      [40, 30],
      [30, 20],
      [20, 10],
      [10, 1],
    ])
    expect(processChain(40, parents, 20)).toEqual([40, 30])
    expect(processChain(40, parents, 999)).toEqual([40, 30, 20, 10])
  })

  test("prefers a recorded root, then the environment, then the working directory", () => {
    const contestants = [SIDE_A, SIDE_B]
    // curl (SIP: no environment) under a zsh the shell tool started for side B.
    expect(
      matchCaller({ chain: [40, 30], roots: new Map([[30, serviceOwnerID(SIDE_B.directory)]]) }, contestants),
    ).toBe(SIDE_B)
    // A node server whose shell has exited: its own environment names its owner.
    expect(
      matchCaller(
        {
          chain: [50],
          environments: new Map([
            [50, `node server.js PASEO_ARENA_OWNER_ID=${serviceOwnerID(SIDE_A.directory)} PATH=/bin`],
          ]),
        },
        contestants,
      ),
    ).toBe(SIDE_A)
    expect(
      matchCaller(
        { chain: [50], environments: new Map([[50, "python -m http.server PASEO_PORT=20113"]]) },
        contestants,
      ),
    ).toBe(SIDE_B)
    // A terminal shell the daemon opened in side A's worktree.
    expect(matchCaller({ chain: [60, 61], cwds: new Map([[61, "/pool/generation-3-a/apps/web"]]) }, contestants)).toBe(
      SIDE_A,
    )
    expect(matchCaller({ chain: [60], cwds: new Map([[60, "/pool/generation-3-ab"]]) }, contestants)).toBeUndefined()
  })

  test.skipIf(process.platform !== "darwin")("identifies a real caller by the owner in its environment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-caller-"))
    const contestant = { ...SIDE_A, directory }
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
    const child = spawn(
      process.execPath,
      ["-e", `require("net").connect(${port}, "127.0.0.1"); setTimeout(() => {}, 10000)`],
      { cwd: os.tmpdir(), env: { ...process.env, PASEO_ARENA_OWNER_ID: serviceOwnerID(directory) }, stdio: "ignore" },
    )
    try {
      const socket = await accepted
      const found = await createProcessIdentifier()(
        {
          localAddress: socket.localAddress,
          localPort: socket.localPort,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        },
        [SIDE_B, contestant],
      )
      expect(found?.contestant).toBe(contestant)
      expect(found?.method).toBe("env")
      socket.destroy()
    } finally {
      child.kill()
      server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== "darwin")(
    "identifies a platform binary through the root that started it",
    async () => {
      const server = net.createServer()
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const port = (server.address() as net.AddressInfo).port
      const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
      // zsh and curl show no environment to `ps`, and `cd /` leaves no worktree cwd behind.
      const shell = spawn("/bin/zsh", ["-c", `cd / && /usr/bin/curl -s -m 5 http://127.0.0.1:${port}/`], {
        stdio: "ignore",
      })
      recordCallerRoot(shell.pid, serviceOwnerID(SIDE_B.directory))
      try {
        const socket = await accepted
        const found = await createProcessIdentifier()(
          { localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort },
          [SIDE_A, SIDE_B],
        )
        expect(found?.contestant).toBe(SIDE_B)
        expect(found?.method).toBe("root")
        socket.destroy()
      } finally {
        forgetCallerRoot(shell.pid)
        shell.kill()
        server.close()
      }
    },
  )
})

describe("HTTP fallback", () => {
  test("waits for a whole request head and refuses anything that is not HTTP", () => {
    expect(parseHttpHead(Buffer.from("GET / HT")).kind).toBe("incomplete")
    expect(parseHttpHead(Buffer.from("\x16\x03\x01\x02\x00"))).toEqual({ kind: "other" })
    expect(parseHttpHead(Buffer.from("SSH-2.0-OpenSSH\r\n")).kind).toBe("other")
    expect(
      parseHttpHead(
        Buffer.from("GET /app.js HTTP/1.1\r\nHost: localhost:20001\r\nReferer: http://localhost:20113/\r\n\r\n"),
      ),
    ).toEqual({ kind: "http", headers: { host: "localhost:20001", referer: "http://localhost:20113/" } })
  })

  test("routes a browser by the current port or preview host its page came from", () => {
    expect(referrerContestant({ referer: "http://localhost:20113/index.html" }, [SIDE_A, SIDE_B])).toBe(SIDE_B)
    expect(referrerContestant({ origin: "http://127.0.0.1:20111" }, [SIDE_A, SIDE_B])).toBe(SIDE_A)
    expect(referrerContestant({ referer: "http://port2--turn3-b--chat.localhost:6767/" }, [SIDE_A, SIDE_B])).toBe(
      SIDE_B,
    )
    // A page from an earlier turn's port says nothing about who is asking.
    expect(referrerContestant({ referer: "http://localhost:20001/" }, [SIDE_A, SIDE_B])).toBeUndefined()
  })
})

describe("retired-port forwarder", () => {
  let forwarder: RetiredPortForwarder | undefined
  const servers: net.Server[] = []

  afterEach(async () => {
    await forwarder?.close()
    forwarder = undefined
    for (const server of servers.splice(0)) server.close()
  })

  const freePort = async () => {
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const port = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }

  const echo = async (name: string) => {
    const server = net.createServer((socket) => socket.on("data", (data) => socket.end(`${name}:${data}`)))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    return (server.address() as net.AddressInfo).port
  }

  const request = (port: number, payload: string, host = "127.0.0.1") =>
    new Promise<string>((resolve) => {
      const socket = net.connect({ port, host })
      let received = ""
      socket.on("data", (data) => (received += data))
      socket.on("close", () => resolve(received))
      socket.on("error", () => resolve(received))
      socket.on("connect", () => socket.write(payload))
    })

  test("forwards an identified caller to its own port with the same alias", async () => {
    const primary = await echo("a-primary")
    const second = await echo("a-second")
    const side = { ...SIDE_A, portAliases: { PASEO_PORT: primary, PASEO_PORT2: second, PASEO_PORT3: 1 } }
    const [old, old2] = [await freePort(), await freePort()]
    const outcomes: string[] = []
    forwarder = createRetiredPortForwarder({
      identify: async (_connection, contestants) => ({ contestant: contestants[0]!, method: "root" }),
      onConnection: (retired, outcome) =>
        outcomes.push(`${retired.alias}:${outcome.kind}:${outcome.kind === "forwarded" ? outcome.method : ""}`),
    })
    const result = await forwarder.sync("chat", {
      ports: [
        { port: old, alias: "PASEO_PORT", turnIndex: 0 },
        { port: old2, alias: "PASEO_PORT2", turnIndex: 0 },
      ],
      contestants: async () => [side],
    })

    expect(result.listening).toEqual([old, old2].sort((left, right) => left - right))
    expect(await request(old, "ping")).toBe("a-primary:ping")
    expect(await request(old2, "ping")).toBe("a-second:ping")
    expect(await request(old, "ping", "::1")).toBe("a-primary:ping")
    expect(forwarder.holds(old)).toBe(true)
    expect(outcomes).toEqual(["PASEO_PORT:forwarded:root", "PASEO_PORT2:forwarded:root", "PASEO_PORT:forwarded:root"])
  })

  test("tells an unidentified HTTP caller the port is from an earlier turn and closes anything else", async () => {
    const old = await freePort()
    const outcomes: string[] = []
    forwarder = createRetiredPortForwarder({
      identify: async () => undefined,
      sniffTimeoutMs: 200,
      onConnection: (_retired, outcome) => outcomes.push(outcome.kind),
    })
    await forwarder.sync("chat", {
      ports: [{ port: old, alias: "PASEO_PORT2", turnIndex: 1 }],
      contestants: async () => [SIDE_A],
    })

    const answer = await request(old, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
    expect(answer).toStartWith("HTTP/1.1 410 Gone\r\n")
    expect(answer).toContain("Port " + old + " was PASEO_PORT2 of turn 2")
    expect(answer).toContain("$PASEO_PORT2 or the URL in $ARENA_PREVIEW_URL2")
    expect(await request(old, "\x16\x03\x01")).toBe("")
    expect(outcomes).toEqual(["gone", "closed"])
  })

  test("routes an unidentified browser by its Referer", async () => {
    const primary = await echo("b-primary")
    const side = { ...SIDE_B, portAliases: { PASEO_PORT: primary, PASEO_PORT2: 2, PASEO_PORT3: 3 } }
    const old = await freePort()
    forwarder = createRetiredPortForwarder({ identify: async () => undefined })
    await forwarder.sync("chat", {
      ports: [{ port: old, alias: "PASEO_PORT", turnIndex: 0 }],
      contestants: async () => [SIDE_A, side],
    })

    const answer = await request(old, `GET / HTTP/1.1\r\nReferer: http://localhost:${primary}/\r\n\r\n`)
    expect(answer).toStartWith("b-primary:GET / HTTP/1.1")
  })

  test("tells an identified HTTP caller that its own port has no server yet", async () => {
    const [old, idle] = [await freePort(), await freePort()]
    const side = { ...SIDE_A, portAliases: { PASEO_PORT: idle, PASEO_PORT2: 2, PASEO_PORT3: 3 } }
    const outcomes: string[] = []
    forwarder = createRetiredPortForwarder({
      identify: async (_connection, contestants) => ({ contestant: contestants[0]!, method: "env" }),
      sniffTimeoutMs: 200,
      onConnection: (_retired, outcome) =>
        outcomes.push(`${outcome.kind}:${outcome.kind === "unreachable" ? `${outcome.method}:${outcome.target}` : ""}`),
    })
    await forwarder.sync("chat", {
      ports: [{ port: old, alias: "PASEO_PORT", turnIndex: 0 }],
      contestants: async () => [side],
    })

    const answer = await request(old, "GET /whoami HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    expect(answer).toStartWith("HTTP/1.1 502 Bad Gateway\r\n")
    expect(answer).toContain(
      `forwards your connections to your own PASEO_PORT, ${idle}, but nothing listens on ${idle}`,
    )
    expect(await request(old, "\x16\x03\x01")).toBe("")
    expect(outcomes).toEqual([`unreachable:env:${idle}`, `unreachable:env:${idle}`])
  })

  test("keeps a port another program holds unbound, and lets go of a chat's ports on stop", async () => {
    const held = await echo("someone-else")
    const old = await freePort()
    forwarder = createRetiredPortForwarder({ identify: async () => undefined })
    const result = await forwarder.sync("chat", {
      ports: [
        { port: held, alias: "PASEO_PORT", turnIndex: 0 },
        { port: old, alias: "PASEO_PORT2", turnIndex: 0 },
      ],
      contestants: async () => [],
    })
    expect(result.listening).toEqual([old])
    expect(result.failed).toEqual([{ port: held, code: "EADDRINUSE" }])

    await forwarder.stop("chat")
    expect(forwarder.holds(old)).toBe(false)
    const rebound = net.createServer()
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject)
      rebound.listen(old, "127.0.0.1", resolve)
    })
    rebound.close()
  })
})

describe("open shim", () => {
  test.skipIf(process.platform === "win32")("retargets earlier ports and preview hosts before opening", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-open-"))
    try {
      const shim = path.join(directory, "open")
      const recorder = path.join(directory, "record")
      const log = path.join(directory, "opened")
      await writeFile(shim, OPEN_SHIM)
      await writeFile(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\n`)
      await chmod(shim, 0o755)
      await chmod(recorder, 0o755)
      await new Promise<void>((resolve, reject) =>
        execFile(
          shim,
          [
            "-a",
            "Safari",
            "http://localhost:20001/app?x=200012",
            "http://turn1-a--chat.localhost:6767/",
            "http://localhost:200010",
          ],
          {
            env: {
              PATH: process.env["PATH"],
              ARENA_OPEN_COMMAND: recorder,
              ARENA_RETIRED_PORTS: "20001=20110 20002=20111",
              ARENA_RETIRED_HOSTS: "turn1-a--chat.localhost=turn3-a--chat.localhost",
            },
          },
          (error) => (error ? reject(error) : resolve()),
        ),
      )
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "-a",
        "Safari",
        "http://localhost:20110/app?x=200012",
        "http://turn3-a--chat.localhost:6767/",
        "http://localhost:200010",
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
