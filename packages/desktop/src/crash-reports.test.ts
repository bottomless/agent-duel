import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { getVersion: () => "merge-test", on: vi.fn() },
  record: vi.fn(),
  release: vi.fn(),
  sessionEnding: vi.fn(),
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
  recordSessionEnding: mocks.sessionEnding,
  releaseRunningMarker: mocks.release,
}));

import { startCrashReporting } from "./crash-reports.js";

beforeEach(() => {
  mocks.app.on.mockClear();
  mocks.record.mockClear();
  mocks.release.mockClear();
  mocks.sessionEnding.mockClear();
});

function appListener(name: string) {
  return mocks.app.on.mock.calls.find(([event]) => event === name)?.[1];
}

test("desktop startup monitors crashes and clears its marker on quit", () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    startCrashReporting();
    expect(on).toHaveBeenCalledWith("uncaughtExceptionMonitor", expect.any(Function));
    const renderer = appListener("render-process-gone");
    const quit = appListener("before-quit");
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
          external: false,
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

test("the end of the Windows session marks every run as stopping and reports nothing after it", () => {
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    startCrashReporting();
    const windowCreated = appListener("browser-window-created");
    const childGone = appListener("child-process-gone");
    const window = { on: vi.fn() };
    windowCreated({}, window);
    const sessionEnd = window.on.mock.calls.find(([event]) => event === "session-end")?.[1];
    expect(sessionEnd).toBeTypeOf("function");

    sessionEnd({ reasons: ["shutdown"] });

    expect(mocks.sessionEnding).toHaveBeenCalledWith("/tmp/arena-merge-desktop");
    // The system then ends Electron's own services; production saw these exit with 0x40010004.
    childGone(
      {},
      { type: "Utility", reason: "killed", exitCode: 1073807364, name: "Audio Service" },
    );
    expect(mocks.record).not.toHaveBeenCalled();
  } finally {
    on.mockRestore();
  }
});
