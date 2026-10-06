import { expect, test } from "bun:test"
import { buildEnvironmentTransition } from "@/arena/transition"

test("builds a winner-derived transition without historical ports or absolute paths", () => {
  const createdAt = new Date("2026-08-28T12:00:00.000Z")
  const event = buildEnvironmentTransition({
    previousWinningRunID: "run-winner",
    createdAt,
    stoppedCommands: [
      {
        command: "npm run dev -- --port 43121",
        relativeCwd: "apps/web",
        status: "stopped",
        verified: true,
      },
      {
        command: "vite --host 127.0.0.1:43122",
        relativeCwd: "apps/web",
        status: "failed",
        verified: false,
        error: "still listening on 43122",
      },
    ],
    copyOmissions: [{
      relativePath: "node_modules/cache.bin",
      fileType: "file",
      logicalBytes: 10,
      sourceIdentity: "inode:12",
      omissionReason: "ignored_file_too_large",
    }],
  })
  expect(event.previousWinningRunID).toBe("run-winner")
  expect(event.stoppedCommands).toEqual([
    {
      command: "npm run dev -- --port {port}",
      relativeCwd: "apps/web",
      status: "stopped",
      verified: true,
    },
    {
      command: "vite --host 127.0.0.1:{port}",
      relativeCwd: "apps/web",
      status: "failed",
      verified: false,
      error: "still listening on {port}",
    },
  ])
  expect(JSON.stringify(event)).not.toContain("43121")
  expect(JSON.stringify(event)).not.toContain("43122")
  expect(JSON.stringify(event)).not.toContain("/Users/")
  expect(event.summary).toEqual({
    commandsStopped: 1,
    commandsAlreadyAbsent: 0,
    stopFailures: 1,
    listenersReleased: 0,
    pathsOmitted: 1,
  })
})

test("retains grouped listener aliases while redacting their historical ports", () => {
  const createdAt = new Date("2026-08-28T12:00:00.000Z")
  const event = buildEnvironmentTransition({
    previousWinningRunID: "run-winner",
    createdAt,
    stopRecords: [
      {
        command: "npm run dev",
        relativeCwd: ".",
        status: "stopped",
        verified: true,
        captured: {
          kind: "owned_process",
          command: "npm",
          args: ["run", "dev", "--port", "43121"],
          env: {},
          relativeCwd: ".",
          processGroupID: 20,
          listeners: [
            { port: 43121, alias: "PASEO_PORT", verifiedAt: createdAt },
            { port: 43122, alias: "PASEO_PORT2", verifiedAt: createdAt },
            { port: 43123, alias: "PASEO_PORT3", verifiedAt: createdAt },
          ],
          proxyRoutes: [],
          capturedAt: createdAt,
          verifiedAt: createdAt,
        },
        stoppedAt: createdAt,
      },
    ],
  })

  expect(event.stoppedCommands).toEqual([
    {
      command: "npm run dev --port {port}",
      relativeCwd: ".",
      status: "stopped",
      verified: true,
      listeners: [
        { alias: "PASEO_PORT" },
        { alias: "PASEO_PORT2" },
        { alias: "PASEO_PORT3" },
      ],
    },
  ])
  expect(event.summary.commandsStopped).toBe(1)
  expect(event.summary.listenersReleased).toBe(3)
  expect(JSON.stringify(event)).not.toMatch(/4312[1-3]/)
})

test("orders and deduplicates details so both contestants receive the same event", () => {
  const input = {
    previousWinningRunID: "run-winner",
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
    stoppedCommands: [
      { command: "z", relativeCwd: "z", status: "already_absent" as const, verified: true },
      { command: "a", relativeCwd: ".", status: "stopped" as const, verified: true },
      { command: "a", relativeCwd: ".", status: "stopped" as const, verified: true },
    ],
  }
  const event = buildEnvironmentTransition(input)
  expect(event.stoppedCommands).toHaveLength(2)
  expect(event.stoppedCommands.map((item) => item.command)).toEqual(["a", "z"])
})
