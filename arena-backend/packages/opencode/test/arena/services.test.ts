import { expect, test } from "bun:test"
import {
  assignProxyRoutes,
  captureOwnedServices,
  parseProcessTerminals,
  sessionShellPids,
  persistedProxyRoutes,
  serviceOwnerID,
  stopOwnedServices,
  type ProcessSnapshot,
  type ServiceAdapter,
} from "@/arena/services"
import type { CapturedService } from "@/arena/records"

test("assigns unused aliases and proxy routes to listeners on ad-hoc ports", () => {
  const now = new Date("2026-08-28T12:00:00.000Z")
  const services = [
    {
      kind: "owned_process" as const,
      command: "node services.mjs",
      args: [],
      env: {},
      relativeCwd: ".",
      listeners: [
        { port: 4100, alias: "PASEO_PORT" as const, verifiedAt: now },
        { port: 5100, verifiedAt: now },
        { port: 5101, verifiedAt: now },
      ],
      proxyRoutes: [],
      capturedAt: now,
      verifiedAt: now,
    },
  ]
  const routed = assignProxyRoutes(services, [
    { hostname: "preview.localhost", alias: "PASEO_PORT", port: 4100, active: true },
    { hostname: "api.localhost", alias: "PASEO_PORT2", port: 4101, active: true },
    { hostname: "events.localhost", alias: "PASEO_PORT3", port: 4102, active: true },
  ])

  expect(routed[0]?.listeners.map((listener) => [listener.port, listener.alias])).toEqual([
    [4100, "PASEO_PORT"],
    [5100, "PASEO_PORT2"],
    [5101, "PASEO_PORT3"],
  ])
  expect(routed[0]?.proxyRoutes.map((route) => [route.alias, route.port])).toEqual([
    ["PASEO_PORT", 4100],
    ["PASEO_PORT2", 5100],
    ["PASEO_PORT3", 5101],
  ])
})

test("reuses persisted preview routes when the live registry is unavailable", () => {
  const persisted = [
    {
      proxyRoutes: [
        {
          hostname: "preview.localhost",
          url: "http://preview.localhost:6771",
          port: 43121,
          alias: "PASEO_PORT" as const,
          active: true,
        },
      ],
    },
  ] satisfies readonly Pick<CapturedService, "proxyRoutes">[]
  const captured = [
    {
      kind: "owned_process" as const,
      command: "npm run dev",
      args: [],
      env: {},
      relativeCwd: ".",
      listeners: [{ port: 43121 }],
      proxyRoutes: [],
      capturedAt: new Date("2026-08-28T12:00:00.000Z"),
      verifiedAt: new Date("2026-08-28T12:00:00.000Z"),
    },
  ]

  const routes = persistedProxyRoutes(persisted)
  expect(assignProxyRoutes(captured, routes)[0]?.proxyRoutes).toEqual(persisted[0]!.proxyRoutes)
})

test("captures only CWD-owned processes, keeps listener aliases, and bounds the environment", async () => {
  const capturedAt = new Date("2026-08-28T12:00:00.000Z")
  const processes: ProcessSnapshot[] = [
    {
      pid: 10,
      processGroupID: 20,
      cwd: "/repo/contestant/apps/web",
      command: "npm",
      args: ["run", "dev", "--port", "43121"],
      env: { PASEO_PORT: "43121", PORT: "43121", SECRET_TOKEN: "do-not-persist" },
      processStartIdentity: "start-10",
      listeners: [{ port: 43121 }],
    },
    {
      pid: 11,
      processGroupID: 21,
      cwd: "/repo/other-contestant",
      command: "npm",
      args: ["run", "dev"],
      listeners: [{ port: 43121 }],
    },
  ]
  await expect(
    captureOwnedServices({
      worktree: "/repo/contestant",
      processes,
      portAliases: { PASEO_PORT: 43121, PASEO_PORT2: 43122, PASEO_PORT3: 43123 },
      now: capturedAt,
    }),
  ).resolves.toEqual([
    {
      kind: "owned_process",
      command: "npm",
      args: ["run", "dev", "--port", "43121"],
      env: { PASEO_PORT: "43121", PORT: "43121" },
      relativeCwd: "apps/web",
      processGroupID: 20,
      processStartIdentity: "start-10",
      listeners: [{ port: 43121, alias: "PASEO_PORT", verifiedAt: capturedAt }],
      proxyRoutes: [],
      capturedAt,
      verifiedAt: capturedAt,
    },
  ])
})

test("does not stop a reused process group when its start identity changed", async () => {
  const calls: number[] = []
  const adapter: ServiceAdapter = {
    listProcesses: () => [
      {
        pid: 10,
        processGroupID: 20,
        cwd: "/repo/contestant",
        command: "npm",
        processStartIdentity: "new-process",
      },
    ],
    stopProcessGroup: (group) => calls.push(group),
  }
  const [service] = await captureOwnedServices({
    worktree: "/repo/contestant",
    processes: [
      {
        pid: 10,
        processGroupID: 20,
        cwd: "/repo/contestant",
        command: "npm",
        processStartIdentity: "old-process",
      },
    ],
  })
  const [result] = await stopOwnedServices([service!], { worktree: "/repo/contestant", adapter })
  expect(calls).toEqual([])
  expect(result?.status).toBe("already_absent")
  expect(result?.verified).toBe(true)
})

