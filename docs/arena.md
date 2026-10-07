# Arena

How a battle runs, from prompt to applied result. This is the product; everything else in this
repository is the Paseo shell it runs inside.

The engine is `arena-backend/packages/opencode/src/arena/` — a module inside a vendored OpenCode
fork, isolated from the root npm workspace and installed with Bun. Packaged desktop launches a
compiled copy; source development launches it from `PASEO_ARENA_BACKEND_ROOT`. The daemon exposes it at `/arena/...`
(`packages/server/src/server/agent/providers/opencode-agent.ts:3282`), which the protocol wraps as
`arena.*` RPCs and `packages/app/src/arena/` renders.

Arena state is canonical local data. The runtime stores it in SQLite at
`$PASEO_HOME/arena/arena.sqlite` and keeps artifact bytes in
`$PASEO_HOME/arena/artifacts/sha256/`. The default home is `~/.paseo`; source development can
override it with `PASEO_HOME`.

The battle routes (assignments, the contestant OpenRouter proxy, and the comparison) live in
`arena-backend/packages/arena-service`. Where they run depends on the build, and one build never
switches between the two:

- **Hosted** is the official build, configured with `PASEO_CONTROL_PLANE_URL` and the session
  public key. The control plane, in a separate private repository, owns the contestant pool,
  assignment mapping, and OpenRouter routing, and serves these routes with its own account check,
  storage, pool, and key. The desktop receives opaque assignment IDs; only the control plane reads
  the actual model profiles and its credentials.
