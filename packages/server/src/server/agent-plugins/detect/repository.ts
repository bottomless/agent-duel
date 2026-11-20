import path from "node:path";

import { presentFeatures, type DetectedPlugin } from "../plugin.js";
import {
  describeMcpServers,
  isRecord,
  listFiles,
  listSkillNames,
  mcpServersOf,
  modificationSignature,
  readJsonObject,
  readTomlObject,
} from "./files.js";

/**
 * The project's own Claude Code setup: `.claude/commands`, `.claude/agents` and `.mcp.json`. Skills
 * in `.claude/skills` are left out because the engine reads them itself.
 */
async function detectClaudeSetup(projectRoot: string): Promise<DetectedPlugin | null> {
  const commandFiles = (
    await listFiles(path.join(projectRoot, ".claude", "commands"), [".md"])
  ).map((file) => path.join(projectRoot, ".claude", "commands", file));
  const agentFiles = (await listFiles(path.join(projectRoot, ".claude", "agents"), [".md"])).map(
    (file) => path.join(projectRoot, ".claude", "agents", file),
  );
  const mcpFile = path.join(projectRoot, ".mcp.json");
  const mcpServers = describeMcpServers(mcpServersOf(await readJsonObject(mcpFile)));
  const features = presentFeatures({
    skills: 0,
    commands: commandFiles.length,
    subagents: agentFiles.length,
    mcp: mcpServers.length,
  });
  if (features.length === 0) return null;
  return {
    id: "repository:claude-code",
    name: "Claude Code",
    description: null,
    version: null,
    source: "claude-code",
    kind: "repository",
    contents: { skills: 0, commands: commandFiles.length, agents: agentFiles.length, mcpServers },
    unsupported: null,
    importer: { kind: "rulesync", target: "claudecode", root: projectRoot, features },
    signature: await modificationSignature([...commandFiles, ...agentFiles, mcpFile]),
  };
}

/** The project's own Codex setup: MCP servers in `.codex/config.toml` and agents in `.codex/agents`. */
async function detectCodexSetup(projectRoot: string): Promise<DetectedPlugin | null> {
  const configFile = path.join(projectRoot, ".codex", "config.toml");
  const config = await readTomlObject(configFile);
  const servers = describeMcpServers(
    config && isRecord(config.mcp_servers) ? config.mcp_servers : {},
  );
  const agentFiles = (await listFiles(path.join(projectRoot, ".codex", "agents"), [".toml"])).map(
    (file) => path.join(projectRoot, ".codex", "agents", file),
  );
  const features = presentFeatures({
    skills: 0,
    commands: 0,
    subagents: agentFiles.length,
    mcp: servers.length,
  });
  if (features.length === 0) return null;
  return {
    id: "repository:codex",
    name: "Codex",
    description: null,
    version: null,
    source: "codex",
    kind: "repository",
    contents: { skills: 0, commands: 0, agents: agentFiles.length, mcpServers: servers },
    unsupported: null,
    importer: { kind: "rulesync", target: "codexcli", root: projectRoot, features },
    signature: await modificationSignature([configFile, ...agentFiles]),
  };
}

export async function detectRepositorySetup(projectRoot: string): Promise<DetectedPlugin[]> {
  const found = [await detectClaudeSetup(projectRoot), await detectCodexSetup(projectRoot)];
  return found.filter((plugin): plugin is DetectedPlugin => plugin !== null);
}

/** Skills the engine already loads from the project, which need no import. */
export async function listNativeSkills(projectRoot: string): Promise<string[]> {
  const names = [
    ...(await listSkillNames(path.join(projectRoot, ".claude", "skills"))),
    ...(await listSkillNames(path.join(projectRoot, ".agents", "skills"))),
  ];
  return [...new Set(names)].toSorted();
}
