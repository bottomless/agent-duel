import type { ArenaReplyTarget, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";

/**
 * A reply sent into the battle on screen, announced to the panes it lands in.
 *
 * The composer and the panes sit in different halves of the chat, and a send is a moment rather
 * than state: a pane that mounts afterwards has nothing to catch up on.
 */
type ArenaReplySentListener = (target: ArenaReplyTarget) => void;

const listenersByTurn = new Map<string, Set<ArenaReplySentListener>>();

export function announceArenaReplySent(turnId: string, target: ArenaReplyTarget): void {
  for (const listener of listenersByTurn.get(turnId) ?? []) listener(target);
}

export function subscribeArenaReplySent(
  turnId: string,
  listener: ArenaReplySentListener,
): () => void {
  const listeners = listenersByTurn.get(turnId) ?? new Set<ArenaReplySentListener>();
  listenersByTurn.set(turnId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByTurn.delete(turnId);
  };
}

/** Whether a reply sent to `target` lands in this side's pane. */
export function arenaReplyReaches(target: ArenaReplyTarget, side: ArenaSide): boolean {
  return target === "both" || target === side;
}

/** Whether every run a reply went to has finished answering it. */
export function arenaReplyAnswered(
  target: ArenaReplyTarget,
  finished: Readonly<Record<ArenaSide, boolean>>,
): boolean {
  return (["a", "b"] as const).every((side) => !arenaReplyReaches(target, side) || finished[side]);
}
