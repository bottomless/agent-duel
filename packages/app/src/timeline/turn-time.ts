import type { StreamItem } from "@/types/stream";
import { startsNewTurn, isTurnTrigger } from "@/agent-stream/turn-membership";
import type { ArenaHistoryItem } from "@getpaseo/protocol/arena/rpc-schemas";

export interface TurnTiming {
  completedAt: Date;
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byItemId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

interface OpenTurn {
  userAt: Date | null;
  lastItemAt: Date | null;
  assistantIds: readonly string[];
  previousItem: StreamItem | null;
}

interface HeadTurnTiming {
  additions: Map<string, TurnTiming>;
  byItemId: Map<string, TurnTiming>;
}

interface TailTurnTiming {
  completed: Map<string, TurnTiming>;
  openTurn: OpenTurn;
  lastHead: HeadTurnTiming | null;
}

const EMPTY_OPEN_TURN: OpenTurn = {
  userAt: null,
  lastItemAt: null,
  assistantIds: [],
  previousItem: null,
};

function closeTurn(turn: OpenTurn, into: Map<string, TurnTiming>): void {
  if (!turn.lastItemAt) {
    return;
  }
  const timing: TurnTiming = {
    completedAt: turn.lastItemAt,
    durationMs: turn.userAt ? Math.max(0, turn.lastItemAt.getTime() - turn.userAt.getTime()) : null,
  };
  let footerIds = turn.assistantIds;
  if (footerIds.length === 0 && turn.previousItem?.kind === "tool_call") {
    footerIds = [turn.previousItem.id];
  }
  for (const id of footerIds) {
    into.set(id, timing);
  }
}

function walkTurns(
  items: readonly StreamItem[],
  from: OpenTurn,
  into: Map<string, TurnTiming>,
): OpenTurn {
  let userAt = from.userAt;
  let lastItemAt = from.lastItemAt;
  let assistantIds = [...from.assistantIds];
  let previousItem = from.previousItem;
  for (const item of items) {
    if (startsNewTurn(item, previousItem)) {
      closeTurn({ userAt, lastItemAt, assistantIds, previousItem }, into);
      userAt = isTurnTrigger(item) ? item.timestamp : null;
      lastItemAt = null;
      assistantIds = [];
    }
    lastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      assistantIds.push(item.id);
    }
    previousItem = item;
  }
  return { userAt, lastItemAt, assistantIds, previousItem };
}

function areTimingsEqual(a: Map<string, TurnTiming>, b: Map<string, TurnTiming>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, timing] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.completedAt.getTime() !== timing.completedAt.getTime() ||
      other.durationMs !== timing.durationMs
    ) {
      return false;
    }
  }
  return true;
}

// The tail walk is cached by array identity so a streamed delta, which only replaces the
// head, walks the head from the carried open turn. The returned Map keeps its identity
// while the head adds no completed turn, so memos keyed on it do not miss per tick.
const tailTurnTimingCache = new WeakMap<StreamItem[], TailTurnTiming>();

function getTailTurnTiming(tail: StreamItem[]): TailTurnTiming {
  const cached = tailTurnTimingCache.get(tail);
  if (cached) {
    return cached;
  }
  const completed = new Map<string, TurnTiming>();
  const openTurn = walkTurns(tail, EMPTY_OPEN_TURN, completed);
  const timing: TailTurnTiming = { completed, openTurn, lastHead: null };
  tailTurnTimingCache.set(tail, timing);
  return timing;
}

function resolveByItemId(
  tail: TailTurnTiming,
  additions: Map<string, TurnTiming>,
): Map<string, TurnTiming> {
  if (additions.size === 0) {
    return tail.completed;
  }
  if (tail.lastHead && areTimingsEqual(tail.lastHead.additions, additions)) {
    return tail.lastHead.byItemId;
  }
  const byItemId = new Map(tail.completed);
  for (const [id, timing] of additions) {
    byItemId.set(id, timing);
  }
  tail.lastHead = { additions, byItemId };
  return byItemId;
}

const appliedBattleTimingCache = new WeakMap<
  Map<string, TurnTiming>,
  WeakMap<readonly ArenaHistoryItem[], Map<string, TurnTiming>>
>();

function applyBattleTiming(
  byItemId: Map<string, TurnTiming>,
  params: Parameters<typeof deriveStreamTurnTiming>[0],
): Map<string, TurnTiming> {
  const history = params.arenaHistory;
  if (!history?.length) return byItemId;
  let cached = appliedBattleTimingCache.get(byItemId);
  const previous = cached?.get(history);
  if (previous) return previous;
  let result = byItemId;
  for (const turn of history) {
    const first = turn.canonicalUserMessageID;
    const last = turn.canonicalLastMessageID;
    const durationMs = turn.appliedDurationMs;
    if (
      turn.state !== "complete" ||
      !turn.appliedSide ||
      !first ||
      !last ||
      durationMs === undefined
    ) {
      continue;
    }
    const isWinnerAnswer = (item: StreamItem) => {
      if (item.kind !== "assistant_message") return false;
      const id = item.messageId ?? item.id;
      return id >= first && id <= last;
    };
    const answer = params.head.findLast(isWinnerAnswer) ?? params.tail.findLast(isWinnerAnswer);
    if (!answer) continue;
    const timing = byItemId.get(answer.id);
    // An active canonical turn still belongs to its running timer.
    if (!timing) continue;
    if (result === byItemId) result = new Map(byItemId);
    result.set(answer.id, { ...timing, durationMs });
  }
  if (!cached) {
    cached = new WeakMap();
    appliedBattleTimingCache.set(byItemId, cached);
  }
  cached.set(history, result);
  return result;
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
  arenaHistory?: readonly ArenaHistoryItem[];
}): StreamTurnTiming {
  const tail = getTailTurnTiming(params.tail);
  const additions = new Map<string, TurnTiming>();
  const openTurn = walkTurns(params.head, tail.openTurn, additions);
  if (!params.isTurnActive) {
    closeTurn(openTurn, additions);
  }
  return {
    byItemId: applyBattleTiming(resolveByItemId(tail, additions), params),
    runningStartedAt: params.isTurnActive ? params.activeTurnStartedAt : null,
  };
}
