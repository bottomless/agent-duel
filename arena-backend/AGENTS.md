# Agent Arena backend

- The backend source preserves its OpenCode `dev` baseline, but branches and commits are managed by the enclosing Agent Arena repository.
- Run tests and type checks from package directories, never from the repository root.
- Run bun typecheck from the relevant package; do not invoke tsc directly.
- After changing the public Protocol or Server HttpApi, generate clients from a compatible client workspace rather than editing generated SDK files manually.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server.
- Keep the server headless. Do not add UI frameworks or frontend packages to this repository.

## Local Arena development

- `packages/opencode` owns local battle execution. The hosted control plane used by the official download is not in this repository.
- Use `npm run dev:desktop -- --byok` at the enclosing repository root for the complete development stack. It launches the daemon, Arena source runtime, Metro, and Electron, and runs battles on the OpenRouter key you paste in Settings.
- Start only the Arena source runtime for local history operations with `bun --no-env-file run dev -- --hostname 127.0.0.1 --port 4098` from this directory.
- Never print, copy, or commit API keys.

## Style

- Prefer const, early returns, type inference, dot notation, and functional array methods.
- Avoid any, unnecessary try/catch, import aliases, star imports, and premature single-use helpers.
- Use Bun APIs when possible.
- In Effect generators, bind services to named variables before calling methods.
