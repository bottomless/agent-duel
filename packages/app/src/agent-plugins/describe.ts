import type { TFunction } from "i18next";
import type { AgentPlugin } from "@getpaseo/protocol/messages";

/** A repository's own setup has no plugin name, so it is named after where it came from. */
export function pluginLabel(plugin: AgentPlugin, t: TFunction): string {
  if (plugin.kind === "plugin") return plugin.name;
  return plugin.source === "claude-code"
    ? t("agentPlugins.plugin.repositoryClaude")
    : t("agentPlugins.plugin.repositoryCodex");
}

/** "Claude Code · 9 skills · 5 commands · MCP: slack" */
export function pluginSummary(plugin: AgentPlugin, t: TFunction): string {
  if (plugin.unsupported) return t("agentPlugins.plugin.unsupported");
  const { skills, commands, agents, mcpServers } = plugin.contents;
  const source =
    plugin.source === "claude-code"
      ? t("agentPlugins.plugin.fromClaude")
      : t("agentPlugins.plugin.fromCodex");
  const servers = mcpServers.map((server) => server.name).join(", ");
  const parts = [
    source,
    skills > 0 ? t("agentPlugins.plugin.skills", { count: skills }) : null,
    commands > 0 ? t("agentPlugins.plugin.commands", { count: commands }) : null,
    agents > 0 ? t("agentPlugins.plugin.agents", { count: agents }) : null,
    servers ? t("agentPlugins.plugin.mcp", { servers }) : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}
