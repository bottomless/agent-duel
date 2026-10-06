# Development

## Prerequisites

These requirements are for contributors running the stack from source. A packaged desktop user
does not install Bun or provide an OpenRouter key.

- Node.js 22 with npm
- Bun 1.3.14 for `arena-backend`
- An OpenRouter API key for battles

Install both package graphs after cloning:

```bash
npm install
cd arena-backend && bun install
```

## Running the dev server

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
```

Root checkout dev is intentionally split across terminals:

- `npm run dev:server` runs the daemon on `127.0.0.1:6768`.
- `npm run dev:app` runs Expo on `http://localhost:8081` and connects to the dev daemon.
- `npm run dev:desktop` runs its own Electron-flavored Expo server on the first free port from `8082` through `8089`. It never claims port `8081`.

Desktop dev launches its desktop-managed daemon with `PASEO_NODE_ENV=development`,
so development-only providers such as Mock Load Test are available. Packaged
desktop launches always force the daemon to production mode.

`npm run dev:desktop` is the complete local desktop startup path. It builds the server, CLI, and
Electron main process, then starts the daemon, Metro, and Electron. It assigns free daemon, Metro,
and debugger ports and prints `healthy` only after the daemon identity and both app listeners
respond. A port occupied by another worktree is skipped rather than reused or stopped.

This repository has no control plane, so `npm run dev:desktop` runs as a source build: no sign-in,
and battles on your own OpenRouter key, which you paste in Settings. `npm run dev:desktop -- --byok`
does the same explicitly.

To develop against an external control plane, set `PASEO_CONTROL_PLANE_URL` to its loopback URL and
`PASEO_SESSION_PUBLIC_KEY` to its public key before starting the launcher, which then waits for
`$PASEO_CONTROL_PLANE_URL/api/health`. For a local session without interactive sign-in, pass
`--dev-login` and set `PASEO_DEV_LOGIN_COMMAND` to a shell command that prints the session JSON. A
daemon keeps the mode it started in, so run `npm run cli -- daemon stop` when you switch modes.

### Desktop dev runtime

Canonical Arena history stays in the checkout's local `$PASEO_HOME/arena` directory.

On macOS, desktop dev uses an `Agent Duel Dev.app` copy of Electron under
`~/Library/Application Support/Agent Duel/Development`, with the Agent Duel icon
and a separate notification identity. Keep this runtime outside temporary
worktrees: macOS excludes temporary app bundles from notification sender lookup.
Allow notifications from the app’s Notifications settings; an existing denial
must be changed in macOS Settings for **Agent Duel Dev**. The Electron permission
does not carry over. The launcher reuses this local, ad-hoc-signed
copy until Electron, the icon, or the preparation script changes. Metro still
serves the renderer with hot reload, and each checkout keeps its existing user data.

The macOS notification permission bridge runs inside Electron’s main process so
Apple reads the running app’s bundle identity. Keep permission checks and delivery
on UserNotifications: Electron 41 delivers through the legacy NSUserNotification
API, which macOS rejects once the app connects through UserNotifications. A helper executable would read its
own authorization. `build:main` requires Xcode Command Line Tools and builds a
universal Node-API module; packaging leaves it outside the asar for loading and
signing. Rebuild and relaunch Electron after changing this bridge.

The dev scripts automatically set `PASEO_ARENA_BACKEND_ROOT` to the bundled
`arena-backend` directory. Set it explicitly only when testing a different
backend checkout.

The web and desktop dev launchers pass the current Git branch to Metro as
`EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL`. The expanded desktop sidebar shows it in
the titlebar row. Production builds leave the variable unset and show no label.

`npm run dev` is only a shorthand for `npm run dev:server`. Keep `127.0.0.1:6767` for the packaged app and production-style `~/.paseo` state.

## Nix desktop package

The flake exposes `packages.<system>.desktop` on Linux and macOS:

```bash
nix build .#desktop
```

Linux produces the `paseo-desktop` launcher and desktop entry. macOS produces
`Applications/Paseo.app` plus the `paseo-desktop` launcher. Both use the nixpkgs
Electron runtime and the checkout's built daemon, client, and renderer rather
than downloading a published desktop release.

### PASEO_HOME

