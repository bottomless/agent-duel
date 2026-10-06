import { describe, expect, it } from "vitest";
import { isArenaOwnedTerminalName } from "./owned-terminals";

describe("isArenaOwnedTerminalName", () => {
  it("claims the names the seats give their shells", () => {
    expect(isArenaOwnedTerminalName("Agent A")).toBe(true);
    expect(isArenaOwnedTerminalName("Agent B")).toBe(true);
  });

  it("tolerates the padding a stored name can pick up", () => {
    expect(isArenaOwnedTerminalName("  Agent A  ")).toBe(true);
  });

  it("leaves every other workspace terminal to the reconciler", () => {
    for (const name of ["Terminal 1", "agent a", "Agent", "Agent C", "", undefined]) {
      expect(isArenaOwnedTerminalName(name)).toBe(false);
    }
  });
});
