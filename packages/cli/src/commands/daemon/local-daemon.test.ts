import { expect, test, vi } from "vitest";

const startDaemonInstance = vi.hoisted(() => vi.fn().mockResolvedValue({ spawned: false }));
vi.mock("@getpaseo/server/daemon-control", () => ({
  startDaemonInstance,
  resolvePaseoHome: (env: NodeJS.ProcessEnv) => env.PASEO_HOME,
}));

import { launchLocalDaemon } from "./local-daemon.js";

test("CLI launch keeps the 2.0 daemon ownership entry point", async () => {
  await expect(
    launchLocalDaemon({ home: "/tmp/arena-merge-cli", foreground: true }),
  ).resolves.toEqual({ spawned: false });
  expect(startDaemonInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      home: "/tmp/arena-merge-cli",
      command: process.execPath,
      foreground: true,
      signal: expect.any(AbortSignal),
    }),
  );
});
