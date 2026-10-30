import { describe, expect, it } from "vitest";
import type { Theme } from "@/styles/theme";
import { appearanceStyleBoundaryMapping } from "./appearance-style-boundary";

// The subset of Theme that appearanceStyleBoundaryMapping reads. The real Theme
// type is a frozen `as const` literal; casting a fixture of this shape through
// `unknown` to Theme is test-only, matching apply-appearance.test.ts.
interface FakeTheme {
  fontFamily: { ui: string; mono: string };
  fontSize: {
    xs: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
    "4xl": number;
    code: number;
  };
  lineHeight: { diff: number };
  colors: {
    foreground: string;
    foregroundMuted: string;
    mutedForeground: string;
    surface1: string;
    surface2: string;
    border: string;
    accentBright: string;
    syntax: Record<string, string>;
  };
}

function makeFakeTheme(overrides: Partial<FakeTheme> = {}): Theme {
  const base: FakeTheme = {
    fontFamily: { ui: "seed-ui-stack", mono: "seed-mono-stack" },
    fontSize: {
      xs: 12,
      sm: 14,
      base: 16,
      lg: 18,
      xl: 20,
      "2xl": 22,
      "3xl": 26,
      "4xl": 34,
      code: 12,
    },
    lineHeight: { diff: 22 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      mutedForeground: "#bbb",
      surface1: "#111",
      surface2: "#222",
      border: "#333",
      accentBright: "#444",
      syntax: { keyword: "#f00", comment: "#0f0", string: "#00f" },
    },
  };
  return { ...base, ...overrides } as unknown as Theme;
}

describe("appearanceStyleBoundaryMapping", () => {
  it("produces the same key when only syntax colors change", () => {
    const a = makeFakeTheme();
    const b = makeFakeTheme({
      colors: { ...a.colors, syntax: { keyword: "#fff", comment: "#000", string: "#abc" } },
    });

    expect(appearanceStyleBoundaryMapping(a).appearanceKey).toBe(
      appearanceStyleBoundaryMapping(b).appearanceKey,
    );
  });

  it("still changes the key when a tracked font value changes", () => {
    const a = makeFakeTheme();
    const b = makeFakeTheme({ fontFamily: { ui: "different-ui-stack", mono: "seed-mono-stack" } });

    expect(appearanceStyleBoundaryMapping(a).appearanceKey).not.toBe(
      appearanceStyleBoundaryMapping(b).appearanceKey,
    );
  });

  it("still changes the key when a tracked color value changes", () => {
    const a = makeFakeTheme();
    const b = makeFakeTheme({ colors: { ...a.colors, accentBright: "#different" } });

    expect(appearanceStyleBoundaryMapping(a).appearanceKey).not.toBe(
      appearanceStyleBoundaryMapping(b).appearanceKey,
    );
  });
});