test("keeps ownership after a launched service changes out of the worktree cwd", async () => {
  const root = "/repo/contestant"
  const ownerID = serviceOwnerID(root)
  let alive = true
  const process = {
    pid: 10,
    processGroupID: 20,
    cwd: "/tmp/runtime",
    command: "npm",
    args: ["run", "dev"],
    ownerID,
    ownerRelativeCwd: "apps/web",
    processStartIdentity: "start-10",
  } satisfies ProcessSnapshot
  const adapter: ServiceAdapter = {
    listProcesses: () =>
      alive ? [{ ...process, pid: 12, processStartIdentity: "surviving-child" }] : [],
    stopProcessGroup: () => {
      alive = false
    },
    processGroupAlive: () => alive,
  }
  const [service] = await captureOwnedServices({
    worktree: root,
    processes: [
      process,
      { ...process, pid: 11, processGroupID: 21, ownerID: serviceOwnerID("/repo/other") },
    ],
  })

  expect(service?.ownerID).toBe(ownerID)
  expect(service?.relativeCwd).toBe("apps/web")
  const [result] = await stopOwnedServices([service!], { worktree: root, adapter })
  expect(result?.status).toBe("stopped")
  expect(result?.verified).toBe(true)
})

test("stops owned groups and verifies listener release with an injectable adapter", async () => {
  let alive = true
  let listeners = [{ port: 43121 }, { port: 43122 }, { port: 43123 }]
  const stoppedGroups: number[] = []
  const adapter: ServiceAdapter = {
    listProcesses: () =>
      alive
        ? [
            {
              pid: 10,
              processGroupID: 20,
              cwd: "/repo/contestant",
              command: "npm",
              processStartIdentity: "start-10",
              listeners,
            },
          ]
        : [],
    stopProcessGroup: (group) => {
      stoppedGroups.push(group)
      alive = false
      listeners = []
    },
    processGroupAlive: () => alive,
    listenersForProcessGroup: () => listeners,
  }
  const [service] = await captureOwnedServices({
    worktree: "/repo/contestant",
    adapter,
    portAliases: { PASEO_PORT: 43121, PASEO_PORT2: 43122, PASEO_PORT3: 43123 },
    now: new Date("2026-08-28T12:00:00.000Z"),
  })
  expect(service?.listeners.map((listener) => listener.alias)).toEqual([
    "PASEO_PORT",
    "PASEO_PORT2",
    "PASEO_PORT3",
  ])
  const [result] = await stopOwnedServices([service!], { worktree: "/repo/contestant", adapter })
  expect(stoppedGroups).toEqual([20])
  expect(result?.status).toBe("stopped")
  expect(result?.verified).toBe(true)
})

test("force-stops an owned group when terminate does not release it", async () => {
  let alive = true
  const signals: Array<"SIGTERM" | "SIGKILL"> = []
  const adapter: ServiceAdapter = {
    listProcesses: () =>
      alive
        ? [
            {
              pid: 10,
              processGroupID: 20,
              cwd: "/repo/contestant",
              command: "/bin/zsh",
              processStartIdentity: "start-10",
            },
          ]
        : [],
    stopProcessGroup: (_group, signal) => {
      signals.push(signal)
      if (signal === "SIGKILL") alive = false
    },
    processGroupAlive: () => alive,
    wait: () => undefined,
  }
  const [service] = await captureOwnedServices({ worktree: "/repo/contestant", adapter })

  const [result] = await stopOwnedServices([service!], {
    worktree: "/repo/contestant",
    adapter,
    graceMs: 250,
  })

  expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  expect(result?.status).toBe("stopped")
  expect(result?.verified).toBe(true)
})

test("never captures a terminal's own shell standing in the worktree", async () => {
  const capturedAt = new Date("2026-09-09T09:00:00.000Z")
  const processes: ProcessSnapshot[] = [
    {
      pid: 30,
      processGroupID: 30,
      cwd: "/repo/contestant",
      command: "/bin/zsh",
      sessionShell: true,
      processStartIdentity: "start-30",
    },
    {
      pid: 31,
      processGroupID: 31,
      cwd: "/repo/contestant",
      command: "npm",
      args: ["run", "dev"],
      processStartIdentity: "start-31",
    },
  ]

  const captured = await captureOwnedServices({
    worktree: "/repo/contestant",
    processes,
    now: capturedAt,
  })

  // The contestant terminal is the user's session, not a service the turn started: stopping
  // it between turns would take the user's shell and its scrollback with it.
  expect(captured.map((service) => service.command)).toEqual(["npm"])
})

