import { describe, expect, test } from "vitest";
import { getStaticProviders } from "./ls.js";

describe("getStaticProviders", () => {
  const enabledById = (overrides?: Record<string, { enabled?: boolean }>) =>
    Object.fromEntries(getStaticProviders(overrides).map((item) => [item.provider, item.enabled]));

  test("reports the manifest defaults without a config", () => {
    expect(enabledById()).toMatchObject({
      claude: "Disabled",
      codex: "Disabled",
      opencode: "Enabled",
    });
  });

  test("follows enabled overrides from config", () => {
    expect(enabledById({ codex: { enabled: true }, opencode: { enabled: false } })).toMatchObject({
      claude: "Disabled",
      codex: "Enabled",
      opencode: "Disabled",
    });
  });
});
