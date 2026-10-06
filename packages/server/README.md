# Agent Duel local daemon

This package is the local Node.js daemon embedded in the Agent Duel desktop
application. It manages coding-agent processes and exposes the WebSocket API
used by the renderer and CLI.

The daemon owns:

- agent lifecycle and local process supervision;
- the local WebSocket connection and timeline updates;
- workspaces, terminals, files, Git operations, and MCP adapters;
- the bridge to the local Arena runtime;
- proxying sign-in operations to the remote control plane;
- offline verification of signed 30-day desktop sessions.

The daemon does not own a database or any OpenRouter, email, OAuth, or
session-signing secrets. In a packaged app it launches the bundled Arena executable and passes
only the public control-plane URL, session public key, and current account
session. Ordinary non-Arena agents remain local and can continue while the
control plane is unreachable when their own provider permits it.

Start the complete product stack from the repository root:

```bash
npm run dev:desktop
```

Start only the development daemon with:

```bash
npm run dev
```

The daemon-only command does not start Metro, Electron, or the Arena
development runtime.

Read [../../docs/architecture.md](../../docs/architecture.md) for package
boundaries, [../../docs/accounts.md](../../docs/accounts.md) for sessions, and
[../../docs/development.md](../../docs/development.md) for configuration and
logs.
