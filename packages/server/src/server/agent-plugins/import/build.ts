import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isRecord,
  listFiles,
  listSkillNames,
  mcpServersOf,
  readJsonObject,
} from "../detect/files.js";
import { IMPORT_FEATURES, type DetectedPlugin, type PluginImporter } from "../plugin.js";
import { RulesyncError, runRulesync } from "./rulesync.js";

/** Bump when a build's output changes, so imports made by an older daemon are redone. */
export const IMPORT_FORMAT = 4;

/** Why a plugin is missing from the build, by plugin id. */
export type BuildErrors = Record<string, string>;

const RULESYNC_DIR = ".rulesync";
const MCP_FILE = "mcp.jsonc";

// Project-mode imports of `claudecode` and `codexcli` write their MCP file into the output root's
// `.rulesync/`, so they read a private copy of these files and never the repository itself.
const REPOSITORY_FILES: Record<"claudecode" | "codexcli", readonly string[]> = {
  claudecode: [".claude/commands", ".claude/agents", ".mcp.json"],
  codexcli: [".codex/config.toml", ".codex/agents"],
};

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

async function copy(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, dereference: true });
}

function resolvePluginRoot(value: string, root: string): string {
  const expanded = value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("$CLAUDE_PLUGIN_ROOT", root);
  return expanded.startsWith("./") ? path.join(root, expanded.slice(2)) : expanded;
}

/**
 * rulesync turns `${CLAUDE_PLUGIN_ROOT}/server.js` into `./server.js` for repackaging the plugin.
 * The import runs the server from the plugin's install folder, so anchor those paths there.
 */
function anchorServer(config: unknown, root: string): unknown {
  if (!isRecord(config)) return config;
  const anchor = (value: unknown) =>
    typeof value === "string" ? resolvePluginRoot(value, root) : value;
  const env = isRecord(config.env)
    ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, anchor(value)]))
    : config.env;
  return {
    ...config,
    command: anchor(config.command),
    ...(Array.isArray(config.args) ? { args: config.args.map(anchor) } : {}),
    ...(config.cwd !== undefined ? { cwd: anchor(config.cwd) } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

async function writeMcp(rulesyncDir: string, servers: Record<string, unknown>): Promise<void> {
  await fs.mkdir(rulesyncDir, { recursive: true });
  await fs.writeFile(
    path.join(rulesyncDir, MCP_FILE),
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
  );
}

/** A plugin's files in rulesync's format, and why any of its features did not convert. */
interface Staged {
  dir: string;
  failures: string[];
}

/**
 * Imports one feature at a time: rulesync refuses a whole run over one file it cannot parse, such
 * as an agent whose frontmatter Claude Code reads leniently, and that should cost only that feature.
 */
async function stageRulesync(
  importer: Extract<PluginImporter, { kind: "rulesync" }>,
  stage: string,
): Promise<Staged> {
  const { target } = importer;
  const isPlugin = target === "claudecode-plugin";
  if (target !== "claudecode-plugin") {
    for (const file of REPOSITORY_FILES[target]) {
      const source = path.join(importer.root, file);
      if (await exists(source)) await copy(source, path.join(stage, file));
    }
  }
  const outputRoot = isPlugin ? importer.root : stage;
  const failures: string[] = [];
  for (const feature of importer.features) {
    try {
      await runRulesync(
        [
          "import",
          "--targets",
          importer.target,
          "--features",
          feature,
          "--output-root",
          outputRoot,
        ],
        stage,
      );
    } catch (error) {
      if (!(error instanceof RulesyncError)) throw error;
      // rulesync names files by absolute path; the plugin's own layout is what the user can act on.
      failures.push(error.reason.replaceAll(`${outputRoot}${path.sep}`, ""));
    }
  }
  const rulesyncDir = path.join(stage, RULESYNC_DIR);
  if (isPlugin) {
    const servers = mcpServersOf(await readJsonObject(path.join(rulesyncDir, MCP_FILE)));
    const anchored = Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [name, anchorServer(config, importer.root)]),
    );
    if (Object.keys(anchored).length > 0) await writeMcp(rulesyncDir, anchored);
  }
  return { dir: rulesyncDir, failures };
}

async function stageCodexPlugin(
  importer: Extract<PluginImporter, { kind: "codex-plugin" }>,
  stage: string,
): Promise<Staged> {
  const rulesyncDir = path.join(stage, RULESYNC_DIR);
  if (importer.skillsDir) {
    for (const name of await listSkillNames(importer.skillsDir)) {
      await copy(path.join(importer.skillsDir, name), path.join(rulesyncDir, "skills", name));
    }
  }
  if (Object.keys(importer.mcpServers).length > 0) await writeMcp(rulesyncDir, importer.mcpServers);
  return { dir: rulesyncDir, failures: [] };
}

function stagePlugin(plugin: DetectedPlugin, directory: string): Promise<Staged> {
  return plugin.importer.kind === "rulesync"
    ? stageRulesync(plugin.importer, directory)
    : stageCodexPlugin(plugin.importer, directory);
}

interface Merged {
  dir: string;
  servers: Record<string, unknown>;
}

