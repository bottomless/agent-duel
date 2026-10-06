import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Pause, Terminal } from "lucide-react-native";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import invariant from "tiny-invariant";
import { useQueryClient } from "@tanstack/react-query";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { agentLabel } from "@/arena/environment";
import { createArenaWorktreeTerminal } from "@/arena/open-worktree-terminal";
import {
  arenaTurnLabel,
  planArenaTerminalTransition,
  resolveArenaSeatTerminalSides,
  resolveArenaTerminalTarget,
  type ArenaTerminalTarget,
} from "@/arena/terminal-target";
import {
  getArenaSeatTerminal,
  rememberArenaSeatTerminalId,
  useArenaSeatTerminal,
} from "@/arena/seat-terminals";
import { useArenaSessionQuery } from "@/arena/use-arena-session";
import {
  buildTerminalsQueryKey,
  type ListTerminalsPayload,
  upsertCreatedTerminalPayload,
} from "@/screens/workspace/terminals/state";
import type { Theme } from "@/styles/theme";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

const ThemedPause = withUnistyles(Pause);
// The pause is a state worth noticing, so it takes the warning signal rather than the muted
// grey every other piece of chrome uses — a paused shell that looks like chrome gets typed into.
const noticeIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const styles = StyleSheet.create((theme) => ({
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  terminal: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  // The signal is the pause glyph alone. An amber rule under an amber headline on a lifted fill
  // says the same thing three times, and a shell between turns is quiet news.
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  noticeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  noticeHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
}));

/** What the pane is pointed at, and the rule that has not been drawn yet. */
interface ArenaTerminalState {
  terminalId: string | null;
  target: ArenaTerminalTarget | null;
  error: string | null;
}

const EMPTY_STATE: ArenaTerminalState = {
  terminalId: null,
  target: null,
  error: null,
};

function useArenaTerminalPanelDescriptor(target: {
  kind: "arena_terminal";
  agentId: string;
  side: "a" | "b";
  instanceId: string;
}): PanelDescriptor {
  const seat = useArenaSeatTerminal(target.instanceId);
  const seatLabel = agentLabel(target.side);
  // The seat's first shell is just the seat. Later ones number themselves, the way the
  // workspace's own terminals do, so two tabs for one seat are told apart.
  const ordinal = seat?.ordinal ?? 1;
  const label = ordinal > 1 ? `${seatLabel} ${ordinal}` : seatLabel;
  return {
    label,
    subtitle: "Battle worktree",
    tooltip: `${label}'s shell`,
    titleState: "ready",
    icon: Terminal,
    statusBucket: null,
  };
}

function ArenaTerminalPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  invariant(target.kind === "arena_terminal", "ArenaTerminalPanel requires arena_terminal target");
  const { agentId, side, instanceId } = target;

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const queryClient = useQueryClient();
  const { data: snapshot } = useArenaSessionQuery(serverId, agentId);
  // A reload wipes this panel's state, so the shell it opened is read back from the store.
  // Without that it would strand the shell and open a second one in the same worktree.
  const [state, setState] = useState<ArenaTerminalState>(() => ({
    ...EMPTY_STATE,
    terminalId: getArenaSeatTerminal(instanceId)?.terminalId ?? null,
  }));

  // One in-flight create at a time. Two snapshots can land while the first create is still
  // open, and a second shell in the same worktree would orphan the first.
  const creatingForWorktreeRef = useRef<string | null>(null);

  const resolved = resolveArenaTerminalTarget(snapshot, side);
  const resolvedRunId = resolved?.runId ?? null;
  const resolvedWorktree = resolved?.worktree ?? null;
  const resolvedTurnIndex = resolved?.turnIndex ?? -1;
  const nextTarget = useMemo<ArenaTerminalTarget | null>(
    () =>
      resolvedWorktree && resolvedRunId
        ? { runId: resolvedRunId, worktree: resolvedWorktree, turnIndex: resolvedTurnIndex }
        : null,
    [resolvedRunId, resolvedTurnIndex, resolvedWorktree],
  );

  useEffect(() => {
    if (!client || !workspaceDirectory) {
      return;
    }
    const plan = planArenaTerminalTransition({ previous: state.target, next: nextTarget });
    if (plan.kind === "idle") {
      return;
    }
    if (plan.kind === "detach") {
      // The worktree is gone between turns. Deliberately keep the remembered target: it is
      // what makes the next worktree an `advance` — and so draws the rule — rather than a
      // first `attach`. The buffer and the dead terminal id stay too, because the output is
      // the reason someone still has this tab open.
      return;
    }
    if (creatingForWorktreeRef.current === plan.target.worktree) {
      return;
    }
    creatingForWorktreeRef.current = plan.target.worktree;
    const existingTerminalId = state.terminalId;
    const advancing = plan.kind === "advance";
    void (async () => {
      try {
        if (advancing && existingTerminalId) {
          // The shell moves; the terminal does not. The daemon writes the rule into the
          // buffer it already owns, so every attached client — and every later reattach,
          // reload or repaint — sees the previous turns and the seam between them.
          const result = await client.rehomeTerminal({
            terminalId: existingTerminalId,
            cwd: plan.target.worktree,
            bannerLabel: plan.dividerLabel,
          });
          if (result.success) {
            setState({ terminalId: existingTerminalId, target: plan.target, error: null });
            return;
          }
          // The daemon no longer has that terminal — it restarted, or the shell was killed
          // from somewhere else. There is no buffer left to carry across, so fall through
          // and open a fresh one for this turn instead of reporting a dead panel.
        }

        // Reattach to the shell this tab already owns, if the daemon still has it. A reload
        // comes back here with the remembered id, and creating unconditionally would strand
        // that shell and throw away the scrollback the daemon still holds for it.
        const worktreeLeaf = plan.target.worktree.replace(/\/+$/, "").split("/").at(-1) ?? "";
        const listed = await client.listTerminals(workspaceDirectory, undefined, { workspaceId });
        const remembered = existingTerminalId
          ? (listed.terminals ?? []).find((candidate) => candidate.id === existingTerminalId)
          : undefined;
        if (remembered) {
          const standsInTarget =
            worktreeLeaf.length > 0 && String(remembered.title ?? "").includes(worktreeLeaf);
          if (!standsInTarget) {
            // Turns went by while this tab was closed or the page was away. Move the shell on
            // and draw the rule, rather than reattaching it to a worktree that is now gone.
            const moved = await client.rehomeTerminal({
              terminalId: remembered.id,
              cwd: plan.target.worktree,
              bannerLabel: arenaTurnLabel(plan.target.turnIndex),
            });
            if (!moved.success) {
              throw new Error(moved.error ?? "Unable to move the contestant terminal");
            }
          }
          setState({ terminalId: remembered.id, target: plan.target, error: null });
          return;
        }

        const terminal = await createArenaWorktreeTerminal({
          client,
          worktree: plan.target.worktree,
          workspaceId,
          name: agentLabel(side),
        });
        queryClient.setQueryData<ListTerminalsPayload>(
          buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId),
          (current) =>
            upsertCreatedTerminalPayload({
              current,
              terminal: terminal as Parameters<typeof upsertCreatedTerminalPayload>[0]["terminal"],
              workspaceDirectory,
            }),
        );
        setState({ terminalId: terminal.id, target: plan.target, error: null });
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to open the contestant terminal",
        }));
      } finally {
        if (creatingForWorktreeRef.current === plan.target.worktree) {
          creatingForWorktreeRef.current = null;
        }
      }
    })();
  }, [
    agentId,
    client,
    nextTarget,
    queryClient,
    serverId,
    side,
    state.target,
    state.terminalId,
    workspaceDirectory,
    workspaceId,
  ]);

  // The tab owns the shell, so the store follows the panel rather than the other way round:
  // closing the tab reads the id back out of it to kill what it opened.
  useEffect(() => {
    rememberArenaSeatTerminalId(instanceId, state.terminalId);
  }, [instanceId, state.terminalId]);

  // The remembered shell can be gone — the daemon restarted, or it was killed from elsewhere.
  // Let go of it, rather than leaving the pane pointed at a terminal the daemon will refuse to
  // stream. With a worktree to stand in, the transition above then opens a fresh one.
  const attachedTerminalId = state.terminalId;
  useEffect(() => {
    if (!client || !workspaceDirectory || !attachedTerminalId) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const listed = await client
        .listTerminals(workspaceDirectory, undefined, { workspaceId })
        .catch(() => null);
      if (cancelled || !listed) {
        return;
      }
      if ((listed.terminals ?? []).some((candidate) => candidate.id === attachedTerminalId)) {
        return;
      }
      setState((current) =>
        current.terminalId === attachedTerminalId ? { ...current, terminalId: null } : current,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [attachedTerminalId, client, workspaceDirectory, workspaceId]);

  // A seat is live exactly while the battle is: two environments to compare. The winner's
  // worktree outlives the vote, but by then it is the workspace's environment rather than a
  // contestant's, so both seats pause together — including after a reload, since this is a
  // fact about the battle now rather than a transition the panel happened to see.
  const isStranded =
    state.terminalId !== null && !resolveArenaSeatTerminalSides(snapshot).includes(side);

  const handleOpenFileExplorer = useCallback(() => undefined, []);

  if (!workspaceDirectory) {
    return <SidePanelDirectoryMissing />;
  }

  if (!state.terminalId) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text style={styles.placeholderText}>
          {state.error ?? `Waiting for ${agentLabel(side)}'s worktree…`}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.pane}>
      <View style={styles.terminal}>
        <TerminalPane
          serverId={serverId}
          cwd={workspaceDirectory}
          terminalId={state.terminalId}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={isPaneFocused}
          onOpenFileExplorer={handleOpenFileExplorer}
          onOpenWorkspaceFile={openFileInWorkspace}
          readOnly={isStranded}
          {...(isStranded ? { belowCursor: <ArenaTerminalStrandedNotice side={side} /> } : {})}
        />
      </View>
    </View>
  );
}

/**
 * The turn that follows a battle need not be a battle, and then this seat has no worktree to
 * stand in. The output stays — it is the reason the tab is open — but the pane says why nothing
 * can be typed, rather than leaving a live-looking prompt that goes nowhere.
 */
function ArenaTerminalStrandedNotice({ side }: { side: ArenaSide }) {
  const { t } = useTranslation();
  return (
    <View style={styles.notice} testID={`arena-terminal-stranded-${side}`}>
      <ThemedPause size={12} uniProps={noticeIconMapping} />
      <Text style={styles.noticeText}>{t("workspace.arenaTerminal.noBattle")}</Text>
      <Text style={styles.noticeHint}>{t("workspace.arenaTerminal.noBattleHint")}</Text>
    </View>
  );
}

export const arenaTerminalPanelRegistration: PanelRegistration<"arena_terminal"> = {
  kind: "arena_terminal",
  component: ArenaTerminalPanel,
  useDescriptor: useArenaTerminalPanelDescriptor,
};
