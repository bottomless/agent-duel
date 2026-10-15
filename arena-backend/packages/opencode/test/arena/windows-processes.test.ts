import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { captureOwnedServices, SERVICE_OWNER_ENV, serviceOwnerID, stopOwnedServices } from "@/arena/services"
import {
  groupMembers,
  isSessionShell,
  readWindowsProcesses,
  splitWindowsCommandLine,
  windowsSnapshots,
  type WindowsProcessRow,
} from "@/arena/windows-processes"

const row = (pid: number, ppid: number, created: number, extra: Partial<WindowsProcessRow> = {}): WindowsProcessRow => ({
  pid,
  ppid,
  created: BigInt(created),
  image: "node.exe",
  ...extra,
})

describe("Windows process groups", () => {
  // explorer(1) > app(2) > daemon(3) > engine(10) > tool bash(20) > npm(21) > node(22)
  const tree = [
    row(1, 0, 1, { image: "explorer.exe" }),
    row(2, 1, 2, { image: "Agent Duel.exe" }),
    row(3, 2, 3),
    row(10, 3, 4, { image: "agent-duel-arena.exe" }),
    row(20, 10, 5, { image: "bash.exe", commandLine: 'bash.exe -l -c "npm run dev"', cwd: "C:\\repo\\wt" }),
    row(21, 20, 6, { commandLine: "npm run dev", cwd: "C:\\repo\\wt" }),
    row(22, 21, 7, { commandLine: "node server.js", cwd: "C:\\repo\\wt" }),
  ]

  test("groups a command's tree under the shell the engine started, and never lists the engine's ancestry", () => {
    const snapshots = windowsSnapshots(tree, 10)
    expect(snapshots.map((item) => [item.pid, item.processGroupID])).toEqual([
      [20, 20],
      [21, 20],
      [22, 20],
    ])
    expect(groupMembers(tree, 20, 10)).toEqual([20, 21, 22])
  })

  test("keeps the group when its shell has exited, the way a process group outlives its leader", () => {
    const orphaned = tree.filter((item) => item.pid !== 20)
    expect(windowsSnapshots(orphaned, 10).map((item) => [item.pid, item.processGroupID])).toEqual([
      [21, 20],
      [22, 20],
    ])
    expect(groupMembers(orphaned, 20, 10)).toEqual([21, 22])
  })

  test("does not join a reused pid to the children of the process that had it", () => {
    // The shell exited and its pid now names an unrelated, younger process.
    const reused = [...tree.filter((item) => item.pid !== 20), row(20, 1, 9, { image: "notepad.exe" })]
    const groups = new Map(windowsSnapshots(reused, 10).map((item) => [item.pid, item.processGroupID]))
    expect(groups.get(21)).toBe(20)
    expect(groups.get(20)).toBeUndefined()
    expect(groupMembers(reused, 20, 10)).toEqual([21, 22])
  })

  test("leaves the engine's own tools alone, wherever they run", () => {
    const tools = [
      ...tree,
      row(40, 10, 8, { image: "git.exe", commandLine: "git ls-files --stage -z", cwd: "C:\\repo\\wt" }),
      row(41, 3, 8, { image: "rg.exe", commandLine: "rg --files", cwd: "C:\\repo\\wt" }),
    ]
    const listed = windowsSnapshots(tools, 10).map((item) => item.pid)
    expect(listed).toEqual([20, 21, 22])
    expect(groupMembers(tools, 40, 10)).toEqual([])
  })

  test("stops a group at a terminal's shell, which is never a member", () => {
    const terminal = [
      ...tree.slice(0, 4),
      row(30, 3, 5, { image: "pwsh.exe", commandLine: "pwsh.exe -NoLogo", cwd: "C:\\repo\\wt" }),
      row(31, 30, 6, { commandLine: "node server.js", cwd: "C:\\repo\\wt" }),
    ]
    const snapshots = windowsSnapshots(terminal, 10)
    expect(snapshots.find((item) => item.pid === 30)?.sessionShell).toBe(true)
    expect(snapshots.find((item) => item.pid === 31)?.processGroupID).toBe(31)
  })

  test("tells a terminal's shell from a one-shot shell command", () => {
    expect(isSessionShell({ image: "bash.exe", commandLine: "bash.exe --login -i" })).toBe(true)
    expect(isSessionShell({ image: "bash.exe", commandLine: 'bash.exe -l -c "ls"' })).toBe(false)
    expect(isSessionShell({ image: "powershell.exe", commandLine: "powershell.exe -NoProfile -Command ls" })).toBe(false)
    expect(isSessionShell({ image: "cmd.exe", commandLine: "cmd.exe /c dir" })).toBe(false)
    expect(isSessionShell({ image: "cmd.exe", commandLine: "cmd.exe" })).toBe(true)
    expect(isSessionShell({ image: "node.exe", commandLine: "node.exe" })).toBe(false)
  })

  test("splits a command line as Windows does", () => {
    expect(splitWindowsCommandLine('"C:\\Program Files\\nodejs\\node.exe" server.js --port 3000')).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "server.js",
      "--port",
      "3000",
    ])
    expect(splitWindowsCommandLine('a "b c" d\\"e "f\\\\"')).toEqual(["a", "b c", 'd"e', "f\\"])
  })
})

describe.skipIf(process.platform !== "win32")("Windows process table", () => {
  test("lists this process's own directory and command line", async () => {
    const rows = await readWindowsProcesses()
    const self = rows.find((item) => item.pid === process.pid)
    expect(self?.ppid).toBe(process.ppid)
    expect(self?.cwd?.toLowerCase()).toBe(process.cwd().toLowerCase())
    expect(self?.commandLine).toContain("bun")
  })

  test("captures a server started in a worktree with its port, then stops it", async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "arena-windows-services-"))
    // A port picked by the OS, so the server's own listener is the only one asserted on.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const address = probe.address()
        probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
      })
    })
    // Started straight from this process, the way the engine starts its own tools, so only the
    // owner marker every contestant command carries makes it a service.
    const server = spawn(
      process.execPath,
      ["-e", `require("node:net").createServer(() => {}).listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`],
      {
        cwd: worktree,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, [SERVICE_OWNER_ENV]: serviceOwnerID(worktree) },
      },
    )
    try {
      let captured: Awaited<ReturnType<typeof captureOwnedServices>> = []
      for (let attempt = 0; attempt < 50 && !captured.some((item) => item.listeners.length > 0); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        captured = await captureOwnedServices({ worktree })
      }
      expect(captured).toHaveLength(1)
      expect(captured[0]!.processGroupID).toBe(server.pid)
      expect(captured[0]!.relativeCwd).toBe(".")
      expect(captured[0]!.listeners.map((item) => item.port)).toEqual([port])

      const stopped = await stopOwnedServices(captured, { worktree, graceMs: 200 })
      expect(stopped.map((item) => item.status)).toEqual(["stopped"])
      const exited = await new Promise<boolean>((resolve) => {
        if (server.exitCode !== null || server.signalCode !== null) return resolve(true)
        server.once("exit", () => resolve(true))
        setTimeout(() => resolve(false), 5_000)
      })
      expect(exited).toBe(true)
    } finally {
      server.kill()
      await rm(worktree, { recursive: true, force: true })
    }
  })
})
