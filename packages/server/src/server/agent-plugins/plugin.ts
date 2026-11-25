import type {
  AgentPluginContents,
  AgentPluginKind,
  AgentPluginSource,
  AgentPlugin,
} from "@getpaseo/protocol/messages";

/** The rulesync features Agent Duel imports. Hooks are left out: each battle contestant would run them. */
export const IMPORT_FEATURES = ["skills", "commands", "subagents", "mcp"] as const;
export type ImportFeature = (typeof IMPORT_FEATURES)[number];

export function presentFeatures(counts: Record<ImportFeature, number>): ImportFeature[] {
  return IMPORT_FEATURES.filter((feature) => counts[feature] > 0);
}

export type PluginImporter =
  | {
      kind: "rulesync";
      target: "claudecode-plugin" | "claudecode" | "codexcli";
      root: string;
      features: ImportFeature[];
    }
  | {
      // rulesync has no Codex plugin target, so its skills and MCP servers are staged directly.
      kind: "codex-plugin";
      skillsDir: string | null;
      mcpServers: Record<string, unknown>;
    };

/** A plugin found on disk, before the user's decision about it is applied. */
export interface DetectedPlugin extends Pick<
  AgentPlugin,
  "id" | "name" | "description" | "version"
> {
  source: AgentPluginSource;
  kind: AgentPluginKind;
  contents: AgentPluginContents;
  importer: PluginImporter;
  /** Changes whenever the plugin's files change, so a changed plugin is imported again. */
  signature: string;
}
