# Side panel

A workspace is a main pane and a side panel (`packages/app/src/components/split-container.tsx`).
The main pane is the workspace's one chat, a draft until its first message is sent. The side panel
holds what the chat works beside: Files, Changes, the pull request, file editors, diffs, terminals,
browsers, subagent transcripts, workspace setup. It is the same shape as the Codex desktop app's
right panel, for the same reason: the chat keeps its width while the things it produces stack next
to it. There are no other splits.

## One chat per workspace

The main pane has no tab row. A chat is created by creating a workspace from the sidebar; there is
no New agent entry point inside a workspace (no Cmd+T, no command center action, no header menu
item). An empty workspace seeds a draft on open (`shouldSeedEmptyWorkspaceDraft`), which is
also what closing the chat yields. Subagent transcripts open beside the chat, not as sibling chats.

## A tab's kind picks its pane

`isSidePanelTabTarget` (`packages/app/src/stores/workspace-layout-actions.ts`) is the only place
that decides. Callers open tabs with `openTabFocused` and never name a pane; the layout store creates
the side pane the first time a side-panel tab opens. From outside the workspace screen, open a side
panel tab with `openWorkspaceSidePanelTab` (`packages/app/src/workspace/side-panel-command.ts`).

Dragging a side panel tab onto the main pane moves it. Pane role is chrome (the side pane's "+"
menu), not a guarantee about what a pane contains; the main pane shows whichever of its tabs is
focused.

## The contestant terminals

Each seat's worktree menu opens one tab — Agent A's shell, Agent B's shell — and that tab keeps the
same terminal for the life of the chat. On the next turn the daemon moves the shell into the new
worktree instead of the panel opening another terminal (`terminal.rehome.request`), and writes a
rule naming the turn into the buffer it already owns. The daemon owning the buffer is what makes
the history survive a tab switch, a theme change, a reattach and a reload; a per-turn terminal
loses it at every one of those. The transitions live in
`packages/app/src/arena/terminal-target.ts`; the rule is `buildTerminalDivider` in the protocol
package, rendered server-side so it spans the real terminal width.

The panel's "+" always lists what a new terminal would stand in, under one "New terminal"
heading: the workspace itself, and above it a row per contestant. Both contestant rows appear from
the chat's first battle and stay for the rest of it, decided turns included — a menu that empties
itself between turns is one nobody can find twice, and a seat opened with no worktree waits for the
next turn rather than being refused (`resolveArenaSeatMenuSides`). A chat that has only ever sent
to a single agent lists the workspace alone.

The launcher an empty panel draws lists the same group, from the same rule, ruled off from the
surfaces above and below it. It keeps that shape whether or not the seats are there: the snapshot
the seats come from arrives a render after the panel does, and a heading that appears under the
reader moves every row below it after the click has been aimed.

Between turns the seat's worktree is deleted under the shell. It stays where it is — output from
the finished turn is the reason the tab is still open — and the next turn's rehome moves it on.
While there is no live battle the pane says so and takes no input: the seat has nowhere to work,
and a prompt that looks alive but runs in a directory the reader did not choose is worse than one
that says it is paused. Both seats pause together, retained winner included — by then that
worktree is the workspace's environment, not a contestant's (`resolveArenaSeatTerminalSides`).

## Shape

The layout tree is a bare pane, or a group of exactly two panes, main first. `normalizeLayout`
flattens anything else, which is how layouts persisted by the earlier free-form splits migrate:
chats to main, the rest to the side, in tree order. Do not add a third pane; the tree type still
allows it, the product does not.

The group's axis is the panel's placement, and that is a preference rather than part of the
workspace: `sidePanelPlacement` in app settings, right or bottom, applied on the way to the
renderer by `applySidePanelPlacement` (`packages/app/src/workspace/side-panel-placement.ts`). The
stored layout is untouched by it, so moving the panel keeps every tab, its focus and the split it
was dragged to — and one workspace cannot end up docked differently from the next. It is chosen
next to the panel's "+", and again in Settings → Appearance, because an empty side panel draws no
tab row and the reader should not have to open something first to move it. The dock control's
glyph is the arrangement (two columns, two rows), not a panel outline: that shape belongs to the
header toggle, whose own glyph follows the placement. Compact widths show one pane at a time and
have no use for either.

