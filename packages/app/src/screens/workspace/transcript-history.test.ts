import { expect, it } from "vitest";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import { ChatFindModel } from "@/agent-stream/chat-find/model";
import { TranscriptReader, transcriptFindHistory } from "./transcript-history";

function page(firstSeq: number): FetchAgentTimelinePayload {
  return {
    requestId: "request",
    agentId: "agent",
    agent: null,
    epoch: "transcript-epoch",
    direction: "tail",
    projection: "projected",
    startCursor: { epoch: "transcript-epoch", seq: firstSeq },
    endCursor: { epoch: "transcript-epoch", seq: 200 },
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 200, nextSeq: 201 },
    hasOlder: firstSeq > 1,
    hasNewer: false,
    entries: [],
    error: null,
  };
}

const client = {
  async searchAgentTimeline() {
    return {
      agentId: "agent",
      requestId: "request",
      epoch: "transcript-epoch",
      locations: [
        { seq: 5, role: "assistant" as const },
        { seq: 125, role: "assistant" as const },
      ],
      nextCursor: null,
      error: null,
    };
  },
};

it("finds and retries using the fetched transcript epoch after the live store had another epoch (R26 issue 1)", async () => {
  const history = transcriptFindHistory([page(100)], client, "agent");
  const revealed: string[] = [];
  const model = new ChatFindModel({
    ...history,
    async reveal(id) {
      revealed.push(id);
      return { occurrence: 0, count: 1 };
    },
    clear() {},
  });
  try {
    model.updateHistory("stale-live-epoch", []);
    model.open();
    model.setQuery("target");
    await expect.poll(() => model.getSnapshot().failure).toBe("historyChanged");
    model.updateHistory(history.epoch, [
      {
        id: "answer",
        kind: "assistant_message",
        text: "target",
        timestamp: new Date(0),
        timelineCursor: { epoch: "transcript-epoch", seq: 125 },
      },
    ]);
    model.retry();
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot()).toMatchObject({
      count: 1,
      failure: null,
      selectedItemId: "answer",
    });
    model.retry();
    await expect.poll(() => revealed.length).toBe(2);
    expect(model.getSnapshot()).toMatchObject({ phase: "ready", count: 1, failure: null });
  } finally {
    model.close();
  }
});

it("limits Find to loaded pages and includes earlier hits once those pages load (R26 issue 2)", async () => {
  const first = transcriptFindHistory([page(100)], client, "agent");
  expect((await first.search("target")).locations).toEqual([{ seq: 125, role: "assistant" }]);
  const all = transcriptFindHistory([page(100), page(1)], client, "agent");
  expect((await all.search("target")).locations).toEqual([
    { seq: 5, role: "assistant" },
    { seq: 125, role: "assistant" },
  ]);
});

it.each(["success", "failure"])(
  "releases the reader after an outstanding %s even when Back happens first (R26 issue 3)",
  async (outcome) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    let releases = 0;
    const reader = new TranscriptReader(async () => {
      releases++;
    });
    const read = reader.read(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const settled = read.catch(() => undefined);
    const close = reader.close();
    expect(reader.close()).toBe(close);
    expect(releases).toBe(0);
    if (outcome === "success") finish();
    else fail(new Error("Fetch failed"));
    await settled;
    await close;
    expect(releases).toBe(1);
    await expect(reader.read(async () => undefined)).rejects.toThrow("Transcript closed");
  },
);
