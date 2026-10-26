# Upstream sync

Agent Duel takes Paseo's fixes by merging `getpaseo/paseo` `main` once a week. Shared Paseo
defects are fixed upstream and arrive through this merge ([CLAUDE.md](../CLAUDE.md#critical-rules)).
The vendored OpenCode fork in `arena-backend` has its own upstream and is not covered here.

## Cadence

One sync a week. Upstream lands 100–180 commits a week, and a week of them leaves a few dozen
files to resolve by hand. Skipped weeks pile up: the first sync after the fork took 1,206 commits
and 670 conflicted files.

## Land it as a merge commit

The sync PR is the one PR that is not squashed. Its merge commit records upstream as a parent, so
the next `git merge upstream/main` starts from this week's upstream commit and sees only the new
ones. A squash drops that parent; every later merge would replay all upstream history since the
fork and conflict on everything resolved before. The `main` ruleset allows only squash today, so
the sync needs merge commits allowed for it.

## Run it

1. Cut a worktree from the current `origin/main` on `chore/upstream-sync-<yyyy-mm-dd>`.
2. `node scripts/upstream-sync.mjs prepare --out <file>`. It fetches `upstream` (adding the remote
   if missing), refuses a branch that does not contain `origin/main`, merges with `zdiff3` markers
   and rerere, and applies the policy below. The report lists every upstream commit by bucket and
   the files still in conflict.
3. Resolve what is left (rules below).
4. `node scripts/sync-workspace-versions.mjs && npm install` to regenerate the lockfile on our
   version line, then `npm run build:server`, `npm run typecheck`, `npm run lint`, and the
   targeted tests of the files you resolved. Compare failing tests with the same files on `main`
   before blaming the merge; some fail there already.
5. QA in Electron with stubbed models ([QA](qa.md)): a battle turn through vote and apply, a reply
   after the vote, a Battle off chat, the side panel, the OpenRouter key in Settings, and a
   relaunch that restores the last chat. Add checks for each "Needs review" area the report lists.
6. Open the PR with the report's summary and review sections as the body.

`node scripts/upstream-sync.mjs report` prints the same commit report without touching the tree;
`--from <rev>` previews another range.

## Policy

`scripts/upstream-sync.mjs` holds the lists; change them there.

- **Drop** — Paseo surfaces Agent Duel removed: the website, public docs, mobile and store
  release, Hub, Schedules, heartbeats, host pairing, the diagnostic report, the in-app changelog,
  upstream's built-in plugins, upstream's release workflows. Upstream edits and additions there are removed by `prepare`. A
  file Agent Duel deleted stays deleted even when upstream kept editing it.
- **Ours** — files Agent Duel owns outright: licensing, the root guides, CI and release workflows,
  the app config, the Arena and account docs. `prepare` keeps our side.
- **Review** — battle bridge (OpenCode provider, session, protocol), the desktop shell, workspace
  layout and sidebar, the new chat and composer, settings, and dependencies. These merge
  normally, and each one gets a reviewer's read and an app check.
- **Take** — everything else merges as upstream wrote it.

## Resolving conflicts

- Keep upstream's structure and re-apply the Agent Duel change on top. Do not revert an upstream
  refactor to make an old diff apply. Put Agent Duel branches in their own helper, so upstream's
  body stays close to upstream and the next merge is smaller.
- Battle behavior, BYOK and hosted modes, the control plane, desktop-only decisions and the
  Agent Duel name win where the two sides truly collide. `@getpaseo/*` package names and
  `PASEO_*` variables stay.
- When upstream solved a problem Agent Duel had patched, take upstream's version and drop ours.
- Keep both sides' tests.

## What a clean textual merge still breaks

Typecheck catches most of these; the rest show up only in the running app.

- Upstream files added next to removed features: imports of deleted modules, i18n keys Agent
  Duel dropped, routes and settings sections that no longer exist. Delete the file or cut the
  reference.
- Strict schemas that do not know Agent Duel's fields. A persisted-state schema that rejects an
  unknown key wipes the user's saved state on read (the workspace layout's side panel and Arena
  terminal tabs needed adding).
- Authorization tables keyed by message type: every Arena RPC needs an entry, or the daemon
  refuses it at runtime.
- CLI and daemon interface changes that Agent Duel's scripts call: `packages/desktop/scripts`,
  the dev-home helpers and the local QA kit.
- Theme token renames. A token whose value moved silently resizes Agent Duel's own screens; move
  Agent Duel's uses to the token with the old value.

## Declining an upstream feature

When the team decides against an upstream feature, remove its entry point in Agent Duel code
(the route, the menu item, the setting) instead of reverting upstream's files. A revert conflicts
again the next time upstream touches those files. Record the decision here.

| Feature                                                       | Decision                                                                              | Where it is cut                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Send behavior setting                                         | Enter steers a running turn, Cmd/Ctrl+Enter queues; no setting (2026-10-24)           | `packages/app/src/composer/index.tsx`                                                          |
| Provider account usage                                        | Not shown; Agent Duel does not use local subscriptions (2026-10-24)                   | `components/context-window-details.tsx`; the sidebar's Usage item has no setting to turn it on |
| Sidebar head rows (New workspace, History, Search, Schedules) | Agent Duel's head (Home, Chats, Archived) stays                                       | `components/sidebar/sidebar-nav-rows.tsx` renders plugin items only                            |
| `changes_tree` tab                                            | Hidden; the side panel's Changes keeps the list with its optional tree (2026-10-24)   | nothing opens it; the side panel launcher and `+` menu open `changes`                          |
| Terminal profiles in the tab launcher                         | No profile UI                                                                         | `workspace-tabs/launcher/index.tsx`                                                            |
| Host filters (plugin screens, Usage, label manager)           | One host                                                                              | removed from those screens                                                                     |
| Built-in plugins (usage sources, Antigravity, Hoplite, Muse)  | Not shipped; they require Paseo 0.9.2 or newer and failed on every start (2026-10-26) | `plugins/` is dropped; `server/plugins/builtin/index.ts` lists none                            |
