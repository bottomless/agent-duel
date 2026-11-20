# Imported agent plugins

Agent Duel loads the plugins a user installed in Claude Code and Codex into the battle engine. The
daemon finds them, converts them with [rulesync](https://github.com/dyoshikawa/rulesync), and writes
OpenCode config folders the engine reads. Code: `packages/server/src/server/agent-plugins/`,
`packages/app/src/agent-plugins/`, and `importedProjectDirectory` in
`arena-backend/packages/core/src/config/discovery.ts`.

## What gets imported

| Source                                      | Where it is found                                                                        | Scope        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| Claude Code plugin, `user` scope            | `~/.claude/plugins/installed_plugins.json`, enabled unless `enabledPlugins` says `false` | Global       |
| Claude Code plugin, `project`/`local` scope | Same file, with a `projectPath`                                                          | That project |
| Codex plugin                                | `~/.codex/plugins/cache/<marketplace>/<plugin>/<newest version>`                         | Global       |
| The repository's own setup                  | `.claude/commands`, `.claude/agents`, `.mcp.json`, `.codex/config.toml`, `.codex/agents` | That project |

Skills, commands, agents and MCP servers convert. Hooks do not: each battle contestant would run
them. Skills in `.claude/skills` and `.agents/skills` are left out because the engine reads them
itself. A Codex plugin whose `.app.json` requires a ChatGPT app is left out of every list: its
skills drive the app's tools, which run only through OpenAI's backend, so the user has nothing to
decide.

## Decisions

Global plugins wait for one review (the sidebar callout); after it, new global plugins import on
their own and the app shows a toast; Settings → Plugins switches them later. Project plugins wait
for a decision in that project (the line below the composer), and the project's settings page
switches them later. Every undecided plugin starts checked. Decisions live in
`$PASEO_HOME/agent-plugins/state.json`, never in the user's repository or OpenCode config.

## Where the engine finds them

The daemon passes `AGENT_DUEL_IMPORTED_CONFIG` (`$PASEO_HOME/agent-plugins/opencode`) to the
engine. It holds `global/` and `projects/<key>/`, where the key is the first 32 hex characters of
the SHA-256 of the project's resolved root. The engine hashes every resolved ancestor of a
session's directory, so a battle slot under `<checkout>/.agent-duel/` finds its checkout's folder
and both contestants load the same set. Keep the daemon's `projectKey` and the engine's
`importedProjectDirectory` identical.

Imports rank below the user's own config at each level. The engine watches the folders, so a
finished import loads without a restart. The builder replaces the files inside a folder, never the
folder itself, because the engine's watch is on the folder.

## rulesync gotchas

- Run the CLI in a child process. Its library API reads `process.cwd()`.
- Project-mode `import` of `claudecode` and `codexcli` writes its MCP file into
  `<output-root>/.rulesync/`, so with the repository as output root it writes into the repository.
  The builder copies the needed files into a staging folder and imports from there.
- One unparsable file fails the whole run. Claude Code reads agent frontmatter leniently, and
  official plugins ship descriptions strict YAML rejects. Import one feature per run, so a bad
  agent costs that plugin's agents and nothing else.
- Under `NODE_ENV=test` rulesync prints nothing, including the reason it failed. The runner clears
  it for the child.
- `${CLAUDE_PLUGIN_ROOT}/x` becomes `./x` on import, which is right for repackaging a plugin and
  wrong for running it. The builder anchors those paths at the install folder.
- rulesync pins its own zod. The root `overrides` keep the workspace on zod 4.4.3, because 4.6
  breaks the protocol's message type inference, and give rulesync its own copy.
- Bump `IMPORT_FORMAT` in `import/build.ts` whenever a build's output changes, or existing imports
  stay as the old daemon wrote them.