test("does not stop a terminal shell that reuses a recorded process group", async () => {
  const stopped: number[] = []
  const record: CapturedService = {
    kind: "owned_process",
    command: "npm",
    args: ["run", "dev"],
    env: {},
    relativeCwd: ".",
    processGroupID: 40,
    processStartIdentity: "start-40",
    listeners: [],
    proxyRoutes: [],
    capturedAt: new Date("2026-09-09T09:00:00.000Z"),
    verifiedAt: new Date("2026-09-09T09:00:00.000Z"),
  }
  const adapter: ServiceAdapter = {
    listProcesses: () => [
      {
        pid: 40,
        processGroupID: 40,
        cwd: "/repo/contestant",
        command: "/bin/zsh",
        sessionShell: true,
        processStartIdentity: "start-40",
      },
    ],
    stopProcessGroup: (group) => {
      stopped.push(group)
    },
  }

  const [result] = await stopOwnedServices([record], { worktree: "/repo/contestant", adapter })

  expect(stopped).toEqual([])
  expect(result?.status).toBe("already_absent")
})

test("reads a terminal session's own shell out of the process table", () => {
  // The daemon's terminal worker holds no terminal; the shell it spawned holds one, and the
  // command the user ran inherits it from the shell.
  const rows = parseProcessTerminals(
    [
      "  9817     9814 ??       ",
      " 20275     9817 ttys027  ",
      " 20301    20275 ttys027  ",
      "     1        0 ??       ",
      " 30500        1 ttys031  ",
    ].join("\n"),
  )

  expect([...sessionShellPids(rows)]).toEqual([20275])
})

// The stop path races the thing it is stopping. A service that exits on its own between
// rediscovery and the signal is the outcome we wanted, so it must never be recorded as a
// cleanup failure — that state fails the turn and leaves the worktree behind.
function errno(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

test("treats a self-exit between rediscovery and SIGTERM as absent, not failed", async () => {
  let alive = true
  const adapter: ServiceAdapter = {
    listProcesses: () =>
      alive
        ? [
            {
              pid: 10,
              processGroupID: 20,
              cwd: "/repo/contestant",
              command: "npm",
              processStartIdentity: "start-10",
            },
          ]
        : [],
    // The window: the group drains after it was rediscovered and before the kill lands.
    stopProcessGroup: () => {
      alive = false
      throw errno("ESRCH", "No such process")
    },
    processGroupAlive: () => alive,
    listenersForProcessGroup: () => [],
  }
  const [service] = await captureOwnedServices({ worktree: "/repo/contestant", adapter })

  const [result] = await stopOwnedServices([service!], { worktree: "/repo/contestant", adapter })

  expect(result?.status).toBe("already_absent")
  expect(result?.verified).toBe(true)
  expect(result?.error).toBeUndefined()
})

test("keeps a signal we were not allowed to send a failure", async () => {
  const adapter: ServiceAdapter = {
    listProcesses: () => [
      {
        pid: 10,
        processGroupID: 20,
        cwd: "/repo/contestant",
        command: "npm",
        processStartIdentity: "start-10",
      },
    ],
    // The owner outlives the throw, so the error is the truth rather than a lost race.
    stopProcessGroup: () => {
      throw errno("EPERM", "Operation not permitted")
    },
    processGroupAlive: () => true,
    listenersForProcessGroup: () => [{ port: 43121 }],
  }
  const [service] = await captureOwnedServices({ worktree: "/repo/contestant", adapter })

  const [result] = await stopOwnedServices([service!], { worktree: "/repo/contestant", adapter })

  expect(result?.status).toBe("failed")
  expect(result?.verified).toBe(false)
  expect(result?.error).toBe("Operation not permitted")
})

test("stays a failure when the listener probe cannot answer", async () => {
  let alive = true
  const adapter: ServiceAdapter = {
    listProcesses: () =>
      alive
        ? [
            {
              pid: 10,
              processGroupID: 20,
              cwd: "/repo/contestant",
              command: "npm",
              processStartIdentity: "start-10",
            },
          ]
        : [],
    stopProcessGroup: () => {
      alive = false
      throw errno("ESRCH", "No such process")
    },
    processGroupAlive: () => alive,
    // The owner is gone but the ports cannot be checked, so absence is unproven and the
    // worktree must not be trashed on the strength of a guess.
    listenersForProcessGroup: () => {
      throw new Error("lsof unavailable")
    },
  }
  const [service] = await captureOwnedServices({
    worktree: "/repo/contestant",
    processes: [
      {
        pid: 10,
        processGroupID: 20,
        cwd: "/repo/contestant",
        command: "npm",
        processStartIdentity: "start-10",
      },
    ],
  })

  const [result] = await stopOwnedServices([service!], { worktree: "/repo/contestant", adapter })

  expect(result?.status).toBe("failed")
  expect(result?.verified).toBe(false)
  expect(result?.error).toBe("No such process")
})

test("a real kill of a vanished group does not throw out of the default adapter", async () => {
  const { defaultServiceAdapter } = await import("@/arena/services")
  // A group id that cannot exist: killing it is the exact ESRCH the race produces.
  expect(() => defaultServiceAdapter.stopProcessGroup?.(2_147_483_646, "SIGTERM")).not.toThrow()
})
