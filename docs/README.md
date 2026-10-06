# Agent Duel documentation

Start with [local setup](../README.md#develop-locally) to run the
product and the [agent guide](../CLAUDE.md) for repository rules. The product
uses the browser and Electron clients; inherited native adapters are retained.

## Active Agent Duel guides

Read the guide that owns the subject before changing it. Shared UI guides may
retain labeled native implementation history; it does not add a native target.

| Guide                                    | Subject                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| [Arena](arena.md)                        | Battle lifecycle, blinding, voting, canonical history     |
| [Architecture](architecture.md)          | Daemon, backend, client boundaries and data flow          |
| [Glossary](glossary.md)                  | Product terminology; current UI labels take precedence    |
| [Development](development.md)            | Setup, dev state, commands, build sync, debugging         |
| [Coding standards](coding-standards.md)  | Types, state, errors, React, module boundaries            |
| [Design](design.md)                      | Tokens, density, alignment, components and visual states  |
| [Forms](forms.md)                        | Form models, lifecycle and async input gating             |
| [Hover](hover.md)                        | Pointer tracking, stable geometry and reveal lifetime     |
| [Unistyles](unistyles.md)                | Theme updates, style tracking and web runtime gotchas     |
| [Floating panels](floating-panels.md)    | Anchoring, portals, measurement and lifecycle             |
| [Menus](menus.md)                        | Shared menu engine, presentations and submenus            |
| [Expo Router](expo-router.md)            | Route ownership and startup workspace restore             |
| [RPC namespacing](rpc-namespacing.md)    | Request/response naming and shared-release policy         |
| [Testing](testing.md)                    | Test policy, targeted execution and CI status             |
| [QA](qa.md)                              | Evidence appropriate to the affected behavior and runtime |
| [Writing documentation](writing-docs.md) | Ownership, organization and prose conventions             |
| [Contributing](../CONTRIBUTING.md)       | Short contribution and PR guidance                        |
| [Accounts](accounts.md)                  | Sign-in, account sessions and authentication boundaries   |
| [Side panel](side-panel.md)              | Main pane, side panel tabs and layout ownership           |

## Inherited subsystem references

These describe the Paseo systems retained by Agent Duel. Open them when work
lands in that subsystem; verify source details before relying on historical
examples. They do not override the active guides above or establish additional
product targets. Report shared upstream defects separately.

| Subject                     | References                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lifecycle and storage | [Lifecycle](agent-lifecycle.md), [data model](data-model.md), [timeline sync](timeline-sync.md), [terminal activity](terminal-activity.md)                                                                     |
| Providers and protocol      | [Providers](providers.md), [custom providers](custom-providers.md), [forge providers](forge-providers.md), [protocol validation](protocol-validation.md), [OpenCode events](opencode-global-event-baseline.md) |
| Files and terminal          | [File icons](file-icons.md), [file observation](file-observation.md), [terminal performance](terminal-performance.md)                                                                                          |
| Transport and hosting       | [Service proxy](service-proxy.md), [Docker](docker.md), [web UI](web-ui.md), [security](../SECURITY.md)                                                                                                        |
| Verification tools          | [Daemon tests](ad-hoc-daemon-testing.md), [browser capture harness](browser-capture-harness.md)                                                                                                                |
| Native and localization     | [Mobile panels](mobile-panels.md), [i18n](i18n.md), [Maestro flows](../packages/app/maestro/README.md)                                                                                                         |
| Historical plans            | [Session decomposition](refactors/session-decomposition-plan.md)                                                                                                                                               |

## Other documentation collections

- [App](../packages/app/README.md), [desktop](../packages/desktop/README.md),
  [server](../packages/server/README.md), [client](../packages/client/README.md),
  and [protocol](../packages/protocol/README.md) describe the active packages.
- [Backend docs](../arena-backend/README.md) and its nested agent guides belong
  to the vendored OpenCode workspace. Preserve its separate Bun tooling.
- [Bundled skills](../skills/README.md) describe inherited Paseo tools.
- [Test projects](../test-projects/README.md) are fixtures and QA scenarios.
- [Changelog](../CHANGELOG.md) and license notices retain their original history.

Add new guides to the owning section and link them from the relevant subject
pages. Follow [writing documentation](writing-docs.md).
