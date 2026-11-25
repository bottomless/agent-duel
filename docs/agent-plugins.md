# Imported agent plugins

Agent Duel loads the plugins a user installed in Claude Code and Codex into the battle engine. The
daemon finds them, converts them with [rulesync](https://github.com/dyoshikawa/rulesync), and writes
OpenCode config folders the engine reads. The same lists switch the instruction files the engine
reads in place (see [Instruction files](#instruction-files)). Code: `packages/server/src/server/agent-plugins/`,
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
them.

Each contestant starts its own copy of every imported MCP server and calls it on its own, so a
server with side effects (posting to Slack, writing to a database) acts once per side, and the vote
does not undo the losing side's calls. The builder adds an `ask` permission rule for each imported
server (`<server>_*`), so Ask before tools asks before every call, as Claude Code does. Without it,
Ask before tools asks only for work outside the project. Auto Accept runs them, and a rule in the
user's own config ranks above the import. Skills in `.claude/skills` and `.agents/skills` are left out because the engine reads them
itself. A Codex plugin whose `.app.json` requires a ChatGPT app is left out of every list: its
skills drive the app's tools, which run only through OpenAI's backend, so the user has nothing to
decide.

## Instruction files

Two more entries switch files the engine reads in place rather than imports, so a battle carries
the user's own setup only when they chose it:

| Entry                                                    | Files                                                                                                                    | Default |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| This project's instructions (`instructions:project`)     | The project's `AGENTS.md`, or its `CLAUDE.md` where it has none                                                          | On      |
| Your own instructions and skills (`instructions:global`) | `~/.config/opencode/AGENTS.md`, or `~/.claude/CLAUDE.md` without it; skills in `~/.claude/skills` and `~/.agents/skills` | Off     |

The project entry is pending like a project plugin, so the line below the composer asks once, and
its files keep loading until the user turns them off. The global entry is never pending: it sits
switched off in the global review and in Settings until the user turns it on, and switching it is
not the global review. Skills in a project's `.claude/skills` and `.agents/skills` have no switch.

The daemon writes each scope's switch as `agent-duel.json` (`{ "instructions": boolean }`) into the
imported folder, also when it holds no plugins; `config/imported-setup.ts` in the engine's core
reads it, and the instruction and skill discovery follow it without a restart. A missing file means
the defaults above. Without `AGENT_DUEL_IMPORTED_CONFIG`, upstream discovery applies, except that
`CLAUDE.md` never loads (`routeOptions` in `arena-backend/packages/opencode/src/server/server.ts`).

Each side's run records what its prompt loaded (`loadedSetup`, `arena/loaded-setup.ts`): the
instruction files by scope and project- or `~/`-relative path with a hash of their text, and the
skill names by scope. It carries no file text or absolute path, since runs mirror to research.

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
