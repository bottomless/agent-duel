import { describe, expect, test } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { createArenaPreviewRouteManager, liveArenaPreviewRoutes } from "./arena-preview-routes.js";
import { ServiceProxyRouteRegistry } from "./service-proxy.js";

const baseRun = {
  id: "run-a",
  side: "a",
  sessionID: "session-a",
  descendantSessionIDs: [],
  worktree: "/tmp/arena-a",
  worktreeName: "generation-1-a",
  worktreeActive: true,
  runState: "complete",
  durationMs: null,
  selectable: true,
  applicable: true,
} as const;

function managerAndProxy() {
  const proxy = new ServiceProxyRouteRegistry();
  return { proxy, manager: createArenaPreviewRouteManager(proxy) };
}

describe("Arena preview route ownership", () => {
  test("registers the route against the observed primary listener and preserves URL aliases", () => {
    const { proxy, manager } = managerAndProxy();
    manager.sync({
      runs: [
        {
          ...baseRun,
          portAliases: { PASEO_PORT: 4311, PASEO_PORT2: 4312, PASEO_PORT3: 4313 },
          services: [
            {
              command: "npm run dev",
              relativeCwd: ".",
              listeners: [
                { port: 4311, alias: "PASEO_PORT" },
                { port: 4312, alias: "PASEO_PORT2" },
              ],
              proxyRoutes: [
                {
                  hostname: "turn1-a--abcd.localhost",
                  url: "https://turn1-a--abcd.example.com",
                  active: true,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(proxy.findRoute("turn1-a--abcd.localhost")?.port).toBe(4311);
    expect(proxy.findRoute("turn1-a--abcd.example.com")?.port).toBe(4311);
    expect(liveArenaPreviewRoutes(proxy, "run-a")).toHaveLength(1);
  });

  test("does not guess a target when a multi-listener route has no primary association", () => {
    const { proxy, manager } = managerAndProxy();
    manager.sync({
      runs: [
        {
          ...baseRun,
          services: [
            {
              command: "server",
              relativeCwd: ".",
              listeners: [{ port: 4401 }, { port: 4402 }],
              proxyRoutes: [{ hostname: "ambiguous.localhost", active: true }],
            },
          ],
        },
      ],
    });
    expect(proxy.findRoute("ambiguous.localhost")).toBeNull();
  });

  test("uses an explicit route listener when a command exposes several listeners", () => {
    const { proxy, manager } = managerAndProxy();
    manager.sync({
      runs: [
        {
          ...baseRun,
          services: [
            {
              command: "server",
              relativeCwd: ".",
              listeners: [{ port: 4401 }, { port: 4402 }],
              proxyRoutes: [{ hostname: "explicit.localhost", port: 4402, active: true }],
            },
          ],
        },
      ],
    });
    expect(proxy.findRoute("explicit.localhost")?.port).toBe(4402);
  });

  test("removes every owned route when Arena reports ownership ended", () => {
    const { proxy, manager } = managerAndProxy();
    const active = {
      ...baseRun,
      services: [
        {
          command: "server",
          relativeCwd: ".",
          listeners: [{ port: 4501 }],
          proxyRoutes: [{ hostname: "ended.localhost", active: true }],
        },
      ],
    };
    manager.sync({ runs: [active] });
    expect(proxy.findRoute("ended.localhost")?.port).toBe(4501);

    manager.sync({ runs: [{ ...active, worktreeActive: false }] });
    expect(proxy.findRoute("ended.localhost")).toBeNull();
    expect(liveArenaPreviewRoutes(proxy, "run-a")).toEqual([]);
  });

  test("retains an absent prior-turn owner until a verified transition ends ownership", () => {
    const { proxy, manager } = managerAndProxy();
    manager.sync({
      runs: [
        {
          ...baseRun,
          services: [
            {
              command: "server",
              relativeCwd: ".",
              listeners: [{ port: 4601 }],
              proxyRoutes: [{ hostname: "prior-turn.localhost", active: true }],
            },
          ],
        },
      ],
    });
    manager.sync({ runs: [] });
    expect(proxy.findRoute("prior-turn.localhost")?.port).toBe(4601);
    manager.sync({
      runs: [],
      turn: {
        transition: {
          id: "transition-1",
          previousWinningRunID: "run-a",
          stoppedCommands: [],
          copyOmissions: [],
          summary: {
            commandsStopped: 0,
            commandsAlreadyAbsent: 0,
            stopFailures: 0,
            pathsOmitted: 0,
          },
          createdAt: new Date().toISOString(),
        },
      } as NonNullable<ArenaSnapshot["turn"]>,
    });
    expect(proxy.findRoute("prior-turn.localhost")).toBeNull();
  });

  test("does not release the retained winner route after a failed environment transition", () => {
    const { proxy, manager } = managerAndProxy();
    manager.sync({
      runs: [
        {
          ...baseRun,
          services: [
            {
              command: "npm run dev",
              relativeCwd: ".",
              listeners: [{ port: 4701 }],
              proxyRoutes: [{ hostname: "retained-after-failure.localhost", active: true }],
            },
          ],
        },
      ],
    });
    manager.sync({ runs: [] });

    manager.sync({
      runs: [],
      turn: {
        transition: {
          id: "transition-failed",
          previousWinningRunID: "run-a",
          stoppedCommands: [
            {
              command: "npm run dev",
              relativeCwd: ".",
              status: "failed",
              verified: false,
              error: "process still running",
            },
          ],
          copyOmissions: [],
          createdAt: new Date().toISOString(),
        },
      } as NonNullable<ArenaSnapshot["turn"]>,
    });

    expect(proxy.findRoute("retained-after-failure.localhost")?.port).toBe(4701);
  });
});
