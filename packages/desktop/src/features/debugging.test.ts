import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {} }));
vi.mock("electron-log/main", () => ({ default: { error: vi.fn() } }));

import { attachedDebuggers } from "./debugging";

describe("release debugging lock", () => {
  it("finds the switches Playwright and CDP clients launch Electron with", () => {
    const switches = new Set(["inspect", "remote-debugging-port", "disable-gpu"]);
    expect(
      attachedDebuggers({
        hasSwitch: (name) => switches.has(name),
        inspectorUrl: () => undefined,
      }),
    ).toEqual(["--remote-debugging-port", "--inspect"]);
  });

  it("finds an inspector opened without a switch, such as through NODE_OPTIONS", () => {
    expect(
      attachedDebuggers({
        hasSwitch: () => false,
        inspectorUrl: () => "ws://127.0.0.1:9229/abc",
      }),
    ).toEqual(["inspector"]);
  });

  it("finds nothing in an ordinary launch", () => {
    expect(
      attachedDebuggers({
        hasSwitch: (name) => name === "disable-gpu",
        inspectorUrl: () => undefined,
      }),
    ).toEqual([]);
  });
});
