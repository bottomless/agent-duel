import { isDeepStrictEqual } from "node:util";
import { limitAgentTimelineItemContent } from "../agent/agent-timeline-content.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

interface Hydration {
  completed?: { key: string; index: number };
  running?: { key: string; promise: Promise<void> };
}

// The active agent is shared across windows and released on close. Window-local
// caches would rebuild and broadcast the same canonical history once per subscriber.
const agents = new WeakMap<object, Hydration>();

export async function hydrateArenaWinner(
  owner: object,
  snapshot: ArenaSnapshot,
  hydrate: () => Promise<void>,
): Promise<void> {
  if (snapshot.chat.status !== "ready") return;
  const applied = snapshot.history.reduce<(typeof snapshot.history)[number] | undefined>(
    (latest, turn) => {
      const side = turn.appliedSide ?? turn.resolution?.appliedSide;
      if (side === undefined || (latest && latest.index >= turn.index)) return latest;
      return turn;
    },
    undefined,
  );
  if (!applied) return;
  const key = JSON.stringify([
    snapshot.chat.id,
    snapshot.chat.canonicalSessionID,
    applied.id,
    applied.appliedSide ?? applied.resolution?.appliedSide,
    applied.canonicalUserMessageID,
  ]);
  let state = agents.get(owner);
  if (!state) {
    state = {};
    agents.set(owner, state);
  }
  while (state.running) {
    if (state.running.key === key) return state.running.promise;
    // A failed earlier winner must not prevent a newer canonical version from loading.
    await state.running.promise.catch(() => {});
  }
  if (state.completed?.key === key || (state.completed && state.completed.index > applied.index))
    return;
  const current = state;
  const promise = Promise.resolve()
    .then(hydrate)
    .then(() => {
      current.completed = { key, index: applied.index };
      return undefined;
    })
    .finally(() => {
      current.running = undefined;
    });
  current.running = { key, promise };
  return promise;
}

export function isArenaTimelinePrefix(
  rows: readonly AgentTimelineRow[],
  history: readonly Extract<AgentStreamEvent, { type: "timeline" }>[],
): boolean {
  return (
    rows.length > 0 &&
    rows.length <= history.length &&
    rows.every((row, index) => {
      const event = history[index];
      return (
        row.seq === index + 1 &&
        row.providerMessageId === undefined &&
        row.timestamp === event.timestamp &&
        isDeepStrictEqual(row.item, limitAgentTimelineItemContent(event.item))
      );
    })
  );
}
