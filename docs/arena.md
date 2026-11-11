# Arena

How a battle runs, from prompt to applied result. This is the product; everything else in this
repository is the Paseo shell it runs inside.

The engine is `arena-backend/packages/opencode/src/arena/` — a module inside a vendored OpenCode
fork, isolated from the root npm workspace and installed with Bun. Packaged desktop launches a
compiled copy with Arena's provider SDK pinned to the engine's `package.json` and bundled inside
the executable. Arena provider initialization must work without npm or a package download; model
requests still need the network. Check this through the desktop build, since a source runtime can
resolve installed packages that a compiled Bun executable cannot. Source development launches
from `PASEO_ARENA_BACKEND_ROOT`. The daemon exposes it at `/arena/...`
through `packages/server/src/server/agent/providers/opencode/v2/arena.ts`, which the protocol wraps as
`arena.*` RPCs and `packages/app/src/arena/` renders. Arena's app-wide pages, including
[My leaderboard](accounts.md#personal-leaderboard), share Expo Router's navigation context.
Import their navigation hooks from `expo-router/react-navigation`: Expo 57 bundles its own
React Navigation, so the standalone package reads a different context and can crash a routed page.

Arena uses OpenCode's V2 session store and runner. Install its routes and engine plugin into the
same Core service graph and directory boundary as the native `/api` routes. Project paths can
contain Unicode, spaces, and literal percent signs; preserve them across requests and returned
session locations. A second graph creates a separate session lifetime and can race worktree setup
or winner promotion. The active engine typecheck excludes
retained 1.x modules; check their imports separately when merging. Preview integration belongs to
the V2 engine plugin. The Arena `info + parts` transcript is a wire projection; fork and graft
canonical V2 messages so attachments, compaction checkpoints, and replay state survive a vote,
subject to the sealed-reasoning boundary under [Blinding](#blinding). Keep canonical history
independent of SDK-owned stream metadata: a provider can still extend its reasoning state after
answer text begins.

Arena state is canonical local data. The runtime stores it in SQLite at
`$PASEO_HOME/arena/arena.sqlite` and keeps artifact bytes in
`$PASEO_HOME/arena/artifacts/sha256/`. The default home is `~/.paseo`; source development can
override it with `PASEO_HOME`.

The battle routes (assignments, the contestant OpenRouter proxy, the comparison, and commit, pull
request and branch name text) live in `arena-backend/packages/arena-service`. Where they run depends on the build, and one build never
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

A hosted runtime journals research mutations with the local SQLite write, then validates and
converts them after commit. Conversion or upload failures must not lose canonical local history.
Pending revisions survive restarts and account changes; partition the queue by verified account and
hosted destination so a new account cannot upload its predecessor's records. Account sessions are
verified locally with the embedded public key, and signing out does not delete local data. BYOK
creates no research queue or uploader.

Temporary upload failures retry with jittered exponential backoff capped at one minute. Split
HTTP 400, 413 and 422 batches to isolate refused records and retain them, including dependent
manifests, for hourly recovery. That deadline survives restarts and does not delay new writes.
The queue has no size-based eviction: an extended outage consumes local disk until uploads succeed.
It protects committed records against upload failures, not disk exhaustion, disk failure, or manual
deletion of local state.

The first hosted start backfills the verified account's existing chats, turns, runs, intact
transcript/image artifacts and archive manifests. Its durable worklist resumes after a restart;
park artifacts after three unsuccessful reads until the next hosted start or an explicit recovery
pass. Unowned history is never assigned to the account that happens to sign in. Truncated local
artifacts cannot be recovered. Backfill must not overwrite a concurrent local edit with an older copy.

Research includes chats, turns, runs, generation metadata, structured events, comparisons,
single-agent ratings, session archives, and transcript, patch and image artifacts. Raw events and
per-call full request, response and tool-output artifacts stay local. Requests stay below 3 MiB
and records below 2 MiB; larger documents use content-addressed chunks and a checksum manifest.
Research readers use `resolveResearchDocument` from arena-service under the same account and source.
Deploy the control plane's updated arena-service dependency before shipping this protocol: an old
server refuses chunks, which the desktop retains for automatic recovery after the server upgrade.

The desktop's per-call copies are scrubbed, so in hosted battles the control plane keeps each
contestant call as OpenRouter received it, with the real model, routing, cache key and restored
reasoning, and its raw response (`arena-service/src/generation-capture.ts`, `captureGenerations`).
Messages, tools and images are stored once per account by content, because each call resends the
whole history. Single-agent chats, keep-alive pings and the service's own comparison and metadata
calls are not kept. BYOK leaves capture off: its store is on the voter's machine, and those fields
name the model.

The control plane also adds the endpoint's quantization to each stored request row, from a catalog of
OpenRouter's endpoint lists that it saves itself (`arena-service/src/endpoint-label.ts`, `recordEndpointLabels`).
OpenRouter never reports quantization for a call, so the label is what the catalog listed for that
provider, and does not prove what ran. These fields stay on the server, like the provider name.

`archiveComplete` means the local archive exists, not that research has uploaded. Reply resets keep
the previous cloud archive until its replacement arrives. Keep transcript and image archives whole,
without per-call artifact budgets; a disk error must fail the local write rather than produce an
empty archive.

Read a `battleMetrics` side's `retries` and `ttftMs` only where they are present in a row of
`schemaVersion` 9 or later: an older row's `retries: 0` and `ttftMs` (often the title request's)
mean unknown, and engine recovery rebuilds old rows only on desktops that upgrade, for turns still
stored locally (`BattleSideMetrics` in `arena/records.ts`).

Keep inline images in separate content-addressed artifacts and refer to them from archived
transcripts as `arena-image:sha256:<hash>` (`arena/transcript-artifact.ts`). This avoids duplicating
image bytes across transcripts. Research sends the transcript and shared image records through the
durable queue above.

Keep window payloads bounded (`arena/live.ts`, `arena/transcript.ts`):

- Omit tool-result attachments, which the app does not display, and history before the run's prompt.
  Each contestant is a fork of the whole chat; sending both complete forks can exceed the daemon's
  64 MiB socket limit on opening a chat, voting, or replying.
- Preview large tool fields and prompt images; fetch their full parts when opened or displayed
  (`arena.run.get_part`, `arena-part`). Follow-up images can exceed the socket limit too.
- Omit stored `events`, which no window reads. Trim the oldest messages once a run's thread exceeds
  8 MiB, and show `activityOmitted` in its pane so the voter knows what is missing.
- Refuse a response still over half the socket limit with `chat_too_large` or
  `arena_diff_too_large` (`server/arena/payload-limit.ts`), preserving the connection.

## Live synchronization

The current chat and each opened historical turn are separate watch targets.
Share one backend SSE connection per target and signed-in account, and one React Query record per
window. The daemon delivers updates only to the subscribing socket; closing a
window must not close another window's watch.

The daemon supplies the resolved account when opening a stream. A first watch
can create or claim a Git-backed chat, so it must preserve the ownership contract in
[data-model.md](data-model.md) without an extra transcript read. Recheck canonical checkout availability when an existing
chat opens a stream. While blocked, the stream’s existing maintenance timer checks for
a filesystem repair once a second and publishes recovery without rereading transcripts.
An ordinary chat in a folder without Git has no battle to watch. Leave it without a battle
disconnect callout; starting a battle prepares its repository and opens a new watch. An existing
battle still reports stream failures when its repository becomes unavailable.

Begin with a redacted snapshot, reconciled with events received during the read
and unfinished token text held in memory. Then apply messages and parts by ID.
Include each contestant's descendant sessions in both the live feed and transcript snapshots;
delegated work must remain visible while the parent waits, including after reconnecting or archiving.
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
When a rewind removes a battle's canonical prompt, hide that battle's summary and keep its turn,
vote, and metric records for research. Recover missed rewind notifications at startup and when
an idle chat opens, before serving its history. A surviving prompt keeps its summary; an active
battle's graft must settle before checking which prompts remain.

A subscriber acknowledges each delivered packet before receiving the next.
Keep the initial snapshot outside its pending change buffer. More than 256
pending packets or 4 MiB resets that subscriber; other subscribers continue.
Release upstream readers, queues and timers when the last subscriber leaves.
The request/response pairs are `arena.stream.subscribe`, `unsubscribe` and
`ack`; `arena.stream.update` carries the data. App and daemon ship this contract
together. Canonical winner hydration belongs to the daemon and is shared across windows per
active agent. Hydrate each applied winner once after the chat becomes ready, keeping native live
delivery synchronized with canonical history replacement. Apply the same boundary after a rewind.
Grafts arrive without an ordinary provider turn, so migrated winners and surviving replies can
otherwise replay into history already on screen. Serialize different winners and leave failed
hydration eligible for retry. A reconnect or another state packet must not rebuild an already
hydrated winner. Callers waiting for hydration, including the resolve before a send, wait at most
10 seconds so a stuck hydration cannot block the next battle. Newer winners supersede older
hydrations, whose late results must be dropped. V2 serializes provider snapshot reads: if one is
stuck, callers still return after the deadline, but newer hydration waits for that read to settle.

## What this is for

One prompt, two agents, one worktree each, and a vote. The winner's work becomes the chat's real
history; the losing environment is released after resolution. Battle mode is on by default; the single-agent path is the
escape hatch for when you already know what you want done. Render client-owned battle copy,
including composer prompts, diff controls, status text, and accessibility labels, in the selected
app language without reopening the view. Keep contestant letters, model names, code, and agent output
intact; [i18n.md](i18n.md) owns the translation boundary.

The voter is a developer getting work done who happens to get two attempts to choose between, not a
benchmark operator scoring models. Optimize the UI for deciding quickly and moving on: the two
results side by side, the difference between them legible, and every decision in one place. The
battle in the transcript is for reading. The contestant responses and their inline review
share one surface, without another Responses/Review switch. The battle uses no side panel tab:
it has the chat's width, and a panel beside it would narrow it to show the same thing.

The battle has no frame. Its prompt is the chat's own grey bubble, at the reading width and right-
aligned to the battle's right edge, where it stays once the battle is history. The owner turned down
the prompt as a bold heading: across the battle's width it read as a document's section title, not
as something you said. The prompt, both answers, the review's columns and the decision row share
two rails (`battle-layout.ts`).
Each answer is headed by a rule in its side's colour, the colour of its Choose button, then the
agent's name with its state and time. The size of each change is read in the Changes tab, beside the
other side's. The heading ends with the agent's tools (`pane-actions.tsx`): Preview when it runs an
app, a terminal in its worktree, and a menu with the worktree path, Copy path, Expand, and its
services. Side by side, both headings are one row that sticks to the top of the chat for the whole
battle (`BattlePaneHeader` in `battle-view.tsx`), so the names stay in view over the answers' ends and
the review on their columns. The row is a child of the battle, not of the panes: a pane is only as
tall as its thread, so a heading inside it scrolled away before the review. Stacked panes keep their
own headings.

Review has two tabs: **Difference summary**, the generated comparison, and **Changes**, each
changed file with what A and B did to it. It appears when the first side has a result
(`battleReviewPhase` in `comparison-visibility.ts`), before an early choice, if that side changed
files; a finished side with no changes shows nothing until both are in, since both tabs would only
say "nothing yet" and the decision row already names the side still working. The summary tab says
the other side is working; Changes shows the finished side against a hatched placeholder sized to
its diff, with no pair verdict yet. Only the finished side expands. The unfinished side stands in
as the frozen base, as in a stopped battle.
A side working again after a reply keeps its previous commit, so check its run state too.

Key comparison and file reads by their commits (`arenaDiffQueryKey`, `comparisonRevision`), and
partial review by its phase. Run completion precedes the new commit: keying by phase alone can
reuse a reply's old result, while treating a completed run without a commit as finished can briefly
hide review. Keep existing evidence visible until the new read arrives.

List every changed file in path order, with contents fetched only when its row opens
(`arena.turn.get_file_diff`). Capping the list can hide files changed only by B. Several rows can
stay open; open the first diverging file automatically and preserve that choice when the other
result arrives. After eight rows, use Show more while keeping open rows visible.

Open on Difference summary while a report is pending or available; otherwise open Changes, as for
a stopped battle or a failed side. Read the turn's `comparisonState` before the comparison record
exists (`battleSummaryStatus`): the review keeps its initial tab, so relying on the record opens it
on Changes too soon. The review has no fold: it sits in the chat and scrolls past like the answers.
Changes retries a failed
read twice before offering manual retry. Summary generation retries transient network and service
failures for about a minute (`RETRY_DELAYS_MS` in `arena/comparison.ts`): a shared upstream pool can
refuse every utility model with 429 for that long. Permanent payment or credential failures remain
actionable. Retry summary claims the failed summary and marks the turn and its record `running`
before it answers (`claimComparisonRetry`): the app reads the record's state first, and a record left
`failed` kept the button up while every further press failed. A press that loses to a running retry
gets the current snapshot, not an error. A decision (vote, early pick, stop) closes the summary's
scope and the control plane answers later calls with 403, so the generator stops once the turn has a
resolution, and a decided turn's failed summary shows neither the error nor Retry summary. A summary
already on its way when the vote lands still shows.

Keep agent responses above review in the visual hierarchy. The review sits in the chat under the
answers, on their text edge, the same for a live battle (`ArenaLiveReview` in `battle-judging.tsx`)
as under Show battle. Do not pin it under the chat: a pinned review stayed in view over turns it did
not belong to, and the owner did not want it fixed while voting either. Only the decision row is
pinned, at the bottom of the window. A small segmented switch on the left rail heads the review,
with no rule across both answers: underlined tabs over a full-width hairline read as a third
heading at the agents' rank. With no summary the switch holds Changes alone, so every review has
the same head. Do not mark the columns with A and B letters; the owner turned them down, and the
columns sit under their answers.

Everything about one side sits under that side, and only what is about both spans the columns. Each
column opens with a hairline. The summary puts each side's sentences and its value in each row of
the differences table under that side's answer (`summary-columns.ts`). Changes heads each column
with that side's file count and total, then gives each file one row: what A did under A, what B did
under B, "unchanged" on the side that left it alone (`SplitChangesRow` in `changes-list.tsx`).
An opened file puts A's code in a box under A and B's in a box under B, across the same gutter, with
only each side's expand above it (`onColumns` in `base-relative-view.tsx`). The review's switch and
the diff layout toggle are the same control (`segmented-switch.tsx`).
Below the width at which the answers stack, a row keeps both counts on one line. When neither side
changed a file, each column says so under its own answer; one sentence starting under A read as
A's. The judge is asked for that shape, but nothing enforces it, so a report that
does not split cleanly shows whole, as compact Markdown with flat headings and paragraphs capped at
`proseMeasure`. The diff layout toggle uses the `xs` tier. [Design](design.md) owns the tokens and
control conventions.

The judge writes a short report (`arena/comparison.ts`): what each agent did, including shared task
violations, then a table of differences. Show it whole unless it exceeds a screen of the card, when
`Show full summary` folds it (`verdict-body.tsx`). Do not trim the requested report to make it fit:
that spends latency on prose the voter must then unfold. Identical file results do not prove that
the text answers agree, though equal trees skip the report. A failed side also skips it and leaves
only Changes.

On the first turn the judge also returns a `Title:` line, which the engine removes from the report.
A new chat shows its prompt's first line until that title arrives; any other workspace name stays
(`arena-workspace-auto-name.ts`). Equal trees or a failed side request only the title. Battle off
uses the metadata route described under [Blinding](#blinding). A failed title request leaves the
prompt's first line. Never start a coding agent to name a chat: it uses the full agent setup for a
metadata task.

Git's `merge-tree --write-tree` compares A and B over the frozen base with
`merge.conflictStyle=zdiff3` (`compare` in `arena/git.ts`). `diverging` means a real merge conflict;
`compatible` means both touched the file in different places. Review each side against the frozen
original with corresponding regions aligned. Wrap long lines in both layouts so narrow panes
keep the full change readable; side-by-side rows stay level across A and B. Keep every change
visible, shared additions and removals included, even when the results match. Fold only context
neither side changed. Shared changes keep their screen-reader labels without a separate `Both`
column.

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

While the contestants work, each pane reads its thread with inline activity groups, controlled by
`toolCallDetailLevel`. Once a contestant finishes, fold the work before its final text into one
collapsed row, such as **Read 1 file · Ran 1 command**, so the pane ends on the answer being judged.
Opening it restores the updates and work; questions and subagents keep their own rows in place.
Follow-ups keep completed exchanges folded. Replies share the chat's Markdown renderer, including
local images and file links. After a vote, the applied side reads those files from the chat's
workspace; a removed side cannot read its old worktree. Images larger than 25 MiB show as
unavailable so a reply cannot pull an unbounded file into the window. The battle is one card
(`packages/app/src/arena/battle-view.tsx`). The chat's reading-width preference controls collapsed
summaries. An expanded battle keeps its own width limit, twice the default reading column, and runs
edge to edge below that limit. On wider panels it is a bordered, rounded card centered at that
width. Everything in the battle shares the card's width — the two threads and the Changes
review — so the page has two widths: the chat's reading column for the prompt and the
composer, and the card for the battle. Inside the card, sections separate with
one top border each, the way rows in a settings card do, and text starts on one rail. A and B each
occupy half the card, split by a divider; below 520px of available card width, they stack.
The panes keep a fixed resting height and their threads scroll internally. A finished pane shrinks
to fit, up to that height, so folding the work does not leave the answer above an empty box while
the chat follows review below it. Scrolling away pauses following; reaching the bottom or choosing
Jump to latest resumes it. Opening or closing activity also pauses following in the pane and holds
the row's position in the chat (`agent-stream/hold-position.ts`), keeping it under the pointer as
the pane grows or shrinks. Each agent header has an
expand button beside its worktree control to give that thread the full card width; restore returns
to the split. Both are
pane chrome at the ghost `xs` tier, borderless and the same height. Headings have no status
indicators; the status text below each heading reports progress. In the thread, the work summary
rows (`Read 3 files · Ran 4 commands`) match the 14px prose they follow and hug their icon, so a
muted summary never outranks the text. Keep one 12px gap between text, its summary, and the next
text. Changing the view keeps both panes mounted, preserving reading position and permission UI. Keep
the active battle open and its threads height-limited so the prompt and composer remain
reachable. The card has no link back to the history: the conversation is right above it.

While both results wait for a decision (a vote, or what to keep after a stop), the composer is put
away behind Ask a follow-up at the end of the decision row, so the decision is the bottom of the
battle (`useBattleComposerPutAway` in `agent-panel.tsx`). A draft keeps it out, and asking brings it
back for the rest of that turn. Otherwise the composer stays available while a running or completed
contestant can accept a reply. Who it
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
**Attachments** under [A turn](#a-turn)). While a battle is unresolved, send saved inline review
comments through the composer chip and its Both, A and B targets. Changes offers no direct
Send feedback action until resolution: a canonical chat send cannot reach the contestants.
Comments added while a send is pending stay as drafts for the next message. Steering waits for
the current tool call or response to finish, so until the next model request includes a message,
show it as queued at the end of that contestant's thread, never as sent: a one-line bubble, a line
naming its images and files, and under the queue one muted line with what it waits for
(`Sends when the current command finishes`) and **Send now**. A file's contents never show in the
queue. Each queued message has its own delete, always visible because a hover-only one went
unnoticed; it removes that message without interrupting the current work. **Send now** interrupts
the running work and resumes the stored messages; unlike Stop, it must not submit them again or
finish the contestant's battle run. Paseo's ordinary queue waits for an entire run, so the battle
owns delivery. OpenCode 2 keeps a queued steer in the session inbox, not the transcript, until a step
boundary delivers it under the same ID, so the run's thread, delete, and Send now read both
(`steerTranscript` in `arena/service.ts`). Delete cancels its messages together and fails, cancelling
none, once one was delivered. Core stamps a delivered steer with the delivery time; the thread and
the daemon's chat timeline (`opencode/v2/timeline.ts`) show the send time (`ARENA_SENT_AT`), which
`lastTurnStart` also needs to tell a steer from a new prompt.
A steer can arrive as a side's answer ends, after the runner's last boundary check. The side's
prompt fiber closes its turn under a per-run gate only when no steer waits and no runner works, and
otherwise answers it first; a steer is admitted under the same gate and refused once the side is
closing. The refusal carries the code `arena_side_closing` through the daemon, and the app words it
(`arena/steer-refusal.ts`) and keeps the draft. A steer still queued when Stop or an early choice cuts the run off
is delivered as an unanswered message so the thread and a kept side's history agree.
An engine restart leaves it in the inbox: the interrupted run's archive shows it, and Resume delivers it.
The toolbar stays on one row.
When its own available width is narrow, shorten the target labels, show tool permissions as a
status icon, and use the send arrow; retain the target-specific placeholder and accessible labels. Tool permissions use a quiet
status menu: `Auto Accept` or `Ask before tools`. The choice applies to the chat, or to both
contestants during a battle, and becomes the default for new chats; other chats keep their own. The
carry-over is intended, so the menu says so. Its descriptions also explain that enabling Auto
Accept accepts pending requests; explicit deny rules still apply. If an answer loses its connection
or acknowledgement, answer the same card again without reloading. Retrying an accepted answer
must not grant or run the tool twice.

`Ask before tools` does not ask about work inside the project: OpenCode's agents allow it. It asks when
a tool leaves the project through `external_directory`. OpenCode documents ask as its default, but
its upstream rules allow it. Agent Duel restores the documented default in
`schema/src/agent.ts` and the built-in agent rules (`arena/engine-runtime/outside-project.ts`). Keep
this rule on the agent so existing chats, subagents, and agents defined in user config all get it.
A user's configured rule and a contestant's sandbox come later and win. Directories the agent's own
work fills never ask: long tool output, background command output, plans, skills, and uploads.

OpenCode's shell tool checks only `cd` and its working directory, so the plugin
checks the shell call outside a battle. Literal writes outside the project ask through command
wrappers and symlinks too, including files that do not exist yet. After a conditional directory
change, a write asks if any possible location puts it outside the project. Ordinary project writes
stay quiet. The short reader list is unchanged. Temp never asks: `/tmp`, `/var/tmp`, and the system
temp directory are allowed, including their real paths.

Inline shell commands such as `sh -c` are checked; inline interpreter text can still produce a
false card. See [Gotchas](#gotchas) for paths the scan misses. Ask mode does not confine arbitrary
code. Asking for every shell command would also ask about work inside the project.

Always allow cannot save a glob in a directory path, the root, home, or a directory above home,
including aliases through symlinks or case (`tooWideToSave` in `core/src/permission.ts`, an Agent Duel
edit to vendored core). Unresolved paths that look that wide are refused too. A card with nothing
savable offers only Allow once and Deny. One false match must not end every later ask for the project.

The vote lives in a centered sticky pill above the composer: `Choose A`, `Tie`, and `Choose B`.
Anchor it over the transcript above the composer, with a gray surface inside the pill and a
transparent, click-through area around it. It stays reachable while reviewing either thread or
the diff. A stopped battle uses the same pill for `Keep A`, `Discard`, and `Keep B`; an early
choice while the battle runs sits there too. While neither result is selectable, show one `Stop`
button. When one result becomes selectable, `Stop` moves to the exact centre between the answers
and each side's place holds what applies to it: `Choose A early` or `Choose B early` on the
finished side, and the working side's status (`Agent A is still working`, with its colour dot) on
the other. A hint line above the buttons left the status unattached to either side. While both
run, keep `Stop` alone; there is nothing to put on either side. At the vote the pill reads `Choose A`, `Tie`, `Choose B`.
`Tie` shows only when both results can be chosen. A failed side shows `Accept B` in its Choose's
place when its result was saved, and nothing when it was not. Discard is not one of the vote's
choices: two results that can be chosen get a vote, so it shows only after a failure, as an
outline `Discard battle` button at the end of the line above the pill that names the failure. So one failed side
reads `Choose A`, `Accept B` under `Agent B failed · choosing either won't count as a vote ·
Discard battle`, and two read `Accept A`, `Accept B` under `Both agents failed · accepting either won't
count as a vote · Discard battle`. With no saved result the line falls back to `Agent B failed ·
choosing A won't count as a vote`, or `Both agents failed · retry or discard` and `Both agents
failed`; with neither side to take, the pill is hidden and the line's `Discard battle` is the only choice. The resolved battle's
header says `Vote not counted`, and names an accepted side `(failed, accepted)`. Accept confirms first, because the work can be partial. Choosing early stops the other side, so it confirms first. The confirmation belongs to that turn's
running state; close it when the turn changes so it cannot cover the normal vote. Discarding a battle also requires
confirmation, which offers an optional reason (`Both wrong`, `Changed my mind`, `Other`). Action failures remain on the battle until another attempt; the normal
action controls provide the retry so a destructive operation is never retried automatically.
`Choose A` and `Choose B` carry their side's colour as a tint, the blue and amber of the diff's
column headings, so the vote reads as picking that column; two choices of equal weight mean
neither can be the accent. `Tie` and `Discard` stay plain. While the battle runs, `Stop` and the
early pick share one neutral outline, and the early pick takes its side's tint only on hover. An
uneven pair, one filled or brighter, read as a switch already set to that side, since the reply
target fills its selected segment with the same tint, and voters felt pushed to take it before
the other side finished. Transitional and recovery
states use the **decision bar** (`packages/app/src/arena/decision-bar.tsx`) in the composer's
slot, except setup and application progress, which stay in the conversation.

Keep identities hidden until resolution so the vote judges the output. Tool-call ID shapes can
reveal a model too; [Blinding](#blinding) covers each boundary.

Product decisions that are settled, so they do not get relitigated per feature:

- The pool is fixed and small. Choosing models per battle is not a goal.
- Both results are kept until the vote; nothing is auto-selected.
- A vote is final. There is no rematch on the same prompt. Discarding both sides ends the battle
  the same way; the voter sends a new prompt.
- The loser's files remain on a Git ref. The UI offers no action to restore them; archived threads
  remain readable.
- Contestant text stays prominent. The newest activity block shows its latest tool or reasoning,
  even after it finishes. An older unfinished task must not replace newer activity. Animate only
  the displayed activity while it is running. Show thinking when the next model request has started
  without content. Once newer conversation content puts a block into history, show its aggregate
  work summary without animation. Tool details remain available by expanding either row.
  Thinking content stays hidden, including inside expanded activity and subagent rows.
  Give each subagent a static, named, expandable heading with its latest activity on an indented
  line beneath it. Animate only the activity text. When the subagent ends, replace that activity
  with its final status on the same indented line, even while its parent or siblings keep working.
  A background launch acknowledgement does not mean the child has finished. Keep its transcript inside that group so
  concurrent agents cannot replace each other's current tool.
  Use the activity row for thinking and the pane heading for elapsed time, without a second
  thinking control or timer below the transcript.
- A battle chat reads the way its panes do, so a winner's transcript keeps its shape after the
  vote, and so does every later turn of that chat, single-agent ones included. Work before a
  turn's first text sits beneath it (`orderArenaChat`); reasoning joins the work it leads into
  instead of standing as its own row; and a subagent is a row of its own, a heading with its status
  beneath, that opens its transcript in place, inline at full height as in the pane (`ArenaChatSubagent`). Rows carry the pane's words
  (`arenaChatWorkLabel`, `Reasoned`) and its proportions at the chat's 16px: rows take the prose's
  size, their icons too (`labelSizedIcon`), and sit flush, so one rhythm runs down the turn
  (`getArenaGapBetweenStreamItems`): a text sits against the work it led into and every other
  block starts one gap down. Measure a change against the pane; every gap between blocks there is
  the same. Task checklists stay inline, where they were written. Other providers' chats keep
  Paseo's order and spacing.
- Show automatic context compaction as an inline status, including inside subagents. Keep its
  internal summary and synthetic continuation prompt out of the conversation; they are not
  messages from the voter. Resume the contestant's visible work after the status.
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

Follow [the agent guide](../CLAUDE.md#critical-rules) for the boundary on inherited Paseo changes.

## The canonical spine and contestant environments

A workspace maps to one arena **chat**, which owns three things that move together: the developer's
canonical Git checkout and ref, a canonical OpenCode session, and a hash of that session's
transcript. Every battle starts from that spine and exactly one contestant is applied back to it.
Forking a chat clones that canonical OpenCode session through the selected provider message. A
same-worktree fork creates another workspace backed by the current `cwd`. A new-worktree fork
atomically creates a branch-off worktree and workspace. Both open the forked chat directly. The
copied messages remain native transcript history; they are not flattened into the first battle
prompt.
A battle needs Git 2.39 or newer, and a send refuses an older or missing Git with the command that
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
every second. Unarchive is the exception: it records the name git answers with even when the head moved,
because Restore files can bring the worktree back detached or on a branch that moved meanwhile, and
the header would otherwise keep naming the old branch.

Chats in the same checkout share its index, so a read must never take `index.lock`: the
lock it holds is the one another chat's vote or prompt needs at that moment. `--no-optional-locks`
covers `status` and `diff`, but `write-tree` always locks the index, so the checkout's index tree is
read from a copy of the index file (`readIndexTree` in `arena/git.ts`).

Contestant worktrees are kept between turns. A chat owns a small pool of **slots** under
`.agent-duel/worktrees/<chat>/`: a linked worktree plus the bare host repository it is registered in
(`<dir>.git`). In steady state the pool holds three: the next turn's pair and the retained winner.
A kept slot keeps its files, so preparing the next turn rewrites only what differs from the new
frozen base. The pool is read from disk, not stored: a slot belongs to a run until
`worktreeRemovedAt` or to the chat's current warm pair; otherwise it is free. Only Arena's own worktrees are slots: a `.git` link into the host beside it, whose entry
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
under a running contestant. Ignore rules can miss numbered copies, including `.env 2.save` when
only `.env` is ignored. Keep these copies out of snapshots and contestant worktrees when an ignored
original beside them has the same bytes (`excludeSyncConflictCopies` in `arena/git.ts`); otherwise
`add -A` would carry the secret into a result and on into the checkout. A nested directory left
with only its ignored original still prepares; it needs no public placeholder file. Already tracked
files with similar names stay part of the battle.

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
and rewrites every tracked file. Without a watcher backend (Windows) a ready pair is also sealed: once
its instances are booted, the store gets both slots' records plus stat digests of each worktree
outside its copied directory roots and of its host outside `objects/`, the checkout rules, and the
release that wrote them (`sealWarmPair`). A restarted engine trusts the pair again only when the seal
was written by this release for this generation and copy, no process works in either slot, both are
still pool worktrees, and every digest matches (`restoreSealedPair`); the records then become this
process's, and the send checks the pair against the checkout as it would one prepared here. Anything
else, an unreadable seal included, drops the seal and leaves the pair to the refresh below. A watch
ends with the process, so a pair a watch vouched for is never sealed. The send forks again rather
than reuse a restored pair's forks: their port bank was reserved only in the previous process. A
seal goes whenever its chat's warm record is written or a send takes the pair.

To keep the refresh off a send, startup recovery takes the most recently updated chat and, when it is
idle with a ready pair and no single-agent pass since its last battle, trusts the pair from its seal
or else prepares it again in the background (`rewarmLatestPair`), adopting the same two worktrees in
place under the start lock. A send that arrives meanwhile waits for it and then reuses the pair. A
prompt to the chat's agent that arrives before the build claims the two worktrees makes it stand
down, since the agent's edits would leave the pair stale. Every other chat's pair is checked against
its seal at its next send and refreshed when that fails: an older chat is less likely to be sent to
than to hold up, while its host copies take the repository lock, a vote or a prompt in the chat the
user is in. Background cleanup (checkout eviction, its release, and environment release) leaves
`updatedAt` alone, so the chat cleaned up last is not taken for the chat worked in last. A slot that
cannot be verified is retired and a new one created.

The loser's slot is released after the vote, and the retained winner's at the next send: services
stopped, sessions and the OpenCode instance disposed, the run marked `worktreeRemovedAt`. The files
stay until the next warm preparation adopts the slot. A free slot that any process still works in (a
terminal left open in it, for example) is retired instead: a rename would carry that process into
the next contestant's tree. Processes are listed a second time half a second later when the first
listing finds one in a free slot, because a released side's services can still be exiting. Failure
paths and discards still remove worktrees; archiving the workspace, evicting its checkout, or
releasing an idle chat's environments (see the cleanup below) removes the chat's whole pool. Archive
and release delete the pool's trash before they answer, waiting for deletes a removal started in the
background, and then remove the empty pool, because the engine can stop right after and a
background delete stops with it; startup finishes what an interrupted eviction, archive, or release
left. Release deletes after it lets go of the chat's start lock, so a send to the chat does not wait
for the deletes, and leaves the pool to a send that is building in it.

Archive also sets the chat `archived`, and the engine refuses every send to it, battle or single
agent; the battle refusal reads `Arena chat already has an active battle`. Unarchiving brings the
chat back as a release leaves one: ready, with no warm record, so its next send builds a pair from
nothing (`unarchiveSession`). The daemon archives the chat from the workspace archive handler, but
unarchives it from `AgentManager.unarchiveSnapshot`, which every surface that unarchives an agent
(the app, the CLI, MCP) goes through. It calls the engine after the agent's record is unarchived:
the app resumes the agent while the engine answers, and an agent resumed while its record still
reads archived is removed from the app's lists, which turns the open chat into a blank draft.

OpenCode keeps a snapshot repository per worktree path (`snapshot/<project>/<sha1 of the path>` in
its data directory), and a slot moves to a new path every turn, so each released side leaves one
that nothing opens again. The engine deletes a released run's repository once nothing is at its path
(`discardSnapshotRepositories`): after a pair is prepared, after a pool is retired, and for every chat
at startup. It hashes only run worktrees, so a standalone OpenCode's data in the same directory is
never matched.

A chat's pool directory carries Time Machine's sticky exclusion attribute (`arena/backup-exclusion.ts`):
its slots are copies the next battle can build again. Spotlight already skips `.agent-duel`, whose
name is hidden. Worktrees the user works in, under `.agent-duel/worktrees/<id>`, stay in backups.

A ready chat with no open stream for five minutes unloads its OpenCode instances
(`watchChat` in `arena/service.ts`). Its warm pair stays trusted and its retained winner keeps
running services. The next send reloads the instances. The app streams only its current chat,
so an open stream marks use. Warm sides have no services until needed. Human or agent environment
transitions stop retained services and expose retained, warm, and trunk status.

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
Those holds and a spare's claim take the lock as background work
(`withBackgroundRepositoryMutation`): one at a time, and only while no send, vote or chat opening is
waiting on it. The lock is otherwise first come first served, and on Windows each host copy holds it
for one to three seconds, so a vote queued behind two spare claims waited 3.6 s.

A new chat has no pool to adopt from, so its first send claims two worktrees and copies every
ignored root into both. With a copy-on-write clone that is cheap; Windows has none, and a 14k-file
project took 8.7 s per side. There a repository also keeps a spare pair for its next new chat in
`.agent-duel/worktrees/_spares/` (`ensureProjectSpares`): a battle reaching its vote builds it in
the background when it is short, synced to that battle's base, and a new chat's first send adopts
it, so the scan keeps the ignored roots instead of copying them (4.0 s per side). A project gets its
pair before its first battle too: adding it makes the daemon call `/arena/projects/prewarm`, and the
engine builds both spares at once from the checkout's index (`prewarmProject`). The app opens a chat
only when its first prompt is sent, so this is the earliest moment the engine can start. A first
send that arrives while that build runs waits for it before taking the repository lock, which the
build's claims need; it began earlier, so it finishes sooner than the send's own copy would. The
records that let the scan keep a root belong to the process that built the spare, so the first build
in a process retires whatever an earlier one left there, and after a restart the repository of the
latest chat that battled gets its pair again, from that chat's last turn, once the latest pair is
re-warmed. `OPENCODE_ARENA_PROJECT_SPARES` turns spares on (`1`) or off (`0`) on any platform; tests
run with them off.

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
rewrites only the difference. The watches answer whether the ignored content moved
(`warmPairIsUsable`). Without a watcher backend (Windows) the digests a scanned sync records for each
copied directory root, in the checkout and in the copy, answer it instead (`scannedPairIsUsable`):
the pair is reused while both still match, which took a second message from 4.0 s to 0.7 s. A copy
records the checkout's digest from the walk that measured the root for the copy manifest
(`sourceTree` on its entries) instead of walking it again. A resync deciding whether to keep a root
reads the checkout's digest afresh, because a warm pair's manifest is reused at a later send; the two
sides resyncing at once share that walk.

Trust is process-local. Reuse a pair only while the checkout's HEAD, branch, index, working tree,
ignored content, copied Git metadata, and both slots remain unchanged. Otherwise adopt those slots
again, rebuilding hosts and rewriting differences. Reuse its forks only while canonical session,
transcript hash, pruning boundary, and port banks still match. Ports are reserved only in memory:
a send must check for another program taking one and allocate a new bank and fork if needed.

A cold or refreshed side waits for its base checkout before the model starts. Its path is known
before staging (the planned slot, or the warm slot it refreshes in place), so the side forks its
session first and keeps it at the canonical checkout while the slot is an empty reservation.
Staging (claim or adopt, git sync, ref mirror) then runs, the session moves into the staged
worktree, and only then is the first prompt sent. OpenCode 2.0 binds a whole drain, every tool,
the shell's working directory, and each child agent's location to the session's saved location,
and applies a move only at a step boundary. Prompting before the move lets the whole first step,
including writes and children, run in the canonical checkout. Follow this ordering after a restart
too, when neither pair is trusted.

Tools follow a two-phase guard (`session/tool-execution-gate.ts`). Before the base checkout exists,
only tools with no filesystem dependency run: questions, task tracking, web access. Skills wait for
the copy. After it, reads of tracked files, searches outside pending roots, and a short read-only
shell allowlist run while ignored content finishes syncing (Git listings of ignored files, such as
`ls-files -i`, wait); calls that could touch a root being copied, replaced, or removed wait for
the sync. Every filesystem tool, snapshot and diff runs in the contestant's own instance. Nothing
opens an instance at the path before the staged worktree is there: one opened on the empty
reservation would treat it as a directory without git. A refreshed pair keeps
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
FSEvents replays the last few milliseconds before a stream starts, so a root cloned immediately
beforehand arrives as an event on the root itself; the slot watch counts such an event only when the
root's lstat identity changed since the watch began. The replay also leaves parcel remembering the
root's mtime, and a root moved away and straight back keeps its mtime, so parcel then drops the move.
A slot watch that let a replay through therefore takes a new native watcher a second
later (`REPLAY_MS`).

Release the retained winner in the background at send, but wait if any of its ports still accepts
connections: an old preview URL in history must not reach the previous environment. Put this
transition in the UI report, never a contestant prompt. A failed release marks `cleanup_failed`
and retries on the next send.

Location services and initial snapshots start with the first prompt. The V2 adapter's
`SessionPrompt.prepare` is a no-op (`arena/session-runtime/index.ts`); do not assume warm
preparation has booted those services.

Arena keeps snapshots for recovery but skips OpenCode's automatic per-step diff summaries.
A branch switch can make a JavaScript diff block both contestants for minutes. Snapshot
patches use native Git with time and output limits; battle review owns its separate comparison.

Every turn receives a fresh port bank. Proxy routes are keyed by turn, side, and service and use
`.localhost` hostnames; old URLs must never reach a later process. Allocate banks sequentially from
20000–29999, below OS ephemeral ranges, skipping occupied ports and well-known defaults
(`sequentialAllocator` in `arena/preview.ts`). The persistent cursor prevents reuse until wraparound.

The canonical chat keeps the winner's literal ports and preview URLs so the reader sees what
worked. A contestant's fork retargets them to its own bank (`arena/port-retarget.ts`). Match only
the producing run's bank, using the winner's canonical message range from `canonicalUserMessageID`
through `canonicalLastMessageID`; older grafts without the end marker count until the next battle.
Battle-off messages and conflict-resolution messages outside those ranges stay unchanged. Apply
replacements in one pass so a new port equal to an old one is not rewritten again.

Answers, reasoning and tool calls share the standalone-number rule. Names, versions and paths stay
literal, as do user messages, attachments, metadata, IDs, binary data, data URIs, base64, long hex,
UUIDs and JSON over 2,500 characters. Preserve file content read or written by file tools: an edit
copied from history must still match disk. Reasoning with metadata stays untouched; Arena saves
reasoning without that metadata (`arena/privacy.ts`). Shell output follows the common rule even
when it prints file content, so the prompt tells contestants to reread files before editing them.
A PID, size or line number equal to a port can change too. A list of port-shaped expressions missed
real ports in socket tuples, LAN URLs and compound commands; do not reintroduce that allowlist.

User messages, file content and long JSON can still name an earlier round's port. The native Arena
shell wrapper refuses commands that spell out retired bank ports or preview hostnames, including
commands from descendants (`arena/ports.ts`). The refusal names this round's ports and preview URLs.
Only bank ports with a recorded listener retire; a project's own fixed ports remain available.
A command that reads a retired port is refused too. A port hidden in a script or config file is
outside this check, and a failed ownership lookup refuses nothing.

Expand `$ARENA_PREVIEW_URL…` in finished answer text for the reader. Leave port variables as written.

The transcript hash is what lets the engine refuse to start when git and the transcript have drifted
apart independently — the sign that something edited the checkout behind Arena's back.

### Automatic workspace cleanup

Settings → Storage shows the two limits apart because they guard different things: a parent
worktree from New worktree holds the user's own work, and a contestant slot holds only a battle's
attempts, whose chosen result is applied to the checkout.

The daemon keeps a soft target of materialized, app-owned parent worktrees across projects:
`worktreeRetention`, fifteen by default, `null` to keep them all. Chats sharing a checkout count
once. Original source checkouts are outside this policy.

A chat's contestant slots (warm pair, retained winner, free slots) have a limit of their own, since a
chat in the source checkout has no parent to evict. The daemon keeps them for the
`arenaEnvironmentRetention` chats with the latest battle activity (five by default, Settings →
Storage, `null` for every chat) and releases the others' at most once a minute, or at once when the
limit changes (`arena/environments/trim`). Release takes what archive takes and keeps the chat
ready; its next send builds a pair from nothing, as its first battle did. A chat keeps its slots
while a battle or agent turn is in progress, a pair is being prepared, its retained winner has files
its recorded result does not hold, a terminal is open in one of its slots (`terminalOpenUnder`,
checked before anything is stopped), the app shows the chat (an open stream, as for unloading
above), or a send to it is waiting for its start lock. The last two are checked again before the
release stops anything and before it removes anything, so a chat opened or sent to meanwhile keeps
what is left. Only a ready chat is released: a blocked chat's trunk is unavailable until it comes
back, and a failed chat can only be archived, which takes its slots. Otherwise the release stops the
servers the agents left running, as the next send would: winners often leave a preview running to
check their build, and it would hold the chat's largest copy for as long as it lived. It then
disposes the pool's OpenCode instances, which take a language server the engine started with them,
and keeps the slots only if a process still works in the pool. Free up in Settings → Storage
releases every idle chat's. While an open project's volume has less than 10 GB free, only the latest chat on
that volume keeps its slots, whatever the limit says (`LOW_DISK_BYTES`): they can be built again, and
a full disk fails the git writes every battle and vote depends on. Chats on other volumes keep the
limit, since releasing them frees nothing on the full one. The Storage page shows the fullest
volume's free space and says when this applies.

Cleanup runs in the background, oldest chat activity first. Viewing a workspace does not update that
order. Pinned workspaces, foreground work, active agents or terminals, and unresolved battles stay
protected. If no safe candidate exists, the count can remain above the limit without blocking creation.

Before removing files, cleanup saves the exact commit, staged state, and working files, including
non-ignored new files. Git refs in the surviving source repository retain the snapshot through garbage
collection. Ignored files—including local configuration and databases—and running processes are
excluded. Conflicted indexes, unsupported repository states, and more than 100 MB of new and changed
files (`SNAPSHOT_MAX_CHANGED_BYTES`) are skipped: every saved file is a blob in the user's `.git`,
and a file that large is usually a build output or dataset that belongs in `.gitignore`. A retained
contestant with newer, unpreserved code also prevents parent cleanup. The snapshot refs live under
`refs/agent-duel/`, so `git log --all` shows them and `git push --mirror` pushes them, untracked
files included, as it does `refs/battles/`.

Archive takes the same snapshot before it removes an app-owned worktree (`preserveForArchive`,
called from the archive's directory removal). Every archive path passes that hook as
`preserveWorktree`: the app, `paseo worktree archive`, the MCP archive tool, auto-archive after
merge, and an agent's auto-archive. Keep `ArchiveDependencies.preserveWorktree` required and the MCP tool host's missing-hook check,
so a new archive caller cannot remove the directory unsaved. Paseo's restore rebuilds an archived worktree from the
branch in its workspace record and drops the uncommitted files. A New worktree records no branch: it
starts detached, and "Create branch here" or an agent's `git switch -c` does not reach the record
until it is next refreshed. Without the snapshot, Restore would start a new branch at the base and
drop the chat's work. The archived workspace then reads as cleaned up, and Restore recreates the code
as below before it unarchives the chat. If the snapshot fails, archive keeps the directory and
unarchiving opens it as it was. The app's archive says why in a toast. Auto-archive after merge has
no UI, so only the daemon log says why ("Worktree code could not be saved during archive", then
`removedDirectory: false` on the auto-archive line). The archive dialog says the work is saved for these
workspaces (`archiveKeepsWork` on the workspace descriptor).

Read transcript works after the archived chat's worktree is gone. Reading leaves the archived
agent record and saved history unchanged, and leaving the transcript releases its engine reference.
Restore opens an interactive session. Find searches loaded messages only; load earlier messages
to include them. The transcript owns its pages separately from the live chat store, which can
still hold that chat's epoch and last turn from before archive. Keep an open Archived list current
when another window removes a chat, including one absent from that window's active chat directory.

A snapshot is released (refs and manifest) once Restore files has brought it back, when its project
is removed (a project added again gets a new id, so nothing could restore it), and when its
workspace record is removed. Project removal also deletes the archived records it released, their
stored agents (with the fence, close, flush and `agent_deleted` of Paseo's delete), the agents' empty
folders, and their creation and `agent-requests/` receipts. Two projects share a worktree root when you
add an app-owned worktree's path as a project and start a Local chat there: both records name that root
and, once both are archived, one snapshot. Project removal releases that snapshot only when no record of
another project still uses it, and it removes the records before it releases the snapshot, so a failure
on the way never leaves a record without its saved code.
Keeping those records as Paseo does would allow a later relink to restore only the base commit.

Cleanup leaves the workspace and conversation available. Restore files recreates the saved code at
the same path and never overwrites an occupied directory. HEAD goes back on the branch it was on when
that branch still points at the saved commit and no other worktree has it; otherwise it stays
detached. It then seeds the
checkout's ignored content from the source the way a new worktree is seeded, so dependencies and
local configuration come back without being stored; seeding failures cost that content, not the
restore. It does not rerun setup or restart services. This is recovery from workspace cleanup, not
a backup against deleting the source repository. Both limits count directories, not disk bytes: on
APFS a slot's clones share blocks with the checkout until something writes to them.

## A turn

**Start** (`startTurn` in `arena/service.ts`). Refuses unless the chat is `ready`, no turn is active, and no
ordinary turn is in flight. A failed first send returns the saved message to New chat. Keep its
error and retry instruction in the scrolling setup area until dismissed, so a long startup error
cannot cover the composer. Freezes canonical `HEAD` together with the exact staged, unstaged, and
nonignored-untracked state in `refs/battles/<chat>/turn-<n>/base`, then draws a pair. Both agents
work from that frozen state, so later canonical movement cannot shift the ground under a running
battle.

An untracked embedded repository, a directory with its own `.git` the checkout does not track, is
frozen as its files: what that repository tracks or leaves unignored, filtered through the
checkout's ignore rules, and never its `.git` (`stageEmbeddedRepositories` in `arena/git.ts`). The
filter is there because a contestant has no `.git` in that directory and reads the files through the
checkout's rules. `git add -A` cannot be used for them: it records the directory as a gitlink to a
commit only the embedded repository holds, and fails outright on one with no commit. The vote writes
the winner's edits back into the embedded repository as uncommitted changes. A winner that replaces
its directory with a file is refused, since the write would delete the `.git`. A contestant that
commits those files makes the checkout track them once it wins. A gitlink the checkout tracks,
submodule or not, still reaches a contestant as an empty directory.

**The draw** (`arena-service/src/pool.ts`). The service draws two distinct profiles uniformly from
its pool; which one lands on side A is part of the draw. It stores the private mapping permanently
in `arenaAssignmentSets` and returns one opaque assignment id per side. The set is account- and
turn-scoped and idempotent for retries. The local turn and run records contain those opaque ids, not
model names or slugs, until resolution. Changing a pool does not change assignments already stored.

In hosted mode the control plane draws from its active model set.
Development is the default and uses `defaultPool` (`arena-service/src/default-pool.ts`). Production
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
  that path from the upload id, never from the client's path. Before each prompt and reply the engine
  opens each upload's directory to the contestant session (`allowReading`). Battle off opens the
  same directories before sending a prompt or steer, including in a resumed chat. Uploads need no
  approval card. Contestant grants come after the sandbox's rules (see **Setup**), so an upload
  stays readable wherever `$PASEO_HOME` sits. Both sides get the same path.
- Contestants take PDFs. OpenRouter passes one natively to a model that reads PDFs and parses it
  with mistral-ocr for one that does not, so the two sides can read different renderings of the
  same file.
- The engine resizes each image once, at admission, to 1568 px and 600 KB, and names it
  `attachment-<n>.<ext>`. Every model call re-sends the conversation through the control plane,
  whose hosted function takes about 4.5 MB per request, so a message carries at most four images.
  The composer holds a battle message to that count when images are attached and refuses a send
  over it: the engine's refusal comes only after New chat has created the chat.
  An image's own file name never reaches the models, transcripts, or judge.
- Images a contestant reads with its tools are not resized, and they stay in history, so they
  reach the 4.5 MB limit within one turn. Vercel refuses a larger body before Arena's code runs,
  and the side fails on a bare 413. The measured cap is 4,494,157 bytes of body, and headers count
  against it. The engine leaves the oldest images out of a request, only as many as it takes to fit
  (`engine-runtime/request-size.ts`), with a note in each one's place. Each removal costs a
  prompt-cache miss, so a chat at the limit misses the cache on every step that reads an image.
  It never drops the newest step's images to fit older ones; what does not fit
  of that step, or an image too large on its own, gets a note asking for a separate read or a
  smaller file. Canonical history keeps every image. Reasoning is sealed between calls, so an
  agent that keeps no written notes re-reads removed images in a loop; a third read of the same
  file with the same bytes is not attached, which ends it.
- Every model in both pools must read images. The control plane's catalog check refuses one that
  does not: excluding it from a draw only when a prompt carries an image would reveal the model.
- The turn keeps labels and a text excerpt, never bytes (`TurnDocument.userAttachments`). The live
  battle shows them inside the prompt bubble as attachment pills, in one row with the image thumbnails,
  the way a single agent's message shows its uploads; the judge, which reads text only, gets them listed
  with the excerpts.
- After the vote the chat's history is the winner's session, which holds the images. The daemon's
  replay keeps them with the user message, and each attachment text part carries its label under
  the `arenaAttachment` metadata key, the one text metadata `ArenaPrivacy` keeps, so the history
  shows a chip instead of gluing that text onto the prompt. A history page names each image
  (`imageRefs`) instead of carrying it, and the app fetches one when it shows it
  (`agent.timeline.get_image`): pages count messages, not bytes, and a long chat's screenshots made
  one tens of megabytes. Replayed images stay out of the replica cache.

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
references in assistant text. Later turns can reuse a path the assistant printed. Bash output has two
explicit adapters: the result of a plain `pwd`, and a complete single-line `cd <literal> [&& pwd]`
command example. Shell expansions and paths crossing `..` remain unchanged; resolving them requires
runtime state.

When the winner is copied into the chat (`graft`), every string the model reads again also has its
Arena references replaced (`arenaReferences` in `arena/canonical-path.ts`): tool output of every
tool, tool inputs and errors, reasoning, and text the engine adds to a user message. A subagent's
user messages are rewritten too, since its parent wrote them with `task`. Only text the user typed
and image bytes keep their bytes. A slot of the checkout's pool, from any turn, either
side or a spare, becomes the checkout; its host repository, `<slot>.git`, becomes the checkout's
`.git`; and a contestant temp directory becomes `$TMPDIR`, since it is deleted with its run. They are
matched in every spelling a tool prints: after `file://`, under `/private`, behind `../`, and from
`~` or `$HOME`. A slot is matched by the names Arena gives slots (`SLOT_PATH_PATTERN` in
`arena/domain.ts`), not by reading up to the next separator, which swallowed a sentence's closing
`.` and a JSON string's `\n` with the path. Unretargeted read headers and search or shell output send later turns back to a slot that can be
gone or owned by another side. Chats copied before the
change keep their old paths, so the fork never localizes a checkout path into `.agent-duel`: it
would name a directory inside the contestant's own worktree that does not exist.

The fork clears repeatable tool output from before the last finished turn
(`pruneToolOutputBefore` in `arena/fork.ts`, `lastTurnStart` in `arena/service.ts`). Keep the last
turn's output as recent context. Output the contestant cannot get back stays: a question's answers,
a subagent's report, a skill, an MCP tool's result, and a read outside the worktree, such as an
earlier turn's upload, which the sandbox below closes. The call and its input stay, and the model
sees OpenCode's "[Old tool result content cleared]" placeholder instead of the output. A battle
turn starts at its grafted prompt and includes its replies; a prompt written after the graft is a
single-agent turn, and a steer belongs to the turn it steered. Clearing at the fork costs no cache:
a turn draws new models and a new worktree path, so its first request never reads the previous
turn's cache. Never prune mid-turn, which would rewrite the warm prefix. Both sides have to clear
the same output, so the send reads the boundary once, from the transcript it freezes, and forks
again a side whose warm fork used another. Pruning leaves the canonical session and its transcript
hash intact, including single-agent turns that continue one model whose cache survives. Use
canonical history when you need complete tool output. Feedback context is a bounded diagnostic
copy of the daemon timeline; cut tool fields carry original and retained sizes where those were
recorded. Older rows cut without size metadata cannot report the missing size.

Keep the winner's child transcripts available after a vote and after reloading the chat, including
nested children. Their headings must open and close on the first click in both the newly applied
turn and older history, even after the contestant releases its worktree. Hovering a heading must
keep it under the pointer while following is enabled; paced streaming text must still follow the
bottom as it grows. Inside each child, open its task prompt, commands and result without reopening
the child.
OpenCode 2.0's `subagent` calls use the same inline child view as 1.x's `task` calls.
The graft copies descendants under the chat and retargets their session references; the run's own
sessions are deleted on release. Losing contestants and earlier turns have separate session
families. `canonicalSubagentSessionIDs` records the copies for an interrupted graft's cleanup.
Rebuilding the chat's timeline drops the subagents the daemon knew of, so loading a winner reloads
them from the session's children (`reloadProviderSubagents`), including unchanged children from
earlier turns. Do not infer that a child is disposable
from a missing tool call: commands can create children without one, and a committed rewind removes
messages without deleting their children. Child sessions have no separate visible/internal
classification; narrowing retention needs a rule for which of those transcripts the chat keeps.

A contestant can read the main checkout but write only in its own worktree, host repository and
side temp directory. File tools and literal shell targets follow the same rule. Direct targets in the
checkout's `.agent-duel` and other sides' temp directories are closed to reads too. The shared temp directories
(`/tmp`, `/var/tmp` and the system temp directory) stay readable but not writable. Children inherit
the side's rules and share its temp directory, even if a child was created before the parent moved.
Background shell output belongs in that side's `$TMPDIR`, and the tool result names that file.
The shared shell-output folder is closed to contestants: it can contain the user's commands and
older battles. Keep side output until the run's sessions are disposed; releasing the run removes
its temp directory. Winner transcripts retarget those temporary references before release.
These restrictions apply with either permission mode; a blocked filesystem request returns a denial
to the model without waiting for a permission card. Battle off keeps its own filesystem permission behavior.
In both modes, Agent Duel owns session names, session locations, worktree management and model
selection. Hide OpenCode's tools for those operations and their prompt guidance from the model,
including child agents. File tools, shell, child agents and MCP tools stay available through `execute`.

Web search runs on one provider, OpenRouter, set as Core's default (`arena/websearch.ts`), so Core's
form that asks which search provider to use and whether to send the query never opens: the app has
no card for it, and every search failed after a minute. A search goes to `/api/arena/websearch` on the
battle backend, which sends the query to the utility model with OpenRouter's `web` plugin and no
engine, so OpenRouter picks its default engine, and returns the URL citations. The query carries no
model or side. The hosted route is limited per account; BYOK searches on the user's key with no limit.

The checkout's `.git` is readable too. A side's result is imported into it under `refs/battles/`
as soon as the side finishes, before the vote. Git objects can contain other contestants' work;
these tool checks do not filter object contents.

The shell check shares the parsed-tree walker used by Ask before tools, but distinguishes
reads from writes so a checkout file can be a copy source. A write is a redirect, an operand of a
file command (`rm`, `mv`, `touch`, `mkdir`, `tee`, ...), a copy's destination, an in-place edit
(`sed -i`, `perl -i`) or the value of an output flag (`curl -o`, `npm --prefix`, `tar -C`, `dd of=`);
every other operand is a read (`battleOperands` in `engine-runtime/outside-project.ts`). Do not count
an unknown program's words as writes: URLs, JSON bodies and `sed -n` of a log then read as paths, and
the bench refused about a dozen safe commands that way. Interpreter code (`node -e`) is not scanned
in a battle. The check reads inline shell code, and follows existing symlinks, including parents of
new files.
These tool checks provide no operating-system sandbox. See [Gotchas](#gotchas) for unscanned paths
and code. Programs' internal file operations also escape the scan, and searches from an ancestor
can enumerate restricted descendants. Do not claim that it confines arbitrary code.

Each side has a temp directory under the system temp directory, `opencode/arena/<root session id>`.
Shells in the side and its children export it as `TMPDIR`, `TMP` and `TEMP`. It is removed when the
run gives up its worktree: released for the
next pair (`releaseRunSlot`) or removed by archive, eviction or an environment release
(`removeStoppedRun`).

Keep the shared-temp restriction out of the system prompt. A denied write names the path it refused
and the side's `$TMPDIR`, and a shared temp write says to use the same name under `$TMPDIR`: told only
to "write in your own folders", models retry the write in other forms. A denied read says other
Arena worktrees and other sides' temp directories are closed. Do not include absolute rule lists: they expose home-directory paths to
transcripts and research uploads. Shared temp writes can otherwise overwrite the other side's work.

Prepare and prompt both sides concurrently, each with its own host repository, session and worktree.
Use copy-on-write host clones where the filesystem supports them.

Contestant subagents share their parent's worktree and run in the background when the call sets
`background=true`. Give independent children separate file scopes so they can work alongside the
parent. Core can end the parent's run before its children and wake it in a new run for each result.
The side's prompt fiber therefore follows those runs (`awaitChildren`) until the parent is idle,
no child works, and every result has reached the parent. Join with `prompts.join`: `prompts.loop`
on an idle session pays to answer the last message again.

Allow five hours before cancelling a hung child and failing the side. Store the reason in its error
and the engine log, and let the battle reach a decision. Do not show a countdown.

Stop, early selection, terminal parent failures, and Send now cancel outstanding children. Core
has no combined cancellation call, so `cancelRun` interrupts each child and cancels its job. Keep a
cancelled result in the parent's history: it was promised a notification, and Send now or Retry
resumes it. Hold the parent's wake (`SubagentJob.hold`) until its next prompt or loop so cancellation
cannot spend another model request after Stop. Wait for cancelled children before finalization
(`settleChildren`), or a late result can arrive after the final Git state was captured. See
[Gotchas](#gotchas) for crash recovery limits.

The contestant instruction (`contestantSystemInstruction`) rides on the user message as `system`,
and each request builds its system prompt from the latest user message. The system text heads the
cached prefix: when it changes mid-turn the provider re-reads the whole conversation uncached, and a
message without it leaves the contestant without its instructions. So a user message added in the
middle of a turn keeps the system the turn already sends:

- A child result copies the system of the parent's last user message, none included
  (`tool/task.ts`). A single-agent turn in the canonical session follows the winner's grafted
  prompt, and that prompt's contestant instruction is wrong for it.
- The follow-up after automatic compaction copies the system of the prompt the compacted request
  answered (`session/compaction.ts`). The compaction message itself carries none, since only the
  summary request reads it.
- A reply or a steer reuses the system the run's first prompt carried (`startedSystem`). A cold
  side's staging note stays after staging finishes: an instruction built again would leave it out.
  It is reused only while a fresh build, with or without that note, gives the same text. Preview
  routes live in the engine process, so after a restart the stored preview URLs can be dead, and
  the reply takes the new ones at the cost of one uncached request.

The local OpenCode HTTP server is not an Arena client API. In Arena mode the daemon authenticates
all session and orchestration calls with its private control token, while the OpenCode process keeps
only a one-way verifier. The renderer and browser QA harness continue through the daemon protocol,
and contestants receive neither the token nor an alternate prompt endpoint. Direct prompts to an
unresolved contestant or an active canonical battle session are rejected even when they arrive
from the authenticated daemon. The authoritative route policy and public exception are documented
in [Security](../SECURITY.md#agent-duel-control-plane).

The same guard (`protectedSessionMutation` in `server/server.ts`) refuses every other change to
those sessions, including an agent or model switch. The daemon reapplies the stored agent and model
on every resume, so reopening a chat whose battle waits for its vote sends both. The guard answers a
switch that names the current value with 204 and does not forward it, because upstream's agent
route appends an `agent-switched` row even when nothing changes. A stored value can still differ
from the session's: a chat migrated from 1.x has no model on its session, since 1.x passed it per
prompt. Resume then keeps the session's value and the chat opens for the vote; the daemon session
holds the refused selection and applies it before its next agent, model, or prompt action, which
the guard lets through once the battle is resolved (`DeferredSelection` in `v2/configuration.ts`).
An explicit agent or model choice drops the matching deferred part when it is called, and selection
writes run in call order ([Battle off](#battle-off)), so a deferred value never lands after the
user's choice. The dropped part comes back when the newest choice for it fails, also when several
choices overlap and Arena refuses them all.
Filling a missing model is a change like any other here: the transcript projection gives user rows
the session's model, so a fill moves the canonical transcript hash. The guard refuses with 400 and a
`message`: the generated client keeps an error body only for a status the route declares, every
session route declares 400, and a 409 reached the app as a bare `UnexpectedStatus: 409`.

**Finalize** (`finalizeSide` in `arena/service.ts`). Each side settles on its own. A background shell
does not delay the final answer or the vote. Its service stays available for Preview under the
[contestant environment lifetime](#the-canonical-spine-and-contestant-environments). Stop ends
session-owned shells. Once the side closes, drop its
background shell notifications; they must not change a reviewed answer or enter the winner's
history on a later turn. A contestant's foreground shell defaults to two minutes when the timeout
is omitted or zero. An explicit positive timeout is honored up to a ten-minute hard limit. Use
`background: true` for a server or a long-running command; timeout results state the applied limit
and give that advice.

Terminal state and the actual Git state are recorded under the generation's private battle refs, numstat is stored, and
applicability is set to `applicable` only when the frozen base is an ancestor of the result. A
companion private ref transports the final index tree. Recording must preserve empty and multiple
commits, commit-plus-residual state, and the index and dirty working tree; Arena does not add a
wrapper commit to the developer-visible history. A dev server or build watcher the contestant left
running is paused (`SIGSTOP`) while the result is read and resumed afterwards: one that keeps
creating and deleting files fails nearly every `git add`, and killing it would take the preview the
voter opens. Groups with a controlling terminal keep running, since stopping a terminal's job
suspends it in its shell (`pauseOwnedProcessGroups` in `arena/services.ts`). Untracked dependency and cache folders
(`node_modules`, `.venv` and the like, at any depth) are not part of a side's result: the
contestant's own repository excludes them, because a project that ignores only its root
`/node_modules` would otherwise count a tool a contestant installed under `qa/` as its change and
apply it with the win (`DEPENDENCY_FOLDERS` in `src/worktree/index.ts`). A name the frozen base
already holds is not excluded: a committed `node_modules`, or an untracked `__pycache__` the
checkout does not ignore. The contestant is checked against the base, and in a committed
`node_modules` the exclude would drop a new package's files while its edits to tracked ones still
apply. When both are in, the
turn becomes `awaiting_vote` and the comparison starts in the background
(`startUtility` in `arena/service.ts`). A failed side skips comparison generation; see [review behavior](#what-this-is-for). A failed
comparison never blocks a vote.

## Blinding

A contestant's identity is hidden until the vote lands, and it leaks from more places than the model
field. Each layer has its own file:

- **Assignment** (`arena-service/src/assignments.ts`) — in hosted mode the model pool and
  assignment mapping exist only on the server. The desktop cannot derive the private profile from
  an assignment id, and assignment creation accepts no client-directed model exclusion because
  repeated exclusion draws form an identity oracle. Context and output limits stay private too:
  their numeric combination can identify a contestant.
- **Request** (`arena-service/src/openrouter.ts`) — the desktop can request only the neutral
  `contestant` model. It sends the assignment id and owning scope id through the daemon's
  capability-gated Arena proxy; the Arena process never receives the account session. The control
  plane authenticates the account, requires an exact unresolved account/scope/assignment match and
  then inserts the stored OpenRouter slug, price ceiling, provider policy, and `high` reasoning
  effort. For an `anthropic/` slug it also adds a top-level `cache_control`, because Anthropic
  caches a prompt only when asked. It skips requests without tools (compaction summaries and
  titles), whose prefix nothing reads back, and bodies that mark their own cache breakpoints. It
  drops `temperature`, `top_p`, and `top_k` from every request: the engine sets them without knowing
  the model, Claude and OpenAI's reasoning models accept none of them, and under the pool's
  `require_parameters` OpenRouter would refuse only those draws, which also reveals them. It sets
  `session_id` and `prompt_cache_key`, replacing any the engine sent, so the throughput sort keeps a
  conversation on the provider that holds its cache. A battle side keys on its assignment id. A
  single-agent chat draws an assignment per message, so it keys on a hash of the account and session
  that stays the same across the chat. The same refusal rule applies to both fields, and the catalog
  check cannot see it: run `probeRouting` (`arena-service/src/openrouter.ts`) on a pool before it
  ships. A provider that slows down mid-turn keeps the conversation; OpenRouter leaves it only when
  that provider is unavailable.
  Resolution disables further routing without deleting the assignment.
- **Keep-alive** (`arena/keep-alive.ts`) — preserve Anthropic's five-minute prompt cache during long
  tool, permission and child-agent waits by pinging waiting sessions every four minutes, for at most
  30 minutes. Finished sessions waiting for a user reply get no pings. The engine cannot know which
  contestant is Claude: the service forwards only `anthropic/` chat completions and returns the same
  empty 204 for every side, including a refused ping (`arena-service/src/keep-alive.ts`). Pings carry
  `max_tokens: 1`; zero is ignored by OpenRouter and runs a full answer. Keep them out of transcripts,
  generation metrics and stream progress. A failed ping gets one retry. Deploy the cloud's updated
  arena-service before desktop: a proxy without the response header disables pings until restart.
  The hosted daemon router must allow `x-arena-keep-alive` in both directions; BYOK skips that router
  and cannot prove the hosted path.
- **Response** (`arena-service/src/openrouter.ts`) — before bytes return to the desktop, the control
  plane strips model, provider, fingerprint, OpenRouter metadata, and cost, replaces the generation
  id, and collapses upstream failures to a generic error. The local proxy repeats the scrub as a
  defensive boundary. The shared service seals reasoning text, summaries, signatures, and encrypted
  provider blocks before they leave the cloud (`arena-service/src/reasoning.ts`). Each reasoning
  chunk still crosses the stream, with one neutral `Thinking redacted` marker and opaque continuation
  envelopes, so thinking does not trigger the model-idle deadline. The service restores the original
  blocks on the next request; tool continuation must not see the marker in place of its reasoning.
  Envelopes are authenticated against the account, scope, and assignment using a key derived from the
  service's OpenRouter key. The service drops an envelope that does not open instead of failing the
  request. Reasoning never carries into a later battle, even if both contestants have the same
  opaque model ID. New-assignment forks and winner grafts remove expired envelopes from their
  copies; the source keeps its state for recovery. This changes provider state in the copied rows
  and the new canonical transcript hash recorded after promotion. Do not migrate existing stored
  history or strip envelopes when saving a message.
  Keep envelopes throughout one assignment's tool loop, retries, and Resume after an engine restart.
  A running turn loses its sealed reasoning when the key rotates; cloud instances must share that
  key. BYOK sealing provides no secrecy from the user who owns that key.
  `Thinking redacted` is display text: never turn it into a reply or retain it as reasoning in a
  compaction checkpoint. Omit assistant requests containing only the redaction marker, since
  Moonshot rejects an empty assistant message. Preserve cut-stream text, interruption notes, and tool order.
  The small Core vendor patches in `session/runner/to-llm-message.ts` and `session/compaction.ts`
  enforce those marker rules; keep them when updating the vendor.
  Runtime-only usage can continue through the transport, but the telemetry copy never persists
  generation request bodies because system prompts and tool
  schemas can fingerprint the provider. It drops per-side token counts, native finish reasons,
  provider-specific reasoning metadata, identity fields, and raw upstream errors from stored
  responses, and rewrites provider-shaped tool-call ids before saving response artifacts. The
  control plane holds generation usage, cost, and finish reason and returns them only with the
  committed resolution. It also stores the provider that served each call, which no response or
  reveal returns. Usage keeps OpenRouter's account charge in `cost` and, when supplied, the
  provider's `cost_details.upstream_inference_cost` as `upstreamInferenceCost`; the desktop then
  records both in the research metrics. Local-store startup
  removes those fields and request/response artifacts from legacy unresolved battles; resolved
  history already exposes the contestants by design.
- **Session data** (`arena/privacy.ts`, `arena/v2-privacy.ts`) — keep each active assignment's
  canonical Core history intact for provider replay. Blind the native `/api` JSON and SSE boundary, the Arena recorder, and public
  transcript projections. Remove provider state and identity metadata, redact reasoning, zero usage
  and cost, flatten provider errors, and rehash tool-call IDs to `call_arena_<hash>`. Never run the
  native sanitizer over `/arena` responses: resolved battles deliberately reveal identities and
  costs. Stable streamed part IDs and UTF-16 delta offsets let clients assemble live updates;
  native exports do not define those stream IDs.
- **System prompt** (`arena/engine-runtime/plugin.ts`) — every `arena` session, contestant or
  single-agent, gets a fixed identity instruction. Replace upstream model branding before a request
  leaves Core. The text is static because assignment-derived instructions would differ between sides.
- **The judge** (`arena/comparison-timeline.ts`) — sees narrative text and tool name/status only.
  Reasoning is excluded deliberately: it dwarfs the visible text and sends the comparison model
  after differences that exist only in private deliberation.

A BYOK build runs the same layers, so the UI, the stored records, and the judge are blinded the
same way. The user owns the key, routing process, and SQLite mapping, so these layers cannot hide identities
from them. Treat BYOK blinding as a UI convention, and never upload a BYOK
vote.

The comparison uses base-to-agent changes, direct A/B differences, and visible timelines. It uses the dedicated
`POST /api/arena/comparison` route, which accepts only the expected single-message payload for an
unresolved battle scope and picks the model in the service (`arena-service/src/utility-model.ts`):
Qwen 3.8 27B on Cerebras with low reasoning, and on any failure status or network error, DeepSeek
V4.1 Flash on Baseten with reasoning off. Baseten ignores `effort: low` and reasons for thousands of
tokens, so DeepSeek runs without it. The comparison record keeps the first choice in `model` and the
model that answered in `resolvedModel`. There is no generic or unassigned comparison path through
the OpenRouter proxy.

The Commit and Create PR buttons get their text from the same model through
`POST /api/arena/metadata` (`arena-service/src/metadata.ts`), never from an agent, and so do the
name the Create branch dialog offers and the title of a chat started with Battle off. The daemon
sends the engine's `/arena/metadata` route the kind, the file list and patch (for a branch name, the
chat's title and its uncommitted changes; for a chat title, the start of its first prompt), and
the project's own instructions from Project Settings; the service builds the prompt around them, so
the route is not a general model endpoint. It takes at most 60,000 characters of changes and 1,000
of instructions, caps the reply, folds a branch name into the slug the desktop accepts, and allows
each hosted account 60 requests an hour of each kind, so branch names never use up commit
messages; a BYOK build runs it on the user's key without a limit.
Any failure, a missing control-plane route included, gives a fixed message such as `Update 3 files`
(`git-metadata-generator.ts`), so a commit never waits on the model; the branch dialog stays empty.
Deploy the control plane with the route before the desktop release that calls it.

Keep complete small changes grouped by agent against the base. Do not collapse shared work
or add a third A/B view when both base patches fit: extra directions can reverse attribution.
For large changes, keep base-to-result changes alongside direct A/B differences. The base
establishes who changed what and exposes shared mistakes; A/B differences keep a small divergence
visible beside large generated files. The timelines never establish who changed what: from the
second turn on, each contestant's history holds the earlier winners' work as its own, so its text
can recap code it never touched, and a judge that read the recap as an edit credited that side
with the previous winner's work. A later turn's request therefore names the files the chat
changed before it and neither side touched in it, computed from the first turn's base, so a
recap meets a fact about that file. It repeats the attribution rule after the timelines, because
they come last and end on each side's own account of its work. Compare complete JSON before
budgeting, preserving numeric tokens and duplicate keys. Match array records by id only when both
arrays have unique scalar ids; otherwise retain positions. A missing excerpt is unknown. File
equality and equal record counts do not prove correctness or preservation against the task. A
complete computed comparison can establish file-specific facts without sending the raw contents.
Summarization alone is not missing evidence: warn on live and archived summaries only when
comparison details were omitted. Preservation claims must stay scoped to the file and side
actually verified. Use one utility request; increase evidence quality before adding model passes.

## Resolving

- **Vote** at `awaiting_vote` applies that side, and only a side whose result can be chosen
  (`canVote` in `arena/domain.ts`), so a failure is never voted for. A vote while the other side
  failed still applies the chosen side, but it compares a result with a failure, so it does not
  count: the turn and its battle metrics carry `voteDiscardedReason: "contestant_failed"`, the
  metrics row has `won` false on both sides, and the research upload carries both
  (`voteDiscardedReason`). Analysis and the leaderboard drop any battle where a side
  failed. The control plane's resolve route records only `select:<side>`; it takes no other field.
- **Accept** at `awaiting_vote` is the vote for a failed side, sent with `acceptFailed` so a window
  that has not heard of the failure cannot apply unfinished work with a plain vote. It is open for a
  side that ended in error with its result saved (`canAcceptFailed`): its worktree and transcript as
  they stood at the failure. A side whose setup failed can hold edits no contestant made, and a side
  whose result could not be saved has at most an earlier attempt's commit. It applies like any
  winner and carries `voteDiscardedReason` too, so it does not count. The turn and metrics also name
  the side in `acceptedFailedSide`, because `voteDiscardedReason` alone also marks a vote for the
  finished side. While the other side still works, the same result is reached through Stop and Keep,
  which sets the same field, asks the same confirmation, and says first that it will not count.
- **Early vote** while still `running` claims the resolution, then cancels the loser in the
  background until it reports terminal. Ties are rejected here — a tie needs both results. The
  early choice asks before sending one, since the other side's work is gone the moment it lands.
- **Tie** applies **A**, deterministically (`voteResolution` in `arena/domain.ts`), so it needs two
  results that can be chosen (`canTie`). Over a failed run it would record a vote for a failure
  and put that run's unfinished work in the checkout.
- **Discard** is open at every vote and after a stop (`canDiscardBattle`); the app offers it at the
  vote only once a side failed (`canDiscard` in `packages/app/src/arena/decision-state.ts`). The control plane records
  `discard`, not a vote, and the checkout is left as it was. A discarded battle reads the same in
  `resolution` wherever it happened, so the turn and its metrics row carry `discardStage` (`vote`,
  `stop`, `recovery`, `archive`) and, when the voter gave one, `discardReason`. The last two stages
  are not the voter's verdict on the results; drop them when reading discards as one. A discard
  writes its metrics row at once. A comparison that finishes keeps its report. One the service refuses,
  because it already holds the battle as discarded, reads as `skipped` rather than as a failure to
  retry. A discard grafts nothing, so the chat's session never holds its prompt: the history item
  carries it, and the app shows it as a prompt row with the discarded card under it
  (`projectDiscardedArenaPrompts`). The next battle's agents do not see the discarded turn.
- **Stop** moves to `awaiting_stop_resolution`, where the choice is discard, keep A, or keep B
  (`stop` in `arena/service.ts`). A stopped battle gets no summary, so the move to `stopping` marks
  it `skipped` in the same write (`transitionTurn` in `arena/mongo.ts`). Left `pending`, the decision
  showed a summary on its way, and a restart failed it and offered Retry summary
  (`interruptedComparisonState`). Keeping a side when the other had already failed, rather than
  merely stopped, carries the same `voteDiscardedReason`, so metrics do not file it as a win.

**Applying** (`promoteImpl` in `arena/service.ts`) records the resolution and enters `applying`
in one compare-and-set. Acknowledge votes, kept sides, and review answers after that durable claim
(`applyInBackground`); Git work can exceed the client's wait. The feed carries progress and failures,
including `application_failed` and `canonicalization_failed`.

Keep the battle open during application, then collapse it to the kept answer. The model that wrote
it, the model it was chosen over (`over Qwen 3.8 Max`, muted), its time, and Show battle end that
answer's footer at the battle's right edge (`ArenaKeptByline`, keyed by
`arenaKeptAnswerFooterRowId`), in place of the footer's own duration. Name both: with only the
winner the reveal was half a reveal, and the other contestant left no trace in the chat. They are
small on purpose: in a long chat a large name above each answer drew the eye from the answers. The chat after a battle sits on the battle's rails (`agent-stream/arena-row-layout.tsx`):
a battle's prompt keeps its bubble at the battle's right edge (`ArenaRow` `prompt`), and the rest
keeps the reading width from the same left edge, so nothing moves sideways when a battle closes. A rule goes above each turn's
prompt after the chat's first row, live battles' included, never between a prompt and its answer:
under the prompt it read as the previous answer belonging to the next prompt. Show battle opens the
battle in place of its kept answer (`shown-battle.ts`, `arenaKeptAnswerRowIds`), with the vote's
names in place of Agent A and B and its review under them. It ends with the decision row as it was
left (`ArenaPastDecision` in `decision-bar.tsx`): the same three buttons, the one taken marked and
the others quiet, with Hide battle where Ask a follow-up was. It also retains the transition report.

A battle chat's header names the project only, with no rule under it: the battle's prompt heads the
page. Commit shows once a battle is decided, and the editor, environment, scripts and changes sit in
the overflow, where a narrow header puts them anyway (`useArenaWorkspaceHeader`). Its Environment
item opens checkout and environment details.

Show recorded setup and application operations in the conversation. Hide panes, replies, and early
choices until setup finishes, including copying that overlaps model startup. Keep Stop available
from the running state; it aborts copying. Keep completed steps beside concurrent active steps,
show elapsed time, and reserve timeline height. Failed or interrupted steps get no completion check.
A retained winner with live services does not prove cleanup. Preserve completed transitions in the
report; ordinary background preparation stays silent while failures remain visible.

Apply the Git state captured at [Finalize](#a-turn). Include every branch, tag, and remote-tracking
ref the winner moved, its own branch included; the run's permanent ref holds its real `HEAD`.

### The review

Plan every Git change before writing the checkout or refs (`planWinner` in `arena/service.ts`). Each
ref the winner moved is compared with the developer's repository now: what the agent did
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

All other items share one callout: the files, then
the branches with what happened to each, and three answers that settle every item at once. With one
item, the title, the buttons, and a bullet list of the commits an answer removes name that item. **Keep my
changes** keeps the developer's version of each item. **Apply winning changes** takes the winner's;
replaced values go under the turn's `replaced/` refs and replaced file edits stay on the safety ref,
which the card names. **Let an agent resolve** applies the winner with the developer's work kept and
conflict markers where files can hold them, then sends an agent what is left to combine
(`resolvePrompt` in `packages/app/src/arena/review.ts`), told to ask before it removes anything.
The prompt waits until that apply has settled (`heldResolveStep`), so the agent never edits the
checkout while Arena writes it, and a failed apply sends nothing.
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

Git application waits until every item has an answer. Apply the checkout and refs together,
rolling back a partial write on failure.
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

Copy the winner's transcript and retain its environment alongside Git application
(`promoteImpl` in `arena/service.ts`). The graft drops any partial remnant before copying, so retry
cannot append a second copy. Finish the graft before parking for review: a half-copy above later
user messages cannot safely be replaced. Use `unappliedWinnerNote` above while those files are unapplied.

A `conflicted` turn stays parked until its markers are cleared. Once application and grafting
settle, release the loser's environment, re-record the canonical transcript hash, and complete the
turn. Keep the winner's environment until its next send or cleanup.

While application is running, the composer accepts one prompt for the next turn. Send captures the
current Battle toggle, stops the retained environment as part of the human/agent environment
transition, then waits for the chat to become ready before starting that battle or ordinary
single-agent turn. A queued battle appears in the feed as Agent A and Agent B preparing, using the
same presentation as a new battle. A failed battle start restores the prompt to the composer; a
failed single-agent send stays in the queue for editing and retry.

## The reveal

`identitiesRevealed` in `arena/domain.ts` governs the public projection. Resolution reveals both
identities once either side has shown text, reasoning, or a tool call. Two cases stay blind:

- A battle that failed during creation ends locally before the control plane answers. The chat
  shows **Battle couldn't start**; **Try again** sends the same prompt with a new pair.
- A discarded battle with no output from either side shows **Battle discarded**
  (`anySideShowedOutput`).

Resolve those assignments in the background to stop routing, without persisting their usage. For
other decisions, resolve on the control plane before recording the local choice. It accepts only
that assignment kind's decisions, and the first is immutable: a retry returns the committed
decision, which the desktop must honor. Write the resolution and revealed names together so no
unresolved record contains identities. The server retains assignments permanently, so an old
unresolved battle remains resolvable. Mask failed run text as "Contestant run failed", except for
approved neutral recovery messages. Rejected user keys have a BYOK-only message; see
[Bring your own key](accounts.md#bring-your-own-key).

A committed `discard` has no side to honour. Every request that meets it must finish that discard
(`discardCommitted`), including after another window's Retry or reply claimed the turn back to
`running`. Stop those runs first. The discard also lands in `interrupted_recovery` and
`finalization_failed`, revealed as an aborted battle would be: the control plane will not accept an
abort over its committed decision.

`identity.name` is the profile's display name, which the app uses for vendor marks and labels.
The app receives no names before reveal.

## Battle off

The Battle toggle is per turn. With it off, choose **Medium** (the default) or **frontier**.
Medium shows **GPT Luna 5.6 Xhigh** and allows continued use without a rating. Frontier draws one
contestant from the battle pool and hides its identity until a thumbs-up or thumbs-down rating.
The question-mark control explains this before the user sends a prompt.

A frontier turn locks the chat composer and its settings until its completed result is rated.
Keep Stop and tool permission responses available while the agent works. When it finishes successfully, show
an in-stream rating dialog below the response, with both thumbs and no dismiss action. The disabled
composer’s tooltip points to that dialog. A failed save stays in the dialog and leaves the gate
closed for retry. The gate belongs to the persisted result, so changing the local preference,
reconnecting, or starting a battle cannot bypass it. If an older frontier result still needs a
rating, surface that result first.

A failed or incomplete response asks for no rating and leaves the composer and its settings
usable, including after an engine restart. Keep the failure and any partial work in the chat;
the contestant's identity stays hidden. Previously saved failures must not keep the gate closed.

A turn the user stops has an optional rating. The dialog offers Skip, and the next turn replaces
it. Keep `stoppedAt` on the record so analysis can separate votes on stopped turns from votes on
finished ones.

Each Battle-off prompt starts a new scope and assignment. Earlier envelopes cannot open, even
when the selected size stays the same. Filter them from outgoing context before transport; retain
the canonical rows so the transcript hash stays stable. Follow the sealed-reasoning contract under
[Blinding](#blinding) within the current scope.

Both sizes use the assignment boundary, and `reconcileNormalTurn` (`arena/service.ts`) folds the
resulting Git and transcript state back into the canonical spine. A process-local reservation
keeps a battle and an ordinary turn from racing for the same session. The shared arena-service
assignment route accepts `modelSize` for single-agent turns; deploy that contract in the hosted
control plane before shipping a desktop build that sends it. A request without `modelSize` gets a
frontier assignment, because released desktop builds send none and route as `contestant`.

The size lives on the canonical session as its model, `arena/medium` or `arena/contestant`.
`beginNormalTurn` reads it at each prompt and sets the variant from the size, so a variant has no
meaning of its own in Arena. The app still sends a model change and a variant change together, and
in 2.0 each one is a separate `switchModel` on the session. So in Arena mode the daemon's
`setThinkingOption` writes nothing to the engine, and agent, model, and variant calls run one at a
time in call order (`serializeSelection` in `v2/session.ts`). A variant call that wrote the model it
had cached put the old size back, and the next turn ran Medium after a switch to frontier. A queued
write that takes longer than `SELECTION_TIMEOUT_MS` is aborted, so a hung engine call cannot hold
later changes or a prompt. The job then reads the session back and counts the write as applied when
the engine holds it, because an aborted request can still have landed. A session read that a
selection write overlaps keeps the cached agent and model and reads again once the queue settles:
it can return the size from before the write. A size chosen while a turn runs waits until that turn ends
(`DeferredSelection`): each step of the running turn reads the session model, and its assignment is
for the size it started on, so a switch mid-turn failed the next step with an Arena routing error.
The daemon reports the held size and its variant at once, and the next turn runs it. A held size
that the turn already ran sends no switch.

## States and failure

`arena/domain.ts` holds the legal-transition table and `requireTransition` for compare-and-set
call sites. Read it before adding a state.

Failure has first-class states — `creation_failed`, `finalization_failed`, `application_failed`,
`canonicalization_failed`. The last two come after the decision and transition back into the step
they failed, so a resolution can be retried instead of losing the battle. A turn-level failure
before resolution aborts the battle at once (`abortUnresolved` in `arena/service.ts`): its pending
sides are cancelled and settled, so no pane keeps reading as working, its worktrees go, and the chat
is ready again. A turn startup finds in `creation_failed`, because the previous process stopped
while ending it, is ended the same way rather than parked for Keep or Discard, which would name the
pair. `interrupted_recovery` is where a turn lands when the daemon dies mid-battle.

A battle already awaiting its vote keeps its prompt, both results and vote controls after an engine
restart. Reopen the workspace after signing back in; no daemon restart is required. Sign-out and
account changes [restart the engine](accounts.md#how-the-session-travels), but the
[local store remains shared across accounts](data-model.md#who-owns-a-battle-record).

A battle still running when the engine stops reopens for Resume or Discard
(`reopenInterruptedTurn`); quitting the app records no decision. A side that had finished keeps its
result. A side that was working is committed as `interrupted`: its cut-off response is closed the way a stop closes it, so
its unfinished tool calls end interrupted and are never run again. The pill then holds only
**Resume**, its one filled choice, and **Discard** (`canResumeBattle`). Resume (`resumeBattle`)
claims every interrupted side at once and continues each from its cut-off response. No side resumes
alone, and an interrupted run has no Retry, because a side that started first would get a head start
on a battle meant to be fair. Before continuing, each interrupted side gets the same hidden note
once per battle: “The engine restarted. Check the current state before you run a step again.” A
finished side gets no note. Exclude this reminder from the winner's canonical history after the
vote; keep other synthetic messages, including background subagent results and the stopped-shell
notice below. The reminder cannot guarantee that a contestant will avoid repeating a completed
command. Until Resume, hide review and refuse every vote, including for a side
that finished: the other side has not finished. Resume spends no manual retry. Never resume
automatically at startup: it spends on both contestants before the voter returns, and a quit can
be intended to stop the work. Two cases still recover as a
stopped battle (`canReopenInterruptedBattle`): one the voter was already stopping, and one with a side
whose environment never finished copying (`environmentReadyAt`), since a resumed contestant would
work without those files. Engines before this parked every interrupted battle as stopped; startup
reopens those once (`reopenParkedInterruptedTurn`).

Core gives each shell its own process group, so a shell survives an engine that dies without
teardown. It would keep writing into the worktree, and a resumed contestant that runs the command
again would do the work twice. So the engine lists each running shell in
`$PASEO_HOME/arena/engine-shells/`, and the next start stops those shells before recovery commits a
worktree (`arena/engine-runtime/shell-ledger.ts`). Stop only what that list names: the list is per
home, so another home's engine is out of reach, and an entry whose engine still runs stays. An entry
names the PID and when it started, since the system reuses PIDs; a group whose leader has gone is
left alone, since nothing proves whose it is. Do not identify shells by an environment variable:
macOS hides another process's environment. After Resume, each affected side gets the same neutral
note that its background shell stopped and can be started again. A side with no stopped shell gets
no note. With Battle off, the matching engine-exit error stays in its place in the chat and reads
“The engine restarted, and a running command stopped.” in the app's language. Other exits keep their
existing text.

Payment failures belong to the service account; BYOK uses the user's OpenRouter account. Keep
billing details out of user-facing messages. The service distinguishes temporary request-budget,
credit-limit, and unknown payment failures, but Core classifies HTTP 402 as nonretryable quota
failure (`ai/src/provider-error.ts`). There is no automatic temporary-budget retry in the V2 path.
Never switch contestants or replay partial work to recover payment failures.

An output-token cap continues from saved output and tool results under the same assignment. Never
replay completed tools. Leave unfinished calls unexecuted and request smaller writes or patches.
Core allows two continuations, then fails on the third consecutive `length` response while
preserving completed work (`core/src/session/runner/llm.ts`). It counts recent durable user and
assistant rows: a user message or a non-`length` assistant response breaks the streak; compaction
rows do not. Failed tool results are not a separate reset condition. This budget is independent
of transport retries.

OpenRouter can report a truncated tool call as `tool_calls`, even in its native finish reason.
Treat incomplete arguments at the requested output cap as a cutoff, including usage arriving
after the finish chunk. A complete call at the cap stays valid. Normalize before the SDK flushes
arguments, or incomplete JSON can become an executable empty object.

The OpenRouter SDK ends a tool call as soon as its arguments parse as JSON and sends a delta for each
later chunk of that call. Qwen 3.8 Max sends an empty chunk after the closing brace, which Core treats
as a defect that kills the run. Core also starts the tool at the call, so `{}` followed by the real
arguments would run it with `{}`. `arena/engine-runtime/tool-stream.ts` holds each ended call until the
model finishes, as Core's native routes do, and passes everything the model sent. Late text other than
whitespace fails the JSON parse, so the tool does not run and the model is asked to send the call again.
Tools therefore start when the model's response ends, not when their arguments end. A stream cut
before then leaves the call unexecuted, with the provider or cancellation error. Complete arguments
stay in the failed call's history, so the model can see what it tried to send.

Other retryable Arena failures use Core's ten-retry allowance per logical step: eleven attempts
including the first. There is no wall-clock limit. Request time is additional to the
backoff, so repeated broken streams can take five minutes or longer. Provider retry hints can
lengthen the waits, up to fifteen minutes per hint. Cancellation and permanent errors stay
terminal. A completed step starts a new allowance. Model timeouts have the smaller limit below.

An offline machine spends no retry. When a contestant request cannot reach the network at all (DNS
fails or there is no route), the daemon's runtime proxy in a hosted build, or the in-process service
in a BYOK build, answers 503 `arena_network_unavailable`. The hosted proxy answers the same in
these connection failures: the control plane refused the connection (`ECONNREFUSED`), or the connect
timed out (`UND_ERR_CONNECT_TIMEOUT` or `ETIMEDOUT`). Then no request was written, so runs wait out a restart.
Every failure after a connection exists is a 502 that spends the retry budget: a reset, a closed
socket, or a TLS handshake drop. The control plane can have started the model call, and every wait
would start another. Node reports a reset immediately after connect the same way as one after the request
(`read ECONNRESET`). An HTTP error from the control plane passes through. On a 503 the contestant
waits with backoff capped at 10 seconds for as long as the network is gone, shows **Waiting for
network**. These persistent waits have no wall-clock limit. A closed lid is the common
case: macOS wakes briefly for Power Nap before Wi-Fi reconnects, and the window's monotonic clock
stops during sleep, so without this each wake spent one retry until the run failed. The control
plane never sends this answer; its own outbound failures are not the user's network.

A stream that ends without a finish reason or `[DONE]` is broken too (`endsResponse` in
`arena/proxy.ts`). The control plane's function time limit ends a response cleanly, mid-thought;
accepted as a finish, the step has no tool call and the run completes with no answer. Each cut
spends one of the step's ten retries; request duration does not reduce the count.

Core keeps interrupted replies and completed tool results so recovery does not replay their side
effects (`core/src/session/runner/llm.ts`). An Arena idle timeout with no text or tool call uses
`IDLE_RESTART`: there is no partial reply to continue. Keep its stored row for recovery accounting.
A partial reply uses `IDLE_CONTINUE`; other broken streams use Core's continuation prompt.
A declined or interrupted tool prevents this automatic continuation
(`core/src/session/runner/step.ts`).

If that side wins, graft its half answers, continuation notes, and completed answer in order
(`messagesToGraft` in `arena/session-runtime/projection.ts`). The next model must read what the
winner read. The chat shows separate blocks and can repeat text because models often restart a
line after a cut; synthetic notes stay hidden. Do not join, edit, or deduplicate stored pieces:
text rules can lose content inside reopened JSON, HTML, or SQL blocks. Improve the display without
rewriting the rows.

A run that fails after the budget can be retried by hand, or its saved work accepted as it stands. A
failed run cannot be chosen or tied (see [Resolving](#resolving)). When the failure is one the policy above would
have retried, or an empty compaction summary, the pane shows **Retry** under its error
(`errorRetryable`, set in `finalizeSide`).
Retry continues the same session on the same assignment from its last finished step, adding no
message (`prompts.loop`), so the battle stays blind. The pane and the applied turn's **Worked for**
footer show the winner's active time across attempts, excluding the wait before Retry.
Retry first removes the run's half answers and the
notes after them (`abandonedAttempts`), because the new answer starts over and none of them is part
of it. A half answer that ran a tool stays, because the tool's work is in the worktree. The other side
keeps working, and the turn finalizes
again once both have settled, as after a reply. Each run gets two retries
(`MAX_MANUAL_RUN_RETRIES`): every retry is paid for, and a failure that keeps repeating is answered
by the other side or a new prompt. Use `canRetryRun` in `arena/domain.ts` for both the service
refusal and the app's button.

An Arena model request that gets no response headers, or no SSE event, for 150 seconds fails with
`Response headers timed out` or `SSE read timed out`. Recovery uses the retry or continuation
policy above. The pane shows **Continuing after model timeout** until the recovery stream ends. Three timeouts in a row
are recovered; the fourth fails the run with only the neutral `IDLE_EXHAUSTED` text, and completed
work stays. The label stays until the run settles, so the pane goes straight to Failed. Only the
contestant's own model requests count; title and compaction requests neither count nor end a
recovery. A new prompt, the end of the run, or a response whose SSE finish reason is `stop` or
`tool_calls` starts the count again. A `length` cutoff or an error event inside the stream does not.
A normally finished response resets the count even if its tool failed: the fetch layer cannot
see tool results. The counter lives in memory and resets after an engine restart; continuing an
interrupted battle still requires Resume.

The chunk deadline is Core's, inside `AISDK.providerFetch`. It moves on every parsed SSE event, so
chunks that carry only OpenRouter `reasoning_details` keep a long thought alive, and keep-alive
comments do not, so a stalled model still times out. The engine plugin wraps the Arena fetch with
`providerFetch` (`engine-runtime/plugin.ts`). Assigning the Arena fetch to the SDK options directly
drops every timeout, and a stalled stream then waits forever. The header deadline and the budget
are ours (`engine-runtime/idle.ts`), and Core's header timeout stays off for contestants so Arena
owns that deadline and its recovery budget. Core's own header deadline reports `Response headers
timed out` through HTTP hooks too. When the runtime abandons a request, the daemon's Arena proxy aborts its control-plane
request too; otherwise the hosted function keeps streaming, and billing, until its own time limit.

The control plane owns model-specific compaction limits (`arena-service/src/openrouter.ts`), since
only it knows the contestant's context window and output cap. `X-Arena-Compaction: auto` marks a
request whose history can be summarized. The service returns neutral 413 `arena_compaction_required`
at that profile's savings threshold for marked requests, or at the endpoint's hard context edge for
any request. Thresholds and limits never cross the boundary: their numbers can identify the model.
The savings threshold is at most 272K and otherwise 85% of the input room. Its full-body estimate
uses the assignment's latest measured prompt size; calibration samples expire after 30 days through
the control plane's TTL index (`request-calibration.ts`).

The native Arena plugin offers compaction to the control plane and translates its neutral 413 into
Core's checkpoint-and-retry path (`arena/engine-runtime/plugin.ts`). The engine has no separate
savings threshold or fallback for an older control plane. Sealed provider state is replay metadata,
not prompt text; counting its duplicated envelopes makes reasoning-heavy chats compact too early.
Core still checks the contestant's context window. A first request or one still too large after a
summary ends with the neutral request-too-large explanation instead of repeatedly paying for
summaries. Automatic compaction must be enabled for Core to create a checkpoint.

Keep a new user message and its attachments intact while summarizing earlier history. First
messages, the step immediately after a summary, and summary requests must not be marked for savings
compaction: they have no older history to shrink. A summary may exceed the savings threshold but
must fit the provider's context window. The V2 runner retains its own checkpoint and shrinking
summary behavior (`core/src/session/compaction.ts`); the legacy rolling-batch summary path does not
configure it.

Never replace history with an idle, truncated, or empty compaction summary: a completed checkpoint
hides earlier history from the next request. Core retains the history on failure
(`core/src/session/compaction.ts`). Transport failures use its retry policy; an output-limit summary
fails immediately. A reply missing the required summary headings, including an empty reply, gets
one reminder before failure. If the summary is still empty, the pane says “The agent could not
summarize its context. Retry to continue.” Retry compacts again from the retained history on the
same assignment, within the manual retry limit above. Each side can recover independently, including
when both summaries failed; the other side's work and the vote rules stay unchanged.

A connection can also die without closing. On some mobile networks the hosted function finishes the
response while the desktop never receives another byte or a close, and only the 150-second deadline
ends the wait. The control plane writes a heartbeat comment into any contestant stream that is quiet
for 10 seconds and says so with `x-arena-heartbeat-ms`; the engine's proxy treats three missed
heartbeats as a dead connection (`arena/proxy.ts`). It ends that request and fetches the same
generation from `/api/openrouter/api/v1/arena/replay`. The control plane records the bytes of every
stream it sends, without heartbeats, for 15 minutes, and a replay of one still streaming waits up to
two minutes for it (`arena-service/src/stream-recovery.ts`). The engine skips the data lines the
model call already received, so the model call sees one uninterrupted response and nothing is paid
twice. With nothing recorded, the stream fails as a retryable break. A response without the header
gets no deadline, and the BYOK service turns recovery off: nothing sits between it and the engine.
The control plane deploys the replay route as its own function, and the daemon's runtime router
allows it by path.

Use `$PASEO_HOME/engine.log` for the V2 engine's INFO diagnostics. The daemon selects this file
through `OPENCODE_LOG_FILE` in both source and packaged launches. Without that hook, the Arena
host keeps its console logging. The file keeps the existing 50 MiB bound and trims to about
25 MiB in place; crash reports attach its tail. Process command payloads are omitted from this file.
Direct console warnings still go to the daemon log.

Diagnose deadlines with these logs and the proxy's `streamProgress` timestamps
(`arena/proxy.ts`). Compare chunk receipt, response end, artifact saving, and closure: a stream
that ended but never closed stalled inside the engine. Correlate its `generationID` with the control
plane's `arenaAssignmentGenerationMetrics`, whose `createdAt` marks the hosted function's response
end. The legacy `arena model response idle` log is emitted by `session/llm.ts`; the V2 fetch adapter
does not emit it.

A request OpenRouter refuses reaches the contestant as the same neutral error, and only the service
sees why. It logs `[arena-service] OpenRouter refused a contestant request` with the battle ID
(`scopeID`), assignment, generation, model, status and OpenRouter's answer. For a hosted build that
line is in the control plane's Vercel runtime logs, which keep about a day:
`vercel logs --query '"<battleID>"' --since 1d`. A BYOK build writes it to the engine log.

`No recent activity` means the run has had no event and no part of its model stream for 90 seconds;
it is not proof of a stalled process. Count every stream part, as the engine's idle deadline does
(`engine-runtime/tool-stream.ts`): sealed reasoning streams deltas with no text, which reach no
transcript event, and a model that reasons for ten minutes must not read as quiet. Explicit retry and user-input waits take precedence. A tool call that is still
running reads `Running a command` or `Running a tool` instead: a long command emits nothing until it
ends, the same reason the engine's deadline pauses for it. Time that label from the call's own
start as well as from the run's last event (`run-liveness.ts`): queuing or deleting a steer is a run
event too, and must not put a long command back to `Working` for another 90 seconds. A shorter call
stays `Working` so the label does not flicker from call to call. That UI label alone must not stop
or restart a contestant.

## Guard against an accidental 1.x build

Stay on OpenCode 2.0 after the switch. Do not ship a 1.x rollback to people who already run 2.0.
A released 1.x engine has no version check and would hide every turn since the upgrade. The fence
makes it refuse the database instead. Installing 2.0 again keeps the work since the switch.

The upgrade makes no pre-upgrade database copy. Reserve space for a second copy of the chat data
inside the engine database during import: a 25 GB engine database can grow to about 50 GB.
Reclaiming that space needs one compacted engine copy beside the database,
plus 64 MiB of filesystem headroom. Keep that free space on the engine database's volume.
There is no way back to 1.x without a new migration.

Only the default `~/.paseo` home may upgrade the packaged engine's legacy database in
`~/.local/share/opencode/`. Every other home must keep its engine database inside `PASEO_HOME`,
including when `OPENCODE_DB` overrides its name. The engine refuses an outside path before opening
it. The repo's dev commands select an owned engine database without extra
environment; see [Development](development.md#paseo_home) for the default and override paths.
For a custom second-home launcher, set `OPENCODE_DB` to an absolute path inside that home's
`PASEO_HOME`, or set `XDG_DATA_HOME` inside it before the first start. Setting `PASEO_HOME` alone
outside the repo's dev launch path does not isolate OpenCode's database. Do not point a dev stack
at a packaged database to get its history.

After import, the fence renames the old `session` table to `_arena_v1_session`. A 1.x engine then
refuses to start with `Database is not empty and has no session table`. The same start removes the
duplicated old chat tables before listening or running battles, when every source session and
projected message has a V2 counterpart and no source rows were skipped. A durable deletion event for
the same session explains an intentionally removed chat; an absent row alone does not. Completion checks coverage and retries missing sessions,
including imports already marked complete by an older build. Older 2.0 imports receive the same
audit. A count mismatch or skipped row keeps all old chat tables and logs counts
without chat content. Do not delete those rows by hand: they may be the only copy of work the
import could not convert.

Removing the tables keeps the 1.x refusal: `session` remains absent. At each OpenCode update,
check migrations against a database without `session`, `message` or
`part`. Fresh 2.0 databases lack these tables too.

Cleanup uses VACUUM INTO after the drop, then atomically replaces the database with the checked,
synced copy. An interrupted copy leaves the complete source; an interruption after replacement
leaves the complete compacted database. The next eligible start removes a leftover temporary copy.

Arena holds a shared file lease while using the database; maintenance needs an exclusive lease.
An idle connection from another process also postpones cleanup. Keep external database tools
closed during startup: SQLite's own locks do not protect a close-and-rename operation. If the
lease or holder check is unavailable, cleanup is skipped. Low disk space also defers the copy.
A failed or interrupted copy waits at least a day before retrying, so it cannot delay every launch.
An ordinary start after successful cleanup does not copy again.

Interrupted audit work keeps its saved cursor; if V2 changed between starts, the audit starts
again. Cleanup and waiting for the import share a deadline eight minutes after engine spawn,
including module loading and schema migrations. Maintenance stops at that deadline, leaving two minutes
of the daemon's ten-minute allowance to reach readiness. A copy whose estimated duration does not
fit the remaining window waits for a later start.

Import and cleanup run in maintenance children before the runtime opens SQLite. A connection held
across replacement would keep writing to the old file. If cleanup is deferred, a later start resumes
it before opening the runtime. Windows still imports; cleanup requires file leases and is skipped
there. Fresh and finished databases spawn no maintenance child and print no upgrade line.
An interrupted import continues from its saved cursor, keeping the import order.

Before schema migrations or other database maintenance, an unfinished upgrade announces itself to
the daemon. During import and old-table cleanup, the sidebar says "Upgrading your database. Keep the app
open until this finishes. This can take a few minutes." It stays across both steps until engine
readiness. An existing chat waiting for history says "Upgrading your database. This chat opens when the
upgrade finishes." It loads automatically at readiness. New-chat composers remain usable. Both notices
currently use English in every locale. A first send waits for readiness too; its pending state can last
through the upgrade. Initial import, resumed import and cleanup use the same spawn-relative ten-minute deadline; ordinary starts keep their 30-second limit.

If the shared eight-minute budget runs out before import completes, the engine logs the fallback and
stops the import child, then starts listening while the runtime resumes import in the background.
The sidebar notice stays until that import ends. Imported chats and new chats remain usable. A chat
whose load fails with "Session not found" shows the same upgrade pane message while import continues.
It opens automatically when its history becomes available or import ends. Other load errors keep
their usual presentation. A failed import or stopped engine clears the background notice and lets
remaining load errors show. Restarting does not retain the previous engine's import state.
Background import does not extend startup or send deadlines. Old-table removal waits for a subsequent start.

If recovery needs a new migration, stop the app **and its daemon** before preserving the affected
home's current engine database, `arena/arena.sqlite`, their WAL and SHM files, and `arena/artifacts/`.
Quitting alone can leave the daemon running when Keep running after quit is on. Never delete a WAL:
after a crash, it can hold committed tables and turns that have not reached the main file.
Keep using 2.0 while recovery is investigated; recreating a `session` table does not make 1.x safe.

## Gotchas

- Both sides are prepared concurrently, directory claims included.
- `TurnDocument.setupTimings` records where a send spent its time. Read it before guessing.
- `RunDocument.firstToolAt` records the model-emitted tool part's start time, before any environment
  guard. Tool completion controls `toolCount`.
- A tie always applies A, so it is offered only when both results can be chosen.
- An early vote cancels the loser, so its transcript stops mid-run and its diff is whatever it had
  reached.
- Review recording starts when the first side settles, not when both have, so an early vote has a
  review too. Compare early and late votes on `msFromFirstResultToVote`: `timeToVoteMs` counts from
  `awaiting_vote`, which an early vote never reaches.
- Generation-scoped battle refs preserve the contestant results. Nothing prunes them.
- The winner's hydration sends no turn completion, so the chat's stream keeps the end of that
  turn in its live head until the next canonical event; before a new chat's history loads, the
  whole turn is there. Anything placed against the chat's turns, such as summaries and the
  pending prompt, reads tail and head together (`arena/summary-anchor.ts`).
- Contestant worktrees are reused across turns. Never assume a run's directory is fresh or that it
  is removed after the vote; `worktreeRemovedAt` means the run released its slot.
- Never give a host `alternates` to the checkout's objects; see the contestant environments above.
- New turns use a fresh port bank and never retarget old `.localhost` routes.
- The production pool lives only in the control-plane package; never import it from the engine.
  The engine bundles `defaultPool` for BYOK, and a hosted runtime must never read it.
- A child agent running during a crash does not continue after restart; the desktop engine does not run Core restart recovery.
- A background child of a shell can survive Stop.
- Shell paths in variables, computed paths, scripts on disk, and code piped to an interpreter get no check.
