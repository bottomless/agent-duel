# Agent Duel server guide

Follow the repository [agent guide](../../CLAUDE.md). This package owns the local
daemon and Arena bridge; the battle engine lives in the separate Bun workspace
under `arena-backend`.

## Before changing the daemon

- Read [architecture](../../docs/architecture.md) and [Arena](../../docs/arena.md)
  for the daemon/backend boundary.
- Follow [coding standards](../../docs/coding-standards.md),
  [RPC namespacing](../../docs/rpc-namespacing.md), and
  [testing](../../docs/testing.md). Protocol changes follow the repository's
  shared-release rule; there is no separate server compatibility policy.
- Use `@server/*` for server source imports. Inspect provider adapters under
  `src/server/agent/providers/` when working on the bridge.

## Development

Run commands from the repository root. `npm run dev:desktop` starts the complete
product; `npm run dev:server` starts only the daemon. Use `npm run build:server`
to rebuild the server stack before diagnosing stale cross-package declarations.
See [development](../../docs/development.md) for commands, isolated dev state,
and daemon logs, and the [documentation index](../../docs/README.md) for inherited
subsystem references.