`PASEO_HOME` is the directory that holds runtime state (agents, workspace config, sockets, daemon log, and local Arena SQLite/artifacts). Worktrees live inside their project, under `.agent-duel/worktrees`, not here. Resolution rules:

- The **server itself** (e.g. when launched by the desktop app or `npm run start`) defaults to `~/.paseo` (see `packages/server/src/server/paseo-home.ts`).
- **Repo dev scripts** default to `$ROOT/.dev/paseo-home`, where `$ROOT` is the current checkout or worktree root. This keeps all dev state scoped to the checkout instead of the packaged desktop app.
- **`npm run cli -- ...`** runs through the same dev-home wrapper as the dev scripts, so the in-repo CLI automatically targets the current checkout's `.dev/paseo-home` and configured dev daemon endpoint.
- **Paseo-created worktrees** seed `$PASEO_WORKTREE_PATH/.dev/paseo-home` from `$PASEO_SOURCE_CHECKOUT_PATH/.dev/paseo-home` by copying durable JSON metadata. Runtime files like pid files, sockets, and logs are not copied.

Override knobs:

```bash
PASEO_HOME=~/.paseo-blue npm run dev          # explicit home
PASEO_DEV_SEED_HOME=/path/to/home npm run dev # seed from a different source home
PASEO_DEV_RESET_HOME=1 npm run dev            # clear and reseed the derived worktree home
```

### Daemon endpoints

- Stable daemon launched by the desktop app: `localhost:6767`.
- Root checkout dev daemon: `localhost:6768`.
- Root checkout Expo: `http://localhost:8081`.
- Root checkout desktop dev Expo: first free port from `8082` through `8089`.
- `npm run dev` (Windows): `localhost:6767` for the daemon.

In Paseo-managed worktree services, use the injected service environment rather than hardcoded root checkout ports.

### Expo Router

Route ownership, startup restore, and native blank-screen gotchas live in
[expo-router.md](expo-router.md). Read it before changing `packages/app/src/app`,
startup routing, remembered workspace restore, or active workspace selection.

### Desktop renderer profiling

`npm run dev:desktop` starts Electron with Chromium remote debugging enabled so
renderer CPU profiles can be captured through CDP. By default it passes
`--remote-debugging-port=0`, so Chromium atomically asks the OS for an available
port and prints the selected DevTools endpoint. Set
`PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` when a QA workflow requires a validated,
fixed port.

Desktop dev also scopes Electron `userData` to the current dev root. This prevents
desktop-only environment inherited by terminals opened inside Paseo from coupling
a new worktree instance to the parent desktop instance's profile or single-instance
lock.

The desktop workspace script `exec`s the dev runner so the terminal owns the runner
PID. Terminal shutdown reaches the runner as `SIGHUP`; the runner stops Metro and
asks Electron to quit through its normal app lifecycle. Do not add an npm wrapper or
detach Electron: either change leaves an orphan holding the worktree's single-instance
lock and broken output pipes.

With desktop dev running, verify the real BrowserWindow, titlebar clearance, fullscreen
transition, and 751-pixel settings split with:

```bash
npm run verify:electron-cdp --workspace=@getpaseo/desktop
```

The verifier reads the same `EXPO_PORT` and
`PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` environment names as desktop dev. Set an
explicit remote-debugging port for verifier runs, and set both when testing an
isolated instance on non-default ports.

When running a dedicated Electron QA instance against a non-default Expo port, set
`EXPO_DEV_URL` explicitly. Desktop main defaults to `http://localhost:8081`, so
`PASEO_PORT=57928` alone starts Metro on 57928 but Electron still loads 8081.

### React render profiling

The app has a gated React render profiler in
`packages/app/src/utils/render-profiler.tsx`. Wrap the component boundary you want
to measure with `RenderProfile`, then open the app with `?renderProfile=1`. When
the query param is absent, `RenderProfile` returns children directly and records
nothing.

Captured samples are exposed on `globalThis.__PASEO_RENDER_PROFILE__`. Call
`globalThis.__PASEO_RESET_RENDER_PROFILE__?.()` after warm-up and before the
interaction you want to measure. If a memo comparator or subscription boundary
needs explanation, call `recordRenderProfileReasons(id, reasons)` while profiling;
reason counts are exposed on `globalThis.__PASEO_RENDER_PROFILE_REASONS__`.

