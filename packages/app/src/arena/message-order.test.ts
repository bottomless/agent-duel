import { describe, expect, it } from "vitest";
import { compareMessageIds } from "./message-order";

describe("compareMessageIds", () => {
  it("orders Core's fork copies by their sequence, not as strings", () => {
    const ids = ["msg_f_13", "msg_f_9", "msg_f_101", "msg_f_1"];
    expect(ids.toSorted(compareMessageIds)).toEqual([
      "msg_f_1",
      "msg_f_9",
      "msg_f_13",
      "msg_f_101",
    ]);
  });

  it("puts messages written after the fork after its copies", () => {
    expect(
      compareMessageIds("msg_1eb153426001ZB9dVCLAD5Et0n_99", "msg_1eb16531a001aSsU29NCfKvzla"),
    ).toBeLessThan(0);
    expect(
      compareMessageIds("msg_1eb16531a001aSsU29NCfKvzla", "msg_1eb16531a001aSsU29NCfKvzla"),
    ).toBe(0);
  });
});
