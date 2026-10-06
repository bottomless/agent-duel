# Accounts

The official build requires an account. Nothing in the app renders until one is established, and the
local daemon refuses unauthenticated WebSocket connections and API calls. A source build without a
control plane has no accounts and runs battles on your own OpenRouter key; see
[Bring your own key](#bring-your-own-key).

The official build supports three sign-in methods: email magic link, Google, and GitHub. Agent Duel
is an Electron client with a local Express daemon and a remote control plane, so no web-framework
auth library fits; the control plane implements the flow below.

## Where it lives

The hosted control plane, in a separate private repository, owns the public auth routes, OAuth
exchange, email delivery, session issuance, revocation and rate limits, and holds every provider and
session-signing secret.

`packages/server/src/server/accounts/` owns the loopback `/api/auth` surface used by the app. It
proxies sign-in operations to the control plane, redirects callbacks to its public origin, and
verifies returned session tokens locally. The daemon has no database driver or provider secrets.

No account storage code ships in this repository or the desktop app. The account id also owns battle
records; the daemon passes the locally verified user to
the Arena runtime when it resolves a session into a chat.

## The sign-in flow

All methods share one flow because the browser that completes sign-in is not the client that needs
the session. Electron opens the system browser, and an email link may be opened on another device.

1. The app opens a flow through the daemon and receives a `flowId` and secret from the control plane.
2. The browser completes OAuth or opens the email link on the public control-plane origin.
3. The control plane mints a session and attaches it to the flow.
4. The app polls the daemon with the flow secret. The daemon claims the token once, verifies its
   signature, and returns it to the app.

Desktop flows include a temporary loopback return address owned by the initiating Electron window.
The control-plane success page posts to it when you click **Open Agent Duel**. This focuses that
window without an OS protocol link, which could launch another installed build during development.
The address carries no account credentials. Browser-only flows keep the manual return instruction.

OAuth `state` is stored on the flow rather than in a cookie, so the callback can land in a browser
that shares no cookie jar with the app.

## Session tokens

The control plane issues Ed25519-signed tokens with a 30-day expiry. The private key exists only in
the control plane; the matching public key is embedded in the desktop release and passed to its
daemon. Every mode fails closed when either key is missing; a daemon without a control-plane URL
needs neither, because it is a BYOK build. Hosted development has no built-in key pair: the dev
scripts generate one pair per checkout, keep it in the gitignored `.dev/session-keys.json`, and pass
it through the same variables.

The raw token is returned once and held by the client. Electron persists the signed session through
`safeStorage`, which uses the operating system's protected credential facility, and removes the
legacy renderer `AsyncStorage` copy during hydration. The token exists in renderer and daemon memory
while the app is signed in; it is not persisted as plaintext browser storage by the desktop build.
The browser QA surface continues to use `AsyncStorage` and is not a production session boundary.
The control plane stores only a SHA-256 hash of each session token, and claims each magic-link token
once.

The local daemon verifies signature and expiry without contacting the control plane. This keeps
ordinary local agents available while the internet or control plane is unreachable. Opening a new
session requires the network, as do OpenRouter requests and selected research uploads. Arena
history and recovery remain local.

The control plane checks both the signature and the live server-side session for every OpenRouter and
research request. Signing out therefore revokes cloud access immediately. A disconnected daemon cannot
learn about revocation; its locally verifiable token remains valid until the app removes it or its
30-day expiry is reached.

## How the session travels

The daemon password and account session are separate credentials; a remote client presents both.

- HTTP uses the `x-paseo-session` header (`SESSION_HEADER` in
  `packages/protocol/src/accounts/schemas.ts`).
- WebSocket uses a `paseo.session.<token>` subprotocol alongside `paseo.bearer.<password>`.
- The daemon holds the account token in memory. It creates a random, revocable loopback capability
  for each Arena child and sends only that capability, the daemon's `/api/arena-runtime` URL, and
  a SHA-256 verifier of the loopback OpenCode control token through the child's one-time stdin
  startup pipe, tagged `"mode": "hosted"`. The child consumes and closes the pipe before starting
  services. None of these credentials is installed in environment variables or command-line
  arguments.
- The daemon's Arena runtime proxy accepts that local capability only on an explicit allowlist:
  assignments, comparison, research upload, and assigned OpenRouter chat/responses. It exchanges the
  capability for the account session when forwarding the request. Account changes, signing out the
  account's last usable session, child exit, and daemon shutdown revoke the local capability.
- The control-plane OpenRouter route replaces the account session with the server's real OpenRouter
  key. The Arena process and its contestant subprocesses never receive the account token or provider
  key.

`DaemonClient` reads the token through `getSessionToken` on every connection attempt rather than
capturing it at construction. A client rejected while signed out is already reconnecting when the
user signs in, so its next attempt must carry the new token.

Switching accounts, or signing out the account's last usable session, invalidates pending launches
and restarts the Arena child, which interrupts every running battle. Another session of the same
account replaces the forwarded token in place: Electron and the browser harness hold different
sessions, and each of their requests would otherwise restart Arena. When the active session signs
out, the daemon forwards the most recent remembered session of that account that still verifies. It
remembers a few, and forgets them when the account changes. A signed-out session is never forwarded
again, though it still verifies locally and another tab may still present it: the control plane has
revoked it. Ordinary non-Arena agents are not restarted.

Contestant inference requires both a scope ID and an assignment ID owned by the authenticated user
and still unresolved. The server selects the model and provider from that assignment and stops
authorizing it after resolution without deleting its permanent identity
record. There is no unassigned OpenRouter route.
Comparison uses a separate endpoint with a
fixed server-selected model and an unresolved battle scope. Alternative model lists, presets,
provider overrides, server-side tools, and query
parameters are rejected.

These controls close the reported arbitrary-model request and keep the account session outside the
Arena process tree. They are not an operating-system sandbox: software running as the same desktop
user can inspect or manipulate that user's local processes and files. The remote control plane must
therefore continue treating the local runtime as an untrusted client and enforce assignment, scope,
lifecycle, and payload checks itself.

## Bring your own key

A daemon with Arena configured (`PASEO_ARENA_BACKEND_ROOT` or `PASEO_ARENA_BACKEND_EXECUTABLE`) and
no control-plane URL runs in BYOK mode (`resolveArenaAccessConfig` in
`packages/server/src/server/accounts/config.ts`). It has no sign-in middleware, answers
`GET /api/auth/methods` with `{enabled: false}`, which the app reads as "no sign-in", and mounts no
feedback routes. The build decides the mode; one build never switches between hosted and BYOK.
`npm run dev:desktop -- --byok` starts the daemon without a control-plane URL; see
[development](development.md).

The key travels from Settings to the engine without touching an environment variable,
command-line argument, or plaintext file. Contestants run unsandboxed as the same user, and
`ps eww` shows another process's environment.

1. You paste the key in Settings, in a section that appears only when the daemon reports BYOK mode
   (`packages/app/src/byok/`). Electron encrypts it with `safeStorage` in its own file beside the
   account session and keeps no renderer copy; the browser QA harness keeps it in `AsyncStorage`,
   which is not a protected boundary. The section shows whether the daemon holds a key and never
   reads the stored key back.
2. The app sends it over the authenticated WebSocket with `arena.byok.key.set.request`; `null`
   clears it. The key belongs to the computer, so a save or removal goes to every connected host.
   `arena.byok.status.get.request` reports whether the daemon is in BYOK mode (`available`) and
   holds a key (`configured`). A daemon with a control plane refuses the key.
3. The daemon keeps the key only in memory (`accounts/byok.ts`) and writes it to the Arena child's
   stdin startup pipe as `"mode": "byok"` with the same control-token verifier. The engine calls
   OpenRouter itself, so the daemon issues no runtime capability and `/api/arena-runtime`
   authorizes nothing. The engine still strips `OPENROUTER_API_KEY` from contestant environments,
   and the daemon redacts a key request from its raw-payload error log.

A new or cleared key restarts the Arena child the way an account change does, which interrupts
every running battle, so Settings confirms a replacement or removal. Sending the key the daemon
already holds changes nothing, and the daemon forgets the key when it exits, so the app hands the
stored key over every time a host comes online. Without a key, Arena refuses to start the same way
it does when nobody is signed in. Before a battle starts, the app checks for a key instead of
letting that refusal surface: it hands over the stored key, or stops with a message that points to
Settings. The check never replaces a key the daemon already holds; two clients with different keys
would otherwise restart Arena under each other's battles.

BYOK battles are blinded the same way, but nothing enforces it; see [Blinding](arena.md#blinding).

## Refused versus unavailable

The client must distinguish an invalid local session from a control-plane outage.

| State                                    | HTTP | WebSocket close | App behavior             |
| ---------------------------------------- | ---- | --------------- | ------------------------ |
| Missing, invalid, or expired token       | 401  | 4402            | Clears it, shows sign-in |
| Control plane unavailable during sign-in | 503  | N/A             | Keeps the flow, retries  |

A valid signed session remains locally accepted during an outage; there is no network cache or
grace timer in the daemon.

## Two ordering traps

- **The endpoint cannot come from a registered host.** A host is registered only after a successful
  connection probe, and the probe fails while signed out. `accounts/endpoint.ts` falls back to the
  configured daemon (`EXPO_PUBLIC_LOCAL_DAEMON`, or the initial connection hint).
- **The probe needs the session too.** It builds its own `DaemonClient`
  (`utils/test-daemon-connection.ts`), so it must present the same credentials as the app.
  `AccountGate` reruns `bootstrapConfiguredConnection()` after sign-in.

## Configuration

Release builds embed these public values, which default to the hosted control plane; a BYOK build
leaves both unset (see [deployment](deployment.md)):

| Variable                   | Effect                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `PASEO_CONTROL_PLANE_URL`  | Written into the packaged desktop deployment configuration. |
| `PASEO_SESSION_PUBLIC_KEY` | Ed25519 SPKI public key embedded for local verification.    |

At runtime the desktop passes the URL as `PASEO_CONTROL_PLANE_URL`, points the packaged daemon at the
bundled Arena executable, and passes the public key. Source-based development can attach an
external control plane the same way; see [development](development.md#running-the-dev-server).

A sign-in method with missing credentials is omitted from `GET /api/auth/methods`.

## Public route boundaries

OAuth callbacks and magic links cannot attach the daemon password. The daemon bypasses bearer auth
for its auth routes; each callback instead carries a single-use OAuth state or hashed magic-link
capability. The control plane validates those values before issuing a session.

The research, Arena assignment, comparison, and OpenRouter routes accept only an account session. They verify
the signed token, confirm its live session on the server, and scope research records and assignments
through the owning account. No shared upload token, contestant catalog, assignment mapping,
or OpenRouter key is shipped in the desktop app.

Relay connections remain out of scope because sign-in needs a plain HTTP origin, which the
end-to-end encrypted relay does not provide.

## Testing

- `arena-backend/packages/arena-service/src/*.test.ts` covers assignments, OpenRouter streaming, and
  comparison against an injected caller.
- `packages/server/src/server/accounts/routes.test.ts` covers the daemon proxy, local token
  verification, Arena credential installation, sign-out, and unavailable-versus-rejected behavior.
- `packages/server/src/server/accounts/config.test.ts` covers choosing hosted, BYOK, or no Arena;
  `byok.test.ts` and the `Arena BYOK RPCs` cases in `session.test.ts` cover holding, replacing, and
  clearing the key and when that restarts Arena.
- `packages/app/src/byok/key.test.ts` covers where the app stores the key, handing it over on
  connect, saving and removing it, and the check before a battle starts;
  `packages/app/src/runtime/host-runtime.test.ts` checks that every connection hands it over again.
- `packages/server/src/server/accounts/arena-runtime-router.test.ts` checks that a local capability
  reaches only the allowlisted Arena routes and that the daemon substitutes the account token.
- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts` covers private stdin
  delivery in both modes, missing credentials, pipe failures, account changes during startup or
  shutdown, and the restart on a BYOK key change.
- `arena-backend/packages/opencode/test/arena/credentials.test.ts` checks bounded startup parsing;
  `runtime.test.ts` checks authenticated research uploads and refusal to use legacy environment keys.

See [testing.md](testing.md) for the repository-wide test rules.
