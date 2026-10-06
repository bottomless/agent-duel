import { describe, expect, it } from "vitest";
import { MODEL_VENDORS, arenaModelVendor } from "./model-vendor";
import { MODEL_VENDOR_ICON_SVGS } from "@/assets/model-vendor-icons";

describe("arenaModelVendor", () => {
  // What a reveal actually carries: arena-backend sends the profile's display
  // name, so these are the strings the marks are chosen from today.
  it("reads the display names the arena reveals", () => {
    expect(arenaModelVendor("GLM 5.2")).toBe("zai");
    expect(arenaModelVendor("Qwen 3.8 Max")).toBe("qwen");
    expect(arenaModelVendor("Grok 4.6")).toBe("xai");
    expect(arenaModelVendor("DeepSeek V4 Flash")).toBe("deepseek");
  });

  it("reads slug-shaped names too", () => {
    expect(arenaModelVendor("z-ai/glm-5.2-20260616")).toBe("zai");
    expect(arenaModelVendor("qwen/qwen3.8-max-20260803")).toBe("qwen");
    expect(arenaModelVendor("x-ai/grok-4.6")).toBe("xai");
    expect(arenaModelVendor("openrouter/deepseek/deepseek-v4-flash")).toBe("deepseek");
  });

  it("recognises a family name without its vendor", () => {
    expect(arenaModelVendor("Sonnet 4.6")).toBe("anthropic");
    expect(arenaModelVendor("Opus 5")).toBe("anthropic");
    expect(arenaModelVendor("Gemini 3 Pro")).toBe("google");
    expect(arenaModelVendor("K2 Thinking")).toBe("moonshot");
    expect(arenaModelVendor("Llama 4 Maverick")).toBe("meta");
    expect(arenaModelVendor("Devstral Medium")).toBe("mistral");
    expect(arenaModelVendor("o3")).toBe("openai");
    expect(arenaModelVendor("GPT-5.2")).toBe("openai");
  });

  it("swaps a model for another vendor's without a code change", () => {
    expect(arenaModelVendor("Claude Opus 5")).toBe("anthropic");
    expect(arenaModelVendor("anthropic/claude-opus-5")).toBe("anthropic");
    expect(arenaModelVendor("moonshotai/kimi-k2")).toBe("moonshot");
    expect(arenaModelVendor("MiniMax M2")).toBe("minimax");
    expect(arenaModelVendor("minimax/minimax-m2")).toBe("minimax");
    expect(arenaModelVendor("google/gemini-3-pro")).toBe("google");
    expect(arenaModelVendor("meta-llama/llama-4-maverick")).toBe("meta");
    expect(arenaModelVendor("mistralai/magistral-small")).toBe("mistral");
  });

  it("ignores case", () => {
    expect(arenaModelVendor("Z-AI/GLM-5.2")).toBe("zai");
    expect(arenaModelVendor("qwen 3.8 max")).toBe("qwen");
  });

  it("does not match a short token buried in a longer word", () => {
    // `o3` and `k2` are the two patterns loose enough to misfire.
    expect(arenaModelVendor("turbo3-preview")).toBeNull();
    expect(arenaModelVendor("ark2-large")).toBeNull();
  });

  it("has no vendor for a model it does not know", () => {
    expect(arenaModelVendor(undefined)).toBeNull();
    expect(arenaModelVendor("")).toBeNull();
    expect(arenaModelVendor("Command R+")).toBeNull();
    expect(arenaModelVendor("some-lab/experimental-1")).toBeNull();
  });
});

describe("model vendor icons", () => {
  it("ships one mark per vendor", () => {
    expect(Object.keys(MODEL_VENDOR_ICON_SVGS).toSorted()).toEqual([...MODEL_VENDORS].toSorted());
  });

  it("leaves every mark sizeable and themeable", () => {
    for (const [vendor, svg] of Object.entries(MODEL_VENDOR_ICON_SVGS)) {
      expect(svg, vendor).toMatch(/^<svg[^>]*viewBox="/);
      expect(svg, vendor).not.toMatch(/<svg[^>]*\s(?:width|height)=/);
    }
  });
});
