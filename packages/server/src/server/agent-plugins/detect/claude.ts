import path from "node:path";
import { z } from "zod";

import { presentFeatures, type DetectedPlugin } from "../plugin.js";
import {
  describeMcpServers,
  isDirectory,
  isRecord,
  listFiles,
  listSkillNames,
  mcpServersOf,
  readJsonObject,
  realpathOrNull,
} from "./files.js";

// `~/.claude/plugins/installed_plugins.json`, version 2. One plugin can have an entry per scope.
const InstalledPluginsSchema = z.object({
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        scope: z.string(),
        installPath: z.string(),
        version: z.string().optional(),
        projectPath: z.string().optional(),
      }),
    ),
  ),
});

/** Where Claude Code enabled a plugin: `user` is global; the others belong to one project. */
export type ClaudeScope = { kind: "user" } | { kind: "project" | "local"; projectRoot: string };

export interface ClaudePlugin {
  scope: ClaudeScope;
  plugin: DetectedPlugin;
}

function settingsFile(home: string, scope: ClaudeScope): string {
  if (scope.kind === "user") return path.join(home, ".claude", "settings.json");
  const name = scope.kind === "local" ? "settings.local.json" : "settings.json";
  return path.join(scope.projectRoot, ".claude", name);
}

/** Claude Code enables an installed plugin unless its settings turn it off. */
async function isEnabled(home: string, scope: ClaudeScope, key: string): Promise<boolean> {
  const settings = await readJsonObject(settingsFile(home, scope));
  const enabled = settings && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  return enabled[key] !== false;
}

async function resolveScope(entry: {
  scope: string;
  projectPath?: string;
}): Promise<ClaudeScope | null> {
  if (entry.scope === "user") return { kind: "user" };
  if ((entry.scope !== "project" && entry.scope !== "local") || !entry.projectPath) return null;
  const projectRoot = await realpathOrNull(entry.projectPath);
  return projectRoot ? { kind: entry.scope, projectRoot } : null;
}

async function describePlugin(input: {
  key: string;
  installPath: string;
  version: string | null;
}): Promise<DetectedPlugin> {
  const { key, installPath } = input;
  const manifest = await readJsonObject(path.join(installPath, ".claude-plugin", "plugin.json"));
  const mcpFile = await readJsonObject(path.join(installPath, ".mcp.json"));
  const manifestServers = manifest && isRecord(manifest.mcpServers) ? manifest.mcpServers : {};
  const mcpServers = describeMcpServers({ ...manifestServers, ...mcpServersOf(mcpFile) });
  const skills = (await listSkillNames(path.join(installPath, "skills"))).length;
  const commands = (await listFiles(path.join(installPath, "commands"), [".md"])).length;
  const agents = (await listFiles(path.join(installPath, "agents"), [".md"])).length;
  const features = presentFeatures({
    skills,
    commands,
    subagents: agents,
    mcp: mcpServers.length,
  });
  const version =
    (manifest && typeof manifest.version === "string" ? manifest.version : null) ?? input.version;
  return {
    id: `claude-code:${key}`,
    name: manifest && typeof manifest.name === "string" ? manifest.name : pluginName(key),
    description: manifest && typeof manifest.description === "string" ? manifest.description : null,
    version,
    source: "claude-code",
    kind: "plugin",
    contents: { skills, commands, agents, mcpServers },
    importer: { kind: "rulesync", target: "claudecode-plugin", root: installPath, features },
    signature: `${installPath}|${version ?? ""}`,
  };
}

/** `slack@anthropic-plugin-directory` names the `slack` plugin from that marketplace. */
function pluginName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/** Every plugin Claude Code has installed and enabled, in any scope. */
export async function detectClaudePlugins(home: string): Promise<ClaudePlugin[]> {
  const installed = await readJsonObject(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
  );
  const parsed = InstalledPluginsSchema.safeParse(installed);
  if (!parsed.success) return [];
  const found: ClaudePlugin[] = [];
  for (const [key, entries] of Object.entries(parsed.data.plugins)) {
    for (const entry of entries) {
      const scope = await resolveScope(entry);
      if (!scope || !(await isDirectory(entry.installPath))) continue;
      if (!(await isEnabled(home, scope, key))) continue;
      const plugin = await describePlugin({
        key,
        installPath: entry.installPath,
        version: entry.version ?? null,
      });
      found.push({ scope, plugin });
    }
  }
  return found;
}
