import { describe, expect, it } from "vitest";
import { arenaPartDisplayText } from "./display-text";

describe("arenaPartDisplayText", () => {
  it("shows the run's own values when the engine stored them", () => {
    expect(
      arenaPartDisplayText({
        type: "text",
        text: "URL: $ARENA_PREVIEW_URL",
        metadata: { arenaDisplay: { text: "URL: http://turn4-a--abc.localhost:6767" } },
      }),
    ).toBe("URL: http://turn4-a--abc.localhost:6767");
  });

  it("shows the text as written otherwise", () => {
    expect(arenaPartDisplayText({ type: "text", text: "URL: $ARENA_PREVIEW_URL" })).toBe(
      "URL: $ARENA_PREVIEW_URL",
    );
    expect(
      arenaPartDisplayText({ type: "text", text: "Done", metadata: { arenaDisplay: 1 } }),
    ).toBe("Done");
    expect(arenaPartDisplayText({ type: "text" })).toBe("");
  });
});
