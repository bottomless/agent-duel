import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { DisclosureTriggerEdge, StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";
import { useRevealInStream, type RevealInStream } from "./reveal-position";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VIEWPORT_HEIGHT = 100;
const ROW_HEIGHT = 40;
// The room a revealed element keeps under the transcript's top edge.
const REVEAL_TOP_INSET = 12;

// The transcript provides the reveal to what it renders, so a row is where a test picks it up.
let revealInStream: RevealInStream | null = null;

function RevealCapture() {
  revealInStream = useRevealInStream();
  return null;
}

// A row's height comes from its text, so a disclosure that opens or grows a row is a new item
// for that row, as it is in the app.
function row(index: number, height = ROW_HEIGHT): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: String(height),
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

const rowStyleByHeight = new Map<number, { height: number }>();

function renderRow(item: StreamItem) {
  const height = item.kind === "user_message" ? Number(item.text) : ROW_HEIGHT;
  let style = rowStyleByHeight.get(height);
  if (!style) {
    style = { height };
    rowStyleByHeight.set(height, style);
  }
  return (
    <div style={style}>
      {item.id}
      <RevealCapture />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:500px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mountTimeline(historyMounted: StreamItem[]) {
  const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const input: StreamRenderInput = {
    agentId: "agent",
    segments: { historyVirtualized: [], historyMounted, liveHead: [] },
    boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
    renderers: {
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: () => null,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearBottomChange: () => {},
    onNearHistoryStart: async () => true,
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: null,
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
    contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
  };
  let segments = input.segments;
  let renderers = input.renderers;
  const render = () => root.render(strategy.render({ ...input, segments, renderers }));
  act(() => render());

  const scrollContainer = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!scrollContainer) throw new Error("Expected agent chat scroll container");
  const element = (selector: string) => {
    const found = host.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`Expected ${selector}`);
    return found;
  };
  const rowElement = (id: string) => element(`[data-history-row-id="${id}"]`);
  const topOf = (target: HTMLElement) =>
    target.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
  const reveal = (target: HTMLElement, how: keyof RevealInStream = "reveal") => {
    const revealIn = revealInStream;
    if (!revealIn) throw new Error("Expected the transcript to provide a reveal");
    act(() => revealIn[how](target));
  };
  const panes = () => element('[data-testid="battle-panes"]');

  return {
    render: (next: Partial<StreamRenderInput["segments"]>) =>
      act(() => {
        segments = { ...segments, ...next };
        render();
      }),
    // The active battle renders after the rows, in the transcript's live area.
    renderLive: (live: ReactNode) =>
      act(() => {
        renderers = { ...renderers, renderLiveAuxiliary: () => live };
        render();
      }),
    hold: (rowId: string, apply: () => void, triggerEdge: DisclosureTriggerEdge = "top") =>
      act(() => viewportRef.current!.holdRow(rowId, apply, triggerEdge)),
    reveal: (id: string) => reveal(rowElement(id)),
    revealPanes: () => reveal(panes()),
    revealPanesAgain: () => reveal(panes(), "revealAgain"),
    rowTop: (id: string) => topOf(rowElement(id)),
    panesTop: () => topOf(panes()),
    rowBottom: (id: string) =>
      rowElement(id).getBoundingClientRect().bottom - scrollContainer.getBoundingClientRect().top,
    scrollTo: (top: number) => {
      scrollContainer.scrollTop = top;
    },
    scrollTop: () => scrollContainer.scrollTop,
    jumpToLatest: () => act(() => viewportRef.current!.scrollToBottom()),
    distanceFromEnd: () =>
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    // Resize observers and the hold's settle run on animation frames.
    settle: () =>
      act(async () => {
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
  };
}

describe("web disclosure hold", () => {
  it("keeps the trigger's top when an anchored toggle at the bottom opens rows below it, and stops following", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 5), row(7, 200), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  it("keeps the trigger's top when its row grows while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  // A long message's show more sits under the text it opens, on the bottom edge of its row.
  it("keeps the bottom of a bottom-trigger row through show more and show less while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerBottom = timeline.rowBottom("message-5");

    timeline.hold(
      "message-5",
      () => timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
      "bottom",
    );
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }), "bottom");
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);
  });

  it("keeps the bottom of a bottom-trigger row through show more and show less when scrolled up", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.scrollTo(60);
    await timeline.settle();
    // message-2 is cut off at the top; message-3 is fully in view.
    for (const index of [2, 3]) {
      const triggerBottom = timeline.rowBottom(`message-${index}`);
      const grown = history.map((item, position) =>
        position === index - 1 ? row(index, 240) : item,
      );

      timeline.hold(`message-${index}`, () => timeline.render({ historyMounted: grown }), "bottom");
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);

      timeline.hold(
        `message-${index}`,
        () => timeline.render({ historyMounted: history }),
        "bottom",
      );
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);
    }
  });

  it("resumes following when collapsing an anchored row lands back at the end", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }));
    await timeline.settle();

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
  });
});

