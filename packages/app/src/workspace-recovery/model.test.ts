import { describe, expect, it } from "vitest";
import { recoverWorkspaceSelection, resolveWorkspaceRecoveryModel } from "./model";

describe("resolveWorkspaceRecoveryModel", () => {
  it("keeps a failed recovery actionable after the workspace and route intent change", () => {
    const recovery = {
      kind: "recoverable",
      workspaceId: "workspace-1",
      workspaceName: "Feature branch",
      action: "unarchive",
      branch: "feature",
    } as const;
    expect(
      resolveWorkspaceRecoveryModel({
        enabled: false,
        connected: true,
        hasClient: true,
        hasServerInfo: true,
        supportsRecovery: true,
        inspection: { pending: false, error: null, data: undefined },
        restore: {
          pending: false,
          error: "Engine unavailable",
          attempt: { recovery, agentId: "agent-1" },
        },
      }),
    ).toEqual({ kind: "recoverable", recovery, phase: "failed", error: "Engine unavailable" });
  });

  it("keeps newer recovery actions visible but non-actionable", () => {
    expect(
      resolveWorkspaceRecoveryModel({
        enabled: true,
        connected: true,
        hasClient: true,
        hasServerInfo: true,
        supportsRecovery: true,
        inspection: {
          pending: false,
          error: null,
          data: {
            kind: "recoverable",
            workspaceId: "workspace-1",
            workspaceName: "Feature branch",
            action: "repair_from_snapshot",
            branch: "feature",
          },
        },
        restore: { pending: false, error: null, attempt: null },
      }),
    ).toEqual({
      kind: "unsupportedAction",
      action: "repair_from_snapshot",
    });
  });

  it("keeps recovery pending until the whole action succeeds, then releases the screen", () => {
    const recovery = {
      kind: "recoverable",
      workspaceId: "workspace-1",
      workspaceName: "Feature branch",
      action: "unarchive",
      branch: "feature",
    } as const;
    const input = {
      enabled: false,
      connected: true,
      hasClient: true,
      hasServerInfo: true,
      supportsRecovery: true,
      inspection: { pending: false, error: null, data: undefined },
      restore: { pending: true, error: null, attempt: { recovery, agentId: "agent-1" } },
    };
    expect(resolveWorkspaceRecoveryModel(input)).toEqual({
      kind: "recoverable",
      recovery,
      phase: "restoring",
      error: null,
    });
    expect(
      resolveWorkspaceRecoveryModel({ ...input, restore: { ...input.restore, pending: false } }),
    ).toEqual({ kind: "idle" });
  });
});

describe("recoverWorkspaceSelection", () => {
  it("retries only the selected agent when the workspace was already recovered", async () => {
    const operations: string[] = [];
    await recoverWorkspaceSelection({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      needsWorkspaceRestore: false,
      client: {
        restoreWorkspace: async () => {
          throw new Error("This workspace is not archived");
        },
        refreshAgent: async (agentId) => {
          operations.push(`agent:${agentId}`);
        },
      },
    });
    expect(operations).toEqual(["agent:agent-1"]);
  });

  it("restores the workspace and selected archived agent as one recovery action", async () => {
    const operations: string[] = [];

    await recoverWorkspaceSelection({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      needsWorkspaceRestore: true,
      client: {
        restoreWorkspace: async (workspaceId) => {
          operations.push(`workspace:${workspaceId}`);
        },
        refreshAgent: async (agentId) => {
          operations.push(`agent:${agentId}`);
        },
      },
    });

    expect(operations).toEqual(["workspace:workspace-1", "agent:agent-1"]);
  });
});
