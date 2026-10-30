/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Dimensions, Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARENA_MAX_CONTENT_WIDTH, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { ArenaContentColumn, useArenaCardBleed } from "./content-column";

vi.stubGlobal("React", React);

function Probe() {
  const summary = useArenaCardBleed(MAX_CONTENT_WIDTH);
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

describe("ArenaContentColumn bleed", () => {
  it("runs a summary and a battle edge to edge in a narrow window", () => {
    expect(bleedAt(480)).toBe("summary=true battle=true");
  });

  it("keeps a collapsed summary a centered card while an expanded one fills a normal window", () => {
    expect(bleedAt(MAX_CONTENT_WIDTH + 1)).toBe("summary=false battle=true");
    expect(bleedAt(ARENA_MAX_CONTENT_WIDTH)).toBe("summary=false battle=true");
  });

  it("centers both past the battle's max width", () => {
    expect(bleedAt(ARENA_MAX_CONTENT_WIDTH + 1)).toBe("summary=false battle=false");
  });

  it("never bleeds a column that did not ask to", () => {
    expect(bleedAt(480, false)).toBe("summary=false battle=false");
  });
});
