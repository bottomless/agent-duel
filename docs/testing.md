# Testing

## Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

## Test-driven development

Work in vertical slices: one test, one implementation, repeat. Each test responds to what you learned from the previous cycle.

```
RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3

WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5
```

Writing all tests first then all implementation produces bad tests — you end up testing imagined behavior instead of actual behavior.

## Fallible user actions

Every user action that can fail must expose the complete operation state in the UI:

- **Pending:** show immediate progress and prevent accidental duplicate submissions.
- **Success:** show the requested result, or a clear success acknowledgement when the result is not otherwise visible.
- **Failure:** keep an actionable error visible in the same context until the user retries or dismisses it.

Logs, console output, and a reset button are not user feedback. Neither is a platform API unless it is verified on every supported platform: React Native Web's `Alert.alert()` is a no-op, so browser and Electron failures must use rendered app UI such as the shared alert component.

Every fallible action needs behavioral coverage for success and failure. RPC-backed UI should use an app Playwright test with a real browser, network, and daemon whenever feasible. The failure test must assert what the user can see and do after the failure, not an internal response, state field, or log line. Add distinct timeout or disconnect cases when they produce distinct recovery behavior.

## Determinism first

Tests must produce the same result every run:

- No conditional assertions or branching paths
- No reliance on timing, randomness, or network jitter
- No weak assertions (`toBeTruthy`, `toBeDefined`)
- Assert the full intended behavior, not fragments

```typescript
// Bad: conditional and weak
it("creates a tool call", async () => {
  const result = await createToolCall(input);
  if (result.ok) {
    expect(result.id).toBeDefined();
  }
});

// Good: deterministic and explicit
it("returns timeout error when provider times out", async () => {
  const result = await createToolCall(input);
  expect(result).toEqual({
    ok: false,
    error: { code: "PROVIDER_TIMEOUT", waitedMs: 30000 },
  });
});
```

## Flaky tests are a bug

Never remove a test because it's flaky. Find the variance source (time, randomness, race condition, shared state, non-deterministic output, environment drift) and fix it.

## Real dependencies over mocks

Mocks are not the default. They require an explicit decision.

- **Database**: real test database, not a mock
- **APIs**: real APIs with test/sandbox credentials, not request mocks
- **File system**: temporary directory that gets cleaned up, not fs mocks

Ask: "will this still hold with real dependencies at runtime?" If no, don't mock.

### Use swappable adapters instead

When you need test isolation, design code so dependencies are injectable:

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// Production
const realSender: EmailSender = { send: sendgrid.send };

// Test: in-memory adapter
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => {
      sent.push({ to, body });
    },
    sent,
  };
}
```

## End-to-end means end-to-end

When a test is labeled end-to-end, it calls the real service. No environment variable gates, no conditional skipping, no mocking the external dependency.

### Packaged desktop smoke

The packaged desktop smoke is an external observer of the production launch path. It must not add a smoke-only branch to Electron main or start the daemon itself.

The harness launches the unpacked packaged app with isolated user data and daemon state, connects to the real renderer over Chromium's debugging protocol, and requires all of these outcomes:

- the `paseo://app/` renderer mounts into `#root`;
- the sandboxed preload exposes the desktop bridge;
- the renderer starts a fresh desktop-managed daemon through the normal startup bootstrap;
- the bundled CLI can query that daemon and run a terminal command.