Use this workflow for any render investigation:

1. Add stable `RenderProfile` boundaries around the suspected root and expensive
   children. Keep IDs specific enough to compare before and after.
2. Reproduce against real app state, not toy fixtures, whenever practical.
3. Record an idle baseline first. If idle is noisy, fix or account for that
   before optimizing the interaction.
4. Warm up the route, reset profiler samples, run the exact interaction, then
   compare `actualDuration`, render counts, and per-commit samples.
5. When a memo boundary still renders, record reasons before changing code. Do
   not guess from object identity alone.
6. Keep changes that move the measured profile. Remove probes or memo wrappers
   that do not move the number.

What this caught during the workspace tab investigation:

- A large apparent workspace cost was real interaction work, not daemon noise;
  the idle baseline stayed near zero.
- The expensive stream rerender was mostly prop identity churn from pane context
  callbacks and capability objects, not new stream data.
- Stabilizing provider actions at the pane boundary helped because every mounted
  panel consumes that context.
- Comparing value-shaped capability flags beat preserving object identity through
  unrelated stores.
- Some plausible fixes did not pay off: memoizing the tab row and composer draft
  object barely moved the profile, so they were removed.

Existing scenario script: workspace agent/terminal tab switching. Start Expo on
web, keep a daemon available, then run:

```bash
PASEO_PROFILE_SERVER_ID=<server-id> \
PASEO_PROFILE_WORKSPACE_ID=<workspace-path> \
PASEO_PROFILE_AGENT_ID=<agent-id> \
  npm run profile:workspace-tabs --workspace=@getpaseo/app
```

This script opens the app with `?renderProfile=1`, creates a temporary terminal
tab, switches between a real agent and that terminal, prints aggregated React
Profiler timings, then removes the temporary terminal. It is an example of the
workflow above, not the only way to use the profiler. Useful knobs:

```bash
PASEO_PROFILE_APP_URL=http://localhost:19010 # Expo web URL
PASEO_PROFILE_SWITCH_COUNT=1                # number of agent/terminal switch pairs
PASEO_PROFILE_SWITCH_WAIT_MS=250            # delay after each click
PASEO_PROFILE_IDLE_WAIT_MS=3000             # idle baseline before switching
PASEO_PROFILE_DUMP_COMMITS=1                # include per-commit profiler samples
```

### Desktop macOS compositor watchdog

macOS display sleep can leave Chromium's GPU-process display link — the vsync
source that drives frame production — stuck on a stale display. The compositor
then stops producing frames and the window looks frozen: unresponsive to clicks
and keys even though the renderer and every process stay alive. It self-recovers
after a few minutes, which is too long for a foreground app.

`setupDarwinCompositorWatchdog`
(`packages/desktop/src/window/compositor-watchdog/index.ts`) guards against
this. It polls the renderer for frame production every couple of seconds and,
after a sustained stall while the window is visible and unlocked, restarts the
GPU process so Chromium rebuilds the display link. The probe is skipped while
the screen is locked or the window is hidden or minimized, since a window
legitimately stops producing frames then.

The watchdog deliberately leaves background throttling **enabled**. Calling
`webContents.setBackgroundThrottling(false)` would keep the compositor producing
frames non-stop, pinning ProMotion displays at 120Hz forever and draining the
battery while the app is idle — so do not re-add it. The probe's visibility
guards already prevent throttling from causing a false stall.

### Daemon logs

Check `$PASEO_HOME/daemon.log` for daemon logs. The default level is `info`; set
`PASEO_LOG_LEVEL=trace` before launching the daemon when you need full provider,
session, and agent-manager traces for stuck-state debugging.

The supervisor rotates `daemon.log`. Persisted `log.file.rotate` settings in
`$PASEO_HOME/config.json` win first. Without persisted config, the optional
`PASEO_LOG_ROTATE_SIZE` and `PASEO_LOG_ROTATE_COUNT` env vars override the
defaults. The default rotation is `10m` x `3` files everywhere.

### Git process pressure

If Git refreshes consume too much CPU, disk, or antivirus capacity, especially on Windows, reduce
the daemon-global Git process limits in `$PASEO_HOME/config.json`:

