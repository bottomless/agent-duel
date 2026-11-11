/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Dimensions, Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARENA_MAX_CONTENT_WIDTH } from "@/constants/layout";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import { ArenaContentColumn, useArenaCardBesideOutline, useArenaCardBleed } from "./content-column";

vi.stubGlobal("React", React);

function Probe() {
  const summary = useArenaCardBleed(DEFAULT_CONTENT_MAX_WIDTH);
  const battle = useArenaCardBleed();
  return <Text testID="probe">{`summary=${summary} battle=${battle}`}</Text>;
}

function bleedAt(windowWidth: number, fullBleed = true) {
  vi.spyOn(Dimensions, "get").mockReturnValue({
    width: windowWidth,
    height: 800,
    scale: 1,
    fontScale: 1,
  });
  render(
    <ArenaContentColumn fullBleed={fullBleed}>
      <Probe />
    </ArenaContentColumn>,
  );
  const text = screen.getByTestId("probe").textContent;
  cleanup();
  return text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function OutlineProbe() {
  return <Text testID="probe">{`beside=${useArenaCardBesideOutline()}`}</Text>;
}

function besideOutlineAt(windowWidth: number) {
  vi.spyOn(Dimensions, "get").mockReturnValue({
    width: windowWidth,
    height: 800,
    scale: 1,
    fontScale: 1,
  });
  render(
    <ArenaContentColumn fullBleed>
      <OutlineProbe />
    </ArenaContentColumn>,
  );
  const text = screen.getByTestId("probe").textContent;
  cleanup();
  return text;
}

describe("ArenaContentColumn bleed", () => {
  it("runs a summary and a battle edge to edge in a narrow window", () => {
    expect(bleedAt(480)).toBe("summary=true battle=true");
  });

  it("keeps a collapsed summary a centered card while an expanded one fills a normal window", () => {
    expect(bleedAt(DEFAULT_CONTENT_MAX_WIDTH + 1)).toBe("summary=false battle=true");
    expect(bleedAt(ARENA_MAX_CONTENT_WIDTH)).toBe("summary=false battle=true");
  });

  it("centers both past the battle's max width", () => {
    expect(bleedAt(ARENA_MAX_CONTENT_WIDTH + 1)).toBe("summary=false battle=false");
  });

  it("never bleeds a column that did not ask to", () => {
    expect(bleedAt(480, false)).toBe("summary=false battle=false");
  });
});

// The chat outline floats over the panel's left 44px from a 918px panel up, and an edge-to-edge
// card under it started its text at 12px, under the outline's ticks.
describe("ArenaContentColumn beside the chat outline", () => {
  it("insets an edge-to-edge battle once the panel is wide enough for the outline", () => {
    expect(besideOutlineAt(917)).toBe("beside=false");
    expect(besideOutlineAt(918)).toBe("beside=true");
    expect(besideOutlineAt(ARENA_MAX_CONTENT_WIDTH)).toBe("beside=true");
  });

  it("leaves a centered card alone past the battle's max width", () => {
    expect(besideOutlineAt(ARENA_MAX_CONTENT_WIDTH + 1)).toBe("beside=false");
  });
});
