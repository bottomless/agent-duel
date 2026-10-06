# Contributing to Agent Duel

Agent Duel is a desktop coding-agent battle interface forked from Paseo. The
Electron application, local daemon, and local Arena runtime are the product. The
browser renderer is a development and QA harness. The official download signs in
to a hosted control plane that is not part of this repository; the development
stack runs battles on your own OpenRouter key.

Read [docs/architecture.md](docs/architecture.md) before changing a runtime
boundary and [docs/arena.md](docs/arena.md) before changing battle behavior.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in an
issue.

## Development setup

You need macOS or Linux, Node.js 22 with npm, Bun 1.3.14, and an OpenRouter API
key. Install the npm and Bun workspaces, then start the desktop stack in
bring-your-own-key mode:

```bash
npm install
cd arena-backend && bun install && cd ..
npm run dev:desktop -- --byok
```

Wait for `[dev] healthy:`, then paste your OpenRouter key in Settings. Battles
run on that key.

See [docs/development.md](docs/development.md) for worktrees, logs, and focused
validation commands.

## Issues and product discussions

Use [GitHub Issues](https://github.com/bottomless/agent-duel/issues) for
reproducible bugs. Search for an existing report first and include the shortest
reproduction, actual behavior, expected behavior, logs, and a screenshot or
video for UI failures.

Open an issue with the Feature request form for product proposals. Describe the
workflow, how you do it now, what's missing or hard, and what a successful flow
would look like.

If an agent investigated the issue, include its raw evidence and reproduction
steps. A summary is not a substitute for logs or observable behavior.

If a bug is in code Agent Duel hasn't changed from Paseo or OpenCode, report it
upstream too. Changes here stay scoped to Agent Duel.

## Pull requests

Keep a pull request focused. Explain the user-facing problem, goals, non-goals,
and intentional tradeoffs. Link the issue or discussion that provides context.
Pull requests are squash-merged into `main`.

Fill in the pull request template. Keep "What and why" to at most 500
characters, and list every check you ran with who ran it: a person, an AI agent,
or an automated test.

Do not run the full local test suite. Follow [docs/testing.md](docs/testing.md)
for focused commands and [docs/qa.md](docs/qa.md) for evidence requirements.

CI runs format, lint and typecheck on every pull request. It does not run
behavior tests, so list the focused tests you ran.

The first product release targets macOS Electron. Browser QA still matters for
shared renderer code. Test Windows, Linux, Docker, or inherited surfaces when a
change touches their code, and report that scope explicitly.

## AI-assisted work

Pull requests written with AI agents are welcome. You are responsible for the
change as if you wrote it yourself: read it before you open the PR, and mark
which checks a person ran and which an agent ran.

## Architecture rules

- Keep repositories, agents, Git worktrees, terminals, services, the daemon,
  and the UI WebSocket local.
- Keep battles working in a BYOK build (the development stack, or
  `PASEO_BYOK_BUILD=1`), which has no sign-in and no control plane.
- Do not deploy `packages/app` as a browser product.
- Keep provider credentials, including the OpenRouter key, out of contestant
  shell environments.

## License

Contributions use the licence of the directory they change (inbound=outbound):

- `arena-backend/` is MIT. See [arena-backend/LICENSE](arena-backend/LICENSE).
- Everything else is AGPL-3.0-or-later. See [LICENSE](LICENSE).

Keep existing copyright and licence notices. [NOTICE](NOTICE) maps each
directory to its licence and upstream project.
