import { describe, expect, it } from "vitest";
import { buildTerminalDivider } from "./terminal-divider";

const ESC = String.fromCharCode(27);

/** The rule as a reader sees it: SGR removed, CRLF collapsed to LF. */
function visibleRule(value: string): string {
  return value
    .split(ESC)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("")
    .split("\r\n")
    .join("\n");
}

function ruleLine(value: string, needle: string): string | undefined {
  return visibleRule(value)
    .split("\n")
    .find((line) => line.includes(needle));
}

describe("buildTerminalDivider", () => {
  it("fills the rule to one column short of the width", () => {
    // Writing into the last cell leaves xterm in deferred-wrap, which turns the
    // newline that follows into a blank row. The rule stops one column short.
    const rule = ruleLine(buildTerminalDivider({ label: "turn 5", cols: 40 }), "turn 5");
    expect(rule).toBe("── turn 5 ─────────────────────────────");
    expect(rule).toHaveLength(39);
  });

  it("opens on a fresh line and pads with one blank row on each side", () => {
    const lines = visibleRule(buildTerminalDivider({ label: "turn 2", cols: 30 })).split("\n");
    // The leading newline only closes the line the prompt left the cursor on — it is not
    // itself a blank row — so this is one blank above the rule and one below.
    expect(lines.slice(0, 2)).toEqual(["", ""]);
    expect(lines[2]).toContain("turn 2");
    expect(lines.slice(3)).toEqual(["", ""]);
  });

  it("keeps a readable rule when the label cannot fit", () => {
    const rule = ruleLine(buildTerminalDivider({ label: "a".repeat(80), cols: 20 }), "a");
    expect(rule?.endsWith("────")).toBe(true);
  });

  it("falls back to a sane width when the pane has not measured yet", () => {
    for (const cols of [0, -5, Number.NaN]) {
      expect(ruleLine(buildTerminalDivider({ label: "turn 1", cols }), "turn 1")).toHaveLength(79);
    }
  });

  it("draws the rule in a grey that does not follow the palette", () => {
    // Bright black is a near-black in the light themes, which drew the rule as a hard black
    // line. The greyscale index reads the same under either colour scheme.
    const value = buildTerminalDivider({ label: "turn 3", cols: 40 });
    expect(value).toContain(`${ESC}[38;5;245m`);
    expect(value).not.toContain(`${ESC}[90m`);
  });

  it("draws a bare rule when there is no label", () => {
    expect(ruleLine(buildTerminalDivider({ label: "  ", cols: 12 }), "─")).toBe("── ────────");
  });
});
