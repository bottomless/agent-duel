# @getpaseo/client

TypeScript client for the daemon used by Agent Duel, inherited from Paseo.
Build it with the repository; see [development](../../docs/development.md).
The installation and SDK examples below describe the upstream published package.

```bash
npm install @getpaseo/client
```

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

The public API is the package root. Imports under `@getpaseo/client/internal/*` are unsupported implementation details used by Paseo's own packages.

Read the [SDK documentation](https://paseo.sh/docs/sdk) for agents, workspaces, provider discovery, events, recipes, and the API reference. Runnable TypeScript patterns also live in [`examples/`](./examples/README.md).

## Runtime

The client needs a WebSocket implementation. Modern browsers and Node.js 22 provide one globally.

Use a WebSocket URL ending in `/ws`, such as `ws://127.0.0.1:6767/ws`. Pass `password` when the daemon requires authentication.

## Stability

Agent Duel ships its app, daemon, and desktop together. Follow the
[shared-release protocol policy](../../docs/rpc-namespacing.md#compatibility);
upstream SDK documentation does not establish an old-client contract for this fork.
