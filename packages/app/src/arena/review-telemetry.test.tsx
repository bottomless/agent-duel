/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import type { ArenaReviewEvent } from "@getpaseo/protocol/arena/rpc-schemas";
import { useSessionStore } from "@/stores/session-store";
import { useArenaReviewStore } from "./review-state";
import { useArenaReviewTelemetry } from "./review-telemetry";

const SERVER = "srv-1";
const AGENT = "agent-1";
const TURN = "turn-1";

let sent: ArenaReviewEvent[] = [];
let container: HTMLDivElement;
let root: Root;

function Harness() {
  useArenaReviewTelemetry({
    serverId: SERVER,
    agentId: AGENT,
    turnId: TURN,
    focused: false,
    enabled: true,
  });
  return null;
}

function mount() {
  act(() => {
    root.render(<Harness />);
  });
}

function types() {
  return sent.map((event) => event.type);
}

beforeEach(() => {
  sent = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useArenaReviewStore.setState({ byTurn: {} });
  const client = {
    arenaRecordReview: async (_agentId: string, _turnId: string, events: ArenaReviewEvent[]) => {
      sent.push(...events);
      return { received: events.length, accepted: events.length };
    },
  };
  useSessionStore.setState({ sessions: { [SERVER]: { client } } } as never);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("useArenaReviewTelemetry", () => {
  it("records the file the card shows on arrival, not only the ones clicked", () => {
    // The regression this exists for: the card auto-selects a file when Changes
    // opens, and counting only explicit clicks lost the first file of every
    // review. Two files seen has to read as two files seen.
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
      useArenaReviewStore.getState().setShownFile(TURN, "src/a.ts", 0);
    });
    act(() => {
      useArenaReviewStore.getState().setFile(TURN, "src/b.ts");
      useArenaReviewStore.getState().setShownFile(TURN, "src/b.ts", 1);
    });
    act(() => {
      root.unmount();
    });

    const files = sent.filter((event) => event.type === "file.selected");
    expect(files).toHaveLength(2);
    expect(files.map((event) => "file" in event && event.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files.map((event) => "index" in event && event.index)).toEqual([0, 1]);
  });

  it("does not emit for a file that is merely re-shown", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownFile(TURN, "src/a.ts", 0);
    });
    act(() => {
      // Leaving Changes and coming back to the same file shows it again; the
      // reader has not seen a second file.
      useArenaReviewStore.getState().setShownTab(TURN, "verdict");
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
      useArenaReviewStore.getState().setShownFile(TURN, "src/a.ts", 0);
    });
    act(() => {
      root.unmount();
    });
    expect(sent.filter((event) => event.type === "file.selected")).toHaveLength(1);
  });

  it("seeds from state the card wrote before this subscribed", () => {
    // React runs a child's effects before its parent's, so the card has already
    // recorded the tab and file it landed on by the time the observer mounts.
    // Waiting for a transition would lose the pane every reader starts on.
    useArenaReviewStore.getState().setShownTab(TURN, "verdict");
    useArenaReviewStore.getState().setShownFile(TURN, "src/a.ts", 0);
    mount();
    act(() => {
      root.unmount();
    });
    expect(types()).toEqual(["battle.opened", "tab.viewed", "file.selected"]);
    const tab = sent.find((event) => event.type === "tab.viewed");
    expect(tab && "tab" in tab && tab.tab).toBe("verdict");
  });

  it("records the tab the reader lands on, not only the ones they switch to", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "verdict");
    });
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
    });
    act(() => {
      root.unmount();
    });
    const tabs = sent.filter((event) => event.type === "tab.viewed");
    expect(tabs.map((event) => ("tab" in event ? event.tab : null))).toEqual([
      "verdict",
      "changes",
    ]);
  });

  it("opens the stream and reports tab and verdict transitions", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
      useArenaReviewStore.getState().setVerdictExpanded(TURN, true);
    });
    act(() => {
      root.unmount();
    });
    expect(types()).toEqual(["battle.opened", "tab.viewed", "verdict.expanded"]);
  });

  it("reports the fold being offered, not only the reader taking it", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setVerdictFolded(TURN);
    });
    act(() => {
      useArenaReviewStore.getState().setVerdictExpanded(TURN, true);
    });
    act(() => {
      // The card writes this on every measure; only the first is an event.
      useArenaReviewStore.getState().setVerdictFolded(TURN);
    });
    act(() => {
      root.unmount();
    });
    expect(types()).toEqual(["battle.opened", "verdict.folded", "verdict.expanded"]);
  });

  it("reports each preview open once, per contestant", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().addPreviewOpened(TURN, "a");
    });
    act(() => {
      // Opening the same contestant's app again is the same preview.
      useArenaReviewStore.getState().addPreviewOpened(TURN, "a");
      useArenaReviewStore.getState().addPreviewOpened(TURN, "b");
    });
    act(() => {
      root.unmount();
    });
    const previews = sent.filter((event) => event.type === "preview.opened");
    expect(previews.map((event) => ("side" in event ? event.side : null))).toEqual(["a", "b"]);
  });

  it("gives each mounting its own id, so timelines never merge", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
    });
    act(() => {
      root.unmount();
    });
    const first = sent.map((event) => event.mountId);
    expect(new Set(first).size).toBe(1);

    // Same turn, mounted again: offsets restart, so the id has to change.
    root = createRoot(container);
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownFile(TURN, "src/a.ts", 0);
    });
    act(() => {
      root.unmount();
    });
    const second = sent.map((event) => event.mountId).filter((id) => !first.includes(id));
    expect(second.length).toBeGreaterThan(0);
    expect(new Set(second).size).toBe(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it("stamps every event with an id and a monotonic offset", () => {
    mount();
    act(() => {
      useArenaReviewStore.getState().setShownTab(TURN, "changes");
    });
    act(() => {
      root.unmount();
    });
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent.map((event) => event.id)).size).toBe(sent.length);
    const offsets = sent.map((event) => event.offsetMs);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(offsets[0]).toBeGreaterThanOrEqual(0);
  });
});