/** The first plugin to claim a skill, command, agent or server name keeps it. */
async function merge(rulesyncDir: string, merged: Merged): Promise<void> {
  for (const name of await listSkillNames(path.join(rulesyncDir, "skills"))) {
    const destination = path.join(merged.dir, "skills", name);
    if (!(await exists(destination)))
      await copy(path.join(rulesyncDir, "skills", name), destination);
  }
  for (const feature of ["commands", "subagents"]) {
    for (const file of await listFiles(path.join(rulesyncDir, feature), [".md"])) {
      const destination = path.join(merged.dir, feature, file);
      if (!(await exists(destination)))
        await copy(path.join(rulesyncDir, feature, file), destination);
    }
  }
  const servers = mcpServersOf(await readJsonObject(path.join(rulesyncDir, MCP_FILE)));
  for (const [name, config] of Object.entries(servers)) {
    if (!(name in merged.servers)) merged.servers[name] = config;
  }
}

async function presentMergedFeatures(merged: Merged): Promise<string[]> {
  const present = await Promise.all(
    IMPORT_FEATURES.map(async (feature) => {
      if (feature === "mcp") return Object.keys(merged.servers).length > 0;
      if (feature === "skills")
        return (await listSkillNames(path.join(merged.dir, "skills"))).length > 0;
      return (await listFiles(path.join(merged.dir, feature), [".md"])).length > 0;
    }),
  );
  return IMPORT_FEATURES.filter((_, index) => present[index]);
}

/**
 * The engine's permission action for every tool of an MCP server (`McpTool.name` in
 * `arena-backend/packages/core/src/tool/mcp.ts`), which normalizes the server name the same way.
 */
function mcpToolsAction(server: string): string {
  return `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`;
}

/**
 * Imported MCP servers ask before each call, as they do in Claude Code. Agent Duel's Ask before
 * tools otherwise asks only for work outside the project, so a server with side effects (posting to
 * Slack, writing to a database) would run once per battle contestant without the user seeing it.
 * Auto Accept still runs them, and the user's own config ranks above the import and can allow them.
 */
async function askBeforeMcpCalls(configFile: string, servers: readonly string[]): Promise<void> {
  if (servers.length === 0 || !(await exists(configFile))) return;
  const config = await readJsonObject(configFile);
  if (!config) throw new Error(`rulesync wrote an unreadable ${configFile}`);
  const permissions = Array.isArray(config.permissions) ? config.permissions : [];
  config.permissions = [
    ...permissions,
    ...servers.map((server) => ({ action: mcpToolsAction(server), resource: "*", effect: "ask" })),
  ];
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Whether the engine loads this scope's instruction files and skills in place: a project's
 * AGENTS.md or CLAUDE.md, or the user's own (`config/imported-setup.ts` in the engine's core).
 */
export interface ImportSetup {
  instructions: boolean;
}

const SETUP_FILE = "agent-duel.json";

async function writeSetup(target: string, setup: ImportSetup): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, SETUP_FILE), `${JSON.stringify(setup, null, 2)}\n`);
}

/**
 * Replaces the files inside `target` rather than the directory itself, so the engine's watch on
 * the directory keeps working across imports.
 */
async function replaceContents(
  target: string,
  output: string | null,
  setup: ImportSetup,
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(target)) {
    if (entry === SETUP_FILE) continue;
    await fs.rm(path.join(target, entry), { recursive: true, force: true });
  }
  // Rewritten in place, so the engine never reads the scope without its switch.
  await writeSetup(target, setup);
  if (!output) return;
  const configDir = path.join(output, ".opencode");
  if (await exists(configDir)) {
    for (const entry of await fs.readdir(configDir)) {
      await copy(path.join(configDir, entry), path.join(target, entry));
    }
  }
  const config = path.join(output, "opencode.jsonc");
  if (await exists(config)) await copy(config, path.join(target, "opencode.jsonc"));
}

/**
 * Converts `plugins` into an OpenCode config directory at `target`. Each plugin is imported on its
 * own, so what rulesync refuses in one leaves the rest in; the merged set is generated once.
 */
export async function buildImport(input: {
  plugins: readonly DetectedPlugin[];
  target: string;
  workRoot: string;
  setup: ImportSetup;
}): Promise<BuildErrors> {
  await fs.mkdir(input.workRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(input.workRoot, "build-"));
  try {
    const errors: BuildErrors = {};
    const merged: Merged = { dir: path.join(work, "merged", RULESYNC_DIR), servers: {} };
    await fs.mkdir(merged.dir, { recursive: true });
    const imported: DetectedPlugin[] = [];
    for (const [index, plugin] of input.plugins.entries()) {
      const directory = path.join(work, "stage", String(index));
      await fs.mkdir(directory, { recursive: true });
      const staged = await stagePlugin(plugin, directory);
      await merge(staged.dir, merged);
      imported.push(plugin);
      if (staged.failures.length > 0) errors[plugin.id] = staged.failures.join("\n");
    }
    if (Object.keys(merged.servers).length > 0) await writeMcp(merged.dir, merged.servers);
    const features = await presentMergedFeatures(merged);
    if (features.length === 0) {
      await replaceContents(input.target, null, input.setup);
      return errors;
    }
    const output = path.join(work, "out");
    await fs.mkdir(output, { recursive: true });
    try {
      await runRulesync(
        [
          "generate",
          "--targets",
          "opencode",
          "--features",
          features.join(","),
          "--output-roots",
          output,
        ],
        path.dirname(merged.dir),
      );
    } catch (error) {
      if (!(error instanceof RulesyncError)) throw error;
      // The previous import stays in place, with this one's switch; every plugin reports the failure.
      await writeSetup(input.target, input.setup);
      const failed = Object.fromEntries(imported.map((plugin) => [plugin.id, error.reason]));
      return { ...errors, ...failed };
    }
    await askBeforeMcpCalls(path.join(output, "opencode.jsonc"), Object.keys(merged.servers));
    await replaceContents(input.target, output, input.setup);
    return errors;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
