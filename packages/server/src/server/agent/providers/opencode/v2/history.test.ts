import { describe, expect, it } from "vitest";
import type { V2Api } from "./api.js";
import { exclusiveForkBoundary } from "./history.js";

function client(ids: string[]): V2Api {
  return {
    message: {
      // Two messages a page, so the boundary is found across pages.
      list: async (input: { cursor?: string }) => {
        const start = input.cursor ? Number(input.cursor) : 0;
        const next = start + 2 < ids.length ? String(start + 2) : null;
        return { data: ids.slice(start, start + 2).map((id) => ({ id })), cursor: { next } };
      },
    },
  } as unknown as V2Api;
}

describe("exclusiveForkBoundary", () => {
  it("forks through the selected message by ending before the one after it", async () => {
    await expect(exclusiveForkBoundary(client(["m1", "m2", "m3", "m4"]), "s", "m2")).resolves.toBe(
      "m3",
    );
  });

  it("keeps every message when the selected one is the last", async () => {
    await expect(
      exclusiveForkBoundary(client(["m1", "m2", "m3"]), "s", "m3"),
    ).resolves.toBeUndefined();
  });

  it("refuses a message the session no longer has", async () => {
    await expect(exclusiveForkBoundary(client(["m1"]), "s", "gone")).rejects.toThrow(
      "no longer available",
    );
  });
});
