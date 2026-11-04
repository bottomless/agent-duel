import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { getVersion: () => "merge-test", on: vi.fn() },
  record: vi.fn(),
  release: vi.fn(),
}));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-log/main", () => ({
  default: { transports: { file: { getFile: () => ({ path: "/tmp/arena-app.log" }) } } },
}));
vi.mock("@getpaseo/server", () => ({
  resolvePaseoHome: () => "/tmp/arena-merge-desktop",
  claimRunningMarker: () => null,
  describeError: (error: Error) => error.message,
  describeUncleanShutdown: () => "unclean exit",
  recordCrashReport: mocks.record,
  releaseRunningMarker: mocks.release,
}));

import { startCrashReporting } from "./crash-reports.js";

test("desktop startup monitors crashes and clears its marker on quit", () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    startCrashReporting();
    expect(on).toHaveBeenCalledWith("uncaughtExceptionMonitor", expect.any(Function));
    const renderer = mocks.app.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1];
    const quit = mocks.app.on.mock.calls.find(([name]) => name === "before-quit")?.[1];
    expect(renderer).toBeTypeOf("function");
    expect(quit).toBeTypeOf("function");
    renderer({}, {}, { reason: "crashed", exitCode: 9 });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        crash: {
          process: "window",
          kind: "exit",
          message: "A window's renderer process ended: crashed",
          exitCode: 9,
        },
        logPaths: ["/tmp/arena-app.log"],
      }),
    );
    quit();
    expect(mocks.release).toHaveBeenCalledWith("/tmp/arena-merge-desktop", "app");
    renderer({}, {}, { reason: "killed", exitCode: 9 });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  } finally {
    on.mockRestore();
  }
});