CI does not run these packaged smoke checks; see [Pull-request checks](#pull-request-checks).
Packaging is not maintained by this fork.

To exercise the smoke locally on Linux:

```bash
PASEO_DESKTOP_SMOKE=1 \
PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/tmp/paseo-desktop-smoke \
npm run build:desktop -- --publish never --linux --x64 --dir
```

### Desktop browser regression

The desktop browser E2E launches an isolated real daemon, Metro, and Electron app. It forces workspace LRU eviction to reparent the original tab and replace its guest `WebContents`, then makes one MCP call each for tab listing, snapshot, and click against that original browser id. A final MCP wait proves the real target page received the click.

For this browser-tab behavior, run the dedicated regression locally:

```bash
npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
```

## Test organization

- Collocate tests with implementation: `thing.ts` + `thing.test.ts`
- Extract complex setup into reusable helpers
- Test bodies should read like plain English
- Build a vocabulary of test helpers that make complex flows simple

### File naming

Vitest picks up tests by suffix. The suffix tells the runner which category it belongs to.

| Suffix                | What it is                                                                                                    | Where it runs                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `*.test.ts(x)`        | Unit test — pure, fast, no daemon                                                                             | `npm run test:unit`                                                                  |
| `*.posix.test.ts`     | Unit test that needs POSIX-only behavior                                                                      | unit, skipped on Windows                                                             |
| `*.browser.test.ts`   | App test that needs a real browser (DOM)                                                                      | `npm run test:browser` (Vitest browser mode, Playwright provider, headless Chromium) |
| `*.e2e.test.ts`       | End-to-end against a real daemon                                                                              | `npm run test:e2e`                                                                   |
| `*.real.e2e.test.ts`  | E2E that hits a real provider (Claude/Codex/Copilot/OpenCode/Pi) — needs creds in `packages/server/.env.test` | `npm run test:integration:real` / `test:e2e:real`                                    |
| `*.local.e2e.test.ts` | E2E that needs a local-only resource                                                                          | `npm run test:integration:local` / `test:e2e:local`                                  |

Browser Playwright specs live in `packages/app/e2e/browser/`. Desktop Playwright and real-Electron E2E live in `packages/desktop/e2e/`. Harness code shared by both suites lives in `packages/app/e2e/support/`; neither suite may place specs there. App Playwright specs that hit real providers use `*.real.spec.ts` and run through `npm run test:e2e:real --workspace=@getpaseo/app`; the default browser project ignores that suffix so CI does not need provider credentials.

Live provider smoke tests belong in `*.real.e2e.test.ts`, not `*.test.ts`, even when guarded by environment variables. Default unit suites must use deterministic provider adapters/fakes so missing credits, auth outages, and upstream model drift do not block normal CI.

Arena local-HTTP changes need both sides of the boundary: focused Bun tests in
`arena-backend/packages/opencode/test/arena/` must enumerate denied session methods, persistence
side effects, orchestration guards, and ordinary non-Arena behavior; focused daemon tests must prove
that SDK and raw HTTP calls carry the daemon-held token without putting it in the launched process
environment, arguments, or stdin. Browser QA should continue through the daemon protocol and must
not receive an OpenCode token or call the OpenCode server directly. Finish with one normal desktop
battle happy path because authenticated unit requests do not prove the renderer-to-daemon flow.

Codex MultiAgentV2 real tests use local Codex authentication rather than the OpenRouter-compatible test provider. OpenRouter does not accept Codex collaboration-history items on the parent follow-up request, so it cannot verify a complete native sub-agent turn.

### Test setup

- Server: `packages/server/src/test-utils/vitest-setup.ts` loads `.env.test`, sets `PASEO_SUPERVISED=0`, and disables Git/SSH prompts. Add new global env shims here, not in individual tests.
- App: `packages/app/vitest.setup.ts` provides `expo`/`__DEV__` shims and stubs a few native-only modules (`react-native-unistyles`, `react-native-svg`, `expo-linking`, `@xterm/addon-ligatures`). Stubbing here is for modules that have no meaningful Node behavior — not a license to mock app code.

## Running tests locally

Test suites in this repo are heavy. Running them in bulk freezes the machine, especially with multiple agents in parallel.

Choose the runner for the workspace you changed. The root npm workspace and the
vendored Bun backend have separate dependencies, configuration, and checks.
Root `npm run typecheck`, `npm run lint`, and formatting do not cover the backend.

| Changed code       | Working directory                                                       | Targeted test                                     | Typecheck                                    |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Root npm workspace | Repository root, or the owning package when its test config is required | `npx vitest run <test-file> --bail=1`             | `npm run typecheck` from the repository root |
| Arena engine       | `arena-backend/packages/opencode`                                       | `bun run test ./test/arena/<file>.test.ts --bail` | `bun run typecheck` in that package          |

Replace placeholders with the single test file for the changed behavior. The
backend package's test script supplies its timeout and loads its Bun preload;
do not run tests or typecheck from the backend workspace root. For other backend
packages, follow their own scripts and nearest agent guide. See the
[backend agent guide](../arena-backend/AGENTS.md). Root npm lint/format policy does
not replace the backend's local tooling.

Playwright flows use their owning app/desktop scripts with an explicit spec path,
not the Vitest command above. A passing unit test does not prove the browser,
daemon, and backend integration; [QA](qa.md) defines the evidence for that claim.

- Run only the relevant test file with its workspace runner above.
- Never run `npm run test` for a whole workspace unless asked.
- Redirect verbose output to a file and read it afterward; this does not authorize a broader suite.
- Never re-run a suite another agent already reported green.
- CI checks format, lint and types, not behaviour. Do not push merely to obtain test results; use targeted local evidence and report remaining gaps. See [Pull-request checks](#pull-request-checks).
- Never run the full Playwright E2E suite locally. Targeted Playwright specs are allowed when you changed or need to prove that specific flow; report untested coverage explicitly.
- App Playwright shares one warmed Metro server per run and gives every Playwright worker its own isolated daemon and `PASEO_HOME`. Spec files run concurrently without exposing one file's projects, agents, terminals, history, or provider configuration to another worker; tests within a file remain together so file-level setup is not repeated.
- Helpers that create projects or workspaces own those records until cleanup. Their clients remove the daemon project on close, and an automatic fixture fails any test that still leaks a project record. Deleting only the temporary directory is not cleanup. Agent helpers pass the intended `workspaceId` through to agent creation; they never infer ownership from `cwd`.
- Tests whose subject is daemon-global state, such as an empty history or daemon restart, start a dedicated host explicitly. Filenames and directories describe product behavior, never execution order or isolation mechanics.
- Global setup accepts Metro as ready only when `/status` returns `packager-status:running`, then fetches the document's scripts so the cold bundle compilation finishes before Playwright's per-test timeout starts. A generic TCP listener is not sufficient readiness evidence. The browser suite uses direct local daemon connections and does not start a relay.

## Pull-request checks

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. It needs no
secrets, so it also runs for pull requests from forks. It has two jobs:

- `checks`: format, lint, the server-stack build, and typecheck for the npm workspaces.
- `arena-backend`: typecheck for the engine (`opencode`) and `arena-service`.

It does not run the server, app, desktop, CLI, or browser suites. Run the targeted tests for the
files you changed, attach [QA evidence](qa.md), and state gaps without running full local suites.

## Agent authentication in tests

Agent providers handle their own auth. Do not add auth checks, environment variable gates, or conditional skips to tests. If auth fails, report it.

## Debugging with tests

Use the test as your debugging ground:

1. Add temporary logging to the code under test
2. Run the test, observe actual values
3. Trace the flow end-to-end through test output
4. Confirm each assumption with actual output
5. Remove logging when done

The test output is the source of truth, not your reading of the code.

## Design for testability

If code isn't testable, refactor it. Signs:

- You want to reach for a mock
- You can't inject a dependency
- You need to test private internals
- Setup requires too much global state

Aim for deep modules: small interface, deep implementation. Fewer methods = fewer tests needed, simpler params = simpler setup.

## Two test categories, no others

Every test in this repo lives in exactly one of these shapes:

1. **Unit tests with ports and adapters** — production code receives its real-world dependencies (DB, HTTP, CLI process, clock, randomness, filesystem, other modules) through an injected interface. Tests wire a typed in-memory fake colocated with the production module. **No `vi.mock`, `vi.hoisted`, `vi.spyOn` of own exports, JSDOM, `@testing-library` component mounting, RN test renderer, monkey-patched globals, or fake-server fixtures.** If a test needs any of those, the production module is missing a port — fix the seam, then write the test against a fake adapter.
2. **Real end-to-end tests** — real daemon, real network, real browser (Playwright for app code) or a real isolated server instance (for daemon code). No JSDOM, no mocked transport.

Anything in between — component tests in JSDOM, vitest tests that mock the module under test, tests that assert on private state — is slop on its way out.
