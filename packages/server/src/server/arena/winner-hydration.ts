import { isDeepStrictEqual } from "node:util";
import { limitAgentTimelineItemContent } from "../agent/agent-timeline-content.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

interface Running {
  key: string;
  position: number;
  promise: Promise<void>;
  abort: AbortController;
}

interface Hydration {
  completed?: { key: string; position: number };
  running?: Running;
}

// The active agent is shared across windows and released on close. Window-local
// caches would rebuild and broadcast the same canonical history once per subscriber.
const agents = new WeakMap<object, Hydration>();

export async function hydrateArenaWinner(
  owner: object,
  snapshot: ArenaSnapshot,
  hydrate: (signal: AbortSignal) => Promise<void>,
  supersedeAfterMs: number,
): Promise<void> {
  if (snapshot.chat.status !== "ready") return;
  // Order winners by their place in the history, not by `turn.index`: a fork's history starts
  // with the turns it copied, and its own turns number from 0 again.
  const position = snapshot.history.findLastIndex(
    (turn) => (turn.appliedSide ?? turn.resolution?.appliedSide) !== undefined,
  );
  const applied = snapshot.history[position];
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
    const running = state.running;
    if (running.key === key) return running.promise;
    if (position < running.position) {
      // An older winner never takes over from a newer one; its caller bounds its own wait.
      await running.promise.catch(() => {});
      continue;
    }
    // A failed earlier winner must not prevent a newer canonical version from loading, and one
    // that never settles must not hold it: the newer history contains the older winner too.
    const settled = await settlesWithin(running.promise, supersedeAfterMs);
    if (!settled && state.running === running) {
      running.abort.abort();
      state.running = undefined;
    }
  }
  if (state.completed?.key === key || (state.completed && state.completed.position > position))
    return;
  const current = state;
  const abort = new AbortController();
  const promise = Promise.resolve()
    .then(() => hydrate(abort.signal))
    .then(() => {
      if (!abort.signal.aborted) current.completed = { key, position };
      return undefined;
    })
    .finally(() => {
      if (current.running?.abort === abort) current.running = undefined;
    });
  current.running = { key, position, promise, abort };
  return promise;
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
