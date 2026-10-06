# Agent Duel battle engine

`arena-backend` is a Bun workspace with the local battle engine: a vendored
OpenCode fork that runs blinding, worktrees, voting, and canonical history. The
desktop build compiles `packages/opencode/src/index.ts` into a standalone
executable.

The official download signs in to a hosted control plane for accounts and model
routing. That service is not part of this repository. Source builds run battles
on your own OpenRouter key.

## Install dependencies

From the enclosing repository:

```bash
npm install
cd arena-backend
bun install
cd ..
```

## Run battles from source

```bash
npm run dev:desktop -- --byok
```

Paste your OpenRouter key in Settings. The launcher starts the daemon, the
battle engine, Metro, and Electron. Canonical history stays local under
`$PASEO_HOME/arena`.

See [../docs/development.md](../docs/development.md) for ports, parallel
workspaces, and testing, and [../docs/arena.md](../docs/arena.md) for how a
battle works.

## Run the engine alone

```bash
cd arena-backend
bun --no-env-file run dev -- --hostname 127.0.0.1 --port 4098
```

This supports local history operations only. Use the desktop launcher for
battles.

## Validation

Run tests from the package that owns the change:

```bash
cd arena-backend/packages/opencode
bun run typecheck
bun test test/arena/<changed-test>.test.ts --timeout 30000
```

From the repository root, finish changes with:

```bash
npm run typecheck
npm run lint
npm run format
```

Do not run the full test suite locally. See [../docs/testing.md](../docs/testing.md)
for the repository test policy.
