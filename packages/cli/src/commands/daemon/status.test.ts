import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { readPersistedConfig, resolveConfigFromPersisted } from "@getpaseo/server/configuration";
import { connectToDaemon } from "../../utils/client.js";
import { runLsCommand } from "../provider/ls.js";
import { runStatusCommand } from "./status.js";

vi.mock("@getpaseo/server/daemon-control", () => ({
  readDaemonInstance: vi.fn(async () => null),
  daemonLogPath: (home: string) => `${home}/daemon.log`,
  resolvePaseoHome: () => "/unused-home",
  isSameDaemonInstance: vi.fn(),
  DaemonInstanceError: class extends Error {},
}));
vi.mock("@getpaseo/server/configuration", () => ({
  readPersistedConfig: vi.fn(() => ({})),
  resolveConfigFromPersisted: vi.fn(() => ({
    listen: "127.0.0.1:0",
    providerOverrides: { codex: { enabled: true }, opencode: { enabled: false } },
  })),
}));
vi.mock("@getpaseo/server", () => ({ getOrCreateServerId: () => "selected-home-server" }));
vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
  buildDaemonConnectionCommandError: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

const local = { daemonTarget: { kind: "instance" as const, home: "/selected-home" } };

describe("daemon observations without a running instance", () => {
  test("reports the selected stopped home without connecting or probing providers", async () => {
    const result = await runStatusCommand(local, new Command());
    expect(result.data).toMatchObject({
      home: "/selected-home",
      serverId: "selected-home-server",
      localDaemon: "stopped",
      connectedDaemon: "not_probed",
    });
    expect(result.data).not.toHaveProperty("providers");
    expect(readDaemonInstance).toHaveBeenCalledWith("/selected-home");
    expect(connectToDaemon).not.toHaveBeenCalled();
  });

  test("offline provider ls reads overrides only from the selected home", async () => {
    const result = await runLsCommand(local, new Command());
    const enabled = Object.fromEntries(result.data.map((entry) => [entry.provider, entry.enabled]));
    expect(enabled).toMatchObject({ claude: "Disabled", codex: "Enabled", opencode: "Disabled" });
    expect(readPersistedConfig).toHaveBeenCalledWith("/selected-home", { defaultsIfMissing: true });
    expect(resolveConfigFromPersisted).toHaveBeenCalledWith("/selected-home", {}, { env: {} });
    expect(connectToDaemon).not.toHaveBeenCalled();
  });

  test("a remote provider query keeps its connection failure instead of reporting local defaults", async () => {
    const failure = new Error("selected remote unavailable");
    vi.mocked(connectToDaemon).mockRejectedValueOnce(failure);
    await expect(
      runLsCommand({ daemonTarget: { kind: "endpoint", host: "remote.test:1234" } }, new Command()),
    ).rejects.toBe(failure);
    expect(readPersistedConfig).not.toHaveBeenCalled();
    expect(readDaemonInstance).not.toHaveBeenCalled();
  });
});
