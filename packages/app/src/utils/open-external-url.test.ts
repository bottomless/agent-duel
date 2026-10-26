import { describe, expect, it, vi } from "vitest";
import { canOpenExternalUrl, openExternalUrl } from "./open-external-url";

vi.mock("expo-linking", () => ({ openURL: vi.fn() }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: vi.fn(() => null) }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));

describe("canOpenExternalUrl", () => {
  it("allows only HTTP and HTTPS URLs", () => {
    expect(canOpenExternalUrl("https://example.com/path")).toBe(true);
    expect(canOpenExternalUrl("http://localhost:3000")).toBe(true);
    expect(canOpenExternalUrl("file:///tmp/example.txt")).toBe(false);
    expect(canOpenExternalUrl("mailto:test@example.com")).toBe(false);
    expect(canOpenExternalUrl("not a URL")).toBe(false);
  });
});

describe("external URL refusal", () => {
  it.each(["mailto:person@example.com", "javascript:alert(1)", "/relative", "invalid"])(
    "safely ignores %s for fire-and-forget callers",
    async (url) => {
      await expect(openExternalUrl(url)).resolves.toBeUndefined();
    },
  );
});
