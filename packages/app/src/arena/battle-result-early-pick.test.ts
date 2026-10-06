import { describe, expect, it } from "vitest";
import { arenaRunErrorToShow, isStoppedByEarlyPick } from "./battle-result";

const earlyPickOfA = { selectedEarly: true, appliedSide: "a" } as const;

describe("isStoppedByEarlyPick", () => {
  it("claims the side that was cancelled when the other was picked", () => {
    expect(isStoppedByEarlyPick({ runState: "stopped", side: "b", turn: earlyPickOfA })).toBe(true);
  });

  it("leaves the picked side alone", () => {
    expect(isStoppedByEarlyPick({ runState: "stopped", side: "a", turn: earlyPickOfA })).toBe(
      false,
    );
  });

  it("ignores a run that is not stopped", () => {
    expect(isStoppedByEarlyPick({ runState: "complete", side: "b", turn: earlyPickOfA })).toBe(
      false,
    );
    expect(isStoppedByEarlyPick({ runState: "error", side: "b", turn: earlyPickOfA })).toBe(false);
  });

  // Stop battle stops both sides, and an error there is the contestant's own; only an early pick
  // makes a stopped run something the person did on purpose.
  it("does not claim a run stopped by anything but an early pick", () => {
    expect(
      isStoppedByEarlyPick({
        runState: "stopped",
        side: "b",
        turn: { selectedEarly: false, appliedSide: "a" },
      }),
    ).toBe(false);
    expect(isStoppedByEarlyPick({ runState: "stopped", side: "b", turn: undefined })).toBe(false);
    expect(
      isStoppedByEarlyPick({ runState: "stopped", side: "b", turn: { selectedEarly: true } }),
    ).toBe(false);
  });
});

describe("arenaRunErrorToShow", () => {
  const ABORT = 'Contestant assistant error: {"name":"MessageAbortedError","data":{}}';

  it("drops the abort a cancelled run recorded before Arena stopped recording it", () => {
    expect(arenaRunErrorToShow({ error: ABORT, stoppedByEarlyPick: true })).toBeNull();
  });

  it("keeps what a cancelled contestant failed at on its own", () => {
    const provider = 'Contestant assistant error: {"name":"ProviderAuthError","data":{}}';
    expect(arenaRunErrorToShow({ error: provider, stoppedByEarlyPick: true })).toBe(provider);
  });

  // finalizeSide joins its reasons with newlines, so an old record can carry both.
  it("keeps the real reason out of a record that also carried the abort", () => {
    const provider = 'Contestant assistant error: {"name":"ProviderAuthError","data":{}}';
    expect(arenaRunErrorToShow({ error: `${ABORT}\n${provider}`, stoppedByEarlyPick: true })).toBe(
      provider,
    );
  });

  it("leaves a run nobody picked over alone", () => {
    expect(arenaRunErrorToShow({ error: ABORT, stoppedByEarlyPick: false })).toBe(ABORT);
    expect(arenaRunErrorToShow({ error: undefined, stoppedByEarlyPick: false })).toBeNull();
  });
});
