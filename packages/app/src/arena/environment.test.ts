import { describe, expect, it } from "vitest";
import {
  contestantWorktreeDisplayPath,
  environmentTransitionCounts,
  lifecycleServiceEntries,
  readinessSummary,
  serviceDisplayName,
  shortWorktreeName,
  summarizeServices,
  transitionListenerLabels,
  transitionSummaryLabel,
  type LifecycleServiceEntry,
} from "./environment";

function serviceEntry(overrides: Partial<LifecycleServiceEntry>): LifecycleServiceEntry {
  return {
    key: "k",
    name: "Service",
    port: 3000,
    preview: false,
    live: true,
    ...overrides,
  };
}

describe("Arena environment metadata", () => {
  it("prefers persisted short worktree names and never displays the full fallback path", () => {
    expect(shortWorktreeName("generation-3-a", "/private/worktrees/chat/generation-3-a")).toBe(
      "generation-3-a",
    );
    expect(shortWorktreeName(undefined, "/private/worktrees/chat/generation-3-b")).toBe(
      "generation-3-b",
    );
  });

  it("shows a contestant's location from the project's excluded directory onward", () => {
    expect(
      contestantWorktreeDisplayPath(
        "/Users/dev/code/project/.agent-duel/worktrees/generation-2-a",
        "generation-2-a",
      ),
    ).toBe(".agent-duel/worktrees/generation-2-a");
    expect(contestantWorktreeDisplayPath("/tmp/elsewhere/generation-2-b", "generation-2-b")).toBe(
      "generation-2-b",
    );
    expect(contestantWorktreeDisplayPath(undefined, "generation-2-b")).toBe("generation-2-b");
  });

  it("uses durable transition summary counts when present", () => {
    expect(
      environmentTransitionCounts({
        stoppedCommands: [
          { command: "npm run dev", relativeCwd: ".", status: "stopped", verified: true },
          { command: "npm run api", relativeCwd: "api", status: "failed", verified: false },
        ],
        copyOmissions: [{ relativePath: ".cache", omissionReason: "ignored_total_limit" }],
        summary: {
          commandsStopped: 1,
          commandsAlreadyAbsent: 0,
          stopFailures: 1,
          listenersReleased: 3,
          pathsOmitted: 1,
        },
      }),
    ).toEqual({ stopped: 1, absent: 0, failures: 1, listeners: 3, omitted: 1 });
  });

  it("derives counts for older transition payloads without a summary", () => {
    expect(
      environmentTransitionCounts({
        stoppedCommands: [
          { command: "npm run dev", relativeCwd: ".", status: "already_absent", verified: true },
          {
            command: "npm run api",
            relativeCwd: ".",
            status: "stopped",
            verified: true,
            listeners: [{ alias: "PASEO_PORT" }, {}],
          },
        ],
        copyOmissions: [{ relativePath: "dist", omissionReason: "excluded" }],
      }),
    ).toEqual({ stopped: 1, absent: 1, failures: 0, listeners: 2, omitted: 1 });
  });

  it("says nothing about a transition that stopped and skipped nothing", () => {
    expect(transitionSummaryLabel({ stoppedCommands: [], copyOmissions: [] })).toBeNull();
    expect(
      transitionSummaryLabel({
        summary: {
          commandsStopped: 2,
          commandsAlreadyAbsent: 0,
          stopFailures: 1,
          listenersReleased: 2,
          pathsOmitted: 1,
        },
      }),
    ).toBe(
      "Stopped 2 processes from the last winner before starting · 1 failed to stop · 1 path skipped when copying the environment",
    );
    expect(
      transitionSummaryLabel({
        stoppedCommands: [
          { command: "npm run dev", relativeCwd: ".", status: "already_absent", verified: true },
        ],
      }),
    ).toBeNull();
  });

  it("labels historical listeners without exposing stale port numbers", () => {
    expect(
      transitionListenerLabels({
        listeners: [{ alias: "PASEO_PORT" }, { alias: "PASEO_PORT2" }, {}],
      }),
    ).toEqual(["PASEO_PORT", "PASEO_PORT2", "Listener 3"]);
  });

  it("names services by their port alias, falling back to the executable", () => {
    expect(serviceDisplayName("PASEO_PORT", "npm run dev")).toBe("Preview");
    expect(serviceDisplayName("PASEO_PORT2", "npm run api")).toBe("Port 2");
    expect(serviceDisplayName(undefined, "/usr/local/bin/node server.mjs")).toBe("node");
    expect(serviceDisplayName(undefined, undefined)).toBe("Service");
  });

  it("renders one service entry per owned listener", () => {
    const entries = lifecycleServiceEntries({
      services: [
        {
          kind: "owned_process",
          command: "node services.mjs",
          relativeCwd: ".",
          listeners: [
            { port: 4100, alias: "PASEO_PORT" },
            { port: 5100, alias: "PASEO_PORT2" },
            { port: 5101, alias: "PASEO_PORT3" },
          ],
          proxyRoutes: [
            {
              hostname: "preview.localhost",
              url: "http://preview.localhost:6774",
              port: 4100,
              alias: "PASEO_PORT",
              active: true,
            },
            {
              hostname: "api.localhost",
              url: "http://api.localhost:6774",
              port: 5100,
              alias: "PASEO_PORT2",
              active: true,
            },
            {
              hostname: "events.localhost",
              url: "http://events.localhost:6774",
              port: 5101,
              alias: "PASEO_PORT3",
              active: true,
            },
          ],
        },
      ],
    });

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.port)).toEqual([4100, 5100, 5101]);
    expect(entries.map((entry) => entry.preview)).toEqual([true, false, false]);
    expect(entries.every((entry) => entry.live && entry.url)).toBe(true);
  });

  it("summarises services as all running or a running count", () => {
    expect(summarizeServices([])).toBeNull();
    expect(summarizeServices([serviceEntry({ live: true })])?.label).toBe("1 service running");
    expect(
      summarizeServices([
        serviceEntry({ live: true }),
        serviceEntry({ key: "b", port: 3001, live: false }),
      ]),
    ).toEqual({ state: "starting", label: "1 of 2 services running" });
  });

  it("reads the retained winner as one line of readiness, and leaves a ready warm pair unsaid", () => {
    const readiness = readinessSummary(
      "feat/x",
      { runID: "run-a", side: "a", worktreeName: "generation-2-a", state: "live" },
      [serviceEntry({ preview: true, live: true, url: "http://preview.localhost:6774" })],
      {
        generation: 3,
        state: "ready",
        sides: [
          { side: "a", worktreeName: "generation-3-a", ready: true },
          { side: "b", worktreeName: "generation-3-b", ready: true },
        ],
      },
    );
    expect(readiness).toEqual({
      branch: "feat/x",
      retained: {
        text: "Agent A's preview running",
        tone: "live",
        previewUrl: "http://preview.localhost:6774",
      },
    });
  });

  it("stays silent about a next battle that is still preparing", () => {
    expect(
      readinessSummary(
        undefined,
        { runID: "run-b", side: "b", worktreeName: "generation-2-b", state: "stopping" },
        [],
        { generation: 3, state: "pending", sides: [] },
      ),
    ).toEqual({
      branch: "Detached HEAD",
      retained: { text: "Stopping Agent B's services", tone: "busy" },
    });
  });

  it("reports failed cleanup and failed preparation", () => {
    expect(
      readinessSummary(
        "main",
        { runID: "run-a", side: "a", worktreeName: "generation-2-a", state: "cleanup_failed" },
        [],
        { generation: 3, state: "failed", sides: [], error: "disk full" },
      ),
    ).toMatchObject({
      retained: { tone: "danger" },
      next: { text: "Next battle preparation failed", tone: "danger" },
    });
  });
});
