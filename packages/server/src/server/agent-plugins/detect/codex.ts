import path from "node:path";
import semver from "semver";

import type { DetectedPlugin } from "../plugin.js";
import {
  describeMcpServers,
  isDirectory,
  isRecord,
  listSkillNames,
  listSubdirectories,
  mcpServersOf,
  readJsonObject,
  readTomlObject,
} from "./files.js";

function compareVersions(a: string, b: string): number {
  const [left, right] = [semver.valid(a), semver.valid(b)];
  if (left && right) return semver.compare(left, right);
  return a.localeCompare(b);
}

async function readCodexConfig(home: string): Promise<Record<string, unknown>> {
  return (await readTomlObject(path.join(home, ".codex", "config.toml"))) ?? {};
}

/**
 * Codex turns a plugin off with `[plugins."name@marketplace"] enabled = false`. Plugins installed
 * from the ChatGPT directory are cached under `<marketplace>-remote`, so both spellings count.
 */
function isDisabled(config: Record<string, unknown>, name: string, marketplace: string): boolean {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const keys = [`${name}@${marketplace}`, `${name}@${marketplace.replace(/-remote$/, "")}`];
  return keys.some((key) => {
    const entry = plugins[key];
    return isRecord(entry) && entry.enabled === false;
  });
}

async function readManifest(root: string): Promise<Record<string, unknown> | null> {
  return (
    (await readJsonObject(path.join(root, ".codex-plugin", "plugin.json"))) ??
    (await readJsonObject(path.join(root, "plugin.json")))
  );
}

async function resolveSkillsDir(
  root: string,
  manifest: Record<string, unknown> | null,
): Promise<string | null> {
  const declared = manifest && typeof manifest.skills === "string" ? manifest.skills : "skills";
  const dir = path.resolve(root, declared);
  return (await isDirectory(dir)) ? dir : null;
}

async function resolveMcpServers(
  root: string,
  manifest: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const declared = manifest?.mcpServers;
  if (isRecord(declared)) return declared;
  const files =
    typeof declared === "string" ? [declared] : ["mcp.json", ".mcp.json", ".codex-mcp.json"];
  for (const file of files) {
    const document = await readJsonObject(path.resolve(root, file));
    if (document) return mcpServersOf(document);
  }
  return {};
}

/** Codex manifests keep display text in `interface`; agent-plugins.org manifests nest it per vendor. */
function displayText(manifest: Record<string, unknown> | null, key: string): string | null {
  const extensions = manifest && isRecord(manifest.extensions) ? manifest.extensions : {};
  const openai = isRecord(extensions["com.openai"]) ? extensions["com.openai"] : {};
  const candidates = [manifest?.interface, openai.interface];
  for (const ui of candidates) {
    const value = isRecord(ui) ? ui[key] : undefined;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Whether the plugin needs a ChatGPT app (`.app.json`). Those run through OpenAI's backend under
 * the user's ChatGPT account, and the plugin's skills drive the app's tools, so none of it works
 * outside Codex.
 */
async function requiresChatGptApp(
  root: string,
  manifest: Record<string, unknown> | null,
): Promise<boolean> {
  const declared = manifest && typeof manifest.apps === "string" ? manifest.apps : ".app.json";
  const document = await readJsonObject(path.resolve(root, declared));
  const apps = document && isRecord(document.apps) ? Object.values(document.apps) : [];
  return apps.some((app) => isRecord(app) && app.required === true);
}

async function describePlugin(input: {
  marketplace: string;
  directory: string;
  root: string;
  version: string;
}): Promise<DetectedPlugin | null> {
  const { marketplace, directory, root, version } = input;
  const manifest = await readManifest(root);
  const skillsDir = await resolveSkillsDir(root, manifest);
  const skills = skillsDir ? (await listSkillNames(skillsDir)).length : 0;
  const mcpServers = await resolveMcpServers(root, manifest);
  const servers = describeMcpServers(mcpServers);
  const requiresApp = await requiresChatGptApp(root, manifest);
  if (skills === 0 && servers.length === 0 && !requiresApp) return null;
  const name = manifest && typeof manifest.name === "string" ? manifest.name : directory;
  return {
    id: `codex:${directory}@${marketplace}`,
    name: displayText(manifest, "displayName") ?? name,
    description:
      displayText(manifest, "shortDescription") ??
      (manifest && typeof manifest.description === "string" ? manifest.description : null),
    version,
    source: "codex",
    kind: "plugin",
    contents: { skills, commands: 0, agents: 0, mcpServers: servers },
    unsupported: requiresApp ? "chatgpt-apps" : null,
    importer: {
      kind: "codex-plugin",
      skillsDir: skills > 0 ? skillsDir : null,
      mcpServers,
    },
    signature: `${root}|${version}`,
  };
}

/** Every plugin in Codex's plugin cache that Codex has not turned off, at its newest cached version. */
export async function detectCodexPlugins(home: string): Promise<DetectedPlugin[]> {
  const cache = path.join(home, ".codex", "plugins", "cache");
  const config = await readCodexConfig(home);
  const found: DetectedPlugin[] = [];
  for (const marketplace of await listSubdirectories(cache)) {
    for (const directory of await listSubdirectories(path.join(cache, marketplace))) {
      if (isDisabled(config, directory, marketplace)) continue;
      const versions = await listSubdirectories(path.join(cache, marketplace, directory));
      const version = versions.toSorted(compareVersions).at(-1);
      if (!version) continue;
      const root = path.join(cache, marketplace, directory, version);
      const plugin = await describePlugin({ marketplace, directory, root, version });
      if (plugin) found.push(plugin);
    }
  }
  return found;
}
