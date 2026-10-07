# Deployment

This repository produces one release artifact: the macOS desktop app. The hosted control plane it
signs in to is deployed from a separate private repository.

The browser renderer is a development and QA surface. Do not deploy
`packages/app/dist` as a product.

## Runtime boundary

The hosted control plane owns sign-in, model assignments and reveals, the model proxy, and research
uploads, along with their credentials.

The desktop application owns:

- Electron and the renderer;
- the local daemon and WebSocket server;
- the daemon's revocable Arena runtime proxy, which retains the account session and exposes only
  the allowlisted Arena control-plane calls to the bundled runtime;
- the compiled Arena runtime;
- coding-agent processes, repositories, worktrees, Git operations, terminals,
  and local services.
- canonical Arena history in `$PASEO_HOME/arena/arena.sqlite` and content-addressed
  artifacts in `$PASEO_HOME/arena/artifacts/sha256/`.

## Build the macOS desktop application

The build signs in to the hosted control plane, `https://agent-duel-cloud.vercel.app`, by default:

```bash
npm run build:desktop -- --publish never --mac --arm64
```

To build against another control plane, set both `PASEO_CONTROL_PLANE_URL` and
`PASEO_SESSION_PUBLIC_KEY`; the build refuses only one. The defaults live in
`packages/desktop/scripts/build-deployment-config.mjs`, and every binary keeps the URL it was built
with, so change them only together with a release.

Builds leave `PASEO_DESKTOP_UPDATES_ENABLED` unset, which disables update checks. Set it to `1` only
for an artifact you publish to the update feed configured in `packages/desktop/electron-builder.yml`.

A build without a control plane sets `PASEO_BYOK_BUILD=1` instead of the two control-plane
values. The build writes neither into the deployment configuration and the packaged daemon starts
without them, so the app has no sign-in and runs battles on the OpenRouter key saved in Settings.
The build refuses the flag together with either control-plane value or with
`PASEO_DESKTOP_UPDATES_ENABLED=1`: the release feed serves the hosted build, which would replace it.
Never publish this artifact to the release feed.

The build:

1. exports the Electron renderer;
2. builds the daemon and shared packages;
3. compiles `arena-backend/packages/opencode/src/index.ts` into a Bun executable and copies the
   `@parcel/watcher` binding beside it. The hardened runtime refuses to load the copy Bun embeds,
   because Bun extracts it to an unsigned temp file; the copy beside the executable is signed with
   the app. Without a watcher the engine re-syncs both contestants at every warm send, and it logs
   `Arena filesystem watcher unavailable` at startup;
4. writes the public deployment configuration, including the Git commit that produced the Arena
   executable;
5. packages the renderer, daemon, CLI, and Arena executable with Electron.

The build reads Arena provenance from the repository `HEAD`. In an exported source tree without
Git metadata, set `OPENCODE_ARENA_BUILD_SHA` to the source commit. Packaged Arena passes this value
to the compiled runtime because it cannot inspect a source checkout at run time.

The resulting application contains no database, OpenRouter, OAuth, email, or
private signing credential.

Build releases from a clean, committed checkout and publish that commit to
`bottomless/agent-duel`. Attach the `.dmg` from `packages/desktop/release/` to a GitHub Release
tagged at the same commit. Beside the download, include a **Source code for this build** link to
`https://github.com/bottomless/agent-duel/archive/<full-build-commit>.tar.gz`, replacing
`<full-build-commit>` with the commit used to build the app. Keep that source available for every
published binary; a link to the current `main` branch does not identify its matching source.
The archive must include the vendored `arena-backend/`, dependency lockfiles, and build scripts.
Record any non-default public build settings in the release notes so the build can be reproduced.

SQLite and artifact migrations run on the desktop because the server cannot access device-local
data. They must preserve existing history and be safe to resume after interruption.

## Production smoke test

Use a fresh macOS user-data directory or clean test machine and verify:

1. The app launches without Bun, the source repository, or local backend
   environment variables.
2. Sign-in completes and returns to Agent Duel.
3. A local Git repository can be added and opened.
4. With the control plane unavailable, the previously signed-in app still opens,
   local Arena history remains readable, and ordinary agents continue running.
   Their own providers may still require internet access.
5. An Arena action reports the research or model proxy outage without stopping
   the daemon or losing local history.
6. With the control plane restored, a signed-in Arena prompt starts both local contestants.
7. Both sides stream, finish, and show the comparison experience.
8. Before voting, inspect desktop traffic and local battle records: neither may contain a
   contestant model name, slug, or routing token. Assigned proxy calls contain the opaque assignment
   id and scope id. Voting reveals both display names and applies the selected result to the original
   local repository.
9. Inspect the Arena process environment, startup arguments, and one-time stdin value: none contains
   the raw OpenCode control token. The stdin value contains the daemon-local control-plane
   capability, loopback URL, and only a SHA-256 verifier for the OpenCode token. Confirm that
   `GET /global/health` remains public, `/doc`, `/session`, `/arena`, and `/api/*` reject unauthenticated
   requests, the daemon-authenticated battle still completes, and sign-out or Arena exit invalidates
   the runtime capability. Do not set `OPENCODE_ARENA_ENABLE_DOCS=1` in a production build.
10. Restart the application and confirm the account session survives through Electron encrypted
    storage while the legacy renderer `AsyncStorage` session key is absent.
11. Local SQLite history and artifact files survive an application restart.
12. Signing out prevents new research, assignment, comparison, and OpenRouter operations while preserving local
    history.
13. The app's `Contents/Resources/licenses/` contains `LICENSE`, `LICENSE-APACHE`, `NOTICE`, and
    `arena-backend/LICENSE`. The release's source link downloads the matching source without sign-in.

Compare the happy path with the current `main` desktop build during the first
release qualification. Follow [qa.md](qa.md) for evidence and
[testing.md](testing.md) for focused automated coverage.

## Research upload limits

Research uploads are background best effort. Each request is limited to 3 MiB and
each record to 2 MiB. The runtime uploads selected snapshots in short batches,
keeps one request in flight, bounds pending memory, and logs then drops timeout,
network, and oversized-record failures. It does not persist a queue or retry
failed uploads. Raw events and per-call full request, response, tool-output, and
other artifacts never leave the local store.
