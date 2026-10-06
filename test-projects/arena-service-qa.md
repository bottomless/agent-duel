# Agent Arena multi-service QA

Use this manual flow to verify that parallel Arena battles isolate full-copy candidate directories, discover several services per candidate, stop predecessor services, and describe the stopped environment to successor agents.

The fast path takes 6–10 minutes after the browser app is running. Run the two chats concurrently; do not wait for one to finish before starting the other.

## Fixture

Use the vendored Weatherfork project at `test-projects/weatherfork`. It already contains the web, `api`, and `events` services, `/health` endpoints, explicit port handling, a title for the second-turn edit, and the required `paseo.json` setup.

Copy it into a disposable Git repository before starting the browser app. Arena needs a repository from which it can create candidate worktrees; do not initialize a nested repository inside the Paseo checkout.

```bash
fixture_parent="$(mktemp -d)"
cp -R test-projects/weatherfork "$fixture_parent/weatherfork"
git -C "$fixture_parent/weatherfork" init -b main
git -C "$fixture_parent/weatherfork" add --all
git -C "$fixture_parent/weatherfork" \
  -c user.name="Arena QA" \
  -c user.email="arena-qa@localhost" \
  commit -m "Initialize Weatherfork Arena fixture"
```

Record `fixture_parent` for cleanup. Use `$fixture_parent/weatherfork` as the project path and `main` as the starting ref throughout this runbook. Do not change the vendored copy.

The fixture defines services in `paseo.json`, but the Turn 1 prompts below tell contestants to start them with the normal shell tool. Arena captures surviving shell process groups rather than relying on the configured service definitions.

## Isolate the browser stack

1. Start `npm run dev:server` and `npm run dev:app` from the implementation checkout. Override `PASEO_LISTEN`, `EXPO_PORT`, and `PASEO_HOME` when their defaults are already in use.
2. Record the Expo URL, daemon address, and `PASEO_HOME` printed by the startup banners.
3. Confirm the daemon is not using port `6767`. Never stop or restart the main daemon.
4. Open the Expo URL in the in-app browser and identify the build by its checkout and development-build branch label before interacting with it.

Do not interpret a timeout as permission to restart a daemon. Check the isolated daemon log and listener first.

## Turn 1: start services in two parallel chats

Add `$fixture_parent/weatherfork` as a project. Create two new workspaces from its `main` ref with Battle enabled. Submit these prompts without waiting for the first chat to finish.

Chat 1:

> Start the existing web, api, and events services with the normal shell as detached background processes and leave them running. Redirect their output to service-specific files under `/tmp`, and verify all three health URLs before finishing. Do not change any files.

Chat 2:

> Start the existing web, api, and events services with the normal shell as detached background processes and leave them running. Use an inline `PASEO_PORT=... command` assignment for api and an `export PASEO_PORT=...; command` form for events. Redirect their output to service-specific files under `/tmp`, and verify all three health URLs before finishing. Do not change any files.

Each chat creates Agent A and Agent B, so four candidate worktrees run concurrently.

For every candidate, verify:

- the header identifies `Agent A` or `Agent B`;
- `Worktree:` shows only the final path component and differs between candidates;
- the worktree folder menu can copy the full path;
- the service cluster grows from empty to three icons as listeners appear;
- the globe icon is the preferred preview and the two server icons are the other services;
- each icon reports a distinct port and a live proxy URL in its tooltip or accessibility label;
- the environment transition row is collapsed by default;
- expanding the row shows selectable transition details, and it collapses again.

Open or request one web preview and one non-preview `/health` URL per candidate. The response must come from that candidate's worktree. A typical non-preview check is:

```bash
curl -fsS http://<service-hostname>:<isolated-daemon-port>/health
```

Record all four worktree basenames and their three ports. The expected total is 12 distinct live candidate listeners across the two chats.

## Turn 2: transition to successor worktrees

Resolve the first battle in each chat. Choose A in one chat and B in the other so both selection paths run.

Immediately submit small second turns in parallel:

Chat 1:

> In `src/CityIndex.tsx`, add a sun emoji beside the existing title. Do not edit any other file.

Chat 2:

> In `src/CityIndex.tsx`, add a rain emoji beside the existing title. Do not edit any other file.

For both Agent A and Agent B in each chat, verify:

- a new candidate worktree basename appears;
- the candidate keeps its persistent A or B branch name;
- the expanded environment transition lists the inherited process-group launch command and all three listener aliases;
- the transition reports one verified command stop and three released predecessor listeners without failures;
- the predecessor ports no longer have listeners;
- the successor receives distinct `PASEO_PORT`, `PASEO_PORT2`, and `PASEO_PORT3` aliases;
- no service icons become live unless the successor agent explicitly starts a service;
- the tiny file edit is confined to the new candidate worktree.

Arena captures predecessor commands for transition context but does not replay them. A listener remaining after the successor starts is a failure unless another process outside this test owns that port.

## Cleanup

Archive the two test workspaces after collecting evidence. Verify their proxy URLs stop resolving and no Arena-owned listeners from those workspaces remain. Do not kill listeners by broad PID, port, process-name, or worktree patterns when other tests are running.

Leave the isolated browser stack running only when another tester will reuse it. Otherwise stop that checkout's Expo and daemon processes and confirm their recorded ports are free. Never clean up port `6767` as part of this flow.

After the workspaces and their listeners are gone, remove the recorded disposable `fixture_parent` directory. This deletes only the temporary copy; keep `test-projects/weatherfork` unchanged.

## Failure interpretation

| Observation                                                         | Result                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| A candidate shows fewer than three services after its turn finishes | Fail. Capture its shell calls, transition text, and daemon log. |
| Any service restarts without a Turn 2 command                       | Fail. Capture its launch command and owner process.             |
| Agent A and Agent B share a worktree or port                        | Fail. Capture both headers and listener ownership.              |
| A non-preview proxy reaches the wrong candidate worktree            | Fail. Capture the URL and health response.                      |
| A predecessor listener remains after successor transition           | Fail. Capture the owner process and stop report.                |
| Transition details start expanded                                   | UI failure.                                                     |
| Header shows the full worktree path instead of its basename         | UI failure.                                                     |
| Routes or listeners remain after workspace archive                  | Cleanup failure.                                                |

## Evidence

Attach:

- one screenshot showing both candidate headers in each chat;
- the four worktree basenames and 12 Turn 1 ports;
- Turn 2 transition details showing the inherited shutdown command and three released listener aliases per candidate;
- one preview response and one non-preview health response per candidate;
- the isolated daemon address and relevant daemon-log excerpt;
- cleanup results;
- total elapsed time and any wait longer than 30 seconds.

Use listener inspection and exhaustive URL checks only when a header assertion fails. The header and one preview plus one non-preview request per candidate keep the normal run short.
