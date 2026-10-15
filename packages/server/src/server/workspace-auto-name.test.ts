import { expect, test } from "vitest";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createPersistedWorkspaceRecord, type WorkspaceRegistry } from "./workspace-registry.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("a title preserves workspace archival that lands during its metadata write", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    title: "Name this workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const mutationStarted = deferred();
  const allowMutation = deferred();
  const workspaceRegistry = {
    get: async () => workspace,
    update: async (_workspaceId, updater) => {
      mutationStarted.resolve();
      await allowMutation.promise;
      workspace = updater(workspace);
      return workspace;
    },
  } satisfies Pick<WorkspaceRegistry, "get" | "update">;
  const autoName = new WorkspaceAutoName({
    workspaceRegistry,
    emitWorkspaceUpdateForWorkspaceId: async () => {},
  });

  const applying = autoName.applyTitle(workspace.workspaceId, {
    title: "generated",
    promptTitle: "Name this workspace",
  });
  await mutationStarted.promise;
  const archivedAt = "2026-08-08T00:01:00.000Z";
  workspace = { ...workspace, updatedAt: archivedAt, archivedAt };
  allowMutation.resolve();
  await applying;

  expect(workspace).toMatchObject({
    title: "generated",
    archivedAt,
  });
});

test("a title never replaces one the user typed", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-typed",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    title: "My own name",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const emitted: string[] = [];
  const autoName = new WorkspaceAutoName({
    workspaceRegistry: {
      get: async () => workspace,
      update: async (_workspaceId, updater) => {
        workspace = updater(workspace);
        return workspace;
      },
    },
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emitted.push(workspaceId);
    },
  });

  await autoName.applyTitle(workspace.workspaceId, {
    title: "generated",
    promptTitle: "Name this workspace",
  });

  expect(workspace.title).toBe("My own name");
  expect(emitted).toEqual([]);
});
