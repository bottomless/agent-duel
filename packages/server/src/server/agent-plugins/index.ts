import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentPlugin,
  AgentPluginScope,
  AgentPluginState,
  AgentPluginsGlobalStatus,
  AgentPluginsProjectStatus,
  AgentPluginsStatus,
} from "@getpaseo/protocol/messages";

import type { RunGitCommand } from "../../utils/run-git-command.js";
import { detectClaudePlugins, type ClaudePlugin } from "./detect/claude.js";
import { detectCodexPlugins } from "./detect/codex.js";
import { realpathOrNull } from "./detect/files.js";
import {
  detectGlobalInstructions,
  detectProjectInstructions,
  INSTRUCTIONS_IDS,
  type DetectedInstructions,
} from "./detect/instructions.js";
import { detectRepositorySetup, listNativeSkills } from "./detect/repository.js";
import { buildImport, IMPORT_FORMAT, type BuildErrors, type ImportSetup } from "./import/build.js";
import {
  projectImportDirectory,
  projectKey,
  resolveAgentPluginsLayout,
  type AgentPluginsLayout,
} from "./layout.js";
import type { DetectedPlugin } from "./plugin.js";
import { readState, updateIds, writeState, type AgentPluginsState } from "./state.js";

export interface AgentPluginsSelection {
  scope: AgentPluginScope;
  enabled: readonly string[];
  disabled: readonly string[];
}

/**
 * The user's Claude Code and Codex plugins, imported into the engine through rulesync. Global
 * plugins are decided once and new ones import on their own afterwards; a project's plugins wait
 * for a decision in that project.
 */
export interface AgentPlugins {
  getStatus(cwd: string | null): Promise<AgentPluginsStatus>;
  saveSelection(selection: AgentPluginsSelection): Promise<AgentPluginsStatus>;
  acknowledgeAdded(ids: readonly string[]): Promise<AgentPluginsStatus>;
  /** Prepares the folders the engine watches and imports global plugins added since last run. */
  start(): Promise<void>;
}

/** A project decision named a directory that no longer exists. */
export class AgentPluginsProjectNotFoundError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(`Project not found: ${projectRoot}`);
    this.name = "AgentPluginsProjectNotFoundError";
    this.projectRoot = projectRoot;
  }
}

interface Detected {
  claude: ClaudePlugin[];
  global: DetectedPlugin[];
  instructions: DetectedInstructions | null;
}

function toWire(plugin: DetectedPlugin, state: AgentPluginState, errors: BuildErrors): AgentPlugin {
  return {
    id: plugin.id,
    name: plugin.name,
    source: plugin.source,
    kind: plugin.kind,
    description: plugin.description,
    version: plugin.version,
    contents: plugin.contents,
    state,
    importError: errors[plugin.id] ?? null,
    files: [],
  };
}

/**
 * Instruction files are read in place, so the entry names its files instead of a plugin. `source`
 * says whose convention the files follow: CLAUDE.md is Claude Code's, AGENTS.md is shared.
 */
function instructionsToWire(entry: DetectedInstructions, state: AgentPluginState): AgentPlugin {
  return {
    id: entry.id,
    name: entry.files.join(", "),
    source: entry.files.some((file) => file.endsWith("CLAUDE.md")) ? "claude-code" : "codex",
    kind: "instructions",
    description: null,
    version: null,
    contents: { skills: entry.skills, commands: 0, agents: 0, mcpServers: [] },
    state,
    importError: null,
    files: entry.files,
  };
}

function fingerprint(plugins: readonly DetectedPlugin[], setup: ImportSetup): string {
  const signatures = plugins.map((plugin) => [plugin.id, plugin.signature]);
  return createHash("sha256")
    .update(JSON.stringify([IMPORT_FORMAT, signatures, setup]))
    .digest("hex");
}

/** What a selection set `id` to, or null when it left it alone. */
function switchedTo(
  id: string,
  selection: { enabled: readonly string[]; disabled: readonly string[] },
): boolean | null {
  if (selection.enabled.includes(id)) return true;
  if (selection.disabled.includes(id)) return false;
  return null;
}