The workspace header's `…` is the overflow for controls that no longer fit. Environment, editor,
scripts, and Git actions move there with labels; Archive remains available even when it was the
primary action. Keep Files, pull request, new terminal, and new browser in the side panel rather
than duplicating its launchers in this menu. Import, copy path/branch, and setup keep their existing
menu access.

No pane collapses when a tab is closed: `closeTabInLayout` preserves whichever pane held the tab.
For the main pane that stops the side pane being promoted into the main slot when the last chat
closes. For the side pane it keeps the panel open on its launcher, rather than taking the panel out
from under the click that emptied it — hiding the panel is what drops an empty side pane
(`removeEmptySidePaneInLayout`, called only from `setSidePanelOpen`). `moveTabToPaneInLayout` is
the exception and still collapses a side pane whose last tab is dragged to the main pane.

## Open state

`sidePanelOpenByWorkspace` in the workspace layout store, absent meaning open. The header toggle is
the only way to hide or show it; the pane carries no close button of its own. Hiding keeps the
panel's tabs; focusing or opening one of them (not a background open) reveals it again, so a tab is
never focused while invisible. Hiding an empty side pane removes the pane; showing the panel when
the layout has none creates an empty one, whose content is the launcher
(`packages/app/src/screens/workspace/side-panel-launcher.tsx`).

An empty side pane draws no tab row: the launcher is the whole pane, and a row holding nothing but
the "+" would be a second, smaller way to do what the launcher already offers. Focus mode is the
exception — the row carries the only way out of it. E2E helpers must therefore reach a new tab
through whichever surface is present (`clickNewTerminal` in `e2e/support/helpers/launcher.ts`),
and `waitForTabBar` accepts either.

The split is the root group's entry in `splitSizesByWorkspace`; the side pane starts at
`SIDE_PANE_DEFAULT_SIZE`. It is one fraction for both placements, so a panel dragged wide comes
back as a tall one when it moves to the bottom.

Both panes have floors, in the shape of the Codex app's panels
(`packages/app/src/components/split-container-floors.ts`). Docked right, the chat keeps 400px and
the panel 319px; with the 1px handle they fill the `md` breakpoint (720px) exactly, and below it
only one pane shows, so both always fit. Docked at the bottom, the panel stays between 160px and half the height. A fraction
alone let a wide window squeeze the chat until its composer controls overlapped, or the panel until
its tabs read "T..". Each floor is a minimum on the pane plus a matching stop on the resize handle,
so a stored split from before the floors renders at the floor and drags from there. The panel never
overlays the chat; a panel that needs the whole window uses focus mode.

## Compact widths

The same panel, full width. `SplitContainer` renders one pane at a time there (`compact` in
`resolveSplitContainerRoot`): the side pane with its tab row while the panel is open, the chat
otherwise. The header toggle follows; nothing else differs, so tabs and the launcher behave as on
desktop. See
[mobile-panels.md](mobile-panels.md) for the drawer that remains.

## Where the Explorer sidebar went

| Explorer tab | Side panel tab kind | Panel                                            |
| ------------ | ------------------- | ------------------------------------------------ |
| Changes      | `changes`           | `packages/app/src/panels/changes-panel.tsx`      |
| Files        | `files`             | `packages/app/src/panels/files-panel.tsx`        |
| PR / MR      | `pull_request`      | `packages/app/src/panels/pull-request-panel.tsx` |

The battle's contestant worktree picker lives on in Changes and Files through
`useSidePanelBrowseTarget`. `working_diff` is the "Diff" tab that Changes opens for a full-width
review; it is a separate tab on purpose so Changes can stay a file list beside it.

A provider's subagent transcript (`provider_subagent`) and the workspace's Setup tab (`setup`) are
side panel tabs as well: they are things the chat works beside, not chats of their own.

A battle has no side panel tab. Its diff is read in the battle card and the archived summary,
which have the chat's width (see [arena.md](arena.md), "What this is for"); a panel beside the
card would only narrow it to show the same thing.

## Shortcuts

| Action                     | Mac                 |
| -------------------------- | ------------------- |
| Toggle side panel          | Cmd+E               |
| Focus pane left / right    | Cmd+Shift+Arrow     |
| Move tab to the other pane | Cmd+Alt+Shift+Arrow |
| Toggle both sidebars       | Cmd+.               |
