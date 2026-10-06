# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue, pull request, or discussion for a vulnerability.

Include:

- the version (Settings → About) or the commit you built from
- whether you run the official download or a source build with your own OpenRouter key (`--byok`)
- your OS and version
- the affected component: desktop app, daemon, battle engine, CLI, or the hosted control plane
  (sign-in, battle assignments, the model proxy, research uploads)
- steps to reproduce, or a proof of concept
- the impact you observed and what an attacker gains

Do not include real API keys, session tokens, or private source code. Redact them from logs.

Reports about the hosted service are welcome here even though its code is not in this repository.

## Supported versions

Agent Duel is pre-1.0. Security fixes land on `main` and ship in the next release. Only the latest
release of the official download and the current `main` branch are supported. Update before you
report.

Most of the daemon, CLI, and relay code is inherited from [Paseo](https://github.com/getpaseo/paseo).
If a vulnerability is in code this repository has not changed, report it to Paseo as well.

## Agent Duel control plane

Agent Duel runs a local daemon that manages your coding agents and a bundled battle engine (a
vendored OpenCode fork). The desktop app and the CLI connect to the daemon over WebSocket.
Contestants run in local worktrees with your user's permissions. Prompts, code context, and tool
output go to the model providers the contestants call.

There are two builds:

- **Official download.** You sign in to a hosted control plane, which is not part of this
  repository. It holds the contestant pool, the model assignments, and the OpenRouter key. The
  desktop receives only opaque assignment ids before you vote, and the control plane authorizes
  every routed request against your account and the battle it belongs to. The official download
  also uploads battle records, including transcripts and patches, to the control plane.
- **Source build with your own key (`--byok`).** There is no sign-in, and no battle records leave
  your machine except the model calls themselves, which go to OpenRouter with your key. You paste
  an OpenRouter key in Settings; the daemon keeps it in memory and passes it to the engine over a
  private startup pipe, never through an environment variable or a file. Blinding in this build is
  a UI convention: you own the key, the process that routes the calls, and the local store that
  holds the mapping.

See [docs/arena.md](docs/arena.md#blinding) for the full identity boundary.

### Bundled engine boundary

The bundled OpenCode server denies local HTTP routes by default and accepts `GET /global/health`
without credentials for liveness only. The `/session` namespace and the battle routes require a
private control token held by the daemon. The daemon sends the engine only a SHA-256 verifier over
its one-time startup pipe; the renderer, command line, environment, logs, and contestant processes
never receive the token. The legacy `/api/*` surface is disabled, and `/doc` stays hidden unless
`OPENCODE_ARENA_ENABLE_DOCS=1` is set for local development.

## Local daemon trust boundary

The daemon binds to `127.0.0.1` by default. With no password configured, anything that can reach
the daemon socket can control the daemon, the same model Docker uses for its daemon.

You can set a shared-secret password with `auth.password` in `config.json` or the `PASEO_PASSWORD`
environment variable (stored bcrypt-hashed). Every HTTP request must then carry
`Authorization: Bearer <password>`, and every WebSocket upgrade must send a
`Sec-WebSocket-Protocol: paseo.bearer.<password>` subprotocol, because browser WebSockets cannot set
custom headers. `GET /api/health` and CORS preflight are exempt.

Connected clients are trusted operators of the daemon user. A file preview may read any regular
file the daemon process can read; workspace-relative paths are a UI convenience, not a security
boundary.

If you expose the daemon beyond loopback (binding to `0.0.0.0`, a tunnel, a reverse proxy), you are
responsible for securing that access. Set a password.

## DNS rebinding protection

CORS does not stop a malicious site from resolving its domain to your machine. The daemon validates
the `Host` header on every HTTP request and WebSocket upgrade against an allowlist. By default only
`localhost`, `*.localhost`, and literal IP addresses are accepted. Add hostnames with `hostnames` in
`config.json` or `PASEO_HOSTNAMES` (comma-separated; a leading `.` matches a domain and its
subdomains; `true` disables the check). Other hosts get `403 Host not allowed`.

## HTML file preview

Previewing an `.html` file runs its markup, including markup an agent wrote or that came with a repo
you cloned. The preview loads it with an opaque origin and a policy that allows inline script and
style and refuses everything else: no remote resources, no network requests, no form posts, no
plugins, no nested frames, no popups, no top-window navigation, and no access to the app's DOM,
storage, cookies, or other files.

One gap remains: a sandboxed document may navigate itself, and no CSP directive in current browsers
prevents it. A hostile page can reach a server that way, carrying data available inside the
preview: its own contents, browser properties, input typed into it, and your IP address. If you
don't trust a page, open it in `Source`, which runs nothing.

## Agent credentials

Agent Duel wraps agent CLIs (Claude Code, Codex, GitHub Copilot, OpenCode, Pi) and does not manage
their authentication. Each provider handles its own credentials, and agents run in your user
context with them. Contestants run unsandboxed as your user, so they can read anything your user
can.

## Forge host trust

The app talks only to a forge host that is a known cloud host or one the forge CLI is already
authenticated to. It never routes credentials to an unauthenticated, remote-derived host.
