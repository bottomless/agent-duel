import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentPluginMcpServer } from "@getpaseo/protocol/messages";
import { parse as parseToml } from "smol-toml";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON object another tool owns. A file that is missing, or that the tool left half-written or
 * malformed, reads as null: the plugin it describes is skipped rather than failing the whole scan.
 */
export async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isRecord(parsed) ? parsed : null;
}

/** A TOML file another tool owns; like `readJsonObject`, a malformed file reads as null. */
export async function readTomlObject(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return parseToml(text);
  } catch (error) {
    if (error instanceof Error && error.name === "TomlError") return null;
    throw error;
  }
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function listDirectory(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Subdirectory names that hold a `SKILL.md`. */
export async function listSkillNames(dir: string): Promise<string[]> {
  const entries = await listDirectory(dir);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if ((await readText(path.join(dir, entry.name, "SKILL.md"))) !== null) names.push(entry.name);
  }
  return names.toSorted();
}

/** Every file under `dir` with one of `extensions`, as paths relative to `dir`. */
export async function listFiles(dir: string, extensions: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await listDirectory(path.join(dir, relative))) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(child);
    }
  }
  await walk("");
  return found.toSorted();
}

/** Subdirectory names, sorted, skipping hidden ones. */
export async function listSubdirectories(dir: string): Promise<string[]> {
  const entries = await listDirectory(dir);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .toSorted();
}

function describeLaunch(config: Record<string, unknown>): string {
  if (typeof config.url === "string") return config.url;
  const args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const command = Array.isArray(config.command)
    ? config.command.filter((part): part is string => typeof part === "string")
    : [typeof config.command === "string" ? config.command : ""];
  return [...command, ...args].join(" ").trim();
}

/** The servers in an `mcpServers` map, as Claude Code's `.mcp.json` and Codex's `mcp.json` write it. */
export function describeMcpServers(servers: Record<string, unknown>): AgentPluginMcpServer[] {
  return Object.entries(servers)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, config]) => ({ name, launch: describeLaunch(config) }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function mcpServersOf(document: Record<string, unknown> | null): Record<string, unknown> {
  return document && isRecord(document.mcpServers) ? document.mcpServers : {};
}

/** Modification times of `files`, so editing any of them changes the import fingerprint. */
export async function modificationSignature(files: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(`${file}:${(await fs.stat(file)).mtimeMs}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return parts.join("|");
}
