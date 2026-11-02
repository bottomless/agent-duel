import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { closeAgentCommand, type LifecycleAgentManager } from "../agent/lifecycle-command.js";

export interface WorkspaceAgentRemovalDeps {
  paseoHome: string;
  agentStorage: Pick<AgentStorage, "listByWorkspace" | "beginDelete" | "remove">;
  agentManager: LifecycleAgentManager & Pick<AgentManager, "flush" | "deleteAgentState">;
  logger: Logger;
  /** Tell the connected apps, as Paseo's delete sends `agent_deleted` to its client. */
  onAgentDeleted?(agentId: string): Promise<void>;
}

/**
 * Delete a removed workspace's stored agents the way Paseo's delete-agent does (fence, close, flush,
 * remove, drop state, tell the app), then the per-cwd agent folder once empty and the creation
 * receipts that name the workspace or its agents. Only for the archived records Remove project
 * deletes. Like Paseo's delete it logs a failure and goes on, so it never throws: the caller removes
 * the record either way.
 */
export async function removeWorkspaceAgents(
  deps: WorkspaceAgentRemovalDeps,
  workspaceId: string,
): Promise<void> {
  let agentIds: string[];
  try {
    agentIds = (await deps.agentStorage.listByWorkspace(workspaceId)).map((record) => record.id);
  } catch (err) {
    deps.logger.error({ err, workspaceId }, "Failed to list a removed workspace's agents");
    agentIds = [];
  }
  const agentFolders = await findAgentFolders(deps.paseoHome, agentIds);

  // File-backed storage needs the delete fence before close, as in Paseo's delete.
  for (const agentId of agentIds) deps.agentStorage.beginDelete(agentId);
  for (const agentId of agentIds) {
    try {
      await closeAgentCommand({ agentManager: deps.agentManager }, agentId);
    } catch (err) {
      deps.logger.warn({ err, agentId }, `Failed to close agent ${agentId} during delete`);
    }
  }
  // Drain queued persistence before the files go, or a late write recreates one.
  try {
    await deps.agentManager.flush();
  } catch (err) {
    deps.logger.warn({ err, workspaceId }, "Failed to flush agents before delete");
  }
  for (const agentId of agentIds) {
    try {
      await deps.agentStorage.remove(agentId);
      await deps.agentManager.deleteAgentState(agentId);
    } catch (err) {
      deps.logger.error({ err, agentId }, `Failed to fully delete agent ${agentId}`);
    }
    try {
      await deps.onAgentDeleted?.(agentId);
    } catch (err) {
      deps.logger.warn({ err, agentId }, "Failed to tell the app an agent was deleted");
    }
  }

  for (const folder of agentFolders) {
    // Only an empty folder: another agent of the same cwd keeps it.
    await fs.rmdir(folder).catch(() => undefined);
  }
  try {
    await forgetCreationReceipts(deps.paseoHome, new Set([workspaceId]), new Set(agentIds));
    await forgetLegacyAgentReceipts(deps.paseoHome, new Set(agentIds));
  } catch (err) {
    deps.logger.warn({ err, workspaceId }, "Failed to remove a removed workspace's receipts");
  }
}

async function findAgentFolders(paseoHome: string, agentIds: string[]): Promise<string[]> {
  if (agentIds.length === 0) return [];
  const agentsRoot = path.join(paseoHome, "agents");
  const folders = new Set<string>();
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(agentsRoot, entry.name);
    const files = await fs.readdir(folder).catch(() => [] as string[]);
    if (agentIds.some((agentId) => files.includes(`${agentId}.json`))) folders.add(folder);
  }
  return [...folders];
}

/**
 * Creation receipts (`creations/<identity>.json`) and the id claims they own
 * (`creations/<digest>.claim`, holding the receipt identity) for the removed workspace and agents.
 */
async function forgetCreationReceipts(
  paseoHome: string,
  workspaceIds: Set<string>,
  agentIds: Set<string>,
): Promise<void> {
  const directory = path.join(paseoHome, "creations");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const identities = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const snapshot = await readReceiptSnapshot(path.join(directory, name));
    if (!snapshot) continue;
    const named =
      (snapshot.workspaceId && workspaceIds.has(snapshot.workspaceId)) ||
      (snapshot.agentId && agentIds.has(snapshot.agentId));
    if (named) identities.add(name.slice(0, -".json".length));
  }
  if (identities.size === 0) return;
  for (const name of names) {
    if (!name.endsWith(".claim")) continue;
    const owner = await fs.readFile(path.join(directory, name), "utf8").catch(() => null);
    if (owner !== null && identities.has(owner.trim()))
      await fs.rm(path.join(directory, name), { force: true });
  }
  for (const identity of identities) {
    await fs.rm(path.join(directory, `${identity}.json`), { force: true });
  }
}

async function readReceiptSnapshot(
  file: string,
): Promise<{ workspaceId: string | null; agentId: string | null } | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("snapshot" in parsed)) return null;
    const snapshot = parsed.snapshot;
    if (typeof snapshot !== "object" || snapshot === null) return null;
    const workspaceId = "workspaceId" in snapshot ? snapshot.workspaceId : null;
    const agentId = "agentId" in snapshot ? snapshot.agentId : null;
    return {
      workspaceId: typeof workspaceId === "string" ? workspaceId : null,
      agentId: typeof agentId === "string" ? agentId : null,
    };
  } catch {
    return null;
  }
}

/**
 * `agent-requests/<digest>.json`: the old creation receipts that `CreationService` still imports and
 * the message receipts of `MessageReceipts`. Both carry the agent in a top-level `agentId`, and both
 * are about an agent that no longer exists.
 */
async function forgetLegacyAgentReceipts(paseoHome: string, agentIds: Set<string>): Promise<void> {
  if (agentIds.size === 0) return;
  const directory = path.join(paseoHome, "agent-requests");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      const agentId =
        typeof parsed === "object" && parsed !== null && "agentId" in parsed
          ? parsed.agentId
          : null;
      if (typeof agentId === "string" && agentIds.has(agentId)) await fs.rm(file, { force: true });
    } catch {
      // Not a receipt this rule reads; leave it.
    }
  }
}
