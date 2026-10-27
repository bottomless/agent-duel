import { describe, expect, it } from "vitest";
import type { ArenaOsActivation, ArenaVoteInput } from "@getpaseo/protocol/arena/rpc-schemas";
import { collectVoteEvidence } from "./vote-evidence";

const matched: ArenaOsActivation = {
  status: "matched",
  elapsedMs: 9,
  distance: 0,
  event: { platform: "darwin", sourceProcess: "present" },
};

describe("vote evidence", () => {
  it("records browser-trusted clicks without a desktop monitor", async () => {
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await collectVoteEvidence({ event, observe: null })).toEqual({
      activation: "trusted",
      input: "pointer",
      os: { status: "no-monitor" },
    });
  });

  it("asks the OS monitor about pointer and keyboard activations and keeps its answer", async () => {
    const received: ArenaVoteInput[] = [];
    async function observe(input: ArenaVoteInput) {
      received.push(input);
      return matched;
    }
    const mouse = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await collectVoteEvidence({ event: mouse, observe })).toEqual({
      activation: "trusted",
      input: "pointer",
      os: matched,
    });
    expect(
      await collectVoteEvidence({ event: { isTrusted: true, key: "Enter" }, observe }),
    ).toEqual({ activation: "trusted", input: "keyboard", os: matched });
    expect(
      (await collectVoteEvidence({ event: { isTrusted: true, key: " " }, observe })).activation,
    ).toBe("trusted");
    expect(received).toEqual([
      { kind: "pointer", screenX: 100, screenY: 200 },
      { kind: "keyboard", key: "Enter" },
      { kind: "keyboard", key: " " },
    ]);
  });

  it("identifies script-dispatched clicks without asking the OS monitor", async () => {
    let calls = 0;
    async function observe(): Promise<ArenaOsActivation> {
      calls++;
      return matched;
    }
    expect(
      await collectVoteEvidence({ event: { nativeEvent: { isTrusted: false } }, observe }),
    ).toEqual({ activation: "script" });
    expect(calls).toBe(0);
  });

  it("marks missing or malformed trust metadata and unsupported input unrecognized", async () => {
    for (const nativeEvent of [null, undefined, {}, { isTrusted: "true" }, { isTrusted: 1 }]) {
      expect(await collectVoteEvidence({ event: { nativeEvent }, observe: null })).toEqual({
        activation: "unrecognized",
      });
    }
    expect(
      await collectVoteEvidence({
        event: { nativeEvent: { isTrusted: true, key: "Tab" } },
        observe: async () => matched,
      }),
    ).toEqual({ activation: "unrecognized" });
  });

  it("keeps voting available when the OS monitor fails or answers out of shape", async () => {
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    const unavailable = { activation: "trusted", input: "pointer", os: { status: "unavailable" } };
    expect(
      await collectVoteEvidence({
        event,
        observe: async () => {
          throw new Error("The desktop window closed");
        },
      }),
    ).toEqual(unavailable);
    expect(
      await collectVoteEvidence({
        event,
        observe: async () => JSON.parse('{"status":"native"}'),
      }),
    ).toEqual(unavailable);
  });
});
