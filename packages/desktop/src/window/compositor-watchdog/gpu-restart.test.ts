import { describe, expect, it } from "vitest";

import { GPU_RESTART_WINDOW_MS, isExpectedGpuRestart, noteGpuRestart } from "./gpu-restart";

const AT = 1_000_000;

describe("gpu restart window", () => {
  // First, while no restart has been announced yet.
  it("covers nothing before the watchdog restarts the GPU process", () => {
    expect(isExpectedGpuRestart("GPU", AT)).toBe(false);
  });

  it("covers the GPU process end the watchdog caused", () => {
    noteGpuRestart(AT);

    expect(isExpectedGpuRestart("GPU", AT + 10)).toBe(true);
  });

  it("expires, so a genuine GPU crash afterwards is still reported", () => {
    noteGpuRestart(AT);

    expect(isExpectedGpuRestart("GPU", AT + GPU_RESTART_WINDOW_MS)).toBe(false);
  });

  it("covers no other child process", () => {
    noteGpuRestart(AT);

    expect(isExpectedGpuRestart("Utility", AT + 10)).toBe(false);
  });
});