/** Instruction switches travel with the plugin decisions but never reach the plugin lists. */
function withoutInstructions(ids: readonly string[]): string[] {
  const instructions = new Set<string>(Object.values(INSTRUCTIONS_IDS));
  return ids.filter((id) => !instructions.has(id));
}

/** A project is its repository's main checkout, also when the chat runs in a battle slot inside it. */
async function resolveProjectRoot(cwd: string, runGit: RunGitCommand): Promise<string | null> {
  const resolved = await realpathOrNull(cwd);
  if (!resolved) return null;
  const slot = resolved.indexOf(`${path.sep}.agent-duel${path.sep}`);
  const directory = slot >= 0 ? resolved.slice(0, slot) : resolved;
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    { cwd: directory, acceptExitCodes: [0, 128] },
  );
  if (result.exitCode !== 0) return directory;
  const [toplevel, commonDir] = result.stdout.trim().split("\n");
  if (!toplevel || !commonDir) return directory;
  const root = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : toplevel;
  return (await realpathOrNull(root)) ?? directory;
}

export function createAgentPlugins(options: {
  paseoHome: string;
  home: string;
  /** `$XDG_CONFIG_HOME`, where the engine finds the global AGENTS.md; defaults to `~/.config`. */
  configHome?: string;
  runGit: RunGitCommand;
}): AgentPlugins {
  const configHome = options.configHome ?? path.join(options.home, ".config");
  const layout: AgentPluginsLayout = resolveAgentPluginsLayout(options.paseoHome);
  let queue: Promise<unknown> = Promise.resolve();

  // Builds and state writes share one folder and one file, so operations run one at a time.
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function detect(): Promise<Detected> {
    const claude = await detectClaudePlugins(options.home);
    const user = claude.filter((entry) => entry.scope.kind === "user").map((entry) => entry.plugin);
    return {
      claude,
      global: [...user, ...(await detectCodexPlugins(options.home))],
      instructions: await detectGlobalInstructions({ home: options.home, configHome }),
    };
  }

  async function detectProject(detected: Detected, root: string): Promise<DetectedPlugin[]> {
    const global = new Set(detected.global.map((plugin) => plugin.id));
    const scoped = detected.claude
      .filter((entry) => entry.scope.kind !== "user" && entry.scope.projectRoot === root)
      .map((entry) => entry.plugin)
      .filter((plugin) => !global.has(plugin.id));
    const unique = [...new Map(scoped.map((plugin) => [plugin.id, plugin])).values()];
    return [...unique, ...(await detectRepositorySetup(root))];
  }

  async function ensureImported(input: {
    state: AgentPluginsState;
    key: string;
    plugins: readonly DetectedPlugin[];
    target: string;
    setup: ImportSetup;
  }): Promise<BuildErrors> {
    const { state, key, plugins, target, setup } = input;
    const next = fingerprint(plugins, setup);
    const previous = state.imports[key];
    if (previous?.fingerprint === next) return previous.errors;
    const errors = await buildImport({ plugins, target, workRoot: layout.work, setup });
    state.imports[key] = { fingerprint: next, errors };
    return errors;
  }

  async function globalStatus(
    state: AgentPluginsState,
    detected: Detected,
  ): Promise<AgentPluginsGlobalStatus> {
    const { reviewed } = state.global;
    const off = new Set(state.global.off);
    const stateOf = (plugin: DetectedPlugin): AgentPluginState => {
      if (!reviewed) return "pending";
      return off.has(plugin.id) ? "off" : "on";
    };
    const active = detected.global.filter((plugin) => stateOf(plugin) === "on");
    const errors = await ensureImported({
      state,
      key: "global",
      plugins: active,
      target: layout.global,
      setup: { instructions: state.global.instructions },
    });
    const announced = new Set(state.global.announced);
    // The user's own files are off until switched on, also before the first review.
    const instructions = detected.instructions
      ? [instructionsToWire(detected.instructions, state.global.instructions ? "on" : "off")]
      : [];
    return {
      reviewed,
      plugins: [
        ...detected.global.map((plugin) => toWire(plugin, stateOf(plugin), errors)),
        ...instructions,
      ],
      added: active.filter((plugin) => !announced.has(plugin.id)).map((plugin) => plugin.id),
    };
  }

  async function projectStatus(
    state: AgentPluginsState,
    detected: Detected,
    root: string,
  ): Promise<AgentPluginsProjectStatus> {
    const plugins = await detectProject(detected, root);
    const decisions = state.projects[root] ?? { on: [], off: [] };
    const stateOf = (plugin: DetectedPlugin): AgentPluginState => {
      if (decisions.off.includes(plugin.id)) return "off";
      return decisions.on.includes(plugin.id) ? "on" : "pending";
    };
    const active = plugins.filter((plugin) => stateOf(plugin) === "on");
    const errors = await ensureImported({
      state,
      key: projectKey(root),
      plugins: active,
      target: projectImportDirectory(layout, root),
      // A project's own files load until the user turns them off, as before the switch existed.
      setup: { instructions: !decisions.off.includes(INSTRUCTIONS_IDS.project) },
    });
    const instructions = await detectProjectInstructions(root);
    const instructionsState = (): AgentPluginState => {
      const id = INSTRUCTIONS_IDS.project;
      if (decisions.off.includes(id)) return "off";
      return decisions.on.includes(id) ? "on" : "pending";
    };
    return {
      projectRoot: root,
      plugins: [
        ...plugins.map((plugin) => toWire(plugin, stateOf(plugin), errors)),
        ...(instructions ? [instructionsToWire(instructions, instructionsState())] : []),
      ],
      nativeSkills: await listNativeSkills(root),
    };
  }

  async function status(input: {
    state: AgentPluginsState;
    detected: Detected;
    projectRoot: string | null;
  }): Promise<AgentPluginsStatus> {
    const { state, detected, projectRoot } = input;
    const global = await globalStatus(state, detected);
    const project = projectRoot ? await projectStatus(state, detected, projectRoot) : null;
    await writeState(layout.state, state);
    return { global, project };
  }

  return {
    getStatus: (cwd) =>
      serialize(async () => {
        const projectRoot = cwd ? await resolveProjectRoot(cwd, options.runGit) : null;
        return status({
          state: await readState(layout.state),
          detected: await detect(),
          projectRoot,
        });
      }),

    saveSelection: ({ scope, enabled, disabled }) =>
      serialize(async () => {
        const state = await readState(layout.state);
        const detected = await detect();
        if (scope.kind === "global") {
          const { global: id } = INSTRUCTIONS_IDS;
          const instructions = switchedTo(id, { enabled, disabled });
          const pluginsEnabled = withoutInstructions(enabled);
          const pluginsDisabled = withoutInstructions(disabled);
          // The instructions switch alone is not the review of the global plugins; an empty
          // selection is, since that is how the review is dismissed.
          const decidesPlugins =
            instructions === null || pluginsEnabled.length > 0 || pluginsDisabled.length > 0;
          const seen = detected.global.map((plugin) => plugin.id);
          state.global = {
            reviewed: state.global.reviewed || decidesPlugins,
            off: updateIds(state.global.off, { add: pluginsDisabled, remove: pluginsEnabled }),
            announced: decidesPlugins
              ? updateIds(state.global.announced, { add: seen, remove: [] })
              : state.global.announced,
            instructions: instructions ?? state.global.instructions,
          };
          return status({ state, detected, projectRoot: null });
        }
        const projectRoot = await realpathOrNull(scope.projectRoot);
        if (!projectRoot) throw new AgentPluginsProjectNotFoundError(scope.projectRoot);
        const decisions = state.projects[projectRoot] ?? { on: [], off: [] };
        state.projects[projectRoot] = {
          on: updateIds(decisions.on, { add: enabled, remove: disabled }),
          off: updateIds(decisions.off, { add: disabled, remove: enabled }),
        };
        return status({ state, detected, projectRoot });
      }),

    acknowledgeAdded: (ids) =>
      serialize(async () => {
        const state = await readState(layout.state);
        state.global.announced = updateIds(state.global.announced, { add: ids, remove: [] });
        return status({ state, detected: await detect(), projectRoot: null });
      }),

    start: () =>
      serialize(async () => {
        await fs.mkdir(layout.projects, { recursive: true });
        await status({
          state: await readState(layout.state),
          detected: await detect(),
          projectRoot: null,
        });
      }),
  };
}
