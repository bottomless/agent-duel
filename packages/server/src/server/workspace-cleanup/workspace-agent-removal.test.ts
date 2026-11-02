import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";

import {
  removeWorkspaceAgents,
  type WorkspaceAgentRemovalDeps,
} from "./workspace-agent-removal.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function receipt(workspaceId: string | null, agentId: string | null): string {
  return JSON.stringify({
    fingerprint: "f",
    inFlight: null,
    snapshot: {
      kind: "agent",
      idempotencyKey: "k",
      revision: 1,
      phase: "completed",
      workspaceId,
      agentId,
    },
  });
}

test("removes the workspace's agents like Paseo's delete, then their empty folder and creation receipts", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "workspace-agent-removal-"));
  directories.push(paseoHome);
  const removedFolder = join(paseoHome, "agents", "removed-cwd");
  const sharedFolder = join(paseoHome, "agents", "shared-cwd");
  mkdirSync(removedFolder, { recursive: true });
  mkdirSync(sharedFolder, { recursive: true });
  writeFileSync(join(removedFolder, "agent-a.json"), "{}");
  writeFileSync(join(sharedFolder, "agent-b.json"), "{}");
  writeFileSync(join(sharedFolder, "agent-other.json"), "{}");
  const creations = join(paseoHome, "creations");
  mkdirSync(creations);
  writeFileSync(join(creations, "workspace-receipt.json"), receipt("removed-workspace", null));
  writeFileSync(join(creations, "agent-receipt.json"), receipt("removed-workspace", "agent-a"));
  writeFileSync(join(creations, "other-receipt.json"), receipt("other-workspace", "agent-other"));
  writeFileSync(join(creations, "c1.claim"), "workspace-receipt");
  writeFileSync(join(creations, "c2.claim"), "agent-receipt");
  writeFileSync(join(creations, "c3.claim"), "other-receipt");
  const legacy = join(paseoHome, "agent-requests");
  mkdirSync(legacy);
  writeFileSync(
    join(legacy, "old-create.json"),
    JSON.stringify({ fingerprint: "f", agentId: "agent-a", state: "completed" }),
  );
  writeFileSync(
    join(legacy, "old-send.json"),
    JSON.stringify({ fingerprint: "f", agentId: "agent-b" }),
  );
  writeFileSync(
    join(legacy, "other-send.json"),
    JSON.stringify({ fingerprint: "f", agentId: "agent-other" }),
  );

  const calls: string[] = [];
  const files: Record<string, string> = {
    "agent-a": join(removedFolder, "agent-a.json"),
    "agent-b": join(sharedFolder, "agent-b.json"),
  };
  const deps = {
    paseoHome,
    logger: pino({ level: "silent" }),
    onAgentDeleted: async (agentId: string) => {
      calls.push(`event ${agentId}`);
    },
    agentStorage: {
      listByWorkspace: async () => [{ id: "agent-a" }, { id: "agent-b" }],
      beginDelete: (agentId: string) => calls.push(`fence ${agentId}`),
      remove: async (agentId: string) => {
        calls.push(`remove ${agentId}`);
        unlinkSync(files[agentId]!);
      },
    },
    agentManager: {
      closeAgent: async (agentId: string) => {
        calls.push(`close ${agentId}`);
        if (agentId === "agent-b") throw new Error("not loaded");
      },
      flush: async () => {
        calls.push("flush");
      },
      deleteAgentState: async (agentId: string) => {
        calls.push(`state ${agentId}`);
      },
    },
  } as unknown as WorkspaceAgentRemovalDeps;

  await removeWorkspaceAgents(deps, "removed-workspace");

  expect(calls).toEqual([
    "fence agent-a",
    "fence agent-b",
    "close agent-a",
    "close agent-b",
    "flush",
    "remove agent-a",
    "state agent-a",
    "event agent-a",
    "remove agent-b",
    "state agent-b",
    "event agent-b",
  ]);
  expect(existsSync(removedFolder)).toBe(false);
  // Another agent of the same cwd keeps its folder.
  expect(existsSync(join(sharedFolder, "agent-other.json"))).toBe(true);
  expect(existsSync(join(creations, "workspace-receipt.json"))).toBe(false);
  expect(existsSync(join(creations, "agent-receipt.json"))).toBe(false);
  expect(existsSync(join(creations, "c1.claim"))).toBe(false);
  expect(existsSync(join(creations, "c2.claim"))).toBe(false);
  expect(existsSync(join(creations, "other-receipt.json"))).toBe(true);
  expect(existsSync(join(creations, "c3.claim"))).toBe(true);
  expect(existsSync(join(legacy, "old-create.json"))).toBe(false);
  expect(existsSync(join(legacy, "old-send.json"))).toBe(false);
  expect(existsSync(join(legacy, "other-send.json"))).toBe(true);
});

test("a failing delete is logged and the other agents, events and receipts still go", async () => {
  const paseoHome = mkdtempSync(join(tmpdir(), "workspace-agent-removal-"));
  directories.push(paseoHome);
  const creations = join(paseoHome, "creations");
  mkdirSync(creations);
  writeFileSync(join(creations, "agent-receipt.json"), receipt("removed-workspace", "agent-a"));
  const calls: string[] = [];
  const errors: string[] = [];
  const logger = pino({ level: "silent" });
  logger.error = ((_context: unknown, message: string) => {
    errors.push(message);
  }) as typeof logger.error;
  const deps = {
    paseoHome,
    logger,
    onAgentDeleted: async (agentId: string) => {
      calls.push(`event ${agentId}`);
    },
    agentStorage: {
      listByWorkspace: async () => [{ id: "agent-a" }, { id: "agent-b" }],
      beginDelete: () => undefined,
      remove: async (agentId: string) => {
        if (agentId === "agent-a") throw new Error("disk error");
        calls.push(`remove ${agentId}`);
      },
    },
    agentManager: {
      closeAgent: async () => undefined,
      flush: async () => undefined,
      deleteAgentState: async (agentId: string) => {
        calls.push(`state ${agentId}`);
      },
    },
  } as unknown as WorkspaceAgentRemovalDeps;

  await expect(removeWorkspaceAgents(deps, "removed-workspace")).resolves.toBeUndefined();

  expect(errors).toEqual(["Failed to fully delete agent agent-a"]);
  expect(calls).toEqual(["event agent-a", "remove agent-b", "state agent-b", "event agent-b"]);
  expect(existsSync(join(creations, "agent-receipt.json"))).toBe(false);
});
