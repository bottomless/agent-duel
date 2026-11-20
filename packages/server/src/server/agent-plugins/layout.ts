import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Where imported plugins live under `$PASEO_HOME`. The engine reads `imported` through
 * `AGENT_DUEL_IMPORTED_CONFIG` and finds a project's folder by the same hash
 * (`importedProjectDirectory` in `arena-backend/packages/core/src/config/discovery.ts`).
 */
export interface AgentPluginsLayout {
  root: string;
  state: string;
  work: string;
  imported: string;
  global: string;
  projects: string;
}

export function resolveAgentPluginsLayout(paseoHome: string): AgentPluginsLayout {
  const root = path.join(paseoHome, "agent-plugins");
  const imported = path.join(root, "opencode");
  return {
    root,
    state: path.join(root, "state.json"),
    work: path.join(root, "work"),
    imported,
    global: path.join(imported, "global"),
    projects: path.join(imported, "projects"),
  };
}

/** `projectRoot` is a resolved path; the engine hashes the resolved ancestors of a session. */
export function projectKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
}

export function projectImportDirectory(layout: AgentPluginsLayout, projectRoot: string): string {
  return path.join(layout.projects, projectKey(projectRoot));
}
