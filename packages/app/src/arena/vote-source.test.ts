import { describe, expect, it } from "vitest";
import type {
  ArenaVoteEvidence,
  ArenaVoteInput,
  ArenaVoteTarget,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { classifyVoteSource } from "./vote-source";

const target: ArenaVoteTarget = {
  kind: "battle",
  agentId: "agent-1",
  targetId: "turn-1",
  vote: "a",
};

describe("vote source", () => {
  it("leaves browser-trusted clicks unverified without native evidence", async () => {
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await classifyVoteSource({ event, target, nativeInput: null })).toEqual({
      source: "unverified",
    });
  });

  it("records macOS provenance for pointer and keyboard activation bound to the target", async () => {
    const received: Array<{ target: ArenaVoteTarget; input: ArenaVoteInput }> = [];
    for (const source of ["native", "injected", "unverified"] as const) {
      const nativeInput = async (request: {
        target: ArenaVoteTarget;
        input: ArenaVoteInput;
      }): Promise<ArenaVoteEvidence> => {
        received.push(request);
        return {
          source,
          ...(source === "native" ? { receipt: { payload: "p", signature: "s" } } : {}),
        };
      };
      const mouse = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
      expect((await classifyVoteSource({ event: mouse, target, nativeInput })).source).toBe(source);
      expect(
        (
          await classifyVoteSource({
            event: { isTrusted: true, key: "Enter" },
            target,
            nativeInput,
          })
        ).source,
      ).toBe(source);
      expect(
        (await classifyVoteSource({ event: { isTrusted: true, key: " " }, target, nativeInput }))
          .source,
      ).toBe(source);
    }
    expect(received).toHaveLength(9);
    expect(received[0]).toEqual({
      target,
      input: { kind: "pointer", screenX: 100, screenY: 200 },
    });
    expect(received[1]).toEqual({ target, input: { kind: "keyboard", key: "Enter" } });
    expect(received[2]).toEqual({ target, input: { kind: "keyboard", key: " " } });
  });

  it("identifies script-dispatched clicks without asking for native evidence", async () => {
    let calls = 0;
    const nativeInput = async (): Promise<ArenaVoteEvidence> => {
      calls++;
      return { source: "native" };
    };
    expect(
      await classifyVoteSource({
        event: { nativeEvent: { isTrusted: false } },
        target,
        nativeInput,
      }),
    ).toEqual({ source: "synthetic" });
    expect(calls).toBe(0);
  });

  it("keeps missing or malformed trust metadata unknown", async () => {
    for (const nativeEvent of [null, undefined, {}, { isTrusted: "true" }, { isTrusted: 1 }]) {
      expect(
        await classifyVoteSource({ event: { nativeEvent }, target, nativeInput: null }),
      ).toEqual({ source: "unknown" });
    }
  });

  it("keeps voting available if native input lookup fails", async () => {
    const nativeInput = async (): Promise<ArenaVoteEvidence> => {
      throw new Error("The desktop window closed");
    };
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await classifyVoteSource({ event, target, nativeInput })).toEqual({ source: "unknown" });
  });

  it("marks trusted events with invalid input metadata unknown", async () => {
    const nativeInput = async (): Promise<ArenaVoteEvidence> => ({ source: "native" });
    expect(
      await classifyVoteSource({
        event: { nativeEvent: { isTrusted: true, key: "Tab" } },
        target,
        nativeInput,
      }),
    ).toEqual({ source: "unknown" });
  });

  it("rejects an invalid target before asking the native bridge", async () => {
    let calls = 0;
    const nativeInput = async (): Promise<ArenaVoteEvidence> => {
      calls++;
      return { source: "native" };
    };
    expect(
      await classifyVoteSource({
        event: { nativeEvent: { isTrusted: true, key: "Enter" } },
        target: { ...target, targetId: "" },
        nativeInput,
      }),
    ).toEqual({ source: "unknown" });
    expect(calls).toBe(0);
  });
});
