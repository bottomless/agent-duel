import { expect, it } from "vitest";
import { DockBadgeState, readBadgeEntries } from "./dock-badge";

it("clears on focus without bringing an unchanged pending battle back", () => {
  const badge = new DockBadgeState();
  expect(badge.update(1, { chat: "turn-1" }, false)).toBe(1);
  expect(badge.focus()).toBe(0);
  expect(badge.update(1, { chat: "turn-1" }, false)).toBe(0);
  expect(badge.update(1, { chat: "turn-2" }, false)).toBe(1);
});

it("acknowledges results received while focused without changing their pending state", () => {
  const badge = new DockBadgeState();
  const pending = { chat: "turn-1" };
  expect(badge.update(1, pending, true)).toBe(0);
  expect(pending).toEqual({ chat: "turn-1" });
  expect(badge.update(1, pending, false)).toBe(0);
  expect(badge.update(1, { ...pending, other: "turn-2" }, false)).toBe(1);
});

it("clears shared attention across windows and counts each workspace once", () => {
  const badge = new DockBadgeState();
  expect(badge.update(1, { chat: "turn-1" }, false)).toBe(1);
  expect(badge.update(2, { chat: "turn-1", other: "turn-2" }, false)).toBe(2);
  expect(badge.focus()).toBe(0);
  expect(badge.update(2, { chat: "turn-1", other: "turn-2" }, false)).toBe(0);
  expect(badge.remove(1)).toBe(0);
  expect(badge.update(2, { chat: "turn-3", other: "turn-2" }, false)).toBe(1);
  expect(badge.remove(2)).toBe(0);
});

it("removes attention for resolved or closed workspaces", () => {
  const badge = new DockBadgeState();
  expect(badge.update(1, { chat: "turn-1", other: "turn-2" }, false)).toBe(2);
  expect(badge.update(1, { other: "turn-2" }, false)).toBe(1);
  expect(badge.remove(1)).toBe(0);
});

it("rejects invalid IPC payloads and copies valid entries", () => {
  for (const value of [undefined, null, 2, "2", [], { chat: 2 }, { "": "turn" }]) {
    expect(readBadgeEntries(value)).toBeNull();
  }
  const entries = { chat: "turn-1" };
  const parsed = readBadgeEntries(entries);
  expect(parsed).toEqual(entries);
  expect(parsed).not.toBe(entries);
  expect(readBadgeEntries({})).toEqual({});
});