- **BYOK** is a source build with no control-plane URL. It has no sign-in and no control plane. The user
  pastes an OpenRouter key in Settings, the daemon holds it in memory and hands it to the engine
  through the [startup pipe](accounts.md#how-the-session-travels), and the engine answers the routes
  in process against its SQLite store with that key and `defaultPool`
  (`arena-service/src/default-pool.ts`). Never put the key in an environment variable or a file:
  contestants run unsandboxed as the same user and can read both.

The engine reaches the routes through `arena/backend.ts`, which keeps the control plane's paths in
both modes, so no caller branches on the mode. The rest of this doc says "control plane" for the
routes; in a BYOK build read it as the in-process service.

After local writes, a hosted runtime selects small research snapshots and uploads them in the
background to the authenticated control plane at `PASEO_CONTROL_PLANE_URL`. Upload failures are
logged and dropped. There is no persistent upload queue, retry, or backfill, so local history and
recovery continue when the control plane is unavailable. Account sessions are verified
locally with the embedded public key, and signing out does not delete local data. A BYOK build
creates no uploader, so nothing it records leaves the machine.

Research uploads include chats, turns, runs, generation metadata, structured events, comparisons,
single-agent ratings, session archives, and transcript or patch artifacts. Raw events and per-call
full request, response, tool-output, and other artifacts stay local. A research request is limited
to 3 MiB and a record to 2 MiB; oversized records are logged and dropped while the local copy stays
intact. The control plane still owns authentication, the OpenRouter proxy, and research
ingestion.

A transcript holds its images inline, so a few large ones put it over the record limit. Its research
copy carries each image as its own `images` record, named by the SHA-256 of its bytes, and refers to
it as `arena-image:sha256:<hash>`, with `imageIDs` listing them; both sides share a battle's images,
so each is uploaded once. The control plane refuses a whole batch that names a collection it does
not know, so deploy it before a desktop build that sends a new one.

## Live synchronization

The current chat and each opened historical turn are separate watch targets.
Share one backend SSE connection per target and signed-in account, and one React Query record per
window. The daemon delivers updates only to the subscribing socket; closing a
window must not close another window's watch.

The daemon supplies the resolved account when opening a stream. A first watch
can create or claim the chat, so it must preserve the ownership contract in
[data-model.md](data-model.md) without an extra transcript read. Recheck canonical checkout availability when an existing
chat opens a stream. While blocked, the stream’s existing maintenance timer checks for
a filesystem repair once a second and publishes recovery without rereading transcripts.

Begin with a redacted snapshot, reconciled with events received during the read
and unfinished token text held in memory. Then apply messages and parts by ID.
Append text only at its expected UTF-16 offset, batching for at most 100 ms. Keep this
live overlay separate from durable event compression: token transport must not
turn into one SQLite write per token. Control state does not reread transcripts;
service discovery runs separately about once a second and publishes changes.

The stream carries a generation and increasing sequence. Ignore duplicates;
resynchronize on a gap, invalid text offset, disconnect or overflow. Version one
has no durable replay: reconnect with a fresh snapshot that includes unfinished
text. Keep the last content visible while retrying with a 1–30 second backoff.
Invalidate the old subscription before a battle action, show its response
immediately, and resubscribe whether that action succeeds or fails.

Keep history caches within active subscriptions and rebuild them on reconnect;
turn mutations and writes through another SQLite connection invalidate the cached history.

A subscriber acknowledges each delivered packet before receiving the next.
Keep the initial snapshot outside its pending change buffer. More than 256
pending packets or 4 MiB resets that subscriber; other subscribers continue.
Release upstream readers, queues and timers when the last subscriber leaves.
The request/response pairs are `arena.stream.subscribe`, `unsubscribe` and
`ack`; `arena.stream.update` carries the data. App and daemon ship this contract
together. Canonical winner hydration belongs to the daemon and is shared across windows per
active agent. Hydrate each applied winner once after the chat becomes ready; serialize
different winners and leave failed hydration eligible for retry. A reconnect or another
state packet must not rebuild an already hydrated winner.

## What this is for

One prompt, two agents, one worktree each, and a vote. The winner's work becomes the chat's real
history and the loser's is discarded. Battle mode is on by default; the single-agent path is the
escape hatch for when you already know what you want done.

The voter is a developer getting work done who happens to get two attempts to choose between, not a
benchmark operator scoring models. Optimize the UI for deciding quickly and moving on: the two
results side by side, the difference between them legible, and every decision in one place. The
battle card in the transcript is for reading. The contestant responses and their inline review
share one surface, without another Responses/Review switch. The response panes keep a fixed
resting height and scroll internally. A small arrow appears when the reader scrolls away from the
latest output. The battle uses no side panel tab: the card has the chat's width, and a panel beside it would only
narrow the card to show the same thing.

Review has two tabs: **Difference summary**, the generated comparison, and **Changes**, the file rows with git's
status for each pair and the selected file's diff right there. A ready summary opens first. When
the review opens before the summary is ready, Changes stays open after it arrives. Changes
retries a failed read twice before showing a small manual retry. The summary generator retries
transient network and service failures
up to three attempts, while permanent failures such as payment or credentials remain actionable.
Identical file results say nothing about whether the contestants' text answers agree. The threads
are the headline and the review is their complement, so the review must never outweigh the agent
headings above it: the tabs are text in a strip across the
card with a 1px baseline (`battle-review.tsx`), the selected one in foreground at medium weight
with a 2px underline sitting on that baseline, the other muted, so the strip reads as the heading
of the section under it rather than a control floating in it; the summary renders as compact
Markdown with flat headings (`flatHeadings` on `MarkdownRenderer`) so its headings sit one step
above the body while the prose keeps the regular text colour, since muted prose was hard to read, and with
its paragraphs capped at the reading measure (`proseMeasure`) while the differences table keeps
the card's width, since a 1000px line of 14px prose is unreadable; and the diff's layout toggle
uses the `xs` tier like the A | A+B | B control inside it. The agent names are the largest type
on the card. The judge is asked for a short report (`arena/comparison.ts`,
`arena-comparison-v10`): what each agent did, including shared violations of the task, then a table of where they differ, and nothing else.
The card shows it whole; only a report that measures longer than a screen of the card folds to its
opening with `Show full summary` (`verdict-body.tsx`). Trimming at the prompt was Michael's call:
the fold spent latency on prose the voter then had to unfold. The status is `git merge-tree
--write-tree` of A and B over the frozen base (`arena/git.ts`, `compare`), with
`merge.conflictStyle=zdiff3`, so `diverging` means a real merge conflict and `compatible` means both
touched the file in different places; no client heuristic decides it. Review each contestant against the frozen original, with corresponding regions aligned across
A and B. A change made by either contestant must stay visible in the comparison; fold only
context that neither changed. Keep shared additions and removals visible even when the entire
results match, and label them `Both`. The voter still needs to see what will be applied.

The comparison has two layouts, **Side by side** and **One column**, shared by the active card and
archived battles (`inline-file-diff.tsx`). In one column, show A and then B for each region so an
extra change stays near the other contestant's corresponding code. Width chooses the layout until
the reader does; the choice holds for the chat. **Expand** shows one contestant's changes from the
original at the full width of the card. It is the same icon-only action as the pane header's, so
the diff and the panes share one affordance; in the one-column layout the two icons carry their
side's colour, since no heading sits beside them. **Back to comparison**, the matching icon or
Escape, restores the reading position and keyboard focus. Keep this inspection inside the
conversation; it is separate from the panes' expand control. [Design](design.md) owns the diff's
colour and control conventions.

Keep alignment bounded. Try the ordered sparse matcher after the matrix budget, including when
aligning additions at the same original position. If both budgets are exhausted, show a bounded
replacement from the original with a notice. Do not infer shared edits from text found elsewhere
in the file. An unknown payload is not an empty version: distinguish an absent file from content
the daemon did not send. Retained windows must remain separated and missing changes must be named.
If their correspondence cannot be recovered, say that the comparison is unavailable.

Git's merge remains the source of the per-file statuses. `divergence` is part of every comparison:
equal trees merge to either tree, and a merge-tree failure fails the comparison like any other git
failure. merge-tree writes its trees and blobs into the canonical repository as unreachable
objects; the same inputs give the same OIDs, and gc prunes them.

Bound comparison work across review requests and end-of-battle utilities; both share the
runtime with contestants. A deadline or metadata limit must fail the comparison instead of
presenting partial evidence as a complete result.

While the contestants work, each pane reads its thread with the work summarized inline (PR #57's
activity groups, behind the `toolCallDetailLevel` setting). The battle is one card
(`packages/app/src/arena/battle-view.tsx`). Up to `ARENA_MAX_CONTENT_WIDTH`, twice the chat's
reading column, it runs edge to edge, keeping only its top and bottom borders; a 14" MacBook Pro
never exceeds that. On a wider panel each pane would outrun the reading column, so the battle is
a bordered, rounded card centered at that width. `ArenaContentColumn` measures the host
and decides. Everything in the battle shares the card's width — the two threads and the Changes
review — so the page has two widths: the chat's reading column for the prompt and the
composer, and the card for the battle. Inside the card, sections separate with
one top border each, the way rows in a settings card do, and text starts on one rail. A and B each
occupy half the card, split by a divider; below 520px of available card width, they stack.
The panes keep a fixed resting height and their threads scroll internally. Scrolling away pauses
following; reaching the bottom or choosing Jump to latest resumes it. Each agent header has an
expand button beside its worktree control to give that thread the full card width; restore returns
to the split. Both are
pane chrome at the ghost `xs` tier, borderless and the same height. Headings have no status
indicators; the status text below each heading reports progress. In the thread, the work summary
rows (`Read 3 files · Ran 4 commands`) match the 14px prose they follow and hug their icon, so a
muted summary never outranks the text, and the thread keeps one 12px rhythm between a text, its
summary, and the next text; uneven spacing around the summary read as lopsided. Changing the view
keeps both panes mounted, so each pane keeps its reading position and pending permission UI. Keep
the active battle open and its threads height-limited so the prompt and composer remain
reachable. The card has no link back to the history: the conversation is right above it.

The composer stays available while a running or completed contestant can accept a reply. Who it
goes to is a `Both | Agent A | Agent B` segmented control (`Both | A | B` on a compact composer)
at the composer's leading edge (`reply-target-control.tsx`), replacing the disabled Battle
toggle during an active battle, so the target is visible before typing rather than hidden in
a menu by the send button. Both is the default and the common case; A and B take their side's
tint, the colour of that pane's Choose button. A side that cannot take a message right now is a
disabled segment, not a missing one. Both stays enabled while both runs can take a message,
including when one has finished and the other still works: the engine resumes the finished side
and steers the working one with the same message, so Both is not cleared each time one contestant
finishes first. Keep the selection per turn in `reply-target-store.ts`, including across chat
navigation and app restarts: a retained draft must not silently acquire a different recipient.
The placeholder names the target
and the verb (`Steer Agent A`, `Ask both a follow-up before choosing`) and the send button carries
the verb. If the selected target stops being valid, keep the draft, clear the selection, and
require another pick instead of rerouting it. Prompts and replies carry attachments (see
**Attachments** under [A turn](#a-turn)). The toolbar stays on one row.
When its own available width is narrow, shorten the target labels, show tool permissions as a
status icon, and use the send arrow; retain the target-specific placeholder and accessible labels. Tool permissions use a quiet
status menu: `Auto Accept` or `Ask before tools`. Its description names the scope and explains
that enabling Auto Accept also accepts pending requests; explicit deny rules still apply.

The vote lives in a centered sticky pill above the composer: `Choose A`, `Tie`, and `Choose B`.
Anchor it over the transcript above the composer, with a gray surface inside the pill and a
transparent, click-through area around it. It stays reachable while reviewing either thread or
the diff. A stopped battle uses the same pill for `Keep A`, `Discard`, and `Keep B`; an early
choice while the battle runs sits there too. While neither result is selectable, show one `Stop`
button. When one result becomes selectable, put `Choose A now` or `Choose B now` in its side
and `Stop` in the other side.
Choosing early stops the other side, so it confirms first. Discarding a stopped battle also
requires confirmation. Action failures remain on the battle until another attempt; the normal
action controls provide the retry so a destructive operation is never retried automatically.
`Choose A` and `Choose B` carry their side's colour as a tint, the blue and amber of the diff's
column headings, so the vote reads as picking that column; two choices of equal weight mean
neither can be the accent. `Tie`, `Stop`, and `Discard` stay plain. Transitional and recovery
states still use the **decision bar** (`packages/app/src/arena/decision-bar.tsx`) in the composer's
slot.

Contestants are blinded so the vote lands on the output rather than the label. That is why the
blinding has four layers instead of one hidden field, and why something as small as the shape of a
tool-call ID counts as a leak — a voter who recognizes the model stops judging the diff.

Product decisions that are settled, so they do not get relitigated per feature:

- The pool is fixed and small. Choosing models per battle is not a goal.
- Both results are kept until the vote; nothing is auto-selected.
- A vote is final. There is no rematch on the same prompt.
- The loser's work survives only as a git ref, not as anything the UI offers to recover.
- Contestant text stays prominent. Tool calls and reasoning fold into an expandable activity
  summary beneath the text update they belong to; complete details remain available inside it.
- Questions stay in the conversation after submission, with each answer beneath its prompt.
  Keep the exchange outside folded activity and between the work before and after it, including
  in archived battles and the applied winner's conversation. Interrupted questions remain visible
  as unanswered.
- Completion notifications are for a voter who is elsewhere. Announce each completed agent and
  the pair once its summary settles. Desktop notification settings let the voter disable either
  category independently; sound has its own setting. Sidebar and Dock readiness do not wait for
  the summary or depend on these preferences. Watching that chat suppresses the alerts.
- Focusing an app window clears Dock attention. Keep the sidebar's pending decision until the
  vote, and show the last known decision when disconnected rather than treating it as complete.
- Task checklists belong to one contestant in one battle. Keep their updates in that contestant's
  activity and pin their latest progress below its scrolling transcript while it runs. When the
  run ends, keep the final checklist at the end of its transcript. A finished or stopped run can leave tasks
  unfinished; preserve that record without presenting it as ongoing work or carrying it into the
  composer's next turn.

Inherited from Paseo and **not maintained here**: releases and packaging, native mobile, and the
marketing site. Leave them alone rather than fixing them; report upstream defects separately.

## The canonical spine and contestant environments

A workspace maps to one arena **chat**, which owns three things that move together: the developer's
canonical Git checkout and ref, a canonical OpenCode session, and a hash of that session's
transcript. Every battle starts from that spine and exactly one contestant is applied back to it.
Forking a chat clones that canonical OpenCode session through the selected provider message. A
same-worktree fork creates another workspace backed by the current `cwd`. A new-worktree fork
atomically creates a branch-off worktree and workspace. Both open the forked chat directly. The
copied messages remain native transcript history; they are not flattened into the first battle
prompt.
A battle needs Git 2.38 or newer, and a send refuses an older or missing Git with the command that
fixes it (`requireBattleGit` in `arena/git.ts`). Many Macs still run Apple's Git 2.39 from older
Command Line Tools, so the engine's merges pick their base by parenting wrapper commits on it rather
than with `merge-tree --merge-base`, which needs 2.40. Raise that floor before using a newer Git
option.
A battle needs a `HEAD` to freeze and cut contestant worktrees from, even before any files exist.
New directory creates the repository with an empty first commit before registering the project. For
an existing folder with no Git or no commit, a battle send asks first ("Agent Duel needs a commit")
and then adds the same empty commit; the folder's files and staged changes stay uncommitted, and
contestants still see them through the frozen base. The commit uses the user's `user.name` and
`user.email` when both are set, else `Agent Duel <agent-duel@localhost>`; a new repository takes
`init.defaultBranch`, else `main`. It is made with plumbing and hooks pointed away, so signing,
hooks, and the index cannot block or change it (`packages/server/src/server/project-git-service.ts`).
OpenCode caches each directory's project as Git or not for the life of its server, so the daemon
disposes that directory's OpenCode instance after the commit; without that, a folder a single-agent
chat already opened refuses battles with `WorktreeNotGitError`.
The checkout is the one the workspace was created in. The new-workspace screen's Isolation control
decides which: Local runs in the source checkout, switched to the picked branch, and New worktree
cuts a worktree at the picked ref with a detached HEAD, seeded with the checkout's ignored content
the way a contestant is. That worktree lives at `<project>/.agent-duel/worktrees/<id>`, in the same
excluded directory as the contestants, so deleting the project deletes everything it produced.
No branch is created or checked out, so the ref can already be checked out elsewhere; "Create branch
here" in the workspace menu gives the worktree a branch once its work is worth keeping.

The trunk branch follows the developer. Between turns they can rename it or cut a new branch at the
same commit, so a ready chat re-reads the branch on every canonical inspection rather than keeping
the name it was attached with. A head that moved is a different checkout than the chat's history was
built on; only turn completion and the blocked-checkout restore record that. So when another chat's
vote moves the shared checkout to a new branch and commit, this chat's branch answer keeps
disagreeing with its record, and the stream poll runs the full inspection once per new answer, not
every second.

Chats in the same checkout share its index, so a read must never take `index.lock`: the
lock it holds is the one another chat's vote or prompt needs at that moment. `--no-optional-locks`
covers `status` and `diff`, but `write-tree` always locks the index, so the checkout's index tree is
read from a copy of the index file (`readIndexTree` in `arena/git.ts`).

Contestant worktrees are kept between turns. A chat owns a small pool of **slots** under
`.agent-duel/worktrees/<chat>/`: a linked worktree plus the bare host repository it is registered in
(`<dir>.git`). In steady state the pool holds three: the next turn's pair and the retained winner.
A kept slot keeps its files, so preparing the next turn rewrites only what differs from the new
frozen base. The pool is read from disk, not stored: a slot directory is owned while it is the
worktree of a run without `worktreeRemovedAt`, or part of the chat's current warm pair, and free
otherwise. Only Arena's own worktrees are slots: a `.git` link into the host beside it, whose entry
names the directory back (`isPoolWorktree`). Every contestant sees the pool as `..`, and an agent's
`git worktree add ../x` also leaves a directory with a `.git` link there, one into the contestant's
host. Taken for a slot, it stayed as the pool's spare and every later contestant could read it. So
anything else in the pool goes to the trash, when a pair is prepared after a vote and again before
a turn's contestants start (`sweepSlotPool`), since a retained winner answering a follow-up can
leave one after the pair was prepared.

On macOS, Arena and the daemon set the `com.apple.fileprovider.ignore#P` extended attribute on
`.agent-duel` whenever they create or reuse it, so iCloud Drive and other File Provider sync clients
skip the pool. Synced, the pool's renamed slots and re-cloned ignored files came back as numbered
conflict copies (`.env 2`, `generation-2-a 2.git`), and the provider removed objects from a host
under a running contestant. Nothing ignores a copy like `.env 2`, so snapshots also leave out an
untracked numbered copy whose original beside it is git-ignored and has the same bytes
(`excludeSyncConflictCopies` in `arena/git.ts`); otherwise `add -A` would carry the secret into a
result and on into the checkout.

A slot serves one generation at a time, at that generation's path, `generation-<n>-<side>`. `n`
counts from 1 so the directory reads as the turn number the UI shows; turn indices stay 0-based in
the documents and on the wire. Taking a free slot for the next turn renames it to the new path, so
everything keyed by directory (the OpenCode instance, preview routes and port banks, the service
owner token, terminals) sees a new directory, and a path printed in an older transcript does not
lead to the next contestant's tree. A rename keeps every file's inode, so the index the slot keeps
stays stat-clean.

Taking a slot (`Worktree.adopt`) builds a fresh host for it: a copy-on-write clone of the checkout's
git directory without Arena's private refs (`refs/battles/`, `refs/heads/agent-duel/`,
`refs/agent-duel/`), with the slot's index moved in. The host uses the developer's exact branch name,
or a detached `HEAD` when the developer is detached. The fresh host is what keeps config, hooks,
refs, reflogs and stash equal to the checkout's, whatever a previous contestant did to its
repository. Adopt never follows the slot's `.git` link to find the old host, since a contestant can
rewrite it. The copy still holds every object the checkout has, including earlier turns' losing
results and other chats' results: dropping the refs hides them from `git log --all`, not from `git
cat-file --batch-all-objects`. None of them is the other side of the battle the host serves, which
is what a host must never reach. So do not point a host at the checkout's objects through
`alternates`: a side's result is imported into the checkout while the other side still runs, and
`git fsck` in the other side would show it.

The slot's files are then brought to the frozen base and checked (`syncContestantState` and
`verifyContestantState` in `arena/git.ts`): HEAD and branch identity, index flags (a leftover
skip-worktree or assume-unchanged bit hides a missing file from every other check), index tree,
working tree, exact name case (APFS ignores case, git's index does not), no nested `.git`, one
registered worktree, no private refs. The kept index is trusted only for files whose stat still
matches what the last sync recorded; any other entry loses its stat data first, so git rewrites the
file instead of vouching for bytes a previous contestant left under different checkout rules. Ignored content is re-synced per root (`planIgnoredResync`,
`arena/copy-snapshot.ts`). A root is kept only when neither the checkout's copy nor the slot's
changed since it was cloned: an unchanged root identity on both sides, and an unbroken filesystem
watch on both sides (`arena/environment-watch.ts`), because a root's own identity misses an edit deep
inside it. A directory root written on either side is patched in place when both watches covered the
whole window and named every path written under it (up to `PATCH_PATH_LIMIT` for both sides together,
counting a path under another named path as part of it). Each named path is written again from the
checkout as it stands, whatever the event said, because parcel's event types accumulate flags and
cannot be trusted: a contestant's edit is undone, what it added goes, what it deleted comes back. A
path below a symlink, a file, or a directory one side lacks is written from its nearest ancestor that
is a plain directory on both sides. Either root may move for a patch, since a child added or removed
moves it, but not its inode or mode. The worktree's root must also have changed last through its
entries (ctime equal to mtime): a contestant's root moved away and back, written through its other
name, reports only its return, and the rename moves the ctime alone. A patch never writes into a name
the worktree still holds; if one answers (a name APFS matches but no fold here does), the patch fails
and the root is cloned. Everything else is re-cloned whole too: a write a watch could not name (the
root moved or deleted, an ancestor moved, an event on the root itself), too many paths, a failed
patch. Ignored paths the checkout does not have go to trash.

The per-slot records, journal marks and tracked-file keys live only in the engine process. After an
engine restart the first sync of each kept slot re-clones every copied root, file roots included,
and rewrites every tracked file. To keep that cost off a send, startup recovery takes the most
recently updated chat and, when it is idle with a ready pair and no single-agent pass since its last
battle, prepares that pair again in the background (`rewarmLatestPair`), adopting the same two
worktrees in place under the start lock. A send that arrives meanwhile waits for it and then reuses
the pair. A prompt to the chat's agent that arrives before the build claims the two worktrees makes
it stand down, since the agent's edits would leave the pair stale. Every other chat's pair is
refreshed at its next send: an older chat is less likely to be sent to than to hold up, while its
host copies take the repository lock, a vote or a prompt in the chat the user is in. A slot that
cannot be verified is retired and a new one created.

The loser's slot is released after the vote, and the retained winner's at the next send: services
stopped, sessions and the OpenCode instance disposed, the run marked `worktreeRemovedAt`. The files
stay until the next warm preparation adopts the slot. A free slot that any process still works in (a
terminal left open in it, for example) is retired instead: a rename would carry that process into
the next contestant's tree. Processes are listed a second time half a second later when the first
listing finds one in a free slot, because a released side's services can still be exiting. Failure
paths and discards still remove worktrees; archiving the workspace or evicting its checkout removes
the chat's whole pool. Archive deletes the pool's trash before it answers, because the engine can
stop right after and a background delete stops with it; startup finishes what an interrupted
eviction or archive left.

Each worktree a chat keeps, the retained winner and both warm sides, holds a loaded OpenCode instance
(provider catalog, plugins, tool registry, location services). A ready chat with no open stream for
five minutes unloads them: the instances are disposed and nothing else changes, so the warm pair
stays trusted and the retained winner keeps its services. The next send boots them again, which
`prepareContestant` does for a warm side anyway. The app streams only the chat it shows, so an open
stream is the "in use" signal (`watchChat` in `arena/service.ts`).

- The retained winner keeps its services running until the next send.
- Warm A and B environments have no services until they are needed.
- A human or agent environment transition stops retained services before the next turn and exposes
  retained, warm, and trunk status.

Services are found by working directory, so a terminal opened in a side worktree would look like
one. The sweep skips the process that opened a terminal session — it holds a controlling terminal
its parent does not — and stops what runs inside it as usual. That is what lets a contestant
terminal outlive the turn it was opened in; see [side-panel.md](side-panel.md).

Warm preparation runs once the vote has been applied. Preparing a chat's first pair when the chat is
opened is off by default; `OPENCODE_ARENA_INITIAL_WARM=1` turns it on. The engine cannot tell a
battle chat from a single-agent one, its host copies take the repository lock that normal prompts
also take, and the draft composer sends too soon to use the pair. When it is on, the record lives on
the chat as `initialWarmPreparation` until the first send consumes it, it waits a second before
taking the chat's start lock, it is skipped while the chat's agent is working, and a failure backs
off before the next try. Warm preparation adopts two free slots, or creates one when the pool is
short (the first battle creates a spare in the background while it waits for the vote), and syncs
both at once. Only the pool scan, the host copies, and the final mirror of the hosts take the
repository lock; the file sync, the instances, and the forks run outside it under the chat's start
lock, so a vote, a send, or a prompt in another chat of the same repository does not wait for them.
Arena runs no project start command and no `paseo.json` hook in a slot, so a created slot and an
adopted one start identical. Warm preparation also allocates each successor's port bank and forks
the canonical session into it, paths retargeted, so the send has no transcript to copy. A send uses
that fork only when the pair is trusted in this process and the canonical session, its transcript
hash, and the port bank are unchanged; otherwise it forks then and disposes of the warm one. The
bank is reserved only inside this process, so the send first checks that no other program has taken
one of its ports; a taken port means a fresh bank and a fork at send. The send itself overlaps the
assignment draw with the freeze.

A send reuses the pair when it is trusted in this process and nothing moved since warm preparation:
the checkout's HEAD, branch, index and working tree, its ignored content, the git metadata a host
copies once (config, hooks, `info`, and the stash, notes and replace refs the ref mirror skips), and
both slots. Otherwise it adopts the same two slots again in place, which rebuilds their hosts and
rewrites only the difference.

A cold or refreshed side does not wait for its worktree before the model starts. Its path is known
before staging (the planned slot, or the warm slot it refreshes in place), so the side forks its
session there and sends the first request from the canonical checkout's instance, which is already
loaded. Staging (claim or adopt, git sync, ref mirror) starts once the proxy reports that the request
has left, so it cannot delay it. A slot that must be replaced is claimed again at the same path,
because the request is already bound to it. The canonical instance finds the instruction files and
project skills, so their paths are renamed into the contestant worktree before the request leaves;
the model otherwise reads and edits the checkout by absolute path.

Tools follow a two-phase guard (`session/tool-execution-gate.ts`). Before the base checkout exists,
only tools with no filesystem dependency run: questions, task tracking, web access. Skills wait for
the copy, since the canonical instance would otherwise report the checkout's skill paths. After it,
reads of tracked files, searches outside pending roots, and a short read-only shell allowlist run
while ignored content finishes syncing (Git listings of ignored files, such as `ls-files -i`, wait); calls that could touch a root being copied, replaced, or
removed wait for the sync. Every filesystem tool, snapshot and diff runs in the contestant's own
instance; the canonical instance hosts only the root request, so cancels and steers go to it
(`promptHosts`). Nothing opens an instance at the path before the staged worktree is there: one
opened on the empty reservation would treat it as a directory without git. A refreshed pair keeps
both guards in place until its environments pass the pair comparison. Result finalization waits for
preparation too, because it writes Git state even when the model used no tools. A fully matching
warm pair needs no guard.

Stop does not wait for the copy. It aborts the clone between two `clonefile(2)` calls, the worktree
loses its sync record so its next sync clones every root again, and both sides finalize at once as
stopped sides that can still be kept. A side whose preparation fails is different: tools that passed
the guard before the failure are refused before they run, both sides stop, and the failed side is
marked `blocked` so the stop resolution cannot keep it. Its tree came from an environment that never
became usable and can hold edits no contestant made.

The checkout's ignored content is followed by a journal of FSEvents streams that lives as long as the
chat. Parcel drops a chmod, xattr or owner change on a path its native watcher has already
reported, so the journal renews every stream right before each mark (`renewStream`,
`arena/environment-watch.ts`). Without that, a file made executable in the checkout stays
non-executable in both kept slots, and the pair comparison passes because both sides match.

Each kept slot is followed by its own watch from the end of one sync to the start of the next.
FSEvents replays the last few milliseconds before a stream starts, so a root the sync cloned just
before arrives as an event on the root itself; the slot watch counts such an event only when the
root's lstat identity changed since the watch began. The replay also leaves parcel remembering the
root's mtime, and a root moved away and straight back keeps its mtime, so parcel then drops the move.
A slot watch that let a replay through therefore takes a new native watcher a second
later (`REPLAY_MS`).

The send releases the retained winner (stops its services, records the transition, releases its
slot) without waiting for it, unless one of the winner's ports still accepts connections: a
contestant must not reach the previous preview through a URL in the history. The transition goes to
the report in the UI and never into a contestant prompt, which is what lets the send skip the wait.
A background release that fails marks the run `cleanup_failed`, and the next send retries it.

OpenCode starts a directory's location services and takes its first snapshot on the first prompt
there, and both took 1-3 s after the battle was already `running`. Arena starts them in the
background when warm preparation finishes (`SessionPrompt.prepare`), so a warm send prompts
contestants that are already booted. Cold and refreshed sides do this work in their first prompt,
under the guards described above.

Arena keeps snapshots for recovery but skips OpenCode's automatic per-step diff summaries.
A branch switch can make a JavaScript diff block both contestants for minutes. Snapshot
patches use native Git with time and output limits; battle review owns its separate comparison.

Every turn receives a fresh port bank. Proxy routes are keyed by turn, side, and service, use
`.localhost` hostnames, and never retarget an old URL to a later process.

The transcript hash is what lets the engine refuse to start when git and the transcript have drifted
apart independently — the sign that something edited the checkout behind Arena's back.

### Automatic workspace cleanup

The daemon keeps a soft target of fifteen materialized, app-owned parent worktrees across projects.
Chats sharing a checkout count once. A chat's contestant slots (warm pair, retained winner, free
slots) follow their parent: they have no separate quota or expiry timer. Original source checkouts are outside this policy.

Cleanup runs in the background, oldest chat activity first. Viewing a workspace does not update that
order. Pinned workspaces, foreground work, active agents or terminals, and unresolved battles stay
protected. If no safe candidate exists, the count can remain above fifteen without blocking creation.

Before removing files, cleanup saves the exact commit, staged state, and working files, including
non-ignored new files. Git refs in the surviving source repository retain the snapshot through garbage
collection. Ignored files—including local configuration and databases—and running processes are
excluded. Conflicted indexes and unsupported repository states are skipped. A retained contestant
with newer, unpreserved code also prevents parent cleanup.

Cleanup leaves the workspace and conversation available. Restore files recreates the saved code at
the same path, with a detached HEAD, and never overwrites an occupied directory. It then seeds the
checkout's ignored content from the source the way a new worktree is seeded, so dependencies and
local configuration come back without being stored; seeding failures cost that content, not the
restore. It does not rerun setup or restart services. This is recovery from workspace cleanup, not
a backup against deleting the source repository. The limit controls parent directories, not
snapshot storage or disk bytes.

## A turn

**Start** (`arena/service.ts:2432`). Refuses unless the chat is `ready`, no turn is active, and no
ordinary turn is in flight. Freezes canonical `HEAD` together with the exact staged, unstaged, and
nonignored-untracked state in `refs/battles/<chat>/turn-<n>/base`, then draws a pair. Both agents
work from that frozen state, so later canonical movement cannot shift the ground under a running
battle.

**The draw** (`arena-service/src/pool.ts`). The service draws two distinct profiles uniformly from
its pool; which one lands on side A is part of the draw. It stores the private mapping permanently
in `arenaAssignmentSets` and returns one opaque assignment id per side. The set is account- and
turn-scoped and idempotent for retries. The local turn and run records contain those opaque ids, not
model names or slugs, until resolution. Changing a pool does not change assignments already stored.

In hosted mode the control plane draws from its active model set.
Development is the default and uses `defaultPool`: GLM 5.3 FlashX, Qwen 3.8 Max, and Grok 4.6. Production
uses the [current hosted models](../README.md#current-models). Set `OPENCODE_ARENA_MODEL_SET=production`
on the control plane to use it. The pool, its selection, and `arenaAssignmentSets` stay server-side; the local runtime never
receives model slugs or stable aliases before reveal. A BYOK build always draws from `defaultPool`
and keeps `arenaAssignmentSets` in its own SQLite store, so the mapping is on the user's machine
from the first draw.

**Attachments** (`arena/attachments.ts`, daemon `server/arena/prompt-attachments.ts`). A prompt or
reply takes the same attachments as a chat message, and both contestants get identical parts:

- Pasted images travel as bytes and context attachments (PR comments, reviews) as text. An uploaded
  file of any type travels as Paseo sends it to a single agent: a note with its path under
  `$PASEO_HOME/uploads/<id>/`, for the contestant to open with its own tools. The daemon resolves
  that path from the upload id, never from the client's path. An upload is outside the contestant's
  sandbox (see **Setup**), so before each prompt and reply the engine adds an `external_directory`
  allow for each upload's directory to the contestant session (`allowReading`). An upload sits alone
  in its directory, so that admits the one file, and both sides get the same path.
- Contestants take PDFs. OpenRouter passes one natively to a model that reads PDFs and parses it
  with mistral-ocr for one that does not, so the two sides can read different renderings of the
  same file.
- The engine resizes each image once, at admission, to 1568 px and 600 KB, and names it
  `attachment-<n>.<ext>`. Every model call re-sends the conversation through the control plane,
  whose hosted function takes about 4.5 MB per request, so a message carries at most four images.
  The composer holds a battle message to that count when images are attached and refuses a send
  over it: the engine's refusal comes only after New chat has created the chat.
  An image's own file name never reaches the models, transcripts, or judge.
- Every model in both pools must read images. The control plane's catalog check refuses one that
  does not: excluding it from a draw only when a prompt carries an image would reveal the model.
- The turn keeps labels and a text excerpt, never bytes (`TurnDocument.userAttachments`). The live
  battle shows them inside the prompt bubble as attachment pills, in one row with the image thumbnails,
  the way a single agent's message shows its uploads; the judge, which reads text only, gets them listed
  with the excerpts.
- After the vote the chat's history is the winner's session, which holds the images. The daemon's
  replay sends them with the user message, and each attachment text part carries its label under
  the `arenaAttachment` metadata key, the one text metadata `ArenaPrivacy` keeps, so the history
  shows a chip instead of gluing that text onto the prompt. The app holds replayed images inline and
  leaves them out of the replica cache.

**Setup** (`arena/service.ts`, `executeBattle`). Per side: a slot from the pool (see above) at the
chat/generation path, on the exact developer branch name (or detached `HEAD`), synced to the frozen
state. Nothing else prepares it — `paseo.json` lifecycle hooks and project start commands do not
run, so a contestant gets the frozen tree and the copied untracked and ignored files and no more.
Auto Accept follows the chat's OpenCode feature. The daemon sends its value when admitting a battle;
the engine applies it in each contestant worktree and updates both sides when the toggle changes.
It approves tool prompts that would otherwise ask, including pending ones. Explicit denies still
apply, including the contestant's sandbox.
The session is forked from canonical, set to provider `arena` with `contestant` as its neutral model
id, given its sandbox, and moved into the side worktree. Retarget declared file-tool paths,
attachment paths, assistant locations, literal POSIX Bash arguments, and complete old-worktree path
references in assistant text. Later turns can reuse a path the assistant printed. Keep user prompts,
file contents, unknown tool inputs, and arbitrary output unchanged; a shared path prefix alone is not
enough to rewrite a string. Bash output has two explicit adapters:
the result of a plain `pwd`, and a complete single-line `cd <literal> [&& pwd]` command example. The latter
keeps an executable example from referring to a worktree removed after an earlier vote.
Shell expansions and paths crossing `..` remain unchanged; resolving them requires runtime state.

The sandbox (`arena/contestant.ts`) is the inherited permissions, then a hard
`external_directory: deny`, then allows for what both sides need outside the worktree. Rules match
last first, so the deny overrides the allows every agent gets for `$TMPDIR/opencode`, the truncation
directory and skill directories, and only the rules after it reopen paths. Never turn the deny into
`ask`: a prompt the user answers for one side and not the other makes the sides unequal.

- Skill directories, read-only. The list comes from the canonical checkout's instance, so both sides
  get the same one; project skills are left out because the worktree holds its own copy. An
  `external_directory_write` deny on each keeps file tools and the shell's file commands from
  writing there (`writes` on the permission request). Shell redirection and other programs are not
  checked, as for any path.
- A temp directory per side, `$TMPDIR/opencode/arena/<session id>`, readable and writable. The
  shell exports it as `TMPDIR` and the shell tool's description names it, and truncated tool output
  is saved under it, so the hint to read that file works. The two sides never share it, and it is
  removed when the run's worktree is released (`releaseRunSlot`). Subagents inherit the rules and
  so share their side's directory.

A contestant denied a path outside the sandbox gets one sentence that names the sandbox, not the
generic list of matching rules, which holds dozens of home-directory paths that contestants copy
into their answers and that reach research uploads.

The two sides are prepared **at once**, since each has its own host repository and session, and
the host repository is a copy-on-write clone of the checkout's git directory where the
filesystem allows it. Both are then prompted concurrently; a cold or refreshed side is prompted
before its staging, as described above.

The local OpenCode HTTP server is not an Arena client API. In Arena mode the daemon authenticates
all session and orchestration calls with its private control token, while the OpenCode process keeps
only a one-way verifier. The renderer and browser QA harness continue through the daemon protocol,
and contestants receive neither the token nor an alternate prompt endpoint. Direct prompts to an
unresolved contestant or an active canonical battle session are rejected even when they arrive
from the authenticated daemon. The authoritative route policy and public exception are documented
in [Security](../SECURITY.md#agent-duel-control-plane).

**Finalize** (`arena/service.ts:1705`). Each side settles on its own: terminal state and the actual
Git state are recorded under the generation's private battle refs, numstat is stored, and
applicability is set to `applicable` only when the frozen base is an ancestor of the result. A
companion private ref transports the final index tree. Recording must preserve empty and multiple
commits, commit-plus-residual state, and the index and dirty working tree; Arena does not add a
wrapper commit to the developer-visible history. When both are in, the turn becomes `awaiting_vote`
and the comparison starts in the background
(`arena/service.ts:1968`). A failed comparison never blocks a vote.

## Blinding

A contestant's identity is hidden until the vote lands, and it leaks from more places than the model
field. Each layer has its own file:

- **Assignment** (`arena-service/src/assignments.ts`) — in hosted mode the model pool and
  assignment mapping exist only on the server. The desktop cannot derive the private profile from
  an assignment id, and assignment creation accepts no client-directed model exclusion because
  repeated exclusion draws form an identity oracle.
- **Request** (`arena-service/src/openrouter.ts`) — the desktop can request only the neutral
  `contestant` model. It sends the assignment id and owning scope id through the daemon's
  capability-gated Arena proxy; the Arena process never receives the account session. The control
  plane authenticates the account, requires an exact unresolved account/scope/assignment match and
  then inserts the stored OpenRouter slug, price ceiling, provider policy, and `high` reasoning
  effort. Resolution disables further routing without deleting the assignment.
- **Response** (`arena-service/src/openrouter.ts`) — before bytes return to the desktop, the control
  plane strips model, provider, fingerprint, OpenRouter metadata, and cost, replaces the generation
  id, and collapses upstream failures to a generic error. The local proxy repeats the scrub as a
  defensive boundary. Runtime-only usage and reasoning metadata can continue through that transport,
  but the telemetry copy never persists generation request bodies because system prompts and tool
  schemas can fingerprint the provider. It drops per-side token counts, native finish reasons,
  provider-specific reasoning metadata, identity fields, and raw upstream errors from stored
  responses, and rewrites provider-shaped tool-call ids before saving response artifacts. The
  control plane holds generation usage, cost, and finish reason and returns them only with the
  committed resolution; the desktop then records the research metrics. Local-store startup
  removes those fields and request/response artifacts from legacy unresolved battles; resolved
  history already exposes the contestants by design.
- **Session data** (`arena/privacy.ts`) — the event bridge blinds durable payloads before projectors
  or SQLite see them, and the Arena recorder applies the same transformation before writing raw-event
  artifacts. Live-only stream deltas bypass that work. Active execution keeps only continuation
  metadata and original tool-call IDs in memory, not message text or tool output, and releases the
  overlay when the run is unregistered. Archives and public responses use the blinded copy. The durable copy removes
  provider and model metadata, cost and token usage, flattens errors, and rehashes tool-call IDs to
  `call_arena_<hash>`. Each upstream mints those IDs in a recognizable shape, and xAI's counter
  additionally counts calls the voter never saw (`arena/privacy.ts:72`).
- **System prompt** (`session/system.ts`) — every `arena` session, contestant or single-agent, gets
  a fixed instruction where other providers get the model line: its identity is hidden until the
  vote or a reveal, and it must not guess, name, or look up a model or company. Without it, models answer as
  "opencode" or claim a model they are not, and a strong model can name itself in text the judge
  reads. The text is static because anything assignment-derived would differ between the sides.
- **The judge** (`arena/comparison-timeline.ts`) — sees narrative text and tool name/status only.
  Reasoning is excluded deliberately: it dwarfs the visible text and sends the comparison model
  after differences that exist only in private deliberation.

A BYOK build runs the same layers, so the UI, the stored records, and the judge are blinded the
same way. Nothing enforces it: the user owns the key, the process that routes the calls, and the
SQLite store that holds the mapping. Treat BYOK blinding as a UI convention, and never upload a BYOK
vote.

The comparison uses base-to-agent changes, direct A/B differences, and visible timelines. It uses the dedicated
`POST /api/arena/comparison` route, which accepts only the expected single-message payload for an
unresolved battle scope and always selects `minimax/minimax-m2.7` via groq in the service
(`arena/comparison.ts`). There is no generic or unassigned comparison path through the OpenRouter
proxy.

Keep complete small changes grouped by agent against the base. Do not collapse shared work
or add a third A/B view when both base patches fit: extra directions can reverse attribution.
For large changes, keep base-to-result changes alongside direct A/B differences. The base
establishes who changed what and exposes shared mistakes; A/B differences keep a small divergence
visible beside large generated files. Compare complete JSON before budgeting, preserving numeric
tokens and duplicate keys. Match array records by id only when both arrays have unique scalar
ids; otherwise retain positions. A missing excerpt is unknown. File equality and equal
record counts do not prove correctness or preservation against the task. A complete computed
comparison can establish file-specific facts without sending the raw contents. Summarization
alone is not missing evidence: warn on live and archived summaries only when comparison details
were omitted. Preservation claims must stay scoped to the file and side actually verified.
Use one utility request; increase evidence quality before adding model passes.

## Resolving

- **Vote** at `awaiting_vote` applies that side (`arena/service.ts:4364`).
- **Early vote** while still `running` claims the resolution, then cancels the loser in the
  background until it reports terminal. Ties are rejected here — a tie needs both results. The
  early choice asks before sending one, since the other side's work is gone the moment it lands.
- **Tie** applies **A**, deterministically (`arena/domain.ts:96`).
- **Stop** moves to `awaiting_stop_resolution`, where the choice is discard, keep A, or keep B
  (`arena/service.ts:4527`).

**Applying** (`arena/service.ts:4039`) records the resolution and enters `applying` in one
compare-and-set. The response and feed reveal that durable choice before transcript retention,
application, cancellation, or timeline hydration continue in the background. The resolved battle
collapses immediately; expand it for the difference summary, changed files, both threads, and the transition
report. Each contestant pane keeps its worktree menu in the header and its owned services below
the thread. The workspace header shows the current branch beside Commit. Click the branch, or
Environment in the header overflow, for checkout, retained environment, and service details.
Normal warm preparation stays silent; failures remain visible. See the decision controls above
for the vote, composer, and transitional states.

The selected contestant's Git state is the source of truth. Preserve its no-commit dirty and index
state, every actual commit (including empty or multiple commits), and commit-plus-residual state.
Arena must not create a visible commit of its own. Finalize records every branch, tag, and
remote-tracking ref the contestant moved, its own branch included, and imports their objects and its
real `HEAD` under the run's permanent ref.

### The review

The vote decides everything before it writes anything (`planWinner` in `arena/service.ts`). Each
ref the winner moved is measured against the developer's repository now: what the agent did
(created, added commits, rewrote, deleted) against what the developer did in the meantime. The
rules live in `arena/branch-review.ts` and are the product decision.

Arena never removes the developer's work without their approval, and a backup does not count as
approval. It takes a proposal by itself only when nothing of theirs leaves: a fast-forward, a new
ref, the agent's commits replayed on top of theirs, or keeping their version. When it keeps theirs,
the battle card says so and names the battle ref that holds the agent's version. A remote-tracking
ref follows the agent forward or is skipped; the next fetch sets it anyway. A winner that left its
branch for a detached `HEAD` with new commits gets a new branch, the first free `arena/turn-N`.

Everything else stops the vote and parks the turn in `application_failed` with Git state `review`:

- Files where the winner meets the developer's uncommitted edits or new commits (one `@edits` item).
- A ref the agent deleted or rewrote, or a tag it moved, when that takes the developer's version away.
  A ref the agent only moved back, to a commit the developer's ref already holds, is not asked: the
  agent added nothing there, so Arena keeps the developer's ref and the card says so. The branch the
  trunk ends on is the exception, because there the rewind is likely the task ("drop the last
  commit").
- A ref both sides changed in a way that does not replay cleanly. On the branch the trunk ends on,
  Git can keep both with conflict markers (`combine`); anywhere else only an agent can combine them.
- A branch another worktree has checked out. Taking it detaches that worktree at its commit.
- A merge, rebase, cherry-pick, or revert in progress. This one is a wait, with its own callout.

All the other items share one callout in the shape of main's old divergence callout: the files, then
the branches with what happened to each, and three answers that settle every item at once. With one
item, the title, the buttons, and a bullet list of the commits an answer removes name that item. **Keep my
changes** keeps the developer's version of each item. **Apply winning changes** takes the winner's;
replaced values go under the turn's `replaced/` refs and replaced file edits stay on the safety ref,
which the card names. **Let an agent resolve** applies the winner with the developer's work kept and
conflict markers where files can hold them, then sends an agent what is left to combine
(`resolvePrompt` in `packages/app/src/arena/review.ts`), told to ask before it removes anything.
It is always offered and is the filled button. The Battle switch is hidden while the review stands and comes back
where it was. Answers carry each item's fingerprint, so an answer given to a situation that has
since changed is asked again. Answers are stored on the turn and reused by every later plan, so the
`@edits` fingerprint names the content of each file, staged and in the worktree
(`editsFingerprint`), not only its path: a file edited again after "Apply winning changes" is asked
about again rather than replaced. A review that is still open when a single-agent turn ends is planned
again (`replanReview`), and one with nothing left applies. The winner's transcript is already in the
chat, so an agent in that turn reads that its changes are done; `unappliedWinnerNote` adds a
synthetic part to the user's message that says they are not. A system line was not enough: the
model trusted the transcript over it. The daemon keeps synthetic parts out of the chat.

Nothing applies until every item has an answer, and then all of it applies or none of it.
`holdWinnerRefs` opens one `update-ref --stdin` transaction for every other ref and stops at
`prepare`, which takes the locks and checks the values the plan saw; a ref that moved, or one
another Git process holds, fails there while nothing has changed. `promoteWinnerState` then writes
the checkout under those locks, and `commit` writes the refs. A refusal after the checkout is written
puts it back from the safety refs. If that undo fails too, the turn parks as `manual` with
`partial` set: the callout says the workspace is partly changed and offers only **Restore my
workspace** and Discard, and any retry or discard runs the undo again first (`restore_workspace`
mode of `retry_resolution`). The checkout branch and the switch target are never in the locked set,
which is what lets the checkout be written while the locks are held. A promotion that stops for any
other reason offers an agent too, with the reason in its prompt.

A `conflicted` turn stays parked until the markers are cleared. After the Git
state is applied, Arena grafts the winner's transcript into the canonical session
(`arena/service.ts:3977`), dropping any partial remnant first so a retried graft cannot append a
second copy. Worktrees are cleaned, the canonical transcript hash is re-recorded, and the turn
completes. The loser survives only as its permanent ref.

While application is running, the composer accepts one prompt for the next turn. Send captures the
current Battle toggle, stops the retained environment as part of the human/agent environment
transition, then waits for the chat to become ready before starting that battle or ordinary
single-agent turn. A queued battle appears in the feed as Agent A and Agent B preparing, using the
same presentation as a new battle. A failed battle start restores the prompt to the composer; a
failed single-agent send stays in the queue for editing and retry.

## The reveal

```
const revealed = turn.resolution !== undefined   // arena/public.ts:198
```

That one line governs the public projection. Before committing a vote, the service resolves the
assignment on the control plane. Resolution accepts only the final decisions defined for that kind
of assignment. The first decision is immutable; a retry returns that committed decision and the
desktop honours it instead of applying a later choice. Only then does the control plane return
display names. The local resolution and revealed names are written together, so an unresolved record
never contains identities. The server keeps the assignment mapping permanently, so an old unresolved
battle remains resolvable. Failed run text is masked to "Contestant run failed". The UI never has the
names to leak, so nothing in `packages/app/` needs to enforce secrecy.

`identity.name` is the profile's **display name** ("Qwen 3.8 Max"), not the slug — the app matches on
it for vendor marks and pretty names.

## Battle off

The Battle toggle is per turn. With it off, the control plane draws one contestant through the same
opaque assignment boundary, and `reconcileNormalTurn` (`arena/service.ts`) folds the resulting Git
and transcript state back into the canonical spine. The rating commits that assignment's reveal.
A process-local reservation keeps a battle and an ordinary turn from racing for the same session.

## States and failure

`arena/domain.ts:63` holds the legal-transition table: 19 states, an explicit map, and
`requireTransition` for the compare-and-set call sites. Read it before adding a state.

Failure has first-class states rather than an abort — `creation_failed`, `finalization_failed`,
`application_failed`, `canonicalization_failed` — each transitioning back into the step it failed,
so a resolution can be retried instead of losing the battle. `interrupted_recovery` is where a turn
lands when the daemon dies mid-battle.

Payment failures belong to the service account, not the voter's account; in a BYOK build that
account is the user's own OpenRouter key. Only a classified
temporary request-budget failure is retried, on the same assignment and session, before any
response output. Retry is bounded to three additional attempts and two minutes of waiting;
credit-limit and unknown payment failures need service-side attention. Keep billing details out
of user-facing messages. Never change contestants
or replay a partially received response to recover a payment failure.

Other retryable Arena failures share an eight-retry, two-minute budget per execution. A missing or
malformed retry hint uses bounded backoff so a persistent 5xx cannot spin indefinitely. A known
connection failure before response headers becomes a retryable upstream error; cancellation and
permanent errors stay terminal. A broken response stream or transient OpenRouter error after output
restarts the request under the same retry budget. The budget stops scheduling new retries, not a
request already in flight.

A restart resends the request the failed attempt started from, so it removes that attempt's parts
before the retry wait; otherwise the pane and the transcript show a half answer above the new one.
Never restart once the attempt has started a local tool: the resent request does not contain that
call, and the model can repeat its side effect. That failure ends the step instead, and the next
step continues from the stored tool call and result (`session/processor.ts`).

An Arena model response that emits no new event for two minutes fails and enters the same retry
policy. The deadline pauses while a local tool runs or waits for approval; a long tool call must not
be mistaken for a silent model stream.

`No recent activity` means the run has emitted no event for 90 seconds; it is not proof of a
stalled process. Explicit retry and user-input waits take precedence. That UI label alone must not
stop or restart a contestant.

## Gotchas

- Both sides are prepared concurrently, directory claims included.
- `TurnDocument.setupTimings` records where a send spent its time. Read it before guessing.
- `RunDocument.firstToolAt` records the model-emitted tool part's start time, before any environment
  guard. Tool completion controls `toolCount`.
- A tie always applies A.
- An early vote cancels the loser, so its transcript stops mid-run and its diff is whatever it had
  reached.
- Generation-scoped battle refs preserve the contestant results. Nothing prunes them.
- Contestant worktrees are reused across turns. Never assume a run's directory is fresh or that it
  is removed after the vote; `worktreeRemovedAt` means the run released its slot.
- Never give a host `alternates` to the checkout's objects; see the contestant environments above.
- New turns use a fresh port bank and never retarget old `.localhost` routes.
- The production pool lives only in the control-plane package; never import it from the engine.
  The engine bundles `defaultPool` for BYOK, and a hosted runtime must never read it.
