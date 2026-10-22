import { describe, expect, it } from "vitest";
import type { ArenaVoteInput, ArenaVoteSource } from "@getpaseo/protocol/arena/rpc-schemas";
import { classifyVoteSource } from "./vote-source";

describe("vote source", () => {
  it("leaves browser-trusted clicks unverified without native evidence", async () => {
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await classifyVoteSource({ event, nativeInput: null })).toBe("unverified");
  });

  it("records macOS provenance for pointer and keyboard activation", async () => {
    const received: ArenaVoteInput[] = [];
    for (const source of ["native", "injected", "unverified"] as const) {
      const nativeInput = async (input: ArenaVoteInput): Promise<ArenaVoteSource> => {
        received.push(input);
        return source;
      };
      const mouse = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
      expect(await classifyVoteSource({ event: mouse, nativeInput })).toBe(source);
      // React Native Web forwards keyup as a DOM event rather than a React event.
      expect(
        await classifyVoteSource({ event: { isTrusted: true, key: "Enter" }, nativeInput }),
      ).toBe(source);
      expect(await classifyVoteSource({ event: { isTrusted: true, key: " " }, nativeInput })).toBe(
        source,
      );
    }
    expect(received.slice(0, 3)).toEqual([
      { kind: "pointer", screenX: 100, screenY: 200 },
      { kind: "keyboard", key: "Enter" },
      { kind: "keyboard", key: " " },
    ]);
  });

  it("identifies script-dispatched clicks without asking for native evidence", async () => {
    let calls = 0;
    const nativeInput = async (): Promise<ArenaVoteSource> => {
      calls++;
      return "native";
    };
    expect(
      await classifyVoteSource({ event: { nativeEvent: { isTrusted: false } }, nativeInput }),
    ).toBe("synthetic");
    expect(calls).toBe(0);
  });

  it("keeps missing or malformed trust metadata unknown", async () => {
    for (const nativeEvent of [null, undefined, {}, { isTrusted: "true" }, { isTrusted: 1 }]) {
      expect(await classifyVoteSource({ event: { nativeEvent }, nativeInput: null })).toBe(
        "unknown",
      );
    }
  });

  it("keeps voting available if native input lookup fails", async () => {
    const nativeInput = async (): Promise<ArenaVoteSource> => {
      throw new Error("The desktop window closed");
    };
    const event = { nativeEvent: { isTrusted: true, screenX: 100, screenY: 200 } };
    expect(await classifyVoteSource({ event, nativeInput })).toBe("unknown");
  });
});
