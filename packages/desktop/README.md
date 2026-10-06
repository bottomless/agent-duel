# Agent Duel desktop

This package owns the Electron main process, local daemon supervision, native
desktop bridges, and release packaging. It is the product shell; the first
release target is macOS.

Run the complete development stack from the repository root:

```bash
npm run dev:desktop
```

Build a production artifact only after deploying the control plane:

```bash
PASEO_CONTROL_PLANE_URL=https://<control-plane-origin> \
PASEO_SESSION_PUBLIC_KEY='<base64 SPKI public key>' \
npm run build:desktop -- --publish never --mac --arm64
```

The build packages:

- the Electron main process and local daemon;
- the exported `packages/app` renderer;
- the local CLI and shared client/protocol dependencies;
- a compiled Arena executable built from `arena-backend/packages/opencode`;
- the public control-plane URL and session-verification public key.

It does not package the control plane or any OpenRouter, database, OAuth,
email, or private signing credential.

Electron persists the signed account session with `safeStorage`; it is not kept
in renderer `AsyncStorage`. The local daemon retains the live account token and
gives the Arena runtime only a revocable capability for its allowlisted proxy.

See [../../docs/deployment.md](../../docs/deployment.md) for the release sequence
and [../../docs/development.md](../../docs/development.md) for desktop debugging.
