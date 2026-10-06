# Agent Duel agent guide

This repository is Agent Duel, a fork of Paseo built
around blinded coding-agent battles. Preserve Paseo's local daemon and client
architecture. Treat Electron as the product and the browser build as a local
development and QA harness only. An unspecified request to run or test the app
means the Agent Duel desktop stack, not the upstream Paseo daemon by itself.

A battle runs two blinded contestants against one prompt in isolated worktrees, and the winner you
vote for becomes the chat's history. Read [docs/arena.md](docs/arena.md) before working on any of
it — the engine lives outside the npm workspace and none of the inherited Paseo docs describe it.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, and Pi.

## Repository map

This is an npm workspace monorepo. `arena-backend` is not part of it — it is a vendored OpenCode
fork with its own Bun install.

- The hosted control plane lives in a separate private repository; this repository reaches it only over HTTP
- `arena-backend/packages/arena-service` — Battle routes shared with the control plane: assignments, OpenRouter proxy, comparison
- `arena-backend/packages/opencode` — Local battle engine: blinding, worktrees, voting, canonical git and transcripts; compiled into desktop
- `packages/app` — Electron renderer and browser QA harness (Expo); battle UI in `packages/app/src/arena`
- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server, Arena bridge
- `packages/desktop` — Electron desktop wrapper, the primary target
- `packages/protocol` / `packages/client` — Wire schemas and the client SDK
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

These are the docs this product is built on. Read the relevant one before non-trivial work.

| Doc                                                  | What's in it                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [docs/arena.md](docs/arena.md)                       | **The battle.** What it is for, settled product decisions, turn lifecycle, blinding, voting, states                             |
| [docs/accounts.md](docs/accounts.md)                 | **Sign-in.** Magic link, Google, GitHub; where accounts live, how the session travels, the ordering traps                       |
| [docs/architecture.md](docs/architecture.md)         | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                 |
| [docs/glossary.md](docs/glossary.md)                 | Authoritative terminology — UI label wins, no synonyms                                                                          |
| [docs/coding-standards.md](docs/coding-standards.md) | Type hygiene, error handling, state design, React patterns, file organization                                                   |
| [docs/design.md](docs/design.md)                     | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                  |
| [docs/side-panel.md](docs/side-panel.md)             | The workspace's main pane + side panel — which tabs go where, the two-pane layout shape, open state, what replaced the Explorer |
| [docs/forms.md](docs/forms.md)                       | Form architecture — non-React form model, form kit, load-state gating; the agent profile form is the golden example             |
| [docs/hover.md](docs/hover.md)                       | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it  |
| [docs/unistyles.md](docs/unistyles.md)               | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                        |
| [docs/floating-panels.md](docs/floating-panels.md)   | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash       |
| [docs/menus.md](docs/menus.md)                       | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                                |
| [docs/expo-router.md](docs/expo-router.md)           | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                   |
| [docs/development.md](docs/development.md)           | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                      |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)   | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                            |
| [docs/testing.md](docs/testing.md)                   | TDD workflow, determinism, real dependencies over mocks, test organization                                                      |
| [docs/qa.md](docs/qa.md)                             | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                       |
| [docs/deployment.md](docs/deployment.md)             | Production boundary, desktop packaging, and release smoke test                                                                  |

**Inherited Paseo subsystems.** Working code you rarely touch, documented by upstream and not
maintained here. Open one only when your task lands in that code; do not read them for context.

[agent-lifecycle](docs/agent-lifecycle.md), [data-model](docs/data-model.md), [file-icons](docs/file-icons.md), [providers](docs/providers.md), [forge-providers](docs/forge-providers.md), [custom-providers](docs/custom-providers.md), [service-proxy](docs/service-proxy.md), [protocol-validation](docs/protocol-validation.md), [terminal-performance](docs/terminal-performance.md), [file-observation](docs/file-observation.md), [mobile-panels](docs/mobile-panels.md), [browser-capture-harness](docs/browser-capture-harness.md), [docker](docs/docker.md), [terminal-activity](docs/terminal-activity.md), [ad-hoc-daemon-testing](docs/ad-hoc-daemon-testing.md), [i18n](docs/i18n.md), [timeline-sync](docs/timeline-sync.md), [opencode-global-event-baseline](docs/opencode-global-event-baseline.md), [SECURITY](SECURITY.md)

### Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/unistyles.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/app/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

### Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".

## Quick start

When asked to start "the development environment" without a specific surface,
start the complete Electron desktop stack. Do not interpret that request as
`npm run dev`, which starts only the daemon.

In a fresh checkout or worktree, prepare it before starting:

1. If `node_modules` is missing, run `npm install` at the repository root.
2. If `arena-backend/node_modules` is missing, run `bun install` in
   `arena-backend`.
3. Run `npm run dev:desktop` (this repository has no control plane, so it runs
   as a source build), wait for the `[dev] healthy:` line, and add an OpenRouter
   key in Settings.

```bash
npm run dev                          # Start only the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start the complete desktop dev stack
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with oxfmt
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Critical rules

- **Do not fix underlying Paseo issues in this repository.** Report shared Paseo defects upstream and keep changes here scoped to Agent Duel. Pull their fixes from upstream when this repository is updated.
- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - CI covers format, lint and typecheck only. Verify behaviour with the targeted tests plus the
    running app.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses oxfmt for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx`
- **The protocol has no old-client contract.** The app, daemon, and desktop ship together, so a
  schema change lands on both sides in one commit — no capability gates, no `COMPAT` shims, no
  deprecation windows. New RPCs still follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md):
  `domain.provider.operation.request` pairs with `domain.provider.operation.response`.

## Platform gating

The product target is Electron desktop, with macOS as the first release. The Expo
browser build remains a development and QA harness; it is not deployed as a
product. Native adapters are still in the codebase but nothing ships them: do
not add native branches, and do not write `.native.ts` files. Import the gates
from `@/constants/platform`.

- `isWeb` — DOM APIs: `document`, `window`, `<div>`, `addEventListener`, `ResizeObserver`.
- `getIsElectron()` — desktop-only bridges: file dialogs, titlebar drag region, daemon management,
  app updates, dock badges.
- `useIsCompactFormFactor()` (from `@/constants/layout`) — layout: sidebar overlay vs pinned, modal
  vs full screen, single-panel vs split. Use this for layout, never `Platform.OS`.

Default to cross-platform and gate only when you must. When a module genuinely differs per target,
prefer Metro file extensions over a large `if (isWeb)` block — desktop dev and builds resolve
`.electron.tsx` first and fall back to `.web.tsx`.

[docs/hover.md](docs/hover.md) owns the hover pattern; follow it rather than reasoning from platform
rules. Inherited components still branch on `isNative` — leave them be rather than converting them.

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log
