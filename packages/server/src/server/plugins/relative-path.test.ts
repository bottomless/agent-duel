import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";

test("relative plugin paths use the config directory for inspect, install, load and reload", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "plugin-relative-"));
  const directory = path.join(home, "plugins", "example");
  const starts: string[] = [];
  const running = new Set<string>();
  type Runtime = NonNullable<ConstructorParameters<typeof PluginService>[3]["runtime"]>;
  const runtime: Runtime = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    invoke: async () => undefined,
    getLogs: () => [],
    clearLogs: () => {},
    getUsageSourceRegistrations: () => [],
    fetchUsage: async () => undefined,
    discoverUsage: async () => [],
    connectProvider: async () => {
      throw new Error("unused");
    },
    startPlugin: async (id, source) => {
      starts.push(source);
      running.add(id);
    },
    stopPluginById: async () => true,
    stopAll: async () => {},
    subscribe: () => () => {},
    bindPaseoSessionHost: () => {},
  };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "example" }));
    const store = new DaemonConfigStore(home, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      pluginsEnabled: true,
      plugins: { example: { source: "directory", path: "./plugins/example", enabled: true } },
    });
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", { runtime });
    await expect(service.inspectDirectory("./plugins/example")).resolves.toMatchObject({
      id: "example",
    });
    await service.start();
    await service.reloadPlugin("example");
    expect(starts).toEqual([directory, directory]);
    expect((await service.listPlugins())[0].installation).toMatchObject({
      identity: { path: directory },
    });
    await service.installSource({ source: "./plugins/example", id: "installed" });
    expect(store.get().plugins?.installed.path).toBe(directory);
    expect(starts.at(-1)).toBe(directory);
    await service.stopAllPlugins();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
