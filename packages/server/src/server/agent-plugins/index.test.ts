import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPluginsStatus } from "@getpaseo/protocol/messages";

import { runGitCommand } from "@server/utils/run-git-command.js";
import { createAgentPlugins, type AgentPlugins } from "./index.js";
import { projectImportDirectory, resolveAgentPluginsLayout } from "./layout.js";

interface Sandbox {
  root: string;
  home: string;
  paseoHome: string;
  project: string;
  plugins: AgentPlugins;
  /** `installed_plugins.json`'s `plugins` map, as the fixtures have written it. */
  claudeRegistry: Record<string, unknown[]>;
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill\n---\nUse ${name}.\n`;
}

async function installClaudePlugin(
  sandbox: Sandbox,
  input: {
    key: string;
    scope?: "user" | "local";
    files: Record<string, string>;
  },
): Promise<string> {
  const [name = "", marketplace = ""] = input.key.split("@");
  const installPath = path.join(
    sandbox.home,
    ".claude",
    "plugins",
    "cache",
    marketplace,
    name,
    "1.0.0",
  );
  await write(
    path.join(installPath, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, description: `The ${name} plugin`, version: "1.0.0" }),
  );
  for (const [file, content] of Object.entries(input.files)) {
    await write(path.join(installPath, file), content);
  }
  const scope = input.scope ?? "user";
  sandbox.claudeRegistry[input.key] = [
    {
      scope,
      installPath,
      version: "1.0.0",
      ...(scope === "local" ? { projectPath: sandbox.project } : {}),
    },
  ];
  await write(
    path.join(sandbox.home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: sandbox.claudeRegistry }),
  );
  return installPath;
}

async function installCodexPlugin(
  sandbox: Sandbox,
  input: { name: string; manifest: Record<string, unknown>; files: Record<string, string> },
): Promise<void> {
  const root = path.join(
    sandbox.home,
    ".codex",
    "plugins",
    "cache",
    "openai-curated-remote",
    input.name,
    "0.1.0",
  );
  await write(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: input.name, ...input.manifest }),
  );
  for (const [file, content] of Object.entries(input.files)) {
    await write(path.join(root, file), content);
  }
}

function plugin(
  status: AgentPluginsStatus["global"] | NonNullable<AgentPluginsStatus["project"]>,
  id: string,
) {
  const found = status.plugins.find((entry) => entry.id === id);
  if (!found)
    throw new Error(`No plugin ${id} in ${status.plugins.map((entry) => entry.id).join(", ")}`);
  return found;
}

function projectOf(status: AgentPluginsStatus): NonNullable<AgentPluginsStatus["project"]> {
  if (!status.project) throw new Error("Expected a project status");
  return status.project;
}

function globalImport(sandbox: Sandbox): string {
  return resolveAgentPluginsLayout(sandbox.paseoHome).global;
}

describe("agent plugins", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-")));
    const home = path.join(root, "home");
    const paseoHome = path.join(root, "paseo");
    const project = path.join(root, "repo");
    await fs.mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    sandbox = {
      root,
      home,
      paseoHome,
      project,
      plugins: createAgentPlugins({ paseoHome, home, runGit: runGitCommand }),
      claudeRegistry: {},
    };
    await sandbox.plugins.start();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("lists global plugins as pending and imports nothing until the user reviews them", async () => {
    await installClaudePlugin(sandbox, {
      key: "slack@directory",
      files: { "skills/slack-search/SKILL.md": skill("slack-search") },
    });

    const status = await sandbox.plugins.getStatus(null);

    expect(status.global.reviewed).toBe(false);
    expect(plugin(status.global, "claude-code:slack@directory")).toMatchObject({
      name: "slack",
      state: "pending",
      contents: { skills: 1, commands: 0, agents: 0, mcpServers: [] },
    });
    expect(await exists(path.join(globalImport(sandbox), "skills"))).toBe(false);
  });

  it("imports the global plugins the user keeps and leaves out the ones they turn off", async () => {
    const slack = await installClaudePlugin(sandbox, {
      key: "slack@directory",
      files: {
        "skills/slack-search/SKILL.md": skill("slack-search"),
        "commands/standup.md": "---\ndescription: Standup\n---\nWrite my standup.\n",
        ".mcp.json": JSON.stringify({
          mcpServers: {
            local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
            slack: { type: "http", url: "https://mcp.slack.com/mcp" },
          },
        }),
      },
    });
    await installClaudePlugin(sandbox, {
      key: "noisy@directory",
      files: { "skills/noisy/SKILL.md": skill("noisy") },
    });

    const status = await sandbox.plugins.saveSelection({
      scope: { kind: "global" },
      enabled: ["claude-code:slack@directory"],
      disabled: ["claude-code:noisy@directory"],
    });

    expect(status.global.reviewed).toBe(true);
    expect(plugin(status.global, "claude-code:slack@directory").state).toBe("on");
    expect(plugin(status.global, "claude-code:noisy@directory").state).toBe("off");
    const target = globalImport(sandbox);
    expect(await exists(path.join(target, "skills", "slack-search", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(target, "commands", "standup.md"))).toBe(true);
    expect(await exists(path.join(target, "skills", "noisy"))).toBe(false);
    expect(await readJson(path.join(target, "opencode.jsonc"))).toEqual({
      mcp: {
        servers: {
          local: { type: "local", command: ["node", path.join(slack, "server.js")] },
          slack: { type: "remote", url: "https://mcp.slack.com/mcp" },
        },
      },
    });
  });

  it("imports a global plugin installed after the review on its own and reports it as added", async () => {
    await sandbox.plugins.saveSelection({ scope: { kind: "global" }, enabled: [], disabled: [] });
    await installClaudePlugin(sandbox, {
      key: "later@directory",
      files: { "skills/later/SKILL.md": skill("later") },
    });

    const status = await sandbox.plugins.getStatus(null);

    expect(plugin(status.global, "claude-code:later@directory").state).toBe("on");
    expect(status.global.added).toEqual(["claude-code:later@directory"]);
    expect(await exists(path.join(globalImport(sandbox), "skills", "later", "SKILL.md"))).toBe(
      true,
    );
    const acknowledged = await sandbox.plugins.acknowledgeAdded(status.global.added);
    expect(acknowledged.global.added).toEqual([]);
  });

  it("imports Codex plugin skills and MCP servers, and leaves out ChatGPT-app plugins", async () => {
    await installCodexPlugin(sandbox, {
      name: "visualize",
      manifest: { skills: "./skills/", interface: { displayName: "Visualize" } },
      files: { "skills/chart/SKILL.md": skill("chart") },
    });
    await installCodexPlugin(sandbox, {
      name: "runway",
      manifest: {},
      files: {
        "mcp.json": JSON.stringify({
          mcpServers: { runway: { type: "streamable-http", url: "https://mcp.runwayml.com/mcp" } },
        }),
      },
    });
    await installCodexPlugin(sandbox, {
      name: "pages",
      manifest: { apps: "./.app.json" },
      files: {
        ".app.json": JSON.stringify({
          apps: { pages: { id: "connector_openai_pages", required: true } },
        }),
        "skills/write-page/SKILL.md": skill("write-page"),
      },
    });

    const status = await sandbox.plugins.saveSelection({
      scope: { kind: "global" },
      enabled: [],
      disabled: [],
    });

    expect(plugin(status.global, "codex:visualize@openai-curated-remote")).toMatchObject({
      name: "Visualize",
      state: "on",
    });
    expect(status.global.plugins.map((entry) => entry.id)).not.toContain(
      "codex:pages@openai-curated-remote",
    );
    const target = globalImport(sandbox);
    expect(await exists(path.join(target, "skills", "chart", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(target, "skills", "write-page"))).toBe(false);
    expect(await readJson(path.join(target, "opencode.jsonc"))).toEqual({
      mcp: { servers: { runway: { type: "remote", url: "https://mcp.runwayml.com/mcp" } } },
    });
  });

  it("skips Codex plugins that Codex has turned off", async () => {
    await installCodexPlugin(sandbox, {
      name: "visualize",
      manifest: {},
      files: { "skills/chart/SKILL.md": skill("chart") },
    });
    await write(
      path.join(sandbox.home, ".codex", "config.toml"),
      '[plugins."visualize@openai-curated"]\nenabled = false\n',
    );

    const status = await sandbox.plugins.getStatus(null);

    expect(status.global.plugins).toEqual([]);
  });

  it("reports a plugin rulesync refuses and still imports the others", async () => {
    const broken = await installClaudePlugin(sandbox, {
      key: "broken@directory",
      files: { "skills/broken/SKILL.md": skill("broken") },
    });
    await fs.symlink("/etc/hosts", path.join(broken, "skills", "broken", "hosts"));
    await installClaudePlugin(sandbox, {
      key: "fine@directory",
      files: { "skills/fine/SKILL.md": skill("fine") },
    });

    const status = await sandbox.plugins.saveSelection({
      scope: { kind: "global" },
      enabled: [],
      disabled: [],
    });

    expect(plugin(status.global, "claude-code:broken@directory").importError).toMatch(
      /symbolic link/,
    );
    expect(plugin(status.global, "claude-code:fine@directory").importError).toBeNull();
    expect(await exists(path.join(globalImport(sandbox), "skills", "fine", "SKILL.md"))).toBe(true);
  });

  it("keeps the parts of a plugin rulesync can convert when one of its files cannot be parsed", async () => {
    await installClaudePlugin(sandbox, {
      key: "review@directory",
      files: {
        "commands/review.md": "---\ndescription: Review\n---\nReview the change.\n",
        // Claude Code accepts this unquoted description; strict YAML does not.
        "agents/hunter.md":
          "---\nname: hunter\ndescription: Use this agent when: Context: it fails\n---\nHunt.\n",
      },
    });

    const status = await sandbox.plugins.saveSelection({
      scope: { kind: "global" },
      enabled: [],
      disabled: [],
    });

    expect(plugin(status.global, "claude-code:review@directory").importError).toMatch(/hunter\.md/);
    expect(await exists(path.join(globalImport(sandbox), "commands", "review.md"))).toBe(true);
  });

  it("keeps a project's plugins pending until the user decides in that project", async () => {
    await installClaudePlugin(sandbox, {
      key: "deploy@team",
      scope: "local",
      files: { "commands/deploy.md": "---\ndescription: Deploy\n---\nDeploy it.\n" },
    });
    await write(
      path.join(sandbox.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { pg: { command: "npx", args: ["@pg/mcp"] } } }),
    );
    await write(
      path.join(sandbox.project, ".claude", "skills", "native", "SKILL.md"),
      skill("native"),
    );

    const status = await sandbox.plugins.getStatus(sandbox.project);

    const project = projectOf(status);
    expect(project.projectRoot).toBe(sandbox.project);
    expect(project.nativeSkills).toEqual(["native"]);
    expect(status.global.plugins).toEqual([]);
    expect(plugin(project, "claude-code:deploy@team").state).toBe("pending");
    expect(plugin(project, "repository:claude-code")).toMatchObject({
      kind: "repository",
      state: "pending",
      contents: { mcpServers: [{ name: "pg", launch: "npx @pg/mcp" }] },
    });
  });

  it("imports a project's plugins into that project's folder without writing into the repository", async () => {
    await installClaudePlugin(sandbox, {
      key: "deploy@team",
      scope: "local",
      files: { "commands/deploy.md": "---\ndescription: Deploy\n---\nDeploy it.\n" },
    });
    await write(
      path.join(sandbox.project, ".claude", "commands", "release.md"),
      "---\ndescription: Release\n---\nRelease.\n",
    );
    await write(
      path.join(sandbox.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { pg: { command: "npx", args: ["@pg/mcp"] } } }),
    );
    await write(
      path.join(sandbox.project, ".codex", "config.toml"),
      '[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs-mcp"]\n',
    );

    const status = await sandbox.plugins.saveSelection({
      scope: { kind: "project", projectRoot: sandbox.project },
      enabled: ["claude-code:deploy@team", "repository:claude-code", "repository:codex"],
      disabled: [],
    });

    expect(projectOf(status).plugins.map((entry) => entry.state)).toEqual(["on", "on", "on"]);
    const target = projectImportDirectory(
      resolveAgentPluginsLayout(sandbox.paseoHome),
      sandbox.project,
    );
    expect(await exists(path.join(target, "commands", "deploy.md"))).toBe(true);
    expect(await exists(path.join(target, "commands", "release.md"))).toBe(true);
    expect(await readJson(path.join(target, "opencode.jsonc"))).toEqual({
      mcp: {
        servers: {
          pg: { type: "local", command: ["npx", "@pg/mcp"] },
          docs: { type: "local", command: ["npx", "docs-mcp"] },
        },
      },
    });
    const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: sandbox.project,
      encoding: "utf8",
    });
    expect(untracked.split("\n").filter(Boolean).toSorted()).toEqual([
      "?? .claude/commands/release.md",
      "?? .codex/config.toml",
      "?? .mcp.json",
    ]);
  });

  it("resolves a battle slot inside the checkout to the checkout's project", async () => {
    const slot = path.join(
      sandbox.project,
      ".agent-duel",
      "worktrees",
      "0123456789abcdef",
      "generation-1-a",
    );
    await fs.mkdir(slot, { recursive: true });

    const status = await sandbox.plugins.getStatus(slot);

    expect(projectOf(status).projectRoot).toBe(sandbox.project);
  });
});
