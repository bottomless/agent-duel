import { describe, expect, test, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

import { applyArenaChatTitle, applyArenaFirstTurnMetadata } from "./arena-workspace-auto-name.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

const prompt = "Fix Arena workspace names";

function firstTurn(comparisonTitle?: string): ArenaSnapshot {
  return {
    turn: { index: 0, prompt },
    ...(comparisonTitle
      ? {
          comparison: {
            state: "complete",
            title: comparisonTitle,
            truncated: false,
            omittedArtifacts: [],
          },
        }
      : {}),
  } as ArenaSnapshot;
}

function workspaceNamer(title: string | null, suggested: string | null = null) {
  let workspace: PersistedWorkspaceRecord = {
    ...createPersistedWorkspaceRecord({
      workspaceId: "workspace-arena",
      projectId: "project-arena",
      cwd: "/repo",
      kind: "directory",
      displayName: "repo",
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
    }),
    title,
  };
  const writes: string[] = [];
  const emitted: string[] = [];
  const asked: string[] = [];
  const workspaceRegistry = {
    get: async () => workspace,
    update: async (_workspaceId, updater) => {
      workspace = updater(workspace);
      writes.push(workspace.title ?? "");
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "get" | "update">;
  const workspaceAutoName = new WorkspaceAutoName({
    workspaceRegistry,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emitted.push(workspaceId);
    },
    suggestChatTitle: async (_cwd, source) => {
      asked.push(source);
      return suggested;
    },
  });
  return { workspaceAutoName, writes, emitted, asked, title: () => workspace.title };
}

const agent = { workspaceId: "workspace-arena", cwd: "/repo" };

function skippedFirstTurn(resolution?: unknown): ArenaSnapshot {
  return {
    turn: { index: 0, prompt, comparisonState: "skipped", ...(resolution ? { resolution } : {}) },
  } as ArenaSnapshot;
}

describe("applyArenaFirstTurnMetadata", () => {
  test("titles the agent and an untitled workspace from the first prompt", async () => {
    const namer = workspaceNamer(null);
    const updateAgentTitle = vi.fn(async () => {});

    await applyArenaFirstTurnMetadata({
      agent,
      snapshot: firstTurn(),
      prompt,
      updateAgentTitle,
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(updateAgentTitle).toHaveBeenCalledWith(prompt);
    expect(namer.title()).toBe(prompt);
  });

  test("keeps the name of a workspace an earlier chat titled", async () => {
    const namer = workspaceNamer("Earlier chat");

    await applyArenaFirstTurnMetadata({
      agent,
      snapshot: firstTurn(),
      prompt,
      updateAgentTitle: async () => {},
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(namer.writes).toEqual([]);
  });

  test("leaves a later turn alone", async () => {
    const namer = workspaceNamer(null);
    const updateAgentTitle = vi.fn(async () => {});

    await applyArenaFirstTurnMetadata({
      agent,
      snapshot: { turn: { index: 1 } } as ArenaSnapshot,
      prompt: "Add one more thing",
      updateAgentTitle,
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(updateAgentTitle).not.toHaveBeenCalled();
    expect(namer.writes).toEqual([]);
  });
});

describe("applyArenaChatTitle", () => {
  test("replaces the prompt's first line with the first comparison's title once", async () => {
    const namer = workspaceNamer(null);
    await applyArenaFirstTurnMetadata({
      agent,
      snapshot: firstTurn(),
      prompt,
      updateAgentTitle: async () => {},
      workspaceAutoName: namer.workspaceAutoName,
    });
    const snapshot = firstTurn("Arena workspace names");

    await applyArenaChatTitle({ agent, snapshot, workspaceAutoName: namer.workspaceAutoName });
    await applyArenaChatTitle({ agent, snapshot, workspaceAutoName: namer.workspaceAutoName });

    expect(namer.title()).toBe("Arena workspace names");
    expect(namer.writes).toEqual([prompt, "Arena workspace names"]);
    expect(namer.emitted).toEqual(["workspace-arena", "workspace-arena"]);
  });

  test("keeps a name the user typed", async () => {
    const namer = workspaceNamer("My own name");

    await applyArenaChatTitle({
      agent,
      snapshot: firstTurn("Arena workspace names"),
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(namer.title()).toBe("My own name");
    expect(namer.writes).toEqual([]);
  });

  test("waits for the comparison to carry a title", async () => {
    const namer = workspaceNamer(prompt);

    await applyArenaChatTitle({
      agent,
      snapshot: firstTurn(),
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(namer.writes).toEqual([]);
  });

  test.each([
    ["an early pick", { kind: "early", vote: "a", appliedSide: "a" }],
    ["a stop", { kind: "stopped", resolution: "apply_b", appliedSide: "b" }],
    ["a battle that never started", { kind: "aborted", reason: "creation_failed" }],
  ])(
    "names the chat from its prompt once when %s skips the first comparison",
    async (_case, resolution) => {
      const namer = workspaceNamer(prompt, "Arena workspace names");
      const snapshot = skippedFirstTurn(resolution);

      await applyArenaChatTitle({ agent, snapshot, workspaceAutoName: namer.workspaceAutoName });
      await applyArenaChatTitle({ agent, snapshot, workspaceAutoName: namer.workspaceAutoName });

      expect(namer.asked).toEqual([prompt]);
      expect(namer.title()).toBe("Arena workspace names");
    },
  );

  test("asks nothing for a skipped first turn whose chat already has a name", async () => {
    const namer = workspaceNamer("My own name", "Arena workspace names");

    await applyArenaChatTitle({
      agent,
      snapshot: skippedFirstTurn({ kind: "early", vote: "a", appliedSide: "a" }),
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(namer.asked).toEqual([]);
    expect(namer.title()).toBe("My own name");
  });

  test("leaves a skipped first turn to its own comparison until it ends without a vote", async () => {
    const namer = workspaceNamer(prompt, "Arena workspace names");

    // Stopped but not yet kept or discarded.
    await applyArenaChatTitle({
      agent,
      snapshot: skippedFirstTurn(),
      workspaceAutoName: namer.workspaceAutoName,
    });
    // A failed side's skipped comparison names the chat itself.
    await applyArenaChatTitle({
      agent,
      snapshot: skippedFirstTurn({ kind: "vote", vote: "a", appliedSide: "a" }),
      workspaceAutoName: namer.workspaceAutoName,
    });

    expect(namer.asked).toEqual([]);
    expect(namer.title()).toBe(prompt);
  });
});