```json
{
  "daemon": {
    "git": {
      "maxProcessesPerSecond": 5,
      "maxProcessConcurrency": 4
    }
  }
}
```

Restart the daemon with `paseo daemon restart`. If Paseo Desktop manages the daemon, fully quit and
reopen the desktop app. Lower values reduce machine pressure but make Git-backed workspace state and
Git RPCs wait longer. See [Git process limits](data-model.md#git-process-limits) for defaults,
semantics, and environment-variable overrides.

### Agent Tool Catalog Measurement

Measure the MCP `tools/list` payload that Paseo injects into agents with:

```bash
npm run measure:agent-tools --workspace=@getpaseo/server
```

The command reports compact JSON bytes, estimated tokens, field totals, largest
tools, and the browser-tools delta. It defaults to the agent-scoped catalog; use
`-- --scope=top-level` for the unaffiliated `/mcp/agents` shape and `-- --json`
for machine-readable output.

## Worktree starting refs

A new worktree starts from the current branch's upstream, or the local branch when it has no
upstream. This keeps unpushed local commits out of new workspaces by default. The picker collapses
identical refs; divergent local or non-origin refs remain explicit, qualified choices.

The daemon sends the exact upstream ref because the remote and branch names cannot be inferred.
Worktrees retain that ref for comparisons and updates from base while exposing its branch name to
the UI. Merging into base requires a mutable local target: `origin/main` maps to local `main`, while
another remote fails closed until the worktree records an explicit local target. Older daemons omit
the optional field and retain the previous local-first behavior; older worktree metadata without the
exact ref also resolves through its stored branch name.

Worktrees inherit committed Git state. Paseo copies the source checkout's `paseo.json` over the
worktree copy so saved Project Settings apply without a commit. Other uncommitted source-checkout
changes are not copied.

## Arena checkout lifecycle

Arena chats use the canonical session's existing Git checkout. Chat creation
does not create or move into a hidden canonical worktree. At each normal-turn
and battle boundary Arena re-reads that fixed checkout's `HEAD`, branch or
detached state, and index tree. A branch switch inside the checkout is valid;
moving the chat to another checkout is not automatic. Removing that checkout
blocks new turns. A different repository created at the same path stays
blocked. Restore the checkout with the recorded repository lineage and resolve
the chat again to return it to ready state.

Each battle captures tracked and nonignored working-tree content through a
temporary Git index, writes a permanent base ref below `refs/battles/`, and
clones the checkout's ignored content into each contestant. Everything git
ignores is carried except `.agent-duel` and ignored roots containing another
registered Git worktree. A nested checkout is independent source state and its
`.git` link points outside the copied tree. Other ignored roots are cloned
copy-on-write rather than copied file by file: on APFS each root is cloned one
child at a time (`@scope` directories one level deeper) with `clonefile`, and on
Btrfs or XFS it is one reflink copy, so seeding a contestant takes seconds
however many files it holds. A single whole-tree `clonefile` would block every
`rename` on the volume until it returned, and Git commits its config, index
and refs by rename. The children are cloned into `.agent-duel/worktrees/.staging`
and the finished root moves into the contestant in one rename; built in place,
each child would reach the contestant's file watch as a write. Where the filesystem cannot clone, the trees are copied
and the byte limits apply: 64 MiB per top-level file and 512 MiB in aggregate
by default. Set project exclusions or lower limits in `paseo.json`; zero selects
the daemon default:

```json
{
  "worktree": {
    "arenaCopy": {
      "ignoredFileMaxBytes": 0,
      "ignoredTotalMaxBytes": 0,
      "exclude": ["tmp/**"]
    }
  }
}
```

Arena reuses generation-scoped contestant environments across turns. Do not delete
`refs/battles/` or the isolated Arena repositories while a chat is active. Voting installs the
winner's exact commits and remaining Git state in the canonical checkout. A newly created current
branch is created and checked out there as well. The vote response returns once the choice is durable; transcript retention,
application, and environment preparation continue while the chat remains active. The selected
worktree remains live through the next-send boundary. The next pair is warmed
in generation-scoped paths and reused untouched when the canonical files have
not changed, including across a transcript-only single-agent turn. A changed
tracked or ignored source refreshes both paths from one snapshot. Warm recovery
checks the registered path, branch, Git tree, and post-setup fingerprint of
copied manifest content. A mismatch removes both warm paths and falls back to
cold preparation.

Contestant shells receive the current context dynamically:

| Variable                                                        | Value                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `PASEO_CURRENT_BRANCH`                                          | Persistent branch attached to this contestant.           |
| `PASEO_TRUNK_DIR`                                               | Canonical checkout path. Contestants must not modify it. |
| `PASEO_TRUNK_BRANCH`                                            | Canonical branch, or an empty string at detached `HEAD`. |
| `PASEO_PORT`, `PASEO_PORT2`, `PASEO_PORT3`                      | Three aliases reserved for this contestant environment.  |
| `ARENA_PREVIEW_URL`, `ARENA_PREVIEW_URL2`, `ARENA_PREVIEW_URL3` | Public URL matching each port alias.                     |

Use `$(pwd)` and these variables in prompts, setup, and diagnostics. Port
numbers and aliases expire with the environment. Arena records commands from a
retained winner at the next send, stops their owned process groups, and does
not replay them in the new worktrees. Bind browser-facing services to
`HOST=127.0.0.1`, use `PORT`/`PASEO_PORT` for the primary listener or the
additional aliases for peers, and report `ARENA_PREVIEW_URL` instead of the
private bind address. Report `ARENA_PREVIEW_URL2` or `ARENA_PREVIEW_URL3` for a
service bound to the matching additional alias.

## paseo.json

Agent Duel does not honour `worktree.setup`, `worktree.teardown`, `worktree.terminals` or `scripts`.
A file that carries them parses fine and is preserved on save, but nothing reads them: every project
gets the environment a project with no `paseo.json` has always got. Two keys are still read —
`worktree.arenaCopy` (which untracked files a contestant worktree receives) and `metadataGeneration`
(the prompts behind generated branch names, commit messages, and PR text, edited in Project
Settings).

The scripts and services runtime beneath those removed keys — the projection, the proxy, the port
allocator, the health monitor, the CLI's `paseo scripts`, and the MCP script tools — is still wired
up but has no configuration source, so it always reports an empty list.

## Bundled daemon web UI

> This is an inherited Paseo capability, not an Agent Duel product or deployment
> target. Keep it working when shared daemon code changes, but do not enable or
> publish it for an Agent Duel release.
>
> The user-facing guide for this feature (enabling it, reverse proxy, TLS, tunnels, security) lives at [web UI](web-ui.md). This section is the contributor/build reference: how the artifact is produced, bundled, and excluded from desktop packaging.

The daemon can optionally serve the browser web client from the same HTTP server. This is disabled by default.

Enable it for a running daemon with:

```bash
paseo daemon start --web-ui
```

Or set the environment variable:

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon start
```

Or persist it in `config.json`:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

When enabled, opening the daemon HTTP origin (for example `http://localhost:6767/`) serves the web app. The same HTTP server continues to serve `/api/*`, `/mcp/*`, `/public/*`, the WebSocket upgrade, and service-proxy routes. Static files load without daemon bearer auth; API and WebSocket calls still enforce auth.

The served app auto-bootstraps a connection to the same origin, so opening `http://localhost:6767/` directly usually skips the Add Host step.

Build the artifact for packaging or measurement with:

```bash
npm run build:daemon-web-ui
```

This exports the normal browser web app (not the Electron-flavored desktop renderer) and copies it into `packages/server/dist/server/web-ui`, precompressing `.html`, `.js`, `.css`, and JSON assets as `.br` and `.gz`.

Measured bundle size for a standard Expo web export:

- raw: 10.77 MiB
- gzip: 2.55 MiB
- brotli: 1.93 MiB

The desktop-managed daemon disables the bundled web UI by default (`PASEO_WEB_UI_ENABLED=false`) because the desktop app already ships the renderer as `app-dist`. Shipping the same assets again inside `@getpaseo/server` would duplicate the ~10.8 MiB install. Desktop packaging also excludes `node_modules/@getpaseo/server/dist/server/web-ui/**` from the packaged app.

## Built workspace packages

Package imports resolve through package exports to compiled `dist/` output, not sibling `src/` files. This is true in local dev and in published packages: the app, daemon, CLI, and SDK consumers should all exercise the same runtime paths.

`npm run dev:server` builds the server-side workspace packages once, then keeps `@getpaseo/protocol` and `@getpaseo/client` fresh with TypeScript watch builds while the daemon runs. If you change protocol schemas or client code outside that watch workflow, rebuild the producer before trusting runtime behavior.

Use the named root build targets instead of remembering workspace dependency chains:

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
npm run build:app-deps     # highlight -> protocol -> client -> expo-two-way-audio
```

Use `npm run build:server` whenever you have changed any daemon/server-facing package and need clean cross-package types or runtime behavior.

The app Metro config disables Watchman and uses Metro's node crawler for exports. Keep that invariant unless you have verified production app exports on machines with and without Watchman installed; distro Watchman builds can differ in capabilities and change Metro's crawl behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/protocol/src/*` or `packages/client/src/*`: `npm run build:client`.
- Changed `packages/server/src/*`, `packages/cli/src/*`, `packages/relay/src/*`, or `packages/highlight/src/*`: `npm run build:server`.
- Changed app build dependencies: `npm run build:app-deps`.

## ACP provider catalog versions

The in-app ACP provider catalog pins package-runner entries (`npx`, `npm exec`,
and `uvx`) to exact package versions. Run the drift checker regularly — and
before releases — so catalog installs do not sit on stale agent versions:

```bash
npm run acp:version-drift        # report stale/non-exact package pins
npm run acp:version-drift:check  # same, exits non-zero on drift
npm run acp:version-drift:update # rewrite catalog pins to latest exact versions
```

The checker updates only package-runner catalog entries. Providers that use a
preinstalled binary such as `opencode acp`, `cursor-agent acp`, or `goose acp`
are reported as skipped because their versions are owned by the user's local
install.

## CLI reference

Use `npm run cli` to run the in-repo CLI from source (`npx tsx packages/cli/src/index.ts`). The script wraps the CLI with `scripts/dev-home.sh`, so it automatically uses this checkout's `.dev/paseo-home` and dev daemon endpoint unless you pass an explicit override. The globally installed `paseo` binary on macOS is a symlink into the installed Paseo desktop app, not this checkout — use it to drive the desktop's built-in daemon, but use `npm run cli` when you want to talk to the CLI you are editing.

Canonical automation uses `paseo workspace create/ls/rename/archive`. Detach remains an explicit user lifecycle action rather than an agent tool. `paseo run --new-workspace local|worktree` composes workspace creation with agent creation. The old `paseo worktree` and `paseo run --worktree` forms are hidden compatibility aliases.

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- agent open <id>       # Focus an existing agent in Paseo Desktop
npm run cli -- daemon status         # Check daemon status
npm run cli -- clone owner/repo --dir ~/workspace # Clone GitHub repo and register project
```

Use `--host <host:port>` to point the CLI at a different daemon:

```bash
npm run cli -- --host localhost:7777 ls -a
```

Desktop integrations can focus an existing agent without creating one or
sending a message. Use `paseo://h/<server-id>/agent/<agent-id>`, or run
`paseo agent open <agent-id>`. The CLI reads the local daemon's server ID by
default; pass `--server <server-id>` when targeting another server.

## Agent state

Agent data lives at:

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Find an agent by ID:

```bash
find $PASEO_HOME/agents -name "{agent-id}.json"
```

Find by content:

```bash
rg -l "some title text" $PASEO_HOME/agents/
```

## Provider session files

Get the session ID from the agent JSON (`persistence.sessionId`), then:

**Claude:**

```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex:**

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## Testing with Playwright MCP

Point Playwright MCP at the running Expo web target. For root checkout dev, `npm run dev:app` reserves `http://localhost:8081`. For Paseo-managed worktree app services, use the service URL or port shown by Paseo for that worktree.

Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL — the app uses client-side routing and browser history breaks state.

## Browser development surface

`packages/app` can export and run as a browser application for local development,
Playwright, and Chrome-based QA. It is not a product deployment target. There is
no browser deployment command; do not publish `packages/app/dist` for Agent Duel
releases.

## Expo troubleshooting

```bash
npx expo-doctor
```

Diagnoses version mismatches and native module issues.

## Typecheck

Always run typecheck after changes:

```bash
npm run typecheck
```
