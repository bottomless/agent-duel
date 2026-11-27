# Upstream sync

Agent Duel merges upstream [OpenCode](https://github.com/anomalyco/opencode) into `arena-backend/`
once a week. Paseo syncs have stopped ([Paseo](#paseo)).

## Cadence

Sync once a week, to OpenCode's newest release tag. Upstream lands several hundred commits a week;
v2.2.6 to v2.3.2 (568 commits over 12 days) left 8 source files and 2 tests to resolve by hand. When
you are more than one release behind, go straight to the newest tag. Stepping through the tags in
between conflicts on the same files at every step.

## How the history fits

`arena-backend/` is a subtree of OpenCode. [#184](https://github.com/bottomless/agent-duel/pull/184)
joined the histories with a one-time `-s ours` merge of upstream v2.0.32, and every sync since merges
an upstream tag with `-X subtree=arena-backend`. The merge base is the last synced upstream commit, so
a merge sees only upstream's new commits.

Release tags sit on release branches. The merge base is the previous tag's parent on upstream's
`dev`, so every kept `package.json` conflicts on its `version` line. The cleanup script resolves
those.

## Run it

1. Cut a worktree from the current `origin/main` on `chore/opencode-v<version>`. Use the Bun version
   pinned in `arena-backend/package.json`; another Bun rewrites `bun.lock`.
2. Fetch the new tag and the previous one, then merge without committing:

   ```bash
   git fetch --no-tags https://github.com/anomalyco/opencode refs/tags/v<previous>:refs/oc/v<previous> refs/tags/v<version>:refs/oc/v<version>
   git -c merge.conflictStyle=zdiff3 merge -X subtree=arena-backend -X no-renames --no-commit refs/oc/v<version>
   ```

   Without `-X no-renames`, git pairs the upstream packages we deleted with our own packages as
   renames and moves upstream files into the engine. The cost: when upstream renames a file we
   patched, the merge shows it as changed by us and deleted upstream, plus a clean add, and you port
   the patch to the new file by hand.

3. Run `scripts/opencode-sync-cleanup.sh`, with `--dry-run` first to preview. It deletes what
   upstream ships outside the keep-list, resolves the `package.json` conflicts that are only the
   version line, and prints the conflicts left. A path it reports as not on the known-removed list is
   a new upstream package or root file: decide whether we ship it, and add it to the keep-list or the
   known-removed list in the script.
4. Resolve the rest ([rules](#resolving-conflicts)). Rerun the script once the root `package.json`
   is resolved; its last check lists kept packages that depend on a package we don't ship.
5. Take our `bun.lock` (`git checkout --ours arena-backend/bun.lock`) and run `bun install` in
   `arena-backend` to add upstream's dependency changes. `bunfig.toml` installs only versions
   published at least three days ago, so a newer upstream dependency goes in
   `minimumReleaseAgeExcludes` (v2.3.2's `@opencode/pty` packages). `bun install --frozen-lockfile`
   must pass afterwards.
6. Set `version` in `arena-backend/packages/opencode/package.json` to the tag. Battle records carry
   it as the OpenCode version ([deployment](deployment.md)).
7. Commit the merge locally as `chore(arena-backend): merge upstream OpenCode v<version>` and check
   that no vendor patch was lost ([below](#check-the-vendor-patches)).
8. Test it ([below](#test-it)).
9. Open the PR. Its body lists what we took, the upstream changes that needed work on our side, and
   what we left off.

## Resolving conflicts

- Battle behavior belongs in `packages/opencode/src/arena/`. A change to one of upstream's packages
  (Core, server, plugin, util) is a vendor patch that every sync has to carry. Keep it small, put it
  in a module of its own where you can (`core/src/session/subagent-hold.ts`), and mark it with an
  `Agent Duel vendor patch:` comment that says why.
- Keep upstream's structure and re-apply our change on top. Do not revert an upstream refactor to
  make an old patch apply.
- When upstream fixed what a patch did, take upstream's version and drop the patch.
- On a conflict, `arena-backend/AGENTS.md`, `README.md` and `.oxlintrc.json` keep our side. Merge
  `package.json` and `bunfig.toml` by hand. Resolve `.gitattributes` first if it conflicts: its
  markers make every git command warn.
- Keep both sides' tests.

### Check the vendor patches

Right after the merge commit, compare the files we changed in upstream's packages before and after
it:

```bash
P=(packages/core packages/server packages/plugin packages/util packages/schema)
git diff --name-only refs/oc/v<previous> HEAD^1:arena-backend -- "${P[@]}" > before.txt
git diff --name-only refs/oc/v<version> HEAD:arena-backend -- "${P[@]}" > after.txt
comm -23 before.txt after.txt
```

Each file it prints carried a patch before the merge and matches upstream after it. Account for
each one: the patch moved, upstream absorbed it, or a resolution dropped it.

## What a clean merge still breaks

Typecheck and the engine tests catch API breaks. These need a read of upstream's changes and a
battle:

- **Message IDs.** The vote graft gives the winner's messages new IDs, so upstream state that points
  at a message by ID breaks after a vote. v2.2.6's compaction `keepID` lost the prompt of a turn that
  compacted mid-turn. Check every new field that holds a message ID.
- **New synthetic messages.** Contestants and retries are forks of the chat, and the graft copies
  their messages into it. Check what upstream adds to a session on its own (v2.3.2's fork notice).
- **New defaults.** Upstream turns on features that change a battle (v2.3.2's background
  compaction). Compare the requests a contestant sends before and after the sync: the tools, the
  system prompt, the messages, and any request after the turn.
- **Blinding.** A new part or message field can carry the model's identity. Add it to
  `PRIVATE_KEYS` in `packages/opencode/src/arena/v2-privacy.ts` (v2.2.6's `native`;
  [blinding](arena.md#blinding)).
- **Processes.** A side's commands, servers and subagents end with it: the loser's on the vote, the
  winner's on the next send, both on Stop. In v2.3.2 shells moved into a pty daemon that outlived the
  side's Location.
- **When a side finishes.** The vote waits for both sides to finish. Work upstream lets outlive a
  tool call (a background command, a subagent) has to join that wait or be dropped on purpose
  ([a turn](arena.md#a-turn)). v2.3.2 moved a timed-out command to the background, and the side
  ended before its result arrived.
- **The test harness.** A service an upstream tool starts reading breaks every engine test that
  builds that tool (v2.3.2's write tools read Config and Flag).

## Test it

1. `npm run build:server`, `npm run typecheck` and `npm run lint`, then CI's engine typecheck from
   `arena-backend`:
   `bun turbo typecheck --filter=opencode --filter=@opencode/core --filter=@agent-duel/arena-service`.
2. Run every `packages/opencode/test/arena/*.test.ts` file one at a time
   ([testing](testing.md#running-tests-locally)), on the branch and in a worktree of `main`, each
   file's output to its own log, and compare the pass and fail counts. Some fail on `main` already. A
   hand-picked list missed three broken files in v2.3.2. Also run Core's tests for the Core files you
   resolved.
3. Compile the engine with `npm --prefix packages/desktop run build:arena-runtime`, which writes
   `packages/desktop/dist/arena/agent-duel-arena`. `npm run dev:desktop` runs the engine from source,
   so a bundling bug shows only in a compiled engine: v2.2.6's crashed at start on every platform
   after passing every source run.
4. Run the desktop stack on the compiled engine with stubbed models ([QA](qa.md)):

   ```bash
   PASEO_ARENA_BACKEND_EXECUTABLE="$PWD/packages/desktop/dist/arena/agent-duel-arena" \
     XDG_DATA_HOME="$PWD/.dev/paseo-home/xdg-data" \
     OPENCODE_ARENA_BUILD_SHA="$(git rev-parse HEAD)" \
     npm run dev:desktop
   ```

   The engine refuses a database outside the dev home, and a compiled engine cannot read the commit
   from git. Check a battle with a background command (the loser's process ends on the vote, the
   winner's on the next send), a background build the side waits for, a second turn and vote, Stop
   during a command, a reply with Battle off, a relaunch that restores the chat, and each
   contestant's request (the same tools, nothing new from upstream).

5. A few battles on real models. Test on Windows too when the sync touches shells or processes:
   Windows runs shells without the pty daemon.

## Land it

Never squash a sync. A squash drops upstream's parent, and the next merge would replay all upstream
history since v2.0.32. The `main` ruleset allows only squash merges, so a sync lands by
fast-forward:

1. Merge `main` into the branch. Do not rebase it: the branch holds upstream's commits, and
   rewriting them needs a force push.
2. Push, wait for CI, and get the review. The push in step 3 skips the PR's required review.
3. `git push origin <branch head>:main`, without `--force`. Git refuses it if `main` moved; merge
   `main` again and retry. GitHub marks the PR merged once `main` reaches its head.

CodeQL flags upstream's own code on each sync. Leave those alerts; a fix there is a vendor patch
every sync has to carry. GitHub's generated release notes came out empty for beta.21, which carried
two fast-forwarded syncs; write such a release's PR list by hand. After the sync lands, update the
OpenCode version in the hosted leaderboard's FAQ.

## OpenCode features Agent Duel leaves off

Record each decision against an upstream feature here, with where it is cut.

| Feature                                      | Decision                                                                                                                                  | Where it is cut                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fork notice (v2.3.2)                         | Off; it tells a contestant another copy may be running, and the graft would copy it into the chat (2026-11-19)                            | `core/src/plugin/internal.ts` (vendor patch)                                                                          |
| Background compaction on by default (v2.3.2) | Off; it would be a paid request after the turn, and Arena compacts on its own ceiling (2026-11-19)                                        | `core/src/config/plugin/compaction.ts` (vendor patch)                                                                 |
| CLAUDE.md fallback (v2.3.2)                  | Only with imports, where the user's switches decide ([instruction files](agent-plugins.md#instruction-files)); off otherwise (2026-11-25) | `routeOptions` in `opencode/src/server/server.ts`; `core/src/config/imported-setup.ts` and its readers (vendor patch) |
| OpenCode Console connection (v2.0.32)        | Off; it sent the user's OpenCode key to the Console each minute; org rules could reach battles (2026-11-25)                               | `core/src/plugin/internal.ts` (vendor patch)                                                                          |

## Paseo

Paseo syncs stopped after [#210](https://github.com/bottomless/agent-duel/pull/210), which merged
Paseo's `main` up to `68818067f2` on 2026-11-13. Port a Paseo fix by hand when you need it.
`scripts/upstream-sync.mjs` still holds the lists that sync used.

Before porting from Paseo, check the features Agent Duel declined:

| Feature                                                       | Decision                                                                              | Where it is cut                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Send behavior setting                                         | Enter steers a running turn, Cmd/Ctrl+Enter queues; no setting (2026-10-24)           | `packages/app/src/composer/index.tsx`                                                                         |
| Provider account usage                                        | Not shown; Agent Duel does not use local subscriptions (2026-10-24)                   | `components/context-window-details.tsx`; the sidebar's Usage item has no setting to turn it on                |
| Sidebar head rows (New workspace, History, Search, Schedules) | Agent Duel's head (Home, Chats, Archived) stays                                       | `components/sidebar/sidebar-nav-rows.tsx` renders plugin items only                                           |
| `changes_tree` tab                                            | Hidden; the side panel's Changes keeps the list with its optional tree (2026-10-24)   | nothing opens it; the side panel launcher and `+` menu open `changes`                                         |
| Terminal profiles in the tab launcher                         | No profile UI                                                                         | `workspace-tabs/launcher/index.tsx`                                                                           |
| Host filters (plugin screens, Usage, label manager)           | One host                                                                              | removed from those screens                                                                                    |
| Workspace diff pill above the composer                        | Not shown; the checkout's diff is neither contestant's work (2026-11-10)              | `panels/agent-tracks.tsx` does not render `WorkspaceDiffStatPill`; `agent-panel.tsx` reserves no space for it |
| Built-in plugins (usage sources, Antigravity, Hoplite, Muse)  | Not shipped; they require Paseo 0.9.2 or newer and failed on every start (2026-10-26) | `plugins/` is dropped; `server/plugins/builtin/index.ts` lists none                                           |
| First-run setup modal                                         | Not shipped; Agent Duel's welcome screen is the first run (2026-11-12)                | `packages/app/src/onboarding/` is dropped; startup in `app/_layout.tsx` does not wait for it                  |
| Send shortcut setting                                         | No setting; Enter steers, Cmd/Ctrl+Enter queues (2026-11-12)                          | `composer/index.tsx` passes `sendShortcut="enter"`; the Sending settings section is not here                  |
| Sidebar footer overflow menu (Usage, Hosts, Help)             | Not shipped; Agent Duel's footer icons fit the minimum sidebar width (2026-11-12)     | the overflow menu files are removed; `left-sidebar.tsx` renders Agent Duel's footer                           |
| Voice settings page                                           | Not shipped; the composer mic (dictation) keeps working as before (2026-11-13)        | `packages/app/src/screens/settings/voice/` is dropped; `HOST_SECTION_SLUGS` has no `voice`                    |
| Idle runtime release after an hour                            | Not for Arena chats; a battle waiting for a vote looks idle (2026-11-12)              | `OpenCodeV2Session.canStopRuntime` returns false in Arena mode                                                |
| Folding finished turns by default                             | Off by default; "Collapse tool calls" stays the default chat display (2026-11-12)     | `DEFAULT_CLIENT_SETTINGS.chatDisplay` in `hooks/use-settings/storage.ts`                                      |
| Chat outline (prompt minimap on the chat's left)              | Removed; it covered battle cards and read as IDE chrome (2026-11-13)                  | `agent-stream/view.tsx` neither loads nor renders it; Settings has no Chat outline switch                     |
