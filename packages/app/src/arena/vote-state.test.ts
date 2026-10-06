import { describe, expect, it } from "vitest";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { canChooseArenaRun, canKeepStoppedArenaRun, canStopArenaBattle } from "./vote-state";

const selectableRun = { selectable: true } as ArenaRun;
const applicableRun = { applicable: true } as ArenaRun;

describe("canChooseArenaRun", () => {
  it("keeps a selectable side disabled while the turn is finalizing", () => {
    expect(canChooseArenaRun("finalizing", selectableRun)).toBe(false);
  });

  it("allows completed and early votes only while voting is open", () => {
    expect(canChooseArenaRun("running", selectableRun)).toBe(true);
    expect(canChooseArenaRun("awaiting_vote", selectableRun)).toBe(true);
    expect(canChooseArenaRun("applying", selectableRun)).toBe(false);
  });
});

describe("canStopArenaBattle", () => {
  it("only offers a stop while both sides are running", () => {
    expect(canStopArenaBattle("running")).toBe(true);
    expect(canStopArenaBattle("awaiting_vote")).toBe(false);
    expect(canStopArenaBattle("stopping")).toBe(false);
    expect(canStopArenaBattle("creating")).toBe(false);
  });
});

describe("canKeepStoppedArenaRun", () => {
  it("lets a stopped battle keep only an applicable side", () => {
    expect(canKeepStoppedArenaRun("awaiting_stop_resolution", applicableRun)).toBe(true);
    expect(canKeepStoppedArenaRun("awaiting_stop_resolution", selectableRun)).toBe(false);
    expect(canKeepStoppedArenaRun("awaiting_stop_resolution", undefined)).toBe(false);
    expect(canKeepStoppedArenaRun("awaiting_vote", applicableRun)).toBe(false);
  });
});
