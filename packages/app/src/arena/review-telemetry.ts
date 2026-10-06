import { useEffect, useRef } from "react";
import {
  ARENA_REVIEW_FLUSH_LIMIT,
  type ArenaReviewEvent,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { useArenaDiffLayoutStore } from "./diff-layout";
import { useArenaReviewStore, type ArenaReviewState } from "./review-state";

/**
 * What a voter did while reviewing, observed rather than instrumented. Every
 * event here is a transition in state the card already holds, so the review
 * components carry no telemetry and the taxonomy lives in this one file.
 *
 * Scroll depth and vote hover are not state anywhere, so they are the two read off
 * the DOM below rather than observed on the store. The vote itself is deliberately absent:
 * `turns.voteAt` records it already. See [analytics](../../../../docs/analytics.md).
 */

const FLUSH_INTERVAL_MS = 15_000;
// A failed flush is retried, so the buffer has to have a ceiling. Past this the
// oldest events go: a truncated review is worth more than an unbounded buffer.
const BUFFER_LIMIT = ARENA_REVIEW_FLUSH_LIMIT * 2;

type Distribute<T> = T extends unknown
  ? Omit<T, "id" | "mountId" | "offsetMs" | "clientAtMs">
  : never;

/** An event before the envelope the sink stamps onto it. */
export type ArenaReviewSignal = Distribute<ArenaReviewEvent>;

interface ArenaReviewSink {
  push: (signal: ArenaReviewSignal) => void;
  flush: () => void;
  dispose: () => void;
}

function eventId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createSink(send: (events: ArenaReviewEvent[]) => Promise<unknown>): ArenaReviewSink {
  // The reference every offset is measured from. Dwell comes from these, never
  // from the wall clock, which a skewed client makes useless. Both are per
  // mount: a card mounted twice produces two timelines, and `mountId` is what
  // stops the rollup interleaving them.
  const startedAt = Date.now();
  const mountId = eventId();
  let buffer: ArenaReviewEvent[] = [];
  let inFlight = false;

  const flush = () => {
    if (inFlight || buffer.length === 0) return;
    const batch = buffer.slice(0, ARENA_REVIEW_FLUSH_LIMIT);
    buffer = buffer.slice(batch.length);
    inFlight = true;
    void send(batch)
      .catch(() => {
        // Telemetry never surfaces an error and never blocks a decision. Put the
        // batch back so a dropped connection does not silently bias the set
        // toward voters with good ones.
        buffer = [...batch, ...buffer].slice(-BUFFER_LIMIT);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    push: (signal) => {
      const at = Date.now();
      buffer.push({ ...signal, id: eventId(), mountId, offsetMs: at - startedAt, clientAtMs: at });
      if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT);
    },
    flush,
    dispose: () => {
      flush();
      buffer = [];
    },
  };
}

function reviewState(byTurn: Record<string, ArenaReviewState>, turnId: string): ArenaReviewState {
  return byTurn[turnId] ?? {};
}

/**
 * Mount once per battle card being reviewed. Pushes nothing into React state,
 * so it re-renders nothing.
 */
export function useArenaReviewTelemetry({
  serverId,
  agentId,
  turnId,
  focused,
  enabled,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  /** The card's Focus control, which is a hook rather than store state. */
  focused: boolean;
  enabled: boolean;
}) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const sink = useRef<ArenaReviewSink | null>(null);

  useEffect(() => {
    if (!enabled || !isWeb || !client || !turnId) return;
    const current = createSink((events) => client.arenaRecordReview(agentId, turnId, events));
    sink.current = current;
    current.push({ type: "battle.opened" });

    // The card writes what it renders from its own effect, and React runs a
    // child's effects before its parent's — so by the time this subscribes, the
    // landing tab and file are already in the store and no transition is coming.
    // Seed from what is there rather than waiting for a change that never fires.
    const initial = reviewState(useArenaReviewStore.getState().byTurn, turnId);
    if (initial.shownTab) current.push({ type: "tab.viewed", tab: initial.shownTab });
    if (initial.shownFile) {
      current.push({
        type: "file.selected",
        file: initial.shownFile,
        index: initial.shownIndex ?? 0,
      });
    }
    if (initial.verdictFolded === true) current.push({ type: "verdict.folded" });
    if (initial.verdictExpanded === true) current.push({ type: "verdict.expanded" });
    for (const side of initial.previewsOpened ?? []) current.push({ type: "preview.opened", side });

    let previousReview = initial;
    const unsubscribeReview = useArenaReviewStore.subscribe((state) => {
      const next = reviewState(state.byTurn, turnId);
      const previous = previousReview;
      previousReview = next;
      if (next.shownTab && next.shownTab !== previous.shownTab)
        current.push({ type: "tab.viewed", tab: next.shownTab });
      // `shownFile`, not `file`: the diff on arrival is the card's default and
      // the reader reads it without clicking anything.
      if (next.shownFile && next.shownFile !== previous.shownFile) {
        current.push({ type: "file.selected", file: next.shownFile, index: next.shownIndex ?? 0 });
      }
      if (next.verdictFolded === true && previous.verdictFolded !== true) {
        current.push({ type: "verdict.folded" });
      }
      if (next.verdictExpanded === true && previous.verdictExpanded !== true) {
        current.push({ type: "verdict.expanded" });
      }
      const seen = previous.previewsOpened ?? [];
      for (const side of next.previewsOpened ?? []) {
        if (!seen.includes(side)) current.push({ type: "preview.opened", side });
      }
    });

    let previousLayout = useArenaDiffLayoutStore.getState().layoutByChat[agentId];
    const unsubscribeLayout = useArenaDiffLayoutStore.subscribe((state) => {
      const next = state.layoutByChat[agentId];
      const previous = previousLayout;
      previousLayout = next;
      if (next && next !== previous) current.push({ type: "layout.changed", layout: next });
    });

    // The two below are the only events not derived from store state. They are read
    // off the DOM here rather than pushed from the components, so the review
    // components stay free of telemetry and the taxonomy stays in this file.

    // Which contestant's vote the pointer visited, counted once per side like
    // `previewsOpened`: a reader sweeping back and forth is deliberating, not
    // doing it twice. Only a pointer can cause this, so unlike `tab.viewed` it
    // can never be the card acting on its own.
    const hoveredVotes = new Set<string>();
    const onPointerOver = (event: Event) => {
      const target = event.target as Element | null;
      const control = target?.closest?.("[data-testid^='arena-choose-']");
      const side = control?.getAttribute("data-testid")?.slice("arena-choose-".length);
      if ((side !== "a" && side !== "b") || hoveredVotes.has(side)) return;
      hoveredVotes.add(side);
      current.push({ type: "vote.hovered", side });
    };

    // How far down a diff the reader actually got. Reported as new ground only, in
    // 5% steps, so a long read is bounded at twenty events per file rather than one
    // per frame. Scroll does not bubble, hence the capture listener.
    const deepest = new Map<string, number>();
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el?.getAttribute?.("data-testid") !== "arena-inline-diff") return;
      const file = reviewState(useArenaReviewStore.getState().byTurn, turnId).shownFile;
      if (!file) return;
      const travel = el.scrollHeight - el.clientHeight;
      const depth = travel <= 0 ? 1 : Math.min(1, Math.max(0, el.scrollTop / travel));
      if (depth <= (deepest.get(file) ?? 0) + 0.05) return;
      deepest.set(file, depth);
      current.push({ type: "diff.scrolled", file, depth });
    };

    const onFocus = () => current.push({ type: "window.focus" });
    const onBlur = () => current.push({ type: "window.blur" });
    // A card open behind another window is not review, and the rollup subtracts
    // these spans from every dwell it computes.
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerover", onPointerOver, { passive: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") current.flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(current.flush, FLUSH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribeReview();
      unsubscribeLayout();
      current.dispose();
      sink.current = null;
    };
  }, [agentId, client, enabled, serverId, turnId]);

  // Focus is a hook rather than store state, so it is observed on its own and
  // must not re-create the sink when it changes.
  const previousFocused = useRef(focused);
  useEffect(() => {
    if (previousFocused.current === focused) return;
    previousFocused.current = focused;
    sink.current?.push({ type: "focus.toggled", on: focused });
  }, [focused]);
}