// A reply to a battle shows in its panes, which sit above the review the chat ends on.
describe("web reveal", () => {
  it("leaves an element in view where it is", async () => {
    const timeline = mountTimeline([1, 2, 3, 4, 5, 6].map((index) => row(index)));
    await timeline.settle();
    const top = timeline.rowTop("message-5");
    expect(top).toBeGreaterThanOrEqual(0);

    timeline.reveal("message-5");
    await timeline.settle();

    expect(timeline.rowTop("message-5")).toBe(top);
  });

  it("brings an element above the end to the top of the transcript", async () => {
    const timeline = mountTimeline([1, 2, 3, 4, 5, 6].map((index) => row(index)));
    await timeline.settle();
    expect(timeline.rowBottom("message-3")).toBeLessThanOrEqual(0);

    timeline.reveal("message-3");
    await timeline.settle();

    expect(timeline.rowTop("message-3")).toBe(REVEAL_TOP_INSET);
  });

  it("stays on the element when output arrives at the end", async () => {
    const timeline = mountTimeline([1, 2, 3, 4, 5, 6].map((index) => row(index)));
    await timeline.settle();
    timeline.reveal("message-3");
    await timeline.settle();

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();

    expect(timeline.rowTop("message-3")).toBe(REVEAL_TOP_INSET);
  });

  // The review leaves while a reply runs and comes back when it finishes.
  it("returns to the element when the content below it goes away and comes back", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.reveal("message-3");
    await timeline.settle();

    timeline.render({ historyMounted: history.slice(0, 3) });
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);

    timeline.render({ historyMounted: [...history, row(7, 200)] });
    await timeline.settle();

    expect(timeline.rowTop("message-3")).toBe(REVEAL_TOP_INSET);
  });
});

// The active battle: its panes, and the review that leaves while a reply runs.
const panesStyle = { height: 200 };
const reviewStyle = { height: 600 };

function battle({ reviewShown }: { reviewShown: boolean }) {
  return (
    <div>
      <RevealCapture />
      <div data-testid="battle-panes" style={panesStyle} />
      {reviewShown ? <div style={reviewStyle} /> : null}
    </div>
  );
}

// The battle's outcome, which replaces the panes and the review after a vote.
const outcome = <div style={{ height: 80 }} />;

// A reply was sent: the panes came into view and the review left while the agents answer.
async function mountRepliedBattle() {
  host.style.height = "300px";
  const timeline = mountTimeline([1, 2, 3, 4, 5, 6, 7, 8].map((index) => row(index)));
  timeline.renderLive(battle({ reviewShown: true }));
  await timeline.settle();
  timeline.revealPanes();
  await timeline.settle();
  expect(timeline.panesTop()).toBe(REVEAL_TOP_INSET);
  timeline.renderLive(battle({ reviewShown: false }));
  await timeline.settle();
  return timeline;
}

describe("web reveal in the live area", () => {
  it("keeps the panes in place while the review leaves and returns", async () => {
    const timeline = await mountRepliedBattle();

    timeline.renderLive(battle({ reviewShown: true }));
    timeline.revealPanesAgain();
    await timeline.settle();

    expect(timeline.panesTop()).toBe(REVEAL_TOP_INSET);
  });

  it("leaves the reader in an earlier turn when the answers arrive", async () => {
    const timeline = await mountRepliedBattle();
    timeline.scrollTo(0);
    await timeline.settle();

    timeline.renderLive(battle({ reviewShown: true }));
    timeline.revealPanesAgain();
    await timeline.settle();

    expect(timeline.scrollTop()).toBe(0);
  });

  it("leaves the reader on the review when the answers arrive", async () => {
    const timeline = await mountRepliedBattle();
    timeline.renderLive(battle({ reviewShown: true }));
    await timeline.settle();
    timeline.scrollTo(timeline.scrollTop() + 300);
    await timeline.settle();
    const readerTop = timeline.scrollTop();

    timeline.revealPanesAgain();
    await timeline.settle();

    expect(timeline.scrollTop()).toBe(readerTop);
  });

  it("stays at the end after Jump to latest when the answers arrive", async () => {
    const timeline = await mountRepliedBattle();
    timeline.jumpToLatest();
    await timeline.settle();

    timeline.renderLive(battle({ reviewShown: true }));
    timeline.revealPanesAgain();
    await timeline.settle();

    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
  });

  it("follows the end again when a vote replaces the revealed battle", async () => {
    const timeline = await mountRepliedBattle();
    timeline.renderLive(battle({ reviewShown: true }));
    timeline.revealPanesAgain();
    await timeline.settle();

    timeline.renderLive(outcome);
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);

    timeline.render({ liveHead: [row(9)] });
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
  });

  it("leaves a reader who scrolled away in place when a vote replaces the battle", async () => {
    const timeline = await mountRepliedBattle();
    timeline.scrollTo(0);
    await timeline.settle();

    timeline.renderLive(outcome);
    await timeline.settle();

    expect(timeline.scrollTop()).toBe(0);
  });
});
