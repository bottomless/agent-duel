import type { TFunction } from "i18next";
import type { AgentPlugin } from "@getpaseo/protocol/messages";

/** A repository's own setup has no plugin name, so it is named after where it came from. */
export function pluginLabel(plugin: AgentPlugin, t: TFunction): string {
  if (plugin.kind === "plugin") return plugin.name;
  return plugin.source === "claude-code"
    ? t("agentPlugins.plugin.repositoryClaude")
    : t("agentPlugins.plugin.repositoryCodex");
}

/** "9 skills · 5 commands · MCP: slack" */
export function contentsSummary(plugin: AgentPlugin, t: TFunction): string {
  const { skills, commands, agents, mcpServers } = plugin.contents;
  const servers = mcpServers.map((server) => server.name).join(", ");
  const parts = [
    skills > 0 ? t("agentPlugins.plugin.skills", { count: skills }) : null,
    commands > 0 ? t("agentPlugins.plugin.commands", { count: commands }) : null,
    agents > 0 ? t("agentPlugins.plugin.agents", { count: agents }) : null,
    servers ? t("agentPlugins.plugin.mcp", { servers }) : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** "Claude Code · 9 skills · 5 commands · MCP: slack" */
export function pluginSummary(plugin: AgentPlugin, t: TFunction): string {
  if (plugin.unsupported) return t("agentPlugins.plugin.unsupported");
  const source =
    plugin.source === "claude-code"
      ? t("agentPlugins.plugin.fromClaude")
      : t("agentPlugins.plugin.fromCodex");
  const contents = contentsSummary(plugin, t);
  return contents ? `${source} · ${contents}` : source;
}

/** The banner's heading names where the project's plugins come from. */
export function bannerTitle(plugins: readonly AgentPlugin[], t: TFunction): string {
  const claude = plugins.some((plugin) => plugin.source === "claude-code");
  const codex = plugins.some((plugin) => plugin.source === "codex");
  if (claude && codex) return t("agentPlugins.banner.titleBoth");
  return codex ? t("agentPlugins.banner.titleCodex") : t("agentPlugins.banner.titleClaude");
}

/**
 * What the banner offers: plugins by name, and the repository's own setup by what it holds, since
 * the heading already says whose setup it is.
 */
export function bannerItem(plugin: AgentPlugin, t: TFunction): string {
  if (plugin.kind === "plugin") return plugin.name;
  return contentsSummary(plugin, t) || pluginLabel(plugin, t);
}
